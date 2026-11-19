/**
 * 应用内核心状态机定义与纯状态转移函数。
 *
 * 用可辨识联合类型（Discriminated Unions）替代零散的布尔值与模块级可变变量，
 * 从类型层面消除“既在加载又已报错”“弹层多层同时响应 Esc 关闭”“跨数据库误拖拽”等非法状态，
 * 同时为界面提供统一的 data-* 状态标记与只读诊断快照。
 */
import { useCallback, useReducer } from "react";
import type { AiChatMessage, AiCitation, HistoryEntry, PageMeta, PageRecord, SearchHit } from "../shared/types";
import type { ImportResult } from "./notionImport";

/** 轻量状态机 Hook：用纯 reducer 驱动显式事件转移 */
export function useMachine<S, E>(reducer: (state: S, event: E) => S, initial: S): [S, (event: E) => void] {
  const [state, dispatch] = useReducer(reducer, initial);
  const send = useCallback((event: E) => dispatch(event), []);
  return [state, send];
}

/* =========================================================
 * 1. 页面持久化保存状态机（Per-Page & Global Save Machine）
 * ========================================================= */

export type PageSavePhase = "debouncing" | "saving" | "error";

export type SaveSummary =
  | { phase: "idle" }
  | { phase: "saving"; count: number }
  | { phase: "error"; message: string; failedIds: string[] };

export function summarizeSaveStates(
  perPage: ReadonlyMap<string, { phase: PageSavePhase; error?: string }>,
): SaveSummary {
  let activeCount = 0;
  const failedIds: string[] = [];
  let lastError = "";
  for (const [id, entry] of perPage) {
    if (entry.phase === "debouncing" || entry.phase === "saving") activeCount++;
    else if (entry.phase === "error") {
      failedIds.push(id);
      if (entry.error) lastError = entry.error;
    }
  }
  if (activeCount > 0) return { phase: "saving", count: activeCount };
  if (failedIds.length > 0) {
    return { phase: "error", message: lastError || "保存失败，点击重试", failedIds };
  }
  return { phase: "idle" };
}

/* =========================================================
 * 2. 全局浮层与弹窗栈状态机（Overlay & Modal Stack Machine）
 *    规则：搜索弹窗与 AI 助手互斥；AI 设置可叠在最上层；
 *    按 Esc 时严格按“最上层优先（LIFO）”逐层关闭，绝不一次关光。
 * ========================================================= */

export type PrimaryModal = "none" | "search" | "ai" | "clipper";
export type PageSubModal = "none" | "history" | "poster";
export type SettingsTab = "appearance" | "sync" | "ai" | "mcp" | "trash";

export interface OverlayState {
  modal: PrimaryModal;
  pageModal?: PageSubModal;
  aiSettings: boolean;
  settingsTab?: SettingsTab;
  peekRowId: string | null;
}

export type OverlayEvent =
  | { type: "OPEN_SEARCH" }
  | { type: "CLOSE_SEARCH" }
  | { type: "TOGGLE_SEARCH" }
  | { type: "OPEN_AI" }
  | { type: "CLOSE_AI" }
  | { type: "TOGGLE_AI" }
  | { type: "OPEN_CLIPPER" }
  | { type: "CLOSE_CLIPPER" }
  | { type: "TOGGLE_CLIPPER" }
  | { type: "OPEN_HISTORY" }
  | { type: "OPEN_POSTER" }
  | { type: "CLOSE_PAGE_MODAL" }
  | { type: "OPEN_SETTINGS"; tab?: SettingsTab }
  | { type: "CLOSE_SETTINGS" }
  | { type: "TOGGLE_SETTINGS"; tab?: SettingsTab }
  | { type: "OPEN_AI_SETTINGS" }
  | { type: "CLOSE_AI_SETTINGS" }
  | { type: "OPEN_PEEK"; rowId: string }
  | { type: "CLOSE_PEEK" }
  | { type: "ESCAPE" }
  | { type: "NAVIGATED" };

export const INITIAL_OVERLAY_STATE: OverlayState = {
  modal: "none",
  pageModal: "none",
  aiSettings: false,
  peekRowId: null,
};

