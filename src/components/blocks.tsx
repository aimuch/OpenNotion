import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createReactBlockSpec, useEditorChange } from "@blocknote/react";
import {
  Bookmark,
  Code2,
  Columns2,
  ExternalLink,
  Eye,
  FileUp,
  GitBranch,
  Globe,
  ListTree,
  LoaderCircle,
  MousePointerClick,
  Network,
  Palette,
  Pencil,
  Play,
  Settings2,
  Sigma,
  Sparkles,
} from "lucide-react";
import { blocksPlainText, generateMermaidCode, generateMindMapOutline } from "../ai";
import {
  transitionBookmarkBlock,
  transitionEmbedBlock,
  useMachine,
  type BookmarkBlockState,
} from "../machines";
import { MathRenderer } from "../math";
import { MermaidDiagram } from "../mermaidSvg";
import { DEFAULT_MIND_OUTLINE, MindMapDiagram, type MindLayout, type MindTheme } from "../mindmap";
import { createPage, navigate, reportError, setAiOpen, unfurlLink, uploadFile } from "../store";
import { EmojiPicker } from "./pickers";
import { cx } from "./Popover";

const CALLOUT_TONES = ["gray", "blue", "green", "yellow", "orange", "red", "purple"] as const;
const TONE_LABELS: Record<string, string> = {
  gray: "默认灰",
  blue: "海洋蓝",
  green: "森林绿",
  yellow: "暖阳黄",
  orange: "琥珀橙",
  red: "珊瑚红",
  purple: "薰衣草紫",
};

/** 提示框（Callout）：左侧可换 emoji 图标，支持 7 种底色，内部保留完整富文本编辑能力 */
export const createCalloutBlock = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      icon: { default: "💡" },
      tone: { default: "gray" },
    },
    content: "inline",
  },
  {
    render: ({ block, editor, contentRef }) => {
      const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
      const editable = editor.isEditable;
      const cycleTone = () => {
        if (!editable) return;
        const idx = CALLOUT_TONES.indexOf(block.props.tone as (typeof CALLOUT_TONES)[number]);
        const next = CALLOUT_TONES[(idx + 1) % CALLOUT_TONES.length];
        editor.updateBlock(block, { props: { tone: next } });
      };

      return (
        <div className={cx("callout-block", `callout-${block.props.tone}`)}>
          <button
            type="button"
            className="callout-icon"
            contentEditable={false}
            disabled={!editable}
            title={editable ? "点击更换图标" : undefined}
            onClick={(e) => {
              if (editable) setEmojiAnchor(emojiAnchor ? null : e.currentTarget);
            }}
          >
            {block.props.icon || "💡"}
          </button>
          <div className="callout-content" ref={contentRef} />
          {editable && (
            <button
              type="button"
              className="callout-tone-btn"
              contentEditable={false}
              title={`切换底色（当前：${TONE_LABELS[block.props.tone] ?? "默认"}）`}
              aria-label="切换提示框底色"
              onClick={cycleTone}
            >
              <Palette size={13} />
            </button>
          )}
          {emojiAnchor && (
            <EmojiPicker
              anchor={emojiAnchor}
              hasIcon={false}
              onPick={(icon) => editor.updateBlock(block, { props: { icon: icon ?? "💡" } })}
              onClose={() => setEmojiAnchor(null)}
            />
          )}
        </div>
      );
    },
    parse: (el) => (el.tagName === "ASIDE" ? { icon: "💡", tone: "gray" } : undefined),
    toExternalHTML: ({ block, contentRef }) => (
      <aside>
        <span>{block.props.icon} </span>
        <span ref={contentRef} />
      </aside>
    ),
  },
);

interface HeadingItem {
  id: string;
  level: number;
  text: string;
}

function collectHeadings(blocks: unknown[], out: HeadingItem[] = []): HeadingItem[] {
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as {
      id?: string;
      type?: string;
      props?: { level?: number };
      content?: { text?: string }[];
      children?: unknown[];
    };
    if (b.type === "heading" && b.id) {
      const text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join("").trim() : "";
      out.push({ id: b.id, level: Number(b.props?.level ?? 1), text: text || "无标题章节" });
    }
    if (Array.isArray(b.children) && b.children.length > 0) collectHeadings(b.children, out);
  }
  return out;
}

