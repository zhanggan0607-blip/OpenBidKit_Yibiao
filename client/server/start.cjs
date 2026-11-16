// 投标精灵网页版服务端启动器：以 ELECTRON_RUN_AS_NODE 方式运行 electron 二进制，
// 保证 better-sqlite3 等 native 模块的 ABI 与打包内 Node 一致（不要直接用系统 node 启动）。
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function resolveElectronBinary() {
  const dist = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

function main() {
  const electronBinary = resolveElectronBinary();
  if (!fs.existsSync(electronBinary)) {
    console.error('[server] 未找到 electron 二进制，请先在 client/ 下执行 npm install');
    process.exit(1);
  }
  const child = spawn(electronBinary, [path.join(__dirname, 'index.cjs')], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

main();
