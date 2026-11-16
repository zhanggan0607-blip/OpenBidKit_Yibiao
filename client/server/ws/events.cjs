// 每个浏览器连接对应一个 sender 桩 + 订阅通道集合；
// Main 侧通过 sender.send(channel, ...args) 推事件，这里翻译成 WS 下行帧。
function createEventHub() {
  const connections = new Set();
  let nextSenderId = 1;

  function createConnection(ws) {
    const conn = {
      ws,
      channels: new Set(),
      closed: false,
    };
    const destroyedCallbacks = [];
    conn.sender = {
      id: nextSenderId++,
      __connection: conn,
      isDestroyed: () => conn.closed,
      send: (channel, ...args) => {
        if (conn.closed || !conn.channels.has(channel)) return false;
        sendFrame(ws, { type: 'event', channel, args });
        return true;
      },
      once: (event, callback) => {
        if (event === 'destroyed') destroyedCallbacks.push(callback);
      },
      on: () => undefined,
      off: () => undefined,
    };
    conn.destroy = () => {
      if (conn.closed) return;
      conn.closed = true;
      connections.delete(conn);
      destroyedCallbacks.forEach((callback) => {
        try {
          callback();
        } catch (error) {
          console.warn('[ws] destroyed 回调失败', error?.message || String(error));
        }
      });
    };
    connections.add(conn);
    return conn;
  }

  function broadcast(channel, args) {
    for (const conn of connections) {
      if (conn.closed || !conn.channels.has(channel)) continue;
      sendFrame(conn.ws, { type: 'event', channel, args });
    }
  }

  return { createConnection, broadcast };
}

function sendFrame(ws, frame) {
  if (ws.readyState !== 1 /* WebSocket.OPEN */) return;
  ws.send(JSON.stringify(frame));
}

module.exports = { createEventHub, sendFrame };
