// 投标精灵服务端（网页版）：纯 Node 进程，通过 Module._load 桩复用
// electron/ipc 与 electron/services 的全部既有代码，向浏览器提供
// WS RPC + 事件推送。桌面版 Electron 主进程不受影响（双形态共存）。
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const { installElectronStub } = require('./runtime/installElectronStub.cjs');
const { createAppStub } = require('./runtime/appStub.cjs');
const { ipcMainStub } = require('./runtime/ipcMainStub.cjs');
const { createDialogBridge } = require('./runtime/dialogBridge.cjs');
const { createEventHub, sendFrame } = require('./ws/events.cjs');

const packageJson = require('../package.json');

const PORT = Number(process.env.YIBIAO_SERVER_PORT || 8737);
const DATA_DIR = path.resolve(process.env.YIBIAO_SERVER_DATA_DIR || path.join(__dirname, 'data'));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// 启动时清扫超过 24 小时的历史上传文件。上传占位符在一次会话内可被同一
// File 复用（拖拽入池 → 再点导入），所以不做"RPC 消费即删"；磁盘膨胀靠
// 定期清扫兜底，注册表 Map 只存路径字符串，内存占用可忽略。
function sweepStaleUploads() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let swept = 0;
  for (const name of fs.readdirSync(UPLOADS_DIR)) {
    const filePath = path.join(UPLOADS_DIR, name);
    try {
      if (fs.statSync(filePath).isFile() && fs.statSync(filePath).mtimeMs < cutoff) {
        fs.rmSync(filePath, { force: true });
        swept += 1;
      }
    } catch {
      // 单个文件清理失败不影响启动。
    }
  }
  if (swept > 0) console.log(`[server] 已清扫 ${swept} 个超过 24 小时的历史上传文件`);
}
sweepStaleUploads();

const app = createAppStub({ dataDir: DATA_DIR, version: packageJson.version });
const hub = createEventHub();
const dialogBridge = createDialogBridge({ hub });
installElectronStub({
  app,
  dialogBridge,
  saveDialogDir: DOWNLOADS_DIR,
  // 服务端转图走 headless Chromium（本机 Chrome/Edge），替代桌面版离屏窗口。
  headlessRenderServiceFactory: () => require('./runtime/headlessRenderService.cjs'),
});

// 桩就位后再加载装配中心，保证其内部 require('electron') 拿到的是桩。
const { registerIpcHandlers } = require('../electron/ipc/index.cjs');
const { getCredentialLibraryDir, getGeneratedImagesDir, getImportedImagesDir, getNoticeCacheDir } = require('../electron/utils/paths.cjs');

const noop = () => undefined;

// 服务端是常驻进程：任何未被消费的 Promise 拒绝只记日志，不让 Node 默认行为退出进程。
process.on('unhandledRejection', (reason) => {
  console.warn('[server] 未处理的 Promise 拒绝', reason?.message || String(reason));
});
// Main 侧推送（donation/dependencies/dual-layer-pdf/database 状态等）
// 都经 mainWindow.webContents.send 广播到已订阅该通道的浏览器连接。
const mainWindowStub = {
  isDestroyed: () => false,
  webContents: {
    id: 0,
    isDestroyed: () => false,
    isLoading: () => false,
    send: (channel, payload) => hub.broadcast(channel, [payload]),
    once: noop,
    on: noop,
  },
};

registerIpcHandlers({
  app,
  mainWindow: mainWindowStub,
  checkAndDownloadUpdate: async () => null,
  triggerUpdateDownload: async () => undefined,
  isUpdateCacheInUse: () => false,
  quitAndInstall: noop,
  getLatestVersion: async () => null,
  getUpdateDownloadUrl: () => null,
  gpuStartupState: { hardwareAccelerationEnabled: true },
  forceDisableGpuArgs: [],
  openDeveloperTokenStatsWindow: noop,
  closeDeveloperTokenStatsWindow: noop,
  openDeveloperAgentMonitorWindow: noop,
  closeDeveloperAgentMonitorWindow: noop,
  getRendererWindowUrl: () => null,
});

// 对话框桥回填：浏览器垫片选完文件并上传后调用，把结果交还给等待中的 showOpenDialog。
ipcMainStub.handle('__dialog:resolve', (_event, requestId, result) => dialogBridge.resolveOpen(requestId, result));

