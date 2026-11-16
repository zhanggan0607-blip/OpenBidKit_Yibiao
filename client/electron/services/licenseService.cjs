const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { getLicenseFilePath } = require('../utils/paths.cjs');
const { getOsMachineId } = require('../utils/machineIdentity.cjs');

const packageJson = require('../../package.json');

const PROJECT_NAME = packageJson.name || 'yibiao-client';
const APP_ID = packageJson.build?.appId || 'com.yibiao.openbidkit';
const FINGERPRINT_VERSION = '2026-01';

const buildAttestationPath = path.join(__dirname, '..', 'resources', 'build-attestation.json');

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function hashHex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf-8').digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function getMacFingerprint() {
  const macs = [];
  const interfaces = os.networkInterfaces();
  for (const items of Object.values(interfaces)) {
    for (const item of items || []) {
      const mac = String(item.mac || '').toLowerCase();
      if (!mac || mac === '00:00:00:00:00:00' || item.internal) continue;
      macs.push(mac);
    }
  }
  return hashHex(Array.from(new Set(macs)).sort().join('|'));
}

function createMachineFingerprintHash({ clientId }) {
  const raw = PROJECT_NAME
    + APP_ID
    + clientId
    + clientId
    + getOsMachineId()
    + getMacFingerprint()
    + FINGERPRINT_VERSION;
  return hashHex(raw);
}

function getBuildAttestation() {
  const attestation = readJsonFile(buildAttestationPath);
  return attestation && typeof attestation === 'object' ? attestation : null;
}

// 授权体系已移除：本版本内置激活，不再发起任何远程授权请求。
// 状态对象保持原字段形状，供埋点上报（license_status 等）与 Agent 失败诊断信封使用。
function createBuiltinActiveStatus({ app, configStore }) {
  const config = configStore.load();
  const clientId = config.analytics_client_id || '';
  const buildInfo = getBuildAttestation() || {};
  return {
    status: 'active',
    plan: 'builtin',
    expiresAt: '2999-12-31T00:00:00.000Z',
    licenseExpiresAt: '2999-12-31',
    licenseStatus: 'active',
    activationMode: 'builtin',
    sourceTrusted: true,
    sourceTrustedText: 'true',
    untrustedReason: '',
    machineFingerprintHash: createMachineFingerprintHash({ clientId }),
    fingerprintVersion: FINGERPRINT_VERSION,
    buildTrusted: true,
    buildChanged: false,
    buildId: String(buildInfo.buildId || ''),
    keyId: String(buildInfo.keyId || ''),
    lastCheckedAt: nowIso(),
    config: {
      freeLicenseDays: 30,
      expirePopupEnabled: false,
      expirePopupDismissible: true,
    },
  };
}

function createLicenseService({ app, configStore }) {
  const licenseFile = getLicenseFilePath(app);
  let currentStatus = createBuiltinActiveStatus({ app, configStore });

  return {
    getLicenseFilePath() {
      return licenseFile;
    },
    getBuildAttestation() {
      return getBuildAttestation();
    },
    getLicenseEnvelope() {
      // 诊断信封：授权体系移除后恒为 null，agentErrorReporter 已兼容空值。
      return null;
    },
    getStatus() {
      currentStatus = createBuiltinActiveStatus({ app, configStore });
      return Promise.resolve(currentStatus);
    },
    refresh() {
      return this.getStatus();
    },
    importOfflineFile() {
      return Promise.resolve({
        success: true,
        message: '本版本已内置授权，无需激活',
        status: currentStatus,
      });
    },
    activateOfflineCode() {
      return Promise.resolve({
        success: true,
        message: '本版本已内置授权，无需激活',
        status: currentStatus,
      });
    },
    refreshOnStartup() {
      return this.getStatus();
    },
    getCurrentStatus() {
      return currentStatus;
    },
  };
}

module.exports = {
  createLicenseService,
};
