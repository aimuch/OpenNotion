/**
 * 导入 Notion 的“Markdown & CSV”导出包（一个 zip）。
 * 全部在浏览器里完成：解压 → 还原页面层级 → Markdown 转成块 → 通过本地接口写入。
 */
import { BlockNoteEditor } from "@blocknote/core";
import type { DatabaseDef, PageRecord, PropertyDef, PropValue } from "../shared/types";
import { schema, type NoteEditor } from "./components/Editor";
import { shortId } from "./db";
import { createPage, flushPatch, restoreBackupRecords, updatePage, uploadFile } from "./store";

interface ZipEntry {
  path: string;
  read: () => Promise<Uint8Array>;
}

export interface ImportResult {
  rootId: string;
  pages: number;
  databases: number;
  rows: number;
  files: number;
  source?: "backup" | "obsidian" | "notion";
}

let cachedParserEditor: NoteEditor | null = null;

/** 复用同一个无头 BlockNote 解析实例，避免每次导入或 AI 落盘重复初始化 ProseMirror Schema */
export function getHeadlessParserEditor(): NoteEditor {
  if (!cachedParserEditor) {
    cachedParserEditor = BlockNoteEditor.create({ schema });
  }
  return cachedParserEditor;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 读 zip 的中央目录，得到每个文件的路径和读取方法。只支持最常见的“存储”和“deflate”两种压缩方式。 */
function readZip(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("这不是一个有效的 zip 文件。");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (p === 0xffffffff || count === 0xffff) {
    throw new Error("这个压缩包太大了（zip64 格式），暂不支持。可以在 Notion 里分批导出。");
  }
  const utf8 = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("压缩包的目录损坏了。");
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const path = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLength)).normalize("NFC");
    p += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith("/") || path.startsWith("__MACOSX/")) continue;
    entries.push({
      path,
      read: async () => {
        // 文件数据紧跟在它自己的“本地文件头”后面
        const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
        const data = bytes.subarray(start, start + compressedSize);
        if (method === 0) return data;
        if (method === 8) return inflate(data);
        throw new Error(`无法解压 ${path}（不支持的压缩方式 ${method}）。`);
      },
    });
  }
  return entries;
}

/** 符合 RFC 4180 的 CSV 解析：支持引号里的逗号、换行和转义的引号 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ""));
}

const HEX_SUFFIX = / [0-9a-f]{32}$/i;
const stripHex = (name: string) => name.replace(HEX_SUFFIX, "");
const stripHexPath = (path: string) => path.split("/").map(stripHex).join("/");
const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function resolvePath(fromDir: string, relative: string): string {
  const parts = fromDir ? fromDir.split("/") : [];
  for (const part of relative.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** 认得出的日期写法：2024-03-05、2024/3/5、2024年3月5日、March 5, 2024（后面带时间也行） */
function toIsoDate(value: string): string | null {
  const pad = (n: number) => String(n).padStart(2, "0");
  let m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日|\b)/.exec(value);
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  m = /^([A-Za-z]+) (\d{1,2}), (\d{4})\b/.exec(value);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (m && month >= 0) return `${m[3]}-${pad(month + 1)}-${pad(Number(m[2]))}`;
  return null;
}

/** 根据一列里的所有值猜它的类型；猜不出就当文本 */
function buildColumn(name: string, values: string[]): { def: PropertyDef; convert: (v: string) => PropValue } {
  const filled = values.filter((v) => v !== "");
  const id = shortId();
  if (filled.length > 0 && filled.every((v) => /^-?\d+(\.\d+)?$/.test(v))) {
    return { def: { id, name, type: "number" }, convert: (v) => (v === "" ? null : Number(v)) };
  }
  if (filled.length > 0 && filled.every((v) => v === "Yes" || v === "No")) {
    return { def: { id, name, type: "checkbox" }, convert: (v) => v === "Yes" };
  }
  if (filled.length > 0 && filled.every((v) => toIsoDate(v) !== null)) {
    return { def: { id, name, type: "date" }, convert: (v) => toIsoDate(v) };
  }
  if (filled.length > 0 && filled.every((v) => /^https?:\/\/\S+$/i.test(v))) {
    return { def: { id, name, type: "url" }, convert: (v) => v || null };
  }
  return { def: { id, name, type: "text" }, convert: (v) => v || null };
}

