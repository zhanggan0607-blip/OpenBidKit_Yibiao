// 服务端模式的 Electron ipcMain 桩：channel -> handler 映射，
// 让 electron/ipc/*.cjs 的 register* 代码在纯 Node 里原样注册。
const handlers = new Map();
const listeners = new Map();

const ipcMainStub = {
  handle(channel, handler) {
    handlers.set(channel, handler);
  },
  on(channel, listener) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(listener);
  },
  removeHandler(channel) {
    handlers.delete(channel);
  },
  removeAllListeners(channel) {
    if (channel === undefined) {
      handlers.clear();
      listeners.clear();
      return;
    }
    handlers.delete(channel);
    listeners.delete(channel);
  },
  // 仅供服务端内部查询使用（非 Electron API）。
  __getHandler(channel) {
    return handlers.get(channel);
  },
  __getListeners(channel) {
    return listeners.get(channel);
  },
};

module.exports = { ipcMainStub };
