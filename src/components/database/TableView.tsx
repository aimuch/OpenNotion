import { Fragment, useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CornerDownRight,
  FileText,
  GripVertical,
  PanelRightOpen,
  Plus,
  Trash2,
} from "lucide-react";
import type { CalcFn, DatabaseDef, PageMeta, PropertyDef, PropType, PropValue, ViewDef } from "../../../shared/types";
import {
  PROP_TYPES,
  SUB_PARENT_KEY,
  addProperty,
  buildSubItemTree,
  calcOptionsFor,
  calculateColumn,
  changePropertyType,
  groupRowsByProp,
  removeProperty,
  updateProperty,
  visibleProperties,
} from "../../db";
import { endDragSession, getDraggedRowForDb, startDbRowDrag } from "../../machines";
import { movePage, navigate, setPeekRowId, trashPage, updatePage } from "../../store";
import { MenuDivider, MenuItem, Popover, cx } from "../Popover";
import { PropIcon, PropertyCell, PropertyConfig, Tag } from "./cells";

interface Props {
  page: PageMeta;
  db: DatabaseDef;
  view: ViewDef;
  rows: PageMeta[];
  /** 所有行（不受筛选影响），修改属性类型和手动排序时要用 */
  allRows: PageMeta[];
  focusRowId: string | null;
  onEditDone: () => void;
  onPatchView: (patch: Partial<ViewDef>) => void;
  onAddRow: (props?: Record<string, PropValue>) => void;
}

const MIN_WIDTH = 80;

