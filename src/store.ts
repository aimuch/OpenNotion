import { useMemo, useSyncExternalStore } from "react";
import type {
  ClipRequest,
  ClipResult,
  HistoryEntry,
  McpConfigPublic,
  NewPageInput,
  PageMeta,
  PagePatch,
  PageRecord,
  SearchHit,
  StorageInfo,
  UnfurlData,
} from "../shared/types";
import {
  INITIAL_OVERLAY_STATE,
  getDragSnapshot,
  summarizeSaveStates,
  topOverlayName,
  transitionOverlay,
  type OverlayEvent,
  type OverlayState,
  type PageSavePhase,
  type SaveSummary,
  type SettingsTab,
} from "./machines";

export type ThemeSetting = "light" | "dark" | "system";

interface State {
  pages: Record<string, PageMeta>;
  /** 页面正文被整体替换（恢复历史、套用模板、AI 追加）的次数；变了就要重新加载编辑器 */
  revisions: Record<string, number>;
  loaded: boolean;
  /** 派生自持久化保存状态机的全局保存摘要 */
  saveSummary: SaveSummary;
  /** 正在进行或排队中的保存请求数（与 saveSummary 严格同步） */
  saving: number;
  error: string | null;
  expanded: Record<string, true>;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  theme: ThemeSetting;
  /** 统一的浮层与弹窗栈状态机 */
  overlay: OverlayState;
  searchOpen: boolean;
  aiOpen: boolean;
  aiSettingsOpen: boolean;
  /** 数据库右侧抽屉（Side Peek）打开的行 id */
  peekRowId: string | null;
}

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`on:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(`on:${key}`, JSON.stringify(value));
  } catch {
    /* 隐私模式下可能不可用，忽略 */
  }
}

function readTheme(): ThemeSetting {
  try {
    const t = localStorage.getItem("on:theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** 手机宽度下侧边栏是浮层：默认收起，且不改动桌面端记住的展开状态 */
const narrowQuery = window.matchMedia("(max-width: 720px)");
export const isNarrow = () => narrowQuery.matches;

let state: State = {
  pages: {},
  revisions: {},
  loaded: false,
  saveSummary: { phase: "idle" },
  saving: 0,
  error: null,
  expanded: readLocal<Record<string, true>>("expanded", {}),
  sidebarCollapsed: narrowQuery.matches ? true : readLocal("sidebarCollapsed", false),
  sidebarWidth: readLocal("sidebarWidth", 260),
  theme: readTheme(),
  overlay: INITIAL_OVERLAY_STATE,
  searchOpen: false,
  aiOpen: false,
  aiSettingsOpen: false,
  peekRowId: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const getState = () => state;

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

/* ---------- 请求 ---------- */

async function request<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers:
      json !== undefined
        ? { "Content-Type": "application/json", ...(rest.headers as Record<string, string> | undefined) }
        : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `请求失败（${res.status}）`);
  return data as T;
}

export function reportError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  set({ error: message });
  window.setTimeout(() => {
    if (state.error === message) set({ error: null });
  }, 5000);
}

function setPages(list: PageMeta[]) {
  const pages: Record<string, PageMeta> = {};
  for (const p of list) {
    // 尚未保存的本地修改（例如正在输入的标题）优先于服务器返回的值
    const pending = pendingPatches.get(p.id);
    const { content: _content, ...metaPatch } = pending?.patch ?? {};
    pages[p.id] = pending ? { ...p, ...metaPatch } : p;
  }
  set({ pages });
}

/* ---------- 页面数据 ---------- */

export async function loadPages() {
  try {
    const { pages } = await request<{ pages: PageMeta[] }>("/api/pages");
    setPages(pages);
    set({ loaded: true });
  } catch (err) {
    reportError(err);
  }
}

export async function fetchPage(id: string): Promise<PageRecord> {
  await flushPatch(id);
  const { page } = await request<{ page: PageRecord }>(`/api/pages/${id}`);
  return page;
}

export async function createPage(input: NewPageInput & { quiet?: boolean } = {}): Promise<string | null> {
  try {
    const { quiet, ...body } = input;
    const { id, pages } = await request<{ id: string; pages: PageMeta[] }>("/api/pages", {
      method: "POST",
      json: { ...body, parentId: input.parentId ?? null },
    });
    setPages(pages);
    // 批量导入时不逐个展开侧边栏
    if (input.parentId && !quiet) setExpanded(input.parentId, true);
    return id;
  } catch (err) {
    reportError(err);
    return null;
  }
}

async function mutate(url: string, method: string, json: unknown = {}) {
  try {
    const data = await request<{ id?: string; pages: PageMeta[] }>(url, { method, json });
    setPages(data.pages);
    return data;
  } catch (err) {
    reportError(err);
    return null;
  }
}

export async function trashPage(id: string) {
  await flushPatch(id);
  return mutate(`/api/pages/${id}/trash`, "POST");
}

export const restorePage = (id: string) => mutate(`/api/pages/${id}/restore`, "POST");

export async function deletePage(id: string) {
  dropPatch(id);
  return mutate(`/api/pages/${id}`, "DELETE");
}

export const emptyTrash = () => mutate("/api/trash", "DELETE");

export async function duplicatePage(id: string): Promise<string | null> {
  await flushPatch(id);
  const data = await mutate(`/api/pages/${id}/duplicate`, "POST");
  return data?.id ?? null;
}

export function movePage(id: string, parentId: string | null, index: number) {
  if (parentId) setExpanded(parentId, true);
  return mutate(`/api/pages/${id}/move`, "POST", { parentId, index });
}

/** 正文在服务器上被整体换掉之后调用：丢掉本地还没发出的修改，并让编辑器重新加载 */
export function reloadPageContent(id: string) {
  dropPatch(id);
  set({ revisions: { ...state.revisions, [id]: (state.revisions[id] ?? 0) + 1 } });
}

export async function fetchHistory(id: string): Promise<HistoryEntry[]> {
  await flushPatch(id);
  const { versions } = await request<{ versions: HistoryEntry[] }>(`/api/pages/${id}/history`);
  return versions;
}

export async function fetchVersion(id: string, ts: number): Promise<PageRecord> {
  const { version } = await request<{ version: { title: string; icon: string | null; content: unknown[] } }>(
    `/api/pages/${id}/history/${ts}`,
  );
  // 套上页面当前的其余信息，拼成一个可以交给编辑器预览的记录
  return { ...state.pages[id], ...version, id };
}

export async function restoreVersion(id: string, ts: number): Promise<boolean> {
  await flushPatch(id);
  const done = await mutate(`/api/pages/${id}/history/${ts}/restore`, "POST");
  if (done) reloadPageContent(id);
  return !!done;
}

export async function applyTemplate(targetId: string, templateId: string): Promise<boolean> {
  await flushPatch(targetId);
  const done = await mutate(`/api/pages/${targetId}/apply-template`, "POST", { templateId });
  if (done) reloadPageContent(targetId);
  return !!done;
}

export async function searchPages(q: string): Promise<SearchHit[]> {
  const { hits } = await request<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`);
  return hits;
}

