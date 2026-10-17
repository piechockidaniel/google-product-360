import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ServiceAccountTokenProvider } from '../src/google/auth.js';
import { loadConfig } from '../src/config/index.js';

const KEY = { type: 'service_account', client_email: 'a@b.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n' };

describe('ServiceAccountTokenProvider', () => {
  it('builds from JSON and rejects incomplete keys', () => {
    expect(ServiceAccountTokenProvider.fromJson(JSON.stringify(KEY))).toBeInstanceOf(ServiceAccountTokenProvider);
    expect(() => ServiceAccountTokenProvider.fromJson('{"client_email":"x"}')).toThrow(/private_key/);
  });

  it('builds from config: inline JSON, key file, missing file', () => {
    const base = { SESSION_SECRET: 'test-secret-test-secret-test', LOG_LEVEL: 'silent' };
    expect(ServiceAccountTokenProvider.fromConfig(loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY) }))).toBeInstanceOf(ServiceAccountTokenProvider);
    const file = path.join(os.tmpdir(), `sa-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(KEY));
    try {
      expect(ServiceAccountTokenProvider.fromConfig(loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY_PATH: file }))).toBeInstanceOf(ServiceAccountTokenProvider);
      fs.writeFileSync(file, '{"type":"service_account"}');
      expect(() => ServiceAccountTokenProvider.fromConfig(loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY_PATH: file }))).toThrow(/missing/);
    } finally {
      fs.unlinkSync(file);
    }
    expect(() => ServiceAccountTokenProvider.fromConfig(loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY_PATH: '/nope/none.json' }))).toThrow(/not found/);
  });

  it('fails to get a token without network (does not hang)', async () => {
    const provider = ServiceAccountTokenProvider.fromJson(JSON.stringify(KEY));
    await expect(provider.getAccessToken()).rejects.toBeTruthy();
  }, 15000);
});

describe('loadConfig', () => {
  it('reports invalid values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid configuration/);
    const cfg = loadConfig({ MERCHANT_MOCK: 'yes', SYNC_ON_STARTUP: '0' });
    expect(cfg.MERCHANT_MOCK).toBe(true);
    expect(cfg.SYNC_ON_STARTUP).toBe(false);
    expect(cfg.clientDistDir.endsWith(path.join('dist', 'client'))).toBe(true);
  });
});
