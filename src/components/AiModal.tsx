import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Copy,
  Eraser,
  FilePlus2,
  FileText,
  KeyRound,
  Layers,
  ListChecks,
  LoaderCircle,
  PenLine,
  Settings,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { AiChatMessage } from "../../shared/types";
import { loadAiConfig, saveAiConfig, streamAiChat, useAiConfig } from "../ai";
import { INITIAL_AI_CHAT_STATE, transitionAiChat, useMachine, type AiChatTurn } from "../machines";
import { getHeadlessParserEditor } from "../notionImport";
import {
  createPage,
  fetchPage,
  flushPatch,
  navigate,
  reloadPageContent,
  reportError,
  setAiOpen,
  setAiSettingsOpen,
  updatePage,
  useStore,
} from "../store";
import { cx } from "./Popover";

const STARTERS = [
  {
    icon: Layers,
    label: "梳理工作区进展",
    prompt: "请梳理我工作区里各个页面和数据库的主要内容与待办进展。",
    scope: "workspace" as const,
  },
  {
    icon: ListChecks,
    label: "查找未完成任务",
    prompt: "帮我列出工作区数据库和笔记里所有未完成的任务或待办事项。",
    scope: "workspace" as const,
  },
  {
    icon: FileText,
    label: "总结当前页面",
    prompt: "请提炼并总结当前页面的核心要点和行动项。",
    scope: "page" as const,
  },
  {
    icon: PenLine,
    label: "起草方案框架",
    prompt: "帮我起草一份清晰的产品功能设计文档框架，包含背景、目标、方案对比与里程碑。",
    scope: "none" as const,
  },
];

