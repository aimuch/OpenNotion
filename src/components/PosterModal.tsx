import { useRef, useState } from "react";
import { Check, Copy, Download, ExternalLink, Globe, KeyRound, Printer, RefreshCw, Sparkles, X } from "lucide-react";
import type { PageMeta } from "../../shared/types";
import { reportError, updatePageShare } from "../store";
import { cx } from "./Popover";

export type PosterThemeId = "minimal" | "obsidian" | "magazine" | "emerald" | "aurora" | "kraft";

interface PosterThemeDef {
  id: PosterThemeId;
  name: string;
  outerBg: string;
  cardBg: string;
  text: string;
  muted: string;
  accent: string;
  codeBg: string;
  border: string;
  serif?: boolean;
}

const POSTER_THEMES: PosterThemeDef[] = [
  {
    id: "minimal",
    name: "素雅留白",
    outerBg: "linear-gradient(135deg, #f3f4f6 0%, #e5e7eb 100%)",
    cardBg: "#ffffff",
    text: "#18181b",
    muted: "#71717a",
    accent: "#2563eb",
    codeBg: "#f4f4f5",
    border: "#e4e4e7",
  },
  {
    id: "obsidian",
    name: "深邃暗夜",
    outerBg: "linear-gradient(135deg, #09090b 0%, #1e1b4b 100%)",
    cardBg: "#141417",
    text: "#f4f4f5",
    muted: "#a1a1aa",
    accent: "#818cf8",
    codeBg: "#202026",
    border: "#27272a",
  },
  {
    id: "magazine",
    name: "暖阳杂志",
    outerBg: "linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)",
    cardBg: "#fffdf7",
    text: "#292524",
    muted: "#78716c",
    accent: "#d97706",
    codeBg: "#f5f0e6",
    border: "#e7e0d2",
    serif: true,
  },
  {
    id: "emerald",
    name: "翡翠松林",
    outerBg: "linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%)",
    cardBg: "#fafffd",
    text: "#064e3b",
    muted: "#047857",
    accent: "#059669",
    codeBg: "#ecfdf5",
    border: "#bbf7d0",
  },
  {
    id: "aurora",
    name: "暮光极光",
    outerBg: "linear-gradient(135deg, #e0e7ff 0%, #fae8ff 50%, #ffe4e6 100%)",
    cardBg: "rgba(255, 255, 255, 0.95)",
    text: "#1e1b4b",
    muted: "#6b7280",
    accent: "#7c3aed",
    codeBg: "#f5f3ff",
    border: "#e9d5ff",
  },
  {
    id: "kraft",
    name: "复古手账",
    outerBg: "linear-gradient(135deg, #e7ded0 0%, #d6c7b2 100%)",
    cardBg: "#f7f3eb",
    text: "#3e342b",
    muted: "#7c6d5e",
    accent: "#9a3412",
    codeBg: "#ede6d8",
    border: "#dcd1c0",
    serif: true,
  },
];

function inlinePlain(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const n = item as Record<string, unknown>;
      if (typeof n.text === "string") return n.text;
      if (n.type === "inlineMath") {
        const l = (n.props as Record<string, unknown> | undefined)?.latex;
        return typeof l === "string" ? l : "";
      }
      if (Array.isArray(n.content)) return inlinePlain(n.content);
      return "";
    })
    .join("");
}

/**
 * 分享海报与长图卡片工作台（参考 EdgeEver Poster / 社交卡片设计）：
 * 支持 6 套精选主题、自定义宽度、开关更新时间/字数/标签/签名页脚，一键导出 2x 高清 PNG 长图或打印 PDF
 */
