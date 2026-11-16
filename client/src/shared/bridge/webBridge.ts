// 浏览器网页版 Renderer 垫片：在非 Electron 环境下用 WebSocket 复刻
// preload.cjs 暴露的 window.yibiao API 面。桌面版仍走 preload（不受影响）。
// 协议：上行 {type:'rpc'|'subscribe'|'unsubscribe'}，下行 {type:'rpc-result'|'event'}；
// 服务端把 Uint8Array 编码为 {__yibiao_binary: base64}，此处还原为 Uint8Array。
import type { YibiaoBridge } from '../types';

type PendingRpc = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type EventCallback = (...args: unknown[]) => void;

function detectPlatform(): string {
  const ua = navigator.userAgent;
  if (/Win/i.test(ua)) return 'win32';
  if (/Mac/i.test(ua)) return 'darwin';
  if (/Linux/i.test(ua)) return 'linux';
  return 'unknown';
}

function resolveWebSocketUrl(): string {
  // 显式配置优先（跨域部署时用 VITE_YIBIAO_WS_URL 指向服务端）；
  // 默认同源 /ws：开发态由 Vite 代理，生产态与服务端同端口。
  const configured = import.meta.env.VITE_YIBIAO_WS_URL as string | undefined;
  if (configured) return configured;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function decodeBinary(value: unknown): unknown {
  // 纯 yibiao-asset 资产 URL（公告媒体/生成图/资质图片等字段值）改写为同源 HTTP 路由；
  // 只改写整串 URL，不碰 Markdown 正文里内嵌的引用（回存时需保持协议原文）。
  if (typeof value === 'string' && value.startsWith('yibiao-asset://') && !/\s/.test(value)) {
    return value.replace(/^yibiao-asset:\/\//, '/yibiao-asset/');
  }
  if (value == null || typeof value !== 'object') return value;
  const marker = value as { __yibiao_binary?: unknown };
  if (typeof marker.__yibiao_binary === 'string') {
    const raw = window.atob(marker.__yibiao_binary);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }
  if (Array.isArray(value)) return value.map(decodeBinary);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = decodeBinary(item);
  }
  return out;
}

class WebIpcClient {
  private url = resolveWebSocketUrl();
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private stopped = false;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private subscriptions = new Map<string, Set<EventCallback>>();
  private registerChannels = new Set<string>();

  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.stopped = false;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.onopen = () => {
        this.ws = socket;
        this.connecting = null;
        this.resubscribeAll();
        resolve();
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onclose = () => {
        const wasConnecting = this.connecting !== null;
        this.ws = null;
        this.connecting = null;
        // 断线时拒绝全部在途 RPC，避免服务端重启期间调用永久悬挂；
        // 重连成功后由调用方重新发起。
        this.pending.forEach((entry) => entry.reject(new Error('与服务器的连接已断开')));
        this.pending.clear();
        if (wasConnecting) {
          reject(new Error('无法连接到投标精灵服务端'));
        }
        if (!this.stopped) {
          // 断线自动重连，重连成功后 resubscribeAll 恢复事件订阅。
          window.setTimeout(() => {
            this.connect().catch(() => undefined);
          }, 2000);
        }
      };
      socket.onerror = () => undefined; // 错误统一走 onclose 处理
    });
    return this.connecting;
  }

  dispose(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    this.pending.forEach((entry) => entry.reject(new Error('与服务器的连接已断开')));
    this.pending.clear();
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    try {
      await this.connect();
    } catch {
      throw new Error('无法连接到投标精灵服务端，请确认服务已启动');
    }
    const id = this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: 'rpc', id, channel, args });
    });
  }

  listen(channel: string, callback: EventCallback, registerChannel?: string): () => void {
    let set = this.subscriptions.get(channel);
    if (!set) {
      set = new Set();
      this.subscriptions.set(channel, set);
    }
    set.add(callback);
    this.sendSubscribe(channel);
    if (registerChannel) {
      this.registerChannels.add(registerChannel);
      this.sendSubscribe(registerChannel);
    }
    return () => {
      const current = this.subscriptions.get(channel);
      if (!current) return;
      current.delete(callback);
      if (current.size === 0) {
        this.subscriptions.delete(channel);
        this.send({ type: 'unsubscribe', channel });
      }
    };
  }

  private sendSubscribe(channel: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'subscribe', channel });
    }
  }

  private resubscribeAll(): void {
    this.subscriptions.forEach((_set, channel) => this.sendSubscribe(channel));
    this.registerChannels.forEach((channel) => this.sendSubscribe(channel));
  }

  private send(frame: unknown): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch {
      // 发送失败按连接问题处理，等待重连后重试。
    }
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let frame: { type?: string; id?: number; ok?: boolean; result?: unknown; error?: string; channel?: string; args?: unknown[] };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.type === 'rpc-result' && typeof frame.id === 'number') {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      if (frame.ok) entry.resolve(decodeBinary(frame.result));
      else entry.reject(new Error(frame.error || '远程调用失败'));
      return;
    }
    if (frame.type === 'event' && typeof frame.channel === 'string') {
      const set = this.subscriptions.get(frame.channel);
      if (!set) return;
      const args = Array.isArray(frame.args) ? frame.args.map(decodeBinary) : [];
      set.forEach((callback) => {
        try {
          callback(...args);
        } catch (error) {
          console.warn('[webBridge] 事件回调执行失败', { channel: frame.channel, error });
        }
      });
    }
  }
}

