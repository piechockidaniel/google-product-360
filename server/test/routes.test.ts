import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/http/server.js';
import { testContext } from './helpers.js';
import type { AppContext } from '../src/app.js';
import type { MockMerchantApi } from '../src/mock/mock-merchant-api.js';

let ctx: AppContext;
let mock: MockMerchantApi;
let app: FastifyInstance;
let cookie = '';

async function login(username = 'admin', password = 'admin12345') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return res;
}
const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, headers: { cookie }, payload: payload ?? {} });
const put = (url: string, payload?: unknown) => app.inject({ method: 'PUT', url, headers: { cookie }, payload: payload ?? {} });
const patch = (url: string, payload?: unknown) => app.inject({ method: 'PATCH', url, headers: { cookie }, payload: payload ?? {} });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: { cookie } });

beforeEach(async () => {
  ({ ctx, mock } = testContext({ PUBLIC_URL: 'https://gmc.example.com' }));
  app = await createServer(ctx);
  await ctx.sync.runFullSync('test');
  cookie = (await login()).headers['set-cookie'] as string;
});
afterEach(async () => {
  await app.close();
  await ctx.stop();
});

describe('auth routes', () => {
  it('logout, me, acknowledge, password change, throttling', async () => {
    expect((await get('/api/auth/me')).json().user.username).toBe('admin');
    const ack = await post('/api/auth/acknowledge');
    expect(ack.json().user.previousLoginAt).toBeTruthy();
    expect((await post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'newpassword1' })).statusCode).toBe(400);
    expect((await post('/api/auth/password', { currentPassword: 'admin12345', newPassword: 'newpassword1' })).statusCode).toBe(200);
    expect((await post('/api/auth/logout')).statusCode).toBe(200);
    expect((await get('/api/auth/me')).statusCode).toBe(401);
    expect((await login('admin', 'newpassword1')).statusCode).toBe(200);
    for (let i = 0; i < 10; i += 1) await login('admin', 'bad');
    expect((await login('admin', 'newpassword1')).statusCode).toBe(429);
  });
});

describe('product routes', () => {
  it('facets, refresh, history, attribute removal and bulk operations', async () => {
    const facets = await get('/api/products/facets');
    expect(facets.json().attributeCatalog.length).toBeGreaterThan(10);
    expect(facets.json().feedLabels).toContain('PL');
    const list = await get('/api/products?orderBy=title&orderDir=desc&hasIssues=true&feedLabel=PL&brand=Acme&availability=IN_STOCK&includeDeleted=true&limit=5');
    expect(list.statusCode).toBe(200);
    const id = (await get('/api/products?limit=1')).json().items[0].productId as string;
    expect((await post(`/api/products/${id}/refresh`)).statusCode).toBe(200);
    expect((await get(`/api/products/${id}/history`)).json()).toHaveProperty('issues');
    expect((await get(`/api/products/${id}/rendered-issues`)).statusCode).toBe(200);
    expect((await get('/api/products/bm9wZQ')).statusCode).toBe(404);
    expect((await put('/api/products/bm9wZQ/metadata', { tags: ['x'] })).statusCode).toBe(404);
    expect((await post('/api/products/bm9wZQ/attributes', { attributes: {} })).statusCode).toBe(404);
    expect((await del('/api/products/bm9wZQ/attributes')).statusCode).toBe(404);
    expect((await get(`/api/products/${id}/history`)).statusCode).toBe(200);
    expect((await get('/api/products/bm9wZQ/history')).statusCode).toBe(404);

    await post(`/api/products/${id}/attributes`, { attributes: { customLabel0: 'x' } });
    const cleared = await del(`/api/products/${id}/attributes`);
    expect(cleared.json().attributes).toEqual({});

    const ids = (await get('/api/products?limit=3')).json().items.map((p: { productId: string }) => p.productId);
    const bulk = await post('/api/products/bulk', { productIds: [...ids, 'bm9wZQ'], addTags: ['bulk'], removeTags: ['none'], attributes: { customLabel1: 'b' } });
    expect(bulk.json().ok).toBe(3);
    expect(bulk.json().failed).toBe(1);
    expect((await get('/api/products?tag=bulk')).json().total).toBe(3);
    const tagsOnly = await post('/api/products/bulk', { productIds: ids, removeTags: ['bulk'] });
    expect(tagsOnly.json().ok).toBe(3);
  });
});

describe('issue routes', () => {
  it('lists open/resolved, summary, account issues and rendered issues', async () => {
    expect((await get('/api/issues?level=error,warning&code=missing_gtin&reportingContext=SHOPPING_ADS')).statusCode).toBe(200);
    expect((await get('/api/issues?resolvedSince=lastLogin')).statusCode).toBe(200);
    expect((await get('/api/issues?open=false&since=2020-01-01T00:00:00.000Z')).json().total).toBeGreaterThan(0);
    expect((await get('/api/issues/summary')).json().codes.length).toBeGreaterThan(0);
    expect((await get('/api/issues/account')).json().issues.length).toBe(2);
    expect((await get('/api/issues/account/rendered')).json().issues.length).toBe(2);
  });
});

