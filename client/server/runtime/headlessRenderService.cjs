// 浏览器网页版 headless 渲染服务：用 puppeteer-core 驱动本机 Chrome/Edge，
// 复用桌面版 localImageRenderService 的页面构建与布局质检脚本，
// 对外暴露与 createLocalImageRenderService 相同的接口。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  HTML_CAPTURE_SCALE,
  HTML_DESIGN_WIDTH,
  WORD_FRIENDLY_RENDER_WIDTH,
  __test__,
} = require('../../electron/services/localImageRenderService.cjs');

// 与桌面版 HTML_FRAME_HEIGHTS 保持一致的画布高度映射。
const HTML_FRAME_HEIGHTS = { square: 1240, wide: 827, tall: 1653, panorama: 698 };
const MERMAID_RENDER_TIMEOUT_MS = 30000;
const HTML_RENDER_TIMEOUT_MS = 120000;

const LAYOUT_SETTLE_MS = 120;
const PAUSE_POLL_MS = 100;

let puppeteerModule = null;
function loadPuppeteer() {
  if (!puppeteerModule) {
    puppeteerModule = require('puppeteer-core');
  }
  return puppeteerModule;
}

function throwIfPaused(options, fallbackMessage = '转图已暂停') {
  if (options?.isPauseRequested?.()) {
    throw options.createPauseError?.() || new Error(fallbackMessage);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 探测本机可用的 Chrome/Edge 可执行文件（YIBIAO_CHROME_PATH 优先）。
function findChromeExecutable() {
  const envPath = process.env.YIBIAO_CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 Chrome/Edge 浏览器，无法在网页版服务端渲染 Mermaid/HTML；可通过环境变量 YIBIAO_CHROME_PATH 指定浏览器路径');
}

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    const launchPromise = loadPuppeteer().launch({
      executablePath: findChromeExecutable(),
      headless: true,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--allow-file-access-from-files',
        '--disable-features=Translate',
        '--font-render-hinting=none',
      ],
    });
    browserPromise = launchPromise;
    // 启动失败或浏览器进程意外退出时复位单例，下次渲染重新拉起，
    // 避免进程崩溃后所有转图持续报错直到重启服务端。
    launchPromise.catch(() => {
      if (browserPromise === launchPromise) browserPromise = null;
    });
    launchPromise.then((browser) => {
      browser.once('disconnected', () => {
        if (browserPromise === launchPromise) browserPromise = null;
      });
    }).catch(() => undefined);
  }
  return browserPromise;
}