// ---------- 文件上传 / 对话框桥 / 下载 ----------

// 同一 File 对象复用同一个上传占位符（拖拽入池 → 点击导入时再次 getPathForFile）。
const uploadTokens = new WeakMap<File, string>();

function createUploadToken(): string {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`.replace(/[^0-9a-fA-F-]/g, '0');
  return `web-upload://${id}`;
}

// 上传文件到服务端（/web-upload 以 id 关联，占位符由服务端 dispatchRpc 还原为真实路径）。
async function uploadFileByToken(file: File, token: string): Promise<void> {
  const id = token.replace(/^web-upload:\/\//, '');
  const response = await fetch(
    `/web-upload?id=${encodeURIComponent(id)}&name=${encodeURIComponent(file.name)}`,
    { method: 'POST', body: file },
  );
  if (!response.ok) {
    throw new Error(`文件上传失败（HTTP ${response.status}）：${file.name}`);
  }
}

// 同步取路径（拖拽上传约定）：立即返回占位符并后台开始上传；
// 服务端执行 handler 前会等待上传完成并还原为服务器路径。
function getPathTokenForFile(file: File): string {
  let token = uploadTokens.get(file);
  if (!token) {
    token = createUploadToken();
    uploadTokens.set(file, token);
    void uploadFileByToken(file, token).catch(() => {
      uploadTokens.delete(file);
    });
  }
  return token;
}

// 浏览器版"文件选择对话框"：服务端 dialog.showOpenDialog 经 WS 转发到这里，
// 用户在 <input type="file"> 里选完后上传，把占位符路径回填给等待中的 service。
type DialogOpenPayload = {
  requestId: string;
  options?: {
    title?: string;
    properties?: string[];
    filters?: Array<{ name?: string; extensions?: string[] }>;
  };
};

function createHiddenFileInput(payload: DialogOpenPayload): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'file';
  const properties = payload.options?.properties ?? [];
  input.multiple = properties.includes('multiSelections');
  const accept = (payload.options?.filters ?? [])
    .flatMap((filter) => filter.extensions ?? [])
    .filter((ext) => ext && ext !== '*')
    .map((ext) => `.${ext.replace(/^\./, '')}`)
    .join(',');
  if (accept) input.accept = accept;
  input.style.display = 'none';
  return input;
}