export function PosterModal({
  page,
  blocks,
  wordCount,
  onClose,
}: {
  page: PageMeta;
  blocks: unknown[];
  wordCount: number;
  onClose: () => void;
}) {
  const [studioTab, setStudioTab] = useState<"poster" | "web">("poster");
  const [themeId, setThemeId] = useState<PosterThemeId>("minimal");
  const [cardWidth, setCardWidth] = useState<440 | 600 | 740>(600);
  const [showDate, setShowDate] = useState(true);
  const [showStats, setShowStats] = useState(true);
  const [showTags, setShowTags] = useState(true);
  const [showBrand, setShowBrand] = useState(true);
  const [brandText, setBrandText] = useState("由 OpenNotion 创作与排版");
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [sharePassword, setSharePassword] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const posterRef = useRef<HTMLDivElement>(null);

  const share = page.share;
  const shareUrl = share?.enabled ? `${window.location.origin}/s/${share.token}` : "";

  const patchShare = async (input: Parameters<typeof updatePageShare>[1]) => {
    setShareBusy(true);
    try {
      await updatePageShare(page.id, input);
    } catch (err) {
      reportError(err);
    } finally {
      setShareBusy(false);
    }
  };

  const theme = POSTER_THEMES.find((t) => t.id === themeId) ?? POSTER_THEMES[0];
  const readMins = Math.max(1, Math.ceil(wordCount / 350));
  const dateStr = new Date(page.updatedAt || Date.now()).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const renderCanvasBlob = async (): Promise<Blob> => {
    const el = posterRef.current;
    if (!el) throw new Error("未找到海报画布");
    const rect = el.getBoundingClientRect();
    const w = Math.ceil(rect.width);
    const h = Math.ceil(el.scrollHeight);
    const clone = el.cloneNode(true) as HTMLElement;
    clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    clone.style.width = `${w}px`;
    clone.style.height = `${h}px`;

    const serialized = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <foreignObject width="100%" height="100%">${serialized}</foreignObject>
    </svg>`;
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("生成海报图像失败"));
      img.src = svgUrl;
    });

    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持 Canvas 2D");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, w, h);

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("导出 PNG 失败"))), "image/png");
    });
  };

  const downloadPng = async () => {
    setExporting(true);
    try {
      const blob = await renderCanvasBlob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(page.title || "笔记海报").replace(/[\\/:*?"<>|]/g, "_")}.png`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 1200);
    } finally {
      setExporting(false);
    }
  };

  const copyPng = async () => {
    setExporting(true);
    try {
      const blob = await renderCanvasBlob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      await downloadPng();
    } finally {
      setExporting(false);
    }
  };

  const printPdf = () => {
    const el = posterRef.current;
    if (!el) return;
    const safeTitle = (page.title || "打印导出")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${safeTitle}</title>
      <style>@page { margin: 12mm; } body { margin: 0; display: flex; justify-content: center; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }</style>
      </head><body>${el.outerHTML}</body></html>`;
    // 使用同源隐藏 iframe 触发打印，兼容 Electron 沙箱窗口（不依赖 window.open 弹窗）
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.srcdoc = html;
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } finally {
        window.setTimeout(() => iframe.remove(), 2000);
      }
    };
    document.body.appendChild(iframe);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="poster-studio" role="dialog" aria-modal="true" aria-label="分享与发布" data-share-tab={studioTab}>
        <aside className="poster-controls">
          <div className="poster-controls-head">
            <strong>
              <Sparkles size={15} /> 分享与发布
            </strong>
            <button type="button" className="icon-btn small" aria-label="关闭" onClick={onClose}>
              <X size={16} />
            </button>
          </div>

          <div className="ai-scope-tabs">
            <button
              type="button"
              className={cx("ai-scope-tab", studioTab === "poster" && "active")}
              onClick={() => setStudioTab("poster")}
            >
              <Sparkles size={12} /> 海报长图
            </button>
            <button
              type="button"
              className={cx("ai-scope-tab", studioTab === "web" && "active")}
              onClick={() => setStudioTab("web")}
            >
              <Globe size={12} /> 网页分享
            </button>
          </div>

          {studioTab === "web" ? (
            <div className="share-web-panel">
              <div className="poster-section">
                <label className="poster-check">
                  <input
                    type="checkbox"
                    checked={Boolean(share?.enabled)}
                    disabled={shareBusy}
                    onChange={(e) => void patchShare({ enabled: e.target.checked })}
                  />
                  <span>发布为只读分享网页（/s/链接）</span>
                </label>
              </div>

              {share?.enabled && (
                <>
                  <div className="poster-section">
                    <span className="poster-label">公开访问链接</span>
                    <div className="share-link-row">
                      <input readOnly value={shareUrl} aria-label="公开分享链接" />
                      <button
                        type="button"
                        className="ghost-btn small"
                        onClick={() => {
                          void navigator.clipboard?.writeText(shareUrl);
                          setLinkCopied(true);
                          window.setTimeout(() => setLinkCopied(false), 1800);
                        }}
                      >
                        {linkCopied ? <Check size={13} /> : <Copy size={13} />}
                        {linkCopied ? "已复制" : "复制"}
                      </button>
                    </div>
                    <div className="poster-sub-actions" style={{ marginTop: 6 }}>
                      <a className="ghost-btn small" href={shareUrl} target="_blank" rel="noreferrer noopener">
                        <ExternalLink size={12} /> 打开预览
                      </a>
                      <button
                        type="button"
                        className="text-btn small"
                        disabled={shareBusy}
                        onClick={() => void patchShare({ rotateToken: true })}
                      >
                        <RefreshCw size={12} /> 重置链接
                      </button>
                    </div>
                  </div>

                  <div className="poster-section">
                    <span className="poster-label">
                      <KeyRound size={12} /> 访问口令保护 {share.hasPassword ? "（已开启）" : "（未设置）"}
                    </span>
                    <div className="share-link-row">
                      <input
                        type="password"
                        value={sharePassword}
                        placeholder={share.hasPassword ? "输入新口令覆盖…" : "可选：设置访问密码…"}
                        onChange={(e) => setSharePassword(e.target.value)}
                      />
                      <button
                        type="button"
                        className="primary-btn small"
                        disabled={shareBusy || !sharePassword.trim()}
                        onClick={async () => {
                          await patchShare({ password: sharePassword.trim() });
                          setSharePassword("");
                        }}
                      >
                        保存
                      </button>
                    </div>
                    {share.hasPassword && (
                      <button
                        type="button"
                        className="text-btn small danger"
                        style={{ marginTop: 4 }}
                        disabled={shareBusy}
                        onClick={() => void patchShare({ password: "__CLEAR__" })}
                      >
                        取消密码保护
                      </button>
                    )}
                  </div>

                  <div className="poster-section">
                    <span className="poster-label">公开页选项</span>
                    {page.kind === "database" && (
                      <label className="poster-check">
                        <input
                          type="checkbox"
                          checked={Boolean(share.allowFormSubmit)}
                          disabled={shareBusy}
                          onChange={(e) => void patchShare({ allowFormSubmit: e.target.checked })}
                        />
                        <span>允许访客提交公开表单写入此数据库</span>
                      </label>
                    )}
                    <label className="poster-check">
                      <input
                        type="checkbox"
                        checked={share.showMeta !== false}
                        disabled={shareBusy}
                        onChange={(e) => void patchShare({ showMeta: e.target.checked })}
                      />
                      <span>显示更新时间与字数</span>
                    </label>
                    <label className="poster-check">
                      <input
                        type="checkbox"
                        checked={share.showBrand !== false}
                        disabled={shareBusy}
                        onChange={(e) => void patchShare({ showBrand: e.target.checked })}
                      />
                      <span>显示底部品牌标识</span>
                    </label>
                  </div>
                </>
              )}
            </div>
          ) : (
            <>

          <div className="poster-section">
            <span className="poster-label">视觉主题</span>
            <div className="poster-theme-grid">
              {POSTER_THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={cx("poster-theme-btn", themeId === t.id && "active")}
                  onClick={() => setThemeId(t.id)}
                >
                  <span className="poster-swatch" style={{ background: t.outerBg }} />
                  <span>{t.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="poster-section">
            <span className="poster-label">画幅尺寸</span>
            <div className="ai-scope-tabs">
              {([
                [440, "手机竖卡"],
                [600, "标准图文"],
                [740, "宽幅长文"],
              ] as const).map(([w, label]) => (
                <button
                  key={w}
                  type="button"
                  className={cx("ai-scope-tab", cardWidth === w && "active")}
                  onClick={() => setCardWidth(w)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="poster-section">
            <span className="poster-label">展示信息控制</span>
            <label className="poster-check">
              <input type="checkbox" checked={showDate} onChange={(e) => setShowDate(e.target.checked)} />
              <span>显示更新日期</span>
            </label>
            <label className="poster-check">
              <input type="checkbox" checked={showStats} onChange={(e) => setShowStats(e.target.checked)} />
              <span>显示字数与阅读时长</span>
            </label>
            <label className="poster-check">
              <input type="checkbox" checked={showTags} onChange={(e) => setShowTags(e.target.checked)} />
              <span>显示 #标签</span>
            </label>
            <label className="poster-check">
              <input type="checkbox" checked={showBrand} onChange={(e) => setShowBrand(e.target.checked)} />
              <span>显示页脚品牌标识</span>
            </label>
            {showBrand && (
              <input
                className="poster-brand-input"
                value={brandText}
                placeholder="自定义页脚署名…"
                onChange={(e) => setBrandText(e.target.value)}
              />
            )}
          </div>

          <div className="poster-actions">
            <button type="button" className="primary-btn" disabled={exporting} onClick={() => void downloadPng()}>
              <Download size={15} /> {exporting ? "生成中…" : "下载高清 PNG 长图"}
            </button>
            <div className="poster-sub-actions">
              <button type="button" className="ghost-btn small" disabled={exporting} onClick={() => void copyPng()}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "已复制图片" : "复制图片"}
              </button>
              <button type="button" className="ghost-btn small" onClick={printPdf}>
                <Printer size={13} /> 打印 / PDF
              </button>
            </div>
          </div>
            </>
          )}
        </aside>

        <div className="poster-preview-pane">
          <div
            ref={posterRef}
            style={{
              width: cardWidth,
              padding: "36px 32px",
              background: theme.outerBg,
              boxSizing: "border-box",
              fontFamily: theme.serif
                ? '"Songti SC", "Noto Serif SC", Georgia, serif'
                : '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
            }}
          >
            <article
              style={{
                background: theme.cardBg,
                color: theme.text,
                border: `1px solid ${theme.border}`,
                borderRadius: "16px",
                padding: "34px 36px",
                boxShadow: "0 16px 40px rgba(0, 0, 0, 0.08)",
              }}
            >
              <header style={{ marginBottom: "22px", paddingBottom: "18px", borderBottom: `1px solid ${theme.border}` }}>
                {page.icon && <div style={{ fontSize: "34px", marginBottom: "10px" }}>{page.icon}</div>}
                <h1 style={{ margin: "0 0 10px", fontSize: "26px", lineHeight: 1.32, fontWeight: 750 }}>
                  {page.title || "无标题"}
                </h1>
                {(showDate || showStats) && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", fontSize: "12.5px", color: theme.muted }}>
                    {showDate && <span>{dateStr}</span>}
                    {showStats && (
                      <span>
                        {wordCount} 字 · 约 {readMins} 分钟阅读
                      </span>
                    )}
                  </div>
                )}
                {showTags && page.tags && page.tags.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "12px" }}>
                    {page.tags.map((tag) => (
                      <span
                        key={tag}
                        style={{
                          padding: "2px 9px",
                          borderRadius: "999px",
                          fontSize: "11.5px",
                          background: theme.codeBg,
                          color: theme.accent,
                          fontWeight: 500,
                        }}
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </header>

              <div style={{ display: "grid", gap: "12px", fontSize: "15px", lineHeight: 1.72 }}>
                {blocks.slice(0, 60).map((raw, idx) => {
                  if (!raw || typeof raw !== "object") return null;
                  const b = raw as Record<string, unknown>;
                  const type = String(b.type ?? "paragraph");
                  const props = (b.props ?? {}) as Record<string, unknown>;
                  const txt = inlinePlain(b.content);

                  if (type === "heading") {
                    const lvl = typeof props.level === "number" ? props.level : 2;
                    return (
                      <h2
                        key={idx}
                        style={{
                          margin: "10px 0 2px",
                          fontSize: lvl === 1 ? "20px" : lvl === 2 ? "17.5px" : "16px",
                          fontWeight: 700,
                        }}
                      >
                        {txt}
                      </h2>
                    );
                  }
                  if (type === "quote" || type === "callout") {
                    return (
                      <blockquote
                        key={idx}
                        style={{
                          margin: "4px 0",
                          padding: "10px 14px",
                          borderLeft: `3px solid ${theme.accent}`,
                          background: theme.codeBg,
                          borderRadius: "0 8px 8px 0",
                        }}
                      >
                        {props.icon ? `${String(props.icon)} ` : ""}
                        {txt}
                      </blockquote>
                    );
                  }
                  if (type === "codeBlock") {
                    return (
                      <pre
                        key={idx}
                        style={{
                          margin: "4px 0",
                          padding: "12px 14px",
                          borderRadius: "8px",
                          background: theme.codeBg,
                          fontSize: "12.5px",
                          lineHeight: 1.55,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                        }}
                      >
                        {txt}
                      </pre>
                    );
                  }
                  if (type === "checkListItem") {
                    return (
                      <div key={idx} style={{ display: "flex", gap: "8px" }}>
                        <span style={{ color: theme.accent }}>{props.checked ? "☑" : "☐"}</span>
                        <span style={{ textDecoration: props.checked ? "line-through" : "none" }}>{txt}</span>
                      </div>
                    );
                  }
                  if (type === "bulletListItem" || type === "numberedListItem") {
                    return (
                      <div key={idx} style={{ display: "flex", gap: "8px" }}>
                        <span style={{ color: theme.accent }}>•</span>
                        <span>{txt}</span>
                      </div>
                    );
                  }
                  if (type === "divider") {
                    return <hr key={idx} style={{ border: 0, borderTop: `1px solid ${theme.border}`, margin: "8px 0" }} />;
                  }
                  if (type === "equation" && typeof props.latex === "string") {
                    return (
                      <div
                        key={idx}
                        style={{
                          padding: "10px",
                          textAlign: "center",
                          background: theme.codeBg,
                          borderRadius: "8px",
                          fontFamily: '"Cambria Math", Georgia, serif',
                        }}
                      >
                        {props.latex}
                      </div>
                    );
                  }
                  if (!txt) return null;
                  return (
                    <p key={idx} style={{ margin: 0 }}>
                      {txt}
                    </p>
                  );
                })}
              </div>

              {showBrand && brandText.trim() && (
                <footer
                  style={{
                    marginTop: "28px",
                    paddingTop: "14px",
                    borderTop: `1px dashed ${theme.border}`,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "12px",
                    color: theme.muted,
                  }}
                >
                  <span>{brandText}</span>
                  <span>OpenNotion</span>
                </footer>
              )}
            </article>
          </div>
        </div>
      </div>
    </div>
  );
}