export function transitionOverlay(state: OverlayState, event: OverlayEvent): OverlayState {
  const curPageModal = state.pageModal ?? "none";
  switch (event.type) {
    case "OPEN_SEARCH":
      return { ...state, modal: "search", pageModal: "none", aiSettings: false };
    case "CLOSE_SEARCH":
      return state.modal === "search" ? { ...state, modal: "none" } : state;
    case "TOGGLE_SEARCH":
      return state.modal === "search"
        ? { ...state, modal: "none" }
        : { ...state, modal: "search", pageModal: "none", aiSettings: false };
    case "OPEN_AI":
      return { ...state, modal: "ai", pageModal: "none" };
    case "CLOSE_AI":
      return state.modal === "ai" ? { ...state, modal: "none" } : state;
    case "TOGGLE_AI":
      return state.modal === "ai" ? { ...state, modal: "none" } : { ...state, modal: "ai", pageModal: "none" };
    case "OPEN_CLIPPER":
      return { ...state, modal: "clipper", pageModal: "none", aiSettings: false };
    case "CLOSE_CLIPPER":
      return state.modal === "clipper" ? { ...state, modal: "none" } : state;
    case "TOGGLE_CLIPPER":
      return state.modal === "clipper"
        ? { ...state, modal: "none" }
        : { ...state, modal: "clipper", pageModal: "none", aiSettings: false };
    case "OPEN_HISTORY":
      return { ...state, pageModal: "history", modal: "none", aiSettings: false };
    case "OPEN_POSTER":
      return { ...state, pageModal: "poster", modal: "none", aiSettings: false };
    case "CLOSE_PAGE_MODAL":
      return curPageModal !== "none" ? { ...state, pageModal: "none" } : state;
    case "OPEN_SETTINGS":
      return { ...state, aiSettings: true, settingsTab: event.tab ?? state.settingsTab ?? "appearance" };
    case "CLOSE_SETTINGS":
      return state.aiSettings ? { ...state, aiSettings: false } : state;
    case "TOGGLE_SETTINGS":
      return state.aiSettings
        ? { ...state, aiSettings: false }
        : { ...state, aiSettings: true, settingsTab: event.tab ?? "appearance" };
    case "OPEN_AI_SETTINGS":
      return { ...state, aiSettings: true, settingsTab: "ai" };
    case "CLOSE_AI_SETTINGS":
      return state.aiSettings ? { ...state, aiSettings: false } : state;
    case "OPEN_PEEK":
      return { ...state, peekRowId: event.rowId };
    case "CLOSE_PEEK":
      return state.peekRowId ? { ...state, peekRowId: null } : state;
    case "NAVIGATED":
      return { ...state, modal: "none", pageModal: "none", peekRowId: null };
    case "ESCAPE":
      if (state.aiSettings) return { ...state, aiSettings: false };
      if (curPageModal !== "none") return { ...state, pageModal: "none" };
      if (state.modal !== "none") return { ...state, modal: "none" };
      if (state.peekRowId) return { ...state, peekRowId: null };
      return state;
  }
}

export function topOverlayName(
  state: OverlayState,
): "ai-settings" | "history" | "poster" | "search" | "ai" | "clipper" | "peek" | "none" {
  if (state.aiSettings) return "ai-settings";
  if (state.pageModal && state.pageModal !== "none") return state.pageModal;
  if (state.modal !== "none") return state.modal;
  if (state.peekRowId) return "peek";
  return "none";
}

/* =========================================================
 * 3. 页面正文异步加载与编辑状态机（Page Document Load Machine）
 * ========================================================= */

export type PageLoadState =
  | { status: "loading" }
  | { status: "ready"; record: PageRecord; dirty: boolean }
  | { status: "error"; message: string };

export type PageLoadEvent =
  | { type: "RELOAD" }
  | { type: "LOADED"; record: PageRecord }
  | { type: "FAILED"; message: string }
  | { type: "MARK_DIRTY" };

export function transitionPageLoad(state: PageLoadState, event: PageLoadEvent): PageLoadState {
  switch (event.type) {
    case "RELOAD":
      return { status: "loading" };
    case "LOADED":
      return { status: "ready", record: event.record, dirty: false };
    case "FAILED":
      return { status: "error", message: event.message };
    case "MARK_DIRTY":
      return state.status === "ready" && !state.dirty ? { ...state, dirty: true } : state;
  }
}

/* =========================================================
 * 4. 内联 AI 生成与改写状态机（Inline AI Session Machine）
 * ========================================================= */

export type AiInlineState =
  | { phase: "idle" }
  | { phase: "streaming"; output: string; reasoning: string; baseHistory: AiChatMessage[] }
  | { phase: "ready"; output: string; reasoning: string; history: AiChatMessage[] }
  | { phase: "applying"; output: string; reasoning: string; history: AiChatMessage[] }
  | { phase: "error"; message: string; history: AiChatMessage[] };

export type AiInlineEvent =
  | { type: "START"; messages: AiChatMessage[] }
  | { type: "REASONING"; full: string }
  | { type: "DELTA"; full: string }
  | { type: "COMPLETE"; full: string }
  | { type: "STOP" }
  | { type: "FAIL"; message: string }
  | { type: "APPLY_START" }
  | { type: "APPLY_FAIL"; message: string };

