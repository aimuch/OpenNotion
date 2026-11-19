import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownLeft,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  Ellipsis,
  FileText,
  HardDriveDownload,
  Image as ImageIcon,
  Kanban,
  LayoutTemplate,
  List,
  LoaderCircle,
  Lock,
  MessageSquare,
  PanelLeft,
  Plus,
  RotateCcw,
  Share2,
  Smile,
  Sparkles,
  Star,
  Table2,
  Tag,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { PageMeta, SearchHit } from "../../shared/types";
import { blocksPlainText, suggestPageTags } from "../ai";
import { transitionConfirmAction, transitionCover, transitionPageLoad, useMachine } from "../machines";
import {
  ancestorsOf,
  applyTemplate,
  buildTree,
  closePageModal,
  closeSplitPane,
  deletePage,
  fetchBacklinks,
  fetchPage,
  getState,
  navigate,
  openHistoryModal,
  openPosterModal,
  reportError,
  restorePage,
  retryFailedSaves,
  setAiOpen,
  setSidebarCollapsed,
  updatePage,
  useStore,
} from "../store";
import { BUILTIN_TEMPLATES } from "../templates";
import { CommentsBox } from "./CommentsBox";
import { HistoryModal } from "./HistoryModal";
import { MenuItem, Popover, cx } from "./Popover";
import { PosterModal } from "./PosterModal";
import { defaultDatabase, exportCsv } from "../db";
import { DatabaseView, RowProperties } from "./database/DatabaseView";
import { Editor, type NoteEditor } from "./Editor";
import { PageMenu } from "./PageMenu";
import { CoverPicker, EmojiPicker, coverStyle, randomCover } from "./pickers";
import { modKey } from "./Sidebar";

interface OutlineItem {
  id: string;
  level: number;
  text: string;
}

function extractOutline(blocks: unknown[], out: OutlineItem[] = []): OutlineItem[] {
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as {
      id?: string;
      type?: string;
      props?: { level?: number };
      content?: { text?: string }[];
      children?: unknown[];
    };
    if (b.type === "heading" && b.id) {
      const text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join("").trim() : "";
      if (text) out.push({ id: b.id, level: Number(b.props?.level ?? 1), text });
    }
    if (Array.isArray(b.children) && b.children.length > 0) extractOutline(b.children, out);
  }
  return out;
}