// JSON 通道无法直接传二进制：Uint8Array/Buffer 统一编码为 base64 标记对象，
// Renderer 垫片收到后还原为 Uint8Array（Word 导出、模板样张等依赖此约定）。
function encodeBinary(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) {
    return { __yibiao_binary: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(encodeBinary);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = encodeBinary(item);
  }
  return out;
}

// 浏览器拖拽文件没有本地路径：垫片先把文件传到 /web-upload，再把
// web-upload://<id> 占位符作为路径传下来，调用前在这里还原为服务器真实路径。
const uploadRegistry = new Map(); // id -> Promise<absolutePath>

const UPLOAD_TOKEN_RE = /^web-upload:\/\/([0-9a-fA-F-]{8,64})$/;

async function resolveUploadTokenDeep(value) {
  if (typeof value === 'string') {
    const match = UPLOAD_TOKEN_RE.exec(value);
    if (match) {
      const pending = uploadRegistry.get(match[1]);
      if (!pending) {
        throw new Error(`文件尚未上传或上传已失效：${value}`);
      }
      return pending;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveUploadTokenDeep(item)));
  }
  if (value && typeof value === 'object') {
    const out = {};
    await Promise.all(Object.entries(value).map(async ([key, item]) => {
      out[key] = await resolveUploadTokenDeep(item);
    }));
    return out;
  }
  return value;
}

async function dispatchRpc(sender, channel, args) {
  const handler = ipcMainStub.__getHandler(channel);
  if (!handler) {
    throw new Error(`No handler registered for '${channel}'`);
  }
  const resolvedArgs = await resolveUploadTokenDeep(args);
  return handler({ sender }, ...(Array.isArray(resolvedArgs) ? resolvedArgs : []));
}

// yibiao-asset 资产静态服务：与 main.cjs 的 protocol.handle 同一套目录映射与越界防护。
const ASSET_CONTENT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf',
};

