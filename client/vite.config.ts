import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  // 隐藏工作窗口才会用到 pdfjs，开发服务器启动时就预先处理，
  // 否则首次用到时会重新处理依赖并刷新页面，打断正在加载的工作窗口。
  optimizeDeps: {
    include: ['pdfjs-dist/legacy/build/pdf.mjs'],
  },
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
    fs: {
      allow: ['.'],
    },
    // 浏览器网页版：开发态把 WS/RPC 与文件上传、资产、下载路由一并代理到
    // 本地服务端（client/server）；生产态浏览器直接访问服务端口，无需代理。
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8737',
        ws: true,
      },
      '/rpc': {
        target: 'http://127.0.0.1:8737',
      },
      '/web-upload': {
        target: 'http://127.0.0.1:8737',
      },
      '/yibiao-asset': {
        target: 'http://127.0.0.1:8737',
      },
      '/yibiao-file': {
        target: 'http://127.0.0.1:8737',
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