describe('feed routes', () => {
  it('get / patch / fetch / latest upload / delete and enrichment status', async () => {
    expect((await get('/api/feeds/101')).json().displayName).toContain('PL');
    expect((await patch('/api/feeds/101', { displayName: 'Renamed', fetch: { hour: 7, minute: 15, frequency: 'FREQUENCY_MONTHLY', dayOfMonth: 3, timeZone: 'UTC', username: 'u', password: 'p', enabled: true } })).json().fetchSchedule).toContain('monthly');
    expect((await patch('/api/feeds/101', { fetch: { frequency: 'FREQUENCY_WEEKLY', dayOfWeek: 'FRIDAY' } })).json().fetchSchedule).toContain('FRIDAY');
    expect((await patch('/api/feeds/101', {})).statusCode).toBe(200);
    expect((await post('/api/feeds/101/fetch')).statusCode).toBe(200);
    expect((await post('/api/feeds/103/fetch')).statusCode).toBe(400); // API source cannot be fetched
    expect((await get('/api/feeds/101/latest-upload')).json().upload.processingState).toBe('SUCCEEDED');
    expect((await get('/api/feeds/103/latest-upload')).json().upload).toBeNull();
    expect((await get('/api/feeds/enrichment/status')).json().dataSource).toBeNull();
    expect((await post('/api/feeds/enrichment/ensure')).json().dataSource.displayName).toBe('GMC Manager enrichment');
    const created = await post('/api/feeds', { displayName: 'Supp', kind: 'supplemental', feedLabel: 'PL', contentLanguage: 'pl' });
    expect(created.json().kind).toBe('supplemental');
    const sheet = await post('/api/feeds', { displayName: 'Sheet', feedLabel: 'DE', contentLanguage: 'de', file: { type: 'GOOGLE_SHEETS', fetchUri: 'https://docs.google.com/x', frequency: 'FREQUENCY_MONTHLY', dayOfMonth: 2, fileName: 'f' } });
    expect(sheet.statusCode).toBe(201);
    const noLabel = await post('/api/feeds', { displayName: 'Bad', file: { type: 'FETCH', fetchUri: 'https://x.example/f' } });
    expect(noLabel.statusCode).toBe(500);
    expect((await del(`/api/feeds/${created.json().id}`)).statusCode).toBe(200);
    expect((await get('/api/feeds/does-not-exist')).statusCode).toBe(404);
  });
});

describe('account routes', () => {
  it('overview, shipping settings and return policy CRUD', async () => {
    const overview = await get('/api/account');
    expect(overview.json().health).toBe('error');
    expect((await get('/api/account/shipping-settings')).json().shippingSettings.services.length).toBe(2);
    expect((await get('/api/account/return-policies')).json().policies.length).toBe(1);
    const created = await post('/api/account/return-policies', { label: 'New', countries: ['PL'] });
    expect(created.statusCode).toBe(201);
    const id = created.json().returnPolicyId;
    expect((await put(`/api/account/return-policies/${id}`, { label: 'Updated' })).json().label).toBe('Updated');
    expect((await del(`/api/account/return-policies/${id}`)).statusCode).toBe(200);
    expect((await del(`/api/account/return-policies/${id}`)).statusCode).toBe(404);
  });
});

