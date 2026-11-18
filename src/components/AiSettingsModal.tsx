import { useEffect, useState } from "react";
import {
  Check,
  Cloud,
  Copy,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  FolderSync,
  Import,
  KeyRound,
  LoaderCircle,
  Monitor,
  Moon,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SearchX,
  Sparkles,
  Sun,
  Trash,
  Trash2,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import type {
  AiConfigPublic,
  AiProtocol,
  AiProviderPublic,
  AiProviderUpdate,
  AiRegion,
  McpConfigPublic,
  StorageInfo,
} from "../../shared/types";
import { fetchRemoteModels, loadAiConfig, saveAiConfig, testAiProvider } from "../ai";
import { shortId } from "../db";
import type { SettingsTab } from "../machines";
import {
  cleanOrphanSynced,
  deletePage,
  desktopImportFolder,
  desktopOpenDataDir,
  desktopPickDataDir,
  desktopResetDataDir,
  emptyTrash,
  fetchMcpConfig,
  fetchStorageInfo,
  navigate,
  openSettings,
  restorePage,
  setTheme,
  syncFromDisk,
  updateMcpConfig,
  useStore,
  useTree,
  type ThemeSetting,
} from "../store";
import { modKey } from "./Sidebar";
import { cx } from "./Popover";

interface DraftProvider extends AiProviderPublic {
  draftKey: string;
  clearKey: boolean;
  headersText: string;
}

function headersToText(headers?: Record<string, string>): string {
  if (!headers) return "";
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

function textToHeaders(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toDrafts(cfg: AiConfigPublic): DraftProvider[] {
  return cfg.providers.map((p) => ({
    ...p,
    models: [...p.models],
    draftKey: "",
    clearKey: false,
    headersText: headersToText(p.headers),
  }));
}

function toUpdates(drafts: DraftProvider[]): AiProviderUpdate[] {
  return drafts.map((d) => ({
    id: d.id,
    name: d.name,
    region: d.region,
    builtin: d.builtin,
    protocol: d.protocol,
    baseUrl: d.baseUrl,
    models: d.models,
    keyOptional: d.keyOptional,
    apiKey: d.clearKey ? "__CLEAR__" : d.draftKey.trim() || undefined,
    headers: textToHeaders(d.headersText),
  }));
}

const REGION_TITLES: { region: AiRegion; label: string }[] = [
  { region: "domestic", label: "国产大模型" },
  { region: "foreign", label: "海外主流模型" },
  { region: "custom", label: "本地与自定义" },
];

export function AiSettingsModal({
  onClose,
  onImportNotionZip,
}: {
  onClose: () => void;
  onImportNotionZip?: () => void;
}) {
  const activeTab = useStore((s) => s.overlay.settingsTab ?? "appearance");
  const theme = useStore((s) => s.theme);
  const tree = useTree();
  const hasHiddenSynced = useStore((s) => Object.values(s.pages).some((p) => p.hidden));

  const setTab = (tab: SettingsTab) => openSettings(tab);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-modal ai-settings-modal" role="dialog" aria-modal="true" aria-label="设置">
        <aside className="settings-nav">
          <div className="settings-nav-group">
            <div className="settings-nav-label">工作区设置</div>
            <button
              type="button"
              className={cx("settings-nav-item", activeTab === "appearance" && "active")}
              onClick={() => setTab("appearance")}
            >
              <Palette size={15} />
              <span>外观与快捷键</span>
            </button>
            <button
              type="button"
              className={cx("settings-nav-item", activeTab === "sync" && "active")}
              onClick={() => setTab("sync")}
            >
              <Cloud size={15} />
              <span>数据与多端同步</span>
            </button>
            <button
              type="button"
              className={cx("settings-nav-item", activeTab === "ai" && "active")}
              onClick={() => setTab("ai")}
            >
              <Sparkles size={15} />
              <span>AI 模型服务</span>
            </button>
            <button
              type="button"
              className={cx("settings-nav-item", activeTab === "mcp" && "active")}
              onClick={() => setTab("mcp")}
            >
              <Plug size={15} />
              <span>MCP 与开放接口</span>
            </button>
            <button
              type="button"
              className={cx("settings-nav-item", activeTab === "trash" && "active")}
              onClick={() => setTab("trash")}
            >
              <Trash2 size={15} />
              <span>回收站</span>
              {tree.trash.length > 0 && <span className="settings-badge">{tree.trash.length}</span>}
            </button>
          </div>
        </aside>

        <div className="settings-content">
          {activeTab === "appearance" && <AppearancePane theme={theme} onClose={onClose} />}
          {activeTab === "sync" && (
            <SyncAndDataPane
              hasHiddenSynced={hasHiddenSynced}
              onImportNotionZip={onImportNotionZip}
              onClose={onClose}
            />
          )}
          {activeTab === "ai" && <AiProvidersPane onClose={onClose} />}
          {activeTab === "mcp" && <McpSettingsPane onClose={onClose} />}
          {activeTab === "trash" && <TrashPane items={tree.trash} onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}

function PaneHeader({ title, subtitle, onClose }: { title: string; subtitle: string; onClose: () => void }) {
  return (
    <header className="settings-pane-head">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <button type="button" className="icon-btn" aria-label="关闭设置" onClick={onClose}>
        <X size={18} />
      </button>
    </header>
  );
}

function AppearancePane({ theme, onClose }: { theme: ThemeSetting; onClose: () => void }) {
  const options: { value: ThemeSetting; label: string; desc: string; icon: typeof Sun }[] = [
    { value: "system", label: "跟随系统", desc: "随操作系统昼夜自动切换", icon: Monitor },
    { value: "light", label: "浅色模式", desc: "温暖干净的纸面阅读体验", icon: Sun },
    { value: "dark", label: "深色模式", desc: "低眩光深灰背景，适合夜间专注", icon: Moon },
  ];

  const shortcuts: [string, string][] = [
    [`${modKey}K / ${modKey}P`, "全局搜索页面标题、正文与 #标签"],
    [`${modKey}J`, "打开 AI 助手与全工作区问答"],
    [`${modKey}⇧C`, "打开网页深度剪藏器（Web Clipper）"],
    [`${modKey},`, "打开工作区设置"],
    [`${modKey}\\`, "收起或展开左侧边栏"],
    ["/", "在编辑器插入扩展块或唤起内联 AI"],
    ["@", "提及并建立页面双向链接"],
  ];

  return (
    <div className="settings-pane">
      <PaneHeader title="外观与快捷键" subtitle="自定义界面主题并查看常用键盘操作。" onClose={onClose} />
      <div className="settings-pane-body">
        <section className="settings-section">
          <h3>界面外观</h3>
          <div className="theme-cards">
            {options.map((opt) => {
              const Icon = opt.icon;
              const selected = theme === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={cx("theme-card", selected && "selected")}
                  onClick={() => setTheme(opt.value)}
                >
                  <div className={cx("theme-preview", `preview-${opt.value}`)}>
                    <span className="preview-side" />
                    <span className="preview-main">
                      <i />
                      <i />
                    </span>
                  </div>
                  <div className="theme-card-meta">
                    <span className="theme-card-title">
                      <Icon size={14} /> {opt.label}
                    </span>
                    <span className="theme-card-desc">{opt.desc}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="settings-section">
          <h3>常用快捷键</h3>
          <div className="shortcut-list">
            {shortcuts.map(([keys, label]) => (
              <div key={keys} className="shortcut-row">
                <span>{label}</span>
                <kbd>{keys}</kbd>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function SyncAndDataPane({
  hasHiddenSynced,
  onImportNotionZip,
  onClose,
}: {
  hasHiddenSynced: boolean;
  onImportNotionZip?: () => void;
  onClose: () => void;
}) {
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetchStorageInfo().then(
      (info) => alive && setStorage(info),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  const handleManualSync = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const diff = await syncFromDisk();
      const count = diff.updatedIds.length + diff.removedIds.length;
      setNotice({
        ok: true,
        text: count > 0 ? `已从磁盘同步 ${count} 处外部文件变更` : "当前已是磁盘最新内容，无需更新",
      });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const handlePickSyncDir = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await desktopPickDataDir();
      setStorage(res.storage);
      if (res.changed) {
        setNotice({ ok: true, text: `数据目录已切换至：${res.storage.dataDir}` });
      }
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleResetDir = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await desktopResetDataDir();
      setStorage(res.storage);
      setNotice({ ok: true, text: "已切回本机默认存储目录" });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleCleanSynced = async () => {
    const n = await cleanOrphanSynced();
    setNotice({ ok: true, text: n > 0 ? `已清理 ${n} 个未引用的闲置同步块` : "没有需要清理的闲置同步块" });
  };

  return (
    <div className="settings-pane">
      <PaneHeader
        title="数据与多端同步"
        subtitle="所有页面均以独立的 JSON 文件保存在本地，支持放入 iCloud Drive 或 NAS 同步目录实现多台电脑同步。"
        onClose={onClose}
      />
      <div className="settings-pane-body">
        <section className="settings-section">
          <h3>当前数据存储位置</h3>
          <div className="storage-box">
            <div className="storage-path-row">
              <code className="storage-path">{storage?.dataDir ?? "正在读取路径…"}</code>
              {storage?.dataDir && (
                <button
                  type="button"
                  className="ghost-btn small"
                  onClick={() => {
                    void navigator.clipboard?.writeText(storage.dataDir);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "已复制" : "复制路径"}
                </button>
              )}
            </div>
            <div className="storage-actions">
              {storage?.isDesktop ? (
                <>
                  <button type="button" className="primary-btn small" disabled={busy} onClick={() => void handlePickSyncDir()}>
                    <FolderSync size={14} /> 选择同步文件夹（iCloud / NAS）…
                  </button>
                  <button type="button" className="ghost-btn small" onClick={() => void desktopOpenDataDir()}>
                    <FolderOpen size={14} /> 打开数据文件夹
                  </button>
                  <button type="button" className="ghost-btn small" onClick={() => void desktopImportFolder()}>
                    <Import size={14} /> 合并其他文件夹数据…
                  </button>
                  {storage.isCustomDir && (
                    <button type="button" className="text-btn small" disabled={busy} onClick={() => void handleResetDir()}>
                      <RotateCcw size={13} /> 恢复默认位置
                    </button>
                  )}
                </>
              ) : (
                <button type="button" className="ghost-btn small" disabled={busy} onClick={() => void handleManualSync()}>
                  {busy ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} 立即扫描磁盘变更
                </button>
              )}
            </div>
          </div>
          <p className="settings-help">
            <strong>多台电脑同步方式：</strong>在桌面版点击上方“选择同步文件夹”，将目录指定到 <code>iCloud Drive</code>、群晖{" "}
            <code>Synology Drive</code>、<code>SMB/NAS</code> 挂载盘、<code>OneDrive</code> 或 <code>坚果云</code>{" "}
            中的同一个文件夹即可；网页开发模式可通过环境变量 <code>OPEN_NOTION_DATA=/同步目录路径 npm run dev</code> 指定。切换回窗口时会自动感知外部文件更新。
          </p>
        </section>

        <section className="settings-section">
          <h3>备份、导入与维护</h3>
          <div className="settings-card-row">
            <div>
              <strong>导出全量工作区备份（.zip）</strong>
              <p>生成双轨压缩包：解压后 notes/ 目录保留纯文本 Markdown 树与附件供自由阅读，同时附带结构化元数据支持 100% 无损还原。</p>
            </div>
            <a className="ghost-btn small" href="/api/backup/export" download>
              <Download size={14} /> 导出备份 .zip
            </a>
          </div>
          <div className="settings-card-row">
            <div>
              <strong>导入备份 / Obsidian / Notion 导出包</strong>
              <p>支持无损恢复 OpenNotion 备份包，或直接导入 Obsidian / Markdown 笔记库（自动转换双链与标签）及 Notion 导出包。</p>
            </div>
            <button
              type="button"
              className="ghost-btn small"
              onClick={() => {
                onClose();
                onImportNotionZip?.();
              }}
            >
              <Import size={14} /> 选择 .zip 导入…
            </button>
          </div>
          {hasHiddenSynced && (
            <div className="settings-card-row">
              <div>
                <strong>清理闲置同步块</strong>
                <p>移除已经没有任何页面引用的孤立同步块数据。</p>
              </div>
              <button type="button" className="ghost-btn small" onClick={() => void handleCleanSynced()}>
                <RefreshCw size={13} /> 立即清理
              </button>
            </div>
          )}
        </section>

        {notice && (
          <div className={cx("ai-status", notice.ok ? "ok" : "err")} role="status">
            {notice.text}
          </div>
        )}
      </div>
    </div>
  );
}

function McpSettingsPane({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<McpConfigPublic | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchMcpConfig().then(
      (c) => alive && setCfg(c),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  const copyText = (key: string, val: string) => {
    void navigator.clipboard?.writeText(val);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(null), 1800);
  };

  const patch = async (next: { enabled?: boolean; requireToken?: boolean; rotateToken?: boolean }) => {
    setBusy(true);
    try {
      setCfg(await updateMcpConfig(next));
    } finally {
      setBusy(false);
    }
  };

  const stdioParts = (cfg?.stdioCommand ?? "node server/mcp-stdio.ts").split(" ");
  const stdioSnippet = JSON.stringify(
    {
      mcpServers: {
        opennotion: {
          command: stdioParts[0],
          args: stdioParts.slice(1),
        },
      },
    },
    null,
    2,
  );

  const httpSnippet = JSON.stringify(
    {
      mcpServers: {
        opennotion: {
          url: cfg?.endpoint ?? `${window.location.origin}/api/mcp`,
          ...(cfg?.requireToken && cfg.token
            ? { headers: { Authorization: `Bearer ${cfg.token}` } }
            : {}),
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="settings-pane">
      <PaneHeader
        title="MCP 与开放接口"
        subtitle="通过原生 Model Context Protocol 让 Claude Code、Cursor、Windsurf 等外部 AI Agent 直接检索、写入与管理本地知识库。"
        onClose={onClose}
      />
      <div className="settings-pane-body">
        <section className="settings-section">
          <h3>服务状态与安全口令</h3>
          <div className="settings-card-row">
            <div>
              <strong>启用本地 MCP 服务（/api/mcp）</strong>
              <p>开启后，本机运行的 AI 编程工具或桌面客户端可通过标准 JSON-RPC 2.0 协议读写页面与多维数据库。</p>
            </div>
            <label className="auto-toggle-row">
              <input
                type="checkbox"
                checked={cfg?.enabled ?? true}
                disabled={busy}
                onChange={(e) => void patch({ enabled: e.target.checked })}
              />
              <span>{cfg?.enabled ? "已开启" : "已停用"}</span>
            </label>
          </div>

          <div className="settings-card-row">
            <div>
              <strong>要求 Bearer Token 鉴权</strong>
              <p>对同机 HTTP 请求额外校验口令（跨站书签剪藏始终强制校验此口令）。</p>
            </div>
            <label className="auto-toggle-row">
              <input
                type="checkbox"
                checked={cfg?.requireToken ?? false}
                disabled={busy}
                onChange={(e) => void patch({ requireToken: e.target.checked })}
              />
              <span>{cfg?.requireToken ? "强制校验" : "本机免密"}</span>
            </label>
          </div>

          <div className="mcp-copy-bar">
            <KeyRound size={14} />
            <input readOnly value={cfg?.token ?? "加载中…"} aria-label="安全口令" />
            <button
              type="button"
              className="ghost-btn small"
              disabled={!cfg}
              onClick={() => cfg && copyText("token", cfg.token)}
            >
              {copiedKey === "token" ? <Check size={13} /> : <Copy size={13} />}
              {copiedKey === "token" ? "已复制" : "复制口令"}
            </button>
            <button
              type="button"
              className="text-btn small"
              disabled={busy}
              onClick={() => void patch({ rotateToken: true })}
            >
              <RefreshCw size={13} /> 重置
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="mcp-code-head">
            <h3>方式一：Streamable HTTP 接入（应用运行时即连即用）</h3>
            <button
              type="button"
              className="ghost-btn small"
              onClick={() => copyText("http", httpSnippet)}
            >
              {copiedKey === "http" ? <Check size={13} /> : <Copy size={13} />}
              {copiedKey === "http" ? "已复制配置" : "复制 JSON"}
            </button>
          </div>
          <pre className="mcp-code-box">{httpSnippet}</pre>

          <div className="mcp-code-head" style={{ marginTop: 14 }}>
            <h3>方式二：Stdio 独立进程接入（无需提前打开界面）</h3>
            <button
              type="button"
              className="ghost-btn small"
              onClick={() => copyText("stdio", stdioSnippet)}
            >
              {copiedKey === "stdio" ? <Check size={13} /> : <Copy size={13} />}
              {copiedKey === "stdio" ? "已复制配置" : "复制 JSON"}
            </button>
          </div>
          <pre className="mcp-code-box">{stdioSnippet}</pre>
        </section>

        <section className="settings-section">
          <h3>内置 MCP 工具清单（{cfg?.tools.length ?? 7} 项）</h3>
          <div className="shortcut-list">
            {(cfg?.tools ?? []).map((t) => (
              <div key={t.name} className="shortcut-row">
                <code>{t.name}</code>
                <span>{t.description}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function TrashPane({ items, onClose }: { items: ReturnType<typeof useTree>["trash"]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((p) => (p.title || "无标题").toLowerCase().includes(q)) : items;

  return (
    <div className="settings-pane">
      <PaneHeader title="回收站" subtitle="已删除的页面会暂存在这里，可随时恢复或彻底清除。" onClose={onClose} />
      <div className="settings-pane-body">
        <div className="settings-trash-bar">
          <label className="settings-search">
            <Search size={14} />
            <input
              value={query}
              placeholder="搜索已删除的页面…"
              aria-label="筛选回收站"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {items.length > 0 && (
            <button
              type="button"
              className="ghost-btn small danger-text"
              onClick={() => {
                if (window.confirm(`永久删除回收站中的全部 ${items.length} 个页面？此操作无法撤销。`)) {
                  void emptyTrash();
                }
              }}
            >
              <Eraser size={14} /> 清空回收站
            </button>
          )}
        </div>

        <div className="settings-trash-list">
          {shown.map((p) => (
            <div
              key={p.id}
              className="trash-row"
              role="button"
              tabIndex={0}
              onClick={() => {
                navigate(p.id);
                onClose();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.target === e.currentTarget) {
                  navigate(p.id);
                  onClose();
                }
              }}
            >
              <span className="tree-icon">{p.icon ?? <FileText size={16} />}</span>
              <span className="trash-title">{p.title || "无标题"}</span>
              <button
                type="button"
                className="ghost-btn small"
                title="恢复页面"
                aria-label={`恢复“${p.title || "无标题"}”`}
                onClick={(e) => {
                  e.stopPropagation();
                  void restorePage(p.id);
                }}
              >
                <Undo2 size={13} /> 恢复
              </button>
              <button
                type="button"
                className="icon-btn small"
                title="永久删除"
                aria-label={`永久删除“${p.title || "无标题"}”`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`永久删除“${p.title || "无标题"}”及其子页面？此操作无法撤销。`)) {
                    void deletePage(p.id);
                  }
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {shown.length === 0 && (
            <div className="trash-empty">
              {items.length === 0 ? <Trash size={28} strokeWidth={1.5} /> : <SearchX size={28} strokeWidth={1.5} />}
              {items.length === 0 ? "回收站是空的" : "没有匹配的页面"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AiProvidersPane({ onClose }: { onClose: () => void }) {
  const [drafts, setDrafts] = useState<DraftProvider[]>([]);
  const [selectedId, setSelectedId] = useState<string>("deepseek");
  const [activeProviderId, setActiveProviderId] = useState<string>("deepseek");
  const [activeModel, setActiveModel] = useState<string>("");
  const [temperature, setTemperature] = useState<number>(0.7);
  const [customSystemPrompt, setCustomSystemPrompt] = useState<string>("");
  const [showKey, setShowKey] = useState(false);
  const [newModel, setNewModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    loadAiConfig().then(
      (cfg) => {
        if (!alive) return;
        setDrafts(toDrafts(cfg));
        setSelectedId(cfg.activeProviderId);
        setActiveProviderId(cfg.activeProviderId);
        setActiveModel(cfg.activeModel);
        setTemperature(cfg.temperature);
        setCustomSystemPrompt(cfg.customSystemPrompt);
      },
      (err: Error) => alive && setStatus({ ok: false, text: err.message }),
    );
    return () => {
      alive = false;
    };
  }, []);

  const current = drafts.find((d) => d.id === selectedId) ?? drafts[0];

  const patchCurrent = (change: Partial<DraftProvider>) => {
    if (!current) return;
    setDrafts((prev) => prev.map((d) => (d.id === current.id ? { ...d, ...change } : d)));
    setStatus(null);
  };

  const addCustomProvider = () => {
    const id = `custom_${shortId()}`;
    const created: DraftProvider = {
      id,
      name: "自定义模型服务",
      region: "custom",
      builtin: false,
      protocol: "openai",
      baseUrl: "https://api.example.com/v1",
      models: ["gpt-4o-mini"],
      keyOptional: false,
      hasKey: false,
      keyHint: "",
      draftKey: "",
      clearKey: false,
      headersText: "",
    };
    setDrafts((prev) => [...prev, created]);
    setSelectedId(id);
    setStatus(null);
  };

  const removeCustomProvider = () => {
    if (!current || current.builtin) return;
    const next = drafts.filter((d) => d.id !== current.id);
    setDrafts(next);
    const fallback = next[0];
    if (fallback) {
      setSelectedId(fallback.id);
      if (activeProviderId === current.id) {
        setActiveProviderId(fallback.id);
        setActiveModel(fallback.models[0] ?? "");
      }
    }
  };

  const addModel = () => {
    if (!current) return;
    const m = newModel.trim();
    if (!m) return;
    const models = current.models.includes(m) ? current.models : [...current.models, m];
    patchCurrent({ models });
    setActiveProviderId(current.id);
    setActiveModel(m);
    setNewModel("");
  };

  const pullModels = async () => {
    if (!current) return;
    setFetchingModels(true);
    setStatus(null);
    try {
      const remote = await fetchRemoteModels({
        providerId: current.builtin ? current.id : undefined,
        protocol: current.protocol,
        baseUrl: current.baseUrl,
        apiKey: current.draftKey.trim() || undefined,
        headers: textToHeaders(current.headersText),
      });
      if (remote.length === 0) {
        setStatus({ ok: false, text: "接口未返回可用模型列表，可手动输入模型名称添加。" });
      } else {
        const merged = [...new Set([...current.models, ...remote.slice(0, 60)])];
        patchCurrent({ models: merged });
        if (!activeModel || activeProviderId === current.id) setActiveModel(remote[0]);
        setStatus({ ok: true, text: `已从接口同步 ${remote.length} 个模型` });
      }
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setFetchingModels(false);
    }
  };

  const runTest = async () => {
    if (!current) return;
    setTesting(true);
    setStatus(null);
    try {
      const modelToTest =
        activeProviderId === current.id && activeModel ? activeModel : (current.models[0] ?? newModel.trim());
      const saved = await saveAiConfig({
        providers: toUpdates(drafts),
        activeProviderId,
        activeModel,
        temperature,
        customSystemPrompt,
      });
      setDrafts(toDrafts(saved));
      const res = await testAiProvider({
        providerId: current.id,
        model: modelToTest,
        protocol: current.protocol,
        baseUrl: current.baseUrl,
        headers: textToHeaders(current.headersText),
      });
      setStatus({ ok: true, text: `连接正常（${res.ms} ms · ${res.model}）：${res.reply}` });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const saveAndClose = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await saveAiConfig({
        providers: toUpdates(drafts),
        activeProviderId,
        activeModel,
        temperature,
        customSystemPrompt,
      });
      onClose();
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ai-pane-layout">
      <div className="ai-provider-rail">
        <div className="ai-provider-list">
          {REGION_TITLES.map(({ region, label }) => {
            const items = drafts.filter((d) => d.region === region);
            return (
              <div key={region} className="ai-provider-group">
                <div className="ai-provider-group-title">{label}</div>
                {items.map((p) => {
                  const configured = (p.hasKey && !p.clearKey) || Boolean(p.draftKey.trim()) || Boolean(p.keyOptional);
                  const isDefault = p.id === activeProviderId;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={cx("ai-provider-item", p.id === current?.id && "active")}
                      onClick={() => {
                        setSelectedId(p.id);
                        setStatus(null);
                      }}
                    >
                      <span className={cx("ai-dot", configured && "ready")} />
                      <span className="ai-provider-name">{p.name.replace(/（.+）/, "")}</span>
                      {isDefault && <span className="tree-badge">默认</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <button type="button" className="ghost-btn small ai-add-provider" onClick={addCustomProvider}>
          <Plus size={14} /> 添加自定义服务
        </button>
      </div>

      <div className="ai-settings-main">
        <div className="ai-settings-top">
          <div>
            <h2>{current?.name ?? "模型配置"}</h2>
            <p className="ai-settings-sub">
              密钥以 0600 权限保存在本机 <code>ai.json</code>，由本机进程直连模型接口，不经过任何第三方中转。
            </p>
          </div>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {current && (
          <div className="ai-settings-body">
            {!current.builtin && (
              <div className="ai-form-row two-col">
                <label className="ai-field">
                  <span>服务名称</span>
                  <input
                    value={current.name}
                    placeholder="例如：硅基流动 / OpenRouter / 公司网关"
                    onChange={(e) => patchCurrent({ name: e.target.value })}
                  />
                </label>
                <label className="ai-field">
                  <span>接口协议</span>
                  <select
                    value={current.protocol}
                    onChange={(e) => patchCurrent({ protocol: e.target.value as AiProtocol })}
                  >
                    <option value="openai">OpenAI 兼容 (/chat/completions)</option>
                    <option value="anthropic">Anthropic Messages (/messages)</option>
                    <option value="gemini">Google Gemini (generateContent)</option>
                  </select>
                </label>
              </div>
            )}

            <label className="ai-field">
              <span className="ai-field-head">
                <span>接口地址（Base URL）</span>
                {current.defaultBaseUrl && current.baseUrl !== current.defaultBaseUrl && (
                  <button
                    type="button"
                    className="text-btn small"
                    onClick={() => patchCurrent({ baseUrl: current.defaultBaseUrl! })}
                  >
                    <RotateCcw size={12} /> 恢复默认
                  </button>
                )}
              </span>
              <input
                value={current.baseUrl}
                placeholder="https://api.deepseek.com/v1"
                spellCheck={false}
                onChange={(e) => patchCurrent({ baseUrl: e.target.value })}
              />
            </label>

            <div className="ai-field">
              <span className="ai-field-head">
                <span>
                  API Key
                  {current.hasKey && !current.clearKey && !current.draftKey && (
                    <em className="ai-key-saved">已保存：{current.keyHint}</em>
                  )}
                </span>
                <span className="ai-field-actions">
                  {!current.builtin && (
                    <label className="ai-inline-check">
                      <input
                        type="checkbox"
                        checked={Boolean(current.keyOptional)}
                        onChange={(e) => patchCurrent({ keyOptional: e.target.checked })}
                      />
                      免 Key（本地服务）
                    </label>
                  )}
                  {current.hasKey && !current.clearKey && (
                    <button
                      type="button"
                      className="text-btn small danger"
                      onClick={() => patchCurrent({ clearKey: true, draftKey: "" })}
                    >
                      清除已存 Key
                    </button>
                  )}
                </span>
              </span>
              <div className="ai-key-input">
                <input
                  type={showKey ? "text" : "password"}
                  value={current.draftKey}
                  placeholder={
                    current.hasKey && !current.clearKey
                      ? "留空则继续使用已保存的 Key，输入新值可替换"
                      : (current.keyPlaceholder ?? "输入 API Key…")
                  }
                  spellCheck={false}
                  onChange={(e) => patchCurrent({ draftKey: e.target.value, clearKey: false })}
                />
                <button
                  type="button"
                  className="icon-btn small"
                  aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            <div className="ai-field">
              <span className="ai-field-head">
                <span>可用模型（点击设为当前默认模型）</span>
                <button
                  type="button"
                  className="ghost-btn small"
                  disabled={fetchingModels}
                  onClick={() => void pullModels()}
                >
                  {fetchingModels ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} 从接口同步模型
                </button>
              </span>
              {current.modelHint && <div className="ai-hint">{current.modelHint}</div>}
              <div className="ai-models-wrap">
                {current.models.map((m) => {
                  const selected = activeProviderId === current.id && activeModel === m;
                  return (
                    <span key={m} className={cx("ai-model-chip", selected && "selected")}>
                      <button
                        type="button"
                        className="ai-model-pick"
                        onClick={() => {
                          setActiveProviderId(current.id);
                          setActiveModel(m);
                        }}
                      >
                        {selected ? <Check size={13} /> : <Sparkles size={12} />}
                        <span>{m}</span>
                      </button>
                      {current.models.length > 1 && (
                        <button
                          type="button"
                          className="tag-remove"
                          aria-label={`移除模型 ${m}`}
                          onClick={() => {
                            const nextModels = current.models.filter((x) => x !== m);
                            patchCurrent({ models: nextModels });
                            if (selected) setActiveModel(nextModels[0] ?? "");
                          }}
                        >
                          <X size={11} />
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
              <div className="ai-add-model">
                <input
                  value={newModel}
                  placeholder="输入自定义模型 ID 或接入点 ID（如 deepseek-v3 / ep-2026...）后回车"
                  spellCheck={false}
                  onChange={(e) => setNewModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (!e.nativeEvent.isComposing && e.key === "Enter") {
                      e.preventDefault();
                      addModel();
                    }
                  }}
                />
                <button type="button" className="ghost-btn small" onClick={addModel}>
                  <Plus size={14} /> 添加
                </button>
              </div>
            </div>

            <details className="ai-advanced">
              <summary>高级参数（自定义请求头、温度、全局提示词）</summary>
              <div className="ai-advanced-body">
                <label className="ai-field">
                  <span>自定义请求头（可选，每行一个 Header: Value）</span>
                  <textarea
                    rows={2}
                    spellCheck={false}
                    placeholder="例如：HTTP-Referer: https://opennotion.local"
                    value={current.headersText}
                    onChange={(e) => patchCurrent({ headersText: e.target.value })}
                  />
                </label>
                <div className="ai-form-row two-col">
                  <label className="ai-field">
                    <span>生成温度（Temperature：{temperature.toFixed(1)}）</span>
                    <input
                      type="range"
                      min={0}
                      max={1.5}
                      step={0.1}
                      value={temperature}
                      onChange={(e) => setTemperature(Number(e.target.value))}
                    />
                  </label>
                  <label className="ai-field">
                    <span>当前默认模型</span>
                    <input
                      readOnly
                      value={`${drafts.find((d) => d.id === activeProviderId)?.name.replace(/（.+）/, "") ?? activeProviderId} · ${activeModel}`}
                    />
                  </label>
                </div>
                <label className="ai-field">
                  <span>全局附加指令（可选，对所有 AI 对话与写作生效）</span>
                  <textarea
                    rows={2}
                    placeholder="例如：默认使用简体中文回答，行文尽量克制精炼。"
                    value={customSystemPrompt}
                    onChange={(e) => setCustomSystemPrompt(e.target.value)}
                  />
                </label>
              </div>
            </details>

            {status && (
              <div className={cx("ai-status", status.ok ? "ok" : "err")} role="status">
                {status.text}
              </div>
            )}
          </div>
        )}

        <div className="ai-settings-foot">
          <div className="ai-settings-foot-left">
            <button type="button" className="ghost-btn small" disabled={testing} onClick={() => void runTest()}>
              {testing ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />} 测试连接
            </button>
            {current && !current.builtin && (
              <button type="button" className="text-btn small danger" onClick={removeCustomProvider}>
                <Trash2 size={14} /> 删除服务
              </button>
            )}
          </div>
          <div className="ai-settings-foot-right">
            <button type="button" className="ghost-btn small" onClick={onClose}>
              取消
            </button>
            <button type="button" className="primary-btn small" disabled={saving} onClick={() => void saveAndClose()}>
              {saving ? "保存中…" : "保存设置"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
