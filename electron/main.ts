/**
 * 桌面版主进程：在本机回环地址上启动“静态页面 + 存储 API”服务，
 * 再开一个窗口加载它。数据默认放在系统的用户数据目录里。
 */
import { BrowserWindow, Menu, app, dialog, nativeTheme, shell, type MenuItemConstructorOptions } from "electron";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createApiMiddleware } from "../server/api.ts";

/**
 * 固定端口：浏览器的本地存储（主题、展开状态等）是按“地址 + 端口”区分的，
 * 端口每次都变的话这些偏好每次启动都会丢。被占用时才退回随机端口。
 */
const PREFERRED_PORT = 47120;

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  map: "application/json",
};

// 测试时可以把浏览器配置和数据都指到临时目录，不碰真实数据
if (process.env.OPEN_NOTION_PROFILE) app.setPath("userData", path.resolve(process.env.OPEN_NOTION_PROFILE));

const defaultDataDir = path.join(app.getPath("userData"), "data");
const configFile = path.join(app.getPath("userData"), "desktop-config.json");
const webRoot = path.join(__dirname, "..", "dist");

let dataDir = process.env.OPEN_NOTION_DATA ? path.resolve(process.env.OPEN_NOTION_DATA) : defaultDataDir;
let api = createApiMiddleware(dataDir);

async function readSavedDataDir(): Promise<string | null> {
  if (process.env.OPEN_NOTION_DATA) return path.resolve(process.env.OPEN_NOTION_DATA);
  try {
    const raw = await fs.readFile(configFile, "utf8");
    const parsed = JSON.parse(raw) as { customDataDir?: unknown };
    if (typeof parsed.customDataDir === "string" && parsed.customDataDir.trim()) {
      const candidate = path.resolve(parsed.customDataDir);
      await fs.mkdir(candidate, { recursive: true });
      return candidate;
    }
  } catch {
    /* 配置文件不存在或外接盘/NAS 暂未挂载时自动退回默认目录 */
  }
  return null;
}

async function saveCustomDataDir(customDataDir: string | null) {
  await fs.writeFile(configFile, JSON.stringify({ customDataDir }, null, 2));
}

async function copyWorkspaceIfEmpty(fromDir: string, toDir: string) {
  if (path.resolve(fromDir) === path.resolve(toDir)) return;
  const targetPages = path.join(toDir, "pages");
  const existing = await fs.readdir(targetPages).catch(() => [] as string[]);
  if (existing.some((f) => f.endsWith(".json"))) return;
  for (const sub of ["pages", "uploads", "history"]) {
    const src = path.join(fromDir, sub);
    const stat = await fs.stat(src).catch(() => null);
    if (stat?.isDirectory()) {
      await fs.cp(src, path.join(toDir, sub), { recursive: true, force: false, errorOnExist: false });
    }
  }
  for (const cfgName of ["ai.json", "mcp.json", "backup-config.json"]) {
    const src = path.join(fromDir, cfgName);
    const dst = path.join(toDir, cfgName);
    const hasDst = await fs.stat(dst).catch(() => null);
    const hasSrc = await fs.stat(src).catch(() => null);
    if (hasSrc && !hasDst) {
      await fs.copyFile(src, dst);
      await fs.chmod(dst, 0o600).catch(() => {});
    }
  }
}

async function switchDataDir(nextCustomDir: string | null) {
  if (mainWindow) await flushPage(mainWindow);
  await api.flush().catch(() => {});
  api.close();

  const targetDir = nextCustomDir ? path.resolve(nextCustomDir) : defaultDataDir;
  await fs.mkdir(targetDir, { recursive: true });
  if (nextCustomDir) await copyWorkspaceIfEmpty(dataDir, targetDir);
  await saveCustomDataDir(nextCustomDir ? targetDir : null);

  dataDir = targetDir;
  api = createApiMiddleware(dataDir);
  buildMenu();
}

