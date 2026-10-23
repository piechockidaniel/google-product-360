import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/http/server.js';
import { testContext } from './helpers.js';
import type { AppContext } from '../src/app.js';

let ctx: AppContext;
let app: FastifyInstance;
let cookie = '';

beforeEach(async () => {
  ({ ctx } = testContext());
  app = await createServer(ctx);
  await ctx.sync.runFullSync('test');
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin12345' } });
  expect(login.statusCode).toBe(200);
  cookie = login.headers['set-cookie'] as string;
});
afterEach(async () => {
  await app.close();
  await ctx.stop();
});

describe('HTTP API', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/products' });
    expect(res.statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'wrong' } });
    expect(bad.statusCode).toBe(401);
  });

  it('serves dashboard, products, issues, feeds and workflows', async () => {
    const dash = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } });
    expect(dash.statusCode).toBe(200);
    expect(dash.json().productStats.total).toBe(30);
    expect(['ok', 'warning', 'error']).toContain(dash.json().health);

    const products = await app.inject({ method: 'GET', url: '/api/products?status=DISAPPROVED&limit=5', headers: { cookie } });
    expect(products.statusCode).toBe(200);
    expect(products.json().items.length).toBeGreaterThan(0);
    const productId = products.json().items[0].productId;

    const detail = await app.inject({ method: 'GET', url: `/api/products/${productId}`, headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().issues.length).toBeGreaterThan(0);

    const meta = await app.inject({ method: 'PUT', url: `/api/products/${productId}/metadata`, headers: { cookie }, payload: { tags: ['t1'], notes: 'n' } });
    expect(meta.json().tags).toEqual(['t1']);

    const push = await app.inject({ method: 'POST', url: `/api/products/${productId}/attributes`, headers: { cookie }, payload: { attributes: { customLabel0: 'x', price: '1.50 PLN' } } });
    expect(push.statusCode).toBe(200);
    expect(push.json().attributes.price).toEqual({ amountMicros: '1500000', currencyCode: 'PLN' });

    const badPush = await app.inject({ method: 'POST', url: `/api/products/${productId}/attributes`, headers: { cookie }, payload: { attributes: { availability: 'NOPE' } } });
    expect(badPush.statusCode).toBe(400);

    const issues = await app.inject({ method: 'GET', url: '/api/issues?since=lastLogin', headers: { cookie } });
    expect(issues.statusCode).toBe(200);

    const feeds = await app.inject({ method: 'GET', url: '/api/feeds', headers: { cookie } });
    expect(feeds.json().feeds.length).toBeGreaterThanOrEqual(3);

    const created = await app.inject({
      method: 'POST',
      url: '/api/feeds',
      headers: { cookie },
      payload: { displayName: 'Test', feedLabel: 'CZ', contentLanguage: 'cs', file: { type: 'FETCH', fetchUri: 'https://x.example/f.xml' } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().fetchSchedule).toContain('daily');
    const invalid = await app.inject({ method: 'POST', url: '/api/feeds', headers: { cookie }, payload: { displayName: 'x', feedLabel: 'lower' } });
    expect(invalid.statusCode).toBe(400);

    const wf = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { cookie },
      payload: { name: 'wf', trigger: { type: 'schedule', cron: '0 6 * * *' }, steps: [{ type: 'select_products', filter: {} }, { type: 'add_tags', tags: ['all'] }] },
    });
    expect(wf.statusCode).toBe(201);
    const run = await app.inject({ method: 'POST', url: `/api/workflows/${wf.json().id}/run?wait=true`, headers: { cookie } });
    expect(run.json().status).toBe('success');
    expect(run.json().stats.selected).toBe(30);
    const list = await app.inject({ method: 'GET', url: '/api/workflows', headers: { cookie } });
    expect(list.json().workflows[0].nextRunAt).toBeTruthy();
  });

  it('accepts Google notifications on the webhook and refreshes the product', async () => {
    const products = await app.inject({ method: 'GET', url: '/api/products?limit=1', headers: { cookie } });
    const name = products.json().items[0].name as string;
    const ok = await app.inject({
      method: 'POST',
      url: `/api/webhooks/merchant/${ctx.settings.current().webhookSecret}`,
      payload: { resource: name, resourceId: name.split('/').pop(), changes: [{ oldValue: 'approved', newValue: 'disapproved', regionCode: 'PL', reportingContext: 'SHOPPING_ADS' }] },
    });
    expect(ok.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.events.list({ type: 'notification.received' }).total).toBe(1);
    const wrong = await app.inject({ method: 'POST', url: '/api/webhooks/merchant/wrong', payload: {} });
    expect(wrong.statusCode).toBe(404);
  });
});
