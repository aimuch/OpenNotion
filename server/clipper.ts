import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { markdownToBlocks, parseInlineMarkdown, type BlockObj } from "./markdownBridge.ts";

const blkId = () => crypto.randomBytes(6).toString("hex");

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 127 || parts[0] === 10 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice(7);
    if (net.isIPv4(tail)) return isPrivateIp(tail);
    const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hexPair) {
      const hi = parseInt(hexPair[1], 16);
      const lo = parseInt(hexPair[2], 16);
      return isPrivateIp(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    return true;
  }
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80")
  );
}

async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error("无效的网址格式");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("仅支持剪藏 http / https 网页链接");
  }
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("安全策略不允许抓取本机或内网地址");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("安全策略不允许抓取内网地址");
    return target;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error("安全策略不允许抓取内网地址");
  }
  return target;
}

async function fetchHtmlSafely(rawUrl: string): Promise<{ finalUrl: string; html: string }> {
  let current = await assertPublicUrl(rawUrl);
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(current.href, {
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      current = await assertPublicUrl(new URL(loc, current.href).href);
      continue;
    }

    if (!res.ok) {
      throw new Error(`抓取网页失败（HTTP ${res.status}）`);
    }
    if (!res.body) throw new Error("网页响应正文为空");

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const MAX_BYTES = 2 * 1024 * 1024; // 最多读取 2MB HTML
    while (size < MAX_BYTES) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
    }
    void reader.cancel().catch(() => {});
    const html = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
    return { finalUrl: current.href, html };
  }
  throw new Error("网页重定向次数过多");
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

function stripTagsToInlineMd(fragment: string, baseUrl: string): string {
  let s = fragment
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**")
    .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*")
    .replace(/<(?:code)\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<(?:del|s)\b[^>]*>([\s\S]*?)<\/(?:del|s)>/gi, "~~$1~~")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const cleanLabel = decodeEntities(label.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
      if (!cleanLabel) return "";
      try {
        const resolved = new URL(decodeEntities(href), baseUrl).href;
        if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
          return `[${cleanLabel}](${resolved})`;
        }
      } catch {
        /* 忽略非法链接 */
      }
      return cleanLabel;
    })
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s).replace(/\s+/g, " ").trim();
  return s;
}

const SITE_LABELS: [RegExp, string][] = [
  [/mp\.weixin\.qq\.com/i, "微信公众号"],
  [/zhihu\.com/i, "知乎"],
  [/github\.com/i, "GitHub"],
  [/juejin\.cn/i, "稀土掘金"],
  [/xiaohongshu\.com/i, "小红书"],
  [/medium\.com/i, "Medium"],
  [/reddit\.com/i, "Reddit"],
  [/bilibili\.com/i, "Bilibili"],
  [/x\.com|twitter\.com/i, "X"],
  [/news\.ycombinator\.com/i, "Hacker News"],
];

function inferSiteName(urlStr: string, ogSite: string): string {
  for (const [re, label] of SITE_LABELS) {
    if (re.test(urlStr)) return label;
  }
  if (ogSite) return ogSite;
  try {
    return new URL(urlStr).hostname.replace(/^www\./, "");
  } catch {
    return "网页剪藏";
  }
}

/**
 * 提取核心阅读区域 HTML，优先匹配微信公众号、知乎、GitHub、Medium 及语义化 <article> / <main>
 */
