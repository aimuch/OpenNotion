import { useEffect, useState } from "react";
import { BookmarkPlus, Check, Copy, Globe, LoaderCircle, Scissors, Sparkles, Tag, X } from "lucide-react";
import type { McpConfigPublic } from "../../shared/types";
import { INITIAL_CLIPPER_STATE, transitionClipper, useMachine } from "../machines";
import { clipWebUrl, fetchMcpConfig, navigate, reportError, setClipperOpen, useStore } from "../store";
import { cx } from "./Popover";

/**
 * 深度网页剪藏弹窗（由显式 ClipperModalState 状态机驱动）：
 * 1. 抓取中（clipping）锁定页签切换与背景误触关闭，确保异步落库原子完成
 * 2. 提供免装扩展的浏览器书签栏一键剪藏小工具（Bookmarklet）
 */
export function ClipperModal() {
  const pages = useStore((s) => s.pages);
  const [state, send] = useMachine(transitionClipper, INITIAL_CLIPPER_STATE);
  const [url, setUrl] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [parentId, setParentId] = useState<string>("");
  const [mcpCfg, setMcpCfg] = useState<McpConfigPublic | null>(null);
  const [copied, setCopied] = useState(false);

  const clipping = state.job.status === "clipping";
  const errorMsg = state.job.status === "error" ? state.job.message : null;

  const candidateParents = Object.values(pages).filter(
    (p) => !p.trashed && !p.hidden && p.kind === "page",
  );

  useEffect(() => {
    if (state.tab === "bookmarklet" && !mcpCfg) {
      void fetchMcpConfig()
        .then(setMcpCfg)
        .catch(() => {});
    }
  }, [state.tab, mcpCfg]);

  const handleClip = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = url.trim();
    if (!target || clipping) return;
    const normalizedUrl = /^https?:\/\//i.test(target) ? target : `https://${target}`;
    send({ type: "START_CLIP", url: normalizedUrl });
    try {
      const extraTags = tagsInput
        .split(/[,，\s]+/)
        .map((t) => t.trim().replace(/^#+/, ""))
        .filter(Boolean);
      const res = await clipWebUrl({
        url: normalizedUrl,
        tags: extraTags,
        parentId: parentId || null,
      });
      setClipperOpen(false);
      navigate(res.id);
    } catch (err) {
      send({ type: "CLIP_FAILED", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const origin = window.location.origin;
  const token = mcpCfg?.token ?? "";
  const bookmarkletHref = `javascript:(function(){var s=window.getSelection();var h='';if(s&&s.rangeCount>0&&!s.isCollapsed){var d=document.createElement('div');for(var i=0;i<s.rangeCount;i++)d.appendChild(s.getRangeAt(i).cloneContents());h=d.innerHTML;}else{var a=document.querySelector('article,main,#js_content,.Post-RichText,.markdown-body')||document.body;h=a.innerHTML;}fetch('${origin}/api/clip',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer ${token}'},body:JSON.stringify({url:location.href,title:document.title,html:h})}).then(function(r){return r.json()}).then(function(d){if(d.id){alert('已成功剪藏到 OpenNotion：《'+d.title+'》');}else{alert('剪藏失败：'+(d.error||'未知错误'));}}).catch(function(){alert('无法连接本机 OpenNotion 服务（请确认应用已打开）');});})();`;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !clipping) setClipperOpen(false);
      }}
    >
      <div
        className="clipper-modal"
        role="dialog"
        aria-modal="true"
        aria-label="网页剪藏"
        data-clipper-state={state.job.status}
      >
        <header className="clipper-head">
          <div className="clipper-title">
            <Scissors size={16} />
            <span>网页深度剪藏（Web Clipper）</span>
          </div>
          <div className="ai-scope-tabs">
            <button
              type="button"
              disabled={clipping}
              className={cx("ai-scope-tab", state.tab === "url" && "active")}
              onClick={() => send({ type: "SWITCH_TAB", tab: "url" })}
            >
              <Globe size={13} /> 网址提取
            </button>
            <button
              type="button"
              disabled={clipping}
              className={cx("ai-scope-tab", state.tab === "bookmarklet" && "active")}
              onClick={() => send({ type: "SWITCH_TAB", tab: "bookmarklet" })}
            >
              <BookmarkPlus size={13} /> 浏览器书签栏小工具
            </button>
          </div>
          <button
            type="button"
            className="icon-btn small"
            aria-label="关闭"
            disabled={clipping}
            onClick={() => setClipperOpen(false)}
          >
            <X size={16} />
          </button>
        </header>

        {state.tab === "url" ? (
          <form className="clipper-body" onSubmit={(e) => void handleClip(e)}>
            <p className="clipper-desc">
              粘贴文章链接（支持微信公众号、知乎、GitHub、掘金、Medium、Reddit 及主流技术博客），自动剔除页面广告与导航，将标题、段落、代码块与配图转为可编辑笔记并打上分类标签。
            </p>

            <label className="clipper-field">
              <span>网页链接</span>
              <input
                autoFocus
                required
                disabled={clipping}
                value={url}
                placeholder="https://..."
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (errorMsg) send({ type: "CLEAR_ERROR" });
                }}
              />
            </label>

            <div className="clipper-row-two">
              <label className="clipper-field">
                <span>
                  <Tag size={12} /> 附加标签（选填）
                </span>
                <input
                  disabled={clipping}
                  value={tagsInput}
                  placeholder="例如：架构, 深度学习"
                  onChange={(e) => setTagsInput(e.target.value)}
                />
              </label>

              <label className="clipper-field">
                <span>存入父页面</span>
                <select disabled={clipping} value={parentId} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">作为顶级页面</option>
                  {candidateParents.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.icon ? `${p.icon} ` : ""}
                      {p.title || "无标题"}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {errorMsg && <div className="ai-status err">{errorMsg}</div>}

            <div className="clipper-foot">
              <button type="button" className="ghost-btn" disabled={clipping} onClick={() => setClipperOpen(false)}>
                取消
              </button>
              <button type="submit" className="primary-btn" disabled={!url.trim() || clipping}>
                {clipping ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
                {clipping ? "正在抓取并解析正文…" : "提取正文并存为笔记"}
              </button>
            </div>
          </form>
        ) : (
          <div className="clipper-body">
            <p className="clipper-desc">
              遇到需要登录才能阅读的网页，或只想剪藏网页中<strong>鼠标划选的某几段精华</strong>？把下方胶囊直接拖到浏览器（Chrome / Edge / Safari / Firefox）顶部的<strong>书签栏</strong>即可一键剪藏！
            </p>

            <div className="bookmarklet-box">
              <a
                className="bookmarklet-pill"
                href={bookmarkletHref}
                onClick={(e) => {
                  e.preventDefault();
                  reportError("请按住此胶囊按钮不放，直接拖拽到浏览器顶部的书签栏（收藏夹栏）中使用");
                }}
              >
                📌 剪藏到 OpenNotion
              </a>
              <span className="ai-hint">← 按住拖到浏览器书签栏</span>
            </div>

            <div className="clipper-field">
              <span>或手动复制书签脚本网址</span>
              <div className="mcp-copy-bar">
                <input readOnly value={token ? bookmarkletHref : "正在生成安全口令…"} />
                <button
                  type="button"
                  className="ghost-btn small"
                  disabled={!token}
                  onClick={() => {
                    void navigator.clipboard?.writeText(bookmarkletHref);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1800);
                  }}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? "已复制" : "复制脚本"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