export function transitionAiInline(state: AiInlineState, event: AiInlineEvent): AiInlineState {
  switch (event.type) {
    case "START":
      return { phase: "streaming", output: "", reasoning: "", baseHistory: event.messages };
    case "REASONING":
      return state.phase === "streaming" ? { ...state, reasoning: event.full } : state;
    case "DELTA":
      return state.phase === "streaming" ? { ...state, output: event.full } : state;
    case "COMPLETE": {
      if (state.phase !== "streaming") return state;
      const text = event.full || state.output;
      return {
        phase: "ready",
        output: text,
        reasoning: state.reasoning,
        history: [...state.baseHistory, { role: "assistant", content: text }],
      };
    }
    case "STOP": {
      if (state.phase !== "streaming") return state;
      if (!state.output.trim()) return { phase: "idle" };
      // 用户中途点停止时保留已流式输出的半截结果，允许继续追问或直接插入
      return {
        phase: "ready",
        output: state.output,
        reasoning: state.reasoning,
        history: [...state.baseHistory, { role: "assistant", content: state.output }],
      };
    }
    case "FAIL": {
      const history =
        state.phase === "streaming"
          ? state.baseHistory
          : state.phase === "ready" || state.phase === "applying" || state.phase === "error"
            ? state.history
            : [];
      return { phase: "error", message: event.message, history };
    }
    case "APPLY_START":
      return state.phase === "ready" ? { ...state, phase: "applying" } : state;
    case "APPLY_FAIL":
      return state.phase === "applying" ? { phase: "error", message: event.message, history: state.history } : state;
  }
}

/* =========================================================
 * 5. 页面历史版本预览与恢复状态机（History Modal Machine）
 * ========================================================= */

export type HistoryPreviewState =
  | { status: "loading" }
  | { status: "ready"; record: PageRecord }
  | { status: "restoring"; record: PageRecord }
  | { status: "error"; message: string };

export type HistoryModalState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "loaded"; versions: HistoryEntry[]; selectedTs: number; preview: HistoryPreviewState };

export type HistoryModalEvent =
  | { type: "LIST_LOADED"; versions: HistoryEntry[] }
  | { type: "LIST_FAILED"; message: string }
  | { type: "SELECT_VERSION"; ts: number }
  | { type: "VERSION_LOADED"; ts: number; record: PageRecord }
  | { type: "VERSION_FAILED"; ts: number; message: string }
  | { type: "RESTORE_START" }
  | { type: "RESTORE_FAILED"; message: string };

export function transitionHistory(state: HistoryModalState, event: HistoryModalEvent): HistoryModalState {
  switch (event.type) {
    case "LIST_LOADED":
      if (event.versions.length === 0) return { status: "empty" };
      return {
        status: "loaded",
        versions: event.versions,
        selectedTs: event.versions[0].ts,
        preview: { status: "loading" },
      };
    case "LIST_FAILED":
      return { status: "error", message: event.message };
    case "SELECT_VERSION":
      if (state.status !== "loaded" || state.preview.status === "restoring") return state;
      if (state.selectedTs === event.ts && state.preview.status === "ready") return state;
      return { ...state, selectedTs: event.ts, preview: { status: "loading" } };
    case "VERSION_LOADED":
      if (state.status !== "loaded" || state.selectedTs !== event.ts) return state;
      return { ...state, preview: { status: "ready", record: event.record } };
    case "VERSION_FAILED":
      if (state.status !== "loaded" || state.selectedTs !== event.ts) return state;
      return { ...state, preview: { status: "error", message: event.message } };
    case "RESTORE_START":
      if (state.status !== "loaded" || state.preview.status !== "ready") return state;
      return { ...state, preview: { status: "restoring", record: state.preview.record } };
    case "RESTORE_FAILED":
      if (state.status !== "loaded") return state;
      return { ...state, preview: { status: "error", message: event.message } };
  }
}

/* =========================================================
 * 6. Notion 导出包导入状态机（Zip Import Machine）
 * ========================================================= */

export type ImportModalState =
  | { status: "idle" }
  | { status: "awaiting_password"; fileName: string; error: string | null }
  | { status: "running"; text: string }
  | { status: "done"; result: ImportResult }
  | { status: "error"; message: string };

export type ImportModalEvent =
  | { type: "NEED_PASSWORD"; fileName: string; error?: string | null }
  | { type: "START"; text?: string }
  | { type: "PROGRESS"; text: string }
  | { type: "SUCCEED"; result: ImportResult }
  | { type: "FAIL"; message: string }
  | { type: "DISMISS" };