let mainWindow: BrowserWindow | null = null;
let origin = "";
let quitRequested = false;

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  let file = path.join(webRoot, decodeURIComponent(pathname));
  // 不允许用 ../ 读到应用目录之外
  if (file !== webRoot && !file.startsWith(webRoot + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  let stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) {
    // 单页应用：其余路径都交给 index.html
    file = path.join(webRoot, "index.html");
    stat = await fs.stat(file);
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": stat.size,
    // 带哈希的构建产物可以长期缓存，入口页每次都重新取
    "Cache-Control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function chooseSyncFolder(): Promise<boolean> {
  const win = mainWindow;
  if (!win) return false;
  const picked = await dialog.showOpenDialog(win, {
    title: "选择数据存储与同步目录",
    message: "可选择 iCloud Drive、NAS 挂载盘、Synology Drive、坚果云或 OneDrive 中的文件夹实现多端同步",
    properties: ["openDirectory", "createDirectory"],
  });
  if (picked.canceled || !picked.filePaths[0]) return false;
  await switchDataDir(picked.filePaths[0]);
  return true;
}

function startServer(): Promise<number> {
  const server = http.createServer((req, res) => {
    // 只接受以回环地址访问的请求，挡住把外部域名解析到本机的“DNS 重绑定”
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? "")) {
      res.writeHead(403).end();
      return;
    }
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    // 浏览器书签栏剪藏（/api/clip）与跨域 MCP 请求（/api/mcp）交由 api 中间件强制校验 Bearer Token 口令
    const allowBearerCors = pathname === "/api/clip" || pathname === "/api/mcp";
    const reqOrigin = req.headers.origin;
    if (reqOrigin && new URL(reqOrigin).host !== req.headers.host && !allowBearerCors) {
      res.writeHead(403).end();
      return;
    }
    if (pathname === "/api/storage" && req.method === "GET") {
      void api.sync().then(
        () =>
          sendJson(res, 200, {
            storage: {
              dataDir,
              defaultDataDir,
              isDesktop: true,
              isCustomDir: path.resolve(dataDir) !== path.resolve(defaultDataDir),
            },
          }),
        (err: Error) => sendJson(res, 500, { error: err.message }),
      );
      return;
    }
    if (pathname.startsWith("/api/desktop/") && req.method === "POST") {
      const action = pathname.slice("/api/desktop/".length);
      void (async () => {
        if (action === "open-dir") {
          await shell.openPath(dataDir);
          return sendJson(res, 200, { ok: true });
        }
        if (action === "pick-dir") {
          const changed = await chooseSyncFolder();
          return sendJson(res, 200, {
            changed,
            storage: {
              dataDir,
              defaultDataDir,
              isDesktop: true,
              isCustomDir: path.resolve(dataDir) !== path.resolve(defaultDataDir),
            },
          });
        }
        if (action === "reset-dir") {
          await switchDataDir(null);
          return sendJson(res, 200, {
            changed: true,
            storage: {
              dataDir,
              defaultDataDir,
              isDesktop: true,
              isCustomDir: false,
            },
          });
        }
        if (action === "import-folder") {
          await importFolder();
          return sendJson(res, 200, { ok: true });
        }
        sendJson(res, 404, { error: "未知桌面指令" });
      })().catch((err: Error) => sendJson(res, 500, { error: err.message }));
      return;
    }

    api(req, res, () => {
      serveStatic(req, res).catch((err) => {
        console.error("[static]", err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });

  return new Promise((resolve, reject) => {
    const listen = (port: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port !== 0) listen(0);
        else reject(err);
      };
      server.once("error", onError);
      // 只监听回环地址，局域网里的其他设备访问不到
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve((server.address() as AddressInfo).port);
      });
    };
    listen(PREFERRED_PORT);
  });
}

function isExternal(url: string): boolean {
  try {
    return new URL(url).origin !== origin;
  } catch {
    return true;
  }
}

function openExternal(url: string) {
  // 只把网页和邮件链接交给系统浏览器
  if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
}

