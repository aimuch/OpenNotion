import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import type { PageMeta, PageRecord } from "../shared/types.ts";
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