function attachDialogBridge(
  client: WebIpcClient,
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): void {
  // 请求已被其他标签页回填或服务端超时：关闭本页还在等待的文件选择框。
  const pendingInputs = new Map<string, (result: { canceled: boolean; filePaths: string[] }) => void>();
  client.listen('__dialog:cancel', (rawPayload) => {
    const requestId = String((rawPayload as { requestId?: string } | null)?.requestId || '');
    const finish = pendingInputs.get(requestId);
    if (finish) {
      pendingInputs.delete(requestId);
      finish({ canceled: true, filePaths: [] });
    }
  });
  client.listen('__dialog:open', (rawPayload) => {
    const payload = (rawPayload ?? {}) as DialogOpenPayload;
    const requestId = String(payload.requestId || '');
    if (!requestId) return;
    const resolve = (result: { canceled: boolean; filePaths: string[] }) => {
      void invoke('__dialog:resolve', requestId, result).catch(() => undefined);
    };

    const input = createHiddenFileInput(payload);
    document.body.appendChild(input);
    let settled = false;
    const finish = (result: { canceled: boolean; filePaths: string[] }) => {
      if (settled) return;
      settled = true;
      pendingInputs.delete(requestId);
      input.remove();
      resolve(result);
    };
    pendingInputs.set(requestId, finish);
    input.addEventListener('change', async () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) {
        finish({ canceled: true, filePaths: [] });
        return;
      }
      try {
        const filePaths: string[] = [];
        for (const file of files) {
          const token = createUploadToken();
          uploadTokens.set(file, token);
          await uploadFileByToken(file, token);
          filePaths.push(token);
        }
        finish({ canceled: false, filePaths });
      } catch {
        finish({ canceled: true, filePaths: [] });
      }
    });
    input.addEventListener('cancel', () => finish({ canceled: true, filePaths: [] }));
    input.click();
  });
}

