// 在进程最早阶段拦截 require('electron')，把所有引用指向服务端桩。
// 必须在 require('electron/ipc/index.cjs') 之前调用 installElectronStub。
const path = require('node:path');
const Module = require('node:module');
const { createElectronStub } = require('./electronStub.cjs');

function installElectronStub({ app, dialogBridge, saveDialogDir, headlessRenderServiceFactory }) {
  const stub = createElectronStub({ app, dialogBridge, saveDialogDir });
  const electronModuleNames = new Set(['electron', 'electron/main']);
  let headlessRenderService = null;

  // 服务端尚无 headless 等价实现的两个 BrowserWindow 能力：
  // 拦截成"明确报错"的降级桩，避免把 stub 的"阶段3"占位错误漏给用户。
  const unavailableLayoutStub = {
    readWordLayout: () => Promise.reject(new Error('网页版暂不支持 Word 排版检查，请改用桌面版，或在设置中关闭字数排版检查')),
    readWordPageAnchors: () => Promise.reject(new Error('网页版暂不支持 Word 目录页码测量，请改用桌面版')),
    analyzeLayout: () => { throw new Error('网页版暂不支持 Word 排版分析，请改用桌面版'); },
    runContentLayoutCheck: () => Promise.reject(new Error('网页版暂不支持 Word 排版检查，请改用桌面版，或在设置中关闭字数排版检查')),
  };
  const unavailableWorkerWindowStub = {
    createWorkerWindow: () => {
      throw new Error('网页版暂不支持双层 PDF 导出，请改用桌面版');
    },
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, ...rest) {
    // electron/ipc 与 services 内 require('electron') 全部替换为桩；
    // 桌面能力 BrowserWindow/nativeImage 等由 stub 统一提供。
    if (electronModuleNames.has(request)) {
      return stub;
    }
    const inElectronDir = typeof parent?.filename === 'string' && parent.filename.includes(`${path.sep}electron${path.sep}`);
    if (inElectronDir && typeof request === 'string' && request.includes('contentGenerationLayout')) {
      return unavailableLayoutStub;
    }
    if (inElectronDir && typeof request === 'string' && request.includes('workerWindow') && parent.filename.includes('dualLayerPdf')) {
      return unavailableWorkerWindowStub;
    }
    // 服务端用 headless Chromium 渲染服务替换桌面版离屏窗口转图实现；
    // 只拦截 electron/ 目录内的 require，headless 服务自身取真实模块复用其页面构建函数。
    if (
      headlessRenderService
      && typeof request === 'string'
      && request.includes('localImageRenderService')
      && inElectronDir
    ) {
      return headlessRenderService;
    }
    return originalLoad.call(this, request, parent, ...rest);
  };

  // 桩生效后再实例化 headless 渲染服务：
  // 它 require 的真实模块内部 require('electron') 需要拿到桩。
  if (typeof headlessRenderServiceFactory === 'function') {
    headlessRenderService = headlessRenderServiceFactory();
  }

  return stub;
}

module.exports = { installElectronStub };