export async function fetchBacklinks(id: string): Promise<SearchHit[]> {
  const { backlinks } = await request<{ backlinks: SearchHit[] }>(`/api/pages/${id}/backlinks`);
  return backlinks;
}

export async function cleanOrphanSynced(): Promise<number> {
  const data = await request<{ removed: number; pages: PageMeta[] }>("/api/synced/cleanup", { method: "POST", json: {} });
  setPages(data.pages);
  return data.removed;
}

export async function unfurlLink(url: string): Promise<UnfurlData> {
  const { data } = await request<{ data: UnfurlData }>(`/api/unfurl?url=${encodeURIComponent(url)}`);
  return data;
}

/* ---------- 存储目录与外部同步（iCloud Drive / NAS / 共享目录） ---------- */

export async function fetchStorageInfo(): Promise<StorageInfo> {
  const { storage } = await request<{ storage: StorageInfo }>("/api/storage");
  return storage;
}

export async function syncFromDisk(): Promise<{ changed: boolean; updatedIds: string[]; removedIds: string[] }> {
  const data = await request<{
    changed: boolean;
    updatedIds: string[];
    removedIds: string[];
    pages: PageMeta[];
  }>("/api/storage/sync", { method: "POST", json: {} });
  if (data.changed) {
    setPages(data.pages);
    for (const id of data.updatedIds) {
      if (!pendingPatches.has(id)) {
        set({ revisions: { ...state.revisions, [id]: (state.revisions[id] ?? 0) + 1 } });
      }
    }
  }
  return { changed: data.changed, updatedIds: data.updatedIds, removedIds: data.removedIds };
}

export async function desktopOpenDataDir(): Promise<void> {
  await request("/api/desktop/open-dir", { method: "POST", json: {} });
}

export async function desktopPickDataDir(): Promise<{ changed: boolean; storage: StorageInfo }> {
  const res = await request<{ changed: boolean; storage: StorageInfo }>("/api/desktop/pick-dir", {
    method: "POST",
    json: {},
  });
  if (res.changed) {
    await loadPages();
    const cur = currentPageId();
    if (cur) reloadPageContent(cur);
  }
  return res;
}

