import { useEffect, useRef, useState } from "react";
import {
  ALargeSmall,
  Clock,
  Columns2,
  Copy,
  Download,
  FileCode2,
  FileText,
  History,
  LayoutTemplate,
  Link2,
  Lock,
  LockOpen,
  PencilLine,
  Share2,
  Star,
  StarOff,
  Trash2,
  UnfoldHorizontal,
} from "lucide-react";
import type { PageFont, PageMeta } from "../../shared/types";
import {
  buildTree,
  duplicatePage,
  getState,
  isDescendant,
  navigate,
  openSplitPane,
  trashPage,
  updatePage,
} from "../store";
import { MenuDivider, MenuItem, Popover, cx } from "./Popover";

/** 把页面移到回收站；如果正在查看它（或它的子页面），跳到别的页面。 */
export async function trashAndLeave(id: string, currentId: string | null) {
  const before = getState().pages;
  const viewing = currentId !== null && (currentId === id || isDescendant(before, currentId, id));
  await trashPage(id);
  if (viewing) {
    const roots = buildTree(getState().pages).children.get("") ?? [];
    navigate(
      before[id]?.parentId && !getState().pages[before[id].parentId!]?.trashed
        ? before[id].parentId
        : (roots[0]?.id ?? null),
    );
  }
}

const FONTS: { font: PageFont; sample: string; label: string }[] = [
  { font: "sans", sample: "Ag", label: "默认" },
  { font: "serif", sample: "Ag", label: "衬线" },
  { font: "mono", sample: "Ag", label: "等宽" },
];

interface Props {
  page: PageMeta;
  anchor: HTMLElement;
  currentId: string | null;
  onClose: () => void;
  align?: "start" | "end";
  /** 顶栏菜单里额外提供的操作 */
  onExport?: () => void;
  exportLabel?: string;
  onExportHtml?: () => void;
  onPoster?: () => void;
  showLayout?: boolean;
  /** 打开页面历史（只有正文页面才有） */
  onHistory?: () => void;
  /** 当前页面正文字数 */
  wordCount?: number;
}

export function PageMenu({
  page,
  anchor,
  currentId,
  onClose,
  align,
  onExport,
  exportLabel,
  onExportHtml,
  onPoster,
  showLayout,
  onHistory,
  wordCount,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  if (renaming) {
    return (
      <Popover anchor={anchor} onClose={onClose} align={align}>
        <RenameForm page={page} onDone={onClose} />
      </Popover>
    );
  }

  return (
    <Popover anchor={anchor} onClose={onClose} align={align} className="menu page-menu-pop">
      {showLayout && page.kind === "page" && (
        <>
          <div className="font-switcher" role="group" aria-label="页面字体">
            {FONTS.map(({ font, sample, label }) => (
              <button
                key={font}
                type="button"
                className={cx("font-option", `font-${font}`, (page.font ?? "sans") === font && "active")}
                onClick={() => updatePage(page.id, { font })}
              >
                <span className="font-sample">{sample}</span>
                <span>{label}</span>
              </button>
            ))}
          </div>
          <MenuDivider />
        </>
      )}

      <MenuItem
        icon={page.favorite ? <StarOff size={16} /> : <Star size={16} />}
        label={page.favorite ? "取消收藏" : "添加到收藏"}
        onClick={run(() => updatePage(page.id, { favorite: !page.favorite }))}
      />
      {!showLayout && <MenuItem icon={<PencilLine size={16} />} label="重命名" onClick={() => setRenaming(true)} />}
      <MenuItem
        icon={<Copy size={16} />}
        label="创建副本"
        onClick={run(async () => {
          const id = await duplicatePage(page.id);
          if (id) navigate(id);
        })}
      />
      <MenuItem
        icon={<Columns2 size={16} />}
        label="在右侧分屏打开"
        onClick={run(() => openSplitPane(page.id))}
      />
      <MenuItem
        icon={<Link2 size={16} />}
        label="复制链接"
        onClick={run(() => {
          const url = `${window.location.origin}${window.location.pathname}#/${page.id}`;
          void navigator.clipboard?.writeText(url);
        })}
      />

      {showLayout && (
        <>
          <MenuDivider />
          {page.kind === "page" && (
            <MenuItem
              icon={<ALargeSmall size={16} />}
              label={page.smallText ? "恢复默认字号" : "小字号"}
              onClick={() => updatePage(page.id, { smallText: !page.smallText })}
            />
          )}
          <MenuItem
            icon={<UnfoldHorizontal size={16} />}
            label={page.fullWidth ? "恢复默认宽度" : "全宽显示"}
            onClick={() => updatePage(page.id, { fullWidth: !page.fullWidth })}
          />
          <MenuItem
            icon={page.locked ? <LockOpen size={16} /> : <Lock size={16} />}
            label={page.locked ? "解锁页面" : "锁定页面"}
            hint={page.locked ? "当前只读" : undefined}
            onClick={run(() => updatePage(page.id, { locked: !page.locked }))}
          />
        </>
      )}

      <MenuDivider />
      <MenuItem
        icon={<LayoutTemplate size={16} />}
        label={page.template ? "取消模板" : "设为模板"}
        hint={page.template ? undefined : "可在新页面套用"}
        onClick={run(() => updatePage(page.id, { template: !page.template }))}
      />
      {onHistory && <MenuItem icon={<History size={16} />} label="页面历史" onClick={run(onHistory)} />}
      {onPoster && <MenuItem icon={<Share2 size={16} />} label="生成分享海报 / 打印 PDF" onClick={run(onPoster)} />}
      {onExport && <MenuItem icon={<Download size={16} />} label={exportLabel ?? "导出为 Markdown"} onClick={run(onExport)} />}
      {onExportHtml && <MenuItem icon={<FileCode2 size={16} />} label="导出为 HTML" onClick={run(onExportHtml)} />}
      <MenuDivider />
      <MenuItem
        icon={<Trash2 size={16} />}
        label="移到回收站"
        danger
        onClick={run(() => void trashAndLeave(page.id, currentId))}
      />
      <div className="menu-footnote">
        <Clock size={12} />
        <span>
          {typeof wordCount === "number" ? `约 ${wordCount} 字 · ` : ""}
          最后编辑于 {new Date(page.updatedAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })}
        </span>
      </div>
    </Popover>
  );
}

function RenameForm({ page, onDone }: { page: PageMeta; onDone: () => void }) {
  const [value, setValue] = useState(page.title);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <form
      className="rename-form"
      onSubmit={(e) => {
        e.preventDefault();
        onDone();
      }}
    >
      <span className="rename-icon">{page.icon ?? <FileText size={16} />}</span>
      <input
        ref={ref}
        value={value}
        placeholder="无标题"
        aria-label="页面标题"
        onChange={(e) => {
          setValue(e.target.value);
          updatePage(page.id, { title: e.target.value });
        }}
      />
    </form>
  );
}