export function transitionImport(state: ImportModalState, event: ImportModalEvent): ImportModalState {
  switch (event.type) {
    case "NEED_PASSWORD":
      return { status: "awaiting_password", fileName: event.fileName, error: event.error ?? null };
    case "START":
      return state.status === "running"
        ? state
        : { status: "running", text: event.text ?? "正在读取导入文件…" };
    case "PROGRESS":
      return state.status === "running" ? { status: "running", text: event.text } : state;
    case "SUCCEED":
      return { status: "done", result: event.result };
    case "FAIL":
      return { status: "error", message: event.message };
    case "DISMISS":
      // 正在导入中时不允许误触背景或按 Esc 半途关闭弹层
      return state.status === "running" ? state : { status: "idle" };
  }
}

/* =========================================================
 * 7. 带作用域隔离的拖拽会话状态机（Scoped Drag Session Machine）
 *    携带所属数据库 dbId，杜绝两个内嵌数据库之间串行污染属性或错移页面；
 *    并在全局 dragend / drop / Esc 时自动兜底复位。
 * ========================================================= */

export type DragSession =
  | { kind: "none" }
  | { kind: "page"; pageId: string }
  | { kind: "db-row"; dbId: string; rowId: string };

let currentDrag: DragSession = { kind: "none" };
let dragListenersBound = false;

function bindGlobalDragReset() {
  if (dragListenersBound || typeof window === "undefined") return;
  dragListenersBound = true;
  const reset = () => {
    currentDrag = { kind: "none" };
  };
  window.addEventListener("dragend", reset, true);
  window.addEventListener("drop", () => window.setTimeout(reset, 0), true);
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") reset();
    },
    true,
  );
}

export function startPageDrag(pageId: string) {
  bindGlobalDragReset();
  currentDrag = { kind: "page", pageId };
}

export function startDbRowDrag(dbId: string, rowId: string) {
  bindGlobalDragReset();
  currentDrag = { kind: "db-row", dbId, rowId };
}

export function endDragSession() {
  currentDrag = { kind: "none" };
}

export function getDraggedPageId(): string | null {
  return currentDrag.kind === "page" ? currentDrag.pageId : null;
}

/** 仅当正在拖动的是同一个数据库里的行时才返回行 id，跨库拖拽一律拒绝 */
export function getDraggedRowForDb(dbId: string): string | null {
  return currentDrag.kind === "db-row" && currentDrag.dbId === dbId ? currentDrag.rowId : null;
}

export function getDragSnapshot(): DragSession {
  return currentDrag;
}

/* =========================================================
 * 8. 全局 AI 问答会话状态机（AI Modal Session Machine）
 *    消除 running / savingAction 等离散布尔竞态，防止重复点击“存为新页面 / 追加到本页”产生脏副本
 * ========================================================= */

export interface AiChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  citations?: AiCitation[];
  error?: string;
}

export interface AiChatSessionState {
  phase: "idle" | "streaming" | "applying";
  activeAssistantId: string | null;
  turns: AiChatTurn[];
}

export type AiChatSessionEvent =
  | { type: "SUBMIT"; userTurn: AiChatTurn; assistantTurn: AiChatTurn }
  | { type: "CITATIONS"; citations: AiCitation[] }
  | { type: "REASONING"; full: string }
  | { type: "DELTA"; full: string }
  | { type: "COMPLETE" }
  | { type: "STOP" }
  | { type: "FAIL"; message: string }
  | { type: "CLEAR" }
  | { type: "APPLY_START" }
  | { type: "APPLY_DONE" };

export const INITIAL_AI_CHAT_STATE: AiChatSessionState = {
  phase: "idle",
  activeAssistantId: null,
  turns: [],
};

export function transitionAiChat(state: AiChatSessionState, event: AiChatSessionEvent): AiChatSessionState {
  switch (event.type) {
    case "SUBMIT":
      if (state.phase !== "idle") return state;
      return {
        phase: "streaming",
        activeAssistantId: event.assistantTurn.id,
        turns: [...state.turns, event.userTurn, event.assistantTurn],
      };
    case "CITATIONS":
      if (state.phase !== "streaming" || !state.activeAssistantId) return state;
      return {
        ...state,
        turns: state.turns.map((t) => (t.id === state.activeAssistantId ? { ...t, citations: event.citations } : t)),
      };
    case "REASONING":
      if (state.phase !== "streaming" || !state.activeAssistantId) return state;
      return {
        ...state,
        turns: state.turns.map((t) => (t.id === state.activeAssistantId ? { ...t, reasoning: event.full } : t)),
      };
    case "DELTA":
      if (state.phase !== "streaming" || !state.activeAssistantId) return state;
      return {
        ...state,
        turns: state.turns.map((t) => (t.id === state.activeAssistantId ? { ...t, content: event.full } : t)),
      };
    case "COMPLETE":
    case "STOP":
      if (state.phase !== "streaming") return state;
      return { ...state, phase: "idle", activeAssistantId: null };
    case "FAIL":
      if (!state.activeAssistantId) return { ...state, phase: "idle" };
      return {
        phase: "idle",
        activeAssistantId: null,
        turns: state.turns.map((t) => (t.id === state.activeAssistantId ? { ...t, error: event.message } : t)),
      };
    case "CLEAR":
      if (state.phase === "streaming" || state.phase === "applying") return state;
      return INITIAL_AI_CHAT_STATE;
    case "APPLY_START":
      return state.phase === "idle" ? { ...state, phase: "applying" } : state;
    case "APPLY_DONE":
      return state.phase === "applying" ? { ...state, phase: "idle" } : state;
  }
}