/** 让页面把还没发出的修改立刻保存，最多等 3 秒 */
async function flushPage(win: BrowserWindow) {
  if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
  const flush = win.webContents.executeJavaScript("window.__openNotionFlush ? window.__openNotionFlush() : null", true);
  await Promise.race([flush.catch(() => null), new Promise((resolve) => setTimeout(resolve, 3000))]);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 480,
    show: false,
    title: "OpenNotion",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#191919" : "#ffffff",
    webPreferences: {
      // 页面只是一个普通网页：不给它 Node 能力，也不需要预加载脚本
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // 关窗口前先让页面保存；页面自己的“离开前确认”在桌面版里不需要
  let closing = false;
  win.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    void flushPage(win).finally(() => {
      win.destroy();
      if (quitRequested) app.quit();
    });
  });
  win.webContents.on("will-prevent-unload", (event) => event.preventDefault());

  // 外部链接用系统浏览器打开，窗口本身不离开应用
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) openExternal(url);
    else void win.loadURL(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isExternal(url)) return;
    event.preventDefault();
    openExternal(url);
  });

  void win.loadURL(origin);

  // 冒烟测试：加载完截一张图然后退出，用来在没有人看屏幕时确认应用能起来
  const shot = process.env.OPEN_NOTION_SMOKE_SHOT;
  if (shot) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        await fs.writeFile(shot, image.toPNG());
        app.quit();
      }, 3500);
    });
  }
}

/** 把另一份数据（比如网页版项目里的 data/ 目录）并进来 */
async function importFolder() {
  const win = mainWindow;
  if (!win) return;
  const picked = await dialog.showOpenDialog(win, {
    title: "选择要导入的数据文件夹",
    message: "选择网页版项目里的 data 文件夹（里面有 pages 目录）",
    properties: ["openDirectory"],
  });
  if (picked.canceled || !picked.filePaths[0]) return;
  try {
    // 先让页面把没保存的内容写下去，免得刷新时丢失
    await flushPage(win);
    const result = await api.importFolder(picked.filePaths[0]);
    await dialog.showMessageBox(win, {
      type: "info",
      message: "导入完成",
      detail: `新增 ${result.pages} 个页面、${result.files} 个附件。${
        result.skipped > 0 ? `\n有 ${result.skipped} 个页面已经存在或无法读取，已跳过，没有覆盖现有内容。` : ""
      }`,
    });
    win.webContents.reload();
  } catch (err) {
    dialog.showErrorBox("导入失败", err instanceof Error ? err.message : String(err));
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    {
      label: "文件",
      submenu: [
        { label: "打开数据文件夹", click: () => void shell.openPath(dataDir) },
        {
          label: "更改数据存储目录（iCloud / NAS 同步）…",
          click: () => {
            void chooseSyncFolder().then((changed) => {
              if (changed) mainWindow?.webContents.reload();
            });
          },
        },
        { label: "从文件夹导入数据…", click: () => void importFolder() },
        { type: "separator" },
        isMac ? { role: "close", label: "关闭窗口" } : { role: "quit", label: "退出" },
      ],
    },
    { role: "editMenu", label: "编辑" },
    { role: "viewMenu", label: "视图" },
    { role: "windowMenu", label: "窗口" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 数据由一个进程独占读写；再次启动时只把已有窗口带到前面
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("before-quit", () => {
    quitRequested = true;
  });

  // 所有窗口都关掉之后，等磁盘写完再真正退出
  let diskFlushed = false;
  app.on("will-quit", (event) => {
    if (diskFlushed) return;
    event.preventDefault();
    void api
      .flush()
      .catch(() => {})
      .finally(() => {
        diskFlushed = true;
        app.quit();
      });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (!mainWindow && origin) createWindow();
  });

  app
    .whenReady()
    .then(async () => {
      const savedDir = await readSavedDataDir();
      if (savedDir && savedDir !== dataDir) {
        api.close();
        dataDir = savedDir;
        api = createApiMiddleware(dataDir);
      }
      await fs.mkdir(dataDir, { recursive: true });
      const port = await startServer();
      origin = `http://127.0.0.1:${port}`;
      buildMenu();
      createWindow();
    })
    .catch((err) => {
      dialog.showErrorBox("OpenNotion 无法启动", err instanceof Error ? (err.stack ?? err.message) : String(err));
      app.exit(1);
    });
}
