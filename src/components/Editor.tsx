import { useEffect, useMemo, useState } from "react";
import {
  BlockNoteSchema,
  createCodeBlockSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  insertOrUpdateBlockForSlashMenu,
  type PartialBlock,
} from "@blocknote/core";
import { codeBlockOptions, syntaxHighlighter } from "@blocknote/code-block";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { zh } from "@blocknote/core/locales";
import { BlockNoteView } from "@blocknote/mantine";
import {
  SuggestionMenuController,
  createReactInlineContentSpec,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import {
  Bookmark,
  Columns2,
  Columns3,
  FilePlus2,
  FileText,
  FileX2,
  GitBranch,
  Globe,
  Languages,
  Lightbulb,
  Link2,
  ListChecks,
  ListTree,
  MessageSquarePlus,
  MousePointerClick,
  Network,
  PanelTop,
  RefreshCw,
  Sigma,
  Sparkles,
  Table2,
  WandSparkles,
} from "lucide-react";
import { defaultDatabase, shortId } from "../db";
import { MathRenderer } from "../math";
import { AiInlineBar } from "./AiInlineBar";
import {
  createActionButtonBlock,
  createBookmarkBlock,
  createCalloutBlock,
  createEmbedBlock,
  createEquationBlock,
  createMermaidBlock,
  createMindMapBlock,
  createTocBlock,
} from "./blocks";
import { createColumnsBlock, defaultColumns } from "./ColumnsBlock";
import { createDatabaseBlock } from "./database/InlineDatabase";
import { createSyncedBlock, registerNestedEditor } from "./SyncedBlock";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import type { PageRecord } from "../../shared/types";
import {
  createPage,
  flushPatch,
  getState,
  navigate,
  updatePage,
  uploadFile,
  useResolvedTheme,
  useStore,
} from "../store";
import { Popover, cx } from "./Popover";

/** 行内的页面链接（@ 提及）。标题和图标始终取自最新的页面数据。 */
function PageChip({ pageId }: { pageId: string }) {
  const page = useStore((s) => s.pages[pageId]);
  const gone = !page;
  return (
    <span
      className={cx("page-chip", (gone || page.trashed) && "gone")}
      role="link"
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!gone) navigate(pageId);
      }}
    >
      <span className="page-chip-icon">
        {gone ? <FileX2 size={15} /> : (page.icon ?? (page.kind === "database" ? <Table2 size={15} /> : <FileText size={15} />))}
      </span>
      <span className="page-chip-title">{gone ? "已删除的页面" : page.title || "无标题"}</span>
    </span>
  );
}

/** 行内数学公式芯片（如段落内嵌 E = mc^2 或 \frac{a}{b}），点击弹出实时预览公式编辑框 */
function InlineMathChip({ latex, onChange }: { latex: string; onChange: (next: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState(latex);

  useEffect(() => {
    setDraft(latex);
  }, [latex]);

  const commit = () => {
    onChange(draft.trim() || "x");
    setAnchor(null);
  };

  return (
    <>
      <span
        className="inline-math-chip"
        role="button"
        tabIndex={-1}
        title="点击修改行内公式"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <MathRenderer latex={latex || "x"} />
      </span>
      {anchor && (
        <Popover anchor={anchor} onClose={commit} className="inline-math-popover">
          <div className="inline-math-editor">
            <Sigma size={14} className="equation-icon" />
            <input
              autoFocus
              value={draft}
              placeholder="输入行内 LaTeX，如 E = mc^2 或 \frac{\alpha}{\beta}"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (!e.nativeEvent.isComposing && e.key === "Enter") {
                  e.preventDefault();
                  commit();
                }
              }}
            />
          </div>
          {draft.trim() && (
            <div className="inline-math-preview">
              <MathRenderer latex={draft} display />
            </div>
          )}
        </Popover>
      )}
    </>
  );
}

const pageMention = createReactInlineContentSpec(
  {
    type: "pageMention",
    propSchema: { pageId: { default: "" } },
    content: "none",
  },
  {
    render: ({ inlineContent }) => <PageChip pageId={inlineContent.props.pageId} />,
    toExternalHTML: ({ inlineContent }) => {
      const page = getState().pages[inlineContent.props.pageId];
      return <a href={`#/${inlineContent.props.pageId}`}>{page?.title || "无标题"}</a>;
    },
  },
);

