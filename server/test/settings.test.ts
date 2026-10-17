import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/http/server.js';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { silentLogger } from '../src/util/logger.js';
import { Database } from '../src/db/database.js';
import { SettingsService } from '../src/services/settings-service.js';

const FAKE_KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'demo-project',
  private_key_id: 'abc',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n',
  client_email: 'bot@demo-project.iam.gserviceaccount.com',
});

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    SESSION_SECRET: 'test-secret-test-secret-test',
    SYNC_INTERVAL_MINUTES: '0',
    SYNC_ON_STARTUP: 'false',
    LOG_LEVEL: 'silent',
    GOOGLE_SERVICE_ACCOUNT_KEY_PATH: '/nonexistent.json',
    ...extra,
  });
}

describe('SettingsService', () => {
  it('uses environment defaults, stores updates and encrypts the service account key', () => {
    const db = new Database(':memory:');
    const svc = new SettingsService(db, config({ MERCHANT_ACCOUNT_ID: '42', MERCHANT_TIME_ZONE: 'Europe/Berlin' }), silentLogger);
    expect(svc.current().merchantAccountId).toBe('42');
    expect(svc.current().timeZone).toBe('Europe/Berlin');
    expect(svc.isConfigured()).toBe(false);
    expect(svc.publicView().fromEnvironment).toContain('merchantAccountId');

    const changes: string[][] = [];
    svc.onChange((_n, _p, changed) => changes.push(changed));
    svc.update({ serviceAccountJson: FAKE_KEY, merchantAccountId: '43', timeZone: 'Europe/Berlin' });
    expect(changes).toEqual([['serviceAccountJson', 'merchantAccountId']]);
    expect(svc.isConfigured()).toBe(true);
    expect(svc.publicView().serviceAccount?.clientEmail).toBe('bot@demo-project.iam.gserviceaccount.com');
    expect(JSON.stringify(svc.publicView())).not.toContain('PRIVATE KEY');

    const raw = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'merchant.serviceAccountJson'")!.value;
    expect(raw.startsWith('enc:v1:')).toBe(true);
    expect(raw).not.toContain('PRIVATE KEY');

    // a fresh instance reads the stored (decrypted) values
    const again = new SettingsService(db, config(), silentLogger);
    expect(again.current().merchantAccountId).toBe('43');
    expect(again.current().serviceAccountJson).toBe(FAKE_KEY);

    // with a different SESSION_SECRET the key cannot be decrypted -> falls back gracefully
    const other = new SettingsService(db, config({ SESSION_SECRET: 'another-secret-another-secret' }), silentLogger);
    expect(other.current().serviceAccountJson).toBeNull();
    expect(other.isConfigured()).toBe(false);
  });

  it('rejects invalid values', () => {
    const svc = new SettingsService(new Database(':memory:'), config(), silentLogger);
    expect(() => svc.update({ serviceAccountJson: '{"type":"user"}' })).toThrow(/service account/);
    expect(() => svc.update({ merchantAccountId: 'abc' })).toThrow();
    expect(() => svc.update({ publicUrl: 'not a url' })).toThrow();
  });
});

describe('Setup wizard API', () => {
  let ctx: AppContext;
  let app: FastifyInstance;
  beforeEach(async () => {
    ctx = buildApp(config(), silentLogger);
    app = await createServer(ctx);
  });
  afterEach(async () => {
    await app.close();
    await ctx.stop();
  });

  it('walks through admin creation, connection test and completion', async () => {
    let status = await app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(status.json()).toMatchObject({ needsAdmin: true, configured: false });

    const admin = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: { username: 'owner', password: 'secret123' } });
    expect(admin.statusCode).toBe(201);
    const again = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: { username: 'x', password: 'secret123' } });
    expect(again.statusCode).toBe(409);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: 'secret123' } });
    const cookie = login.headers['set-cookie'] as string;

    // Everything that needs Google answers 409 while unconfigured
    const dash = await app.inject({ method: 'GET', url: '/api/feeds', headers: { cookie } });
    expect(dash.statusCode).toBe(409);
    expect(dash.json().code).toBe('not_configured');

    const inspect = await app.inject({ method: 'POST', url: '/api/setup/inspect-key', headers: { cookie }, payload: { serviceAccountJson: FAKE_KEY } });
    expect(inspect.json().projectId).toBe('demo-project');

    // test connection in mock mode works without Google
    const test = await app.inject({ method: 'POST', url: '/api/setup/test-connection', headers: { cookie }, payload: { mock: true, merchantAccountId: '777' } });
    expect(test.json().ok).toBe(true);
    expect(test.json().account.accountId).toBe('777');

    const missing = await app.inject({ method: 'POST', url: '/api/setup/test-connection', headers: { cookie }, payload: { mock: false, merchantAccountId: '' } });
    expect(missing.json().ok).toBe(false);

    const saved = await app.inject({ method: 'PUT', url: '/api/setup/config', headers: { cookie }, payload: { mock: true, merchantAccountId: '777', syncIntervalMinutes: 5 } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().configured).toBe(true);
    expect(ctx.api.accountId).toBe('777'); // client was swapped at runtime
    expect(ctx.mock).not.toBeNull();

    const feeds = await app.inject({ method: 'GET', url: '/api/feeds', headers: { cookie } });
    expect(feeds.statusCode).toBe(200);

    const done = await app.inject({ method: 'POST', url: '/api/setup/complete', headers: { cookie } });
    expect(done.json().ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.products.productStats().total).toBeGreaterThan(0);
    status = await app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(status.json()).toMatchObject({ needsAdmin: false, configured: true, setupCompleted: true });

    // storing a real-looking key switches to the REST client (which cannot reach Google here)
    const real = await app.inject({ method: 'PUT', url: '/api/setup/config', headers: { cookie }, payload: { mock: false, merchantAccountId: '1', serviceAccountJson: FAKE_KEY } });
    expect(real.statusCode).toBe(200);
    expect(ctx.mock).toBeNull();
    expect(ctx.api.accountName).toBe('accounts/1');
  });
});

describe('Developer registration', () => {
  it('recognises the "not registered" error and offers registration', async () => {
    const ctx = buildApp(config(), silentLogger);
    const app = await createServer(ctx);
    try {
      await app.inject({ method: 'POST', url: '/api/setup/admin', payload: { username: 'owner', password: 'secret123' } });
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: 'secret123' } });
      const cookie = login.headers['set-cookie'] as string;
      // mock mode exercises the endpoint itself
      const reg = await app.inject({ method: 'POST', url: '/api/setup/register-gcp', headers: { cookie }, payload: { mock: true, merchantAccountId: '1', developerEmail: 'owner@example.com' } });
      expect(reg.json().ok).toBe(true);
      const bad = await app.inject({ method: 'POST', url: '/api/setup/register-gcp', headers: { cookie }, payload: { mock: true, merchantAccountId: '1', developerEmail: 'nope' } });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
      await ctx.stop();
    }
  });

  it('maps Google\'s registration error to a needsRegistration flag', async () => {
    const { NOT_REGISTERED_RE } = await import('../src/http/routes/setup.js');
    expect(NOT_REGISTERED_RE.test('GCP project with id x and number 1 is not registered with the merchant account. Please follow these steps ...')).toBe(true);
    expect(NOT_REGISTERED_RE.test('The caller does not have permission')).toBe(false);
  });
});