/** 目录块（Table of Contents）：实时提取页面内的一/二/三级标题，点击平滑滚动定位 */
export const createTocBlock = createReactBlockSpec(
  {
    type: "toc",
    propSchema: {},
    content: "none",
  },
  {
    render: ({ editor }) => {
      const [, setTick] = useState(0);
      useEditorChange(() => setTick((n) => n + 1), editor);
      const headings = collectHeadings(editor.document);
      const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 3);

      return (
        <nav className="toc-block" contentEditable={false} aria-label="页面目录">
          <div className="toc-head">
            <ListTree size={14} /> 目录
          </div>
          {headings.length === 0 ? (
            <div className="toc-empty">在页面中添加一、二、三级标题后，这里会自动生成可跳转的目录。</div>
          ) : (
            <div className="toc-list">
              {headings.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className="toc-item"
                  style={{ paddingLeft: 8 + Math.max(0, h.level - minLevel) * 16 }}
                  onClick={() => {
                    const target = document.querySelector(`[data-id="${h.id}"]`);
                    target?.scrollIntoView({ behavior: "smooth", block: "center" });
                  }}
                >
                  {h.text}
                </button>
              ))}
            </div>
          )}
        </nav>
      );
    },
    toExternalHTML: () => <p>（目录）</p>,
  },
);

/** 数学公式块（Equation）：支持结构化分式、根号、上下标、大型求和积分与矩阵实时排版预览 */
export const createEquationBlock = createReactBlockSpec(
  {
    type: "equation",
    propSchema: {
      latex: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const editable = editor.isEditable;
      const [editing, setEditing] = useState(!block.props.latex);
      const [draft, setDraft] = useState(block.props.latex);

      useEffect(() => {
        setDraft(block.props.latex);
      }, [block.props.latex]);

      const commit = () => {
        editor.updateBlock(block, { props: { latex: draft.trim() } });
        if (draft.trim()) setEditing(false);
      };

      if (editable && editing) {
        return (
          <div className="equation-editor-card" contentEditable={false} onKeyDown={(e) => e.stopPropagation()}>
            <div className="equation-block editing">
              <Sigma size={15} className="equation-icon" />
              <input
                autoFocus
                value={draft}
                placeholder="输入 LaTeX 公式，如 \sum_{i=1}^{n} x_i = \frac{n(n+1)}{2} 或 \sqrt{a^2 + b^2}"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (!e.nativeEvent.isComposing && (e.key === "Enter" || e.key === "Escape")) {
                    e.preventDefault();
                    commit();
                  }
                }}
              />
            </div>
            {draft.trim() && (
              <div className="equation-live-preview">
                <MathRenderer latex={draft} display />
              </div>
            )}
          </div>
        );
      }

      return (
        <div
          className={cx("equation-block", editable && "clickable")}
          contentEditable={false}
          role={editable ? "button" : undefined}
          tabIndex={editable ? 0 : undefined}
          onClick={() => editable && setEditing(true)}
          onKeyDown={(e) => {
            if (editable && e.key === "Enter") setEditing(true);
          }}
        >
          {block.props.latex.trim() ? (
            <MathRenderer latex={block.props.latex} display />
          ) : (
            <span className="equation-placeholder">点击输入数学公式</span>
          )}
        </div>
      );
    },
    toExternalHTML: ({ block }) => <pre>{`$$${block.props.latex}$$`}</pre>,
  },
);

const MERMAID_TEMPLATES: { label: string; code: string }[] = [
  {
    label: "流程图",
    code: `flowchart LR
  A[需求评审] --> B{方案通过?}
  B -->|是| C[开发与自测]
  B -->|否| A
  C --> D((正式上线))`,
  },
  {
    label: "时序图",
    code: `sequenceDiagram
  participant U as 用户界面
  participant S as 本地服务
  participant M as 大模型接口
  U->>S: 发起检索问答请求
  S-->>M: 组装上下文流式调用
  M-->>U: 实时返回生成内容`,
  },
  {
    label: "饼图",
    code: `pie title 任务模块占比
  "核心编辑" : 42
  "数据库视图" : 35
  "多模型问答" : 23`,
  },
];

