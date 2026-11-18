import { useEffect, useRef } from "react";
import { CircleAlert, LoaderCircle, PanelLeft, Plus } from "lucide-react";
import { AiModal } from "./components/AiModal";
import { AiSettingsModal } from "./components/AiSettingsModal";
import { ClipperModal } from "./components/ClipperModal";
import { Logo } from "./components/Logo";
import { RowDrawer } from "./components/database/RowDrawer";
import { topOverlayName, transitionImport, useMachine } from "./machines";
import { importNotionZip } from "./notionImport";
import {
  closeSettings,
  createPage,
  dismissTopOverlay,
  getState,
  loadPages,
  navigate,
  sendOverlay,
  setExpanded,
  setSidebarCollapsed,
  useRoute,
  useStore,
  useTree,
} from "./store";
import { PageView } from "./components/PageView";
import { SearchModal } from "./components/SearchModal";
import { Sidebar } from "./components/Sidebar";

const LAST_PAGE_KEY = "on:lastPage";

export function App() {
  const loaded = useStore((s) => s.loaded);
  const pages = useStore((s) => s.pages);
  const overlay = useStore((s) => s.overlay);
  const searchOpen = overlay.modal === "search";
  const aiOpen = overlay.modal === "ai";
  const clipperOpen = overlay.modal === "clipper";
  const settingsOpen = overlay.aiSettings;
  const peekRowId = overlay.peekRowId;
  const topOverlay = topOverlayName(overlay);
  const revisions = useStore((s) => s.revisions);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const error = useStore((s) => s.error);
  const route = useRoute();
  const tree = useTree();
  const current = route && pages[route] ? route : null;

  const zipInputRef = useRef<HTMLInputElement>(null);
  const [importState, sendImport] = useMachine(transitionImport, { status: "idle" });

  const runNotionImport = async (file: File) => {
    sendImport({ type: "START" });
    try {
      const result = await importNotionZip(file, (text) => sendImport({ type: "PROGRESS", text }));
      sendImport({ type: "SUCCEED", result });
    } catch (err) {
      sendImport({ type: "FAIL", message: err instanceof Error ? err.message : String(err) });
    }
  };

  useEffect(() => {
    if (importState.status === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        sendImport({ type: "DISMISS" });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [importState.status, sendImport]);

  useEffect(() => {
    void loadPages();
  }, []);

  useEffect(() => {
    if (!loaded || current) return;
    let last: string | null;
    try {
      last = localStorage.getItem(LAST_PAGE_KEY);
    } catch {
      last = null;
    }
    const fallback = last && pages[last] && !pages[last].trashed ? last : (tree.children.get("")?.[0]?.id ?? null);
    if (fallback) navigate(fallback, true);
    else if (route) navigate(null, true);
  }, [loaded, current, route, pages, tree]);

  useEffect(() => {
    if (!current) return;
    try {
      localStorage.setItem(LAST_PAGE_KEY, current);
    } catch {
      /* 忽略 */
    }
  }, [current]);

  useEffect(() => {
    const onShortcut = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "k" || key === "p") {
        const sel = window.getSelection();
        const inEditor = (e.target as HTMLElement | null)?.closest?.(".bn-editor");
        if (key === "k" && inEditor && sel && !sel.isCollapsed) return;
        e.preventDefault();
        e.stopPropagation();
        sendOverlay({ type: "TOGGLE_SEARCH" });
      } else if (key === "j") {
        e.preventDefault();
        e.stopPropagation();
        sendOverlay({ type: "TOGGLE_AI" });
      } else if (key === "c" && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        sendOverlay({ type: "TOGGLE_CLIPPER" });
      } else if (e.key === ",") {
        e.preventDefault();
        e.stopPropagation();
        sendOverlay({ type: "TOGGLE_SETTINGS" });
      } else if (e.key === "\\") {
        e.preventDefault();
        setSidebarCollapsed(!getState().sidebarCollapsed);
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (document.querySelector("[data-local-modal]")) return;
      if (dismissTopOverlay()) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onShortcut, true);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", onShortcut, true);
      window.removeEventListener("keydown", onEscape);
    };
  }, []);

  return (
    <div
      className="app"
      data-boot-state={loaded ? "ready" : "loading"}
      data-top-overlay={topOverlay}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const link = (e.target as HTMLElement | null)?.closest?.("a");
        if (!link || link.closest(".bn-editor[contenteditable='true']")) return;
        const m = /^#\/([a-f0-9]{16})$/.exec(link.getAttribute("href") ?? "");
        if (m) {
          e.preventDefault();
          navigate(m[1]);
        }
      }}
    >
      <Sidebar currentId={current} />
      {!collapsed && <div className="sidebar-backdrop" onClick={() => setSidebarCollapsed(true)} />}
      <main className="main">
        {current ? (
          <PageView key={`${current}:${revisions[current] ?? 0}`} id={current} />
        ) : (
          <div className="page">
            {collapsed && (
              <header className="topbar">
                <button type="button" className="icon-btn" aria-label="展开侧边栏" onClick={() => setSidebarCollapsed(false)}>
                  <PanelLeft size={18} />
                </button>
              </header>
            )}
            {!loaded && (
              <div className="splash" role="status" aria-label="正在加载">
                <Logo size={64} />
              </div>
            )}
            {loaded && (
              <div className="empty-state">
                <Logo size={68} className="empty-logo" />
                <h1>这里还没有页面</h1>
                <p>新建一个页面，开始记录吧。</p>
                <button
                  type="button"
                  className="primary-btn"
                  onClick={async () => {
                    const id = await createPage();
                    if (id) navigate(id);
                  }}
                >
                  <Plus size={16} /> 新建页面
                </button>
              </div>
            )}
          </div>
        )}
      </main>
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void runNotionImport(file);
        }}
      />
      {peekRowId && <RowDrawer id={peekRowId} />}
      {searchOpen && <SearchModal />}
      {aiOpen && <AiModal currentPageId={current} />}
      {clipperOpen && <ClipperModal />}
      {settingsOpen && (
        <AiSettingsModal
          onClose={closeSettings}
          onImportNotionZip={() => zipInputRef.current?.click()}
        />
      )}
      {importState.status !== "idle" && (
        <div
          className="modal-backdrop"
          data-local-modal="import"
          onMouseDown={(e) => e.target === e.currentTarget && sendImport({ type: "DISMISS" })}
        >
          <div
            className="import-modal"
            role="dialog"
            aria-modal="true"
            aria-label="导入与恢复工作区数据"
            data-import-state={importState.status}
          >
            <h2>
              {importState.status === "done" && importState.result.source === "backup"
                ? "备份无损还原完成"
                : importState.status === "done" && importState.result.source === "obsidian"
                  ? "Obsidian / Markdown 笔记库导入完成"
                  : "导入笔记与数据库压缩包"}
            </h2>
            {importState.status === "running" && (
              <p className="import-progress" aria-live="polite">
                <LoaderCircle size={15} className="spin" /> {importState.text}
              </p>
            )}
            {importState.status === "done" && (
              <>
                <p>
                  已处理：{importState.result.pages} 个页面，{importState.result.databases} 个数据库（共{" "}
                  {importState.result.rows} 行），{importState.result.files} 个图片或附件。
                </p>
                <p className="import-note">
                  {importState.result.source === "backup"
                    ? "所有页面、多维数据库视图、公式与标签已按备份原样无损恢复。"
                    : importState.result.source === "obsidian"
                      ? "目录层级、YAML 标签及 [[双链]] 已自动转换为原生页面树与双向链接。"
                      : "内容已归入新创建的导入页面下；数据库的列类型已根据内容自动识别。"}
                </p>
                <div className="import-actions">
                  <button
                    type="button"
                    className="primary-btn small"
                    onClick={() => {
                      navigate(importState.result.rootId);
                      setExpanded(importState.result.rootId, true);
                      sendImport({ type: "DISMISS" });
                    }}
                  >
                    查看导入的内容
                  </button>
                </div>
              </>
            )}
            {importState.status === "error" && (
              <>
                <p className="value-error">{importState.message}</p>
                <div className="import-actions">
                  <button type="button" className="ghost-btn small" onClick={() => sendImport({ type: "DISMISS" })}>
                    关闭
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {error && (
        <div className="toast" role="alert">
          <CircleAlert size={16} />
          {error}
        </div>
      )}
    </div>
  );
}
