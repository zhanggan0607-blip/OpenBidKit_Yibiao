// 服务端对话框桥：把 Main 侧 dialog.showOpenDialog 请求经 WS 转发给浏览器，
// Renderer 垫片弹出文件选择器并上传到 /web-upload，回填服务器本地路径；
// 这样 electron/services 里所有对话框流程在浏览器形态下零改动工作。
const crypto = require('node:crypto');

function createDialogBridge({ hub, openTimeoutMs = 10 * 60 * 1000 } = {}) {
  const pending = new Map();

  // 请求已结束时通知所有连接关闭残留的文件选择框，避免多标签页互相回填或弹框滞留。
  function broadcastCancel(requestId) {
    if (!hub) return;
    hub.broadcast('__dialog:cancel', [{ requestId }]);
  }

  function showOpenDialog(options = {}) {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        broadcastCancel(requestId);
        resolve({ canceled: true, filePaths: [] });
      }, openTimeoutMs);
      pending.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      });
      hub.broadcast('__dialog:open', [{ requestId, options }]);
    });
  }

  function resolveOpen(requestId, result) {
    const key = String(requestId || '');
    const entry = pending.get(key);
    if (!entry) return false;
    pending.delete(key);
    broadcastCancel(key);
    entry.resolve({
      canceled: Boolean(result?.canceled),
      filePaths: Array.isArray(result?.filePaths) ? result.filePaths.map(String).filter(Boolean) : [],
    });
    return true;
  }

  function cancelAll() {
    pending.forEach((entry, requestId) => {
      broadcastCancel(requestId);
      entry.resolve({ canceled: true, filePaths: [] });
    });
    pending.clear();
  }

  return { showOpenDialog, resolveOpen, cancelAll };
}

module.exports = { createDialogBridge };