const inlineMath = createReactInlineContentSpec(
  {
    type: "inlineMath",
    propSchema: { latex: { default: "E = mc^2" } },
    content: "none",
  },
  {
    render: ({ inlineContent, updateInlineContent }) => (
      <InlineMathChip
        latex={inlineContent.props.latex}
        onChange={(latex) => updateInlineContent({ type: "inlineMath", props: { latex } })}
      />
    ),
    toExternalHTML: ({ inlineContent }) => <code>{`$${inlineContent.props.latex}$`}</code>,
  },
);

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    callout: createCalloutBlock(),
    toc: createTocBlock(),
    equation: createEquationBlock(),
    mermaid: createMermaidBlock(),
    mindmap: createMindMapBlock(),
    embed: createEmbedBlock(),
    actionButton: createActionButtonBlock(),
    columns: createColumnsBlock(),
    bookmark: createBookmarkBlock(),
    database: createDatabaseBlock(),
    synced: createSyncedBlock(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, pageMention, inlineMath },
});

export type NoteEditor = typeof schema.BlockNoteEditor;

interface Props {
  page: PageRecord;
  editable: boolean;
  onReady: (editor: NoteEditor | null) => void;
  /** 内容第一次被修改时调用 */
  onDirty?: () => void;
  /** 同步块或分栏内嵌编辑器的实时内容回调 */
  onContentSync?: (blocks: unknown[]) => void;
  /** 外部（如空白页“AI 帮我写”）触发打开内联 AI 的计数信号 */
  aiTrigger?: number;
  /** 选中正文片段后点击“划词批注”时的回调 */
  onQuoteComment?: (quote: string) => void;
  /** 嵌在别的界面里（同步块、分栏、历史预览）：不提供新建子页面、数据库、同步块的命令 */
  nested?: boolean;
}

