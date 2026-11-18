/**
 * 本地存储服务：把每个页面保存为 data/pages/<id>.json，
 * 上传的文件保存在 data/uploads/。只用 Node 内置模块。
 */
import fs from "node:fs/promises";
import { createReadStream, watch as watchFs, type FSWatcher } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AiChatMessage,
  AiCitation,
  AiConfigUpdate,
  AiProtocol,
  DatabaseDef,
  HistoryEntry,
  PageComment,
  PageFont,
  PageKind,
  PageMeta,
  PageRecord,
  PropValue,
  SearchHit,
} from "../shared/types.ts";
import { AiService, unfurlUrl } from "./ai.ts";
import { exportWorkspaceBackupZip } from "./backup.ts";
import { clipWebPage } from "./clipper.ts";
import { McpService } from "./mcp.ts";
import { notesContent, sampleDatabase, sampleRows, welcomeContent } from "./seed.ts";

const ID_RE = /^[a-f0-9]{16}$/;
const UPLOAD_RE = /^[a-f0-9]{16}(\.[a-z0-9]{1,8})?$/;
const MAX_JSON = 32 * 1024 * 1024;
const MAX_UPLOAD = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  pdf: "application/pdf",
};

/** 同一页面两个历史版本之间至少隔多久 */
const SNAPSHOT_INTERVAL = 10 * 60 * 1000;
/** 每个页面最多保留多少个历史版本 */
const MAX_VERSIONS = 40;

const newId = () => crypto.randomBytes(8).toString("hex");

function cleanFont(v: unknown): PageFont {
  return v === "serif" || v === "mono" ? v : "sans";
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const tag = item.trim().replace(/^#+/, "").slice(0, 40);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 24) break;
  }
  return out;
}

function cleanComments(v: unknown): PageComment[] {
  if (!Array.isArray(v)) return [];
  const out: PageComment[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const c = item as Partial<PageComment>;
    if (typeof c.id !== "string" || typeof c.text !== "string" || !c.text.trim()) continue;
    out.push({
      id: c.id.slice(0, 32),
      author: typeof c.author === "string" && c.author.trim() ? c.author.trim().slice(0, 40) : "我",
      text: c.text.slice(0, 4000),
      ...(typeof c.quote === "string" && c.quote.trim() ? { quote: c.quote.trim().slice(0, 600) } : {}),
      ...(typeof c.resolved === "boolean" ? { resolved: c.resolved } : {}),
      createdAt: typeof c.createdAt === "number" ? c.createdAt : Date.now(),
    });
  }
  return out;
}

/** 把从磁盘读到的页面补全成当前版本的结构（兼容旧文件） */
function normalize(page: PageRecord): PageRecord {
  page.content = Array.isArray(page.content) ? page.content : [];
  page.kind = page.kind === "database" ? "database" : "page";
  page.database = page.kind === "database" ? (cleanDatabase(page.database) ?? { properties: [], views: [] }) : null;
  page.props = cleanProps(page.props) ?? {};
  page.tags = cleanTags(page.tags);
  page.smallText = page.smallText === true;
  page.font = cleanFont(page.font);
  page.locked = page.locked === true;
  page.comments = cleanComments(page.comments);
  page.template = page.template === true;
  page.hidden = page.hidden === true;
  return page;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function cleanDatabase(v: unknown): DatabaseDef | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Partial<DatabaseDef>;
  if (!Array.isArray(d.properties) || !Array.isArray(d.views)) return null;
  return {
    properties: d.properties,
    views: d.views,
    ...(typeof d.subItemsEnabled === "boolean" ? { subItemsEnabled: d.subItemsEnabled } : {}),
    ...(d.dependencyProp === null || typeof d.dependencyProp === "string" ? { dependencyProp: d.dependencyProp } : {}),
    ...(Array.isArray(d.automations) ? { automations: d.automations } : {}),
  };
}

function cleanProps(v: unknown): Record<string, PropValue> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, PropValue>;
}

function toMeta(p: PageRecord): PageMeta {
  const { content: _content, ...meta } = p;
  return meta;
}

/** 从 BlockNote 文档里抽出纯文本，用于搜索。 */
function extractText(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) extractText(n, out);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.text === "string") out.push(obj.text);
    if (obj.props && typeof obj.props === "object") {
      const p = obj.props as Record<string, unknown>;
      if (typeof p.latex === "string" && p.latex) out.push(p.latex);
      if (typeof p.code === "string" && p.code) out.push(p.code);
      if (typeof p.outline === "string" && p.outline) out.push(p.outline);
      if (typeof p.colsJson === "string" && p.colsJson) {
        try {
          extractText(JSON.parse(p.colsJson), out);
        } catch {
          /* 忽略不合法的分栏 JSON */
        }
      }
    }
    for (const key of ["content", "children", "rows", "cells", "blocks"]) {
      const v = obj[key];
      if (typeof v === "string") out.push(v);
      else if (v) extractText(v, out);
    }
  } else if (typeof node === "string") {
    out.push(node);
  }
  return out;
}

class Store {
  private pages = new Map<string, PageRecord>();
  private text = new Map<string, string>();
  private writes = new Map<string, Promise<void>>();
  private activeWrites = new Set<string>();
  private fileMtimes = new Map<string, number>();
  private watcher: FSWatcher | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private ready: Promise<void> | null = null;
  /** 页面 id → 上一次保存历史版本的时间 */
  private lastSnapshot = new Map<string, number>();
  readonly pagesDir: string;
  readonly uploadsDir: string;
  readonly historyDir: string;

  constructor(dir: string) {
    this.pagesDir = path.join(dir, "pages");
    this.uploadsDir = path.join(dir, "uploads");
    this.historyDir = path.join(dir, "history");
  }

  init(): Promise<void> {
    this.ready ??= this.load();
    return this.ready;
  }

