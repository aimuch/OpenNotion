import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { McpConfigPublic, NewPageInput, PageMeta, PagePatch, PageRecord, PropValue, SearchHit } from "../shared/types.ts";
import { markdownToBlocks, pageRecordToMarkdown } from "./markdownBridge.ts";

export interface McpWorkspaceAdapter {
  dataDir: string;
  listMetas(): PageMeta[];
  getPage(id: string): PageRecord | null;
  search(query: string): SearchHit[];
  createPage(input: NewPageInput): PageRecord;
  updatePage(id: string, patch: PagePatch): PageRecord;
  trashPage(id: string): void;
  flush?(): Promise<void>;
}

interface StoredMcpConfig {
  enabled: boolean;
  requireToken: boolean;
  token: string;
}

export const MCP_TOOLS = [
  {
    name: "list_pages",
    description: "列出工作区页面与多维数据库的层级目录、图标和 #标签（支持按 tag 或 parentId 过滤）",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "可选：仅列出带有指定标签的页面" },
        parentId: { type: "string", description: "可选：仅列出指定父页面或数据库下的子项" },
      },
    },
  },
  {
    name: "search_notes",
    description: "全文搜索工作区所有笔记标题、正文、分栏、公式、思维导图、标签及数据库属性",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_page",
    description: "读取指定页面或数据库的完整 Markdown 正文、元数据、标签与数据库行表格",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "16 位十六进制页面 ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_page",
    description: "使用标准 Markdown 创建新笔记页面（自动转换标题、代码块、列表、待办、表格、公式、Mermaid 与思维导图）",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "页面标题" },
        markdown: { type: "string", description: "Markdown 格式正文" },
        icon: { type: "string", description: "可选 Emoji 图标，如 📝" },
        tags: { type: "array", items: { type: "string" }, description: "可选标签数组，如 ['技术', '架构']" },
        parentId: { type: "string", description: "可选父页面 ID" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_page",
    description: "更新已有页面的标题、图标、标签，或替换/追加 Markdown 正文内容",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "页面 ID" },
        title: { type: "string", description: "新标题（可选）" },
        icon: { type: "string", description: "新图标（可选）" },
        tags: { type: "array", items: { type: "string" }, description: "更新后的标签列表（可选）" },
        markdown: { type: "string", description: "要写入或追加的 Markdown 内容（可选）" },
        mode: {
          type: "string",
          enum: ["append", "replace"],
          description: "正文更新方式：append 追加到末尾（默认），replace 覆盖全文",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "query_database",
    description: "读取指定多维数据库的属性结构（Schema）及全部数据行",
    inputSchema: {
      type: "object",
      properties: {
        databaseId: { type: "string", description: "数据库页面 ID" },
      },
      required: ["databaseId"],
    },
  },
  {
    name: "add_database_row",
    description: "向指定多维数据库新增一行记录，可按属性名称直接赋值并附带正文 Markdown",
    inputSchema: {
      type: "object",
      properties: {
        databaseId: { type: "string", description: "数据库页面 ID" },
        title: { type: "string", description: "记录名称" },
        properties: {
          type: "object",
          description: "键值对象：key 为数据库属性名称（如 '状态'、'截止日期'），value 为属性值",
        },
        markdown: { type: "string", description: "可选：该记录详情页的正文 Markdown" },
      },
      required: ["databaseId", "title"],
    },
  },
];

export class McpService {
  private readonly adapter: McpWorkspaceAdapter;
  private readonly cfgPath: string;
  private cached: StoredMcpConfig | null = null;

  constructor(adapter: McpWorkspaceAdapter) {
    this.adapter = adapter;
    this.cfgPath = path.join(adapter.dataDir, "mcp.json");
  }