/** 把“显示文字正好就是页面标题”的内部链接升级成原生页面提及块（带图标并跟随改名） */
function upgradePageMentions(node: unknown, titles: Map<string, string>) {
  if (!Array.isArray(node)) return;
  for (let i = 0; i < node.length; i++) {
    const item = node[i] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") continue;
    if (item.type === "link" && typeof item.href === "string") {
      const directMention = /^#mention\/([a-f0-9]{16})$/.exec(item.href);
      if (directMention && titles.has(directMention[1])) {
        node[i] = { type: "pageMention", props: { pageId: directMention[1] } };
        continue;
      }
      const m = /^#\/([a-f0-9]{16})$/.exec(item.href);
      if (m && titles.has(m[1])) {
        const label = Array.isArray(item.content)
          ? item.content.map((c: { text?: string }) => c?.text ?? "").join("").trim()
          : "";
        if (!label || label === titles.get(m[1])) {
          node[i] = { type: "pageMention", props: { pageId: m[1] } };
          continue;
        }
      }
    }
    for (const key of ["content", "children", "rows", "cells"]) {
      if (item[key]) upgradePageMentions(item[key], titles);
    }
  }
}

interface Node {
  key: string;
  kind: "page" | "database";
  isAllCsv?: boolean;
  entry?: ZipEntry;
  title: string;
  icon?: string | null;
  tags?: string[];
  text: string;
  parentKey: string | null;
  id?: string;
  isRow?: boolean;
}

