import crypto from "node:crypto";
import type { PageMeta, PageRecord } from "../shared/types.ts";

const blkId = () => crypto.randomBytes(6).toString("hex");

interface InlineNode {
  type: string;
  text?: string;
  href?: string;
  styles?: Record<string, boolean>;
  props?: Record<string, unknown>;
  content?: InlineNode[];
}

export interface BlockObj {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: BlockObj[];
}

/**
 * 解析单行行内富文本（支持 **粗体**、*斜体*、`代码`、~~删除线~~、[链接](url)、$公式$ 及 [[双链]]）
 */
export function parseInlineMarkdown(
  text: string,
  resolveWikiLink?: (title: string) => string | null,
): InlineNode[] {
  const out: InlineNode[] = [];
  const tokenRe =
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\$([^$\n]+)\$|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ type: "text", text: text.slice(last, m.index), styles: {} });
    }
    if (m[1] !== undefined) {
      const targetTitle = m[1].trim();
      const pageId = resolveWikiLink?.(targetTitle) ?? null;
      if (pageId) {
        out.push({ type: "pageMention", props: { pageId } });
      } else {
        out.push({ type: "text", text: m[2]?.trim() || targetTitle, styles: { bold: true } });
      }
    } else if (m[3] !== undefined) {
      out.push({ type: "inlineMath", props: { latex: m[3].trim() } });
    } else if (m[4] !== undefined) {
      out.push({ type: "text", text: m[4], styles: { code: true } });
    } else if (m[5] !== undefined) {
      out.push({ type: "text", text: m[5], styles: { bold: true } });
    } else if (m[6] !== undefined) {
      out.push({ type: "text", text: m[6], styles: { italic: true } });
    } else if (m[7] !== undefined) {
      out.push({ type: "text", text: m[7], styles: { strike: true } });
    } else if (m[8] !== undefined && m[9] !== undefined) {
      out.push({
        type: "link",
        href: m[9],
        content: [{ type: "text", text: m[8], styles: {} }],
      });
    }
    last = m.index + m[0].length;
  }

  if (last < text.length) {
    out.push({ type: "text", text: text.slice(last), styles: {} });
  }
  return out;
}

/**
 * 将标准 Markdown 文本（含 YAML Frontmatter 可选剥离）转换为原生 BlockNote 块数组
 */
