import { useCallback, useEffect, useId, useRef, useState, type ComponentType } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { RefreshCw } from "lucide-react";
import type { PageRecord } from "../../shared/types";
import { transitionSyncedBlock, useMachine } from "../machines";
import { fetchPage, getState, updatePage, useStore } from "../store";
import { Island } from "./Island";

interface SyncableEditorHandle {
  document: unknown[];
  replaceBlocks: (toRemove: unknown[], replacements: unknown[]) => void;
}

interface NestedEditorProps {
  page: PageRecord;
  editable: boolean;
  onReady: (editor: SyncableEditorHandle | null) => void;
  onContentSync?: (blocks: unknown[]) => void;
  nested?: boolean;
}

let NestedEditor: ComponentType<NestedEditorProps> | null = null;

export function registerNestedEditor(component: ComponentType<NestedEditorProps>) {
  NestedEditor = component;
}

export function getNestedEditor(): ComponentType<NestedEditorProps> | null {
  return NestedEditor;
}

/** 同一页面内多个相同同步块实例的实时广播总线 */
const syncPeers = new Map<string, Map<string, (blocks: unknown[]) => void>>();

function broadcastSynced(sourceId: string, fromInstance: string, blocks: unknown[]) {
  const peers = syncPeers.get(sourceId);
  if (!peers) return;
  for (const [id, apply] of peers) {
    if (id !== fromInstance) apply(blocks);
  }
}

/** 同步块的内容存成一个不显示在页面树里的内部页面，所有引用它的块编辑的是同一份。 */
function SyncedIsland({ sourceId }: { sourceId: string }) {
  const instanceId = useId();
  const source = useStore((s) => s.pages[sourceId]);
  const [syncState, sendSync] = useMachine(transitionSyncedBlock, { status: "loading", sourceId });
  const editorRef = useRef<SyncableEditorHandle | null>(null);
  const applyingRemote = useRef(false);

  const onReady = useCallback((ed: SyncableEditorHandle | null) => {
    editorRef.current = ed;
  }, []);

  useEffect(() => {
    let peers = syncPeers.get(sourceId);
    if (!peers) {
      peers = new Map();
      syncPeers.set(sourceId, peers);
    }
    peers.set(instanceId, (blocks) => {
      const ed = editorRef.current;
      if (!ed) return;
      applyingRemote.current = true;
      try {
        ed.replaceBlocks(ed.document, blocks);
      } finally {
        applyingRemote.current = false;
      }
    });
    return () => {
      peers?.delete(instanceId);
      if (peers && peers.size === 0) syncPeers.delete(sourceId);
    };
  }, [sourceId, instanceId]);

  useEffect(() => {
    let alive = true;
    sendSync({ type: "SWITCH_SOURCE", sourceId });
    fetchPage(sourceId).then(
      (r) => alive && sendSync({ type: "LOADED", sourceId, record: r }),
      () => alive && sendSync({ type: "FAILED", sourceId }),
    );
    return () => {
      alive = false;
    };
  }, [sourceId, sendSync]);

  const record = syncState.status === "ready" ? syncState.record : null;

  if (
    syncState.status === "missing" ||
    (!source && record === null && getState().loaded && !getState().pages[sourceId])
  ) {
    return (
      <div className="inline-db-missing" data-synced-state="missing">
        这个同步块的内容已被删除，可以把这个块删掉。
      </div>
    );
  }

  return (
    <div className="synced" data-synced-state={syncState.status}>
      <div className="synced-head">
        <RefreshCw size={13} />
        <input
          value={source?.title ?? ""}
          placeholder="给同步块起个名字"
          aria-label="同步块名称"
          onChange={(e) => updatePage(sourceId, { title: e.target.value })}
        />
        <span className="synced-hint">在别处输入 /同步 可插入同一个块</span>
      </div>
      {record && NestedEditor ? (
        <NestedEditor
          page={record}
          editable
          onReady={onReady}
          nested
          onContentSync={(blocks) => {
            if (!applyingRemote.current) broadcastSynced(sourceId, instanceId, blocks);
          }}
        />
      ) : (
        <div className="synced-loading">正在加载…</div>
      )}
    </div>
  );
}

function SyncedHost({ sourceId, interactive }: { sourceId: string; interactive: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [nestedInside, setNestedInside] = useState(false);

  // 同步块里再放同一个同步块会无限套娃，直接拒绝嵌套
  useEffect(() => {
    setNestedInside(!!ref.current?.parentElement?.closest(".synced"));
  }, []);

  return (
    <div ref={ref} className="synced-wrap">
      {nestedInside ? (
        <div className="inline-db-missing">同步块里不能再放同步块。</div>
      ) : (
        <Island
          id={sourceId}
          className="synced-host"
          interactive={interactive}
          render={() => <SyncedIsland sourceId={sourceId} />}
        />
      )}
    </div>
  );
}

export const createSyncedBlock = createReactBlockSpec(
  {
    type: "synced",
    propSchema: { sourceId: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => <SyncedHost sourceId={block.props.sourceId} interactive={editor.isEditable} />,
    toExternalHTML: ({ block }) => {
      const source = getState().pages[block.props.sourceId];
      return <p>（同步块：{source?.title || "未命名"}）</p>;
    },
  },
);