export async function desktopResetDataDir(): Promise<{ changed: boolean; storage: StorageInfo }> {
  const res = await request<{ changed: boolean; storage: StorageInfo }>("/api/desktop/reset-dir", {
    method: "POST",
    json: {},
  });
  if (res.changed) {
    await loadPages();
    const cur = currentPageId();
    if (cur) reloadPageContent(cur);
  }
  return res;
}

export async function desktopImportFolder(): Promise<void> {
  await request("/api/desktop/import-folder", { method: "POST", json: {} });
}

export async function uploadFile(file: File): Promise<string> {
  const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "X-Upload": "1", "Content-Type": "application/octet-stream" },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "上传失败");
  return data.url as string;
}

export async function clipWebUrl(input: ClipRequest): Promise<ClipResult> {
  const res = await request<ClipResult>("/api/clip", { method: "POST", json: input });
  setPages(res.pages);
  return res;
}

export async function fetchMcpConfig(): Promise<McpConfigPublic> {
  const { config } = await request<{ config: McpConfigPublic }>("/api/mcp/config");
  return config;
}

export async function updateMcpConfig(patch: {
  enabled?: boolean;
  requireToken?: boolean;
  rotateToken?: boolean;
}): Promise<McpConfigPublic> {
  const { config } = await request<{ config: McpConfigPublic }>("/api/mcp/config", {
    method: "PUT",
    json: patch,
  });
  return config;
}

export async function restoreBackupRecords(records: unknown[]): Promise<{ imported: number; updated: number }> {
  const data = await request<{ imported: number; updated: number; pages: PageMeta[] }>("/api/backup/restore-records", {
    method: "POST",
    json: { records },
  });
  setPages(data.pages);
  const nextRevs = { ...state.revisions };
  for (const p of data.pages) nextRevs[p.id] = (nextRevs[p.id] ?? 0) + 1;
  set({ revisions: nextRevs });
  return { imported: data.imported, updated: data.updated };
}

/* ---------- 持久化自动保存状态机（debouncing → saving → idle | error） ---------- */

interface Pending {
  patch: PagePatch;
  timer: number;
}

const pendingPatches = new Map<string, Pending>();
const inflight = new Map<string, Promise<void>>();
const pageSaveStates = new Map<string, { phase: PageSavePhase; error?: string }>();
const failedPatches = new Map<string, PagePatch>();
const SAVE_DELAY = 500;

function sameSaveSummary(a: SaveSummary, b: SaveSummary): boolean {
  if (a.phase !== b.phase) return false;
  if (a.phase === "saving" && b.phase === "saving") return a.count === b.count;
  if (a.phase === "error" && b.phase === "error") {
    return a.message === b.message && a.failedIds.join(",") === b.failedIds.join(",");
  }
  return true;
}

function syncSaveState() {
  const saveSummary = summarizeSaveStates(pageSaveStates);
  if (sameSaveSummary(state.saveSummary, saveSummary)) return;
  set({
    saveSummary,
    saving: saveSummary.phase === "saving" ? saveSummary.count : 0,
  });
}

/** 立即更新界面，稍后把修改合并成一次请求写入磁盘。 */
export function updatePage(id: string, patch: PagePatch) {
  const current = state.pages[id];
  const { content: _content, ...metaPatch } = patch;
  if (current && Object.keys(metaPatch).length > 0) {
    set({ pages: { ...state.pages, [id]: { ...current, ...metaPatch, updatedAt: Date.now() } } });
  }
  const existing = pendingPatches.get(id);
  if (existing) window.clearTimeout(existing.timer);
  const priorFailed = failedPatches.get(id);
  failedPatches.delete(id);
  pendingPatches.set(id, {
    patch: { ...priorFailed, ...existing?.patch, ...patch },
    timer: window.setTimeout(() => void flushPatch(id), SAVE_DELAY),
  });
  pageSaveStates.set(id, { phase: "debouncing" });
  syncSaveState();
}

function dropPatch(id: string) {
  const pending = pendingPatches.get(id);
  if (pending) {
    window.clearTimeout(pending.timer);
    pendingPatches.delete(id);
  }
  failedPatches.delete(id);
  if (pageSaveStates.delete(id)) syncSaveState();
}