/* =========================================================
 * 9. 网页剪藏任务状态机（Web Clipper Workflow Machine）
 *    抓取进行中锁定页签切换与误触关闭，确保异步落库原子完成
 * ========================================================= */

export interface ClipperModalState {
  tab: "url" | "bookmarklet";
  job:
    | { status: "idle" }
    | { status: "clipping"; url: string }
    | { status: "error"; message: string };
}

export type ClipperModalEvent =
  | { type: "SWITCH_TAB"; tab: "url" | "bookmarklet" }
  | { type: "START_CLIP"; url: string }
  | { type: "CLIP_FAILED"; message: string }
  | { type: "CLEAR_ERROR" };

export const INITIAL_CLIPPER_STATE: ClipperModalState = {
  tab: "url",
  job: { status: "idle" },
};

export function transitionClipper(state: ClipperModalState, event: ClipperModalEvent): ClipperModalState {
  switch (event.type) {
    case "SWITCH_TAB":
      if (state.job.status === "clipping") return state;
      return { tab: event.tab, job: { status: "idle" } };
    case "START_CLIP":
      if (state.job.status === "clipping") return state;
      return { ...state, job: { status: "clipping", url: event.url } };
    case "CLIP_FAILED":
      return { ...state, job: { status: "error", message: event.message } };
    case "CLEAR_ERROR":
      return state.job.status === "error" ? { ...state, job: { status: "idle" } } : state;
  }
}

/* =========================================================
 * 10. 全局搜索异步查询与游标状态机（Search Query & Selection Machine）
 *     消除 hits === null 的“空输入 vs 搜索防抖中”二义性，检索期间保留上一轮结果防闪烁，并严格钳制键盘游标边界
 * ========================================================= */

export type SearchQueryState =
  | { phase: "recent"; selectedIndex: number }
  | { phase: "searching"; query: string; prevHits: SearchHit[]; selectedIndex: number }
  | { phase: "results"; query: string; hits: SearchHit[]; selectedIndex: number }
  | { phase: "error"; query: string; message: string };

export type SearchQueryEvent =
  | { type: "INPUT_CHANGED"; query: string }
  | { type: "SEARCH_RESOLVED"; query: string; hits: SearchHit[] }
  | { type: "SEARCH_FAILED"; query: string; message: string }
  | { type: "MOVE_INDEX"; delta: number; itemCount: number }
  | { type: "SET_INDEX"; index: number; itemCount: number };

export const INITIAL_SEARCH_STATE: SearchQueryState = {
  phase: "recent",
  selectedIndex: 0,
};

function clampIdx(idx: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, idx));
}

export function transitionSearchQuery(state: SearchQueryState, event: SearchQueryEvent): SearchQueryState {
  switch (event.type) {
    case "INPUT_CHANGED": {
      const q = event.query.trim();
      if (!q) return { phase: "recent", selectedIndex: 0 };
      const prevHits =
        state.phase === "results"
          ? state.hits
          : state.phase === "searching"
            ? state.prevHits
            : [];
      return { phase: "searching", query: q, prevHits, selectedIndex: 0 };
    }
    case "SEARCH_RESOLVED":
      if (state.phase !== "searching" || state.query !== event.query) return state;
      return { phase: "results", query: event.query, hits: event.hits, selectedIndex: 0 };
    case "SEARCH_FAILED":
      if (state.phase !== "searching" || state.query !== event.query) return state;
      return { phase: "error", query: event.query, message: event.message };
    case "MOVE_INDEX": {
      if (state.phase === "error") return state;
      return { ...state, selectedIndex: clampIdx(state.selectedIndex + event.delta, event.itemCount) };
    }
    case "SET_INDEX": {
      if (state.phase === "error") return state;
      const next = clampIdx(event.index, event.itemCount);
      return next === state.selectedIndex ? state : { ...state, selectedIndex: next };
    }
  }
}

