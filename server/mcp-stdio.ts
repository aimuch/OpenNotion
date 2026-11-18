/**
 * 独立运行的 stdio MCP 服务端入口（供 Claude Desktop / Claude Code / Cursor / Windsurf 等直接拉起）
 *
 * 运行方式：
 *   npm run mcp
 *   OPEN_NOTION_DATA=/path/to/data npm run mcp
 */
import path from "node:path";
import readline from "node:readline";
import { createApiMiddleware } from "./api.ts";

const dataDir = process.env.OPEN_NOTION_DATA ?? path.resolve(process.cwd(), "data");
const api = createApiMiddleware(dataDir);

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    const reply = await api.mcp.handleJsonRpc(parsed);
    if (reply) {
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: err instanceof Error ? err.message : "Parse error" },
      })}\n`,
    );
  }
});

process.on("SIGINT", async () => {
  await api.close();
  process.exit(0);
});
