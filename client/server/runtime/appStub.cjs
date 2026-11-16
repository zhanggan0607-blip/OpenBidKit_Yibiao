// 服务端模式的 app 桩：getPath 全部指向服务端数据目录，
// 保证 userData/workspace/yibiao.sqlite 与桌面版数据结构一致。
const path = require('node:path');
const fs = require('node:fs');

function createAppStub({ dataDir, version }) {
  const ensureDir = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const paths = {
    userData: ensureDir(dataDir),
    home: ensureDir(path.join(dataDir, 'home')),
    temp: ensureDir(path.join(dataDir, 'temp')),
    downloads: ensureDir(path.join(dataDir, 'downloads')),
    logs: ensureDir(path.join(dataDir, 'logs')),
    documents: ensureDir(path.join(dataDir, 'documents')),
    desktop: ensureDir(path.join(dataDir, 'desktop')),
    exe: process.execPath,
    appPath: path.resolve(__dirname, '..', '..'),
  };

  return {
    isPackaged: false,
    getVersion: () => version,
    getName: () => 'yibiao-client',
    getAppPath: () => paths.appPath,
    getPath: (name) => {
      if (!(name in paths)) {
        throw new Error(`服务端模式未实现的 app.getPath('${name}')`);
      }
      return paths[name];
    },
    setPath(name, value) {
      paths[name] = value;
    },
    on: () => undefined,
    once: () => undefined,
    whenReady: () => Promise.resolve(),
    quit: () => process.exit(0),
    exit: (code) => process.exit(code ?? 0),
    relaunch: () => undefined,
    isReady: () => true,
    // 关闭/聚焦等窗口事件在服务端无意义，保持 no-op。
    focus: () => undefined,
    hide: () => undefined,
    show: () => undefined,
  };
}

module.exports = { createAppStub };