/* =========================================================
 * 11. 数据库表单提交生命周期状态机（Form Submission Machine）
 *     补齐显式错误态，消除提交异常静默吞没问题
 * ========================================================= */

export type FormSubmissionState =
  | { phase: "editing" }
  | { phase: "submitting" }
  | { phase: "submitted"; rowId: string }
  | { phase: "error"; message: string };

export type FormSubmissionEvent =
  | { type: "SUBMIT_START" }
  | { type: "SUBMIT_SUCCESS"; rowId: string }
  | { type: "SUBMIT_ERROR"; message: string }
  | { type: "RESET" };

export function transitionFormSubmission(
  state: FormSubmissionState,
  event: FormSubmissionEvent,
): FormSubmissionState {
  switch (event.type) {
    case "SUBMIT_START":
      return state.phase === "submitting" ? state : { phase: "submitting" };
    case "SUBMIT_SUCCESS":
      return { phase: "submitted", rowId: event.rowId };
    case "SUBMIT_ERROR":
      return { phase: "error", message: event.message };
    case "RESET":
      return { phase: "editing" };
  }
}

/* =========================================================
 * 12. 封面更换与焦点拖拽状态机（Cover Interaction Machine）
 *     保证“更换封面浮层”与“纵向焦点拖拽”严格互斥，避免陈旧焦点偏移
 * ========================================================= */

export type CoverInteractionState =
  | { mode: "viewing" }
  | { mode: "picking"; anchor: HTMLElement }
  | { mode: "repositioning"; draftY: number; dragging: boolean };

export type CoverInteractionEvent =
  | { type: "TOGGLE_PICKER"; anchor: HTMLElement }
  | { type: "CLOSE_PICKER" }
  | { type: "START_REPOSITION"; initialY: number }
  | { type: "DRAG_START" }
  | { type: "DRAG_MOVE"; y: number }
  | { type: "DRAG_END" }
  | { type: "FINISH_REPOSITION" };

export function transitionCover(
  state: CoverInteractionState,
  event: CoverInteractionEvent,
): CoverInteractionState {
  switch (event.type) {
    case "TOGGLE_PICKER":
      if (state.mode === "repositioning") return state;
      return state.mode === "picking" ? { mode: "viewing" } : { mode: "picking", anchor: event.anchor };
    case "CLOSE_PICKER":
      return state.mode === "picking" ? { mode: "viewing" } : state;
    case "START_REPOSITION":
      return {
        mode: "repositioning",
        draftY: Math.max(0, Math.min(100, Math.round(event.initialY))),
        dragging: false,
      };
    case "DRAG_START":
      return state.mode === "repositioning" ? { ...state, dragging: true } : state;
    case "DRAG_MOVE":
      return state.mode === "repositioning"
        ? { ...state, draftY: Math.max(0, Math.min(100, Math.round(event.y))) }
        : state;
    case "DRAG_END":
      return state.mode === "repositioning" ? { ...state, dragging: false } : state;
    case "FINISH_REPOSITION":
      return { mode: "viewing" };
  }
}

/* =========================================================
 * 13. 设置面板异步操作互斥状态机（Settings Async Operation Machine）
 *     消除 saving / testing / fetchingModels / backingUp 等多布尔重叠竞态
 * ========================================================= */

export interface SettingsAsyncState {
  phase: "idle" | "busy";
  job: string | null;
  notice: { ok: boolean; text: string } | null;
}

export type SettingsAsyncEvent =
  | { type: "BEGIN"; job: string }
  | { type: "SUCCEED"; text?: string }
  | { type: "FAIL"; text: string }
  | { type: "CLEAR_NOTICE" };

export const INITIAL_SETTINGS_ASYNC_STATE: SettingsAsyncState = {
  phase: "idle",
  job: null,
  notice: null,
};

export function transitionSettingsAsync(
  state: SettingsAsyncState,
  event: SettingsAsyncEvent,
): SettingsAsyncState {
  switch (event.type) {
    case "BEGIN":
      if (state.phase === "busy") return state;
      return { phase: "busy", job: event.job, notice: null };
    case "SUCCEED":
      return {
        phase: "idle",
        job: null,
        notice: event.text ? { ok: true, text: event.text } : null,
      };
    case "FAIL":
      return {
        phase: "idle",
        job: null,
        notice: { ok: false, text: event.text },
      };
    case "CLEAR_NOTICE":
      return state.notice ? { ...state, notice: null } : state;
  }
}

/* =========================================================
 * 14. 非阻塞二次确认动作状态机（Inline Two-Step Confirm Machine）
 *     彻底替代原生 window.confirm，不阻塞主线程也不挂起自动化 Agent
 * ========================================================= */

