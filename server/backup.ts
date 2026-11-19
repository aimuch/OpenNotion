import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import type {
  BackupConfigPublic,
  BackupConfigUpdate,
  BackupSnapshotItem,
  PageMeta,
  PageRecord,
} from "../shared/types.ts";
import { pageRecordToMarkdown } from "./markdownBridge.ts";

// 标准 ZIP CRC32 查找表（无需任何第三方依赖）
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  name: string;
  data: Buffer;
  mtime?: Date;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { time, date };
}

/**
 * 纯 Node 内置 zlib 构建标准 UTF-8 ZIP 归档（兼容 macOS 归档实用工具、Windows 资源管理器、7z 与浏览器解压器）
 */
export function buildZipArchive(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const raw = entry.data;
    const crc = crc32(raw);
    const deflated = raw.length > 64 ? zlib.deflateRawSync(raw) : raw;
    const useDeflate = raw.length > 64 && deflated.length < raw.length;
    const compressed = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosDateTime(entry.mtime ?? new Date());
    const flags = 0x0800; // UTF-8 文件名标记

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralSize = centralParts.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function safeFileSegment(title: string, fallbackId: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  return cleaned || `无标题_${fallbackId.slice(0, 6)}`;
}

/**
 * 导出双轨工作区备份包（EdgeEver 风格）：
 * 1. notes/<层级目录>/<页面标题>.md —— 纯文本 Markdown 文件，解压即可用任意编辑器或 Obsidian 直接阅读
 * 2. uploads/* —— 全部本地上传图片与 PDF 附件
 * 3. .opennotion/pages/*.json —— 完整结构化 JSON 元数据（含数据库视图、公式、自动化、分栏等），支持 100% 无损还原
 */
export async function exportWorkspaceBackupZip(
  pages: Iterable<PageRecord>,
  uploadsDir: string,
): Promise<Buffer> {
  const list = [...pages];
  const metaMap = new Map<string, PageMeta>();
  for (const p of list) metaMap.set(p.id, p);

  const entries: ZipEntryInput[] = [];
  const usedMdPaths = new Set<string>();

  const buildNoteFolder = (p: PageRecord): string => {
    const chain: string[] = [];
    const seen = new Set<string>([p.id]);
    let cur = p.parentId;
    while (cur && metaMap.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const parent = metaMap.get(cur)!;
      chain.unshift(safeFileSegment(parent.title, parent.id));
      cur = parent.parentId;
    }
    return chain.length > 0 ? `notes/${chain.join("/")}` : "notes";
  };

  for (const p of list) {
    // 1. 无损结构化备份（供 OpenNotion 完整恢复）
    entries.push({
      name: `.opennotion/pages/${p.id}.json`,
      data: Buffer.from(JSON.stringify(p, null, 2), "utf8"),
      mtime: new Date(p.updatedAt || Date.now()),
    });

    // 2. 人类可读纯文本 Markdown 树（跳过回收站与隐藏同步块容器）
    if (!p.trashed && !p.hidden) {
      const folder = buildNoteFolder(p);
      const base = safeFileSegment(p.title, p.id);
      let relPath = `${folder}/${base}.md`;
      if (usedMdPaths.has(relPath)) {
        relPath = `${folder}/${base}_${p.id.slice(0, 6)}.md`;
      }
      usedMdPaths.add(relPath);
      const md = pageRecordToMarkdown(p, metaMap);
      entries.push({
        name: relPath,
        data: Buffer.from(md, "utf8"),
        mtime: new Date(p.updatedAt || Date.now()),
      });
    }
  }

  // 3. 打包本地附件目录 uploads/*
  try {
    const uploadFiles = await fs.readdir(uploadsDir);
    for (const file of uploadFiles) {
      if (file.startsWith(".")) continue;
      const full = path.join(uploadsDir, file);
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      entries.push({
        name: `uploads/${file}`,
        data: await fs.readFile(full),
        mtime: st.mtime,
      });
    }
  } catch {
    /* uploads 目录为空或不存在时跳过 */
  }

  entries.push({
    name: "README.txt",
    data: Buffer.from(
      [
        "OpenNotion 工作区备份归档",
        "==========================",
        "- notes/ 目录：按原有层级导出的纯文本 Markdown 笔记（可直接用 Obsidian / Typora / 任意文本编辑器打开阅读）。",
        "- uploads/ 目录：笔记中引用的全部本地图片与 PDF 附件。",
        "- .opennotion/ 目录：完整的页面与多视图数据库结构化数据，在 OpenNotion「设置 → 数据与多端同步 → 导入备份或笔记压缩包」中可无损还原。",
        "",
      ].join("\n"),
      "utf8",
    ),
  });

  return buildZipArchive(entries);
}

/* =========================================================
 * AES-256-GCM 密码加密归档（.opennotion.enc）
 * 二进制布局：Magic "ONENC1" (6B) + Salt (16B) + IV (12B) + AuthTag (16B) + Ciphertext
 * ========================================================= */

const ENC_MAGIC = Buffer.from("ONENC1", "ascii");

export function isEncryptedBackup(buf: Buffer): boolean {
  return buf.length > 50 && buf.subarray(0, 6).equals(ENC_MAGIC);
}

export function encryptBackupBuffer(zipBuf: Buffer, password: string): Buffer {
  const pwd = password.trim();
  if (!pwd) throw new Error("加密口令不能为空");
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pwd, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(zipBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENC_MAGIC, salt, iv, tag, encrypted]);
}