describe('notification routes', () => {
  it('subscribe, list, unsubscribe, simulate and Pub/Sub style envelopes', async () => {
    const list = await get('/api/notifications/subscriptions');
    expect(list.json().callbackUrl).toContain('https://gmc.example.com/api/webhooks/merchant/');
    const sub = await post('/api/notifications/subscriptions');
    expect(sub.statusCode).toBe(201);
    expect(sub.json().ownedByThisApp).toBe(true);
    const again = await post('/api/notifications/subscriptions');
    expect(again.json().id).toBe(sub.json().id);
    expect((await get('/api/notifications/subscriptions')).json().subscriptions.length).toBe(1);
    const name = (await get('/api/products?limit=1')).json().items[0].name as string;
    expect((await post('/api/notifications/simulate', { resource: name, resourceId: 'x', changes: [] })).statusCode).toBe(200);
    const envelope = Buffer.from(JSON.stringify({ resource: name, changes: [{ newValue: 'DISAPPROVED' }] })).toString('base64');
    const secret = ctx.settings.current().webhookSecret;
    expect((await app.inject({ method: 'POST', url: `/api/webhooks/merchant/${secret}`, payload: { message: { data: envelope } } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/webhooks/merchant/${secret}`, payload: { message: { data: 'not-json' } } })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.events.list({ type: 'notification.received' }).total).toBe(2);
    expect((await del(`/api/notifications/subscriptions/${sub.json().id}`)).statusCode).toBe(200);
    expect((await del(`/api/notifications/subscriptions/${sub.json().id}`)).statusCode).toBe(404);
  });

  it('refuses to subscribe without a public URL', async () => {
    ctx.settings.update({ publicUrl: null });
    expect((await post('/api/notifications/subscriptions')).statusCode).toBe(500);
    expect((await get('/api/notifications/subscriptions')).json().callbackUrl).toBeNull();
  });
});

describe('system routes', () => {
  it('sync, events, settings, users and mock helpers', async () => {
    expect((await post('/api/sync')).json().started).toBe(true);
    const status = await get('/api/sync/status');
    expect(status.json().runs.length).toBeGreaterThan(0);
    expect((await get('/api/events?since=lastLogin&type=sync.completed&severity=info&limit=5')).statusCode).toBe(200);
    expect((await get('/api/events?types=issue.new,issue.resolved')).statusCode).toBe(200);
    const settings = await get('/api/settings');
    expect(settings.json().mock).toBe(true);
    expect((await get('/api/settings/quota')).json().groups.length).toBe(3);
    const user = await post('/api/settings/users', { username: 'second', password: 'password2' });
    expect(user.statusCode).toBe(201);
    expect((await post('/api/settings/users', { username: 'second', password: 'password2' })).statusCode).toBe(409);
    expect((await del(`/api/settings/users/${user.json().id}`)).statusCode).toBe(200);
    expect((await del('/api/settings/users/1')).statusCode).toBe(400);
    const changes = await post('/api/dev/mock/simulate-changes');
    expect(changes.json()).toHaveProperty('added');
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().ok).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/some/page' })).statusCode).toBe(200);
  });
});

describe('workflow routes', () => {
  it('catalog, validate, update, delete, runs and preview', async () => {
    const catalog = await get('/api/workflows/catalog');
    expect(catalog.json().templates.length).toBeGreaterThan(0);
    expect((await post('/api/workflows/validate', { name: 'v', trigger: { type: 'schedule', cron: '0 6 * * *' }, steps: [{ type: 'sync' }] })).json().nextRun).toBeTruthy();
    expect((await post('/api/workflows/validate', { name: 'v', trigger: { type: 'schedule', cron: 'bad cron expr' }, steps: [{ type: 'sync' }] })).statusCode).toBe(400);
    const wf = await post('/api/workflows', { name: 'w', trigger: { type: 'manual' }, steps: [{ type: 'select_products', filter: { limit: 2 } }, { type: 'filter', condition: { field: 'status', op: 'exists' } }, { type: 'limit', max: 1 }, { type: 'log', message: 'hi' }] });
    expect(wf.statusCode).toBe(201);
    const id = wf.json().id;
    expect((await get(`/api/workflows/${id}`)).json().name).toBe('w');
    expect((await get('/api/workflows/999')).statusCode).toBe(404);
    expect((await put(`/api/workflows/${id}`, { name: 'w2', trigger: { type: 'schedule', cron: '0 7 * * *' } })).json().name).toBe('w2');
    expect((await put(`/api/workflows/${id}`, { trigger: { type: 'schedule', cron: '99 99 * * *' } })).statusCode).toBe(400);
    expect((await put('/api/workflows/999', { name: 'x' })).statusCode).toBe(404);
    const preview = await post('/api/workflows/preview', wf.json());
    expect(preview.json().count).toBe(1);
    expect(preview.json().skippedSteps).toEqual(['log']);
    expect((await post(`/api/workflows/${id}/run`)).json().started).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect((await get(`/api/workflows/${id}/runs`)).json().runs.length).toBe(1);
    const runId = (await get('/api/workflow-runs')).json().runs[0].id;
    expect((await get(`/api/workflow-runs/${runId}`)).json().status).toBe('success');
    expect((await get('/api/workflow-runs/999')).statusCode).toBe(404);
    expect((await post('/api/workflows/999/run')).statusCode).toBe(404);
    expect((await del(`/api/workflows/${id}`)).statusCode).toBe(200);
    expect((await del(`/api/workflows/${id}`)).statusCode).toBe(404);
  });
});

describe('dashboard', () => {
  it('reflects sync failures and feed problems', async () => {
    ctx.db.run("INSERT INTO sync_runs (kind, status, started_at, finished_at, error) VALUES ('full', 'failed', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:01.000Z', 'boom')");
    const dash = await get('/api/dashboard');
    expect(dash.json().flags.some((f: { message: string }) => f.message.includes('Last sync failed'))).toBe(true);
    expect(dash.json().health).toBe('error');
    expect(mock.productIds().length).toBe(30);
  });
});