export function Editor({ page, editable, onReady, onDirty, onContentSync, aiTrigger, onQuoteComment, nested }: Props) {
  const theme = useResolvedTheme();
  const pageId = page.id;
  // 多列分栏内部的虚拟编辑器使用 __col_ 前缀，只通过 onContentSync 写回外层块，不直接请求后端页面接口
  const isVirtualColumn = pageId.startsWith("__col_");
  const pageTitle = useStore((s) => (isVirtualColumn ? "" : (s.pages[pageId]?.title ?? page.title)));
  const [aiBar, setAiBar] = useState<{
    selectedText: string;
    actionId?: string | null;
    anchorBlockId?: string;
  } | null>(null);
  const [selectedSnippet, setSelectedSnippet] = useState("");

  const editor = useCreateBlockNote({
    schema,
    dictionary: zh,
    initialContent:
      page.content.length > 0
        ? (page.content as PartialBlock<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>[])
        : undefined,
    uploadFile,
    extensions: [syntaxHighlighter],
  });

  useEffect(() => {
    onReady(editor);
    return () => {
      onReady(null);
      if (!isVirtualColumn) void flushPatch(pageId);
    };
  }, [editor, onReady, pageId, isVirtualColumn]);

  useEffect(() => {
    if (aiTrigger && aiTrigger > 0 && editable && !nested) {
      setAiBar({ selectedText: editor.getSelectedText() || "", actionId: null });
    }
  }, [aiTrigger, editable, nested, editor]);

  const openInlineAi = (actionId: string | null = null) => {
    const selText = editor.getSelectedText() || "";
    let anchorBlockId: string | undefined;
    try {
      anchorBlockId = editor.getTextCursorPosition().block.id;
    } catch {
      anchorBlockId = undefined;
    }
    setAiBar({ selectedText: selText, actionId, anchorBlockId });
  };

  const slashItems = useMemo(
    () => async (query: string) => {
      const calloutItem: DefaultReactSuggestionItem = {
        title: "提示框",
        subtext: "带图标和底色的重点提示块",
        aliases: ["callout", "tip", "alert", "note", "tishikuang", "高亮", "提示框"],
        group: "排版与扩展块",
        icon: <Lightbulb size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "callout", props: { icon: "💡", tone: "gray" } });
        },
      };
      const cols2Item: DefaultReactSuggestionItem = {
        title: "双栏布局（2 列）",
        subtext: "左右两列并排编辑，可自由拖动分界线调整列宽",
        aliases: ["columns", "2cols", "two", "fenlan", "shuanglan", "分栏", "两栏", "双栏", "多列"],
        group: "排版与扩展块",
        icon: <Columns2 size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "columns", props: { colsJson: defaultColumns(2) } });
        },
      };
      const cols3Item: DefaultReactSuggestionItem = {
        title: "三栏布局（3 列）",
        subtext: "三列并排排版，适合看板卡片或对比说明",
        aliases: ["columns", "3cols", "three", "sanlan", "分栏", "三栏", "三列"],
        group: "排版与扩展块",
        icon: <Columns3 size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "columns", props: { colsJson: defaultColumns(3) } });
        },
      };
      const tocItem: DefaultReactSuggestionItem = {
        title: "目录",
        subtext: "自动提取本页各级标题并生成跳转大纲",
        aliases: ["toc", "outline", "contents", "mulu", "dagang", "目录", "大纲"],
        group: "排版与扩展块",
        icon: <ListTree size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "toc" });
        },
      };
      const equationItem: DefaultReactSuggestionItem = {
        title: "数学公式（独立块）",
        subtext: "插入支持分式、根号、求和积分与矩阵排版的公式块",
        aliases: ["math", "latex", "equation", "formula", "gongshi", "公式", "数学"],
        group: "排版与扩展块",
        icon: <Sigma size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "equation", props: { latex: "" } });
        },
      };
      const inlineMathItem: DefaultReactSuggestionItem = {
        title: "行内数学公式",
        subtext: "在当前段落文字中嵌入可编辑的数学公式（如 E=mc²）",
        aliases: ["inlinemath", "math", "latex", "hangnei", "行内公式", "内联公式"],
        group: "排版与扩展块",
        icon: <Sigma size={18} />,
        onItemClick: () => {
          editor.insertInlineContent([{ type: "inlineMath", props: { latex: "E = mc^2" } }, " "]);
        },
      };
      const mermaidItem: DefaultReactSuggestionItem = {
        title: "Mermaid 流程图 / 时序图",
        subtext: "用简洁代码实时生成流程图、时序图与饼图",
        aliases: ["mermaid", "diagram", "flowchart", "sequence", "liuchengtu", "shixutu", "流程图", "时序图", "架构图"],
        group: "排版与扩展块",
        icon: <GitBranch size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "mermaid", props: { mode: "split" } });
        },
      };
      const embedItem: DefaultReactSuggestionItem = {
        title: "嵌入 PDF / 视频 / Figma",
        subtext: "在页面内直接阅读本地/在线 PDF，或嵌入 Bilibili、YouTube、Figma",
        aliases: ["embed", "pdf", "bilibili", "youtube", "figma", "iframe", "qianru", "嵌入", "内嵌"],
        group: "排版与扩展块",
        icon: <Globe size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "embed", props: { url: "" } });
        },
      };
      const buttonBlockItem: DefaultReactSuggestionItem = {
        title: "自定义动作按钮",
        subtext: "点击一键插入带时间戳的待办记录、新建子页或唤起 AI",
        aliases: ["button", "action", "anniu", "daka", "按钮", "动作按钮", "打卡"],
        group: "排版与扩展块",
        icon: <MousePointerClick size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "actionButton" });
        },
      };
      const bookmarkItem: DefaultReactSuggestionItem = {
        title: "网页书签",
        subtext: "抓取网页标题与摘要，生成可视书签卡片",
        aliases: ["bookmark", "link", "url", "shuqian", "书签", "链接卡片"],
        group: "排版与扩展块",
        icon: <Bookmark size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "bookmark", props: { url: "" } });
        },
      };

      const mindmapItem: DefaultReactSuggestionItem = {
        title: "思维导图（Mind Map）",
        subtext: "交互式左右发散导图与向右逻辑树，支持节点点击编辑与大纲双视图",
        aliases: ["mindmap", "mind", "siweidaotu", "daotu", "naotu", "思维导图", "导图", "脑图"],
        group: "排版与扩展块",
        icon: <Network size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "mindmap" });
        },
      };

      if (nested) {
        return filterSuggestionItems(
          [
            ...getDefaultReactSlashMenuItems(editor),
            calloutItem,
            equationItem,
            inlineMathItem,
            mermaidItem,
            mindmapItem,
            bookmarkItem,
          ],
          query,
        );
      }

      const aiItems: DefaultReactSuggestionItem[] = [
        {
          title: "AI 写作助手",
          subtext: "起草、改写、翻译、头脑风暴（支持国产/海外/自定义模型）",
          aliases: ["ai", "gpt", "deepseek", "kimi", "qwen", "doubao", "claude", "xiezuo", "助手"],
          group: "AI 助手",
          icon: <Sparkles size={18} />,
          onItemClick: () => openInlineAi(null),
        },
        {
          title: "AI 总结本页",
          subtext: "提炼当前页面的核心结论与要点",
          aliases: ["ai", "summary", "summarize", "zongjie", "总结"],
          group: "AI 助手",
          icon: <WandSparkles size={18} />,
          onItemClick: () => openInlineAi("summarize"),
        },
        {
          title: "AI 顺着续写",
          subtext: "根据上文语境自然往下续写",
          aliases: ["ai", "continue", "xuxie", "续写"],
          group: "AI 助手",
          icon: <Sparkles size={18} />,
          onItemClick: () => openInlineAi("continue"),
        },
        {
          title: "AI 提取待办",
          subtext: "从正文中抽取可执行的复选清单",
          aliases: ["ai", "todo", "action", "daiban", "待办"],
          group: "AI 助手",
          icon: <ListChecks size={18} />,
          onItemClick: () => openInlineAi("todos"),
        },
        {
          title: "AI 翻译本页",
          subtext: "将内容翻译为英文或其他语言",
          aliases: ["ai", "translate", "fanyi", "翻译"],
          group: "AI 助手",
          icon: <Languages size={18} />,
          onItemClick: () => openInlineAi("translate_en"),
        },
      ];

      const subPage: DefaultReactSuggestionItem = {
        title: "子页面",
        subtext: "在当前页面下新建一个页面",
        aliases: ["page", "subpage", "ye", "yemian", "zi", "ziyemian", "页面"],
        group: "页面与数据库",
        icon: <FilePlus2 size={18} />,
        onItemClick: async () => {
          const id = await createPage({ parentId: pageId });
          if (!id) return;
          editor.insertInlineContent([{ type: "pageMention", props: { pageId: id } }, " "]);
          updatePage(pageId, { content: editor.document });
          await flushPatch(pageId);
          navigate(id);
        },
      };
      const dbAliases = ["database", "table", "board", "kanban", "calendar", "list", "chart", "form", "shujuku", "biaoge", "rili", "表格", "看板", "日历", "列表", "图表", "表单"];
      const inlineDatabase: DefaultReactSuggestionItem = {
        title: "数据库（内嵌）",
        subtext: "在正文里直接放一个表格 / 看板 / 图表 / 表单 / 日历",
        aliases: [...dbAliases, "inline", "neiqian", "数据库"],
        group: "页面与数据库",
        icon: <Table2 size={18} />,
        onItemClick: async () => {
          const id = await createPage({ parentId: pageId, kind: "database", database: defaultDatabase("table") });
          if (!id) return;
          insertOrUpdateBlockForSlashMenu(editor, { type: "database", props: { pageId: id, blockKey: shortId() } });
        },
      };
      const fullDatabase: DefaultReactSuggestionItem = {
        title: "数据库（整页）",
        subtext: "新建一个数据库子页面并打开",
        aliases: [...dbAliases, "full", "zhengye", "数据库"],
        group: "页面与数据库",
        icon: <PanelTop size={18} />,
        onItemClick: async () => {
          const id = await createPage({ parentId: pageId, kind: "database", database: defaultDatabase("table") });
          if (!id) return;
          editor.insertInlineContent([{ type: "pageMention", props: { pageId: id } }, " "]);
          updatePage(pageId, { content: editor.document });
          await flushPatch(pageId);
          navigate(id);
        },
      };

      const pages = Object.values(getState().pages).filter((p) => !p.trashed);
      const recent = (list: typeof pages) => list.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);

      const linkedDatabases: DefaultReactSuggestionItem[] = recent(
        pages.filter((p) => p.kind === "database" && !p.hidden),
      ).map((p) => ({
        title: `链接数据库：${p.title || "无标题"}`,
        subtext: "嵌入已有数据库（此处可独立保存专属视图、筛选与排序）",
        aliases: [...dbAliases, "link", "lianjie", "链接", "数据库"],
        group: "页面与数据库",
        icon: <Link2 size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, {
            type: "database",
            props: { pageId: p.id, blockKey: shortId(), linked: "true" },
          });
        },
      }));

      const syncAliases = ["sync", "synced", "tongbu", "同步", "同步块"];
      const newSynced: DefaultReactSuggestionItem = {
        title: "新建同步块",
        subtext: "新建一块可以在多个页面里实时同步显示的内容",
        aliases: syncAliases,
        group: "同步块",
        icon: <RefreshCw size={18} />,
        onItemClick: async () => {
          const id = await createPage({ hidden: true });
          if (!id) return;
          insertOrUpdateBlockForSlashMenu(editor, { type: "synced", props: { sourceId: id } });
        },
      };
      const existingSynced: DefaultReactSuggestionItem[] = recent(pages.filter((p) => p.hidden)).map((p) => ({
        title: `同步块：${p.title || "未命名"}`,
        subtext: "插入这个已有的同步块",
        aliases: syncAliases,
        group: "同步块",
        icon: <RefreshCw size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "synced", props: { sourceId: p.id } });
        },
      }));

      return filterSuggestionItems(
        [
          ...aiItems,
          cols2Item,
          cols3Item,
          calloutItem,
          tocItem,
          equationItem,
          inlineMathItem,
          mermaidItem,
          mindmapItem,
          embedItem,
          buttonBlockItem,
          bookmarkItem,
          ...getDefaultReactSlashMenuItems(editor),
          subPage,
          inlineDatabase,
          fullDatabase,
          ...linkedDatabases,
          newSynced,
          ...existingSynced,
        ],
        query,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, pageId, nested],
  );

  const mentionItems = useMemo(
    () => async (query: string) => {
      const items: DefaultReactSuggestionItem[] = Object.values(getState().pages)
        .filter((p) => !p.trashed && !p.hidden && p.id !== pageId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((p) => ({
          title: p.title || "无标题",
          icon: <span className="mention-item-icon">{p.icon ?? <FileText size={18} />}</span>,
          onItemClick: () => {
            editor.insertInlineContent([{ type: "pageMention", props: { pageId: p.id } }, " "]);
          },
        }));
      return filterSuggestionItems(items, query).slice(0, 12);
    },
    [editor, pageId],
  );

  const handleAiInsert = async (markdown: string, mode: "insert" | "replace") => {
    const parsed = await editor.tryParseMarkdownToBlocks(markdown);
    if (parsed.length === 0) {
      setAiBar(null);
      return;
    }
    const sel = editor.getSelection();
    if (mode === "replace" && sel && sel.blocks.length > 0) {
      editor.replaceBlocks(sel.blocks, parsed);
    } else {
      const anchor =
        (aiBar?.anchorBlockId && editor.document.find((b) => b.id === aiBar.anchorBlockId)) ||
        editor.document[editor.document.length - 1];
      if (anchor) editor.insertBlocks(parsed, anchor, "after");
      else editor.replaceBlocks(editor.document, parsed);
    }
    onDirty?.();
    if (!isVirtualColumn) updatePage(pageId, { content: editor.document });
    setAiBar(null);
  };

  return (
    <div className="editor-wrap">
      {editable && !nested && selectedSnippet && !aiBar && (
        <div className="ai-selection-pill">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => openInlineAi(null)}
          >
            <Sparkles size={13} /> AI 改写 / 翻译
          </button>
          {onQuoteComment && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onQuoteComment(selectedSnippet);
                setSelectedSnippet("");
              }}
            >
              <MessageSquarePlus size={13} /> 划词批注
            </button>
          )}
        </div>
      )}
      {aiBar && !nested && (
        <AiInlineBar
          pageTitle={pageTitle}
          selectedText={aiBar.selectedText}
          initialActionId={aiBar.actionId}
          getPageMarkdown={() => editor.blocksToMarkdownLossy(editor.document)}
          onInsert={handleAiInsert}
          onClose={() => setAiBar(null)}
        />
      )}
      <BlockNoteView
        editor={editor}
        theme={theme}
        editable={editable}
        slashMenu={false}
        onSelectionChange={() => {
          if (!editable || nested) return;
          setSelectedSnippet(editor.getSelectedText().trim());
        }}
        onChange={() => {
          if (!editable) return;
          onDirty?.();
          onContentSync?.(editor.document);
          if (!isVirtualColumn) updatePage(pageId, { content: editor.document });
        }}
      >
        <SuggestionMenuController triggerCharacter="/" getItems={slashItems} />
        <SuggestionMenuController triggerCharacter="@" getItems={mentionItems} />
      </BlockNoteView>
    </div>
  );
}

// 同步块和分栏块里嵌的也是这个编辑器；在这里登记，避免互相引用
registerNestedEditor(Editor as unknown as Parameters<typeof registerNestedEditor>[0]);
