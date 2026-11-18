import { useSyncExternalStore } from "react";
import type {
  AiChatMessage,
  AiCitation,
  AiConfigPublic,
  AiConfigUpdate,
  AiProtocol,
  PageMeta,
  PropertyDef,
} from "../shared/types";
import { cellValue, getDatabase, setProp, valueText } from "./db";
import { fetchPage } from "./store";

let cachedConfig: AiConfigPublic | null = null;
const configListeners = new Set<() => void>();

function setCachedConfig(cfg: AiConfigPublic) {
  cachedConfig = cfg;
  configListeners.forEach((l) => l());
}

export function useAiConfig(): AiConfigPublic | null {
  return useSyncExternalStore(
    (cb) => {
      configListeners.add(cb);
      return () => configListeners.delete(cb);
    },
    () => cachedConfig,
    () => cachedConfig,
  );
}

async function jsonReq<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `请求失败（${res.status}）`);
  return data as T;
}

export async function loadAiConfig(): Promise<AiConfigPublic> {
  const { config } = await jsonReq<{ config: AiConfigPublic }>("/api/ai/config");
  setCachedConfig(config);
  return config;
}

export async function saveAiConfig(patch: AiConfigUpdate): Promise<AiConfigPublic> {
  const { config } = await jsonReq<{ config: AiConfigPublic }>("/api/ai/config", { method: "PUT", json: patch });
  setCachedConfig(config);
  return config;
}