// 打开临时渲染页面；返回 { page, cleanup }。
async function withRenderPage(documentHtml, { width, height, deviceScaleFactor = 1 }, timeoutMs) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const tempDir = path.join(os.tmpdir(), 'yibiao-local-image-render');
  fs.mkdirSync(tempDir, { recursive: true });
  const tempFile = path.join(tempDir, `render-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tempFile, documentHtml, 'utf-8');
  try {
    await page.setViewport({ width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), deviceScaleFactor });
    await page.goto(pathToFileURL(tempFile).href, { waitUntil: 'load', timeout: timeoutMs });
    return {
      page,
      cleanup: async () => {
        await page.close().catch(() => undefined);
        try {
          fs.unlinkSync(tempFile);
        } catch {
          // ignore
        }
      },
    };
  } catch (error) {
    await page.close().catch(() => undefined);
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // ignore
    }
    throw error;
  }
}

// 解析 mermaid 浏览器脚本路径（与桌面版一致）。
function resolveMermaidBrowserScript() {
  try {
    return require.resolve('mermaid/dist/mermaid.min.js');
  } catch {
    const candidates = [
      path.join(__dirname, '..', '..', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error('未找到 mermaid 浏览器脚本，无法本地渲染 Mermaid');
  }
}

// 与桌面版 probeLayoutMetrics 对齐的内容包围盒探测。
function probeLayoutMetrics(page, minWidth, contentOnly = false) {
  const floorWidth = Math.max(1, Math.round(Number(minWidth) || 1));
  return page.evaluate(`(() => {
    const contentOnly = ${contentOnly ? 'true' : 'false'};
    const root = document.documentElement;
    const body = document.body;
    const target = document.getElementById('yibiao-capture-root') || body || root;
    if (!target) return { ready: false, width: 0, height: 0 };
    const images = Array.from(document.images || []);
    const imagesReady = images.every((img) => img.complete);
    const fontsReady = !document.fonts || document.fonts.status === 'loaded' || document.fonts.status === 'idle';
    const rect = target.getBoundingClientRect();
    let width;
    let height;
    if (contentOnly) {
      width = Math.ceil(Math.max(rect.width, target.scrollWidth || 0, 1));
      height = Math.ceil(Math.max(rect.height, target.scrollHeight || 0, 1));
      const svg = target.querySelector && target.querySelector('svg');
      if (svg && (width < 24 || height < 24)) {
        let svgW = 0;
        let svgH = 0;
        const attrW = parseFloat(svg.getAttribute('width') || '');
        const attrH = parseFloat(svg.getAttribute('height') || '');
        if (Number.isFinite(attrW) && Number.isFinite(attrH) && attrW > 0 && attrH > 0) {
          svgW = attrW;
          svgH = attrH;
        } else {
          const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\\s,]+/).map(Number);
          if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
            svgW = vb[2];
            svgH = vb[3];
          } else {
            try {
              const box = svg.getBBox();
              if (box && box.width > 0 && box.height > 0) {
                svgW = box.width;
                svgH = box.height;
              }
            } catch {}
          }
        }
        if (svgW > 0 && svgH > 0) {
          width = Math.ceil(svgW + 16);
          height = Math.ceil(svgH + 16);
        }
      }
    } else {
      width = Math.ceil(Math.max(
        rect.width,
        target.scrollWidth || 0,
        body?.scrollWidth || 0,
        root?.scrollWidth || 0,
        ${floorWidth},
      ));
      height = Math.ceil(Math.max(
        rect.height,
        target.scrollHeight || 0,
        body?.scrollHeight || 0,
        root?.scrollHeight || 0,
        1,
      ));
    }
    return { ready: imagesReady && fontsReady && width > 0 && height > 0, width, height };
  })()`);
}

// 等待布局稳定并返回内容宽高（与桌面版 waitForLayoutReady 对齐）。
async function waitForLayoutReady(page, timeoutMs, minWidth = 1, options = {}) {
  const contentOnly = options.contentOnly === true;
  const started = Date.now();
  let stableSince = 0;
  let lastKey = '';
  while (Date.now() - started < timeoutMs) {
    throwIfPaused(options);
    try {
      const metrics = await probeLayoutMetrics(page, minWidth, contentOnly);
      if (metrics?.ready && metrics.width > 0 && metrics.height > 0) {
        const key = `${metrics.width}x${metrics.height}`;
        if (key !== lastKey) {
          lastKey = key;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= LAYOUT_SETTLE_MS) {
          return { width: metrics.width, height: metrics.height };
        }
      } else {
        lastKey = '';
        stableSince = 0;
      }
    } catch {
      lastKey = '';
      stableSince = 0;
    }
    await delay(PAUSE_POLL_MS);
  }
  throw new Error('等待页面布局稳定超时');
}

async function captureClip(page, clip) {
  const buffer = await page.screenshot({
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
    captureBeyondViewport: true,
    omitBackground: false,
  });
  return Buffer.from(buffer);
}

// 创建 headless 本地渲染服务（接口与桌面版一致）。
function createHeadlessRenderService() {
  async function renderMermaidToPng(code, options = {}) {
    throwIfPaused(options, 'Mermaid 转图已暂停');
    const mermaidScriptUrl = pathToFileURL(resolveMermaidBrowserScript()).href;
    const documentHtml = __test__.buildMermaidDocument(code, mermaidScriptUrl);
    const { page, cleanup } = await withRenderPage(
      documentHtml,
      { width: WORD_FRIENDLY_RENDER_WIDTH, height: 480 },
      MERMAID_RENDER_TIMEOUT_MS,
    );
    try {
      const ready = await (async () => {
        const started = Date.now();
        while (Date.now() - started < MERMAID_RENDER_TIMEOUT_MS) {
          throwIfPaused(options, 'Mermaid 转图已暂停');
          const state = await page.evaluate('({ ready: Boolean(window.__yibiaoMermaidReady), error: String(window.__yibiaoMermaidError || "") })');
          if (state.ready) return state;
          await delay(PAUSE_POLL_MS);
        }
        throw new Error('Mermaid 渲染超时');
      })();
      if (ready.error) throw new Error(ready.error);
      await page.setViewport({ width: WORD_FRIENDLY_RENDER_WIDTH, height: 1200, deviceScaleFactor: 1 });
      const metrics = await waitForLayoutReady(page, MERMAID_RENDER_TIMEOUT_MS, 1, { ...options, contentOnly: true });
      const rawWidth = Math.ceil(metrics.width || 0);
      const rawHeight = Math.ceil(metrics.height || 0);
      if (rawWidth < 24 || rawHeight < 24) {
        throw new Error(`Mermaid 内容尺寸异常（${rawWidth}x${rawHeight}），可能未正确渲染`);
      }
      const width = Math.min(WORD_FRIENDLY_RENDER_WIDTH, Math.max(1, rawWidth));
      const height = Math.max(1, rawHeight);
      await page.setViewport({ width, height, deviceScaleFactor: 3 });
      throwIfPaused(options, 'Mermaid 转图已暂停');
      const buffer = await captureClip(page, { x: 0, y: 0, width, height });
      return { buffer, width: width * 3, height: height * 3 };
    } finally {
      await cleanup();
    }
  }

  async function probeHtmlLayoutOnly(html, options = {}) {
    throwIfPaused(options, 'HTML 质检已暂停');
    const width = HTML_DESIGN_WIDTH;
    const height = HTML_FRAME_HEIGHTS[options.frameSize] || 1240;
    const documentHtml = __test__.buildHtmlDocument(html, height);
    const { page, cleanup } = await withRenderPage(documentHtml, { width, height }, HTML_RENDER_TIMEOUT_MS);
    try {
      await waitForLayoutReady(page, HTML_RENDER_TIMEOUT_MS, HTML_DESIGN_WIDTH, options);
      throwIfPaused(options, 'HTML 质检已暂停');
      const layoutIssues = await page.evaluate(__test__.buildHtmlLayoutProbeScript());
      return { width, height, layout_issues: Array.isArray(layoutIssues) ? layoutIssues.map(String) : [] };
    } finally {
      await cleanup();
    }
  }

  async function renderHtmlToPng(html, options = {}) {
    throwIfPaused(options, 'HTML 转图已暂停');
    const width = HTML_DESIGN_WIDTH;
    const height = HTML_FRAME_HEIGHTS[options.frameSize] || 1240;
    const documentHtml = __test__.buildHtmlDocument(html, height);
    const { page, cleanup } = await withRenderPage(documentHtml, { width, height }, HTML_RENDER_TIMEOUT_MS);
    try {
      await waitForLayoutReady(page, HTML_RENDER_TIMEOUT_MS, HTML_DESIGN_WIDTH, options);
      throwIfPaused(options, 'HTML 转图已暂停');
      const layoutIssues = options.checkLayout === false
        ? []
        : await page.evaluate(__test__.buildHtmlLayoutProbeScript());
      throwIfPaused(options, 'HTML 转图已暂停');
      await page.setViewport({ width, height, deviceScaleFactor: HTML_CAPTURE_SCALE });
      const buffer = await captureClip(page, { x: 0, y: 0, width, height });
      return { buffer, width: width * HTML_CAPTURE_SCALE, height: height * HTML_CAPTURE_SCALE, layout_issues: Array.isArray(layoutIssues) ? layoutIssues.map(String) : [] };
    } finally {
      await cleanup();
    }
  }

  async function renderExactHtmlToPng({ html, width, height, scale = 2 } = {}, options = {}) {
    throwIfPaused(options, 'HTML 转图已暂停');
    const safeWidth = Math.max(1, Math.round(Number(width) || 1));
    const safeHeight = Math.max(1, Math.round(Number(height) || 1));
    const captureScale = Math.max(1, Math.round(Number(scale) || 2));
    const documentHtml = __test__.buildExactHtmlDocument(html, safeWidth, safeHeight);
    const { page, cleanup } = await withRenderPage(
      documentHtml,
      { width: safeWidth, height: safeHeight, deviceScaleFactor: captureScale },
      HTML_RENDER_TIMEOUT_MS,
    );
    try {
      await delay(LAYOUT_SETTLE_MS);
      throwIfPaused(options, 'HTML 转图已暂停');
      const buffer = await captureClip(page, { x: 0, y: 0, width: safeWidth, height: safeHeight });
      return { buffer, width: safeWidth * captureScale, height: safeHeight * captureScale };
    } finally {
      await cleanup();
    }
  }

  return {
    renderMermaidToPng,
    renderHtmlToPng,
    renderExactHtmlToPng,
    probeHtmlLayoutOnly,
    wordFriendlyRenderWidth: WORD_FRIENDLY_RENDER_WIDTH,
    htmlDesignWidth: HTML_DESIGN_WIDTH,
  };
}

let serviceInstance = null;

// 与桌面版 localImageRenderService 同名接口：ipc/index.cjs 通过 init 启动。
function initLocalImageRenderService(options = {}) {
  serviceInstance = createHeadlessRenderService(options);
  return serviceInstance;
}

function getLocalImageRenderService() {
  if (!serviceInstance) {
    serviceInstance = createHeadlessRenderService();
  }
  return serviceInstance;
}

module.exports = {
  HTML_CAPTURE_SCALE,
  HTML_DESIGN_WIDTH,
  WORD_FRIENDLY_RENDER_WIDTH,
  createHeadlessRenderService,
  initLocalImageRenderService,
  getLocalImageRenderService,
};