/** Mermaid 图表块：实时矢量渲染流程图、时序图与饼图，支持“仅预览 / 分屏 / 仅代码”切换 */
export const createMermaidBlock = createReactBlockSpec(
  {
    type: "mermaid",
    propSchema: {
      code: { default: MERMAID_TEMPLATES[0].code },
      mode: { default: "split" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const editable = editor.isEditable;
      const mode = (editable ? block.props.mode : "preview") as "preview" | "split" | "code";
      const [aiOpen, setAiBarOpen] = useState(false);
      const [aiPrompt, setAiPrompt] = useState("");
      const [aiBusy, setAiBusy] = useState(false);

      const runAiDiagram = async () => {
        if (aiBusy) return;
        setAiBusy(true);
        try {
          const ctx = blocksPlainText(editor.document);
          const code = await generateMermaidCode(aiPrompt, ctx);
          if (code) {
            editor.updateBlock(block, { props: { code } });
            setAiBarOpen(false);
            setAiPrompt("");
          }
        } catch (err) {
          reportError(err);
        } finally {
          setAiBusy(false);
        }
      };

      return (
        <div className="mermaid-block" contentEditable={false} onKeyDown={(e) => e.stopPropagation()}>
          {editable && (
            <div className="mermaid-head">
              <span className="mermaid-title">
                <GitBranch size={13} /> Mermaid 图表
              </span>
              <div className="mermaid-templates">
                {MERMAID_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.label}
                    type="button"
                    className="text-btn small"
                    onClick={() => editor.updateBlock(block, { props: { code: tpl.code } })}
                  >
                    {tpl.label}示例
                  </button>
                ))}
                <button
                  type="button"
                  className={cx("text-btn small ai-tag-btn", aiOpen && "active")}
                  onClick={() => setAiBarOpen(!aiOpen)}
                >
                  <Sparkles size={12} /> AI 生成
                </button>
              </div>
              <div className="ai-scope-tabs">
                <button
                  type="button"
                  className={cx("ai-scope-tab", mode === "preview" && "active")}
                  onClick={() => editor.updateBlock(block, { props: { mode: "preview" } })}
                >
                  <Eye size={12} /> 预览
                </button>
                <button
                  type="button"
                  className={cx("ai-scope-tab", mode === "split" && "active")}
                  onClick={() => editor.updateBlock(block, { props: { mode: "split" } })}
                >
                  <Columns2 size={12} /> 分屏
                </button>
                <button
                  type="button"
                  className={cx("ai-scope-tab", mode === "code" && "active")}
                  onClick={() => editor.updateBlock(block, { props: { mode: "code" } })}
                >
                  <Code2 size={12} /> 代码
                </button>
              </div>
            </div>
          )}

          {editable && aiOpen && (
            <div className="diagram-ai-bar">
              <Sparkles size={13} />
              <input
                autoFocus
                disabled={aiBusy}
                value={aiPrompt}
                placeholder="输入流程主题（留空则直接根据当前页面正文提炼流程图）…"
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (!e.nativeEvent.isComposing && e.key === "Enter") {
                    e.preventDefault();
                    void runAiDiagram();
                  } else if (e.key === "Escape") {
                    setAiBarOpen(false);
                  }
                }}
              />
              <button type="button" className="primary-btn small" disabled={aiBusy} onClick={() => void runAiDiagram()}>
                {aiBusy ? <LoaderCircle size={12} className="spin" /> : "生成图表"}
              </button>
            </div>
          )}

          <div className={cx("mermaid-body", `mode-${mode}`)}>
            {(mode === "code" || mode === "split") && (
              <textarea
                className="mermaid-editor"
                rows={6}
                spellCheck={false}
                value={block.props.code}
                placeholder="输入 Mermaid 语法…"
                onChange={(e) => editor.updateBlock(block, { props: { code: e.target.value } })}
              />
            )}
            {(mode === "preview" || mode === "split") && (
              <div className="mermaid-canvas">
                <MermaidDiagram code={block.props.code} />
              </div>
            )}
          </div>
        </div>
      );
    },
    toExternalHTML: ({ block }) => <pre>{block.props.code}</pre>,
  },
);

