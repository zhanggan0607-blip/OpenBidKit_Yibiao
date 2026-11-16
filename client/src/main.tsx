import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AppProviders from './app/providers/AppProviders';
import WorkspaceDatabaseGate from './app/WorkspaceDatabaseGate';
import DeveloperTokenStatsWindow from './features/developer/pages/DeveloperTokenStatsWindow';
import PiAgentMonitorWindow from './features/developer/pages/PiAgentMonitorWindow';
import { installWebBridge } from './shared/bridge/webBridge';
import './styles.css';

const windowMode = new URLSearchParams(window.location.search).get('window');

async function bootstrap() {
  // 浏览器环境没有 preload 注入的 window.yibiao，用 WS 垫片补齐后再渲染；
  // 服务端未启动时轮询重试，避免首连失败后页面永久空白且不再恢复。
  if (!('yibiao' in window)) {
    for (;;) {
      try {
        await installWebBridge();
        break;
      } catch (error) {
        console.warn('[web] 连接投标精灵服务端失败，3 秒后重试', error);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
  createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      {windowMode === 'token-stats' ? (
        <DeveloperTokenStatsWindow />
      ) : windowMode === 'agent-monitor' ? (
        <PiAgentMonitorWindow />
      ) : (
        <AppProviders>
          <WorkspaceDatabaseGate>
            <App />
          </WorkspaceDatabaseGate>
        </AppProviders>
      )}
    </React.StrictMode>
  );
}

if (windowMode === 'dual-layer-pdf-worker') {
  // 批量转双层 PDF 的隐藏工作窗口：没有界面，只按需加载处理脚本。
  void import('./features/dual-layer-pdf/worker/workerMain');
} else {
  void bootstrap();
}