export function TableView({ page, db, view, rows, allRows, focusRowId, onEditDone, onPatchView, onAddRow }: Props) {
  const [menu, setMenu] = useState<{ anchor: HTMLElement; propId: string } | null>(null);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [live, setLive] = useState<Record<string, number>>({});
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const [collapsedSubs, setCollapsedSubs] = useState<Set<string>>(() => new Set());
  const shownProps = visibleProperties(db, view);
  const menuDef = menu ? db.properties.find((p) => p.id === menu.propId) : undefined;
  const collapsedGroups = new Set(view.collapsedGroups ?? []);

  const track = (key: string, fallback: string) => {
    const w = live[key] ?? view.widths?.[key];
    return w ? `${w}px` : fallback;
  };
  const columns = [
    track("title", "var(--db-title-col, minmax(260px, 2fr))"),
    ...shownProps.map((p) => track(p.id, "minmax(150px, 1fr)")),
    "44px",
  ].join(" ");

  const startResize = (key: string) => (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startWidth = (handle.parentElement as HTMLElement).getBoundingClientRect().width;
    let width = Math.round(startWidth);
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const onMove = (ev: PointerEvent) => {
      width = Math.max(MIN_WIDTH, Math.round(startWidth + ev.clientX - startX));
      setLive((prev) => ({ ...prev, [key]: width }));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing");
      onPatchView({ widths: { ...view.widths, [key]: width } });
      setLive((prev) => {
        const { [key]: _done, ...rest } = prev;
        return rest;
      });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  const canReorder = !view.sort && !view.groupBy;

  const onRowDragOver = (row: PageMeta) => (e: DragEvent<HTMLDivElement>) => {
    const draggingRow = getDraggedRowForDb(page.id);
    if (!canReorder || !draggingRow || draggingRow === row.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    if (dropAt?.id !== row.id || dropAt.after !== after) setDropAt({ id: row.id, after });
  };

  const onRowDrop = (row: PageMeta) => (e: DragEvent<HTMLDivElement>) => {
    const target = dropAt;
    setDropAt(null);
    const id = getDraggedRowForDb(page.id);
    if (!canReorder || !id || !target || id === row.id) return;
    e.preventDefault();
    endDragSession();
    const others = allRows.filter((r) => r.id !== id);
    const at = others.findIndex((r) => r.id === row.id);
    void movePage(id, page.id, target.after ? at + 1 : at);
  };

  const toggleMenu = (propId: string, anchor: HTMLElement) =>
    setMenu(menu?.propId === propId ? null : { anchor, propId });

  const setCalc = (key: string, fn: CalcFn) => {
    onPatchView({ calculations: { ...(view.calculations ?? {}), [key]: fn } });
  };

  const toggleGroupCollapse = (groupKey: string) => {
    const next = collapsedGroups.has(groupKey)
      ? (view.collapsedGroups ?? []).filter((k) => k !== groupKey)
      : [...(view.collapsedGroups ?? []), groupKey];
    onPatchView({ collapsedGroups: next });
  };

  const toggleSubCollapse = (rowId: string) => {
    setCollapsedSubs((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const groups = groupRowsByProp(rows, db, view.groupBy);

  const renderRowList = (list: PageMeta[]) => {
    const items = db.subItemsEnabled
      ? buildSubItemTree(list, collapsedSubs)
      : list.map((row) => ({ row, depth: 0, childCount: 0 }));

    return items.map(({ row, depth, childCount }) => (
      <div
        key={row.id}
        className={cx("db-row", dropAt?.id === row.id && (dropAt.after ? "drop-after" : "drop-before"))}
        role="row"
        onDragOver={onRowDragOver(row)}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
        }}
        onDrop={onRowDrop(row)}
      >
        <TitleCell
          dbId={page.id}
          row={row}
          depth={depth}
          childCount={childCount}
          subCollapsed={collapsedSubs.has(row.id)}
          subItemsEnabled={Boolean(db.subItemsEnabled)}
          onToggleSub={() => toggleSubCollapse(row.id)}
          onAddSubItem={() => {
            setCollapsedSubs((prev) => {
              const next = new Set(prev);
              next.delete(row.id);
              return next;
            });
            onAddRow({ [SUB_PARENT_KEY]: row.id });
          }}
          autoFocus={row.id === focusRowId}
          canReorder={canReorder}
          onEditDone={row.id === focusRowId ? onEditDone : undefined}
        />
        {shownProps.map((def) => (
          <div key={def.id} className="db-td" role="cell">
            <PropertyCell row={row} def={def} dbPage={page} />
          </div>
        ))}
        <div className="db-td db-td-tail">
          <button
            type="button"
            className="icon-btn small"
            title="移到回收站"
            aria-label={`把“${row.title || "无标题"}”移到回收站`}
            onClick={() => void trashPage(row.id)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    ));
  };

  return (
    <div className="db-table-scroll">
      <div className="db-table" role="table" style={{ gridTemplateColumns: columns }}>
        <div className="db-row db-head" role="row">
          <div className="db-th" role="columnheader">
            <PropIcon type="title" />
            <span className="db-th-name">名称</span>
            <SortMark view={view} propId="title" />
            <span className="db-resize" onPointerDown={startResize("title")} />
          </div>
          {shownProps.map((def) => (
            <div
              key={def.id}
              role="columnheader"
              tabIndex={0}
              className={cx("db-th db-th-button", menu?.propId === def.id && "open")}
              onClick={(e) => toggleMenu(def.id, e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                toggleMenu(def.id, e.currentTarget);
              }}
            >
              <PropIcon type={def.type} />
              <span className="db-th-name">{def.name}</span>
              <SortMark view={view} propId={def.id} />
              <span
                className="db-resize"
                onPointerDown={startResize(def.id)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          ))}
          <button
            type="button"
            className="db-th db-th-add"
            title="添加属性"
            aria-label="添加属性"
            onClick={(e) => setAddAnchor(addAnchor ? null : e.currentTarget)}
          >
            <Plus size={15} />
          </button>
        </div>

        {groups
          ? groups.map((g) => {
              const isCollapsed = collapsedGroups.has(g.key);
              return (
                <Fragment key={g.key}>
                  <div className="db-group-bar">
                    <button
                      type="button"
                      className="db-group-toggle"
                      onClick={() => toggleGroupCollapse(g.key)}
                    >
                      <ChevronRight size={14} className={cx("db-group-chevron", !isCollapsed && "open")} />
                      {g.option ? <Tag option={g.option} /> : <span className="db-group-name">{g.label}</span>}
                      <span className="board-count">{g.rows.length}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn small"
                      title={`在“${g.label}”下新建`}
                      onClick={() => onAddRow(g.defaultProps)}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  {!isCollapsed && renderRowList(g.rows)}
                </Fragment>
              );
            })
          : renderRowList(rows)}

        <div className="db-row db-calc-row" role="row">
          <CalcCell
            colKey="title"
            def={null}
            rows={rows}
            fn={view.calculations?.title ?? "count"}
            onChange={(fn) => setCalc("title", fn)}
          />
          {shownProps.map((def) => (
            <CalcCell
              key={def.id}
              colKey={def.id}
              def={def}
              rows={rows}
              fn={view.calculations?.[def.id] ?? "none"}
              onChange={(fn) => setCalc(def.id, fn)}
            />
          ))}
          <div className="db-calc-cell" />
        </div>
      </div>

      <button type="button" className="db-add-row" onClick={() => onAddRow()}>
        <Plus size={15} /> 新建
      </button>

      {menu && menuDef && (
        <PropertyMenu
          anchor={menu.anchor}
          page={page}
          def={menuDef}
          view={view}
          allRows={allRows}
          onPatchView={onPatchView}
          onClose={() => setMenu(null)}
        />
      )}
      {addAnchor && (
        <Popover anchor={addAnchor} onClose={() => setAddAnchor(null)} align="end" className="menu">
          <div className="menu-title">属性类型</div>
          {PROP_TYPES.map((t) => (
            <MenuItem
              key={t.type}
              icon={<PropIcon type={t.type} size={16} />}
              label={t.label}
              onClick={() => {
                addProperty(page, t.type);
                setAddAnchor(null);
              }}
            />
          ))}
        </Popover>
      )}
    </div>
  );
}

function CalcCell({
  colKey,
  def,
  rows,
  fn,
  onChange,
}: {
  colKey: string;
  def: PropertyDef | null;
  rows: PageMeta[];
  fn: CalcFn;
  onChange: (fn: CalcFn) => void;
}) {
  if (def?.type === "button") return <div className="db-calc-cell" />;
  const options = calcOptionsFor(def);
  const result = calculateColumn(rows, def, fn);
  return (
    <label className={cx("db-calc-cell", result && "active")} aria-label={`${def?.name ?? "名称"}列汇总`}>
      <span className="db-calc-display">
        {result ? (
          <>
            <span className="db-calc-label">{result.label}</span>
            <strong>{result.value}</strong>
          </>
        ) : (
          <span className="db-calc-placeholder">计算</span>
        )}
      </span>
      <select key={colKey} value={fn} onChange={(e) => onChange(e.target.value as CalcFn)}>
        {options.map((o) => (
          <option key={o.fn} value={o.fn}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SortMark({ view, propId }: { view: ViewDef; propId: string }) {
  if (view.sort?.propId !== propId) return null;
  return view.sort.dir === "asc" ? <ArrowUp size={13} className="db-sort-mark" /> : <ArrowDown size={13} className="db-sort-mark" />;
}

function TitleCell({
  dbId,
  row,
  depth,
  childCount,
  subCollapsed,
  subItemsEnabled,
  onToggleSub,
  onAddSubItem,
  autoFocus,
  canReorder,
  onEditDone,
}: {
  dbId: string;
  row: PageMeta;
  depth: number;
  childCount: number;
  subCollapsed: boolean;
  subItemsEnabled: boolean;
  onToggleSub: () => void;
  onAddSubItem: () => void;
  autoFocus: boolean;
  canReorder: boolean;
  onEditDone?: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <div className="db-td db-td-title" role="cell" style={depth > 0 ? { paddingLeft: 6 + depth * 20 } : undefined}>
      {canReorder && (
        <span
          className="db-grip"
          draggable
          title="拖动调整顺序"
          aria-label="拖动调整顺序"
          onDragStart={(e) => {
            startDbRowDrag(dbId, row.id);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("application/x-opennotion-row", row.id);
            const rowEl = e.currentTarget.closest(".db-row");
            if (rowEl) e.dataTransfer.setDragImage(rowEl, 12, 16);
          }}
          onDragEnd={() => {
            endDragSession();
          }}
        >
          <GripVertical size={14} />
        </span>
      )}
      {subItemsEnabled && (
        <button
          type="button"
          className={cx("tree-toggle", !subCollapsed && childCount > 0 && "open", childCount === 0 && "hidden")}
          disabled={childCount === 0}
          aria-label={subCollapsed ? "展开子任务" : "收起子任务"}
          onClick={onToggleSub}
        >
          <ChevronRight size={13} />
        </button>
      )}
      <span className="tree-icon">{row.icon ?? <FileText size={15} />}</span>
      <input
        ref={ref}
        className="cell-input cell-title"
        value={row.title}
        placeholder="无标题"
        aria-label="名称"
        onChange={(e) => updatePage(row.id, { title: e.target.value })}
        onBlur={() => onEditDone?.()}
        onKeyDown={(e) => {
          if (!e.nativeEvent.isComposing && e.key === "Enter") e.currentTarget.blur();
          if (!e.nativeEvent.isComposing && e.key === "Escape") {
            e.stopPropagation();
            e.currentTarget.blur();
          }
        }}
      />
      {subItemsEnabled && (
        <button
          type="button"
          className="db-open db-add-sub"
          title="在此行下新建子项"
          onClick={onAddSubItem}
        >
          <CornerDownRight size={11} /> 子项
        </button>
      )}
      <button
        type="button"
        className="db-open"
        title="在侧边抽屉打开（按住 ⌘/Ctrl 点击整页打开）"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) navigate(row.id);
          else setPeekRowId(row.id);
        }}
      >
        <PanelRightOpen size={12} /> 打开
      </button>
    </div>
  );
}

interface PropertyMenuProps {
  anchor: HTMLElement;
  page: PageMeta;
  def: PropertyDef;
  view: ViewDef;
  allRows: PageMeta[];
  onPatchView: (patch: Partial<ViewDef>) => void;
  onClose: () => void;
}

function PropertyMenu({ anchor, page, def, view, allRows, onPatchView, onClose }: PropertyMenuProps) {
  const [picking, setPicking] = useState(false);
  const sortBy = (dir: "asc" | "desc") => {
    const same = view.sort?.propId === def.id && view.sort.dir === dir;
    onPatchView({ sort: same ? null : { propId: def.id, dir } });
    onClose();
  };
  const setType = (type: PropType) => {
    changePropertyType(page, allRows, def.id, type);
    setPicking(false);
  };
  const typeLabel = PROP_TYPES.find((t) => t.type === def.type)?.label ?? def.type;

  return (
    <Popover anchor={anchor} onClose={onClose} className="menu prop-menu">
      <input
        className="menu-input"
        autoFocus
        onFocus={(e) => e.target.select()}
        value={def.name}
        aria-label="属性名称"
        onChange={(e) => updateProperty(page, def.id, { name: e.target.value })}
        onKeyDown={(e) => {
          if (!e.nativeEvent.isComposing && e.key === "Enter") onClose();
        }}
      />
      {picking ? (
        <>
          <div className="menu-title">选择类型</div>
          {PROP_TYPES.map((t) => (
            <MenuItem
              key={t.type}
              icon={<PropIcon type={t.type} size={16} />}
              label={t.label}
              hint={def.type === t.type ? "当前" : undefined}
              onClick={() => setType(t.type)}
            />
          ))}
        </>
      ) : (
        <>
          <MenuItem
            icon={<PropIcon type={def.type} size={16} />}
            label={`类型：${typeLabel}`}
            hint="更改"
            onClick={() => setPicking(true)}
          />
          <PropertyConfig dbPage={page} def={def} allRows={allRows} />
          <MenuDivider />
          <MenuItem
            icon={view.sort?.propId === def.id && view.sort.dir === "asc" ? <Check size={16} /> : <ArrowUp size={16} />}
            label="升序排列"
            onClick={() => sortBy("asc")}
          />
          <MenuItem
            icon={view.sort?.propId === def.id && view.sort.dir === "desc" ? <Check size={16} /> : <ArrowDown size={16} />}
            label="降序排列"
            onClick={() => sortBy("desc")}
          />
          <MenuDivider />
          <ConfirmDeletePropItem name={def.name} onConfirm={() => { onClose(); removeProperty(page, def.id); }} />
        </>
      )}
    </Popover>
  );
}

function ConfirmDeletePropItem({ name, onConfirm }: { name: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <MenuItem
      icon={<Trash2 size={16} />}
      label={armed ? `再次点击确认删除“${name}”` : "删除属性"}
      danger
      onClick={() => {
        if (!armed) setArmed(true);
        else onConfirm();
      }}
    />
  );
}