export function flushPatch(id: string): Promise<void> {
  const pending = pendingPatches.get(id);
  const previous = inflight.get(id) ?? Promise.resolve();
  if (!pending) return previous;
  window.clearTimeout(pending.timer);
  pendingPatches.delete(id);
  pageSaveStates.set(id, { phase: "saving" });
  syncSaveState();
  // 同一页面的保存请求按顺序发出，避免旧内容覆盖新内容；仅做一次 JSON 序列化避免大文档双倍开销
  const payloadStr = JSON.stringify(pending.patch);
  const next = previous
    .then(() =>
      request(`/api/pages/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: payloadStr,
        keepalive: payloadStr.length * 3 < 60_000,
      }),
    )
    .then(
      () => {
        if (!pendingPatches.has(id)) pageSaveStates.delete(id);
      },
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        // 保留失败的修改，便于后续编辑合并或点击顶栏一键重试
        const newer = pendingPatches.get(id);
        if (!newer) {
          failedPatches.set(id, { ...failedPatches.get(id), ...pending.patch });
          pageSaveStates.set(id, { phase: "error", error: msg });
        }
        reportError(err);
      },
    )
    .finally(() => {
      if (inflight.get(id) === next) inflight.delete(id);
      syncSaveState();
    });
  inflight.set(id, next);
  return next;
}

export function retryFailedSaves(): Promise<void> {
  const entries = [...failedPatches.entries()];
  for (const [id, patch] of entries) {
    failedPatches.delete(id);
    updatePage(id, patch);
  }
  return flushAll();
}

export function flushAll(): Promise<void> {
  const ids = new Set([...pendingPatches.keys(), ...inflight.keys()]);
  return Promise.all([...ids].map((id) => flushPatch(id))).then(() => {});
}

// 桌面版关闭前保存钩子 + 状态机只读诊断快照（供调试与自动化检查）
const winHooks = window as unknown as {
  __openNotionFlush?: () => Promise<void>;
  __openNotionState?: () => Record<string, unknown>;
};
winHooks.__openNotionFlush = flushAll;
winHooks.__openNotionState = () => {
  const visiblePages = Object.values(state.pages).filter((p) => !p.trashed && !p.hidden);
  const tags = new Set(visiblePages.flatMap((p) => p.tags ?? []));
  return {
    route: currentPageId(),
    bootStatus: state.loaded ? "ready" : "loading",
    topOverlay: topOverlayName(state.overlay),
    overlay: state.overlay,
    saveSummary: state.saveSummary,
    drag: getDragSnapshot(),
    pageCount: Object.keys(state.pages).length,
    visiblePageCount: visiblePages.length,
    tagCount: tags.size,
  };
};

let lastFocusSync = 0;
function triggerAutoDiskSync() {
  if (!state.loaded) return;
  const now = Date.now();
  if (now - lastFocusSync < 1500) return;
  lastFocusSync = now;
  void syncFromDisk().catch(() => {});
}

window.addEventListener("focus", triggerAutoDiskSync);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) triggerAutoDiskSync();
});

window.addEventListener("pagehide", () => void flushAll());
window.addEventListener("beforeunload", (e) => {
  if (state.saving > 0) {
    void flushAll();
    e.preventDefault();
  }
});

/* ---------- 界面与全局浮层栈状态机 ---------- */

export function setExpanded(id: string, open: boolean) {
  const expanded = { ...state.expanded };
  if (open) expanded[id] = true;
  else delete expanded[id];
  set({ expanded });
  writeLocal("expanded", expanded);
}

export function setSidebarCollapsed(collapsed: boolean) {
  set({ sidebarCollapsed: collapsed });
  if (!isNarrow()) writeLocal("sidebarCollapsed", collapsed);
}

export function setSidebarWidth(width: number, persist = false) {
  const w = Math.round(Math.max(200, Math.min(480, width)));
  if (w !== state.sidebarWidth) set({ sidebarWidth: w });
  if (persist) writeLocal("sidebarWidth", w);
}

export function sendOverlay(event: OverlayEvent) {
  const next = transitionOverlay(state.overlay, event);
  if (next === state.overlay) return;
  set({
    overlay: next,
    searchOpen: next.modal === "search",
    aiOpen: next.modal === "ai",
    aiSettingsOpen: next.aiSettings,
    peekRowId: next.peekRowId,
  });
}

/** 按栈顶优先关闭最上层浮层；如果有浮层被关闭则返回 true */
export function dismissTopOverlay(): boolean {
  if (topOverlayName(state.overlay) === "none") return false;
  sendOverlay({ type: "ESCAPE" });
  return true;
}

export function setSearchOpen(open: boolean) {
  sendOverlay({ type: open ? "OPEN_SEARCH" : "CLOSE_SEARCH" });
}

export function setAiOpen(open: boolean) {
  sendOverlay({ type: open ? "OPEN_AI" : "CLOSE_AI" });
}

export function setClipperOpen(open: boolean) {
  sendOverlay({ type: open ? "OPEN_CLIPPER" : "CLOSE_CLIPPER" });
}

export function openHistoryModal() {
  sendOverlay({ type: "OPEN_HISTORY" });
}

export function openPosterModal() {
  sendOverlay({ type: "OPEN_POSTER" });
}

export function closePageModal() {
  sendOverlay({ type: "CLOSE_PAGE_MODAL" });
}

export function openSettings(tab: SettingsTab = "appearance") {
  sendOverlay({ type: "OPEN_SETTINGS", tab });
}

export function closeSettings() {
  sendOverlay({ type: "CLOSE_SETTINGS" });
}

export function setAiSettingsOpen(open: boolean) {
  sendOverlay({ type: open ? "OPEN_AI_SETTINGS" : "CLOSE_AI_SETTINGS" });
}

export function setPeekRowId(id: string | null) {
  sendOverlay(id ? { type: "OPEN_PEEK", rowId: id } : { type: "CLOSE_PEEK" });
}

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

export function resolveTheme(theme: ThemeSetting): "light" | "dark" {
  return theme === "system" ? (systemDark.matches ? "dark" : "light") : theme;
}

function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme(state.theme);
}

export function setTheme(theme: ThemeSetting) {
  set({ theme });
  try {
    localStorage.setItem("on:theme", theme);
  } catch {
    /* 忽略 */
  }
  applyTheme();
}

systemDark.addEventListener("change", applyTheme);

export function useResolvedTheme(): "light" | "dark" {
  const theme = useStore((s) => s.theme);
  const systemIsDark = useSyncExternalStore(
    (cb) => {
      systemDark.addEventListener("change", cb);
      return () => systemDark.removeEventListener("change", cb);
    },
    () => systemDark.matches,
    () => systemDark.matches,
  );
  return theme === "system" ? (systemIsDark ? "dark" : "light") : theme;
}

/* ---------- 页面树 ---------- */

export interface Tree {
  /** 未删除的子页面，按顺序排列；根页面的 key 为 "" */
  children: Map<string, PageMeta[]>;
  favorites: PageMeta[];
  /** 回收站中最上层的页面（其父页面未被删除） */
  trash: PageMeta[];
}

export function buildTree(pages: Record<string, PageMeta>): Tree {
  const children = new Map<string, PageMeta[]>();
  const favorites: PageMeta[] = [];
  const trash: PageMeta[] = [];
  for (const p of Object.values(pages)) {
    // 内部页面（同步块的内容）不出现在页面树、收藏和回收站里
    if (p.hidden) continue;
    if (p.trashed) {
      const parent = p.parentId ? pages[p.parentId] : undefined;
      if (!parent || !parent.trashed || parent.trashedAt !== p.trashedAt) trash.push(p);
      continue;
    }
    const key = p.parentId && pages[p.parentId] && !pages[p.parentId].trashed ? p.parentId : "";
    const list = children.get(key);
    if (list) list.push(p);
    else children.set(key, [p]);
    if (p.favorite) favorites.push(p);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }
  favorites.sort((a, b) => a.title.localeCompare(b.title, "zh"));
  trash.sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
  return { children, favorites, trash };
}

export function useTree(): Tree {
  const pages = useStore((s) => s.pages);
  return useMemo(() => buildTree(pages), [pages]);
}

export function ancestorsOf(pages: Record<string, PageMeta>, id: string): PageMeta[] {
  const chain: PageMeta[] = [];
  const seen = new Set<string>();
  let cur = pages[id]?.parentId ?? null;
  while (cur && pages[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(pages[cur]);
    cur = pages[cur].parentId;
  }
  return chain;
}

export function isDescendant(pages: Record<string, PageMeta>, id: string, ancestorId: string): boolean {
  return ancestorsOf(pages, id).some((p) => p.id === ancestorId);
}

/* ---------- 路由（hash） ---------- */

function currentPageId(): string | null {
  const m = /^#\/([a-f0-9]{16})$/.exec(window.location.hash);
  return m ? m[1] : null;
}

export function useRoute(): string | null {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    currentPageId,
    currentPageId,
  );
}

export function navigate(id: string | null, replace = false) {
  // 手机上选中页面后自动收起侧边栏浮层
  if (isNarrow() && !replace && !state.sidebarCollapsed) set({ sidebarCollapsed: true });
  sendOverlay({ type: "NAVIGATED" });
  const hash = id ? `#/${id}` : "#/";
  if (replace) {
    window.history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
}
