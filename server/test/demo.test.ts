import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/http/server.js';
import { testContext } from './helpers.js';
import type { AppContext } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { DEMO_LOGIN, bootstrapDemo, warmUpDemo } from '../src/demo/demo-bootstrap.js';

let ctx: AppContext;

beforeEach(() => {
  ({ ctx } = testContext({ DEMO_MODE: 'true' }));
});
afterEach(async () => {
  await ctx.stop();
});

describe('demo mode', () => {
  it('DEMO_MODE forces the mock API and supplies its own database + login defaults', () => {
    const cfg = loadConfig({ DEMO_MODE: 'true', SESSION_SECRET: 'test-secret-test-secret-test' });
    expect(cfg.MERCHANT_MOCK).toBe(true);
    expect(cfg.DATABASE_PATH).toBe('./data/demo.sqlite');
    expect(cfg.ADMIN_USERNAME).toBe(DEMO_LOGIN.username);
    expect(cfg.ADMIN_PASSWORD).toBe(DEMO_LOGIN.password);
    // explicit values win
    const custom = loadConfig({ DEMO_MODE: 'true', DATABASE_PATH: '/tmp/x.sqlite', ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'secret123', SESSION_SECRET: 'test-secret-test-secret-test' });
    expect(custom.DATABASE_PATH).toBe('/tmp/x.sqlite');
    expect(custom.ADMIN_USERNAME).toBe('boss');
    const off = loadConfig({ SESSION_SECRET: 'test-secret-test-secret-test' });
    expect(off.DEMO_MODE).toBe(false);
    expect(off.MERCHANT_MOCK).toBe(false);
  });

  it('bootstraps settings + workflows idempotently and warms up the data', async () => {
    const first = bootstrapDemo(ctx);
    expect(first.settingsApplied).toBe(true);
    expect(first.workflowsInstalled.length).toBe(6);
    const s = ctx.settings.current();
    expect(s.setupCompletedAt).toBeTruthy();
    expect(s.searchConsoleEnabled).toBe(true);
    expect(s.searchConsoleSiteUrl).toBe('sc-domain:example-shop.pl');
    expect(s.metricsBackfillDays).toBe(120);
    const workflows = ctx.workflows.list();
    expect(workflows.filter((w) => w.enabled).map((w) => w.name).sort()).toEqual(['Product360 – organic easy wins', 'Product360 – scale label', 'Tag disapproved products']);
    expect(ctx.events.list({ type: 'demo.bootstrapped' }).total).toBe(1);

    const second = bootstrapDemo(ctx);
    expect(second.settingsApplied).toBe(false);
    expect(second.workflowsInstalled).toEqual([]);
    expect(ctx.workflows.list().length).toBe(6);

    const summary = await warmUpDemo(ctx);
    expect(summary.products).toBe(30);
    expect(Object.values(summary.recommendations).reduce((a, b) => a + b, 0)).toBe(30);
    expect(ctx.metricsSync.status().connectors.every((c) => c.lastSuccessfulRun)).toBe(true);
  });

  it('exposes the demo flag and the "simulate a day" helper over HTTP', async () => {
    bootstrapDemo(ctx);
    await warmUpDemo(ctx);
    const app: FastifyInstance = await createServer(ctx);
    try {
      const status = await app.inject({ method: 'GET', url: '/api/setup/status' });
      expect(status.json().demo).toBe(true);
      expect(status.json().mock).toBe(true);
      // testContext sets ADMIN_PASSWORD only – in demo mode the username defaults to "demo"
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'demo', password: 'admin12345' } });
      expect(login.statusCode).toBe(200);
      const cookie = login.headers['set-cookie'] as string;
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(me.json().demo).toBe(true);

      const day = await app.inject({ method: 'POST', url: '/api/dev/mock/simulate-day', headers: { cookie } });
      expect(day.statusCode).toBe(200);
      expect(day.json().sync.products).toBe(30);
      expect(day.json().signals.products).toBe(30);
      expect(Array.isArray(day.json().changes.added)).toBe(true);
      const dash = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } });
      expect(dash.json().insights.computed).toBe(true);
      expect(dash.json().insights.organic.current.impressions).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
