import { Fragment, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { Columns2, Columns3, Equal, Plus, Trash2 } from "lucide-react";
import type { PageRecord } from "../../shared/types";
import { shortId } from "../db";
import { Island } from "./Island";
import { getNestedEditor } from "./SyncedBlock";

export interface ColumnDef {
  id: string;
  width: number;
  content: unknown[];
}

export function defaultColumns(count: 2 | 3): string {
  const w = Number((100 / count).toFixed(2));
  const cols: ColumnDef[] = Array.from({ length: count }, () => ({
    id: shortId(),
    width: w,
    content: [],
  }));
  return JSON.stringify(cols);
}

function parseCols(json: string): ColumnDef[] {
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr) && arr.length >= 2) {
      return arr.map((c: Partial<ColumnDef>) => ({
        id: typeof c.id === "string" && c.id ? c.id : shortId(),
        width: typeof c.width === "number" && c.width > 5 ? c.width : 50,
        content: Array.isArray(c.content) ? c.content : [],
      }));
    }
  } catch {
    /* 回退默认两栏 */
  }
  return JSON.parse(defaultColumns(2)) as ColumnDef[];
}

const colsStore = new Map<string, string>();
const colsListeners = new Map<string, Set<() => void>>();

function publishCols(key: string, json: string) {
  if (colsStore.get(key) === json) return;
  if (colsStore.size > 200) {
    const oldest = colsStore.keys().next().value;
    if (oldest && !colsListeners.has(oldest)) colsStore.delete(oldest);
  }
  colsStore.set(key, json);
  colsListeners.get(key)?.forEach((cb) => cb());
}

function useColsJson(key: string, initial: string): string {
  if (!colsStore.has(key)) colsStore.set(key, initial || defaultColumns(2));
  return useSyncExternalStore(
    (cb) => {
      let set = colsListeners.get(key);
      if (!set) {
        set = new Set();
        colsListeners.set(key, set);
      }
      set.add(cb);
      return () => {
        set?.delete(cb);
        if (set && set.size === 0) {
          colsListeners.delete(key);
          colsStore.delete(key);
        }
      };
    },
    () => colsStore.get(key) ?? initial,
    () => colsStore.get(key) ?? initial,
  );
}

