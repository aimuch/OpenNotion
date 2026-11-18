import { useCallback, useEffect } from "react";
import { History, RotateCcw, X } from "lucide-react";
import type { PageMeta } from "../../shared/types";
import { transitionHistory, useMachine } from "../machines";
import { fetchHistory, fetchVersion, restoreVersion } from "../store";
import { Editor } from "./Editor";
import { cx } from "./Popover";

const formatTime = (ts: number) =>
  new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 页面历史：左边预览选中的版本（只读），右边是版本列表。 */
export function HistoryModal({ page, onClose }: { page: PageMeta; onClose: () => void }) {
  const [state, send] = useMachine(transitionHistory, { status: "loading" });
  const noop = useCallback(() => {}, []);

  useEffect(() => {
    let alive = true;
    fetchHistory(page.id).then(
      (list) => alive && send({ type: "LIST_LOADED", versions: list }),
      (err: Error) => alive && send({ type: "LIST_FAILED", message: err.message }),
    );
    return () => {
      alive = false;
    };
  }, [page.id, send]);

  const selectedTs = state.status === "loaded" ? state.selectedTs : null;

  useEffect(() => {
    if (selectedTs === null) return;
    let alive = true;
    fetchVersion(page.id, selectedTs).then(
      (r) => alive && send({ type: "VERSION_LOADED", ts: selectedTs, record: r }),
      (err: Error) => alive && send({ type: "VERSION_FAILED", ts: selectedTs, message: err.message }),
    );
    return () => {
      alive = false;
    };
  }, [page.id, selectedTs, send]);

  const restoring = state.status === "loaded" && state.preview.status === "restoring";

  useEffect(() => {
    if (!restoring) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 正在恢复版本时拦截全局 Esc，避免半途卸载
        e.stopPropagation();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [restoring]);

  const restore = async () => {
    if (state.status !== "loaded" || state.preview.status !== "ready") return;
    send({ type: "RESTORE_START" });
    if (await restoreVersion(page.id, state.selectedTs)) {
      onClose();
    } else {
      send({ type: "RESTORE_FAILED", message: "恢复历史版本失败，请稍后重试。" });
    }
  };

  const previewRecord =
    state.status === "loaded" && (state.preview.status === "ready" || state.preview.status === "restoring")
      ? state.preview.record
      : null;
  const errorMessage =
    state.status === "error"
      ? state.message
      : state.status === "loaded" && state.preview.status === "error"
        ? state.preview.message
        : null;

  return (
    <div
      className="modal-backdrop"
      data-local-modal="history"
      onMouseDown={(e) => e.target === e.currentTarget && !restoring && onClose()}
    >
      <div
        className="history-modal"
        role="dialog"
        aria-modal="true"
        aria-label="页面历史"
        data-history-state={state.status}
      >
        <div className="history-preview">
          {previewRecord && selectedTs !== null ? (
            <>
              <div className="history-title">{previewRecord.title || "无标题"}</div>
              <Editor key={selectedTs} page={previewRecord} editable={false} onReady={noop} nested />
            </>
          ) : (
            <div className="history-empty">
              {errorMessage ?? (state.status === "empty" ? "这个页面还没有历史版本。" : "正在加载…")}
              {state.status === "empty" && (
                <p>编辑页面时，大约每 10 分钟会自动保存一个版本，最多保留 40 个。</p>
              )}
            </div>
          )}
        </div>
        <aside className="history-side">
          <div className="history-side-head">
            <History size={15} /> 页面历史
            <button type="button" className="icon-btn small" aria-label="关闭" disabled={restoring} onClick={onClose}>
              <X size={15} />
            </button>
          </div>
          <div className="history-list">
            {state.status === "loaded" &&
              state.versions.map((v) => (
                <button
                  key={v.ts}
                  type="button"
                  disabled={restoring}
                  className={cx("history-item", v.ts === state.selectedTs && "active")}
                  onClick={() => send({ type: "SELECT_VERSION", ts: v.ts })}
                >
                  <span>{formatTime(v.ts)}</span>
                  <span className="history-meta">{v.chars} 字</span>
                </button>
              ))}
          </div>
          <div className="history-actions">
            <button
              type="button"
              className="primary-btn"
              disabled={state.status !== "loaded" || state.preview.status !== "ready"}
              onClick={() => void restore()}
            >
              <RotateCcw size={15} /> {restoring ? "恢复中…" : "恢复这个版本"}
            </button>
            <p>恢复前会先把现在的内容存成一个版本。</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