// 服务端落盘的导出文件（showSaveDialog 桩写入 server/data/downloads）经浏览器下载。
async function downloadServerFile(filePath: string): Promise<void> {
  const response = await fetch(`/yibiao-file?path=${encodeURIComponent(filePath)}`);
  if (!response.ok) {
    throw new Error(`文件下载失败（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  const fileName = filePath.split(/[\\/]/).pop() || 'download';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function buildBridge(client: WebIpcClient): YibiaoBridge {
  const invoke = <T>(channel: string, ...args: unknown[]) => client.invoke(channel, ...args) as Promise<T>;
  const listen = (channel: string, registerChannel?: string) =>
    // 回调参数用 any[] 以匹配 YibiaoBridge 中各事件的具体签名（运行时按 WS 帧参数展开）。
    (callback: (...args: any[]) => void) => client.listen(channel, callback as EventCallback, registerChannel);

  // 与 preload.cjs 保持一一对应；桌面能力（选择文件对话框等）在阶段3做 Web 适配。
  return {
    appName: '投标精灵',
    platform: detectPlatform(),
    getVersion: () => invoke('app:get-version'),
    getGpuHardwareAccelerationStatus: () => invoke('app:get-gpu-hardware-acceleration-status'),
    saveGpuHardwareAccelerationPreference: (enabled) => invoke('app:save-gpu-hardware-acceleration-preference', enabled),
    startGpuHardwareAccelerationTrial: () => invoke('app:start-gpu-hardware-acceleration-trial'),
    relaunchWithGpuHardwareAccelerationDisabled: () => invoke('app:relaunch-with-gpu-hardware-acceleration-disabled'),
    requiredOnlineServices: {
      getStatus: () => invoke('required-online-services:get-status'),
    },
    notice: {
      syncCurrent: (request) => invoke('notice:sync-current', request),
      prepareMedia: (request) => invoke('notice:prepare-media', request),
      releaseMedia: (leaseId) => invoke('notice:release-media', leaseId),
    },
    donation: {
      getConfig: () => invoke('donation:get-config'),
      createTip: (request) => invoke('donation:create-tip', request),
      getOrderStatus: (merchantOrderNo) => invoke('donation:get-order-status', merchantOrderNo),
      finalizeOrderStatus: (merchantOrderNo) => invoke('donation:finalize-order-status', merchantOrderNo),
      onPrompt: listen('donation:prompt'),
      onPaid: listen('donation:paid'),
    },
    getLatestVersion: () => invoke('app:get-latest-version'),
    getUpdateDownloadUrl: () => invoke('app:get-update-download-url'),
    openExternal: (url) => {
      // 浏览器形态直接新开标签页，不经服务端 shell。
      window.open(url, '_blank', 'noopener,noreferrer');
      return Promise.resolve({ success: true });
    },
    checkUpdate: () => invoke('app:check-update'),
    startUpdate: () => invoke('app:start-update'),
    quitAndInstall: () => invoke('app:quit-and-install'),
    onUpdateProgress: listen('app:update-progress'),
    onUpdateDownloaded: listen('app:update-downloaded'),
    onUpdateError: listen('app:update-error'),
    onPluginUpdatesAvailable: listen('plugins:updates-available'),
    database: {
      getStatus: () => invoke('workspace-database:get-status'),
      onStatus: listen('workspace-database:status'),
    },
    ui: {
      setCurrentView: (view) => invoke('ui:set-current-view', view),
    },
    config: {
      load: () => invoke('config:load'),
      save: (config) => invoke('config:save', config),
      listModels: (config) => invoke('config:list-models', config),
      getModelInfo: (modelName) => invoke('config:get-model-info', modelName),
      openConfigFolder: () => invoke('config:open-config-folder'),
    },
    storage: {
      getUsage: () => invoke('storage:get-usage'),
      clean: (groupId) => invoke('storage:clean', groupId),
    },
    license: {
      getStatus: () => invoke('license:get-status'),
      refresh: () => invoke('license:refresh'),
      importOfflineFile: () => invoke('license:import-offline-file'),
      activateOfflineCode: (code) => invoke('license:activate-offline-code', code),
    },
    officialAccount: {
      redeemCode: (input) => invoke('official-account:redeem-code', input),
      getInvoiceApplication: (orderNo) => invoke('official-account:get-invoice-application', orderNo),
      createInvoiceApplication: (input) => invoke('official-account:create-invoice-application', input),
      getInvoiceInfo: () => invoke('official-account:get-invoice-info'),
      saveInvoiceInfo: (input) => invoke('official-account:save-invoice-info', input),
      getState: () => invoke('official-account:get-state'),
      refreshBalance: () => invoke('official-account:refresh-balance'),
      getRechargeOptions: () => invoke('official-account:get-recharge-options'),
      createRechargeOrder: (input) => invoke('official-account:create-recharge-order', input),
      getRechargeOrders: (input) => invoke('official-account:get-recharge-orders', input),
      getTransactions: (input) => invoke('official-account:get-transactions', input),
      getRechargeOrder: (orderNo) => invoke('official-account:get-recharge-order', orderNo),
      closeRechargeOrder: (orderNo) => invoke('official-account:close-recharge-order', orderNo),
      onRechargeOrderChanged: listen('official-account:order'),
      sendEmailCode: (input) => invoke('official-account:send-email-code', input),
      loginWithEmail: (input) => invoke('official-account:login', input),
      bindEmail: (input) => invoke('official-account:bind-email', input),
      onStateChanged: listen('official-account:state'),
    },
    ai: {
      chat: (request) => invoke('ai:chat', request),
      requestJson: (request) => invoke('ai:request-json', request),
      testImageModel: (config) => invoke('ai:test-image-model', config),
      onHttpError: listen('ai:http-error'),
      onBalanceInsufficient: listen('ai:balance-insufficient'),
    },
    autoConfirmation: {
      getState: () => invoke('auto-confirmation:get-state'),
      setEnabled: (enabled) => invoke('auto-confirmation:set-enabled', enabled),
      onChanged: listen('auto-confirmation:state', 'auto-confirmation:subscribe'),
    },
    agent: {
      run: (payload) => invoke('agent:run', payload),
      selfCheck: () => invoke('agent:self-check'),
      exportSelfCheckReport: (payload) => invoke('agent:export-self-check-report', payload),
      getStatus: () => invoke('agent:get-status'),
      restart: (reason) => invoke('agent:restart', reason),
      getPendingQuestion: () => invoke('agent:get-pending-question'),
      answerQuestion: (payload) => invoke('agent:answer-question', payload),
      suppressQuestionAutoAnswer: (payload) => invoke('agent:suppress-question-auto-answer', payload),
      onStatus: listen('agent:status', 'agent:subscribe'),
      onQuestion: listen('agent:question-state', 'agent:subscribe'),
    },
    developerTokenStats: {
      openWindow: () => invoke('developer-token-stats:open-window'),
      get: () => invoke('developer-token-stats:get'),
      reset: () => invoke('developer-token-stats:reset'),
      onChanged: listen('developer-token-stats:changed'),
    },
    developerAgentMonitor: {
      openWindow: () => invoke('developer-agent-monitor:open-window'),
      openWorkspace: (workspaceDir) => invoke('developer-agent-monitor:open-workspace', workspaceDir),
      attach: () => invoke('developer-agent-monitor:attach'),
      detach: () => invoke('developer-agent-monitor:detach'),
      onEvent: listen('developer-agent-monitor:event'),
    },
    developerExpansionReplaceTest: {
      run: (payload) => invoke('developer-expansion-replace-test:run', payload),
    },
    developerLayoutFigure: {
      reset: () => invoke('developer-layout-figure:reset'),
      render: (payload) => invoke('developer-layout-figure:render', payload),
      renderPreview: (html, config) => invoke('developer-layout-figure:render-preview', html, config),
    },
    file: {
      selectDuplicateCheckFiles: (options) => invoke('file:select-duplicate-check-files', options),
      selectBlindCheckFile: (options) => invoke('file:select-blind-check-file', options),
      selectBlindCheckTenderFile: () => invoke('file:select-blind-check-tender-file'),
      // 浏览器没有本地路径：返回上传占位符并后台开始上传，服务端调用前还原真实路径。
      getPathForFile: (file) => getPathTokenForFile(file),
    },
    knowledgeBase: {
      list: () => invoke('knowledge-base:list'),
      search: (request) => invoke('knowledge-base:search', request),
      createFolder: (name) => invoke('knowledge-base:create-folder', name),
      renameFolder: (folderId, name) => invoke('knowledge-base:rename-folder', folderId, name),
      reorderFolder: (draggedFolderId, targetFolderId, position) => invoke('knowledge-base:reorder-folder', draggedFolderId, targetFolderId, position),
      deleteFolder: (folderId) => invoke('knowledge-base:delete-folder', folderId),
      deleteDocument: (documentId) => invoke('knowledge-base:delete-document', documentId),
      moveDocument: (documentId, targetFolderId, targetDocumentId, position) => invoke('knowledge-base:move-document', documentId, targetFolderId, targetDocumentId, position),
      uploadDocuments: (folderId, filePaths) => invoke('knowledge-base:upload-documents', folderId, filePaths),
      retryDocument: (documentId) => invoke('knowledge-base:retry-document', documentId),
      startMatching: (documentId, batchSize) => invoke('knowledge-base:start-matching', documentId, batchSize),
      readMarkdown: (documentId) => invoke('knowledge-base:read-markdown', documentId),
      readItems: (documentId) => invoke('knowledge-base:read-items', documentId),
      readAnalysis: (documentId) => invoke('knowledge-base:read-analysis', documentId),
      onEvent: listen('knowledge-base:event'),
    },
    credentialLibrary: {
      load: () => invoke('credential-library:load'),
      importTestData: () => invoke('credential-library:import-test-data'),
      saveProfile: (partial) => invoke('credential-library:save-profile', partial),
      addProfileImages: (fieldKey, filePaths) => invoke('credential-library:add-profile-images', fieldKey, filePaths),
      deleteImage: (imageId) => invoke('credential-library:delete-image', imageId),
      saveCertificate: (payload) => invoke('credential-library:save-certificate', payload),
      deleteCertificate: (recordId) => invoke('credential-library:delete-certificate', recordId),
      saveEmployee: (payload) => invoke('credential-library:save-employee', payload),
      deleteEmployee: (recordId) => invoke('credential-library:delete-employee', recordId),
      saveProject: (payload) => invoke('credential-library:save-project', payload),
      deleteProject: (recordId) => invoke('credential-library:delete-project', recordId),
      saveOtherMaterial: (payload) => invoke('credential-library:save-other-material', payload),
      deleteOtherMaterial: (recordId) => invoke('credential-library:delete-other-material', recordId),
    },
    technicalPlan: {
      loadState: () => invoke('technical-plan:load-state'),
      loadGenerationConfig: () => invoke('technical-plan:load-generation-config'),
      saveGenerationConfig: (partial) => invoke('technical-plan:save-generation-config', partial),
      importTenderDocument: (filePaths) => invoke('technical-plan:import-tender-document', filePaths),
      removeTenderDocument: (sourceId) => invoke('technical-plan:remove-tender-document', sourceId),
      importOriginalPlanDocument: (filePaths) => invoke('technical-plan:import-original-plan-document', filePaths),
      removeOriginalPlanDocument: () => invoke('technical-plan:remove-original-plan-document'),
      checkBidSections: () => invoke('technical-plan:check-bid-sections'),
      selectBidSection: (selectedSection) => invoke('technical-plan:select-bid-section', selectedSection),
      readTenderMarkdown: () => invoke('technical-plan:read-tender-markdown'),
      readContentWord: (sectionId) => invoke('technical-plan:read-content-word', sectionId),
      previewContentWord: (sectionId) => invoke('technical-plan:preview-content-word', sectionId),
      previewBusinessChapterWord: (nodeId) => invoke('technical-plan:preview-business-chapter-word', nodeId),
      readTenderSourceMarkdown: (sourceId) => invoke('technical-plan:read-tender-source-markdown', sourceId),
      updateStep: (step) => invoke('technical-plan:update-step', step),
      saveBidAnalysisConfig: (payload) => invoke('technical-plan:save-bid-analysis-config', payload),
      saveOutlineSelection: (payload) => invoke('tasks:confirm-outline-selection', payload),
      saveOutline: (outlineData) => invoke('technical-plan:save-outline', outlineData),
      saveGlobalFacts: (globalFacts) => invoke('technical-plan:save-global-facts', globalFacts),
      saveContentGenerationOptions: (options) => invoke('technical-plan:save-content-generation-options', options),
      resetContentGeneration: () => invoke('technical-plan:reset-content-generation'),
      clear: () => invoke('technical-plan:clear'),
      inspectBidTemplate: () => invoke('technical-plan:inspect-bid-template'),
      openBidTemplate: () => invoke('technical-plan:open-bid-template'),
      getBusinessFillReview: () => invoke('technical-plan:get-business-fill-review'),
      saveBusinessFillReview: (payload) => invoke('technical-plan:save-business-fill-review', payload),
    },
    feasibilityReport: {
      loadState: () => invoke('feasibility-report:load-state'),
      importSourceDocuments: (filePaths) => invoke('feasibility-report:import-source-documents', filePaths),
      removeSourceDocument: (sourceId) => invoke('feasibility-report:remove-source-document', sourceId),
      readSourceMarkdown: (sourceId) => invoke('feasibility-report:read-source-markdown', sourceId),
      readCombinedSourceMarkdown: () => invoke('feasibility-report:read-combined-source-markdown'),
      updateStep: (step) => invoke('feasibility-report:update-step', step),
      saveProjectInfo: (projectInfo) => invoke('feasibility-report:save-project-info', projectInfo),
      saveAnalysis: (markdown) => invoke('feasibility-report:save-analysis', markdown),
      saveOutlineConfig: (payload) => invoke('feasibility-report:save-outline-config', payload),
      saveOutline: (payload) => invoke('feasibility-report:save-outline', payload),
      saveKeyParameters: (markdown) => invoke('feasibility-report:save-key-parameters', markdown),
      saveChapterContent: (payload) => invoke('feasibility-report:save-chapter-content', payload),
      clear: () => invoke('feasibility-report:clear'),
    },
    duplicateCheck: {
      loadState: () => invoke('duplicate-check:load-state'),
      saveFiles: (payload) => invoke('duplicate-check:save-files', payload),
      saveUiState: (payload) => invoke('duplicate-check:save-ui-state', payload),
      updateState: (partial) => invoke('duplicate-check:update-state', partial),
      exportExcel: (request) => invoke('duplicate-check:export-excel', request),
      clear: () => invoke('duplicate-check:clear'),
    },
    rejectionCheck: {
      loadState: () => invoke('rejection-check:load-state'),
      importDocument: (role, filePaths) => invoke('rejection-check:import-document', role, filePaths),
      importTenderFromTechnicalPlan: () => invoke('rejection-check:import-tender-from-technical-plan'),
      removeDocument: (role, documentId) => invoke('rejection-check:remove-document', role, documentId),
      saveUiState: (payload) => invoke('rejection-check:save-ui-state', payload),
      updateState: (partial) => invoke('rejection-check:update-state', partial),
      exportExcel: (request) => invoke('rejection-check:export-excel', request),
      clear: () => invoke('rejection-check:clear'),
    },
    blindCheck: {
      loadState: () => invoke('blind-check:load-state'),
      importFile: (filePath) => invoke('blind-check:import-file', filePath),
      removeFile: () => invoke('blind-check:remove-file'),
      saveUiState: (payload) => invoke('blind-check:save-ui-state', payload),
      listPresets: () => invoke('blind-check:list-presets'),
      createPreset: (payload) => invoke('blind-check:create-preset', payload),
      updatePreset: (presetId, patch) => invoke('blind-check:update-preset', presetId, patch),
      deletePreset: (presetId) => invoke('blind-check:delete-preset', presetId),
      selectPreset: (presetId) => invoke('blind-check:select-preset', presetId),
      setUseCredentialWords: (enabled) => invoke('blind-check:set-use-credential-words', enabled),
      getCredentialWords: () => invoke('blind-check:get-credential-words'),
      getInputSignature: () => invoke('blind-check:get-input-signature'),
      saveFixRules: (rules) => invoke('blind-check:save-fix-rules', rules),
      saveFixedDocument: () => invoke('blind-check:save-fixed-document'),
      getTenderSources: () => invoke('blind-check:get-tender-sources'),
      clear: () => invoke('blind-check:clear'),
    },
    templates: {
      list: () => invoke('templates:list'),
      get: (templateId) => invoke('templates:get', templateId),
      create: (config) => invoke('templates:create', config),
      update: (templateId, config) => invoke('templates:update', templateId, config),
      delete: (templateId) => invoke('templates:delete', templateId),
      duplicate: (templateId) => invoke('templates:duplicate', templateId),
      renderPreview: (html, config) => invoke('templates:render-preview', html, config),
    },
    tasks: {
      startBidSectionExtraction: (payload) => invoke('tasks:start-bid-section-extraction', payload),
      startBidAnalysis: (payload) => invoke('tasks:start-bid-analysis', payload),
      startOutlineGeneration: (payload) => invoke('tasks:start-outline-generation', payload),
      suppressOutlineSelectionAutoConfirmation: (payload) => invoke('tasks:suppress-outline-selection-auto-confirmation', payload),
      confirmBusinessFillReview: (payload) => invoke('tasks:confirm-business-fill-review', payload),
      suppressBusinessFillReviewAutoConfirmation: (payload) => invoke('tasks:suppress-business-fill-review-auto-confirmation', payload),
      startBidTemplateExtraction: () => invoke('tasks:start-bid-template-extraction'),
      startRulePageCompile: () => invoke('tasks:start-rule-page-compile'),
      startGlobalFactsGeneration: (payload) => invoke('tasks:start-global-facts-generation', payload),
      startContentGeneration: (payload) => invoke('tasks:start-content-generation', payload),
      pauseContentGeneration: () => invoke('tasks:pause-content-generation'),
      startRejectionItemsExtraction: (payload) => invoke('tasks:start-rejection-items-extraction', payload),
      startRejectionCheck: (payload) => invoke('tasks:start-rejection-check', payload),
      startDuplicateAnalysis: (payload) => invoke('tasks:start-duplicate-analysis', payload),
      startBlindCheck: (payload) => invoke('tasks:start-blind-check', payload),
      startBlindCheckFix: (payload) => invoke('tasks:start-blind-check-fix', payload),
      startBlindCheckPresetExtraction: (payload) => invoke('tasks:start-blind-check-preset-extraction', payload),
      startFeasibilityAnalysis: (payload) => invoke('tasks:start-feasibility-analysis', payload),
      startFeasibilityOutline: (payload) => invoke('tasks:start-feasibility-outline', payload),
      startFeasibilityParameters: (payload) => invoke('tasks:start-feasibility-parameters', payload),
      startFeasibilityContent: (payload) => invoke('tasks:start-feasibility-content', payload),
      pauseFeasibilityContent: () => invoke('tasks:pause-feasibility-content'),
      startFeasibilityHumanWriting: (payload) => invoke('tasks:start-feasibility-human-writing', payload),
      getActiveTasks: () => invoke('tasks:get-active'),
      onTaskEvent: listen('tasks:event', 'tasks:subscribe'),
    },
    export: {
      exportWord: (payload) => invoke('export:word', payload),
      // 浏览器形态：导出文件在服务端下载目录，直接触发浏览器下载。
      openFile: (filePath) => downloadServerFile(filePath).then(() => ({ success: true })),
      onWordExportProgress: listen('export:word-progress'),
    },
    systemFonts: {
      list: () => invoke('system-fonts:list'),
    },
    plugins: {
      getAvailablePlugins: () => invoke('plugins:getAvailablePlugins'),
      install: (pluginId) => invoke('plugins:install', pluginId),
      installOffline: () => invoke('plugins:installOffline'),
      uninstall: (pluginId) => invoke('plugins:uninstall', pluginId),
      enable: (pluginId) => invoke('plugins:enable', pluginId),
      disable: (pluginId) => invoke('plugins:disable', pluginId),
      update: (pluginId) => invoke('plugins:update', pluginId),
      checkUpdates: () => invoke('plugins:checkUpdates'),
      updateAll: () => invoke('plugins:updateAll'),
      openConfig: (pluginId) => invoke('plugins:openConfig', pluginId),
      refreshMarket: () => invoke('plugins:refreshMarket'),
      clearUpdateFailedState: (pluginId) => invoke('plugins:clearUpdateFailedState', pluginId),
      notifyEvent: (pluginId, event, payload) => invoke('plugins:notify-event', pluginId, event, payload),
    },
    dependencies: {
      getStatus: (dependencyId) => invoke('dependencies:get-status', dependencyId),
      install: (dependencyId) => invoke('dependencies:install', dependencyId),
      uninstall: (dependencyId) => invoke('dependencies:uninstall', dependencyId),
      onProgress: listen('dependencies:progress'),
    },
    dualLayerPdf: {
      getState: () => invoke('dual-layer-pdf:get-state'),
      getEnvironment: () => invoke('dual-layer-pdf:get-environment'),
      selectFiles: () => invoke('dual-layer-pdf:select-files'),
      addFiles: (filePaths) => invoke('dual-layer-pdf:add-files', filePaths),
      removeItem: (itemId) => invoke('dual-layer-pdf:remove-item', itemId),
      retryItem: (itemId) => invoke('dual-layer-pdf:retry-item', itemId),
      selectOutputDir: () => invoke('dual-layer-pdf:select-output-dir'),
      resetOutputDir: () => invoke('dual-layer-pdf:reset-output-dir'),
      setOutputs: (outputs) => invoke('dual-layer-pdf:set-outputs', outputs),
      start: () => invoke('dual-layer-pdf:start'),
      cancel: () => invoke('dual-layer-pdf:cancel'),
      clear: () => invoke('dual-layer-pdf:clear'),
      showInFolder: (filePath) => invoke('dual-layer-pdf:show-in-folder', filePath),
      onEvent: listen('dual-layer-pdf:event'),
    },
  };
}

// 浏览器环境下挂载 window.yibiao；在 WS 就绪后 resolve，随后再渲染应用。
// 首连失败时 dispose 当前客户端（停止其自动重连）并把错误抛给调用方，
// 由调用方负责重试（bootstrap 轮询），避免泄漏多个后台重连的客户端。
export async function installWebBridge(): Promise<void> {
  const client = new WebIpcClient();
  try {
    await client.connect();
  } catch (error) {
    client.dispose();
    throw error;
  }
  const bridge = buildBridge(client);
  attachDialogBridge(client, (channel, ...args) => client.invoke(channel, ...args));
  (window as unknown as { yibiao: YibiaoBridge; yibiaoWebBridge?: boolean }).yibiaoWebBridge = true;
  (window as unknown as { yibiao: YibiaoBridge }).yibiao = bridge;
  (window as unknown as { yibiaoClient?: { appName: string; platform: string } }).yibiaoClient = {
    appName: bridge.appName,
    platform: bridge.platform,
  };
}

// Renderer 内部判断当前是否为网页版垫片（如 Markdown 图片 src 协议改写）。
export function isWebBridgeActive(): boolean {
  return (window as unknown as { yibiaoWebBridge?: boolean }).yibiaoWebBridge === true;
}

// 网页版把 yibiao-asset:// 协议引用改写为同源 HTTP 路由；桌面版原样返回。
export function resolveAssetUrl(src: string): string {
  if (isWebBridgeActive() && src.startsWith('yibiao-asset://')) {
    return src.replace(/^yibiao-asset:\/\//, '/yibiao-asset/');
  }
  return src;
}
