import { useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronRight,
  ChevronsLeft,
  Ellipsis,
  FileStack,
  FileText,
  Hash,
  Layers,
  Plus,
  Scissors,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Star,
  Table2,
} from "lucide-react";
import { endDragSession, getDraggedPageId, startPageDrag } from "../machines";
import { Logo, Wordmark } from "./Logo";
import type { PageMeta } from "../../shared/types";
import {
  createPage,
  getState,
  isDescendant,
  movePage,
  navigate,
  openSettings,
  setAiOpen,
  setClipperOpen,
  setExpanded,
  setSearchOpen,
  setSidebarCollapsed,
  setSidebarWidth,
  useStore,
  useTree,
  type Tree,
} from "../store";
import { PageMenu } from "./PageMenu";
import { cx } from "./Popover";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? "⌘" : "Ctrl+";

type DropPosition = "before" | "after" | "inside";

async function newPage(parentId: string | null = null) {
  const id = await createPage({ parentId });
  if (id) navigate(id);
}

export function Sidebar({ currentId }: { currentId: string | null }) {
  const tree = useTree();
  const pages = useStore((s) => s.pages);
  const width = useStore((s) => s.sidebarWidth);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const [rootDrop, setRootDrop] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const roots = tree.children.get("") ?? [];

  const tagSummary = useMemo(() => {
    const counts = new Map<string, PageMeta[]>();
    for (const p of Object.values(pages)) {
      if (p.trashed || p.hidden || !p.tags?.length) continue;
      for (const t of p.tags) {
        const list = counts.get(t);
        if (list) list.push(p);
        else counts.set(t, [p]);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh"));
  }, [pages]);

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const onMove = (ev: PointerEvent) => setSidebarWidth(ev.clientX);
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing");
      setSidebarWidth(getState().sidebarWidth, true);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  return (
    <aside
      className={cx("sidebar", collapsed && "collapsed")}
      style={{ width: collapsed ? 0 : width }}
      aria-hidden={collapsed}
      inert={collapsed}
    >
      <div className="sidebar-inner" style={{ width }}>
        <div className="sidebar-header">
          <Logo size={22} />
          <Wordmark className="workspace-name" />
          <button
            type="button"
            className="icon-btn"
            title={`收起侧边栏 ${modKey}\\`}
            aria-label="收起侧边栏"
            onClick={() => setSidebarCollapsed(true)}
          >
            <ChevronsLeft size={17} />
          </button>
          <button type="button" className="icon-btn" title="新建页面" aria-label="新建页面" onClick={() => void newPage()}>
            <SquarePen size={16} />
          </button>
        </div>

        <div className="sidebar-nav">
          <button type="button" className="nav-row" onClick={() => setSearchOpen(true)}>
            <Search size={15} />
            <span>搜索</span>
            <kbd>{modKey}K</kbd>
          </button>
          <button type="button" className="nav-row" onClick={() => setAiOpen(true)}>
            <Sparkles size={15} />
            <span>AI 助手</span>
            <kbd>{modKey}J</kbd>
          </button>
          <button type="button" className="nav-row" onClick={() => setClipperOpen(true)}>
            <Scissors size={15} />
            <span>网页剪藏</span>
            <kbd>{modKey}⇧C</kbd>
          </button>
        </div>

        <div className="sidebar-scroll">
          {tagSummary.length > 0 && (
            <section className="sidebar-section">
              <div className="section-title">
                <span className="section-label">
                  <Hash size={12} /> 标签
                </span>
              </div>
              <div className="sidebar-tag-cloud">
                {tagSummary.map(([tag, list]) => (
                  <button
                    key={tag}
                    type="button"
                    className={cx("sidebar-tag-chip", activeTag === tag && "active")}
                    onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                  >
                    <span>#{tag}</span>
                    <em>{list.length}</em>
                  </button>
                ))}
              </div>
              {activeTag && (
                <div className="sidebar-tag-matches">
                  {(tagSummary.find(([t]) => t === activeTag)?.[1] ?? []).map((p) => (
                    <TreeNode key={p.id} page={p} depth={0} tree={tree} currentId={currentId} draggable={false} />
                  ))}
                </div>
              )}
            </section>
          )}

          {tree.favorites.length > 0 && (
            <section className="sidebar-section">
              <div className="section-title">
                <span className="section-label">
                  <Star size={12} /> 收藏
                </span>
              </div>
              {tree.favorites.map((p) => (
                <TreeNode key={p.id} page={p} depth={0} tree={tree} currentId={currentId} draggable={false} />
              ))}
            </section>
          )}

          <section
            className={cx("sidebar-section", "grow", rootDrop && "root-drop")}
            onDragOver={(e) => {
              const draggingId = getDraggedPageId();
              if (!draggingId || e.target !== e.currentTarget) return;
              e.preventDefault();
              setRootDrop(true);
            }}
            onDragLeave={() => setRootDrop(false)}
            onDrop={(e) => {
              setRootDrop(false);
              const draggingId = getDraggedPageId();
              if (!draggingId || e.target !== e.currentTarget) return;
              e.preventDefault();
              endDragSession();
              void movePage(draggingId, null, roots.filter((p) => p.id !== draggingId).length);
            }}
          >
            <div className="section-title">
              <span className="section-label">
                <Layers size={12} /> 页面
              </span>
              <button type="button" className="icon-btn small" title="新建页面" aria-label="新建页面" onClick={() => void newPage()}>
                <Plus size={15} />
              </button>
            </div>
            {roots.map((p) => (
              <TreeNode key={p.id} page={p} depth={0} tree={tree} currentId={currentId} draggable />
            ))}
            {roots.length === 0 && (
              <div className="tree-empty with-icon">
                <FileStack size={14} /> 还没有页面
              </div>
            )}
            <button type="button" className="nav-row muted add-page" onClick={() => void newPage()}>
              <Plus size={15} />
              <span>新建页面</span>
            </button>
          </section>
        </div>

        <div className="sidebar-footer sidebar-footer-compact">
          <button
            type="button"
            className="icon-btn sidebar-gear-btn"
            title={`设置（外观、同步、AI 模型、导入、回收站） ${modKey},`}
            aria-label="设置"
            onClick={() => openSettings("appearance")}
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      <div className="sidebar-resizer" onPointerDown={startResize} role="separator" aria-orientation="vertical" />
    </aside>
  );
}

interface TreeNodeProps {
  page: PageMeta;
  depth: number;
  tree: Tree;
  currentId: string | null;
  draggable: boolean;
}

function TreeNode({ page, depth, tree, currentId, draggable }: TreeNodeProps) {
  // 收藏区和页面区各自记住展开状态
  const expandKey = draggable ? page.id : `fav:${page.id}`;
  const expanded = useStore((s) => !!s.expanded[expandKey]);
  const [drop, setDrop] = useState<DropPosition | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // 数据库的行不在侧边栏里展开，免得成百上千行把页面树淹没
  const isDatabase = page.kind === "database";
  const kids = isDatabase ? [] : (tree.children.get(page.id) ?? []);
  const active = currentId === page.id;

  const canDropHere = () => {
    const draggingId = getDraggedPageId();
    if (!draggable || !draggingId || draggingId === page.id) return false;
    return !isDescendant(getState().pages, page.id, draggingId);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!canDropHere()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    setDrop(ratio < 0.28 ? "before" : ratio > 0.72 ? "after" : "inside");
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const position = drop;
    setDrop(null);
    const id = getDraggedPageId();
    if (!canDropHere() || !position || !id) return;
    e.preventDefault();
    endDragSession();
    if (position === "inside") {
      void movePage(id, page.id, kids.filter((p) => p.id !== id).length);
      return;
    }
    const siblings = (tree.children.get(page.parentId ?? "") ?? []).filter((p) => p.id !== id);
    const at = siblings.findIndex((p) => p.id === page.id);
    void movePage(id, page.parentId, position === "before" ? at : at + 1);
  };

  return (
    <div role="treeitem" aria-expanded={expanded} aria-selected={active}>
      <div
        ref={rowRef}
        className={cx("tree-row", active && "active", menuAnchor && "menu-open", drop && `drop-${drop}`)}
        style={{ paddingLeft: 6 + depth * 14 }}
        tabIndex={0}
        draggable={draggable}
        onClick={() => navigate(page.id)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter") navigate(page.id);
          if (e.key === "ArrowRight") setExpanded(expandKey, true);
          if (e.key === "ArrowLeft") setExpanded(expandKey, false);
        }}
        onDragStart={(e) => {
          startPageDrag(page.id);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", page.title || "无标题");
        }}
        onDragEnd={() => {
          endDragSession();
          setDrop(null);
        }}
        onDragOver={onDragOver}
        onDragLeave={() => setDrop(null)}
        onDrop={onDrop}
      >
        <button
          type="button"
          disabled={isDatabase}
          className={cx("tree-toggle", expanded && !isDatabase && "open", isDatabase && "hidden")}
          aria-label={expanded ? "收起" : "展开"}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(expandKey, !expanded);
          }}
        >
          <ChevronRight size={14} />
        </button>
        <span className="tree-icon">{page.icon ?? (isDatabase ? <Table2 size={16} /> : <FileText size={16} />)}</span>
        <span className={cx("tree-title", !page.title && "untitled")}>{page.title || "无标题"}</span>
        {page.template && <span className="tree-badge">模板</span>}
        <span className="tree-actions">
          <button
            type="button"
            className="icon-btn small"
            title="更多操作"
            aria-label="更多操作"
            onClick={(e) => {
              e.stopPropagation();
              setMenuAnchor(menuAnchor ? null : e.currentTarget);
            }}
          >
            <Ellipsis size={15} />
          </button>
          <button
            type="button"
            className="icon-btn small"
            title={isDatabase ? "新建一行" : "新建子页面"}
            aria-label={isDatabase ? "新建一行" : "新建子页面"}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(expandKey, true);
              void newPage(page.id);
            }}
          >
            <Plus size={15} />
          </button>
        </span>
      </div>

      {menuAnchor && (
        <PageMenu page={page} anchor={menuAnchor} currentId={currentId} onClose={() => setMenuAnchor(null)} />
      )}

      {expanded && !isDatabase && (
        <div role="group">
          {kids.map((child) => (
            <TreeNode
              key={child.id}
              page={child}
              depth={depth + 1}
              tree={tree}
              currentId={currentId}
              draggable={draggable}
            />
          ))}
          {kids.length === 0 && (
            <div className="tree-empty" style={{ paddingLeft: 6 + (depth + 1) * 14 + 22 }}>
              没有子页面
            </div>
          )}
        </div>
      )}
    </div>
  );
}