export function PageView({ id, secondary = false }: { id: string; secondary?: boolean }) {
  const meta = useStore((s) => s.pages[id]);
  const parent = useStore((s) => (meta?.parentId ? s.pages[meta.parentId] : undefined));
  const pageModal = useStore((s) => (secondary ? "none" : (s.overlay.pageModal ?? "none")));
  const [loadState, sendLoad] = useMachine(transitionPageLoad, { status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [docTick, setDocTick] = useState(0);
  const onDirty = useCallback(() => {
    sendLoad({ type: "MARK_DIRTY" });
    setDocTick((n) => n + 1);
  }, [sendLoad]);
  const historyOpen = pageModal === "history";
  const posterOpen = pageModal === "poster";
  const [templateAnchor, setTemplateAnchor] = useState<HTMLElement | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [pendingQuote, setPendingQuote] = useState<string | null>(null);
  const [tagInputOpen, setTagInputOpen] = useState(false);
  const [aiTrigger, setAiTrigger] = useState(0);
  const [backlinks, setBacklinks] = useState<SearchHit[]>([]);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const allPages = useStore((s) => s.pages);
  const editorRef = useRef<NoteEditor | null>(null);
  const onReady = useCallback((editor: NoteEditor | null) => {
    editorRef.current = editor;
  }, []);

  useEffect(() => {
    let alive = true;
    sendLoad({ type: "RELOAD" });
    fetchPage(id).then(
      (page) => alive && sendLoad({ type: "LOADED", record: page }),
      (err: Error) => alive && sendLoad({ type: "FAILED", message: err.message }),
    );
    fetchBacklinks(id).then(
      (list) => alive && setBacklinks(list),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [id, reloadKey, sendLoad]);

  useEffect(() => {
    document.title = meta ? `${meta.title || "无标题"} · OpenNotion` : "OpenNotion";
  }, [meta?.title, meta]);

  if (!meta) return null;

  const isDatabase = meta.kind === "database";
  const editable = !meta.trashed && !meta.locked;
  const userTemplates = Object.values(allPages)
    .filter((p) => p.template && !p.trashed && !p.hidden && p.id !== meta.id)
    .sort((a, b) => a.title.localeCompare(b.title, "zh"));
  const isRow = parent?.kind === "database" && !parent.trashed;
  const record = loadState.status === "ready" ? loadState.record : null;
  const dirty = loadState.status === "ready" ? loadState.dirty : false;
  const blank = !isDatabase && !isRow && editable && !dirty && record?.content.length === 0;

  const currentDoc = editorRef.current?.document ?? record?.content ?? [];
  const { wordCount, outline } = useMemo(() => {
    if (isDatabase) return { wordCount: undefined, outline: [] as OutlineItem[] };
    const doc = editorRef.current?.document ?? record?.content ?? [];
    return {
      wordCount: blocksPlainText(doc).replace(/\s+/g, "").length,
      outline: extractOutline(doc),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDatabase, record, docTick]);

  const downloadBlob = (blob: Blob, ext: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(meta.title || "无标题").replace(/[\\/:*?"<>|]/g, "_")}.${ext}`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const exportPrimary = () => {
    if (isDatabase) {
      exportCsv(meta, buildTree(getState().pages).children.get(meta.id) ?? []);
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    const body = editor.blocksToMarkdownLossy(editor.document);
    downloadBlob(new Blob([`# ${meta.title || "无标题"}\n\n${body}`], { type: "text/markdown;charset=utf-8" }), "md");
  };

  const exportHtml = async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const bodyHtml = await editor.blocksToHTMLLossy(editor.document);
    const safeTitle = (meta.title || "无标题").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
  body { max-width: 760px; margin: 48px auto; padding: 0 24px; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; color: #222; }
  h1 { font-size: 2.2em; margin-bottom: 0.6em; }
  pre { padding: 14px; border-radius: 8px; background: #f5f5f4; overflow-x: auto; }
  code { padding: 2px 5px; border-radius: 4px; background: #f5f5f4; }
  blockquote, aside { margin: 1em 0; padding: 10px 14px; border-left: 3px solid #ddd; background: #fafaf9; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  td, th { border: 1px solid #e5e5e5; padding: 8px 10px; text-align: left; }
  img { max-width: 100%; border-radius: 6px; }
</style>
</head>
<body>
<h1>${meta.icon ? `${meta.icon} ` : ""}${safeTitle}</h1>
${bodyHtml}
</body>
</html>`;
    downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), "html");
  };

  return (
    <div className="page" data-page-state={isDatabase ? "ready" : loadState.status}>
      <Topbar
        page={meta}
        secondary={secondary}
        onExport={exportPrimary}
        exportLabel={isDatabase ? "导出为 CSV" : "导出为 Markdown"}
        onExportHtml={isDatabase ? undefined : () => void exportHtml()}
        onPoster={openPosterModal}
        onHistory={isDatabase ? undefined : openHistoryModal}
        wordCount={wordCount}
      />
      {meta.trashed && <TrashBanner page={meta} />}
      <div className="page-scroll">
        {meta.cover && <Cover page={meta} editable={editable} />}
        <div
          className={cx(
            "page-body",
            `font-${meta.font ?? "sans"}`,
            meta.smallText && "small-text",
            meta.fullWidth && "full-width",
            meta.cover && "has-cover",
            isDatabase && "database-page",
          )}
        >
          <PageHeader
            page={meta}
            editable={editable}
            onEnter={() => editorRef.current?.focus()}
            onAddComment={() => setCommentOpen(true)}
            onAddTag={() => setTagInputOpen(true)}
          />
          <PageTagsBar
            page={meta}
            editable={editable}
            adding={tagInputOpen}
            onCloseAdding={() => setTagInputOpen(false)}
            getBodyText={() => blocksPlainText(currentDoc)}
          />
          {isRow && parent && (
            <div inert={!editable}>
              <RowProperties row={meta} dbPage={parent} />
            </div>
          )}
          <CommentsBox
            page={meta}
            openComposer={commentOpen}
            pendingQuote={pendingQuote}
            onClearQuote={() => setPendingQuote(null)}
            onCloseComposer={() => setCommentOpen(false)}
          />
          {backlinks.length > 0 && (
            <div className="backlinks-bar">
              <button
                type="button"
                className="backlinks-toggle"
                onClick={() => setBacklinksOpen(!backlinksOpen)}
              >
                <ChevronRight size={13} className={cx("backlinks-chevron", backlinksOpen && "open")} />
                <ArrowDownLeft size={13} />
                <span>{backlinks.length} 个反向链接</span>
              </button>
              {backlinksOpen && (
                <div className="backlinks-list">
                  {backlinks.map((b) => (
                    <button key={b.id} type="button" className="backlink-item" onClick={() => navigate(b.id)}>
                      <span className="tree-icon">{b.icon ?? <FileText size={14} />}</span>
                      <span className="backlink-title">{b.title || "无标题"}</span>
                      {b.snippet && <span className="backlink-snippet">{b.snippet}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {isDatabase ? (
            <div inert={!editable}>
              <DatabaseView page={meta} />
            </div>
          ) : record ? (
            <>
              <Editor
                page={record}
                editable={editable}
                onReady={onReady}
                onDirty={onDirty}
                onContentSync={() => setDocTick((n) => n + 1)}
                aiTrigger={aiTrigger}
                onQuoteComment={(q) => {
                  setPendingQuote(q);
                  setCommentOpen(true);
                }}
              />
              {blank && (
                <div className="starters">
                  <button type="button" onClick={() => setAiTrigger((n) => n + 1)}>
                    <Sparkles size={15} /> AI 帮我写
                  </button>
                  <button type="button" onClick={(e) => setTemplateAnchor(templateAnchor ? null : e.currentTarget)}>
                    <LayoutTemplate size={15} /> 使用模板
                  </button>
                  <span>或者变成数据库：</span>
                  <button type="button" onClick={() => updatePage(meta.id, { kind: "database", database: defaultDatabase("table") })}>
                    <Table2 size={15} /> 表格
                  </button>
                  <button type="button" onClick={() => updatePage(meta.id, { kind: "database", database: defaultDatabase("board") })}>
                    <Kanban size={15} /> 看板
                  </button>
                  <button type="button" onClick={() => updatePage(meta.id, { kind: "database", database: defaultDatabase("list") })}>
                    <List size={15} /> 列表
                  </button>
                  <button type="button" onClick={() => updatePage(meta.id, { kind: "database", database: defaultDatabase("calendar") })}>
                    <CalendarDays size={15} /> 日历
                  </button>
                </div>
              )}
            </>
          ) : loadState.status === "error" ? (
            <div className="page-message">
              <CircleAlert size={16} /> 加载失败：{loadState.message}
              <button type="button" className="text-btn small" onClick={() => setReloadKey((n) => n + 1)}>
                <RotateCcw size={13} /> 重试
              </button>
            </div>
          ) : (
            <div className="editor-skeleton" aria-hidden>
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
        {outline.length >= 2 && <FloatingOutline items={outline} />}
      </div>
      {historyOpen && <HistoryModal page={meta} onClose={closePageModal} />}
      {posterOpen && !isDatabase && (
        <PosterModal
          page={meta}
          blocks={currentDoc}
          wordCount={wordCount ?? 0}
          onClose={closePageModal}
        />
      )}
      {templateAnchor && (
        <Popover anchor={templateAnchor} onClose={() => setTemplateAnchor(null)} className="menu template-menu">
          <div className="menu-title">内置模板</div>
          {BUILTIN_TEMPLATES.map((tpl) => (
            <MenuItem
              key={tpl.id}
              icon={<span className="template-icon">{tpl.icon}</span>}
              label={tpl.name}
              hint={tpl.description}
              onClick={() => {
                setTemplateAnchor(null);
                const editor = editorRef.current;
                if (!editor) return;
                editor.replaceBlocks(editor.document, tpl.content as Parameters<typeof editor.replaceBlocks>[1]);
                updatePage(meta.id, { icon: meta.icon ?? tpl.icon, title: meta.title || tpl.name });
              }}
            />
          ))}
          {userTemplates.length > 0 && <div className="menu-title">我的模板</div>}
          {userTemplates.map((tpl) => (
            <MenuItem
              key={tpl.id}
              icon={<span className="template-icon">{tpl.icon ?? "📄"}</span>}
              label={tpl.title || "无标题"}
              onClick={() => {
                setTemplateAnchor(null);
                void applyTemplate(meta.id, tpl.id);
              }}
            />
          ))}
          <div className="menu-footnote">在任意页面的菜单里选“设为模板”，它就会出现在这里。</div>
        </Popover>
      )}
    </div>
  );
}

function FloatingOutline({ items }: { items: OutlineItem[] }) {
  const minLevel = items.reduce((m, i) => Math.min(m, i.level), 3);
  return (
    <aside className="floating-outline" aria-label="本页标题大纲">
      <div className="outline-ticks" aria-hidden>
        {items.map((item) => (
          <span key={item.id} className={cx("outline-tick", `level-${item.level}`)} />
        ))}
      </div>
      <div className="outline-panel">
        <div className="outline-title">目录大纲</div>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="outline-link"
            style={{ paddingLeft: 8 + Math.max(0, item.level - minLevel) * 12 }}
            onClick={() => {
              document.querySelector(`[data-id="${item.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
          >
            {item.text}
          </button>
        ))}
      </div>
    </aside>
  );
}

interface TopbarProps {
  page: PageMeta;
  secondary?: boolean;
  onExport: () => void;
  exportLabel: string;
  onExportHtml?: () => void;
  onPoster?: () => void;
  onHistory?: () => void;
  wordCount?: number;
}

function Topbar({
  page,
  secondary,
  onExport,
  exportLabel,
  onExportHtml,
  onPoster,
  onHistory,
  wordCount,
}: TopbarProps) {
  const pages = useStore((s) => s.pages);
  const saveSummary = useStore((s) => s.saveSummary);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const chain = [...ancestorsOf(pages, page.id), page];
  const crumbs: (PageMeta | null)[] = chain.length > 4 ? [chain[0], null, ...chain.slice(-2)] : chain;

  return (
    <header className="topbar">
      {!secondary && collapsed && (
        <button
          type="button"
          className="icon-btn"
          title={`展开侧边栏 ${modKey}\\`}
          aria-label="展开侧边栏"
          onClick={() => setSidebarCollapsed(false)}
        >
          <PanelLeft size={18} />
        </button>
      )}
      {secondary && (
        <button
          type="button"
          className="icon-btn small"
          title="关闭右侧分屏"
          aria-label="关闭右侧分屏"
          onClick={() => closeSplitPane()}
        >
          <X size={16} />
        </button>
      )}
      <nav className="breadcrumbs" aria-label="页面路径">
        {crumbs.map((p, i) => (
          <Fragment key={p?.id ?? "gap"}>
            {i > 0 && <span className="crumb-sep">/</span>}
            {p ? (
              <button type="button" className="crumb" onClick={() => navigate(p.id)}>
                <span className="crumb-icon">
                  {p.icon ?? (p.kind === "database" ? <Table2 size={15} /> : <FileText size={15} />)}
                </span>
                <span className="crumb-title">{p.title || "无标题"}</span>
              </button>
            ) : (
              <span className="crumb-gap">…</span>
            )}
          </Fragment>
        ))}
      </nav>
      <div className="topbar-right">
        {page.locked && !page.trashed && (
          <button
            type="button"
            className="lock-pill"
            title="点击解锁编辑"
            onClick={() => updatePage(page.id, { locked: false })}
          >
            <Lock size={12} /> 已锁定
          </button>
        )}
        {saveSummary.phase === "error" ? (
          <button
            type="button"
            className="save-state save-retry"
            data-save-state="error"
            title={saveSummary.message}
            onClick={() => void retryFailedSaves()}
          >
            <CircleAlert size={13} /> 保存失败 · 点击重试
          </button>
        ) : (
          <span className="save-state" data-save-state={saveSummary.phase} aria-live="polite">
            {saveSummary.phase === "saving" ? (
              <LoaderCircle size={13} className="spin" />
            ) : (
              <HardDriveDownload size={13} />
            )}
            {saveSummary.phase === "saving" ? "保存中…" : "已保存到本地"}
          </span>
        )}
        {!page.trashed && (
          <>
            {onPoster && (
              <button
                type="button"
                className="icon-btn"
                title="生成分享海报 / 打印 PDF"
                aria-label="生成分享海报"
                onClick={onPoster}
              >
                <Share2 size={16} />
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              title={`AI 助手 ${modKey}J`}
              aria-label="AI 助手"
              onClick={() => setAiOpen(true)}
            >
              <Sparkles size={17} />
            </button>
            <button
              type="button"
              className={cx("icon-btn", page.favorite && "starred")}
              title={page.favorite ? "取消收藏" : "添加到收藏"}
              aria-label={page.favorite ? "取消收藏" : "添加到收藏"}
              aria-pressed={page.favorite}
              onClick={() => updatePage(page.id, { favorite: !page.favorite })}
            >
              <Star size={17} fill={page.favorite ? "currentColor" : "none"} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="更多操作"
              aria-label="更多操作"
              onClick={(e) => setMenuAnchor(menuAnchor ? null : e.currentTarget)}
            >
              <Ellipsis size={18} />
            </button>
          </>
        )}
      </div>
      {menuAnchor && (
        <PageMenu
          page={page}
          anchor={menuAnchor}
          currentId={page.id}
          align="end"
          showLayout
          onExport={onExport}
          exportLabel={exportLabel}
          onExportHtml={onExportHtml}
          onPoster={onPoster}
          onHistory={onHistory}
          wordCount={wordCount}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </header>
  );
}

function TrashBanner({ page }: { page: PageMeta }) {
  const [confirmState, sendConfirm] = useMachine(transitionConfirmAction, { status: "idle" });
  const confirming = confirmState.status === "confirming" && confirmState.targetKey === page.id;

  return (
    <div className="trash-banner" role="status" data-confirm-state={confirmState.status}>
      <span className="trash-banner-text">
        <Trash2 size={15} /> 此页面在回收站中，暂时不能编辑。
      </span>
      <button type="button" onClick={() => void restorePage(page.id)}>
        <Undo2 size={14} /> 恢复页面
      </button>
      {confirming ? (
        <>
          <button
            type="button"
            onClick={async () => {
              sendConfirm({ type: "EXECUTE", targetKey: page.id });
              try {
                await deletePage(page.id);
              } finally {
                sendConfirm({ type: "DONE" });
              }
            }}
          >
            确认永久删除
          </button>
          <button type="button" onClick={() => sendConfirm({ type: "CANCEL" })}>
            取消
          </button>
        </>
      ) : (
        <button type="button" onClick={() => sendConfirm({ type: "REQUEST", targetKey: page.id })}>
          <Trash2 size={14} /> 永久删除
        </button>
      )}
    </div>
  );
}

function Cover({ page, editable }: { page: PageMeta; editable: boolean }) {
  const [coverState, sendCover] = useMachine(transitionCover, { mode: "viewing" });

  const isUploadedImg = Boolean(page.cover?.startsWith("/uploads/"));
  const repositioning = coverState.mode === "repositioning";
  const activeY = repositioning ? coverState.draftY : (page.coverY ?? 50);

  useEffect(() => {
    if (!repositioning) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        sendCover({ type: "FINISH_REPOSITION" });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [repositioning, sendCover]);

  const startDragCover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (coverState.mode !== "repositioning") return;
    e.preventDefault();
    const startClientY = e.clientY;
    const startVal = coverState.draftY;
    const rectH = e.currentTarget.getBoundingClientRect().height || 200;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    sendCover({ type: "DRAG_START" });
    const onMove = (ev: PointerEvent) => {
      const delta = ((startClientY - ev.clientY) / rectH) * 100;
      sendCover({ type: "DRAG_MOVE", y: startVal + delta });
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      sendCover({ type: "DRAG_END" });
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className={cx("cover", coverState.mode === "picking" && "picking", repositioning && "repositioning")}
      data-cover-state={coverState.mode}
      style={coverStyle(page.cover!, activeY)}
      onPointerDown={startDragCover}
    >
      {repositioning && (
        <div className="cover-reposition-tip">上下拖动图片调整显示焦点（Esc 取消）</div>
      )}
      {editable && (
        <div className={cx("cover-actions", repositioning && "visible")} onPointerDown={(e) => e.stopPropagation()}>
          {coverState.mode === "repositioning" ? (
            <>
              <button
                type="button"
                onClick={() => {
                  updatePage(page.id, { coverY: coverState.draftY });
                  sendCover({ type: "FINISH_REPOSITION" });
                }}
              >
                保存位置
              </button>
              <button
                type="button"
                onClick={() => sendCover({ type: "FINISH_REPOSITION" })}
              >
                取消
              </button>
            </>
          ) : (
            <>
              {isUploadedImg && (
                <button
                  type="button"
                  onClick={() => sendCover({ type: "START_REPOSITION", initialY: page.coverY ?? 50 })}
                >
                  调整位置
                </button>
              )}
              <button type="button" onClick={(e) => sendCover({ type: "TOGGLE_PICKER", anchor: e.currentTarget })}>
                更换封面
              </button>
            </>
          )}
        </div>
      )}
      {coverState.mode === "picking" && (
        <CoverPicker
          anchor={coverState.anchor}
          onPick={(cover) => updatePage(page.id, { cover, coverY: 50 })}
          onClose={() => sendCover({ type: "CLOSE_PICKER" })}
        />
      )}
    </div>
  );
}

function PageHeader({
  page,
  editable,
  onEnter,
  onAddComment,
  onAddTag,
}: {
  page: PageMeta;
  editable: boolean;
  onEnter: () => void;
  onAddComment: () => void;
  onAddTag: () => void;
}) {
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    let lastWidth = -1;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth === lastWidth) return;
      lastWidth = el.offsetWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [page.title]);

  useEffect(() => {
    if (editable && page.title === "") titleRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="page-header">
      {page.icon && (
        <button
          type="button"
          className="page-icon"
          aria-label="更换图标"
          disabled={!editable}
          onClick={(e) => setEmojiAnchor(emojiAnchor ? null : e.currentTarget)}
        >
          {page.icon}
        </button>
      )}
      {editable && (
        <div className={cx("page-controls", emojiAnchor && "visible")}>
          {!page.icon && (
            <button type="button" onClick={(e) => setEmojiAnchor(emojiAnchor ? null : e.currentTarget)}>
              <Smile size={15} /> 添加图标
            </button>
          )}
          {!page.cover && (
            <button type="button" onClick={() => updatePage(page.id, { cover: randomCover() })}>
              <ImageIcon size={15} /> 添加封面
            </button>
          )}
          {(page.tags ?? []).length === 0 && (
            <button type="button" onClick={onAddTag}>
              <Tag size={15} /> 添加标签
            </button>
          )}
          {(page.comments ?? []).length === 0 && (
            <button type="button" onClick={onAddComment}>
              <MessageSquare size={15} /> 添加批注
            </button>
          )}
        </div>
      )}
      <textarea
        ref={titleRef}
        className="page-title"
        rows={1}
        value={page.title}
        placeholder="无标题"
        aria-label="页面标题"
        readOnly={!editable}
        spellCheck={false}
        onChange={(e) => updatePage(page.id, { title: e.target.value.replace(/\n/g, " ") })}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" || e.key === "ArrowDown") {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      {emojiAnchor && (
        <EmojiPicker
          anchor={emojiAnchor}
          hasIcon={!!page.icon}
          onPick={(icon) => updatePage(page.id, { icon })}
          onClose={() => setEmojiAnchor(null)}
        />
      )}
    </div>
  );
}

function PageTagsBar({
  page,
  editable,
  adding,
  onCloseAdding,
  getBodyText,
}: {
  page: PageMeta;
  editable: boolean;
  adding: boolean;
  onCloseAdding: () => void;
  getBodyText: () => string;
}) {
  const allPages = useStore((s) => s.pages);
  const tags = page.tags ?? [];
  const [draft, setDraft] = useState("");
  const [inputOpen, setInputOpen] = useState(adding);
  const [aiTagging, setAiTagging] = useState(false);

  useEffect(() => {
    if (adding) setInputOpen(true);
  }, [adding]);

  if (tags.length === 0 && !inputOpen) return null;

  const workspaceTags = Array.from(
    new Set(
      Object.values(allPages)
        .filter((p) => !p.trashed && !p.hidden)
        .flatMap((p) => p.tags ?? []),
    ),
  );

  const addTag = (raw: string) => {
    const clean = raw.trim().replace(/^#+/, "").slice(0, 32);
    if (!clean) return;
    if (!tags.includes(clean)) {
      updatePage(page.id, { tags: [...tags, clean] });
    }
    setDraft("");
  };

  const removeTag = (target: string) => {
    updatePage(page.id, { tags: tags.filter((t) => t !== target) });
  };

  const runAiTagging = async () => {
    if (aiTagging) return;
    setAiTagging(true);
    try {
      const suggested = await suggestPageTags(page.title, getBodyText(), workspaceTags);
      if (suggested.length > 0) {
        updatePage(page.id, { tags: Array.from(new Set([...tags, ...suggested])).slice(0, 12) });
      }
    } catch (err) {
      reportError(err instanceof Error ? err.message : "AI 自动打标失败，请检查模型配置");
    } finally {
      setAiTagging(false);
    }
  };

  return (
    <div className="page-tags-bar" aria-label="页面标签">
      {tags.map((tag) => (
        <span key={tag} className="page-tag-pill">
          <span className="page-tag-hash">#</span>
          <span>{tag}</span>
          {editable && (
            <button
              type="button"
              className="page-tag-remove"
              aria-label={`移除标签 ${tag}`}
              onClick={() => removeTag(tag)}
            >
              <X size={11} />
            </button>
          )}
        </span>
      ))}

      {editable && inputOpen ? (
        <div className="page-tag-input-wrap">
          <input
            autoFocus
            list={`tag-pool-${page.id}`}
            value={draft}
            placeholder="输入标签回车…"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft.trim()) addTag(draft);
              setInputOpen(false);
              onCloseAdding();
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag(draft);
              } else if (e.key === "Escape") {
                setDraft("");
                setInputOpen(false);
                onCloseAdding();
              }
            }}
          />
          <datalist id={`tag-pool-${page.id}`}>
            {workspaceTags
              .filter((t) => !tags.includes(t))
              .map((t) => (
                <option key={t} value={t} />
              ))}
          </datalist>
        </div>
      ) : (
        editable && (
          <button type="button" className="text-btn small" onClick={() => setInputOpen(true)}>
            <Plus size={12} /> 标签
          </button>
        )
      )}

      {editable && (
        <button
          type="button"
          className="text-btn small ai-tag-btn"
          disabled={aiTagging}
          title="根据正文内容自动提取分类标签"
          onClick={() => void runAiTagging()}
        >
          {aiTagging ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}
          {aiTagging ? "分析中…" : "AI 自动打标"}
        </button>
      )}
    </div>
  );
}