export function normalizeEmbedUrl(rawUrl: string): { src: string; kind: string } | null {
  const u = rawUrl.trim();
  if (!u) return null;
  if (/^\/uploads\/[a-f0-9]{16}\.pdf$/i.test(u)) {
    return { src: u, kind: "PDF 文档" };
  }
  const full = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  let parsed: URL;
  try {
    parsed = new URL(full);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  // Bilibili 视频自动转换嵌入播放器
  const bv = /bilibili\.com\/video\/(BV[A-Za-z0-9]+)/i.exec(full);
  if (bv) {
    return {
      src: `https://player.bilibili.com/player.html?bvid=${bv[1]}&high_quality=1&autoplay=0`,
      kind: "Bilibili 视频",
    };
  }
  // YouTube 视频自动转换嵌入播放器
  const yt =
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{6,})/i.exec(full);
  if (yt) {
    return {
      src: `https://www.youtube-nocookie.com/embed/${yt[1]}`,
      kind: "YouTube 视频",
    };
  }
  // Figma 设计稿画布自动转换嵌入视图
  if (/figma\.com\/(file|design|proto|board)\//i.test(full)) {
    return {
      src: `https://www.figma.com/embed?embed_host=opennotion&url=${encodeURIComponent(full)}`,
      kind: "Figma 画布",
    };
  }
  if (/\.pdf(?:[?#]|$)/i.test(full)) {
    return { src: full, kind: "PDF 文档" };
  }
  return { src: full, kind: parsed.hostname };
}

/** 网页与媒体内嵌块（Embed）：支持本地/在线 PDF 阅读器、Bilibili、YouTube、Figma 画布及拖拽调高 */
export const createEmbedBlock = createReactBlockSpec(
  {
    type: "embed",
    propSchema: {
      url: { default: "" },
      height: { default: 420 },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const editable = editor.isEditable;
      const [embedState, sendEmbed] = useMachine(
        transitionEmbedBlock,
        block.props.url ? { phase: "viewing", liveHeight: null } : { phase: "editing", draft: "", error: null },
      );
      const fileRef = useRef<HTMLInputElement>(null);

      const resolved = normalizeEmbedUrl(block.props.url);
      const draft =
        embedState.phase === "editing" || embedState.phase === "uploading" ? embedState.draft : block.props.url;
      const uploading = embedState.phase === "uploading";
      const uploadErr = embedState.phase === "editing" ? embedState.error : null;

      const commit = () => {
        const next = draft.trim();
        if (!next) return;
        editor.updateBlock(block, { props: { url: next } });
        sendEmbed({ type: "COMMIT_URL" });
      };

      const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const startY = e.clientY;
        const startH = block.props.height || 420;
        let curH = startH;
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        const onMove = (ev: PointerEvent) => {
          curH = Math.max(220, Math.min(860, Math.round(startH + ev.clientY - startY)));
          sendEmbed({ type: "RESIZE_MOVE", height: curH });
        };
        const onUp = () => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          sendEmbed({ type: "RESIZE_END" });
          editor.updateBlock(block, { props: { height: curH } });
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
      };

      if (embedState.phase !== "viewing" || !resolved) {
        return (
          <div
            className="bookmark-input-bar"
            contentEditable={false}
            data-embed-state={embedState.phase}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Globe size={15} />
            <input
              autoFocus={editable}
              disabled={!editable || uploading}
              value={draft}
              placeholder="粘贴 PDF、Bilibili、YouTube、Figma 或任意 https 链接…"
              onChange={(e) => sendEmbed({ type: "DRAFT_CHANGE", draft: e.target.value })}
              onKeyDown={(e) => {
                if (!e.nativeEvent.isComposing && e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (!e.nativeEvent.isComposing && e.key === "Escape" && resolved) {
                  sendEmbed({ type: "CANCEL_EDIT" });
                }
              }}
            />
            <button
              type="button"
              className="ghost-btn small"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              <FileUp size={13} /> {uploading ? "上传中…" : "上传本地 PDF"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,application/pdf"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                sendEmbed({ type: "UPLOAD_START" });
                try {
                  const uploadedUrl = await uploadFile(file);
                  editor.updateBlock(block, { props: { url: uploadedUrl } });
                  sendEmbed({ type: "UPLOAD_DONE" });
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  sendEmbed({ type: "UPLOAD_FAIL", message: msg });
                  reportError(err);
                }
              }}
            />
            <button type="button" className="primary-btn small" disabled={uploading || !draft.trim()} onClick={commit}>
              嵌入预览
            </button>
            {resolved && !uploading && (
              <button type="button" className="text-btn small" onClick={() => sendEmbed({ type: "CANCEL_EDIT" })}>
                取消
              </button>
            )}
            {uploadErr && <span className="value-error bookmark-err">{uploadErr}</span>}
          </div>
        );
      }

      const h = embedState.liveHeight ?? (block.props.height || 420);

      return (
        <div className="embed-card" contentEditable={false} data-embed-state="viewing">
          <div className="embed-card-head">
            <span className="embed-kind">
              <Globe size={12} /> {resolved.kind}
            </span>
            <div className="embed-actions">
              {editable && (
                <button
                  type="button"
                  className="text-btn small"
                  onClick={() => sendEmbed({ type: "EDIT", draft: block.props.url })}
                >
                  <Pencil size={12} /> 更换链接
                </button>
              )}
              <a
                className="text-btn small"
                href={resolved.src}
                target="_blank"
                rel="noreferrer noopener"
              >
                <ExternalLink size={12} /> 新窗口打开
              </a>
            </div>
          </div>
          <iframe
            className="embed-frame"
            src={resolved.src}
            title={resolved.kind}
            style={{ height: h }}
            sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
            allowFullScreen
          />
          {editable && (
            <div className="embed-resizer" title="上下拖动调整高度" onPointerDown={startResize}>
              <span />
            </div>
          )}
        </div>
      );
    },
    toExternalHTML: ({ block }) => (
      <p>
        <a href={block.props.url}>{block.props.url}</a>
      </p>
    ),
  },
);

/** 正文自定义动作按钮块（Button Block）：点击一键插入预设待办/日志模板、新建子页或唤起 AI */
export const createActionButtonBlock = createReactBlockSpec(
  {
    type: "actionButton",
    propSchema: {
      label: { default: "新增打卡记录" },
      actionType: { default: "insert_todo" },
      templateText: { default: "今日进展记录" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const editable = editor.isEditable;
      const [configuring, setConfiguring] = useState(false);

      const run = async () => {
        const nowStr = new Date().toLocaleString("zh-CN", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        const text = (block.props.templateText || "新条目").replace(/\{\{now\}\}/g, nowStr);

        if (block.props.actionType === "new_page") {
          const id = await createPage({ title: text });
          if (id) navigate(id);
          return;
        }
        if (block.props.actionType === "open_ai") {
          setAiOpen(true);
          return;
        }
        (
          editor as unknown as {
            insertBlocks: (
              blocks: { type: "checkListItem" | "paragraph"; content: string }[],
              referenceBlock: { id: string },
              placement: "after",
            ) => void;
          }
        ).insertBlocks(
          [
            {
              type: block.props.actionType === "insert_todo" ? "checkListItem" : "paragraph",
              content: `${nowStr} · ${text}`,
            },
          ],
          block,
          "after",
        );
      };

      return (
        <div className="action-btn-block" contentEditable={false} onKeyDown={(e) => e.stopPropagation()}>
          <div className="action-btn-row">
            <button type="button" className="page-action-trigger" onClick={() => void run()}>
              <Play size={13} />
              <span>{block.props.label || "执行动作"}</span>
            </button>
            {editable && (
              <button
                type="button"
                className="icon-btn small action-btn-gear"
                title="配置按钮动作"
                aria-label="配置按钮动作"
                onClick={() => setConfiguring(!configuring)}
              >
                <Settings2 size={14} />
              </button>
            )}
          </div>

          {editable && configuring && (
            <div className="action-btn-config">
              <label>
                <span>按钮文字</span>
                <input
                  value={block.props.label}
                  onChange={(e) => editor.updateBlock(block, { props: { label: e.target.value } })}
                />
              </label>
              <label>
                <span>点击后执行</span>
                <select
                  value={block.props.actionType}
                  onChange={(e) => editor.updateBlock(block, { props: { actionType: e.target.value } })}
                >
                  <option value="insert_todo">在下方插入带时间戳的待办项</option>
                  <option value="insert_text">在下方插入带时间戳的段落</option>
                  <option value="new_page">新建一个空白页面并打开</option>
                  <option value="open_ai">唤起工作区 AI 助手</option>
                </select>
              </label>
              {block.props.actionType !== "open_ai" && (
                <label>
                  <span>预设文本（可用 &#123;&#123;now&#125;&#125; 代表当前时间）</span>
                  <input
                    value={block.props.templateText}
                    onChange={(e) => editor.updateBlock(block, { props: { templateText: e.target.value } })}
                  />
                </label>
              )}
            </div>
          )}
        </div>
      );
    },
    toExternalHTML: ({ block }) => (
      <p>
        <MousePointerClick size={12} /> [{block.props.label}]
      </p>
    ),
  },
);

/** 网页书签块（Web Bookmark）：输入网址自动抓取站点标题与简介并渲染为卡片，可随时修改网址 */
export const createBookmarkBlock = createReactBlockSpec(
  {
    type: "bookmark",
    propSchema: {
      url: { default: "" },
      title: { default: "" },
      description: { default: "" },
      siteName: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const editable = editor.isEditable;
      const [bmState, sendBm] = useMachine(
        transitionBookmarkBlock,
        block.props.url ? { phase: "ready" } : { phase: "editing", draft: "", error: null },
      );

      const effective: BookmarkBlockState =
        !block.props.url && bmState.phase === "ready" ? { phase: "editing", draft: "", error: null } : bmState;

      const submit = async () => {
        if (effective.phase !== "editing") return;
        let raw = effective.draft.trim();
        if (!raw) return;
        if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
        sendBm({ type: "RESOLVE_START", url: raw });
        try {
          const data = await unfurlLink(raw);
          editor.updateBlock(block, {
            props: {
              url: data.url,
              title: data.title,
              description: data.description,
              siteName: data.siteName,
            },
          });
          sendBm({ type: "RESOLVE_DONE" });
        } catch (e) {
          sendBm({
            type: "RESOLVE_FAIL",
            draft: raw,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      };

      if (effective.phase !== "ready") {
        const loading = effective.phase === "resolving";
        const err = effective.phase === "editing" ? effective.error : null;
        return (
          <div
            className="bookmark-input-bar"
            contentEditable={false}
            data-bookmark-state={effective.phase}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Bookmark size={15} />
            <input
              autoFocus={editable}
              disabled={!editable || loading}
              value={effective.draft}
              placeholder="输入或粘贴网址（如 https://example.com），回车生成书签卡片…"
              onChange={(e) => sendBm({ type: "DRAFT_CHANGE", draft: e.target.value })}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                } else if (e.key === "Escape" && block.props.url) {
                  e.preventDefault();
                  sendBm({ type: "CANCEL" });
                }
              }}
            />
            <button
              type="button"
              className="primary-btn small"
              disabled={loading || !effective.draft.trim()}
              onClick={() => void submit()}
            >
              {loading ? <LoaderCircle size={13} className="spin" /> : "嵌入书签"}
            </button>
            {block.props.url && !loading && (
              <button type="button" className="text-btn small" onClick={() => sendBm({ type: "CANCEL" })}>
                取消
              </button>
            )}
            {err && <span className="value-error bookmark-err">{err}</span>}
          </div>
        );
      }

      return (
        <div className="bookmark-card-wrap" contentEditable={false} data-bookmark-state="ready">
          <a
            className="bookmark-card"
            href={/^https?:\/\//i.test(block.props.url) ? block.props.url : "about:blank"}
            target="_blank"
            rel="noreferrer noopener"
          >
            <div className="bookmark-card-main">
              <div className="bookmark-title">{block.props.title || block.props.url}</div>
              {block.props.description && <div className="bookmark-desc">{block.props.description}</div>}
              <div className="bookmark-meta">
                <ExternalLink size={12} />
                <span>{block.props.siteName || block.props.url}</span>
              </div>
            </div>
          </a>
          {editable && (
            <button
              type="button"
              className="bookmark-edit-btn"
              title="更换网址"
              aria-label="更换书签网址"
              onClick={() => sendBm({ type: "EDIT", draft: block.props.url })}
            >
              <Pencil size={12} /> 更换网址
            </button>
          )}
        </div>
      );
    },
    toExternalHTML: ({ block }) => (
      <p>
        <a href={block.props.url}>{block.props.title || block.props.url}</a>
      </p>
    ),
  },
);

/** 交互式思维导图块（Mind Map）：支持左右发散/向右逻辑树切换、3 套配色主题、节点点击增删改折与大纲双视图 */
export const createMindMapBlock = createReactBlockSpec(
  {
    type: "mindmap",
    propSchema: {
      outline: { default: DEFAULT_MIND_OUTLINE },
      layout: { default: "mind" },
      theme: { default: "rainbow" },
      mode: { default: "map" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const editable = editor.isEditable;
      const mode = (editable ? block.props.mode : "map") as "map" | "split" | "outline";
      const layout = (block.props.layout || "mind") as MindLayout;
      const theme = (block.props.theme || "rainbow") as MindTheme;
      const [aiOpen, setAiBarOpen] = useState(false);
      const [aiPrompt, setAiPrompt] = useState("");
      const [aiBusy, setAiBusy] = useState(false);

      const runAiMind = async () => {
        if (aiBusy) return;
        setAiBusy(true);
        try {
          const ctx = blocksPlainText(editor.document);
          const outline = await generateMindMapOutline(aiPrompt, ctx);
          if (outline) {
            editor.updateBlock(block, { props: { outline } });
            setAiBarOpen(false);
            setAiPrompt("");
          }
        } catch (err) {
          reportError(err);
        } finally {
          setAiBusy(false);
        }
      };

      return (
        <div className="mermaid-block mindmap-block" contentEditable={false} onKeyDown={(e) => e.stopPropagation()}>
          {editable && (
            <div className="mermaid-head">
              <span className="mermaid-title">
                <Network size={13} /> 思维导图
              </span>
              <div className="mermaid-templates">
                <button
                  type="button"
                  className={cx("text-btn small", layout === "mind" && "active")}
                  onClick={() => editor.updateBlock(block, { props: { layout: "mind" } })}
                >
                  左右发散
                </button>
                <button
                  type="button"
                  className={cx("text-btn small", layout === "right" && "active")}
                  onClick={() => editor.updateBlock(block, { props: { layout: "right" } })}
                >
                  向右逻辑树
                </button>
                <select
                  className="mindmap-theme-select"
                  aria-label="导图配色"
                  value={theme}
                  onChange={(e) => editor.updateBlock(block, { props: { theme: e.target.value } })}
                >
                  <option value="rainbow">彩虹分支</option>
                  <option value="ocean">深海靛蓝</option>
                  <option value="forest">松林暖棕</option>
                </select>
                <button
                  type="button"
                  className={cx("text-btn small ai-tag-btn", aiOpen && "active")}
                  onClick={() => setAiBarOpen(!aiOpen)}
                >
                  <Sparkles size={12} /> AI 生成
                </button>
              </div>
              <div className="ai-scope-tabs">
                <button
                  type="button"
                  className={cx("ai-scope-tab", mode === "map" && "active")}
                  onClick={() => editor.updateBlock(block, { props: { mode: "map" } })}
                >
                  <Eye size={12} /> 导图
                </button>
                <button
                  type="button"
                  className={cx("ai-scope-tab", mode === "split" && "active")}
                  onClick={() => editor.updateBlock(block, { props: { mode: "split" } })}
                >
                  <Columns2 size={12} /> 分屏大纲
                </button>
                <button
                  type="button"
                  className={cx("ai-scope-tab", mode === "outline" && "active")}
                  onClick={() => editor.updateBlock(block, { props: { mode: "outline" } })}
                >
                  <Code2 size={12} /> 大纲
                </button>
              </div>
            </div>
          )}

          {editable && aiOpen && (
            <div className="diagram-ai-bar">
              <Sparkles size={13} />
              <input
                autoFocus
                disabled={aiBusy}
                value={aiPrompt}
                placeholder="输入导图中心主题（留空则自动按当前页面内容生成结构化思维导图）…"
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (!e.nativeEvent.isComposing && e.key === "Enter") {
                    e.preventDefault();
                    void runAiMind();
                  } else if (e.key === "Escape") {
                    setAiBarOpen(false);
                  }
                }}
              />
              <button type="button" className="primary-btn small" disabled={aiBusy} onClick={() => void runAiMind()}>
                {aiBusy ? <LoaderCircle size={12} className="spin" /> : "生成导图"}
              </button>
            </div>
          )}

          <div className={cx("mermaid-body", mode === "split" ? "mode-split" : "mode-preview")}>
            {(mode === "outline" || mode === "split") && (
              <textarea
                className="mermaid-editor"
                rows={8}
                spellCheck={false}
                value={block.props.outline}
                placeholder={"按 2 空格缩进编写思维导图大纲，例如：\n- 中心主题\n  - 分支一\n    - 子节点"}
                onChange={(e) => editor.updateBlock(block, { props: { outline: e.target.value } })}
              />
            )}
            {(mode === "map" || mode === "split") && (
              <div className="mermaid-canvas mindmap-canvas">
                <MindMapDiagram
                  outline={block.props.outline}
                  layout={layout}
                  theme={theme}
                  editable={editable}
                  onChangeOutline={(outline) => editor.updateBlock(block, { props: { outline } })}
                />
              </div>
            )}
          </div>
        </div>
      );
    },
    toExternalHTML: ({ block }) => <pre>{block.props.outline}</pre>,
  },
);
