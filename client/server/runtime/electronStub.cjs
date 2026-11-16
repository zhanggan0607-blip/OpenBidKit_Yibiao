// 服务端模式的 Electron 模块桩：通过 Module._load 拦截 require('electron')，
// 让 electron/ipc 与 electron/services 的既有代码在纯 Node 进程里原样运行。
const path = require('node:path');
const fs = require('node:fs');
const { ipcMainStub } = require('./ipcMainStub.cjs');

const notImplemented = (api) => () => {
  throw new Error(`[server] Electron API 在服务端模式未实现：${api}`);
};

function createElectronStub({ app, dialogBridge, saveDialogDir } = {}) {
  const notCanceledDialog = () => !dialogBridge;

  const dialogStub = {
    showOpenDialog: async (...args) => {
      const options = args.find((item) => item && typeof item === 'object') || {};
      if (notCanceledDialog()) return { canceled: true, filePaths: [] };
      // 浏览器无法选择服务器目录：目录选择按取消处理。
      if (Array.isArray(options.properties) && options.properties.includes('openDirectory')) {
        return { canceled: true, filePaths: [] };
      }
      return dialogBridge.showOpenDialog(options);
    },
    showSaveDialog: async (...args) => {
      // 浏览器形态没有"另存为"位置选择：直接落到服务端下载目录，随后可经
      // /yibiao-file 路由下载到用户本机。
      if (!saveDialogDir) return { canceled: true, filePath: '' };
      const options = args.find((item) => item && typeof item === 'object') || {};
      const rawName = path.basename(String(options.defaultPath || `导出文件-${Date.now()}`)) || `导出文件-${Date.now()}`;
      let filePath = path.join(saveDialogDir, rawName);
      const ext = path.extname(filePath);
      const stem = filePath.slice(0, filePath.length - ext.length);
      let seq = 1;
      while (fs.existsSync(filePath)) {
        filePath = `${stem}-${seq}${ext}`;
        seq += 1;
      }
      return { canceled: false, filePath };
    },
    showMessageBox: async () => ({ response: 0, canceled: true }),
    showErrorBox: (title, message) => console.error(`[dialog] ${title}: ${message}`),
  };

  const emptyImage = {
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    toDataURL: () => '',
    toPNG: () => Buffer.alloc(0),
    toJPEG: () => Buffer.alloc(0),
    getAspectRatio: () => 1,
    resize: () => emptyImage,
    crop: () => emptyImage,
  };

  const nativeImageStub = {
    createEmpty: () => emptyImage,
    createFromPath: () => emptyImage,
    createFromBuffer: () => emptyImage,
    createFromDataURL: () => emptyImage,
  };

  const shellStub = {
    openExternal: async () => undefined,
    openPath: async () => '',
    showItemInFolder: () => undefined,
    beep: () => undefined,
  };

  const clipboardStub = {
    readText: () => '',
    writeText: (text) => {
      console.log('[clipboard]', String(text || '').slice(0, 200));
    },
    readImage: () => nativeImageStub.createEmpty(),
    writeImage: () => undefined,
    clear: () => undefined,
  };

  const powerMonitorStub = {
    on: () => undefined,
    off: () => undefined,
    removeAllListeners: () => undefined,
    getSystemIdleTime: () => 0,
  };

  const BrowserWindowStub = class BrowserWindow {
    constructor() {
      throw new Error('[server] 隐藏窗口能力将由 headless Chromium 替代（阶段3）');
    }
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  };

  return {
    app,
    ipcMain: ipcMainStub,
    dialog: dialogStub,
    BrowserWindow: BrowserWindowStub,
    nativeImage: nativeImageStub,
    shell: shellStub,
    clipboard: clipboardStub,
    powerMonitor: powerMonitorStub,
    utilityProcess: {
      fork: notImplemented('utilityProcess.fork'),
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value) => Buffer.from(String(value), 'utf-8'),
      decryptString: (buffer) => Buffer.from(buffer).toString('utf-8'),
    },
    session: {
      defaultSession: {
        getStoragePath: () => app.getPath('userData'),
      },
    },
    net: {
      fetch: (...args) => fetch(...args),
      request: notImplemented('net.request'),
    },
    screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
      getAllDisplays: () => [],
    },
    Notification: class {
      constructor() {}
      show() {
        console.log('[notification]');
      }
      static isSupported() {
        return false;
      }
    },
    webContents: {
      getAllWebContents: () => [],
    },
    Menu: {
      buildFromTemplate: () => ({}),
      setApplicationMenu: () => undefined,
    },
    crashReporter: {
      start: () => undefined,
    },
  };
}

module.exports = { createElectronStub, notImplemented };