export async function fetchRemoteModels(input: {
  providerId?: string;
  protocol?: AiProtocol;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): Promise<string[]> {
  const { models } = await jsonReq<{ models: string[] }>("/api/ai/models", { method: "POST", json: input });
  return models;
}

export async function testAiProvider(input: {
  providerId?: string;
  model?: string;
  protocol?: AiProtocol;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): Promise<{ ok: true; reply: string; ms: number; model: string }> {
  return jsonReq("/api/ai/test", { method: "POST", json: input });
}

export interface StreamChatOptions {
  messages: AiChatMessage[];
  scope?: "none" | "page" | "workspace";
  pageId?: string | null;
  providerId?: string;
  model?: string;
  system?: string;
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (delta: string, full: string) => void;
  onReasoning?: (delta: string, full: string) => void;
  onCitations?: (citations: AiCitation[]) => void;
}

export async function streamAiChat(opts: StreamChatOptions): Promise<string> {
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: opts.messages,
      scope: opts.scope ?? "none",
      pageId: opts.pageId ?? undefined,
      providerId: opts.providerId,
      model: opts.model,
      system: opts.system,
      temperature: opts.temperature,
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const errData = await res.json().catch(() => ({}));
    throw new Error((errData as { error?: string }).error ?? `AI 请求失败（${res.status}）`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let fullReasoning = "";

  const handlePayload = (raw: string) => {
    const ev = JSON.parse(raw) as {
      delta?: string;
      reasoning?: string;
      citations?: AiCitation[];
      error?: string;
    };
    if (ev.error) throw new Error(ev.error);
    if (ev.citations) opts.onCitations?.(ev.citations);
    if (ev.reasoning) {
      fullReasoning += ev.reasoning;
      opts.onReasoning?.(ev.reasoning, fullReasoning);
    }
    if (ev.delta) {
      fullText += ev.delta;
      opts.onDelta?.(ev.delta, fullText);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload) handlePayload(payload);
      }
    }
  }
  return fullText;
}

/* ---------- Notion AI 快捷指令模板 ---------- */

export interface AiActionPreset {
  id: string;
  label: string;
  group: "selection" | "page" | "translate";
  buildPrompt: (text: string, pageTitle: string) => string;
}

export const AI_ACTIONS: AiActionPreset[] = [
  {
    id: "polish",
    label: "改进写作（润色）",
    group: "selection",
    buildPrompt: (t) => `请润色并改进下面这段内容，使其表达更流畅、准确、自然，保留原意与原有语种，直接输出改写后的正文：\n\n${t}`,
  },
  {
    id: "proofread",
    label: "修正错别字与语病",
    group: "selection",
    buildPrompt: (t) => `请检查并修正下面内容中的错别字、语法错误和标点问题，不改变原意与风格，直接输出修正后的结果：\n\n${t}`,
  },
  {
    id: "shorter",
    label: "精简篇幅",
    group: "selection",
    buildPrompt: (t) => `请将下面内容精简压缩，删去冗余表达、保留核心信息，直接输出精简后的文本：\n\n${t}`,
  },
  {
    id: "longer",
    label: "扩写补充细节",
    group: "selection",
    buildPrompt: (t) => `请围绕下面内容进行合理扩写，补充细节、论据或步骤，使其更加充实完整，直接输出结果：\n\n${t}`,
  },
  {
    id: "explain",
    label: "通俗解释说明",
    group: "selection",
    buildPrompt: (t) => `请用通俗易懂的语言解释下面这段内容的含义与关键概念：\n\n${t}`,
  },
  {
    id: "tone_formal",
    label: "语气：专业正式",
    group: "selection",
    buildPrompt: (t) => `请把下面内容改写为专业、正式、严谨的书面语气，直接输出改写结果：\n\n${t}`,
  },
  {
    id: "tone_friendly",
    label: "语气：亲切自然",
    group: "selection",
    buildPrompt: (t) => `请把下面内容改写为温和、亲切、易读的交流语气，直接输出改写结果：\n\n${t}`,
  },
  {
    id: "summarize",
    label: "总结本页要点",
    group: "page",
    buildPrompt: (t, title) =>
      `请总结页面《${title || "无标题"}》的核心要点，以清晰的条目列出：\n\n${t || "（页面暂无正文，请根据标题拟一份简要大纲）"}`,
  },
  {
    id: "todos",
    label: "提取待办事项",
    group: "page",
    buildPrompt: (t, title) =>
      `请从《${title || "无标题"}》的内容中提取所有可执行的待办事项（使用 Markdown 复选列表 \`- [ ]\` 格式）：\n\n${t}`,
  },
  {
    id: "continue",
    label: "顺着往下续写",
    group: "page",
    buildPrompt: (t, title) =>
      `请根据《${title || "无标题"}》已有的上下文自然地继续往下续写，保持一致的文风与结构，不要重复已有段落：\n\n${t}`,
  },
  {
    id: "outline",
    label: "生成结构大纲",
    group: "page",
    buildPrompt: (t, title) =>
      `请围绕主题《${title || "无标题"}》生成一份结构清晰、层次分明的文档大纲：\n\n${t}`,
  },
  {
    id: "brainstorm",
    label: "头脑风暴点子",
    group: "page",
    buildPrompt: (t, title) =>
      `请围绕《${title || "无标题"}》进行发散性头脑风暴，给出 8 个有启发性的思路或方案建议：\n\n${t}`,
  },
  {
    id: "translate_zh",
    label: "翻译为简体中文",
    group: "translate",
    buildPrompt: (t) => `请将下面内容准确、地道地翻译为简体中文，保留原有 Markdown 排版：\n\n${t}`,
  },
  {
    id: "translate_en",
    label: "翻译为英语",
    group: "translate",
    buildPrompt: (t) => `Translate the following content into natural, idiomatic English, preserving Markdown formatting:\n\n${t}`,
  },
  {
    id: "translate_ja",
    label: "翻译为日语",
    group: "translate",
    buildPrompt: (t) => `以下の内容を自然で正確な日本語に翻訳してください（Markdown形式を維持）：\n\n${t}`,
  },
  {
    id: "translate_ko",
    label: "翻译为韩语",
    group: "translate",
    buildPrompt: (t) => `다음 내용을 자연스럽고 정확한 한국어로 번역해 주세요(Markdown 서식 유지):\n\n${t}`,
  },
];

/** 从 BlockNote 块树抽取纯文本 */
export function blocksPlainText(node: unknown, out: string[] = []): string {
  if (Array.isArray(node)) {
    for (const n of node) blocksPlainText(n, out);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.text === "string") out.push(obj.text);
    for (const k of ["content", "children", "rows", "cells"]) {
      if (typeof obj[k] === "string") out.push(obj[k] as string);
      else if (obj[k]) blocksPlainText(obj[k], out);
    }
  } else if (typeof node === "string") {
    out.push(node);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** 数据库 AI 自动填充：根据一行的标题、其他属性与正文生成目标单元格文本 */
export async function fillRowWithAi(row: PageMeta, dbPage: PageMeta, def: PropertyDef): Promise<string> {
  const prompt = def.aiPrompt?.trim() || `用简短的一句话概括这一项的“${def.name}”`;
  const db = getDatabase(dbPage);
  const record = await fetchPage(row.id);
  const otherProps = db.properties
    .filter((p) => p.id !== def.id)
    .map((p) => {
      const txt = valueText(cellValue(row, p), p);
      return txt ? `${p.name}: ${txt}` : "";
    })
    .filter(Boolean)
    .join("\n");
  const body = blocksPlainText(record.content).slice(0, 3000);
  const content = [
    `数据库：${dbPage.title || "无标题"}`,
    `行名称：${row.title || "无标题"}`,
    otherProps,
    body ? `正文：\n${body}` : "",
    `\n任务要求：${prompt}\n请直接输出填入“${def.name}”单元格的纯文本结果，不要带引号或多余解释。`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = (await streamAiChat({ messages: [{ role: "user", content }], temperature: 0.4 })).trim();
  if (result) setProp(row, def.id, result);
  return result;
}

/** AI 智能打标签：根据页面标题、正文内容及工作区已有标签池生成 2~4 个简短分类标签 */
export async function suggestPageTags(
  title: string,
  bodyText: string,
  workspaceTags: string[],
): Promise<string[]> {
  const poolHint = workspaceTags.length > 0 ? `\n工作区已有标签参考（优先复用契合的标签）：${workspaceTags.slice(0, 30).join("、")}` : "";
  const prompt = [
    `页面标题：${title || "无标题"}`,
    `正文摘要：\n${bodyText.slice(0, 2400)}`,
    poolHint,
    "\n请为这篇笔记提炼 2 到 4 个简短精准的分类标签（每个标签 2~8 个字，不带 # 号）。只输出以英文逗号分隔的标签列表，不要任何解释。",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await streamAiChat({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });
  return Array.from(
    new Set(
      raw
        .split(/[,，、\n]+/)
        .map((s) => s.trim().replace(/^[#\-*\d.\s]+|["'。；;]+$/g, ""))
        .filter((s) => s.length >= 1 && s.length <= 20),
    ),
  ).slice(0, 5);
}