export function AiModal({ currentPageId }: { currentPageId: string | null }) {
  const cfg = useAiConfig();
  const currentPage = useStore((s) => (currentPageId ? s.pages[currentPageId] : undefined));
  const [scope, setScope] = useState<"workspace" | "page" | "none">(currentPageId ? "workspace" : "none");
  const [chatState, sendChat] = useMachine(transitionAiChat, INITIAL_AI_CHAT_STATE);
  const [input, setInput] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const turns = chatState.turns;
  const running = chatState.phase === "streaming";
  const applying = chatState.phase === "applying";

  useEffect(() => {
    if (!cfg) void loadAiConfig().catch(() => {});
  }, [cfg]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  const activeProvider = cfg?.providers.find((p) => p.id === cfg.activeProviderId) ?? cfg?.providers[0];
  const configured = Boolean(activeProvider && (activeProvider.hasKey || activeProvider.keyOptional));
  const shortProviderName = activeProvider?.name.replace(/（.+）/, "") ?? "当前模型";

  const sendPrompt = async (promptText?: string, forceScope?: "workspace" | "page" | "none") => {
    const text = (promptText ?? input).trim();
    if (!text || chatState.phase !== "idle") return;
    const useScope = forceScope ?? scope;
    if (forceScope) setScope(forceScope);
    if (!promptText) setInput("");

    const userTurn: AiChatTurn = { id: `${Date.now()}-u`, role: "user", content: text };
    const assistantTurn: AiChatTurn = { id: `${Date.now()}-a`, role: "assistant", content: "" };
    const historyMessages: AiChatMessage[] = [
      ...turns
        .filter((t) => !t.error && t.content.trim())
        .map((t) => ({ role: t.role, content: t.content })),
      { role: "user", content: text },
    ];

    sendChat({ type: "SUBMIT", userTurn, assistantTurn });
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      await streamAiChat({
        messages: historyMessages,
        scope: useScope,
        pageId: currentPageId,
        signal: ctrl.signal,
        onCitations: (citations) => sendChat({ type: "CITATIONS", citations }),
        onReasoning: (_d, full) => sendChat({ type: "REASONING", full }),
        onDelta: (_d, full) => sendChat({ type: "DELTA", full }),
      });
      sendChat({ type: "COMPLETE" });
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        sendChat({ type: "FAIL", message });
      }
    } finally {
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    sendChat({ type: "STOP" });
  };

  const saveAsNewPage = async (markdown: string) => {
    if (chatState.phase !== "idle") return;
    sendChat({ type: "APPLY_START" });
    try {
      const editor = getHeadlessParserEditor();
      const headingMatch = /^#\s+(.+)$/m.exec(markdown);
      const title = headingMatch?.[1]?.trim() || "AI 生成笔记";
      const bodyMd = headingMatch ? markdown.replace(/^#\s+.+\n?/, "").trim() : markdown;
      const blocks = bodyMd ? await editor.tryParseMarkdownToBlocks(bodyMd) : [];
      const id = await createPage({ title, icon: "✨", content: blocks });
      if (id) {
        setAiOpen(false);
        navigate(id);
      }
    } catch (err) {
      reportError(err);
    } finally {
      sendChat({ type: "APPLY_DONE" });
    }
  };

  const appendToCurrentPage = async (markdown: string) => {
    if (chatState.phase !== "idle") return;
    if (!currentPageId || !currentPage || currentPage.kind === "database" || currentPage.trashed || currentPage.locked) return;
    sendChat({ type: "APPLY_START" });
    try {
      const editor = getHeadlessParserEditor();
      const blocks = await editor.tryParseMarkdownToBlocks(markdown);
      const record = await fetchPage(currentPageId);
      updatePage(currentPageId, { content: [...record.content, ...blocks] });
      await flushPatch(currentPageId);
      reloadPageContent(currentPageId);
      setAiOpen(false);
    } catch (err) {
      reportError(err);
    } finally {
      sendChat({ type: "APPLY_DONE" });
    }
  };

  const canAppendCurrent =
    Boolean(currentPage && currentPage.kind === "page" && !currentPage.trashed && !currentPage.locked);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setAiOpen(false)}>
      <div
        className="ai-modal"
        role="dialog"
        aria-modal="true"
        aria-label="AI 助手"
        data-ai-modal-state={chatState.phase}
      >
        <header className="ai-modal-head">
          <span className="ai-brand">
            <span className="ai-brand-badge">
              <Sparkles size={14} />
            </span>
            <span>AI 助手</span>
          </span>
          <div className="ai-scope-tabs" role="tablist" aria-label="问答范围">
            <button
              type="button"
              className={cx("ai-scope-tab", scope === "workspace" && "active")}
              onClick={() => setScope("workspace")}
            >
              全工作区
            </button>
            {currentPage && (
              <button
                type="button"
                className={cx("ai-scope-tab", scope === "page" && "active")}
                onClick={() => setScope("page")}
              >
                当前页面
              </button>
            )}
            <button
              type="button"
              className={cx("ai-scope-tab", scope === "none" && "active")}
              onClick={() => setScope("none")}
            >
              自由对话
            </button>
          </div>
          <div className="ai-head-right">
            {cfg && (
              <select
                className="ai-model-select"
                aria-label="切换模型"
                value={`${cfg.activeProviderId}::${cfg.activeModel}`}
                onChange={(e) => {
                  const [providerId, model] = e.target.value.split("::");
                  void saveAiConfig({ activeProviderId: providerId, activeModel: model });
                }}
              >
                {cfg.providers.map((p) => (
                  <optgroup
                    key={p.id}
                    label={`${p.name}${p.hasKey || p.keyOptional ? "" : "（未配置）"}`}
                  >
                    {p.models.map((m) => (
                      <option key={`${p.id}::${m}`} value={`${p.id}::${m}`}>
                        {p.name.replace(/（.+）/, "")} · {m}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
            <button
              type="button"
              className="icon-btn"
              title="模型设置"
              aria-label="模型设置"
              onClick={() => setAiSettingsOpen(true)}
            >
              <Settings size={16} />
            </button>
            {turns.length > 0 && (
              <button
                type="button"
                className="icon-btn"
                title="清空对话"
                aria-label="清空对话"
                disabled={running || applying}
                onClick={() => sendChat({ type: "CLEAR" })}
              >
                <Eraser size={16} />
              </button>
            )}
            <button type="button" className="icon-btn" aria-label="关闭" onClick={() => setAiOpen(false)}>
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="ai-messages" ref={scrollRef}>
          {!configured && (
            <div className="ai-setup-card">
              <span className="ai-setup-icon">
                <KeyRound size={15} />
              </span>
              <div className="ai-setup-text">
                <strong>尚未配置 {shortProviderName} 的密钥</strong>
                <span>支持接入 DeepSeek、Kimi、豆包、千问、Claude、OpenAI、Gemini、Ollama 及任意自定义接口。</span>
              </div>
              <button type="button" className="primary-btn small" onClick={() => setAiSettingsOpen(true)}>
                配置模型
              </button>
            </div>
          )}

          {turns.length === 0 ? (
            <div className="ai-welcome">
              <div className="ai-welcome-head">
                <div className="ai-welcome-title">有什么可以帮你？</div>
                <p className="ai-welcome-sub">
                  检索本地笔记与数据库精准作答，或在编辑器中输入 <code>/ai</code> 就地续写、润色与翻译。
                </p>
              </div>
              <div className="ai-starter-grid">
                {STARTERS.filter((s) => s.scope !== "page" || currentPage).map((s) => {
                  const Icon = s.icon;
                  return (
                    <button
                      key={s.label}
                      type="button"
                      className="ai-starter-card"
                      onClick={() => void sendPrompt(s.prompt, s.scope)}
                    >
                      <span className="ai-starter-head">
                        <Icon size={14} className="ai-starter-icon" />
                        <strong>{s.label}</strong>
                      </span>
                      <span className="ai-starter-desc">{s.prompt}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            turns.map((turn) => (
              <div key={turn.id} className={cx("ai-turn", `ai-turn-${turn.role}`)}>
                <div className="ai-turn-role">{turn.role === "user" ? "我" : <Sparkles size={13} />}</div>
                <div className="ai-turn-body">
                  {turn.citations && turn.citations.length > 0 && (
                    <div className="ai-citations">
                      <span>引用来源</span>
                      {turn.citations.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className="row-chip row-chip-button"
                          onClick={() => {
                            setAiOpen(false);
                            navigate(c.id);
                          }}
                        >
                          <span className="row-chip-icon">{c.icon ?? <FileText size={12} />}</span>
                          <span className="tag-name">{c.title || "无标题"}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {turn.reasoning && (
                    <details className="ai-reasoning">
                      <summary>思考过程</summary>
                      <pre>{turn.reasoning}</pre>
                    </details>
                  )}
                  {turn.error ? (
                    <div className="value-error">
                      {turn.error}{" "}
                      <button type="button" className="ghost-btn small" onClick={() => setAiSettingsOpen(true)}>
                        打开模型设置
                      </button>
                    </div>
                  ) : turn.content ? (
                    <div className="ai-markdown">{turn.content}</div>
                  ) : (
                    <span className="ai-thinking">
                      <LoaderCircle size={14} className="spin" /> 正在思考…
                    </span>
                  )}
                  {turn.role === "assistant" && turn.content && !running && (
                    <div className="ai-turn-actions">
                      <button
                        type="button"
                        className="ghost-btn small"
                        onClick={() => {
                          void navigator.clipboard?.writeText(turn.content);
                          setCopiedId(turn.id);
                          window.setTimeout(() => setCopiedId(null), 1500);
                        }}
                      >
                        {copiedId === turn.id ? <Check size={13} /> : <Copy size={13} />} 复制
                      </button>
                      <button
                        type="button"
                        className="ghost-btn small"
                        disabled={applying}
                        onClick={() => void saveAsNewPage(turn.content)}
                      >
                        <FilePlus2 size={13} /> {applying ? "写入中…" : "存为新页面"}
                      </button>
                      {canAppendCurrent && (
                        <button
                          type="button"
                          className="ghost-btn small"
                          disabled={applying}
                          onClick={() => void appendToCurrentPage(turn.content)}
                        >
                          插入当前页末尾
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <form
          className="ai-composer-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void sendPrompt();
          }}
        >
          <div className="ai-composer">
            <textarea
              autoFocus
              rows={2}
              value={input}
              placeholder={
                scope === "workspace"
                  ? "向整个本地工作区提问，或让 AI 帮你梳理资料…"
                  : scope === "page"
                    ? `围绕《${currentPage?.title || "当前页面"}》提问或生成内容…`
                    : "输入任何问题、提纲或写作要求…"
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendPrompt();
                }
              }}
            />
            <div className="ai-composer-foot">
              <span className="ai-composer-hint">
                {scope === "workspace"
                  ? "检索本地笔记与数据库 · Enter 发送，Shift+Enter 换行"
                  : scope === "page"
                    ? `仅参考当前页面《${currentPage?.title || "无标题"}》 · Enter 发送`
                    : "自由对话 · Enter 发送，Shift+Enter 换行"}
              </span>
              {running ? (
                <button type="button" className="primary-btn small danger-btn" onClick={stop}>
                  <Square size={12} /> 停止
                </button>
              ) : (
                <button type="submit" className="ai-send-btn" disabled={!input.trim()} aria-label="发送">
                  <ArrowUp size={15} />
                  <span>发送</span>
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