function extractFrontmatter(raw: string): { body: string; title?: string; icon?: string; tags?: string[] } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { body: raw };
  const fm = m[1];
  const body = raw.slice(m[0].length);
  const title = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1]?.trim();
  const icon = /^icon:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1]?.trim();
  let tags: string[] | undefined;
  const inlineTags = /^tags:\s*\[([^\]]*)\]/m.exec(fm);
  if (inlineTags) {
    tags = inlineTags[1]
      .split(",")
      .map((s) => s.trim().replace(/^["'#]+|["']+$/g, ""))
      .filter(Boolean);
  } else {
    const listTags = /^tags:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(fm);
    if (listTags) {
      tags = listTags[1]
        .split("\n")
        .map((l) => l.replace(/^\s*-\s*/, "").trim().replace(/^["'#]+|["']+$/g, ""))
        .filter(Boolean);
    }
  }
  return { body, title, icon, tags };
}

export async function importNotionZip(file: File, onProgress: (text: string) => void): Promise<ImportResult> {
  onProgress("正在读取压缩包…");
  let entries = readZip(await file.arrayBuffer());
  // 较大的导出会是“zip 里套着几个分卷 zip”
  if (entries.length > 0 && entries.every((e) => e.path.toLowerCase().endsWith(".zip"))) {
    const inner: ZipEntry[] = [];
    for (const e of entries) inner.push(...readZip((await e.read()).slice().buffer));
    entries = inner;
  }
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const decoder = new TextDecoder("utf-8");

  // 优先识别 OpenNotion 双轨备份包（含 .opennotion/pages/*.json），支持 100% 无损恢复结构化元数据与附件
  const backupJsonEntries = entries.filter(
    (e) => e.path.startsWith(".opennotion/pages/") && e.path.toLowerCase().endsWith(".json"),
  );
  if (backupJsonEntries.length > 0) {
    const uploadEntries = entries.filter((e) => e.path.startsWith("uploads/") && !e.path.endsWith("/"));
    const uploadRemap = new Map<string, string>();
    let uploadedFiles = 0;
    for (const up of uploadEntries) {
      onProgress(`正在恢复附件 ${++uploadedFiles} / ${uploadEntries.length}`);
      const bytes = await up.read();
      const oldName = basename(up.path);
      const newUrl = await uploadFile(new File([bytes.slice()], oldName));
      uploadRemap.set(`/uploads/${oldName}`, newUrl);
    }
    onProgress(`正在无损还原 ${backupJsonEntries.length} 个页面与数据库…`);
    const records: PageRecord[] = [];
    for (const je of backupJsonEntries) {
      let jsonStr = decoder.decode(await je.read());
      for (const [oldUrl, newUrl] of uploadRemap) {
        if (jsonStr.includes(oldUrl)) jsonStr = jsonStr.replaceAll(oldUrl, newUrl);
      }
      try {
        records.push(JSON.parse(jsonStr) as PageRecord);
      } catch {
        /* 跳过损坏条目 */
      }
    }
    await restoreBackupRecords(records);
    const visible = records.filter((r) => !r.hidden && !r.trashed);
    const dbSet = new Set(visible.filter((r) => r.kind === "database").map((r) => r.id));
    const firstRoot = visible.find((r) => !r.parentId) ?? visible[0];
    return {
      rootId: firstRoot?.id ?? "",
      pages: visible.filter((r) => r.kind === "page" && (!r.parentId || !dbSet.has(r.parentId))).length,
      databases: dbSet.size,
      rows: visible.filter((r) => r.parentId && dbSet.has(r.parentId)).length,
      files: uploadedFiles,
      source: "backup",
    };
  }

  const nodes = new Map<string, Node>();
  for (const entry of entries) {
    // 跳过 Obsidian / Git 隐藏配置目录
    if (entry.path.split("/").some((seg) => seg.startsWith("."))) continue;
    const lower = entry.path.toLowerCase();
    const isMd = lower.endsWith(".md");
    const isAllCsv = lower.endsWith("_all.csv");
    const isCsv = lower.endsWith(".csv");
    if (!isMd && !isCsv) continue;
    const key = isAllCsv ? entry.path.slice(0, -8) : entry.path.slice(0, entry.path.lastIndexOf("."));
    const prev = nodes.get(key);
    // 优先级：主视图 .csv > _all.csv > 同名 .md
    if (prev) {
      if (isMd) continue;
      if (isAllCsv && prev.kind === "database") continue;
    }
    const rawText = decoder.decode(await entry.read()).replace(/\r\n?/g, "\n");
    const fm = isMd ? extractFrontmatter(rawText) : { body: rawText };
    const heading = isMd ? /^# (.+)$/m.exec(fm.body)?.[1]?.trim() : undefined;
    nodes.set(key, {
      key,
      kind: isCsv ? "database" : "page",
      isAllCsv,
      entry,
      title: fm.title || heading || stripHex(basename(key)),
      icon: fm.icon ?? null,
      tags: fm.tags,
      text: fm.body,
      parentKey: null,
    });
  }
  if (nodes.size === 0) {
    throw new Error("压缩包里没有找到 Markdown、CSV 或备份文件。支持导入 Notion、Obsidian 笔记库及 OpenNotion 备份包。");
  }

  // 为 Obsidian / 文件夹式笔记库自动补建纯目录节点（当某文件夹没有同名 .md 时）
  for (const key of [...nodes.keys()]) {
    const parts = key.split("/");
    for (let d = 1; d < parts.length; d++) {
      const dirKey = parts.slice(0, d).join("/");
      const existsExact = nodes.has(dirKey);
      const existsWithHex = [...nodes.keys()].some((k) => stripHexPath(k) === stripHexPath(dirKey));
      if (!existsExact && !existsWithHex) {
        nodes.set(dirKey, {
          key: dirKey,
          kind: "page",
          title: stripHex(basename(dirKey)),
          icon: "📁",
          text: "",
          parentKey: null,
        });
      }
    }
  }

  // 子页面放在与父页面同名的文件夹里；有的导出里文件夹名不带那串 id，所以再按去掉 id 的名字找一次
  const loose = new Map<string, string>();
  for (const key of nodes.keys()) loose.set(stripHexPath(key), key);
  for (const node of nodes.values()) {
    const dir = dirname(node.key);
    if (!dir) continue;
    const parentKey = nodes.has(dir) ? dir : loose.get(stripHexPath(dir));
    if (parentKey && parentKey !== node.key) {
      node.parentKey = parentKey;
      node.isRow = nodes.get(parentKey)!.kind === "database";
    }
  }

  const hasNotionHex = [...nodes.keys()].some((k) => HEX_SUFFIX.test(basename(k)));
  const sourceKind: "notion" | "obsidian" = hasNotionHex ? "notion" : "obsidian";
  const stamp = new Date().toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  const rootTitle = sourceKind === "notion" ? `Notion 导入 · ${stamp}` : `笔记库导入 · ${stamp}`;
  const rootId = await createPage({ title: rootTitle, icon: "📥", quiet: true });
  if (!rootId) throw new Error("无法创建页面，导入已中止。");

  const result: ImportResult = { rootId, pages: 0, databases: 0, rows: 0, files: 0, source: sourceKind };
  const ordered = [...nodes.values()].sort((a, b) => a.key.split("/").length - b.key.split("/").length);
  /** 数据库 key → 按标题排队的行 id，用来把 CSV 里的行和同名的 .md 正文对上 */
  const rowQueues = new Map<string, Map<string, string[]>>();
  const fail = () => new Error("写入页面时出错，导入已中止。已经导入的部分保留在“Notion 导入”页面下。");

  let done = 0;
  for (const node of ordered) {
    onProgress(`正在创建页面 ${++done} / ${ordered.length}`);
    const parentId = node.parentKey ? nodes.get(node.parentKey)?.id : rootId;
    if (!parentId) continue;

    if (node.kind === "database") {
      const table = parseCsv(node.text);
      const header = table[0] ?? ["Name"];
      const body = table.slice(1);
      const columns = header.slice(1).map((name, i) => buildColumn(name || `列 ${i + 2}`, body.map((r) => r[i + 1] ?? "")));
      const database: DatabaseDef = {
        properties: columns.map((c) => c.def),
        views: [{ id: shortId(), name: "表格", type: "table" }],
      };
      const id = await createPage({ parentId, title: node.title, kind: "database", database, quiet: true });
      if (!id) throw fail();
      node.id = id;
      result.databases++;
      const queue = new Map<string, string[]>();
      rowQueues.set(node.key, queue);
      for (const line of body) {
        const title = line[0] ?? "";
        const props: Record<string, PropValue> = {};
        columns.forEach((c, i) => {
          props[c.def.id] = c.convert(line[i + 1] ?? "");
        });
        const rowId = await createPage({ parentId: id, title, props, quiet: true });
        if (!rowId) throw fail();
        queue.set(title, [...(queue.get(title) ?? []), rowId]);
        result.rows++;
      }
      continue;
    }

    if (node.isRow && node.parentKey) {
      // 这一行在 CSV 里已经建过了，直接认领；CSV 里没有的再补建
      const q = rowQueues.get(node.parentKey);
      const existing = q?.get(node.title)?.shift() ?? (node.title === "Untitled" ? q?.get("")?.shift() : undefined);
      if (existing) {
        node.id = existing;
        continue;
      }
      result.rows++;
    } else {
      result.pages++;
    }
    const id = await createPage({
      parentId,
      title: node.title,
      icon: node.icon ?? null,
      tags: node.tags,
      quiet: true,
    });
    if (!id) throw fail();
    node.id = id;
  }

  // 第二遍：所有页面都有 id 了，再转换正文，这样页面之间的链接才能指向新页面
  const editor = getHeadlessParserEditor();
  const uploaded = new Map<string, string>();
  const titlesById = new Map<string, string>();
  const idByTitleLower = new Map<string, string>();
  for (const n of ordered) {
    if (n.id) {
      titlesById.set(n.id, n.title);
      idByTitleLower.set(n.title.trim().toLowerCase(), n.id);
    }
  }
  const pagesWithBody = ordered.filter((n) => n.kind === "page" && n.id && n.entry);
  done = 0;
  for (const node of pagesWithBody) {
    onProgress(`正在导入正文 ${++done} / ${pagesWithBody.length}`);
    let md = node.text.replace(/^﻿/, "");
    // 标题已经单独存了，正文里不再重复
    md = md.replace(/^# .+\n?/, "").replace(/^\n+/, "");
    if (node.isRow) {
      // 数据库行的正文开头是一段“属性: 值”，这些已经从 CSV 里读过了
      const lines = md.split("\n");
      let i = 0;
      while (i < lines.length && /^[^:\n]{1,60}:(?: |$)/.test(lines[i])) i++;
      if (i > 0 && (i === lines.length || lines[i].trim() === "")) md = lines.slice(i).join("\n").replace(/^\n+/, "");
    }

    // 转换 Obsidian [[页面标题]] 或 [[页面标题|别名]] 双链为原生页面引用芯片
    md = md.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, rawTarget: string, alias?: string) => {
      const cleanName = basename(rawTarget.trim()).replace(/\.md$/i, "");
      const targetId = idByTitleLower.get(cleanName.toLowerCase());
      const label = (alias ?? cleanName).trim();
      return targetId ? `[${label}](#mention/${targetId})` : `**${label}**`;
    });

    const dir = dirname(node.entry!.path);
    const links = [...md.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g)];
    for (const match of links) {
      const [whole, bang, label, target] = match;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        /* 保持原样 */
      }
      const path = resolvePath(dir, decoded).normalize("NFC");
      const targetKey = path.replace(/(_all)?\.csv$|\.md$/i, "");
      const linked = nodes.get(targetKey) ?? nodes.get(loose.get(stripHexPath(targetKey)) ?? "");
      if (!bang && linked?.id) {
        md = md.replace(whole, () => `[${label}](#/${linked.id})`);
        continue;
      }
      const asset = byPath.get(path);
      if (!asset) continue;
      let url = uploaded.get(path);
      if (!url) {
        const data = await asset.read();
        url = await uploadFile(new File([data.slice()], basename(path)));
        uploaded.set(path, url);
        result.files++;
      }
      md = md.replace(whole, () => `${bang}[${label}](${url})`);
    }

    if (!md.trim()) continue;
    const blocks = await editor.tryParseMarkdownToBlocks(md);
    upgradePageMentions(blocks, titlesById);
    updatePage(node.id!, { content: blocks });
    await flushPatch(node.id!);
  }

  return result;
}
