import { useEffect, useRef, useState } from "react";
import { CircleAlert, KeyRound, LoaderCircle, PanelLeft, Plus } from "lucide-react";
import { AiModal } from "./components/AiModal";
import { AiSettingsModal } from "./components/AiSettingsModal";
import { ClipperModal } from "./components/ClipperModal";
import { Logo } from "./components/Logo";
import { PublicShareView } from "./components/PublicShareView";
import { RowDrawer } from "./components/database/RowDrawer";
import { topOverlayName, transitionImport, useMachine } from "./machines";
import { importNotionZip, importNotionZipBuffer, isEncryptedBackupBytes } from "./notionImport";
import {
  closeSettings,
  createPage,
  decryptBackupArchive,
  dismissTopOverlay,
  getState,
  loadPages,
  navigate,
  resizeSplitPane,
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

function getPublicShareToken(): string | null {
  const m = /^\/s\/([a-f0-9]{16,32})\/?$/.exec(window.location.pathname);
  return m ? m[1] : null;
}

export function App() {
  const publicToken = getPublicShareToken();
  if (publicToken) {
    return <PublicShareView token={publicToken} />;
  }
  return <WorkspaceApp />;
}

function WorkspaceApp() {
  const loaded = useStore((s) => s.loaded);
  const pages = useStore((s) => s.pages);
  const overlay = useStore((s) => s.overlay);
  const splitPane = useStore((s) => s.splitPane);
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
  const pendingEncFileRef = useRef<File | null>(null);
  const [encPassword, setEncPassword] = useState("");
  const [importState, sendImport] = useMachine(transitionImport, { status: "idle" });

  const runNotionImport = async (file: File) => {
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    if (file.name.toLowerCase().endsWith(".enc") || isEncryptedBackupBytes(head)) {
      pendingEncFileRef.current = file;
      setEncPassword("");
      sendImport({ type: "NEED_PASSWORD", fileName: file.name });
      return;
    }
    sendImport({ type: "START" });
    try {
      const result = await importNotionZip(file, (text) => sendImport({ type: "PROGRESS", text }));
      sendImport({ type: "SUCCEED", result });
    } catch (err) {
      sendImport({ type: "FAIL", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const runEncryptedImport = async () => {
    const file = pendingEncFileRef.current;
    if (!file || !encPassword.trim()) return;
    sendImport({ type: "START", text: "正在解密 AES-256 备份归档…" });
    try {
      const zipBytes = await decryptBackupArchive(file, encPassword.trim());
      const result = await importNotionZipBuffer(zipBytes.slice().buffer, (text) =>
        sendImport({ type: "PROGRESS", text }),
      );
      pendingEncFileRef.current = null;
      setEncPassword("");
      sendImport({ type: "SUCCEED", result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("口令")) {
        sendImport({ type: "NEED_PASSWORD", fileName: file.name, error: msg });
      } else {
        sendImport({ type: "FAIL", message: msg });
      }
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
      <main className={splitPane.open && current ? "main main-split" : "main"}>
        {current ? (
          <>
            <div
              className="split-pane-primary"
              style={splitPane.open ? { flexBasis: `${splitPane.ratio * 100}%` } : undefined}
            >
              <PageView key={`${current}:${revisions[current] ?? 0}`} id={current} />
            </div>
            {splitPane.open && pages[splitPane.pageId] && (
              <>
                <div
                  className="split-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="拖动调整分屏宽度"
                  onPointerDown={(e) => {
                    const container = e.currentTarget.parentElement;
                    if (!container) return;
                    const rect = container.getBoundingClientRect();
                    const el = e.currentTarget;
                    el.setPointerCapture(e.pointerId);
                    const onMove = (ev: PointerEvent) => {
                      resizeSplitPane((ev.clientX - rect.left) / Math.max(1, rect.width));
                    };
                    const onUp = () => {
                      el.removeEventListener("pointermove", onMove);
                      el.removeEventListener("pointerup", onUp);
                    };
                    el.addEventListener("pointermove", onMove);
                    el.addEventListener("pointerup", onUp);
                  }}
                />
                <div
                  className="split-pane-secondary"
                  style={{ flexBasis: `${(1 - splitPane.ratio) * 100}%` }}
                  data-split-pane="open"
                >
                  <PageView
                    key={`split:${splitPane.pageId}:${revisions[splitPane.pageId] ?? 0}`}
                    id={splitPane.pageId}
                    secondary
                  />
                </div>
              </>
            )}
          </>
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
        accept=".zip,application/zip,.enc,.opennotion.enc,.enex,application/xml,text/xml"
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
              {importState.status === "awaiting_password"
                ? "输入加密归档解密口令"
                : importState.status === "done" && importState.result.source === "backup"
                  ? "备份无损还原完成"
                  : importState.status === "done" && importState.result.source === "obsidian"
                    ? "Obsidian / Markdown 笔记库导入完成"
                    : importState.status === "done" && importState.result.source === "evernote"
                      ? "印象笔记（.enex）导入完成"
                      : "导入笔记与数据库归档"}
            </h2>
            {importState.status === "awaiting_password" && (
              <form
                className="import-pwd-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runEncryptedImport();
                }}
              >
                <p>
                  文件 <code>{importState.fileName}</code> 使用 AES-256-GCM 加密，请输入导出时设置的口令：
                </p>
                <div className="share-link-row" style={{ marginTop: 8 }}>
                  <KeyRound size={15} />
                  <input
                    type="password"
                    autoFocus
                    value={encPassword}
                    placeholder="输入备份解密口令…"
                    onChange={(e) => setEncPassword(e.target.value)}
                  />
                </div>
                {importState.error && <p className="value-error">{importState.error}</p>}
                <div className="import-actions">
                  <button
                    type="button"
                    className="ghost-btn small"
                    onClick={() => {
                      pendingEncFileRef.current = null;
                      sendImport({ type: "DISMISS" });
                    }}
                  >
                    取消
                  </button>
                  <button type="submit" className="primary-btn small" disabled={!encPassword.trim()}>
                    解密并恢复
                  </button>
                </div>
              </form>
            )}
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
                      : importState.result.source === "evernote"
                        ? "印象笔记正文、待办事项、标签及内嵌图片附件已全部转换并保存。"
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
