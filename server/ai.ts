/**
 * 多模型 AI 服务与网页书签摘要抓取（仅依赖 Node 内置模块）。
 * 支持国产大模型（DeepSeek、Kimi、豆包、通义千问、智谱 GLM）、
 * 国外主流大模型（OpenAI、Anthropic Claude、Google Gemini）、
 * 本地 Ollama 以及任意自定义 OpenAI / Anthropic / Gemini 兼容接口。
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import type {
  AiChatMessage,
  AiCitation,
  AiConfigPublic,
  AiConfigUpdate,
  AiProtocol,
  AiProviderPublic,
  AiRegion,
  UnfurlData,
} from "../shared/types.ts";

interface StoredProvider {
  id: string;
  name: string;
  region: AiRegion;
  builtin: boolean;
  protocol: AiProtocol;
  baseUrl: string;
  defaultBaseUrl?: string;
  models: string[];
  keyOptional?: boolean;
  modelHint?: string;
  keyPlaceholder?: string;
  envKey?: string;
  apiKey: string;
  headers?: Record<string, string>;
}

interface StoredAiConfig {
  providers: StoredProvider[];
  activeProviderId: string;
  activeModel: string;
  temperature: number;
  customSystemPrompt: string;
}

const PRESETS: Omit<StoredProvider, "apiKey">[] = [
  {
    id: "deepseek",
    name: "DeepSeek（深度求索）",
    region: "domestic",
    builtin: true,
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyPlaceholder: "sk-...（platform.deepseek.com）",
    envKey: "DEEPSEEK_API_KEY",
  },
  {
    id: "kimi",
    name: "Kimi（月之暗面）",
    region: "domestic",
    builtin: true,
    protocol: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2-0905-preview", "moonshot-v1-auto", "moonshot-v1-128k"],
    keyPlaceholder: "sk-...（platform.moonshot.cn）",
    envKey: "MOONSHOT_API_KEY",
  },
  {
    id: "doubao",
    name: "豆包（火山方舟）",
    region: "domestic",
    builtin: true,
    protocol: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["doubao-seed-1-6-250615", "doubao-1-5-pro-32k-250115", "doubao-1-5-lite-32k-250115"],
    modelHint: "可直接填豆包模型名，或填火山方舟控制台创建的推理接入点 ID（如 ep-2026...）",
    keyPlaceholder: "火山方舟 API Key",
    envKey: "ARK_API_KEY",
  },
  {
    id: "qwen",
    name: "通义千问（阿里云百炼）",
    region: "domestic",
    builtin: true,
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwq-plus"],
    keyPlaceholder: "sk-...（bailian.console.aliyun.com）",
    envKey: "DASHSCOPE_API_KEY",
  },
  {
    id: "glm",
    name: "智谱清言（GLM）",
    region: "domestic",
    builtin: true,
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-plus", "glm-4-air", "glm-4-flash"],
    keyPlaceholder: "智谱开放平台 API Key",
    envKey: "ZHIPU_API_KEY",
  },
  {
    id: "openai",
    name: "OpenAI",
    region: "foreign",
    builtin: true,
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: ["gpt-4.1", "gpt-4o", "gpt-4o-mini", "o3-mini"],
    keyPlaceholder: "sk-...",
    envKey: "OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    region: "foreign",
    builtin: true,
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-20250514", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"],
    keyPlaceholder: "sk-ant-...",
    envKey: "ANTHROPIC_API_KEY",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    region: "foreign",
    builtin: true,
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    keyPlaceholder: "AIza...（Google AI Studio）",
    envKey: "GEMINI_API_KEY",
  },
  {
    id: "ollama",
    name: "Ollama（本地模型）",
    region: "custom",
    builtin: true,
    protocol: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    models: ["qwen2.5:7b", "deepseek-r1:8b", "llama3.2"],
    keyOptional: true,
    modelHint: "本地运行 ollama serve 后无需填写 Key，可点“从接口获取模型”自动读取已安装的模型",
    keyPlaceholder: "本地调用可留空",
  },
];

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}***`;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function effectiveKey(p: StoredProvider): string {
  return p.apiKey || (p.envKey ? (process.env[p.envKey] ?? "") : "");
}

function toPublic(p: StoredProvider): AiProviderPublic {
  const key = effectiveKey(p);
  return {
    id: p.id,
    name: p.name,
    region: p.region,
    builtin: p.builtin,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    defaultBaseUrl: p.defaultBaseUrl,
    models: p.models,
    keyOptional: p.keyOptional,
    modelHint: p.modelHint,
    keyPlaceholder: p.keyPlaceholder,
    hasKey: Boolean(key),
    keyHint: p.apiKey ? maskKey(p.apiKey) : key ? `环境变量 (${p.envKey})` : "",
    headers: p.headers,
  };
}

function cleanHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const name = k.trim();
    if (name && typeof v === "string" && v.trim()) out[name] = v.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function resolveEndpoint(baseUrl: string, protocol: AiProtocol, suffix: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`接口地址“${baseUrl}”不是有效的 URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("接口地址必须以 http:// 或 https:// 开头");
  }
  if (protocol === "openai") {
    if (trimmed.endsWith(suffix)) return trimmed;
    if (trimmed.endsWith("/chat/completions") && suffix === "/models") {
      return `${trimmed.slice(0, -"/chat/completions".length)}/models`;
    }
    if (parsed.pathname === "" || parsed.pathname === "/") return `${trimmed}/v1${suffix}`;
    return `${trimmed}${suffix}`;
  }
  if (protocol === "anthropic") {
    if (trimmed.endsWith(suffix)) return trimmed;
    if (parsed.pathname === "" || parsed.pathname === "/") return `${trimmed}/v1${suffix}`;
    return `${trimmed}${suffix}`;
  }
  // gemini
  if (parsed.pathname === "" || parsed.pathname === "/") return `${trimmed}/v1beta${suffix}`;
  return `${trimmed}${suffix}`;
}

/** 从各家接口返回的错误体里提取可读原因 */
function parseUpstreamError(status: number, text: string): string {
  try {
    const json = JSON.parse(text);
    const msg =
      json?.error?.message ??
      json?.message ??
      json?.msg ??
      (typeof json?.error === "string" ? json.error : "");
    if (msg) return `模型接口报错（${status}）：${msg}`;
  } catch {
    /* 非 JSON */
  }
  const snippet = text.replace(/\s+/g, " ").trim().slice(0, 180);
  return `模型接口返回 HTTP ${status}${snippet ? `：${snippet}` : ""}`;
}