export function decryptBackupBuffer(encBuf: Buffer, password: string): Buffer {
  if (!isEncryptedBackup(encBuf)) {
    throw new Error("不是有效的 OpenNotion 加密归档文件");
  }
  const pwd = password.trim();
  if (!pwd) throw new Error("请输入加密归档的解密口令");
  const salt = encBuf.subarray(6, 22);
  const iv = encBuf.subarray(22, 34);
  const tag = encBuf.subarray(34, 50);
  const ciphertext = encBuf.subarray(50);
  try {
    const key = crypto.scryptSync(pwd, salt, 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("备份口令不正确或归档文件已损坏");
  }
}

/* =========================================================
 * 本地定时自动备份 + 快照轮转 + WebDAV 异地副本服务
 * ========================================================= */

interface BackupConfigStored {
  autoEnabled: boolean;
  intervalHours: number;
  keepCount: number;
  encryptPassword: string;
  lastBackupAt: number | null;
  lastStatus: string | null;
  webdav: {
    enabled: boolean;
    url: string;
    username: string;
    password: string;
    remoteDir: string;
  };
}

const SNAPSHOT_FILE_RE = /^OpenNotion-\d{8}-\d{6}(?:-[a-z0-9]{4})?\.(?:zip|opennotion\.enc)$/;

function defaultBackupConfig(): BackupConfigStored {
  return {
    autoEnabled: false,
    intervalHours: 24,
    keepCount: 10,
    encryptPassword: "",
    lastBackupAt: null,
    lastStatus: null,
    webdav: {
      enabled: false,
      url: "",
      username: "",
      password: "",
      remoteDir: "OpenNotion-Backups",
    },
  };
}

function validateWebDavUrl(rawUrl: string): URL {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    throw new Error("WebDAV 地址格式无效（示例：https://dav.jianguoyun.com/dav/）");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("WebDAV 仅支持 http 或 https 协议");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host) === 4 && host.startsWith("169.254.")) {
    throw new Error("不允许访问链路本地元数据地址");
  }
  return u;
}

function formatStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export class BackupService {
  private readonly configPath: string;
  private readonly backupsDir: string;
  private readonly uploadsDir: string;
  private readonly getPages: () => Promise<PageRecord[]>;
  private config: BackupConfigStored | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(dataDir: string, uploadsDir: string, getPages: () => Promise<PageRecord[]>) {
    this.configPath = path.join(dataDir, "backup-config.json");
    this.backupsDir = path.join(dataDir, "backups");
    this.uploadsDir = uploadsDir;
    this.getPages = getPages;
  }

  private async ensureLoaded(): Promise<BackupConfigStored> {
    if (this.config) return this.config;
    const base = defaultBackupConfig();
    try {
      const raw = JSON.parse(await fs.readFile(this.configPath, "utf8")) as Partial<BackupConfigStored>;
      this.config = {
        autoEnabled: Boolean(raw.autoEnabled),
        intervalHours: typeof raw.intervalHours === "number" && raw.intervalHours >= 1 ? raw.intervalHours : 24,
        keepCount: typeof raw.keepCount === "number" ? Math.max(1, Math.min(100, Math.round(raw.keepCount))) : 10,
        encryptPassword: typeof raw.encryptPassword === "string" ? raw.encryptPassword : "",
        lastBackupAt: typeof raw.lastBackupAt === "number" ? raw.lastBackupAt : null,
        lastStatus: typeof raw.lastStatus === "string" ? raw.lastStatus : null,
        webdav: {
          enabled: Boolean(raw.webdav?.enabled),
          url: typeof raw.webdav?.url === "string" ? raw.webdav.url : "",
          username: typeof raw.webdav?.username === "string" ? raw.webdav.username : "",
          password: typeof raw.webdav?.password === "string" ? raw.webdav.password : "",
          remoteDir:
            typeof raw.webdav?.remoteDir === "string" && raw.webdav.remoteDir.trim()
              ? raw.webdav.remoteDir.trim()
              : "OpenNotion-Backups",
        },
      };
    } catch {
      this.config = base;
    }
    this.syncSchedule();
    return this.config;
  }

  private async saveConfig(cfg: BackupConfigStored): Promise<void> {
    this.config = cfg;
    const tmp = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.configPath);
    this.syncSchedule();
  }

  private toPublic(cfg: BackupConfigStored): BackupConfigPublic {
    return {
      autoEnabled: cfg.autoEnabled,
      intervalHours: cfg.intervalHours,
      keepCount: cfg.keepCount,
      hasEncryptPassword: Boolean(cfg.encryptPassword),
      lastBackupAt: cfg.lastBackupAt,
      lastStatus: cfg.lastStatus,
      webdav: {
        enabled: cfg.webdav.enabled,
        url: cfg.webdav.url,
        username: cfg.webdav.username,
        hasPassword: Boolean(cfg.webdav.password),
        remoteDir: cfg.webdav.remoteDir,
      },
    };
  }

  async getPublicConfig(): Promise<BackupConfigPublic> {
    return this.toPublic(await this.ensureLoaded());
  }

  async updateConfig(patch: BackupConfigUpdate): Promise<BackupConfigPublic> {
    const cur = await this.ensureLoaded();
    const next: BackupConfigStored = {
      ...cur,
      ...(typeof patch.autoEnabled === "boolean" ? { autoEnabled: patch.autoEnabled } : {}),
      ...(typeof patch.intervalHours === "number" && patch.intervalHours >= 1
        ? { intervalHours: Math.min(720, Math.round(patch.intervalHours)) }
        : {}),
      ...(typeof patch.keepCount === "number"
        ? { keepCount: Math.max(1, Math.min(100, Math.round(patch.keepCount))) }
        : {}),
      encryptPassword:
        patch.encryptPassword === "__CLEAR__"
          ? ""
          : typeof patch.encryptPassword === "string" && patch.encryptPassword.trim()
            ? patch.encryptPassword.trim()
            : cur.encryptPassword,
      webdav: {
        enabled: typeof patch.webdav?.enabled === "boolean" ? patch.webdav.enabled : cur.webdav.enabled,
        url: typeof patch.webdav?.url === "string" ? patch.webdav.url.trim() : cur.webdav.url,
        username: typeof patch.webdav?.username === "string" ? patch.webdav.username.trim() : cur.webdav.username,
        password:
          patch.webdav?.password === "__CLEAR__"
            ? ""
            : typeof patch.webdav?.password === "string" && patch.webdav.password
              ? patch.webdav.password
              : cur.webdav.password,
        remoteDir:
          typeof patch.webdav?.remoteDir === "string" && patch.webdav.remoteDir.trim()
            ? patch.webdav.remoteDir.trim().replace(/^\/+|\/+$/g, "")
            : cur.webdav.remoteDir,
      },
    };
    await this.saveConfig(next);
    return this.toPublic(next);
  }

  async listSnapshots(): Promise<BackupSnapshotItem[]> {
    await fs.mkdir(this.backupsDir, { recursive: true });
    const names = await fs.readdir(this.backupsDir).catch(() => [] as string[]);
    const items: BackupSnapshotItem[] = [];
    for (const name of names) {
      if (!SNAPSHOT_FILE_RE.test(name)) continue;
      const st = await fs.stat(path.join(this.backupsDir, name)).catch(() => null);
      if (!st?.isFile()) continue;
      items.push({
        filename: name,
        size: st.size,
        createdAt: Math.round(st.mtimeMs),
        encrypted: name.endsWith(".opennotion.enc"),
      });
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items;
  }

  async readSnapshotZip(filename: string, password?: string): Promise<Buffer> {
    if (!SNAPSHOT_FILE_RE.test(filename)) throw new Error("备份文件名不合法");
    const raw = await fs.readFile(path.join(this.backupsDir, filename));
    if (isEncryptedBackup(raw)) {
      const cfg = await this.ensureLoaded();
      const pwd = password?.trim() || cfg.encryptPassword;
      return decryptBackupBuffer(raw, pwd);
    }
    return raw;
  }

  async deleteSnapshot(filename: string): Promise<void> {
    if (!SNAPSHOT_FILE_RE.test(filename)) throw new Error("备份文件名不合法");
    await fs.unlink(path.join(this.backupsDir, filename)).catch(() => {});
  }

  async testWebDav(override?: { url?: string; username?: string; password?: string }): Promise<{ ok: true; status: number }> {
    const cfg = await this.ensureLoaded();
    const rawUrl = override?.url?.trim() || cfg.webdav.url;
    const username = override?.username?.trim() ?? cfg.webdav.username;
    const password = override?.password || cfg.webdav.password;
    const base = validateWebDavUrl(rawUrl);
    const auth = username || password ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : undefined;
    const res = await fetch(base.href, {
      method: "PROPFIND",
      headers: {
        Depth: "0",
        ...(auth ? { Authorization: auth } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`WebDAV 鉴权失败（HTTP ${res.status}），请检查用户名与应用密码`);
    }
    if (res.status >= 400 && res.status !== 405) {
      throw new Error(`WebDAV 连接异常（HTTP ${res.status}）`);
    }
    return { ok: true, status: res.status };
  }

  private async uploadToWebDav(cfg: BackupConfigStored, filename: string, data: Buffer): Promise<void> {
    const base = validateWebDavUrl(cfg.webdav.url);
    const baseHref = base.href.endsWith("/") ? base.href : `${base.href}/`;
    const cleanDir = cfg.webdav.remoteDir.replace(/^\/+|\/+$/g, "");
    const auth =
      cfg.webdav.username || cfg.webdav.password
        ? `Basic ${Buffer.from(`${cfg.webdav.username}:${cfg.webdav.password}`).toString("base64")}`
        : undefined;

    let targetDirUrl = baseHref;
    if (cleanDir) {
      const segments = cleanDir.split("/").filter(Boolean);
      let acc = baseHref;
      for (const seg of segments) {
        acc = `${acc}${encodeURIComponent(seg)}/`;
        // 幂等创建远端目录（201 Created / 405 Already Exists 均视为正常）
        await fetch(acc, {
          method: "MKCOL",
          headers: auth ? { Authorization: auth } : undefined,
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
      }
      targetDirUrl = acc;
    }

    const putRes = await fetch(`${targetDirUrl}${encodeURIComponent(filename)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(data.length),
        ...(auth ? { Authorization: auth } : {}),
      },
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(30_000),
    });
    if (!putRes.ok) {
      throw new Error(`WebDAV 上传失败（HTTP ${putRes.status}）`);
    }
  }

  async runBackupNow(): Promise<{ snapshot: BackupSnapshotItem; webdavUploaded: boolean; config: BackupConfigPublic }> {
    if (this.running) throw new Error("正在执行备份任务，请稍候");
    this.running = true;
    try {
      const cfg = await this.ensureLoaded();
      await fs.mkdir(this.backupsDir, { recursive: true });
      const pages = await this.getPages();
      const zipBuf = await exportWorkspaceBackupZip(pages, this.uploadsDir);
      const encrypted = Boolean(cfg.encryptPassword);
      const outBuf = encrypted ? encryptBackupBuffer(zipBuf, cfg.encryptPassword) : zipBuf;
      const suffix = crypto.randomBytes(2).toString("hex");
      const ext = encrypted ? "opennotion.enc" : "zip";
      const filename = `OpenNotion-${formatStamp()}-${suffix}.${ext}`;
      const fullPath = path.join(this.backupsDir, filename);
      await fs.writeFile(fullPath, outBuf, { mode: 0o600 });

      // 按保留份数清理最旧的本地备份
      const all = await this.listSnapshots();
      if (all.length > cfg.keepCount) {
        for (const old of all.slice(cfg.keepCount)) {
          await fs.unlink(path.join(this.backupsDir, old.filename)).catch(() => {});
        }
      }

      let webdavUploaded = false;
      let statusMsg = `本地快照已生成（${filename}）`;
      if (cfg.webdav.enabled && cfg.webdav.url) {
        await this.uploadToWebDav(cfg, filename, outBuf);
        webdavUploaded = true;
        statusMsg += "，并已同步上传至 WebDAV";
      }

      const nextCfg: BackupConfigStored = {
        ...cfg,
        lastBackupAt: Date.now(),
        lastStatus: statusMsg,
      };
      await this.saveConfig(nextCfg);
      const st = await fs.stat(fullPath);
      return {
        snapshot: { filename, size: st.size, createdAt: Math.round(st.mtimeMs), encrypted },
        webdavUploaded,
        config: this.toPublic(nextCfg),
      };
    } catch (err) {
      const cfg = await this.ensureLoaded();
      const msg = err instanceof Error ? err.message : String(err);
      await this.saveConfig({ ...cfg, lastStatus: `备份失败：${msg}` }).catch(() => {});
      throw err;
    } finally {
      this.running = false;
    }
  }

  startScheduler(): void {
    void this.ensureLoaded();
  }

  private syncSchedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.config?.autoEnabled) return;
    // 每 15 分钟巡检一次是否到达自动备份周期
    this.timer = setInterval(() => {
      void this.checkAndRunAutoBackup();
    }, 15 * 60 * 1000);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async checkAndRunAutoBackup(): Promise<void> {
    const cfg = await this.ensureLoaded();
    if (!cfg.autoEnabled || this.running) return;
    const dueMs = cfg.intervalHours * 3600 * 1000;
    if (!cfg.lastBackupAt || Date.now() - cfg.lastBackupAt >= dueMs) {
      await this.runBackupNow().catch(() => {});
    }
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
