import { useMemo, useSyncExternalStore } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { Link2, Maximize2, Table2, Trash2, Undo2 } from "lucide-react";
import type { ViewDef } from "../../../shared/types";
import { getState, navigate, restorePage, updatePage, useStore } from "../../store";
import { Island } from "../Island";
import { DatabaseView } from "./DatabaseView";

const linkedViewsCache = new Map<string, string>();
const linkedViewsSubs = new Map<string, Set<() => void>>();

function setLinkedViewsJson(key: string, json: string) {
  if (linkedViewsCache.get(key) === json) return;
  linkedViewsCache.set(key, json);
  linkedViewsSubs.get(key)?.forEach((cb) => cb());
}

function useLinkedViewsJson(key: string, initial: string): string {
  if (!linkedViewsCache.has(key)) linkedViewsCache.set(key, initial);
  return useSyncExternalStore(
    (cb) => {
      let set = linkedViewsSubs.get(key);
      if (!set) {
        set = new Set();
        linkedViewsSubs.set(key, set);
      }
      set.add(cb);
      return () => {
        set?.delete(cb);
        if (set && set.size === 0) {
          linkedViewsSubs.delete(key);
          linkedViewsCache.delete(key);
        }
      };
    },
    () => linkedViewsCache.get(key) ?? initial,
    () => linkedViewsCache.get(key) ?? initial,
  );
}

/** 内嵌在正文里的数据库本体。链接数据库独立保存自己的视图、筛选、排序与分组配置。 */
function DatabaseIsland({
  pageId,
  blockKey,
  linked,
  initialViewsJson,
  onSaveViewsJson,
}: {
  pageId: string;
  blockKey: string;
  linked: boolean;
  initialViewsJson: string;
  onSaveViewsJson?: (json: string) => void;
}) {
  const page = useStore((s) => s.pages[pageId]);
  const cacheKey = `${pageId}:${blockKey}`;
  const viewsJson = useLinkedViewsJson(cacheKey, initialViewsJson);

  const parsedOverride = useMemo<ViewDef[] | null>(() => {
    if (!linked || !viewsJson) return null;
    try {
      const v = JSON.parse(viewsJson);
      return Array.isArray(v) ? (v as ViewDef[]) : null;
    } catch {
      return null;
    }
  }, [linked, viewsJson]);

  if (!page || page.kind !== "database") {
    return (
      <div className="inline-db-missing">
        <Table2 size={16} /> 这个数据库已被永久删除，可以把这个块删掉。
      </div>
    );
  }

  if (page.trashed) {
    return (
      <div className="inline-db-missing">
        <Trash2 size={16} /> “{page.title || "无标题数据库"}”在回收站中。
        <button type="button" className="text-btn" onClick={() => void restorePage(pageId)}>
          <Undo2 size={14} /> 恢复
        </button>
      </div>
    );
  }

  return (
    <div className="inline-db">
      <div className="inline-db-head">
        <span className="tree-icon">{page.icon ?? <Table2 size={16} />}</span>
        <input
          className="inline-db-title"
          value={page.title}
          placeholder="无标题数据库"
          aria-label="数据库名称"
          onChange={(e) => updatePage(pageId, { title: e.target.value })}
          onKeyDown={(e) => {
            if (!e.nativeEvent.isComposing && e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {linked && (
          <span className="tree-badge" title="与原数据库共享行数据，但独立保存此处的视图、筛选和排序">
            <Link2 size={11} /> 链接视图
          </span>
        )}
        <button type="button" className="db-open" title="作为整页打开" onClick={() => navigate(pageId)}>
          <Maximize2 size={12} /> 打开
        </button>
      </div>
      <DatabaseView
        page={page}
        viewStorageKey={blockKey ? `view:${pageId}:${blockKey}` : `view:${pageId}`}
        viewsOverride={linked ? parsedOverride : null}
        onChangeViewsOverride={
          linked && onSaveViewsJson
            ? (nextViews) => {
                const serialized = JSON.stringify(nextViews);
                setLinkedViewsJson(cacheKey, serialized);
                onSaveViewsJson(serialized);
              }
            : undefined
        }
      />
    </div>
  );
}

export const createDatabaseBlock = createReactBlockSpec(
  {
    type: "database",
    propSchema: {
      pageId: { default: "" },
      blockKey: { default: "" },
      linked: { default: "false" },
      viewsJson: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const cacheKey = `${block.props.pageId}:${block.props.blockKey}`;
      if (block.props.viewsJson) setLinkedViewsJson(cacheKey, block.props.viewsJson);
      return (
        <Island
          id={cacheKey}
          className="inline-db-host"
          interactive={editor.isEditable}
          render={() => (
            <DatabaseIsland
              pageId={block.props.pageId}
              blockKey={block.props.blockKey}
              linked={block.props.linked === "true"}
              initialViewsJson={block.props.viewsJson}
              onSaveViewsJson={(viewsJson) => {
                editor.updateBlock(block, { props: { viewsJson } });
              }}
            />
          )}
        />
      );
    },
    toExternalHTML: ({ block }) => {
      const page = getState().pages[block.props.pageId];
      return (
        <p>
          <a href={`#/${block.props.pageId}`}>{page?.title || "无标题数据库"}</a>
        </p>
      );
    },
  },
);