export class AiService {
  private file: string;
  private config: StoredAiConfig | null = null;
  private loading: Promise<StoredAiConfig> | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "ai.json");
  }

  private defaultConfig(): StoredAiConfig {
    const providers: StoredProvider[] = PRESETS.map((p) => ({ ...p, models: [...p.models], apiKey: "" }));
    // 如果环境变量里已经配了某家 Key，默认选中它；否则默认 DeepSeek
    const withEnv = providers.find((p) => Boolean(effectiveKey(p)));
    const first = withEnv ?? providers[0];
    return {
      providers,
      activeProviderId: first.id,
      activeModel: first.models[0],
      temperature: 0.7,
      customSystemPrompt: "",
    };
  }

  private async ensure(): Promise<StoredAiConfig> {
    if (this.config) return this.config;
    this.loading ??= (async () => {
      const defaults = this.defaultConfig();
      try {
        const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<StoredAiConfig>;
        const savedById = new Map((raw.providers ?? []).map((p) => [p.id, p]));
        const merged: StoredProvider[] = PRESETS.map((preset) => {
          const saved = savedById.get(preset.id);
          savedById.delete(preset.id);
          if (!saved) return { ...preset, models: [...preset.models], apiKey: "" };
          const models = Array.isArray(saved.models) && saved.models.length > 0
            ? [...new Set(saved.models.map((m) => String(m).trim()).filter(Boolean))]
            : [...preset.models];
          return {
            ...preset,
            baseUrl: typeof saved.baseUrl === "string" && saved.baseUrl.trim() ? saved.baseUrl.trim() : preset.baseUrl,
            models,
            apiKey: typeof saved.apiKey === "string" ? saved.apiKey : "",
            headers: cleanHeaders(saved.headers),
          };
        });
        // 追加用户自定义的服务商
        for (const custom of savedById.values()) {
          if (!custom || typeof custom.id !== "string" || !custom.name || !custom.baseUrl) continue;
          const protocol: AiProtocol =
            custom.protocol === "anthropic" || custom.protocol === "gemini" ? custom.protocol : "openai";
          const models = Array.isArray(custom.models)
            ? [...new Set(custom.models.map((m) => String(m).trim()).filter(Boolean))]
            : [];
          merged.push({
            id: custom.id,
            name: String(custom.name).slice(0, 80),
            region: "custom",
            builtin: false,
            protocol,
            baseUrl: String(custom.baseUrl).trim(),
            models,
            keyOptional: custom.keyOptional === true,
            apiKey: typeof custom.apiKey === "string" ? custom.apiKey : "",
            headers: cleanHeaders(custom.headers),
          });
        }
        const activeProvider = merged.find((p) => p.id === raw.activeProviderId) ?? merged[0];
        const activeModel =
          typeof raw.activeModel === "string" && raw.activeModel.trim()
            ? raw.activeModel.trim()
            : (activeProvider.models[0] ?? "");
        this.config = {
          providers: merged,
          activeProviderId: activeProvider.id,
          activeModel,
          temperature: typeof raw.temperature === "number" ? Math.max(0, Math.min(2, raw.temperature)) : 0.7,
          customSystemPrompt: typeof raw.customSystemPrompt === "string" ? raw.customSystemPrompt.slice(0, 4000) : "",
        };
      } catch {
        this.config = defaults;
      }
      return this.config;
    })();
    return this.loading;
  }

  private async save(cfg: StoredAiConfig) {
    this.config = cfg;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  async getPublicConfig(): Promise<AiConfigPublic> {
    const cfg = await this.ensure();
    return {
      providers: cfg.providers.map(toPublic),
      activeProviderId: cfg.activeProviderId,
      activeModel: cfg.activeModel,
      temperature: cfg.temperature,
      customSystemPrompt: cfg.customSystemPrompt,
    };
  }

  async updateConfig(patch: AiConfigUpdate): Promise<AiConfigPublic> {
    const cur = await this.ensure();
    const oldById = new Map(cur.providers.map((p) => [p.id, p]));
    let nextProviders = cur.providers;

    if (Array.isArray(patch.providers)) {
      const updatedMap = new Map(patch.providers.map((p) => [p.id, p]));
      const list: StoredProvider[] = [];
      for (const preset of PRESETS) {
        const prev = oldById.get(preset.id);
        const incoming = updatedMap.get(preset.id);
        updatedMap.delete(preset.id);
        if (!incoming) {
          list.push(prev ?? { ...preset, models: [...preset.models], apiKey: "" });
          continue;
        }
        const models = incoming.models.map((m) => String(m).trim()).filter(Boolean);
        let apiKey = prev?.apiKey ?? "";
        if (incoming.apiKey === "__CLEAR__") apiKey = "";
        else if (typeof incoming.apiKey === "string" && incoming.apiKey.trim() !== "") apiKey = incoming.apiKey.trim();
        list.push({
          ...preset,
          baseUrl: incoming.baseUrl?.trim() || preset.baseUrl,
          models: models.length > 0 ? [...new Set(models)] : [...preset.models],
          apiKey,
          headers: cleanHeaders(incoming.headers),
        });
      }
      for (const incoming of updatedMap.values()) {
        if (!incoming.id || !incoming.name?.trim() || !incoming.baseUrl?.trim()) continue;
        const prev = oldById.get(incoming.id);
        const protocol: AiProtocol =
          incoming.protocol === "anthropic" || incoming.protocol === "gemini" ? incoming.protocol : "openai";
        let apiKey = prev?.apiKey ?? "";
        if (incoming.apiKey === "__CLEAR__") apiKey = "";
        else if (typeof incoming.apiKey === "string" && incoming.apiKey.trim() !== "") apiKey = incoming.apiKey.trim();
        list.push({
          id: incoming.id.slice(0, 64),
          name: incoming.name.trim().slice(0, 80),
          region: "custom",
          builtin: false,
          protocol,
          baseUrl: incoming.baseUrl.trim(),
          models: [...new Set((incoming.models ?? []).map((m) => String(m).trim()).filter(Boolean))],
          keyOptional: incoming.keyOptional === true,
          apiKey,
          headers: cleanHeaders(incoming.headers),
        });
      }
      nextProviders = list;
    }

    const activeProvider =
      nextProviders.find((p) => p.id === (patch.activeProviderId ?? cur.activeProviderId)) ?? nextProviders[0];
    const requestedModel = (patch.activeModel ?? cur.activeModel).trim();
    const activeModel =
      requestedModel && (activeProvider.models.includes(requestedModel) || patch.activeModel !== undefined)
        ? requestedModel
        : (activeProvider.models[0] ?? requestedModel);

    const next: StoredAiConfig = {
      providers: nextProviders,
      activeProviderId: activeProvider.id,
      activeModel,
      temperature:
        typeof patch.temperature === "number" ? Math.max(0, Math.min(2, patch.temperature)) : cur.temperature,
      customSystemPrompt:
        typeof patch.customSystemPrompt === "string"
          ? patch.customSystemPrompt.slice(0, 4000)
          : cur.customSystemPrompt,
    };
    await this.save(next);
    return this.getPublicConfig();
  }

  private async resolveProvider(
    providerId?: string,
    override?: { protocol?: AiProtocol; baseUrl?: string; apiKey?: string; headers?: Record<string, string> },
  ): Promise<{ provider: StoredProvider; apiKey: string }> {
    const cfg = await this.ensure();
    const found = cfg.providers.find((p) => p.id === (providerId || cfg.activeProviderId));
    if (!found && !override?.baseUrl) throw new Error("未找到指定的模型服务商");
    const provider: StoredProvider = found
      ? {
          ...found,
          protocol: override?.protocol ?? found.protocol,
          baseUrl: override?.baseUrl?.trim() || found.baseUrl,
          headers: override?.headers ? cleanHeaders(override.headers) : found.headers,
        }
      : {
          id: "temp",
          name: "自定义",
          region: "custom",
          builtin: false,
          protocol: override?.protocol ?? "openai",
          baseUrl: override!.baseUrl!.trim(),
          models: [],
          apiKey: "",
          headers: cleanHeaders(override?.headers),
        };
    const key =
      override?.apiKey && override.apiKey !== "__CLEAR__" ? override.apiKey.trim() : effectiveKey(provider);
    if (!key && !provider.keyOptional) {
      throw new Error(`请先在“AI 模型设置”中填写 ${provider.name} 的 API Key`);
    }
    return { provider, apiKey: key };
  }

  /** 拉取远端或本地服务（如 Ollama / OpenAI 兼容网关 / Gemini）支持的模型列表 */
  async fetchModels(input: {
    providerId?: string;
    protocol?: AiProtocol;
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  }): Promise<string[]> {
    const { provider, apiKey } = await this.resolveProvider(input.providerId, input);
    const signal = AbortSignal.timeout(12_000);
    if (provider.protocol === "gemini") {
      const endpoint = resolveEndpoint(provider.baseUrl, "gemini", "/models");
      const res = await fetch(endpoint, {
        headers: { "x-goog-api-key": apiKey, ...(provider.headers ?? {}) },
        signal,
      });
      if (!res.ok) throw new Error(parseUpstreamError(res.status, await res.text()));
      const data = (await res.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
      return (data.models ?? [])
        .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
        .map((m) => String(m.name ?? "").replace(/^models\//, ""))
        .filter(Boolean);
    }
    if (provider.protocol === "anthropic") {
      const endpoint = resolveEndpoint(provider.baseUrl, "anthropic", "/models");
      const res = await fetch(endpoint, {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          ...(provider.headers ?? {}),
        },
        signal,
      });
      if (!res.ok) throw new Error(parseUpstreamError(res.status, await res.text()));
      const data = (await res.json()) as { data?: { id?: string }[] };
      return (data.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
    }
    const endpoint = resolveEndpoint(provider.baseUrl, "openai", "/models");
    const res = await fetch(endpoint, {
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(provider.headers ?? {}),
      },
      signal,
    });
    if (!res.ok) throw new Error(parseUpstreamError(res.status, await res.text()));
    const data = (await res.json()) as { data?: { id?: string; name?: string }[]; models?: { id?: string; name?: string }[] };
    const list = data.data ?? data.models ?? [];
    return list.map((m) => String(m.id ?? m.name ?? "")).filter(Boolean);
  }

  /** 测试连接是否可用并返回延迟 */
  async testConnection(input: {
    providerId?: string;
    model?: string;
    protocol?: AiProtocol;
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  }): Promise<{ ok: true; reply: string; ms: number; model: string }> {
    const cfg = await this.ensure();
    const { provider, apiKey } = await this.resolveProvider(input.providerId, input);
    const model = (input.model || provider.models[0] || cfg.activeModel).trim();
    if (!model) throw new Error("请先填写或选择一个模型名称");
    const start = Date.now();
    const reply = await this.completeOnce(provider, apiKey, model, [{ role: "user", content: "请仅回复 OK" }], 0.1);
    return { ok: true, reply: reply.trim().slice(0, 120) || "OK", ms: Date.now() - start, model };
  }

  private async completeOnce(
    provider: StoredProvider,
    apiKey: string,
    model: string,
    messages: AiChatMessage[],
    temperature: number,
  ): Promise<string> {
    const signal = AbortSignal.timeout(25_000);
    if (provider.protocol === "anthropic") {
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const chat = messages.filter((m) => m.role !== "system");
      const res = await fetch(resolveEndpoint(provider.baseUrl, "anthropic", "/messages"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          ...(provider.headers ?? {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: 256,
          ...(system ? { system } : {}),
          messages: chat.length ? chat : [{ role: "user", content: "OK" }],
        }),
        signal,
      });
      if (!res.ok) throw new Error(parseUpstreamError(res.status, await res.text()));
      const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
      return (data.content ?? []).map((c) => c.text ?? "").join("");
    }

    if (provider.protocol === "gemini") {
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const contents = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      const endpoint = resolveEndpoint(provider.baseUrl, "gemini", `/models/${encodeURIComponent(model)}:generateContent`);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
          ...(provider.headers ?? {}),
        },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: contents.length ? contents : [{ role: "user", parts: [{ text: "OK" }] }],
        }),
        signal,
      });
      if (!res.ok) throw new Error(parseUpstreamError(res.status, await res.text()));
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    }

    const skipTemp = /^(o1|o3|o4|deepseek-reasoner)/i.test(model);
    const res = await fetch(resolveEndpoint(provider.baseUrl, "openai", "/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(provider.headers ?? {}),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(skipTemp ? {} : { temperature }),
      }),
      signal,
    });
    if (!res.ok) throw new Error(parseUpstreamError(res.status, await res.text()));
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }

  /** 以统一的 SSE 事件流向前端推送模型生成内容 */
  async streamChat(
    input: {
      providerId?: string;
      model?: string;
      messages: AiChatMessage[];
      system?: string;
      temperature?: number;
      citations?: AiCitation[];
    },
    res: ServerResponse,
    abortSignal: AbortSignal,
  ) {
    const cfg = await this.ensure();
    const { provider, apiKey } = await this.resolveProvider(input.providerId);
    const model = (input.model || cfg.activeModel || provider.models[0] || "").trim();
    if (!model) throw new Error("请先在 AI 设置里选择或输入模型名称");

    const systemParts = [
      "你是 OpenNotion 内置的智能写作与知识库助手。请直接给出清晰、结构良好的结果，使用 Markdown 排版（标题、列表、表格、代码块等），不要有多余的寒暄套话。",
      cfg.customSystemPrompt.trim(),
      input.system?.trim() ?? "",
    ].filter(Boolean);

    const allMessages: AiChatMessage[] = [
      ...(systemParts.length ? [{ role: "system" as const, content: systemParts.join("\n\n") }] : []),
      ...input.messages.filter((m) => m && typeof m.content === "string" && m.content.trim()),
    ];
    const temperature = typeof input.temperature === "number" ? input.temperature : cfg.temperature;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const writeEvent = (payload: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    if (input.citations && input.citations.length > 0) {
      writeEvent({ citations: input.citations });
    }

    try {
      if (provider.protocol === "anthropic") {
        await this.streamAnthropic(provider, apiKey, model, allMessages, temperature, abortSignal, writeEvent);
      } else if (provider.protocol === "gemini") {
        await this.streamGemini(provider, apiKey, model, allMessages, temperature, abortSignal, writeEvent);
      } else {
        await this.streamOpenAI(provider, apiKey, model, allMessages, temperature, abortSignal, writeEvent);
      }
      writeEvent({ done: true });
    } catch (err) {
      if (!abortSignal.aborted) {
        writeEvent({ error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  private async streamOpenAI(
    provider: StoredProvider,
    apiKey: string,
    model: string,
    messages: AiChatMessage[],
    temperature: number,
    signal: AbortSignal,
    emit: (ev: Record<string, unknown>) => void,
  ) {
    const skipTemp = /^(o1|o3|o4|deepseek-reasoner)/i.test(model);
    const upstream = await fetch(resolveEndpoint(provider.baseUrl, "openai", "/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(provider.headers ?? {}),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(skipTemp ? {} : { temperature }),
      }),
      signal,
    });
    if (!upstream.ok) throw new Error(parseUpstreamError(upstream.status, await upstream.text()));

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.includes("event-stream") && !upstream.body) {
      const json = (await upstream.json()) as { choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content ?? "";
      if (content) emit({ delta: content });
      return;
    }

    await readSseLines(upstream, (data) => {
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        if (parsed?.error) {
          throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
        }
        const delta = parsed?.choices?.[0]?.delta ?? parsed?.choices?.[0]?.message;
        if (!delta) return;
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          emit({ reasoning: delta.reasoning_content });
        }
        if (typeof delta.content === "string" && delta.content) {
          emit({ delta: delta.content });
        }
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
    });
  }

  private async streamAnthropic(
    provider: StoredProvider,
    apiKey: string,
    model: string,
    messages: AiChatMessage[],
    temperature: number,
    signal: AbortSignal,
    emit: (ev: Record<string, unknown>) => void,
  ) {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const chat = messages.filter((m) => m.role !== "system");
    const upstream = await fetch(resolveEndpoint(provider.baseUrl, "anthropic", "/messages"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(provider.headers ?? {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: Math.min(1, temperature),
        stream: true,
        ...(system ? { system } : {}),
        messages: chat,
      }),
      signal,
    });
    if (!upstream.ok) throw new Error(parseUpstreamError(upstream.status, await upstream.text()));

    await readSseLines(upstream, (data) => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === "error") {
          throw new Error(parsed.error?.message ?? "Anthropic 接口返回错误");
        }
        if (parsed.type === "content_block_delta") {
          if (parsed.delta?.type === "thinking_delta" && parsed.delta.thinking) {
            emit({ reasoning: parsed.delta.thinking });
          } else if (parsed.delta?.text) {
            emit({ delta: parsed.delta.text });
          }
        }
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
    });
  }

  private async streamGemini(
    provider: StoredProvider,
    apiKey: string,
    model: string,
    messages: AiChatMessage[],
    temperature: number,
    signal: AbortSignal,
    emit: (ev: Record<string, unknown>) => void,
  ) {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    const endpoint = resolveEndpoint(
      provider.baseUrl,
      "gemini",
      `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    );
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
        ...(provider.headers ?? {}),
      },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig: { temperature },
      }),
      signal,
    });
    if (!upstream.ok) throw new Error(parseUpstreamError(upstream.status, await upstream.text()));

    await readSseLines(upstream, (data) => {
      try {
        const parsed = JSON.parse(data);
        const parts = parsed?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part?.thought && typeof part.text === "string") emit({ reasoning: part.text });
            else if (typeof part?.text === "string" && part.text) emit({ delta: part.text });
          }
        }
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
    });
  }
}

async function readSseLines(response: Response, onData: (payload: string) => void) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
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
        if (payload) onData(payload);
      }
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith("data:")) {
    const payload = rest.slice(5).trim();
    if (payload) onData(payload);
  }
}

/* ---------- 安全的网页书签标题与摘要抓取（防 SSRF） ---------- */

function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  if (net.isIPv4(v)) {
    const [a, b] = v.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (net.isIPv6(v)) {
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80:");
  }
  return true;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export async function unfurlUrl(rawUrl: string): Promise<UnfurlData> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error("无效的网址");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("只支持 http 和 https 网址");
  }
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("不允许抓取本地或内网地址");
  }
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new Error("不允许抓取内网地址");
  }
  const fallback: UnfurlData = { url: target.href, title: target.hostname, description: "", siteName: target.hostname };

  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
      throw new Error("不允许抓取内网地址");
    }
    const res = await fetch(target.href, {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OpenNotionBookmark/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok || !res.body) return fallback;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < 65_536) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
    }
    void reader.cancel().catch(() => {});
    const html = new TextDecoder("utf-8").decode(Buffer.concat(chunks));

    const meta = (pattern: RegExp) => {
      const m = pattern.exec(html);
      return m ? decodeHtmlEntities(m[1].replace(/\s+/g, " ").trim()) : "";
    };

    const ogTitle =
      meta(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      meta(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const docTitle = meta(/<title[^>]*>([^<]+)<\/title>/i);
    const description =
      meta(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
      meta(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
      meta(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    const siteName =
      meta(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) || target.hostname;

    return {
      url: target.href,
      title: (ogTitle || docTitle || target.hostname).slice(0, 200),
      description: description.slice(0, 300),
      siteName: siteName.slice(0, 80),
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("内网")) throw err;
    return fallback;
  }
}
