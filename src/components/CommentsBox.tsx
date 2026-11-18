import { useEffect, useState } from "react";
import { Check, MessageSquare, Send, Trash2, X } from "lucide-react";
import type { PageMeta } from "../../shared/types";
import { shortId } from "../db";
import { updatePage } from "../store";
import { cx } from "./Popover";

export function CommentsBox({
  page,
  openComposer,
  pendingQuote,
  onClearQuote,
  onCloseComposer,
}: {
  page: PageMeta;
  openComposer?: boolean;
  pendingQuote?: string | null;
  onClearQuote?: () => void;
  onCloseComposer?: () => void;
}) {
  const comments = page.comments ?? [];
  const [text, setText] = useState("");
  const [composing, setComposing] = useState(Boolean(openComposer || pendingQuote));
  const editable = !page.trashed && !page.locked;

  useEffect(() => {
    if (openComposer || pendingQuote) setComposing(true);
  }, [openComposer, pendingQuote]);

  const closeComposer = () => {
    setComposing(false);
    onClearQuote?.();
    onCloseComposer?.();
  };

  if (comments.length === 0 && !composing) return null;

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    updatePage(page.id, {
      comments: [
        ...comments,
        {
          id: shortId(),
          author: "我",
          text: trimmed,
          ...(pendingQuote ? { quote: pendingQuote.slice(0, 300) } : {}),
          createdAt: Date.now(),
        },
      ],
    });
    setText("");
    closeComposer();
  };

  return (
    <section className="page-comments" aria-label="页面批注" data-comments-state={composing ? "composing" : "idle"}>
      {comments.map((c) => (
        <div key={c.id} className={cx("comment-row", c.resolved && "resolved")}>
          <span className="comment-avatar">{c.author.slice(0, 1)}</span>
          <div className="comment-body">
            <div className="comment-meta">
              <strong>{c.author}</strong>
              <span>
                {new Date(c.createdAt).toLocaleString("zh-CN", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              {c.resolved && <span className="comment-resolved-tag">已解决</span>}
            </div>
            {c.quote && <blockquote className="comment-quote">“{c.quote}”</blockquote>}
            <div className="comment-text">{c.text}</div>
          </div>
          {editable && (
            <div className="comment-actions">
              <button
                type="button"
                className="icon-btn small"
                title={c.resolved ? "重新打开批注" : "标记为已解决"}
                aria-label={c.resolved ? "重新打开批注" : "标记为已解决"}
                onClick={() =>
                  updatePage(page.id, {
                    comments: comments.map((x) => (x.id === c.id ? { ...x, resolved: !x.resolved } : x)),
                  })
                }
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                className="icon-btn small comment-del"
                title="删除批注"
                aria-label="删除批注"
                onClick={() => updatePage(page.id, { comments: comments.filter((x) => x.id !== c.id) })}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )}
        </div>
      ))}
      {editable && composing ? (
        <div className="comment-composer-wrap">
          {pendingQuote && (
            <div className="comment-pending-quote">
              <span>划词引用：“{pendingQuote.slice(0, 120)}”</span>
              <button type="button" className="icon-btn small" onClick={() => onClearQuote?.()} aria-label="移除引用">
                <X size={12} />
              </button>
            </div>
          )}
          <form
            className="comment-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <MessageSquare size={14} />
            <input
              autoFocus
              value={text}
              placeholder={pendingQuote ? "针对所选文字输入批注…（回车发送）" : "添加批注或讨论记录…（回车发送）"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (!e.nativeEvent.isComposing && e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeComposer();
                }
              }}
            />
            <button type="submit" className="primary-btn small" disabled={!text.trim()}>
              <Send size={13} /> 发送
            </button>
          </form>
        </div>
      ) : (
        editable &&
        comments.length > 0 && (
          <button type="button" className="text-btn small comment-more" onClick={() => setComposing(true)}>
            <MessageSquare size={13} /> 继续添加批注
          </button>
        )
      )}
    </section>
  );
}