function ColumnsIsland({
  blockId,
  initialJson,
  editable,
  onSave,
}: {
  blockId: string;
  initialJson: string;
  editable: boolean;
  onSave: (json: string) => void;
}) {
  const json = useColsJson(blockId, initialJson);
  const cols = useMemo(() => parseCols(json), [json]);
  const [liveWidths, setLiveWidths] = useState<number[] | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const NestedEditor = getNestedEditor();

  const commitCols = (next: ColumnDef[]) => {
    const serialized = JSON.stringify(next);
    publishCols(blockId, serialized);
    onSave(serialized);
  };

  const updateColContent = (colId: string, content: unknown[]) => {
    const current = parseCols(colsStore.get(blockId) ?? json);
    commitCols(current.map((c) => (c.id === colId ? { ...c, content } : c)));
  };

  const addColumn = () => {
    if (cols.length >= 4) return;
    const nextCount = cols.length + 1;
    const even = Number((100 / nextCount).toFixed(2));
    commitCols([...cols.map((c) => ({ ...c, width: even })), { id: shortId(), width: even, content: [] }]);
  };

  const removeLastColumn = () => {
    if (cols.length <= 2) return;
    const trimmed = cols.slice(0, -1);
    const even = Number((100 / trimmed.length).toFixed(2));
    commitCols(trimmed.map((c) => ({ ...c, width: even })));
  };

  const equalizeWidths = () => {
    const even = Number((100 / cols.length).toFixed(2));
    commitCols(cols.map((c) => ({ ...c, width: even })));
  };

  const startResize = (idx: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!editable) return;
    e.preventDefault();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const totalPx = wrap.getBoundingClientRect().width || 600;
    const startX = e.clientX;
    const base = cols.map((c) => c.width);
    let current = [...base];
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");

    const onMove = (ev: PointerEvent) => {
      const deltaPct = ((ev.clientX - startX) / totalPx) * 100;
      const sumPair = base[idx] + base[idx + 1];
      const left = Math.max(18, Math.min(sumPair - 18, base[idx] + deltaPct));
      const right = sumPair - left;
      current = base.map((w, i) => (i === idx ? Number(left.toFixed(2)) : i === idx + 1 ? Number(right.toFixed(2)) : w));
      setLiveWidths(current);
    };

    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing");
      setLiveWidths(null);
      commitCols(cols.map((c, i) => ({ ...c, width: current[i] })));
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  const widths = liveWidths ?? cols.map((c) => c.width);

  return (
    <div className="columns-block" data-column-count={cols.length}>
      {editable && (
        <div className="columns-toolbar">
          <span className="columns-badge">
            {cols.length === 2 ? <Columns2 size={12} /> : <Columns3 size={12} />} {cols.length} 栏并排
          </span>
          <button type="button" className="text-btn small" onClick={equalizeWidths} title="等分各栏宽度">
            <Equal size={12} /> 等宽
          </button>
          {cols.length < 4 && (
            <button type="button" className="text-btn small" onClick={addColumn}>
              <Plus size={12} /> 加一栏
            </button>
          )}
          {cols.length > 2 && (
            <button type="button" className="text-btn small danger" onClick={removeLastColumn}>
              <Trash2 size={12} /> 减一栏
            </button>
          )}
        </div>
      )}

      <div ref={wrapRef} className="columns-grid">
        {cols.map((col, idx) => (
          <Fragment key={col.id}>
            <div className="column-pane" style={{ flex: `${widths[idx]} 1 0%` }}>
              {NestedEditor ? (
                <ColumnEditorPane
                  col={col}
                  editable={editable}
                  NestedEditor={NestedEditor}
                  onContentChange={(blocks) => updateColContent(col.id, blocks)}
                />
              ) : null}
            </div>
            {idx < cols.length - 1 && (
              <div
                className="column-resizer"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={startResize(idx)}
              />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function ColumnEditorPane({
  col,
  editable,
  NestedEditor,
  onContentChange,
}: {
  col: ColumnDef;
  editable: boolean;
  NestedEditor: NonNullable<ReturnType<typeof getNestedEditor>>;
  onContentChange: (blocks: unknown[]) => void;
}) {
  // 构造虚拟 PageRecord 供分栏内嵌编辑器初始化，并通过 onContentSync 将修改写回外层分栏块（无需创建隐藏页面）
  const virtualRecord = useMemo<PageRecord>(
    () => ({
      id: `__col_${col.id}`,
      title: "",
      icon: null,
      cover: null,
      parentId: null,
      order: 0,
      favorite: false,
      fullWidth: false,
      smallText: false,
      font: "sans",
      locked: false,
      comments: [],
      trashed: false,
      trashedAt: null,
      createdAt: 0,
      updatedAt: 0,
      kind: "page",
      database: null,
      props: {},
      template: false,
      hidden: true,
      content: col.content,
    }),
    // 仅在分栏首次挂载时初始化编辑器内容，避免输入时光标重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [col.id],
  );

  return (
    <NestedEditor
      page={virtualRecord}
      editable={editable}
      onReady={() => {}}
      nested
      onContentSync={onContentChange}
    />
  );
}

/** 多列并排分栏布局块（2 列 / 3 列 / 4 列自由拖拽调宽） */
export const createColumnsBlock = createReactBlockSpec(
  {
    type: "columns",
    propSchema: {
      colsJson: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const json = block.props.colsJson || defaultColumns(2);
      return (
        <Island
          id={`cols:${block.id}`}
          className="columns-host"
          interactive={editor.isEditable}
          render={() => (
            <ColumnsIsland
              blockId={block.id}
              initialJson={json}
              editable={editor.isEditable}
              onSave={(colsJson) => editor.updateBlock(block, { props: { colsJson } })}
            />
          )}
        />
      );
    },
    toExternalHTML: ({ block }) => {
      const cols = parseCols(block.props.colsJson);
      return <div data-columns={cols.length}>（{cols.length} 栏并排内容）</div>;
    },
  },
);