export type ConfirmActionState =
  | { status: "idle" }
  | { status: "confirming"; targetKey: string }
  | { status: "executing"; targetKey: string };

export type ConfirmActionEvent =
  | { type: "REQUEST"; targetKey: string }
  | { type: "CANCEL" }
  | { type: "EXECUTE"; targetKey: string }
  | { type: "DONE" };

export function transitionConfirmAction(
  state: ConfirmActionState,
  event: ConfirmActionEvent,
): ConfirmActionState {
  switch (event.type) {
    case "REQUEST":
      if (state.status === "executing") return state;
      return state.status === "confirming" && state.targetKey === event.targetKey
        ? { status: "idle" }
        : { status: "confirming", targetKey: event.targetKey };
    case "CANCEL":
      return state.status === "confirming" ? { status: "idle" } : state;
    case "EXECUTE":
      return state.status === "confirming" && state.targetKey === event.targetKey
        ? { status: "executing", targetKey: event.targetKey }
        : state;
    case "DONE":
      return { status: "idle" };
  }
}

/* =========================================================
 * 15. 同步块加载与存活状态机（Synced Block Lifecycle Machine）
 *     修复切换 sourceId 时旧 failed 标记残留卡死问题
 * ========================================================= */

export type SyncedBlockState =
  | { status: "loading"; sourceId: string }
  | { status: "ready"; sourceId: string; record: PageRecord }
  | { status: "missing"; sourceId: string };

export type SyncedBlockEvent =
  | { type: "SWITCH_SOURCE"; sourceId: string }
  | { type: "LOADED"; sourceId: string; record: PageRecord }
  | { type: "FAILED"; sourceId: string };

export function transitionSyncedBlock(
  state: SyncedBlockState,
  event: SyncedBlockEvent,
): SyncedBlockState {
  switch (event.type) {
    case "SWITCH_SOURCE":
      return { status: "loading", sourceId: event.sourceId };
    case "LOADED":
      if (state.sourceId !== event.sourceId) return state;
      return { status: "ready", sourceId: event.sourceId, record: event.record };
    case "FAILED":
      if (state.sourceId !== event.sourceId) return state;
      return { status: "missing", sourceId: event.sourceId };
  }
}

/* =========================================================
 * 16. 媒体内嵌与书签解析块状态机（Embed & Bookmark Block Machines）
 *     显式捕获本地 PDF 上传异常与拖拽调高互斥态
 * ========================================================= */

export type EmbedBlockState =
  | { phase: "editing"; draft: string; error: string | null }
  | { phase: "uploading"; draft: string }
  | { phase: "viewing"; liveHeight: number | null };

export type EmbedBlockEvent =
  | { type: "EDIT"; draft: string }
  | { type: "DRAFT_CHANGE"; draft: string }
  | { type: "CANCEL_EDIT" }
  | { type: "COMMIT_URL" }
  | { type: "UPLOAD_START" }
  | { type: "UPLOAD_DONE" }
  | { type: "UPLOAD_FAIL"; message: string }
  | { type: "RESIZE_MOVE"; height: number }
  | { type: "RESIZE_END" };

export function transitionEmbedBlock(
  state: EmbedBlockState,
  event: EmbedBlockEvent,
): EmbedBlockState {
  switch (event.type) {
    case "EDIT":
      return state.phase === "uploading" ? state : { phase: "editing", draft: event.draft, error: null };
    case "DRAFT_CHANGE":
      return state.phase === "editing" ? { phase: "editing", draft: event.draft, error: null } : state;
    case "CANCEL_EDIT":
    case "COMMIT_URL":
      return state.phase === "uploading" ? state : { phase: "viewing", liveHeight: null };
    case "UPLOAD_START":
      return { phase: "uploading", draft: state.phase === "editing" ? state.draft : "" };
    case "UPLOAD_DONE":
      return { phase: "viewing", liveHeight: null };
    case "UPLOAD_FAIL":
      return {
        phase: "editing",
        draft: state.phase === "uploading" ? state.draft : "",
        error: event.message,
      };
    case "RESIZE_MOVE":
      return state.phase === "viewing"
        ? { phase: "viewing", liveHeight: Math.max(220, Math.min(860, Math.round(event.height))) }
        : state;
    case "RESIZE_END":
      return state.phase === "viewing" ? { phase: "viewing", liveHeight: null } : state;
  }
}

export type BookmarkBlockState =
  | { phase: "editing"; draft: string; error: string | null }
  | { phase: "resolving"; draft: string }
  | { phase: "ready" };