  async ensureConfig(): Promise<StoredMcpConfig> {
    if (this.cached) return this.cached;
    try {
      const raw = JSON.parse(await fs.readFile(this.cfgPath, "utf8")) as Partial<StoredMcpConfig>;
      this.cached = {
        enabled: raw.enabled !== false,
        requireToken: Boolean(raw.requireToken),
        token: typeof raw.token === "string" && raw.token.length >= 16 ? raw.token : crypto.randomBytes(18).toString("hex"),
      };
    } catch {
      this.cached = {
        enabled: true,
        requireToken: false,
        token: crypto.randomBytes(18).toString("hex"),
      };
      await this.saveConfig(this.cached);
    }
    return this.cached;
  }

  private async saveConfig(cfg: StoredMcpConfig): Promise<void> {
    this.cached = cfg;
    await fs.mkdir(path.dirname(this.cfgPath), { recursive: true });
    const tmp = `${this.cfgPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.cfgPath);
  }

  async getPublicConfig(origin = "http://localhost:5273"): Promise<McpConfigPublic> {
    const cfg = await this.ensureConfig();
    return {
      enabled: cfg.enabled,
      requireToken: cfg.requireToken,
      token: cfg.token,
      endpoint: `${origin}/api/mcp`,
      stdioCommand: `node ${path.resolve("server/mcp-stdio.ts")}`,
      tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
    };
  }

  async updateConfig(patch: { enabled?: boolean; requireToken?: boolean; rotateToken?: boolean }, origin = "http://localhost:5273"): Promise<McpConfigPublic> {
    const cur = await this.ensureConfig();
    const next: StoredMcpConfig = {
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
      requireToken: typeof patch.requireToken === "boolean" ? patch.requireToken : cur.requireToken,
      token: patch.rotateToken ? crypto.randomBytes(18).toString("hex") : cur.token,
    };
    await this.saveConfig(next);
    return this.getPublicConfig(origin);
  }

  async verifyHttpAuth(authHeader: string | undefined): Promise<{ ok: boolean; status?: number; message?: string }> {
    const cfg = await this.ensureConfig();
    if (!cfg.enabled) return { ok: false, status: 403, message: "MCP 服务已在设置中停用" };
    if (!cfg.requireToken) return { ok: true };
    const bearer = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!bearer || bearer !== cfg.token) {
      return { ok: false, status: 401, message: "缺少有效的 MCP Bearer Token" };
    }
    return { ok: true };
  }

  private resolveWikiTitle(title: string): string | null {
    const lower = title.trim().toLowerCase();
    const found = this.adapter
      .listMetas()
      .find((p) => !p.trashed && !p.hidden && p.title.trim().toLowerCase() === lower);
    return found?.id ?? null;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const metas = this.adapter.listMetas();
    const metaMap = new Map(metas.map((m) => [m.id, m]));

    switch (name) {
      case "list_pages": {
        const tagFilter = typeof args.tag === "string" ? args.tag.trim().replace(/^#+/, "") : "";
        const parentFilter = typeof args.parentId === "string" ? args.parentId.trim() : undefined;
        const visible = metas
          .filter((p) => !p.trashed && !p.hidden)
          .filter((p) => (!tagFilter ? true : (p.tags ?? []).includes(tagFilter)))
          .filter((p) => (parentFilter === undefined ? true : (p.parentId ?? "") === parentFilter))
          .map((p) => ({
            id: p.id,
            title: p.title || "无标题",
            icon: p.icon,
            kind: p.kind,
            parentId: p.parentId,
            tags: p.tags ?? [],
            updatedAt: new Date(p.updatedAt).toISOString(),
          }));
        return { count: visible.length, pages: visible };
      }

      case "search_notes": {
        const q = typeof args.query === "string" ? args.query : "";
        const hits = this.adapter.search(q);
        return { count: hits.length, hits };
      }

      case "read_page": {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const rec = this.adapter.getPage(id);
        if (!rec || rec.hidden) throw new Error(`找不到页面: ${id}`);
        return {
          id: rec.id,
          title: rec.title,
          kind: rec.kind,
          tags: rec.tags ?? [],
          parentId: rec.parentId,
          markdown: pageRecordToMarkdown(rec, metaMap),
        };
      }

      case "create_page": {
        const title = typeof args.title === "string" ? args.title.trim() : "未命名笔记";
        const md = typeof args.markdown === "string" ? args.markdown : "";
        const { blocks, frontmatter } = markdownToBlocks(md, (t) => this.resolveWikiTitle(t));
        const rawTags = Array.isArray(args.tags)
          ? args.tags.filter((t): t is string => typeof t === "string")
          : (frontmatter.tags ?? []);
        const tags = Array.from(new Set(rawTags.map((t) => t.trim().replace(/^#+/, "")).filter(Boolean)));
        const created = this.adapter.createPage({
          title: title || frontmatter.title || "未命名笔记",
          icon: typeof args.icon === "string" ? args.icon : (frontmatter.icon ?? null),
          tags,
          parentId: typeof args.parentId === "string" && args.parentId ? args.parentId : null,
          content: blocks,
        });
        await this.adapter.flush?.();
        return { id: created.id, title: created.title, tags: created.tags ?? [], blockCount: blocks.length };
      }

      case "update_page": {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const existing = this.adapter.getPage(id);
        if (!existing || existing.hidden) throw new Error(`找不到页面: ${id}`);
        const patch: PagePatch = {};
        if (typeof args.title === "string") patch.title = args.title;
        if (typeof args.icon === "string") patch.icon = args.icon;
        if (Array.isArray(args.tags)) {
          patch.tags = Array.from(
            new Set(
              args.tags
                .filter((t): t is string => typeof t === "string")
                .map((t) => t.trim().replace(/^#+/, ""))
                .filter(Boolean),
            ),
          );
        }
        if (typeof args.markdown === "string") {
          const { blocks } = markdownToBlocks(args.markdown, (t) => this.resolveWikiTitle(t));
          patch.content = args.mode === "replace" ? blocks : [...existing.content, ...blocks];
        }
        const updated = this.adapter.updatePage(id, patch);
        await this.adapter.flush?.();
        return { id: updated.id, title: updated.title, tags: updated.tags ?? [], updatedAt: updated.updatedAt };
      }

      case "query_database": {
        const dbId = typeof args.databaseId === "string" ? args.databaseId.trim() : "";
        const dbPage = this.adapter.getPage(dbId);
        if (!dbPage || dbPage.kind !== "database" || !dbPage.database) {
          throw new Error(`找不到数据库: ${dbId}`);
        }
        const props = dbPage.database.properties;
        const rows = metas
          .filter((r) => r.parentId === dbId && !r.trashed && !r.hidden)
          .sort((a, b) => a.order - b.order)
          .map((r) => {
            const namedProps: Record<string, unknown> = {};
            for (const def of props) {
              const v = r.props[def.id];
              if (def.type === "select" && typeof v === "string") {
                namedProps[def.name] = def.options?.find((o) => o.id === v)?.name ?? v;
              } else if (def.type === "multiSelect" && Array.isArray(v)) {
                namedProps[def.name] = v.map((oid) => def.options?.find((o) => o.id === oid)?.name ?? oid);
              } else {
                namedProps[def.name] = v ?? null;
              }
            }
            return { id: r.id, title: r.title, properties: namedProps };
          });
        return {
          id: dbPage.id,
          title: dbPage.title,
          schema: props.map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
            options: p.options?.map((o) => o.name),
          })),
          rowCount: rows.length,
          rows,
        };
      }

      case "add_database_row": {
        const dbId = typeof args.databaseId === "string" ? args.databaseId.trim() : "";
        const dbPage = this.adapter.getPage(dbId);
        if (!dbPage || dbPage.kind !== "database" || !dbPage.database) {
          throw new Error(`找不到数据库: ${dbId}`);
        }
        const rawProps = (args.properties && typeof args.properties === "object" ? args.properties : {}) as Record<string, unknown>;
        const mappedProps: Record<string, PropValue> = {};
        for (const def of dbPage.database.properties) {
          if (!(def.name in rawProps) && !(def.id in rawProps)) continue;
          const val = rawProps[def.name] ?? rawProps[def.id];
          if (def.type === "select" && typeof val === "string") {
            const opt = def.options?.find((o) => o.name === val || o.id === val);
            if (opt) mappedProps[def.id] = opt.id;
          } else if (def.type === "multiSelect" && Array.isArray(val)) {
            mappedProps[def.id] = val
              .map((item) => def.options?.find((o) => o.name === String(item) || o.id === String(item))?.id)
              .filter((x): x is string => Boolean(x));
          } else if (typeof val === "string" || typeof val === "number" || typeof val === "boolean" || val === null) {
            mappedProps[def.id] = val;
          }
        }
        const md = typeof args.markdown === "string" ? args.markdown : "";
        const content = md ? markdownToBlocks(md, (t) => this.resolveWikiTitle(t)).blocks : [];
        const created = this.adapter.createPage({
          parentId: dbId,
          title: typeof args.title === "string" ? args.title : "新记录",
          props: mappedProps,
          content,
        });
        await this.adapter.flush?.();
        return { id: created.id, title: created.title, databaseId: dbId };
      }

      default:
        throw new Error(`未知的 MCP 工具: ${name}`);
    }
  }

  /**
   * 处理单条 JSON-RPC 2.0 请求（兼容 MCP 2024-11-05 与 2025-03-26 Streamable HTTP / stdio）
   * 若是 notification（无 id），返回 null。
   */
  async handleJsonRpc(payload: unknown): Promise<Record<string, unknown> | null> {
    if (!payload || typeof payload !== "object") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const req = payload as { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
    const method = req.method ?? "";
    const hasId = "id" in req && req.id !== undefined;

    // JSON-RPC Notification（例如 notifications/initialized）无需回复响应体
    if (!hasId) return null;

    try {
      switch (method) {
        case "initialize": {
          const clientVer = typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2024-11-05";
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              protocolVersion: clientVer,
              capabilities: {
                tools: {},
                resources: {},
              },
              serverInfo: {
                name: "open-notion-mcp",
                version: "0.2.0",
              },
            },
          };
        }

        case "ping":
          return { jsonrpc: "2.0", id: req.id, result: {} };

        case "tools/list":
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: { tools: MCP_TOOLS },
          };

        case "tools/call": {
          const toolName = typeof req.params?.name === "string" ? req.params.name : "";
          const toolArgs =
            req.params?.arguments && typeof req.params.arguments === "object"
              ? (req.params.arguments as Record<string, unknown>)
              : {};
          try {
            const output = await this.callTool(toolName, toolArgs);
            return {
              jsonrpc: "2.0",
              id: req.id,
              result: {
                content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
                isError: false,
              },
            };
          } catch (toolErr) {
            return {
              jsonrpc: "2.0",
              id: req.id,
              result: {
                content: [{ type: "text", text: toolErr instanceof Error ? toolErr.message : String(toolErr) }],
                isError: true,
              },
            };
          }
        }

        case "resources/list": {
          const resources = this.adapter
            .listMetas()
            .filter((p) => !p.trashed && !p.hidden)
            .map((p) => ({
              uri: `opennotion://page/${p.id}`,
              name: p.title || "无标题",
              description: `${p.kind === "database" ? "多维数据库" : "笔记页面"}${p.tags?.length ? ` · #${p.tags.join(" #")}` : ""}`,
              mimeType: "text/markdown",
            }));
          return { jsonrpc: "2.0", id: req.id, result: { resources } };
        }

        case "resources/read": {
          const uri = typeof req.params?.uri === "string" ? req.params.uri : "";
          const m = /^opennotion:\/\/page\/([a-f0-9]{16})$/.exec(uri);
          if (!m) throw new Error(`无效的页面资源 URI: ${uri}`);
          const rec = this.adapter.getPage(m[1]);
          if (!rec) throw new Error(`页面不存在: ${m[1]}`);
          const metaMap = new Map(this.adapter.listMetas().map((p) => [p.id, p]));
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              contents: [
                {
                  uri,
                  mimeType: "text/markdown",
                  text: pageRecordToMarkdown(rec, metaMap),
                },
              ],
            },
          };
        }

        default:
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}