export function markdownToBlocks(
  rawMd: string,
  resolveWikiLink?: (title: string) => string | null,
): { blocks: BlockObj[]; frontmatter: { title?: string; tags?: string[]; icon?: string } } {
  let md = rawMd.replace(/\r\n/g, "\n");
  const frontmatter: { title?: string; tags?: string[]; icon?: string } = {};

  // 解析 YAML Frontmatter（兼容 Obsidian / EdgeEver 备份文件）
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  if (fmMatch) {
    md = md.slice(fmMatch[0].length);
    const fmBody = fmMatch[1];
    const titleM = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fmBody);
    if (titleM) frontmatter.title = titleM[1].trim();
    const iconM = /^icon:\s*["']?(.+?)["']?\s*$/m.exec(fmBody);
    if (iconM) frontmatter.icon = iconM[1].trim();
    const inlineTagsM = /^tags:\s*\[([^\]]*)\]/m.exec(fmBody);
    if (inlineTagsM) {
      frontmatter.tags = inlineTagsM[1]
        .split(",")
        .map((s) => s.trim().replace(/^["'#]+|["']+$/g, ""))
        .filter(Boolean);
    } else {
      const listTagsM = /^tags:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(fmBody);
      if (listTagsM) {
        frontmatter.tags = listTagsM[1]
          .split("\n")
          .map((l) => l.replace(/^\s*-\s*/, "").trim().replace(/^["'#]+|["']+$/g, ""))
          .filter(Boolean);
      }
    }
  }

  const lines = md.split("\n");
  const blocks: BlockObj[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 围栏代码块（自动识别 mermaid / mindmap）
    const fence = /^```([A-Za-z0-9_+-]*)\s*$/.exec(trimmed);
    if (fence) {
      const lang = fence[1].toLowerCase();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const code = buf.join("\n");
      if (lang === "mermaid") {
        blocks.push({ id: blkId(), type: "mermaid", props: { code, mode: "preview" } });
      } else if (lang === "mindmap") {
        blocks.push({ id: blkId(), type: "mindmap", props: { outline: code, layout: "mind", theme: "rainbow", mode: "map" } });
      } else {
        blocks.push({
          id: blkId(),
          type: "codeBlock",
          props: { language: lang || "text" },
          content: [{ type: "text", text: code, styles: {} }],
        });
      }
      continue;
    }

    // 块级公式 $$ ... $$
    if (trimmed.startsWith("$$")) {
      if (trimmed.endsWith("$$") && trimmed.length > 4) {
        blocks.push({ id: blkId(), type: "equation", props: { latex: trimmed.slice(2, -2).trim() } });
        i++;
        continue;
      }
      const eqLines: string[] = [trimmed.slice(2)];
      i++;
      while (i < lines.length && !lines[i].trim().endsWith("$$")) {
        eqLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        eqLines.push(lines[i].trim().slice(0, -2));
        i++;
      }
      blocks.push({ id: blkId(), type: "equation", props: { latex: eqLines.join("\n").trim() } });
      continue;
    }

    // 分隔线
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ id: blkId(), type: "divider" });
      i++;
      continue;
    }

    // 标题 # ~ ###
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(3, heading[1].length);
      blocks.push({
        id: blkId(),
        type: "heading",
        props: { level },
        content: parseInlineMarkdown(heading[2].trim(), resolveWikiLink),
      });
      i++;
      continue;
    }

    // 独立图片 ![alt](url)
    const imgM = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(trimmed);
    if (imgM) {
      blocks.push({
        id: blkId(),
        type: "image",
        props: { url: imgM[2], caption: imgM[1] || "" },
      });
      i++;
      continue;
    }

    // Markdown 表格
    if (trimmed.startsWith("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1])) {
      const parseRow = (rowLine: string) =>
        rowLine
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => ({
            type: "tableCell",
            content: parseInlineMarkdown(cell.trim(), resolveWikiLink),
          }));
      const rows = [
        { cells: parseRow(line) },
      ];
      i += 2; // 跳过分隔行
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push({ cells: parseRow(lines[i]) });
        i++;
      }
      blocks.push({
        id: blkId(),
        type: "table",
        content: { type: "tableContent", rows },
      });
      continue;
    }

    // 引用与 Callout (> [!NOTE] ...)
    if (trimmed.startsWith(">")) {
      const qLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        qLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      const calloutM = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(qLines[0] ?? "");
      if (calloutM) {
        const kind = calloutM[1].toUpperCase();
        const tone = kind === "WARNING" || kind === "CAUTION" ? "amber" : kind === "TIP" ? "green" : "blue";
        const icon = kind === "WARNING" || kind === "CAUTION" ? "⚠️" : kind === "TIP" ? "💡" : "📌";
        const body = [calloutM[2], ...qLines.slice(1)].filter(Boolean).join(" ");
        blocks.push({
          id: blkId(),
          type: "callout",
          props: { icon, tone },
          content: parseInlineMarkdown(body || kind, resolveWikiLink),
        });
      } else {
        blocks.push({
          id: blkId(),
          type: "quote",
          content: parseInlineMarkdown(qLines.join(" "), resolveWikiLink),
        });
      }
      continue;
    }

    // 待办事项 - [ ] / - [x]
    const todo = /^[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(trimmed);
    if (todo) {
      blocks.push({
        id: blkId(),
        type: "checkListItem",
        props: { checked: todo[1].toLowerCase() === "x" },
        content: parseInlineMarkdown(todo[2], resolveWikiLink),
      });
      i++;
      continue;
    }

    // 无序列表
    const bullet = /^[-*+]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      blocks.push({
        id: blkId(),
        type: "bulletListItem",
        content: parseInlineMarkdown(bullet[1], resolveWikiLink),
      });
      i++;
      continue;
    }

    // 有序列表
    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (ordered) {
      blocks.push({
        id: blkId(),
        type: "numberedListItem",
        content: parseInlineMarkdown(ordered[1], resolveWikiLink),
      });
      i++;
      continue;
    }

    // 普通段落
    blocks.push({
      id: blkId(),
      type: "paragraph",
      content: parseInlineMarkdown(trimmed, resolveWikiLink),
    });
    i++;
  }

  return { blocks, frontmatter };
}

function inlineToMarkdown(content: unknown, pageTitles?: Map<string, string>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const node = item as Record<string, unknown>;
      if (node.type === "pageMention") {
        const pid = (node.props as Record<string, unknown> | undefined)?.pageId;
        const title = typeof pid === "string" ? (pageTitles?.get(pid) ?? pid) : "页面";
        return `[[${title}]]`;
      }
      if (node.type === "inlineMath") {
        const latex = (node.props as Record<string, unknown> | undefined)?.latex;
        return typeof latex === "string" ? `$${latex}$` : "";
      }
      if (node.type === "link") {
        const label = inlineToMarkdown(node.content, pageTitles);
        const href = typeof node.href === "string" ? node.href : "";
        return href ? `[${label || href}](${href})` : label;
      }
      let txt = typeof node.text === "string" ? node.text : "";
      if (!txt) return "";
      const styles = (node.styles ?? {}) as Record<string, boolean>;
      if (styles.code) txt = `\`${txt}\``;
      if (styles.bold) txt = `**${txt}**`;
      if (styles.italic) txt = `*${txt}*`;
      if (styles.strike) txt = `~~${txt}~~`;
      return txt;
    })
    .join("");
}

/**
 * 将 BlockNote 块树无损输出为干净易读的 Markdown 正文
 */
export function blocksToMarkdown(blocks: unknown[], pageTitles?: Map<string, string>, indent = ""): string {
  if (!Array.isArray(blocks)) return "";
  const lines: string[] = [];

  blocks.forEach((raw, idx) => {
    if (!raw || typeof raw !== "object") return;
    const b = raw as Record<string, unknown>;
    const type = typeof b.type === "string" ? b.type : "paragraph";
    const props = (b.props ?? {}) as Record<string, unknown>;
    const text = inlineToMarkdown(b.content, pageTitles);

    switch (type) {
      case "heading": {
        const lvl = typeof props.level === "number" ? Math.max(1, Math.min(6, props.level)) : 1;
        lines.push(`${indent}${"#".repeat(lvl)} ${text}`);
        break;
      }
      case "bulletListItem":
        lines.push(`${indent}- ${text}`);
        break;
      case "numberedListItem":
        lines.push(`${indent}${idx + 1}. ${text}`);
        break;
      case "checkListItem":
        lines.push(`${indent}- [${props.checked ? "x" : " "}] ${text}`);
        break;
      case "quote":
        lines.push(`${indent}> ${text}`);
        break;
      case "callout":
        lines.push(`${indent}> [!NOTE] ${props.icon ? `${props.icon} ` : ""}${text}`);
        break;
      case "codeBlock":
        lines.push(`${indent}\`\`\`${typeof props.language === "string" ? props.language : ""}\n${text}\n${indent}\`\`\``);
        break;
      case "mermaid":
        lines.push(`${indent}\`\`\`mermaid\n${typeof props.code === "string" ? props.code : ""}\n${indent}\`\`\``);
        break;
      case "mindmap":
        lines.push(`${indent}\`\`\`mindmap\n${typeof props.outline === "string" ? props.outline : ""}\n${indent}\`\`\``);
        break;
      case "equation":
        lines.push(`${indent}$$\n${typeof props.latex === "string" ? props.latex : ""}\n${indent}$$`);
        break;
      case "divider":
        lines.push(`${indent}---`);
        break;
      case "image":
        if (typeof props.url === "string" && props.url) {
          lines.push(`${indent}![${typeof props.caption === "string" ? props.caption : ""}](${props.url})`);
        }
        break;
      case "bookmark":
      case "embed":
        if (typeof props.url === "string" && props.url) {
          lines.push(`${indent}[${typeof props.title === "string" && props.title ? props.title : props.url}](${props.url})`);
        }
        break;
      case "columns":
        if (typeof props.colsJson === "string") {
          try {
            const cols = JSON.parse(props.colsJson) as { content?: unknown[] }[];
            if (Array.isArray(cols)) {
              for (const col of cols) {
                if (Array.isArray(col.content)) {
                  const sub = blocksToMarkdown(col.content, pageTitles, indent);
                  if (sub.trim()) lines.push(sub);
                }
              }
            }
          } catch {
            /* 忽略 */
          }
        }
        break;
      case "table": {
        const tc = b.content as { rows?: { cells?: unknown[] }[] } | undefined;
        if (tc && Array.isArray(tc.rows) && tc.rows.length > 0) {
          tc.rows.forEach((row, rIdx) => {
            const cells = (row.cells ?? []).map((cell) => {
              if (Array.isArray(cell)) return inlineToMarkdown(cell, pageTitles);
              if (cell && typeof cell === "object" && "content" in cell) {
                return inlineToMarkdown((cell as { content: unknown }).content, pageTitles);
              }
              return "";
            });
            lines.push(`| ${cells.join(" | ")} |`);
            if (rIdx === 0) {
              lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
            }
          });
        }
        break;
      }
      default:
        if (text) lines.push(`${indent}${text}`);
        break;
    }

    if (Array.isArray(b.children) && b.children.length > 0) {
      const childMd = blocksToMarkdown(b.children, pageTitles, `${indent}  `);
      if (childMd) lines.push(childMd);
    }
  });

  return lines.join("\n\n");
}

/**
 * 将单个页面或数据库完整导出为带 YAML Frontmatter 的纯文本 Markdown 文档
 */
export function pageRecordToMarkdown(
  page: PageRecord,
  allPages: Map<string, PageMeta>,
): string {
  const titleMap = new Map<string, string>();
  for (const [id, p] of allPages) titleMap.set(id, p.title || "无标题");

  const fmLines = ["---"];
  fmLines.push(`title: ${JSON.stringify(page.title || "无标题")}`);
  if (page.icon) fmLines.push(`icon: ${JSON.stringify(page.icon)}`);
  if (page.tags && page.tags.length > 0) {
    fmLines.push(`tags: [${page.tags.map((t) => JSON.stringify(t)).join(", ")}]`);
  }
  fmLines.push(`updatedAt: "${new Date(page.updatedAt).toISOString()}"`);
  fmLines.push("---", "");

  const parts: string[] = [fmLines.join("\n")];
  parts.push(`# ${page.icon ? `${page.icon} ` : ""}${page.title || "无标题"}`);

  if (page.kind === "database" && page.database) {
    const props = page.database.properties;
    const rows = [...allPages.values()]
      .filter((r) => r.parentId === page.id && !r.trashed && !r.hidden)
      .sort((a, b) => a.order - b.order);
    const headers = ["名称", ...props.map((p) => p.name)];
    const tableLines = [
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
    ];
    for (const row of rows) {
      const vals = props.map((def) => {
        const raw = row.props[def.id];
        if (raw === null || raw === undefined) return "";
        if (def.type === "select" && typeof raw === "string") {
          return def.options?.find((o) => o.id === raw)?.name ?? raw;
        }
        if (def.type === "multiSelect" && Array.isArray(raw)) {
          return raw.map((id) => def.options?.find((o) => o.id === id)?.name ?? id).join("、");
        }
        if (Array.isArray(raw)) {
          return raw.map((id) => titleMap.get(id) ?? id).join("、");
        }
        return String(raw).replace(/\|/g, "\\|");
      });
      tableLines.push(`| ${(row.title || "无标题").replace(/\|/g, "\\|")} | ${vals.join(" | ")} |`);
    }
    parts.push(tableLines.join("\n"));
  } else {
    const body = blocksToMarkdown(page.content, titleMap);
    if (body) parts.push(body);
  }

  return `${parts.join("\n\n")}\n`;
}