export type BookmarkBlockEvent =
  | { type: "EDIT"; draft: string }
  | { type: "DRAFT_CHANGE"; draft: string }
  | { type: "CANCEL" }
  | { type: "RESOLVE_START"; url: string }
  | { type: "RESOLVE_DONE" }
  | { type: "RESOLVE_FAIL"; draft: string; message: string };

export function transitionBookmarkBlock(
  state: BookmarkBlockState,
  event: BookmarkBlockEvent,
): BookmarkBlockState {
  switch (event.type) {
    case "EDIT":
      return state.phase === "resolving" ? state : { phase: "editing", draft: event.draft, error: null };
    case "DRAFT_CHANGE":
      return state.phase === "editing" ? { phase: "editing", draft: event.draft, error: null } : state;
    case "CANCEL":
    case "RESOLVE_DONE":
      return { phase: "ready" };
    case "RESOLVE_START":
      return state.phase === "resolving" ? state : { phase: "resolving", draft: event.url };
    case "RESOLVE_FAIL":
      return { phase: "editing", draft: event.draft, error: event.message };
  }
}

/* =========================================================
 * 17. 页面划词批注与多轮回复讨论串状态机（Comments Thread Machine）
 * ========================================================= */

export type CommentsBoxState =
  | { mode: "idle" }
  | { mode: "composing" }
  | { mode: "replying"; commentId: string };

export type CommentsBoxEvent =
  | { type: "OPEN_COMPOSER" }
  | { type: "OPEN_REPLY"; commentId: string }
  | { type: "CLOSE" };

export function transitionCommentsBox(
  state: CommentsBoxState,
  event: CommentsBoxEvent,
): CommentsBoxState {
  switch (event.type) {
    case "OPEN_COMPOSER":
      return { mode: "composing" };
    case "OPEN_REPLY":
      return state.mode === "replying" && state.commentId === event.commentId
        ? { mode: "idle" }
        : { mode: "replying", commentId: event.commentId };
    case "CLOSE":
      return { mode: "idle" };
  }
}

/* =========================================================
 * 18. 双栏并排分屏对照状态机（Split Pane Dual-View Machine）
 *     当副屏关联页面被删除或移入回收站时自动收起，防止悬挂引用
 * ========================================================= */

export type SplitPaneState =
  | { open: false }
  | { open: true; pageId: string; ratio: number };

export type SplitPaneEvent =
  | { type: "OPEN"; pageId: string }
  | { type: "CLOSE" }
  | { type: "RESIZE"; ratio: number }
  | { type: "RECONCILE"; validIds: ReadonlySet<string> };

export function transitionSplitPane(state: SplitPaneState, event: SplitPaneEvent): SplitPaneState {
  switch (event.type) {
    case "OPEN":
      return {
        open: true,
        pageId: event.pageId,
        ratio: state.open ? state.ratio : 0.5,
      };
    case "CLOSE":
      return state.open ? { open: false } : state;
    case "RESIZE":
      return state.open
        ? { ...state, ratio: Math.max(0.28, Math.min(0.72, Number(event.ratio.toFixed(3)))) }
        : state;
    case "RECONCILE":
      return state.open && !event.validIds.has(state.pageId) ? { open: false } : state;
  }
}

/* =========================================================
 * 19. 公开分享阅读与口令解锁状态机（Public Share Viewer Machine）
 * ========================================================= */

export type PublicShareViewState =
  | { phase: "loading" }
  | { phase: "locked"; title: string; icon: string | null; unlocking: boolean; error: string | null }
  | { phase: "ready"; page: PageRecord; rows: PageMeta[]; verifiedPassword: string }
  | { phase: "not_found"; message: string };

export type PublicShareViewEvent =
  | { type: "REQUIRE_PASSWORD"; title: string; icon: string | null; error?: string | null }
  | { type: "UNLOCK_START" }
  | { type: "LOADED"; page: PageRecord; rows: PageMeta[]; verifiedPassword?: string }
  | { type: "NOT_FOUND"; message: string };

export function transitionPublicShare(
  state: PublicShareViewState,
  event: PublicShareViewEvent,
): PublicShareViewState {
  switch (event.type) {
    case "REQUIRE_PASSWORD":
      return {
        phase: "locked",
        title: event.title,
        icon: event.icon,
        unlocking: false,
        error: event.error ?? null,
      };
    case "UNLOCK_START":
      return state.phase === "locked" ? { ...state, unlocking: true, error: null } : state;
    case "LOADED":
      return {
        phase: "ready",
        page: event.page,
        rows: event.rows,
        verifiedPassword: event.verifiedPassword ?? "",
      };
    case "NOT_FOUND":
      return { phase: "not_found", message: event.message };
  }
}