function extractMainHtml(fullHtml: string): string {
  // 先剔除无关脚本、样式、导航、页脚与侧栏噪音
  const cleaned = fullHtml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:script|style|noscript|svg|iframe|canvas|form|nav|footer|aside)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg|iframe|canvas|form|nav|footer|aside)>/gi, "");

  const containerPatterns = [
    /<div[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*(?:<script|<div[^>]+class=["']rich_media_tool|$)/i,
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]+class=["'][^"']*(?:Post-RichText|markdown-body|article-content|post-content|entry-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<body\b[^>]*>([\s\S]*?)<\/body>/i,
  ];

  for (const re of containerPatterns) {
    const m = re.exec(cleaned);
    if (m && m[1] && m[1].replace(/<[^>]+>/g, "").trim().length > 40) {
      return m[1];
    }
  }
  return cleaned;
}

/**
 * 将提取出的文章 HTML 精准转换为结构化 BlockNote 块（标题、代码块、引用、列表、图片与段落）
 */
export function htmlToBlocks(rawHtml: string, baseUrl: string): BlockObj[] {
  const main = extractMainHtml(rawHtml);
  const blocks: BlockObj[] = [];

  const blockTokenRe =
    /<(h[1-6]|pre|blockquote|ul|ol|p|img|hr)\b([^>]*)>([\s\S]*?)<\/\1>|<(img|hr)\b([^>]*)\/?>/gi;

  let m: RegExpExecArray | null;
  while ((m = blockTokenRe.exec(main)) !== null) {
    const tag = (m[1] || m[4] || "").toLowerCase();
    const attrs = m[2] || m[5] || "";
    const inner = m[3] || "";

    if (tag === "hr") {
      blocks.push({ id: blkId(), type: "divider" });
      continue;
    }

    if (tag === "img") {
      const srcM = /(?:data-src|data-original|src)=["']([^"']+)["']/i.exec(attrs);
      if (srcM && !srcM[1].startsWith("data:image/svg")) {
        try {
          const resolved = new URL(decodeEntities(srcM[1]), baseUrl).href;
          if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
            const altM = /alt=["']([^"']*)["']/i.exec(attrs);
            blocks.push({
              id: blkId(),
              type: "image",
              props: { url: resolved, caption: altM ? decodeEntities(altM[1]).slice(0, 120) : "" },
            });
          }
        } catch {
          /* 忽略 */
        }
      }
      continue;
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = Math.min(3, Number(tag[1]));
      const md = stripTagsToInlineMd(inner, baseUrl);
      if (md) {
        blocks.push({
          id: blkId(),
          type: "heading",
          props: { level },
          content: parseInlineMarkdown(md),
        });
      }
      continue;
    }

    if (tag === "pre") {
      const langM = /class=["'][^"']*language-([a-zA-Z0-9_+-]+)/i.exec(inner) || /class=["'][^"']*lang-([a-zA-Z0-9_+-]+)/i.exec(attrs);
      const codeText = decodeEntities(
        inner
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, ""),
      ).trim();
      if (codeText) {
        blocks.push({
          id: blkId(),
          type: "codeBlock",
          props: { language: langM?.[1]?.toLowerCase() || "text" },
          content: [{ type: "text", text: codeText, styles: {} }],
        });
      }
      continue;
    }

    if (tag === "blockquote") {
      const md = stripTagsToInlineMd(inner, baseUrl);
      if (md) {
        blocks.push({
          id: blkId(),
          type: "quote",
          content: parseInlineMarkdown(md),
        });
      }
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      const itemType = tag === "ol" ? "numberedListItem" : "bulletListItem";
      const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
      let li: RegExpExecArray | null;
      while ((li = liRe.exec(inner)) !== null) {
        const md = stripTagsToInlineMd(li[1], baseUrl);
        if (md) {
          blocks.push({
            id: blkId(),
            type: itemType,
            content: parseInlineMarkdown(md),
          });
        }
      }
      continue;
    }

    if (tag === "p") {
      // 检查段落内是否嵌有图片
      const innerImg = /<img\b([^>]*)\/?>/i.exec(inner);
      if (innerImg) {
        const srcM = /(?:data-src|data-original|src)=["']([^"']+)["']/i.exec(innerImg[1]);
        if (srcM && !srcM[1].startsWith("data:image/svg")) {
          try {
            const resolved = new URL(decodeEntities(srcM[1]), baseUrl).href;
            if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
              blocks.push({ id: blkId(), type: "image", props: { url: resolved, caption: "" } });
            }
          } catch {
            /* 忽略 */
          }
        }
      }
      const md = stripTagsToInlineMd(inner, baseUrl);
      if (md) {
        blocks.push({
          id: blkId(),
          type: "paragraph",
          content: parseInlineMarkdown(md),
        });
      }
    }
  }

  // 若某些 SPA 页面只用 <div> 承载文本而没有 <p>，回退按换行提取纯文本段落
  if (blocks.length === 0) {
    const fallbackLines = decodeEntities(
      main
        .replace(/<(?:div|section|br|li|tr|h[1-6])\b[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, ""),
    )
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l.length > 1);
    for (const line of fallbackLines.slice(0, 120)) {
      blocks.push({
        id: blkId(),
        type: "paragraph",
        content: parseInlineMarkdown(line),
      });
    }
  }

  return blocks.slice(0, 250);
}

export interface ExtractedClip {
  url: string;
  title: string;
  siteName: string;
  tags: string[];
  blocks: BlockObj[];
}

/**
 * 剪藏网页（支持直接传 URL 由服务端抓取解析，或由浏览器书签小工具传入当前选中 HTML/文本）
 */
export async function clipWebPage(input: {
  url: string;
  title?: string;
  html?: string;
  text?: string;
  tags?: string[];
}): Promise<ExtractedClip> {
  const rawUrl = (input.url || "").trim();
  if (!rawUrl) throw new Error("请提供要剪藏的网页链接");

  let finalUrl = rawUrl;
  let html = input.html?.trim() ?? "";

  if (!html && !input.text?.trim()) {
    const fetched = await fetchHtmlSafely(rawUrl);
    finalUrl = fetched.finalUrl;
    html = fetched.html;
  }

  const meta = (pattern: RegExp) => {
    const m = pattern.exec(html);
    return m ? decodeEntities(m[1].replace(/\s+/g, " ").trim()) : "";
  };

  const ogTitle =
    meta(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    meta(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const docTitle = meta(/<title[^>]*>([^<]+)<\/title>/i).replace(/\s*[-_|–—]\s*[^-_|–—]{1,30}$/, "");
  const ogSite =
    meta(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ||
    meta(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);

  const siteName = inferSiteName(finalUrl, ogSite);
  const title = (input.title?.trim() || ogTitle || docTitle || siteName).slice(0, 180);

  let bodyBlocks: BlockObj[];
  if (input.text?.trim() && !html) {
    bodyBlocks = markdownToBlocks(input.text.trim()).blocks;
  } else {
    bodyBlocks = htmlToBlocks(html, finalUrl);
  }

  const clippedTime = new Date().toLocaleString("zh-CN", { hour12: false });
  const headerCallout: BlockObj = {
    id: blkId(),
    type: "callout",
    props: { icon: "🔖", tone: "blue" },
    content: [
      { type: "text", text: `剪藏自 ${siteName} · ${clippedTime} · `, styles: {} },
      {
        type: "link",
        href: finalUrl,
        content: [{ type: "text", text: "查看原文链接", styles: { bold: true } }],
      },
    ],
  };

  const mergedTags = Array.from(
    new Set(
      ["网页剪藏", siteName, ...(input.tags ?? [])]
        .map((t) => t.trim().replace(/^#+/, ""))
        .filter(Boolean),
    ),
  ).slice(0, 8);

  return {
    url: finalUrl,
    title,
    siteName,
    tags: mergedTags,
    blocks: [headerCallout, ...bodyBlocks],
  };
}