  private async load() {
    await fs.mkdir(this.pagesDir, { recursive: true });
    await fs.mkdir(this.uploadsDir, { recursive: true });
    const files = await fs.readdir(this.pagesDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const fullPath = path.join(this.pagesDir, f);
        const [raw, st] = await Promise.all([fs.readFile(fullPath, "utf8"), fs.stat(fullPath)]);
        const page = JSON.parse(raw) as PageRecord;
        if (!ID_RE.test(page.id) || `${page.id}.json` !== f) continue;
        this.pages.set(page.id, normalize(page));
        this.fileMtimes.set(page.id, st.mtimeMs);
      } catch (err) {
        console.warn(`[storage] 跳过无法读取的文件 ${f}:`, err);
      }
    }
    // 只在第一次启动时写入示例页面；之后即使删光所有页面也不会再生成
    const marker = path.join(this.pagesDir, ".initialized");
    const seeded = await fs.stat(marker).catch(() => null);
    if (!seeded) {
      if (this.pages.size === 0) await this.seed();
      await fs.writeFile(marker, new Date().toISOString());
    }
    this.startWatcher();
  }

  private startWatcher() {
    if (this.watcher) return;
    try {
      this.watcher = watchFs(this.pagesDir, (_event, filename) => {
        if (filename && !String(filename).endsWith(".json")) return;
        if (this.syncTimer) clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => {
          this.syncTimer = null;
          void this.syncFromDisk();
        }, 250);
        (this.syncTimer as unknown as { unref?: () => void }).unref?.();
      });
      this.watcher.on("error", () => {});
      (this.watcher as unknown as { unref?: () => void }).unref?.();
    } catch {
      /* 部分网络挂载盘（SMB/NFS）不支持底层文件监听，自动退回按需扫描 mtime */
    }
  }

  /** 扫描磁盘变更（用于 iCloud Drive / NAS / Syncthing 同步外部新文件或更新文件） */
  async syncFromDisk(): Promise<{ changed: boolean; updatedIds: string[]; removedIds: string[] }> {
    await this.init();
    const updatedIds: string[] = [];
    const removedIds: string[] = [];
    const entries = await fs.readdir(this.pagesDir).catch(() => [] as string[]);
    const seen = new Set<string>();

    for (const f of entries) {
      const m = /^([a-f0-9]{16})\.json$/.exec(f);
      if (!m) continue;
      const id = m[1];
      seen.add(id);
      if (this.activeWrites.has(id)) continue;
      const fullPath = path.join(this.pagesDir, f);
      const st = await fs.stat(fullPath).catch(() => null);
      if (!st) continue;
      if (this.fileMtimes.get(id) === st.mtimeMs && this.pages.has(id)) continue;
      try {
        const raw = await fs.readFile(fullPath, "utf8");
        const page = JSON.parse(raw) as PageRecord;
        if (page.id !== id) continue;
        this.pages.set(id, normalize(page));
        this.fileMtimes.set(id, st.mtimeMs);
        if (page.kind === "database") this.text.clear();
        else this.text.delete(id);
        updatedIds.push(id);
      } catch {
        /* 同步客户端正在写入半截文件时跳过，等下次完整落盘再读 */
      }
    }

    for (const id of [...this.pages.keys()]) {
      if (!seen.has(id) && !this.activeWrites.has(id)) {
        this.pages.delete(id);
        this.fileMtimes.delete(id);
        this.text.delete(id);
        removedIds.push(id);
      }
    }

    return { changed: updatedIds.length > 0 || removedIds.length > 0, updatedIds, removedIds };
  }

  close() {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  private async seed() {
    const welcome = this.create({ title: "欢迎使用", icon: "👋", content: welcomeContent });
    this.create({ parentId: welcome.id, title: "我的第一篇笔记", icon: "📝", content: notesContent });
    const tasks = this.create({ title: "任务看板", icon: "✅", kind: "database", database: sampleDatabase });
    for (const row of sampleRows) this.create({ parentId: tasks.id, ...row });
    await Promise.all(this.writes.values());
  }

  private persist(page: PageRecord) {
    // 数据库的选项改名会影响所有行的搜索文本
    if (page.kind === "database") this.text.clear();
    else this.text.delete(page.id);
    const file = path.join(this.pagesDir, `${page.id}.json`);
    const data = JSON.stringify(page, null, 2);
    const prev = this.writes.get(page.id) ?? Promise.resolve();
    this.activeWrites.add(page.id);
    const next = prev
      .catch(() => {})
      .then(async () => {
        const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        await fs.writeFile(tmp, data);
        await fs.rename(tmp, file);
        const st = await fs.stat(file).catch(() => null);
        if (st) this.fileMtimes.set(page.id, st.mtimeMs);
      })
      .finally(() => {
        if (this.writes.get(page.id) === next) this.activeWrites.delete(page.id);
      });
    this.writes.set(page.id, next);
    next.catch((err) => console.error(`[storage] 写入 ${page.id} 失败:`, err));
    return next;
  }

  private unlink(id: string) {
    this.text.delete(id);
    this.fileMtimes.delete(id);
    const file = path.join(this.pagesDir, `${id}.json`);
    const prev = this.writes.get(id) ?? Promise.resolve();
    this.activeWrites.add(id);
    const next = prev
      .catch(() => {})
      .then(() => fs.rm(file, { force: true }))
      .finally(() => {
        if (this.writes.get(id) === next) this.activeWrites.delete(id);
      });
    this.writes.set(id, next);
    return next;
  }

  /** 等所有排队中的磁盘写入完成（退出前调用） */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.writes.values()]);
  }

  metas(): PageMeta[] {
    return [...this.pages.values()].map(toMeta);
  }

  allRecords(): PageRecord[] {
    return [...this.pages.values()];
  }

  findOrNull(id: string): PageRecord | null {
    return this.pages.get(id) ?? null;
  }

  /** 无损恢复或覆盖写入备份包中的完整 PageRecord 集合 */
  async restoreRecords(records: unknown[]): Promise<{ imported: number; updated: number }> {
    let imported = 0;
    let updated = 0;
    for (const item of records) {
      if (!item || typeof item !== "object") continue;
      const raw = item as PageRecord;
      if (!ID_RE.test(String(raw.id ?? ""))) continue;
      const existed = this.pages.has(raw.id);
      const normalized = normalize(raw);
      this.pages.set(normalized.id, normalized);
      this.text.delete(normalized.id);
      void this.persist(normalized);
      if (existed) updated++;
      else imported++;
    }
    await this.settled();
    return { imported, updated };
  }

  get(id: string): PageRecord {
    const page = this.pages.get(id);
    if (!page) throw new HttpError(404, "页面不存在");
    return page;
  }

  private siblings(parentId: string | null, excludeId?: string): PageRecord[] {
    return [...this.pages.values()]
      .filter((p) => p.parentId === parentId && !p.trashed && p.id !== excludeId)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  private descendants(id: string): PageRecord[] {
    const out: PageRecord[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const p of this.pages.values()) {
        if (p.parentId === cur) {
          out.push(p);
          stack.push(p.id);
        }
      }
    }
    return out;
  }

  create(input: {
    parentId?: string | null;
    title?: string;
    icon?: string | null;
    cover?: string | null;
    tags?: string[];
    content?: unknown[];
    kind?: PageKind;
    database?: DatabaseDef | null;
    props?: Record<string, PropValue>;
    hidden?: boolean;
  }): PageRecord {
    const kind: PageKind = input.kind === "database" ? "database" : "page";
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      const parent = this.get(parentId);
      if (parent.trashed) throw new HttpError(400, "不能在回收站中的页面下新建页面");
    }
    const sibs = this.siblings(parentId);
    const now = Date.now();
    const page: PageRecord = {
      id: newId(),
      title: typeof input.title === "string" ? input.title : "",
      icon: input.icon ?? null,
      cover: input.cover ?? null,
      tags: cleanTags(input.tags),
      parentId,
      order: sibs.length ? sibs[sibs.length - 1].order + 1 : 0,
      favorite: false,
      fullWidth: false,
      smallText: false,
      font: "sans",
      locked: false,
      comments: [],
      trashed: false,
      trashedAt: null,
      createdAt: now,
      updatedAt: now,
      kind,
      database: kind === "database" ? (cleanDatabase(input.database) ?? { properties: [], views: [] }) : null,
      props: cleanProps(input.props) ?? {},
      template: false,
      hidden: input.hidden === true,
      content: Array.isArray(input.content) ? input.content : [],
    };
    this.pages.set(page.id, page);
    void this.persist(page);
    return page;
  }

  update(id: string, patch: Record<string, unknown>): PageRecord {
    const page = this.get(id);
    // 正文或标题要变了：先把改之前的样子留一个历史版本（首次填入正文除外，免得留下一版空白记录）
    const titleChanged = typeof patch.title === "string" && patch.title !== page.title;
    const contentChanged = Array.isArray(patch.content) && page.content.length > 0;
    if (titleChanged || contentChanged) {
      this.snapshot(page);
    }
    if (typeof patch.template === "boolean") page.template = patch.template;
    if (typeof patch.title === "string") page.title = patch.title.slice(0, 2000);
    if (patch.icon === null || typeof patch.icon === "string") page.icon = patch.icon;
    if (patch.cover === null || typeof patch.cover === "string") page.cover = patch.cover;
    if (typeof patch.coverY === "number" && Number.isFinite(patch.coverY)) {
      page.coverY = Math.max(0, Math.min(100, Math.round(patch.coverY)));
    }
    if (Array.isArray(patch.tags)) {
      page.tags = cleanTags(patch.tags);
      this.text.delete(page.id);
    }
    if (typeof patch.favorite === "boolean") page.favorite = patch.favorite;
    if (patch.kind === "page" || patch.kind === "database") page.kind = patch.kind;
    const database = cleanDatabase(patch.database);
    if (database) page.database = database;
    if (page.kind === "database") page.database ??= { properties: [], views: [] };
    else page.database = null;
    const props = cleanProps(patch.props);
    if (props) page.props = props;
    if (typeof patch.fullWidth === "boolean") page.fullWidth = patch.fullWidth;
    if (typeof patch.smallText === "boolean") page.smallText = patch.smallText;
    if (patch.font === "sans" || patch.font === "serif" || patch.font === "mono") page.font = patch.font;
    if (typeof patch.locked === "boolean") page.locked = patch.locked;
    if (Array.isArray(patch.comments)) page.comments = cleanComments(patch.comments);
    if (Array.isArray(patch.content)) page.content = patch.content;
    page.updatedAt = Date.now();
    void this.persist(page);
    return page;
  }

  move(id: string, parentId: string | null, index: number) {
    const page = this.get(id);
    if (parentId !== null) {
      const parent = this.get(parentId);
      if (parent.trashed) throw new HttpError(400, "目标页面在回收站中");
      if (parentId === id || this.descendants(id).some((d) => d.id === parentId)) {
        throw new HttpError(400, "不能把页面移动到它自己的子页面下");
      }
    }
    const sibs = this.siblings(parentId, id);
    const at = Math.max(0, Math.min(Number.isFinite(index) ? index : sibs.length, sibs.length));
    sibs.splice(at, 0, page);
    page.parentId = parentId;
    sibs.forEach((p, i) => {
      if (p.order !== i || p === page) {
        p.order = i;
        void this.persist(p);
      }
    });
  }

  trash(id: string) {
    const page = this.get(id);
    if (page.trashed) return;
    const now = Date.now();
    for (const p of [page, ...this.descendants(id)]) {
      if (p.trashed) continue;
      p.trashed = true;
      p.trashedAt = now;
      void this.persist(p);
    }
  }

  restore(id: string) {
    const page = this.get(id);
    if (!page.trashed) return;
    const stamp = page.trashedAt;
    const parent = page.parentId ? this.pages.get(page.parentId) : null;
    if (page.parentId && (!parent || parent.trashed)) page.parentId = null;
    const sibs = this.siblings(page.parentId, id);
    page.order = sibs.length ? sibs[sibs.length - 1].order + 1 : 0;
    for (const p of [page, ...this.descendants(id)]) {
      // 只恢复当初随它一起删除的子页面
      if (p !== page && p.trashedAt !== stamp) continue;
      p.trashed = false;
      p.trashedAt = null;
      void this.persist(p);
    }
  }

  remove(id: string) {
    const page = this.get(id);
    for (const p of [page, ...this.descendants(id)]) {
      this.pages.delete(p.id);
      this.lastSnapshot.delete(p.id);
      void this.unlink(p.id);
      void fs.rm(path.join(this.historyDir, p.id), { recursive: true, force: true }).catch(() => {});
    }
  }

  emptyTrash() {
    for (const p of [...this.pages.values()]) {
      if (p.trashed && this.pages.has(p.id)) this.remove(p.id);
    }
  }

  /** 复制一个页面和它的全部子页面；copies 记录“原页面 id → 副本” */
  private copySubtree(
    from: PageRecord,
    parentId: string | null,
    title: string,
    copies: Map<string, PageRecord>,
  ): PageRecord {
    // 先取子页面列表，免得把刚建出来的副本也算进去
    const children = this.siblings(from.id);
    const copy = this.create({
      parentId,
      title,
      icon: from.icon,
      cover: from.cover,
      tags: [...(from.tags ?? [])],
      content: structuredClone(from.content),
      kind: from.kind,
      database: structuredClone(from.database),
      props: structuredClone(from.props),
    });
    if (typeof from.coverY === "number") copy.coverY = from.coverY;
    copy.fullWidth = from.fullWidth;
    copy.smallText = from.smallText;
    copy.font = from.font;
    copies.set(from.id, copy);
    for (const child of children) this.copySubtree(child, copy.id, child.title, copies);
    return copy;
  }

  /**
   * 副本里指向“被一起复制的页面”的引用（子页面链接、内嵌数据库、关联）改指向对应的副本，
   * 否则副本里的内嵌数据库仍然是原来那一个，改一处两边都变。
   */
  private remapCopies(copies: Map<string, PageRecord>) {
    for (const page of copies.values()) {
      const before = JSON.stringify([page.content, page.props, page.database]);
      let json = before;
      for (const [oldId, fresh] of copies) {
        if (json.includes(oldId)) json = json.replaceAll(oldId, fresh.id);
      }
      if (json === before) continue;
      const [content, props, database] = JSON.parse(json);
      page.content = content;
      page.props = props;
      page.database = database;
      void this.persist(page);
    }
  }

  duplicate(id: string): PageRecord {
    const src = this.get(id);
    const copies = new Map<string, PageRecord>();
    const copy = this.copySubtree(src, src.parentId, `${src.title || "无标题"}（副本）`, copies);
    this.remapCopies(copies);
    // 放到原页面的正后方
    const sibs = this.siblings(src.parentId, copy.id);
    this.move(copy.id, src.parentId, sibs.findIndex((p) => p.id === src.id) + 1);
    return copy;
  }

  /** 把模板的内容套到一个已有页面上：正文、图标、封面和子页面都复制过来 */
  applyTemplate(targetId: string, templateId: string) {
    const target = this.get(targetId);
    const template = this.get(templateId);
    if (target.id === template.id) throw new HttpError(400, "不能把页面套用到它自己身上");
    this.snapshot(target, true);
    const copies = new Map<string, PageRecord>([[template.id, target]]);
    for (const child of this.siblings(template.id)) this.copySubtree(child, target.id, child.title, copies);
    target.content = structuredClone(template.content);
    target.icon = target.icon ?? template.icon;
    target.cover = target.cover ?? template.cover;
    if (typeof template.coverY === "number" && target.coverY === undefined) target.coverY = template.coverY;
    if ((!target.tags || target.tags.length === 0) && template.tags?.length) {
      target.tags = [...template.tags];
    }
    target.fullWidth = template.fullWidth;
    target.smallText = template.smallText;
    target.font = template.font;
    target.kind = template.kind;
    target.database = structuredClone(template.database);
    if (!target.title) target.title = template.title;
    target.updatedAt = Date.now();
    void this.persist(target);
    this.remapCopies(copies);
  }

  /* ---------- 页面历史 ---------- */

  /** 给页面当前的样子存一个历史版本。默认同一页面每 10 分钟最多存一次。 */
  private snapshot(page: PageRecord, force = false) {
    if (page.kind !== "page") return;
    if (page.content.length === 0 && !page.title) return;
    const now = Date.now();
    if (!force && now - (this.lastSnapshot.get(page.id) ?? 0) < SNAPSHOT_INTERVAL) return;
    this.lastSnapshot.set(page.id, now);
    const dir = path.join(this.historyDir, page.id);
    const data = JSON.stringify({ ts: now, title: page.title, icon: page.icon, content: page.content });
    void fs
      .mkdir(dir, { recursive: true })
      .then(() => fs.writeFile(path.join(dir, `${now}.json`), data))
      .then(() => this.pruneHistory(dir))
      .catch((err) => console.error(`[history] 保存 ${page.id} 的历史版本失败:`, err));
  }

  private async pruneHistory(dir: string) {
    const files = (await fs.readdir(dir)).filter((f) => /^\d+\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_VERSIONS))) {
      await fs.rm(path.join(dir, f), { force: true });
    }
  }

  async history(id: string): Promise<HistoryEntry[]> {
    this.get(id);
    const dir = path.join(this.historyDir, id);
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    const out: HistoryEntry[] = [];
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const v = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
        out.push({ ts: Number(v.ts), title: String(v.title ?? ""), chars: extractText(v.content).join("").length });
      } catch {
        /* 读不出来的版本直接跳过 */
      }
    }
    return out.sort((a, b) => b.ts - a.ts);
  }

  async version(id: string, ts: string): Promise<{ ts: number; title: string; icon: string | null; content: unknown[] }> {
    this.get(id);
    if (!/^\d{10,16}$/.test(ts)) throw new HttpError(404, "版本不存在");
    try {
      const v = JSON.parse(await fs.readFile(path.join(this.historyDir, id, `${ts}.json`), "utf8"));
      return { ts: Number(v.ts), title: String(v.title ?? ""), icon: v.icon ?? null, content: Array.isArray(v.content) ? v.content : [] };
    } catch {
      throw new HttpError(404, "版本不存在");
    }
  }

  async restoreVersion(id: string, ts: string) {
    const page = this.get(id);
    const v = await this.version(id, ts);
    // 恢复前把现在的样子也存一版，恢复错了还能回来
    this.snapshot(page, true);
    page.title = v.title;
    page.icon = v.icon;
    page.content = v.content;
    page.updatedAt = Date.now();
    void this.persist(page);
  }

  /* ---------- 从另一个数据文件夹导入 ---------- */

  /** 把另一份数据（例如网页版的 data/ 目录）并进来。已经存在的页面和文件不覆盖。 */
  async importFolder(dir: string): Promise<{ pages: number; skipped: number; files: number }> {
    await this.init();
    let root = dir;
    // 既可以选 data/ 目录本身，也可以选它的上一级或里面的 pages 目录
    if (!(await fs.stat(path.join(root, "pages")).catch(() => null))?.isDirectory()) {
      root = path.basename(dir) === "pages" ? path.dirname(dir) : path.join(dir, "data");
    }
    const srcPages = path.join(root, "pages");
    if (!(await fs.stat(srcPages).catch(() => null))?.isDirectory()) {
      throw new HttpError(400, "这个文件夹里没有找到 pages 目录");
    }
    if (path.resolve(srcPages) === path.resolve(this.pagesDir)) {
      throw new HttpError(400, "选中的就是当前正在使用的数据文件夹");
    }
    let pages = 0;
    let skipped = 0;
    const importedIds: string[] = [];
    for (const f of await fs.readdir(srcPages)) {
      if (!f.endsWith(".json")) continue;
      try {
        const page = JSON.parse(await fs.readFile(path.join(srcPages, f), "utf8")) as PageRecord;
        if (!ID_RE.test(page.id) || `${page.id}.json` !== f) continue;
        if (this.pages.has(page.id)) {
          skipped++;
          continue;
        }
        this.pages.set(page.id, normalize(page));
        void this.persist(page);
        importedIds.push(page.id);
        pages++;
      } catch {
        skipped++;
      }
    }
    let files = 0;
    const srcUploads = path.join(root, "uploads");
    for (const f of await fs.readdir(srcUploads).catch(() => [] as string[])) {
      if (!UPLOAD_RE.test(f)) continue;
      const dest = path.join(this.uploadsDir, f);
      if (await fs.stat(dest).catch(() => null)) continue;
      await fs.copyFile(path.join(srcUploads, f), dest);
      files++;
    }
    const srcHistory = path.join(root, "history");
    for (const id of importedIds) {
      const entries = await fs.readdir(path.join(srcHistory, id)).catch(() => [] as string[]);
      const valid = entries.filter((f) => /^\d{10,16}\.json$/.test(f));
      if (valid.length === 0) continue;
      const destDir = path.join(this.historyDir, id);
      await fs.mkdir(destDir, { recursive: true });
      for (const f of valid) {
        const dest = path.join(destDir, f);
        if (await fs.stat(dest).catch(() => null)) continue;
        await fs.copyFile(path.join(srcHistory, id, f), dest).catch(() => {});
      }
    }
    await this.settled();
    return { pages, skipped, files };
  }

  /** 行的属性值也参与搜索：文本原样，单选/多选换成选项名 */
  private propsText(p: PageRecord): string[] {
    const defs = (p.parentId ? this.pages.get(p.parentId)?.database?.properties : null) ?? [];
    const out: string[] = [];
    for (const [key, value] of Object.entries(p.props ?? {})) {
      const options = defs.find((d) => d.id === key)?.options;
      for (const v of Array.isArray(value) ? value : [value]) {
        if (typeof v !== "string") continue;
        out.push(options?.find((o) => o.id === v)?.name ?? v);
      }
    }
    return out;
  }

  search(query: string): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: (SearchHit & { score: number; updatedAt: number })[] = [];
    for (const p of this.pages.values()) {
      if (p.trashed || p.hidden) continue;
      let body = this.text.get(p.id);
      if (body === undefined) {
        const tagTokens = (p.tags ?? []).flatMap((t) => [t, `#${t}`]);
        body = [...tagTokens, ...extractText(p.content), ...this.propsText(p)].join(" ").replace(/\s+/g, " ");
        this.text.set(p.id, body);
      }
      const inTitle = p.title.toLowerCase().includes(q);
      const at = body.toLowerCase().indexOf(q);
      if (!inTitle && at < 0) continue;
      let snippet = "";
      if (at >= 0) {
        const start = Math.max(0, at - 30);
        snippet = (start > 0 ? "…" : "") + body.slice(start, at + q.length + 60);
        if (at + q.length + 60 < body.length) snippet += "…";
      } else {
        snippet = body.slice(0, 90);
      }
      hits.push({
        id: p.id,
        title: p.title,
        icon: p.icon,
        snippet,
        score: inTitle ? 2 : 1,
        updatedAt: p.updatedAt,
      });
    }
    hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
    return hits.slice(0, 30).map(({ score: _s, updatedAt: _u, ...hit }) => hit);
  }

  /** 查找所有引用了指定页面的其他页面（@提及、内部链接、链接数据库、数据库关联列） */
  backlinks(targetId: string): SearchHit[] {
    this.get(targetId);
    const results: (SearchHit & { updatedAt: number })[] = [];
    for (const p of this.pages.values()) {
      if (p.id === targetId || p.trashed || p.hidden) continue;
      const inRelation = Object.values(p.props ?? {}).some((v) => Array.isArray(v) && v.includes(targetId));
      const rawContent = JSON.stringify(p.content);
      const inContent = rawContent.includes(targetId);
      if (!inRelation && !inContent) continue;
      const body = [...extractText(p.content), ...this.propsText(p)].join(" ").replace(/\s+/g, " ");
      results.push({
        id: p.id,
        title: p.title,
        icon: p.icon,
        snippet: inRelation && !inContent ? "通过数据库关联属性引用" : body.slice(0, 90),
        updatedAt: p.updatedAt,
      });
    }
    results.sort((a, b) => b.updatedAt - a.updatedAt);
    return results.map(({ updatedAt: _u, ...rest }) => rest);
  }

  /** 清理没有任何页面引用的孤立同步块内部页面 */
  cleanOrphanSynced(): number {
    const referenced = new Set<string>();
    const collect = (node: unknown) => {
      if (Array.isArray(node)) {
        for (const item of node) collect(item);
      } else if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (obj.type === "synced" && obj.props && typeof (obj.props as { sourceId?: string }).sourceId === "string") {
          referenced.add((obj.props as { sourceId: string }).sourceId);
        }
        if (obj.children) collect(obj.children);
        if (obj.content) collect(obj.content);
      }
    };
    for (const p of this.pages.values()) {
      if (!p.hidden) collect(p.content);
    }
    let removed = 0;
    for (const p of [...this.pages.values()]) {
      if (p.hidden && !referenced.has(p.id)) {
        this.remove(p.id);
        removed++;
      }
    }
    return removed;
  }

  /** 将一个页面（或数据库及其行）整理为供大模型阅读的结构化上下文 */
  private formatPageContext(p: PageRecord, maxBody = 3500): string {
    const lines: string[] = [`# ${p.title || "无标题"}`];
    if (p.parentId) {
      const parent = this.pages.get(p.parentId);
      if (parent?.kind === "database" && parent.database) {
        const propPairs = parent.database.properties
          .map((def) => {
            const val = p.props[def.id];
            if (val === null || val === undefined || val === "") return "";
            if (def.type === "select" || def.type === "multiSelect") {
              const ids = Array.isArray(val) ? val : [String(val)];
              const names = ids.map((id) => def.options?.find((o) => o.id === id)?.name ?? id).filter(Boolean);
              return names.length ? `${def.name}: ${names.join("、")}` : "";
            }
            if (def.type === "relation" && Array.isArray(val)) {
              const names = val.map((id) => this.pages.get(id)?.title || "无标题");
              return names.length ? `${def.name}: ${names.join("、")}` : "";
            }
            return `${def.name}: ${typeof val === "boolean" ? (val ? "是" : "否") : String(val)}`;
          })
          .filter(Boolean);
        if (propPairs.length > 0) lines.push(propPairs.join(" | "));
      }
    }
    if (p.kind === "database" && p.database) {
      const rows = this.siblings(p.id);
      lines.push(`数据库（共 ${rows.length} 行），列：${p.database.properties.map((d) => d.name).join("、")}`);
      for (const row of rows.slice(0, 60)) {
        const vals = p.database.properties
          .map((def) => {
            const val = row.props[def.id];
            if (val === null || val === undefined || val === "") return "";
            if (def.type === "select" || def.type === "multiSelect") {
              const ids = Array.isArray(val) ? val : [String(val)];
              return `${def.name}=${ids.map((id) => def.options?.find((o) => o.id === id)?.name ?? id).join("/")}`;
            }
            return `${def.name}=${String(val)}`;
          })
          .filter(Boolean)
          .join(", ");
        lines.push(`- ${row.title || "无标题"}${vals ? ` (${vals})` : ""}`);
      }
    } else {
      const body = extractText(p.content).join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (body) lines.push(body.slice(0, maxBody));
    }
    return lines.join("\n");
  }

  /** 为 AI 助手组装当前页或全工作区检索（RAG）上下文 */
  buildAiContext(scope: string, query: string, pageId?: string): { context: string; citations: AiCitation[] } {
    if (scope === "page" && pageId && this.pages.has(pageId)) {
      const p = this.pages.get(pageId)!;
      return {
        context: `以下是用户当前正在查看的页面内容：\n\n${this.formatPageContext(p, 8000)}`,
        citations: [{ id: p.id, title: p.title || "无标题", icon: p.icon }],
      };
    }
    if (scope !== "workspace") return { context: "", citations: [] };

    const q = query.trim().toLowerCase();
    // 兼顾英文空格分词与中文双字切分检索
    const terms = new Set<string>();
    for (const part of q.split(/[\s,，。？！、；：/]+/).filter(Boolean)) {
      if (part.length >= 2) terms.add(part);
      for (let i = 0; i + 1 < part.length; i++) {
        const bi = part.slice(i, i + 2);
        if (/[\u4e00-\u9fff]/.test(bi)) terms.add(bi);
      }
    }

    const candidates = [...this.pages.values()]
      .filter((p) => !p.trashed && !p.hidden)
      .map((p) => {
        const title = p.title.toLowerCase();
        const body = ([...extractText(p.content), ...this.propsText(p)].join(" ")).toLowerCase();
        let score = p.id === pageId ? 3 : 0;
        for (const t of terms) {
          if (title.includes(t)) score += 4;
          if (body.includes(t)) score += 1;
        }
        return { p, score };
      })
      .sort((a, b) => b.score - a.score || b.p.updatedAt - a.p.updatedAt);

    const picked = (candidates.some((c) => c.score > 0) ? candidates.filter((c) => c.score > 0) : candidates).slice(0, 8);
    if (picked.length === 0) return { context: "", citations: [] };

    const sections = picked.map(({ p }, i) => `【资料 ${i + 1}】\n${this.formatPageContext(p, 1800)}`);
    const citations: AiCitation[] = picked.map(({ p }) => ({ id: p.id, title: p.title || "无标题", icon: p.icon }));
    return {
      context: `以下是从用户本地 OpenNotion 工作区检索到的相关页面与数据库内容，请优先依据这些内容回答问题；如果工作区中没有相关信息，请如实说明：\n\n${sections.join("\n\n---\n\n")}`,
      citations,
    };
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "内容过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
    throw new HttpError(415, "需要 application/json");
  }
  const buf = await readBody(req, MAX_JSON);
  if (buf.length === 0) return {};
  try {
    const data = JSON.parse(buf.toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, "JSON 格式错误");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

type Next = (err?: unknown) => void;

export function createApiMiddleware(dataDir: string) {
  const store = new Store(dataDir);
  const ai = new AiService(dataDir);
  const mcp = new McpService({
    dataDir,
    listMetas: () => store.metas(),
    getPage: (id) => store.findOrNull(id),
    search: (q) => store.search(q),
    createPage: (input) => store.create(input),
    updatePage: (id, patch) => store.update(id, patch as Record<string, unknown>),
    trashPage: (id) => store.trash(id),
    flush: () => store.settled(),
  });

  async function serveUpload(name: string, res: ServerResponse) {
    if (!UPLOAD_RE.test(name)) throw new HttpError(404, "文件不存在");
    const file = path.join(store.uploadsDir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new HttpError(404, "文件不存在");
    const ext = name.split(".")[1] ?? "";
    const type = MIME[ext];
    res.writeHead(200, {
      "Content-Type": type ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // 上传的文件即使被直接打开也不允许执行脚本
      "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      ...(type ? {} : { "Content-Disposition": "attachment" }),
    });
    createReadStream(file).pipe(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "uploads") {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "不支持的方法");
      await store.init();
      return serveUpload(parts[1] ?? "", res);
    }

    const [, resource, id, action, sub, verb] = parts;
    const origin = req.headers.origin;
    const isCrossOrigin = Boolean(origin && new URL(origin).host !== req.headers.host);
    const allowExternalBearer =
      (resource === "mcp" && !id) || (resource === "clip" && !id);

    if (isCrossOrigin && allowExternalBearer) {
      res.setHeader("Access-Control-Allow-Origin", origin!);
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      // 跨站调用（如浏览器书签栏剪藏小工具或外部 Web MCP 客户端）必须携带与本机匹配的密钥口令
      const cfg = await mcp.ensureConfig();
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!bearer || bearer !== cfg.token) {
        throw new HttpError(401, "外部剪藏或跨域 MCP 请求缺少有效的安全口令");
      }
    } else if (isCrossOrigin) {
      throw new HttpError(403, "跨域请求被拒绝");
    }
    await store.init();

    const all = () => send(res, 200, { pages: store.metas() });

    if (resource === "pages" && !id) {
      if (method === "GET") return all();
      if (method === "POST") {
        const body = await readJson(req);
        const parentId = typeof body.parentId === "string" ? body.parentId : null;
        const page = store.create({
          parentId,
          title: typeof body.title === "string" ? body.title : "",
          icon: typeof body.icon === "string" ? body.icon : null,
          tags: cleanTags(body.tags),
          kind: body.kind === "database" ? "database" : "page",
          database: cleanDatabase(body.database),
          props: cleanProps(body.props) ?? {},
          content: Array.isArray(body.content) ? body.content : [],
          hidden: body.hidden === true,
        });
        return send(res, 201, { id: page.id, pages: store.metas() });
      }
    }

    if (resource === "pages" && id) {
      if (!ID_RE.test(id)) throw new HttpError(404, "页面不存在");
      if (!action) {
        if (method === "GET") return send(res, 200, { page: store.get(id) });
        if (method === "PATCH") {
          const page = store.update(id, await readJson(req));
          return send(res, 200, { page: toMeta(page) });
        }
        if (method === "DELETE") {
          store.remove(id);
          return all();
        }
      } else if (action === "backlinks" && method === "GET") {
        return send(res, 200, { backlinks: store.backlinks(id) });
      } else if (action === "history") {
        if (method === "GET" && !sub) return send(res, 200, { versions: await store.history(id) });
        if (method === "GET" && sub && !verb) return send(res, 200, { version: await store.version(id, sub) });
        if (method === "POST" && sub && verb === "restore") {
          await readJson(req);
          await store.restoreVersion(id, sub);
          return all();
        }
      } else if (method === "POST") {
        const body = await readJson(req);
        if (action === "apply-template") {
          if (typeof body.templateId !== "string" || !ID_RE.test(body.templateId)) throw new HttpError(400, "缺少模板");
          store.applyTemplate(id, body.templateId);
          return all();
        }
        if (action === "trash") {
          store.trash(id);
          return all();
        }
        if (action === "restore") {
          store.restore(id);
          return all();
        }
        if (action === "duplicate") {
          const copy = store.duplicate(id);
          return send(res, 201, { id: copy.id, pages: store.metas() });
        }
        if (action === "move") {
          const parentId = typeof body.parentId === "string" ? body.parentId : null;
          store.move(id, parentId, typeof body.index === "number" ? body.index : Infinity);
          return all();
        }
      }
    }

    if (resource === "trash" && method === "DELETE") {
      store.emptyTrash();
      return all();
    }

    if (resource === "synced" && id === "cleanup" && method === "POST") {
      await readJson(req);
      const removed = store.cleanOrphanSynced();
      return send(res, 200, { removed, pages: store.metas() });
    }

    if (resource === "unfurl" && method === "GET") {
      const target = url.searchParams.get("url") ?? "";
      if (!target) throw new HttpError(400, "缺少网址");
      try {
        return send(res, 200, { data: await unfurlUrl(target) });
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }

    if (resource === "ai") {
      try {
        if (id === "config") {
          if (method === "GET") return send(res, 200, { config: await ai.getPublicConfig() });
          if (method === "PUT") {
            const body = (await readJson(req)) as unknown as AiConfigUpdate;
            return send(res, 200, { config: await ai.updateConfig(body) });
          }
        }
        if (id === "models" && method === "POST") {
          const body = await readJson(req);
          const models = await ai.fetchModels({
            providerId: typeof body.providerId === "string" ? body.providerId : undefined,
            protocol: body.protocol === "anthropic" || body.protocol === "gemini" ? (body.protocol as AiProtocol) : body.protocol === "openai" ? "openai" : undefined,
            baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
            apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
            headers: body.headers && typeof body.headers === "object" ? (body.headers as Record<string, string>) : undefined,
          });
          return send(res, 200, { models });
        }
        if (id === "test" && method === "POST") {
          const body = await readJson(req);
          const result = await ai.testConnection({
            providerId: typeof body.providerId === "string" ? body.providerId : undefined,
            model: typeof body.model === "string" ? body.model : undefined,
            protocol: body.protocol === "anthropic" || body.protocol === "gemini" ? (body.protocol as AiProtocol) : body.protocol === "openai" ? "openai" : undefined,
            baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
            apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
            headers: body.headers && typeof body.headers === "object" ? (body.headers as Record<string, string>) : undefined,
          });
          return send(res, 200, result);
        }
        if (id === "chat" && method === "POST") {
          const body = await readJson(req);
          const rawMessages = Array.isArray(body.messages) ? (body.messages as AiChatMessage[]) : [];
          const scope = typeof body.scope === "string" ? body.scope : "none";
          const pageId = typeof body.pageId === "string" ? body.pageId : undefined;
          const lastUser = [...rawMessages].reverse().find((m) => m?.role === "user")?.content ?? "";
          const { context, citations } = store.buildAiContext(scope, lastUser, pageId);
          const system = [typeof body.system === "string" ? body.system : "", context].filter(Boolean).join("\n\n");
          const abort = new AbortController();
          res.on("close", () => {
            if (!res.writableEnded) abort.abort();
          });
          await ai.streamChat(
            {
              providerId: typeof body.providerId === "string" ? body.providerId : undefined,
              model: typeof body.model === "string" ? body.model : undefined,
              messages: rawMessages,
              system,
              temperature: typeof body.temperature === "number" ? body.temperature : undefined,
              citations,
            },
            res,
            abort.signal,
          );
          return;
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }

    if (resource === "mcp") {
      const hostOrigin = `http://${req.headers.host ?? "localhost:5273"}`;
      if (id === "config") {
        if (method === "GET") {
          return send(res, 200, { config: await mcp.getPublicConfig(hostOrigin) });
        }
        if (method === "PUT") {
          const body = await readJson(req);
          const config = await mcp.updateConfig(
            {
              enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
              requireToken: typeof body.requireToken === "boolean" ? body.requireToken : undefined,
              rotateToken: body.rotateToken === true,
            },
            hostOrigin,
          );
          return send(res, 200, { config });
        }
      }
      if (!id && method === "POST") {
        const auth = await mcp.verifyHttpAuth(req.headers.authorization);
        if (!auth.ok) throw new HttpError(auth.status ?? 401, auth.message ?? "未授权");
        const body = await readJson(req);
        if (Array.isArray(body)) {
          const replies = (await Promise.all(body.map((item) => mcp.handleJsonRpc(item)))).filter(Boolean);
          if (replies.length === 0) {
            res.writeHead(202);
            res.end();
            return;
          }
          return send(res, 200, replies);
        }
        const reply = await mcp.handleJsonRpc(body);
        if (!reply) {
          res.writeHead(202);
          res.end();
          return;
        }
        return send(res, 200, reply);
      }
    }

    if (resource === "clip" && !id && method === "POST") {
      const body = await readJson(req);
      try {
        const extracted = await clipWebPage({
          url: typeof body.url === "string" ? body.url : "",
          title: typeof body.title === "string" ? body.title : undefined,
          html: typeof body.html === "string" ? body.html : undefined,
          text: typeof body.text === "string" ? body.text : undefined,
          tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : undefined,
        });
        const parentId = typeof body.parentId === "string" && ID_RE.test(body.parentId) ? body.parentId : null;
        const created = store.create({
          parentId,
          title: extracted.title,
          icon: "🔖",
          tags: extracted.tags,
          content: extracted.blocks,
        });
        await store.settled();
        return send(res, 201, {
          id: created.id,
          title: created.title,
          siteName: extracted.siteName,
          blockCount: extracted.blocks.length,
          pages: store.metas(),
        });
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }

    if (resource === "backup") {
      if (id === "export" && method === "GET") {
        await store.settled();
        const zipBuf = await exportWorkspaceBackupZip(store.allRecords(), store.uploadsDir);
        const day = new Date().toISOString().slice(0, 10);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": zipBuf.length,
          "Content-Disposition": `attachment; filename="OpenNotion-backup-${day}.zip"`,
          "Cache-Control": "no-store",
        });
        res.end(zipBuf);
        return;
      }
      if (id === "restore-records" && method === "POST") {
        const body = await readJson(req);
        const records = Array.isArray(body.records) ? body.records : [];
        const stats = await store.restoreRecords(records);
        return send(res, 200, { ...stats, pages: store.metas() });
      }
    }

    if (resource === "storage") {
      if (!id && method === "GET") {
        await store.syncFromDisk();
        return send(res, 200, {
          storage: {
            dataDir: path.resolve(dataDir),
            isDesktop: false,
            isCustomDir: Boolean(process.env.OPEN_NOTION_DATA),
          },
          pages: store.metas(),
        });
      }
      if (id === "sync" && method === "POST") {
        await readJson(req);
        const diff = await store.syncFromDisk();
        return send(res, 200, { ...diff, pages: store.metas() });
      }
    }

    if (resource === "search" && method === "GET") {
      return send(res, 200, { hits: store.search(url.searchParams.get("q") ?? "") });
    }

    if (resource === "upload" && method === "POST") {
      // 自定义请求头会触发 CORS 预检，跨站表单无法伪造
      if (req.headers["x-upload"] !== "1") throw new HttpError(400, "缺少上传标记");
      const original = url.searchParams.get("name") ?? "";
      const ext = /\.([a-zA-Z0-9]{1,8})$/.exec(original)?.[1]?.toLowerCase();
      const name = newId() + (ext ? `.${ext}` : "");
      const buf = await readBody(req, MAX_UPLOAD);
      await fs.writeFile(path.join(store.uploadsDir, name), buf);
      return send(res, 201, { url: `/uploads/${name}` });
    }

    throw new HttpError(404, "接口不存在");
  }

  const middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/uploads/")) {
      return next();
    }
    handle(req, res, url).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error("[api]", err);
      if (res.headersSent) return res.end();
      send(res, status, { error: err instanceof Error ? err.message : "服务器错误" });
    });
  };

  return Object.assign(middleware, {
    mcp,
    flush: () => store.settled(),
    sync: () => store.syncFromDisk(),
    close: () => store.close(),
    importFolder: (dir: string) => store.importFolder(dir),
  });
}