function serveAsset(req, res, assetPath) {
  const hosts = {
    'credential-library': getCredentialLibraryDir(app),
    'generated-images': getGeneratedImagesDir(app),
    'imported-images': getImportedImagesDir(app),
    'notice-cache': getNoticeCacheDir(app),
  };
  const [host, ...rest] = assetPath.split('/');
  const rootDir = hosts[host];
  const relativePath = rest.join('/');
  const fail = (status, message) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
  };
  if (!rootDir || !relativePath) {
    fail(404, 'Not Found');
    return;
  }
  const baseDir = path.resolve(rootDir);
  const filePath = path.resolve(baseDir, relativePath);
  if (filePath !== baseDir && !filePath.startsWith(`${baseDir}${path.sep}`)) {
    fail(403, 'Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(404, 'Not Found');
    return;
  }
  const stat = fs.statSync(filePath);
  const contentType = ASSET_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const rangeHeader = req.headers.range;
  // 公告视频等媒体按 Range 输出，支持拖动进度条。
  const rangeMatch = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null;
  if (rangeMatch) {
    let start = rangeMatch[1] === '' ? 0 : Number(rangeMatch[1]);
    let end = rangeMatch[2] === '' ? stat.size - 1 : Number(rangeMatch[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Content-Length': stat.size,
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  // yibiao-asset 资产路由：等价于桌面版 main.cjs 注册的自定义协议
  // （公告媒体/生成图/资质图片/导入图），URL 形如 /yibiao-asset/<host>/<path>。
  const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  let urlPath = '';
  try {
    urlPath = decodeURIComponent(requestUrl.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (req.method === 'GET' && urlPath.startsWith('/yibiao-asset/')) {
    serveAsset(req, res, urlPath.replace(/^\/yibiao-asset\//, ''));
    return;
  }

  // 浏览器文件上传：POST /web-upload?id=<uuid>&name=<文件名>，二进制 body；
  // 成功后登记 uploadRegistry，等垫片用 web-upload://<id> 占位符调 RPC 时还原路径。
  if (req.method === 'POST' && requestUrl.pathname === '/web-upload') {
    const id = /^[0-9a-fA-F-]{8,64}$/.test(requestUrl.searchParams.get('id') || '')
      ? requestUrl.searchParams.get('id')
      : crypto.randomUUID();
    const rawName = requestUrl.searchParams.get('name') || 'file';
    const safeName = path.basename(rawName).replace(/[\\/:*?"<>|]/g, '_') || 'file';
    const dest = path.join(UPLOADS_DIR, `${id}-${safeName}`);
    // 大文件（数百 MB 标书 PDF）直接流式写盘，避免全量内存缓冲。
    const uploadRejected = (error) => {
      // 注册表里的失败 Promise 必须先挂 catch，否则无人消费时触发 unhandledRejection。
      const rejected = Promise.reject(error);
      rejected.catch(noop);
      uploadRegistry.set(id, rejected);
    };
    const stream = fs.createWriteStream(dest);
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      stream.destroy();
      fs.rmSync(dest, { force: true });
      uploadRejected(error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
      }
    };
    stream.on('error', fail);
    req.on('error', () => fail(new Error('上传中断')));
    stream.on('finish', () => {
      if (failed) return;
      uploadRegistry.set(id, Promise.resolve(dest));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, id, path: dest }));
    });
    req.pipe(stream);
    return;
  }

  // 导出文件下载：仅允许 DOWNLOADS_DIR 内的路径（showSaveDialog 落点）。
  if (req.method === 'GET' && requestUrl.pathname === '/yibiao-file') {
    const requested = path.resolve(requestUrl.searchParams.get('path') || '');
    if (requested !== DOWNLOADS_DIR && !requested.startsWith(`${DOWNLOADS_DIR}${path.sep}`)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const fileName = path.basename(requested);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
    fs.createReadStream(requested).pipe(res);
    return;
  }

  // HTTP RPC 入口：便于 curl 冒烟，也是未来云端鉴权中间件的挂载点。
  if (req.method === 'POST' && req.url === '/rpc') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
        return;
      }
      const sender = { id: 0, isDestroyed: () => true, send: () => false, once: noop, on: noop };
      dispatchRpc(sender, String(parsed.channel || ''), parsed.args)
        .then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, result: encodeBinary(result) }));
        })
        .catch((error) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
        });
    });
    return;
  }

  // 静态托管 Renderer 构建产物（生产模式直接浏览器访问服务端口）。
  // 畸形百分号序列按 400 处理，避免 URIError 同步抛出导致进程崩溃。
  let staticUrlPath = '';
  try {
    staticUrlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  const relative = staticUrlPath === '/' ? 'index.html' : staticUrlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(DIST_DIR, relative));
  // 与 serveAsset /yibiao-file 同一套越界防护：带分隔符后缀，避免同名前缀目录绕过。
  const withinDist = filePath === DIST_DIR || filePath.startsWith(`${DIST_DIR}${path.sep}`);
  if (withinDist && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.webp': 'image/webp' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const conn = hub.createConnection(ws);

  ws.on('message', (raw) => {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (frame.type === 'rpc') {
      Promise.resolve()
        .then(() => dispatchRpc(conn.sender, String(frame.channel || ''), frame.args))
        .then((result) => sendFrame(ws, { type: 'rpc-result', id: frame.id, ok: true, result: encodeBinary(result) }))
        .catch((error) => sendFrame(ws, {
          type: 'rpc-result',
          id: frame.id,
          ok: false,
          error: error?.message || String(error),
        }));
      return;
    }

    if (frame.type === 'subscribe') {
      const channel = String(frame.channel || '');
      if (!channel) return;
      conn.channels.add(channel);
      // 注册型通道（如 tasks:subscribe）在 ipcMain.on 上有监听者，需通知 Main 记录订阅者。
      const listeners = ipcMainStub.__getListeners(channel);
      if (listeners) {
        for (const listener of listeners) {
          try {
            listener({ sender: conn.sender });
          } catch (error) {
            console.warn('[ws] 订阅监听器执行失败', { channel, message: error?.message || String(error) });
          }
        }
      }
      return;
    }

    if (frame.type === 'unsubscribe') {
      conn.channels.delete(String(frame.channel || ''));
    }
  });

  ws.on('close', () => conn.destroy());
  ws.on('error', () => conn.destroy());
});

// 只绑定回环地址：本机可信边界内的单用户服务，不向局域网暴露 RPC/文件接口。
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] 投标精灵服务端已启动: http://127.0.0.1:${PORT}`);
  console.log(`[server] 数据目录: ${DATA_DIR}`);
  console.log(`[server] WS 端点: ws://127.0.0.1:${PORT}/ws`);
});
