import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/http/server.js';
import { silentLogger } from '../src/util/logger.js';
import type { FastifyInstance } from 'fastify';

let ctx: AppContext;
let app: FastifyInstance;
let cookie: string;
let failOrders: boolean;
let timeoutProducts: boolean;
let hangProducts: boolean;
let requests: { url: string; authorization: string | null; redirect: RequestRedirect | undefined }[];

beforeEach(async () => {
  requests = [];
  failOrders = false;
  timeoutProducts = false;
  hangProducts = false;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url: url.toString(), authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    if (url.pathname.endsWith('/products') && timeoutProducts) throw new DOMException('timed out', 'TimeoutError');
    if (url.pathname.endsWith('/products') && hangProducts) return new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
      else init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    if (url.pathname.endsWith('/orders') && failOrders) return new Response('', { status: 500 });
    let data: unknown[] = [];
    let totalPages = '1';
    if (url.pathname.endsWith('/products')) {
      totalPages = '2';
      data = url.searchParams.get('page') === '1' ? [{ id: 1, type: 'variable', sku: 'parent' }] : [{ id: 2, type: 'simple', sku: 'simple' }];
    } else if (url.pathname.endsWith('/variations')) data = [{ id: 3, sku: 'variant', price: '10.00' }];
    else if (url.pathname.endsWith('/orders')) data = [{ id: 41, total: '10.00', currency: 'PLN', billing: { email: 'private@example.com' }, line_items: [{ id: 4, product_id: 1, variation_id: 3, quantity: 1, total: '10.00', meta_data: [{ value: 'private' }] }] }];
    return new Response(JSON.stringify(data), { status: 200, headers: { 'x-wp-totalpages': totalPages, 'content-type': 'application/json' } });
  };
  const config = loadConfig({ NODE_ENV: 'test', MERCHANT_MOCK: 'true', DATABASE_PATH: ':memory:', ADMIN_PASSWORD: 'admin12345', SESSION_SECRET: 'test-secret-test-secret-test', SYNC_INTERVAL_MINUTES: '0', SYNC_ON_STARTUP: 'false', LOG_LEVEL: 'silent' });
  ctx = buildApp(config, silentLogger, { fetchImpl: fakeFetch });
  app = await createServer(ctx);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin12345' } });
  cookie = login.headers['set-cookie'] as string;
});
afterEach(async () => { await app.close(); await ctx.stop(); });

describe('WooCommerce connection', () => {
  it('requires a session, encrypts and conceals credentials, and rejects insecure URLs', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/woocommerce/orders' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/woocommerce/config', headers: { cookie }, payload: { storeUrl: 'http://shop.example', consumerKey: 'ck_test', consumerSecret: 'cs_test' } })).statusCode).toBe(400);
    const saved = await app.inject({ method: 'PUT', url: '/api/woocommerce/config', headers: { cookie }, payload: { storeUrl: 'https://shop.example', consumerKey: 'ck_test', consumerSecret: 'cs_test' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('ck_test');
    const publicSettings = await app.inject({ method: 'GET', url: '/api/setup/config', headers: { cookie } });
    expect(publicSettings.body).not.toContain('ck_test');
    expect(publicSettings.body).not.toContain('cs_test');
    const stored = ctx.db.all<{ value: string }>("SELECT value FROM settings WHERE key IN ('merchant.wooConsumerKey', 'merchant.wooConsumerSecret')");
    expect(stored.every((row) => row.value.startsWith('enc:v1:'))).toBe(true);
    const change = await app.inject({ method: 'PUT', url: '/api/woocommerce/config', headers: { cookie }, payload: { storeUrl: 'https://other.example' } });
    expect(change.statusCode).toBe(400);
  });

  it('uses a single item for connection checks and reports which sync page times out', async () => {
    ctx.settings.update({ wooStoreUrl: 'https://shop.example', wooConsumerKey: 'ck_test', wooConsumerSecret: 'cs_test' });
    expect((await app.inject({ method: 'POST', url: '/api/woocommerce/test', headers: { cookie } })).statusCode).toBe(200);
    expect(requests.every((r) => new URL(r.url).searchParams.get('per_page') === '1')).toBe(true);
    timeoutProducts = true;
    const response = await app.inject({ method: 'POST', url: '/api/woocommerce/sync', headers: { cookie } });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toContain('products page 1 timed out after 60 seconds');
    expect(ctx.events.list({ type: 'woocommerce.sync_failed', limit: 1 }).items[0]?.message).toContain('products page 1 timed out');
  });

  it('reports active progress, cancels a pending request, and retains the previous snapshot', async () => {
    ctx.settings.update({ wooStoreUrl: 'https://shop.example', wooConsumerKey: 'ck_test', wooConsumerSecret: 'cs_test' });
    await ctx.woocommerce.sync();
    hangProducts = true;
    const running = ctx.woocommerce.sync();
    const status = await app.inject({ method: 'GET', url: '/api/woocommerce/status', headers: { cookie } });
    expect(status.json()).toMatchObject({ running: true, progress: { stage: 'products', page: 1, products: 0 }, lastRun: { status: 'running' }, products: 3 });
    const cancelled = await app.inject({ method: 'POST', url: '/api/woocommerce/cancel', headers: { cookie } });
    expect(cancelled.json()).toEqual({ cancelled: true });
    await expect(running).rejects.toThrow('WooCommerce synchronization cancelled');
    expect(ctx.woocommerce.status()).toMatchObject({ running: false, progress: null, lastError: 'WooCommerce synchronization cancelled', lastRun: { status: 'cancelled' }, products: 3, orders: 1 });
    expect(ctx.woocommerce.cancel()).toBe(false);
  });

  it('marks abandoned runs interrupted without disturbing a recent run or the completed snapshot', async () => {
    ctx.settings.update({ wooStoreUrl: 'https://shop.example', wooConsumerKey: 'ck_test', wooConsumerSecret: 'cs_test' });
    await ctx.woocommerce.sync();
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const recent = new Date().toISOString();
    ctx.db.run('INSERT INTO woo_sync_runs (store_url, status, started_at, heartbeat_at, progress) VALUES (?, ?, ?, ?, ?)', ['https://old.example', 'running', old, old, '{}']);
    ctx.db.run('INSERT INTO woo_sync_runs (store_url, status, started_at, heartbeat_at, progress) VALUES (?, ?, ?, ?, ?)', ['https://other.example', 'running', recent, recent, '{}']);
    ctx.woocommerce.failStaleRuns();
    expect(ctx.db.get<{ status: string }>('SELECT status FROM woo_sync_runs WHERE store_url = ?', ['https://old.example'])?.status).toBe('interrupted');
    expect(ctx.db.get<{ status: string }>('SELECT status FROM woo_sync_runs WHERE store_url = ?', ['https://other.example'])?.status).toBe('running');
    expect(ctx.woocommerce.status()).toMatchObject({ products: 3, orders: 1, lastRun: { status: 'success' } });
  });

  it('fetches every product page, variations and orders and preserves the last good snapshot on failure', async () => {
    ctx.settings.update({ wooStoreUrl: 'https://shop.example', wooConsumerKey: 'ck_test', wooConsumerSecret: 'cs_test' });
    const response = await app.inject({ method: 'POST', url: '/api/woocommerce/sync', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ products: 3, orders: 1 });
    expect(requests.some((r) => r.url.includes('page=2'))).toBe(true);
    expect(requests.every((r) => r.authorization?.startsWith('Basic ') && r.redirect === 'error' && !r.url.includes('ck_test'))).toBe(true);
    const products = await app.inject({ method: 'GET', url: '/api/woocommerce/products', headers: { cookie } });
    expect(products.json().items).toContainEqual(expect.objectContaining({ id: 3, parent_id: 1, sku: 'variant' }));
    const orders = await app.inject({ method: 'GET', url: '/api/woocommerce/orders', headers: { cookie } });
    expect(orders.json().total).toBe(1);
    expect(orders.body).not.toContain('private');
    failOrders = true;
    expect((await app.inject({ method: 'POST', url: '/api/woocommerce/sync', headers: { cookie } })).statusCode).toBe(500);
    expect((await app.inject({ method: 'GET', url: '/api/woocommerce/products', headers: { cookie } })).json().total).toBe(3);
  });

  it('reports exact matches and ambiguous or missing identities without merging products', async () => {
    ctx.settings.update({ wooStoreUrl: 'https://shop.example', wooConsumerKey: 'ck_test', wooConsumerSecret: 'cs_test' });
    await ctx.woocommerce.sync();
    ctx.db.run('DELETE FROM woo_products');
    const addWoo = (id: number, sku: string) => ctx.db.run('INSERT INTO woo_products (id, sku, data) VALUES (?, ?, ?)', [id, sku, JSON.stringify({ id, sku, name: `Woo ${id}` })]);
    addWoo(10, 'exact'); addWoo(11, 'duplicate-woo'); addWoo(12, 'duplicate-woo'); addWoo(13, 'duplicate-google'); addWoo(14, 'unknown'); addWoo(15, '');
    const addGoogle = (id: string, offerId: string) => ctx.products.upsertProduct({ name: `accounts/123/products/${id}`, offerId, productAttributes: { title: `Google ${id}` } });
    addGoogle('a', 'exact'); addGoogle('b', 'duplicate-google'); addGoogle('c', 'duplicate-google'); addGoogle('d', 'google-only');
    const res = await app.inject({ method: 'GET', url: '/api/woocommerce/reconciliation?limit=10', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toEqual({ matched: 1, ambiguous: 3, unmatched: 1, no_sku: 1, merchantOnly: 1 });
    expect(res.json().items.find((item: { wooId: number }) => item.wooId === 10)).toMatchObject({ status: 'matched', candidates: [{ offerId: 'exact' }] });
    expect(res.json().items.find((item: { wooId: number }) => item.wooId === 13).candidates).toHaveLength(2);
    const filtered = await app.inject({ method: 'GET', url: '/api/woocommerce/reconciliation?status=ambiguous&limit=1&offset=1', headers: { cookie } });
    expect(filtered.json()).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(filtered.json().items).toHaveLength(1);
    expect(ctx.products.getRawProduct('accounts/123/products/a')?.productAttributes?.title).toBe('Google a');
    ctx.settings.update({ wooStoreUrl: 'https://other.example' });
    expect(ctx.woocommerce.reconciliation('all', 50, 0)).toMatchObject({ items: [], syncedAt: null });
  });

  it('sorts and filters the complete WooCommerce product and order snapshots before paging', async () => {
    ctx.settings.update({ wooStoreUrl: 'https://shop.example', wooConsumerKey: 'ck_test', wooConsumerSecret: 'cs_test' });
    await ctx.woocommerce.sync();
    ctx.db.run('DELETE FROM woo_products');
    ctx.db.run('DELETE FROM woo_orders');
    for (let id = 1; id <= 60; id++) {
      const sku = `sku-${String(id).padStart(3, '0')}`;
      ctx.db.run('INSERT INTO woo_products (id, sku, data) VALUES (?, ?, ?)', [id, sku, JSON.stringify({ id, sku, name: `Product ${id}`, price: String(id), stock_status: id % 2 ? 'instock' : 'outofstock' })]);
      ctx.db.run('INSERT INTO woo_orders (id, data) VALUES (?, ?)', [id, JSON.stringify({ id, number: String(id), status: id % 2 ? 'processing' : 'completed', total: String(id), currency: 'PLN', date_created_gmt: '2026-01-01', line_items: [{ name: id === 60 ? 'special item' : 'regular item' }] })]);
    }
    const matches = await app.inject({ method: 'GET', url: '/api/woocommerce/reconciliation?orderBy=price&orderDir=desc&limit=10&offset=10&stockStatus=instock', headers: { cookie } });
    expect(matches.statusCode).toBe(200);
    expect(matches.json().total).toBe(30);
    expect(matches.json().items.map((item: { wooId: number }) => item.wooId)).toEqual([39, 37, 35, 33, 31, 29, 27, 25, 23, 21]);
    const matchName = await app.inject({ method: 'GET', url: '/api/woocommerce/reconciliation?sku=sku-060', headers: { cookie } });
    expect(matchName.json().items.map((item: { wooId: number }) => item.wooId)).toEqual([60]);
    const orderPage = await app.inject({ method: 'GET', url: '/api/woocommerce/orders?orderBy=total&orderDir=desc&limit=5&offset=5&status=completed', headers: { cookie } });
    expect(orderPage.statusCode).toBe(200);
    expect(orderPage.json().total).toBe(30);
    expect(orderPage.json().items.map((item: { id: number }) => item.id)).toEqual([50, 48, 46, 44, 42]);
    const orderItem = await app.inject({ method: 'GET', url: '/api/woocommerce/orders?items=special', headers: { cookie } });
    expect(orderItem.json().items.map((item: { id: number }) => item.id)).toEqual([60]);
    const literal = await app.inject({ method: 'GET', url: '/api/woocommerce/orders?number=%25', headers: { cookie } });
    expect(literal.json().total).toBe(0);
    const invalid = await app.inject({ method: 'GET', url: '/api/woocommerce/orders?orderBy=invalid', headers: { cookie } });
    expect(invalid.statusCode).toBe(400);
  });

  it('persists confirmed identity mappings, supports multiple Google feeds, and rejects conflicting links', async () => {
    ctx.settings.update({ wooStoreUrl: 'https://shop.example', wooConsumerKey: 'ck_test', wooConsumerSecret: 'cs_test' });
    await ctx.woocommerce.sync();
    ctx.products.upsertProduct({ name: 'accounts/123/products/g1', offerId: 'parent', productAttributes: { title: 'First feed' } });
    ctx.products.upsertProduct({ name: 'accounts/123/products/g2', offerId: 'parent', productAttributes: { title: 'Second feed' } });
    const first = ctx.products.getProduct('accounts/123/products/g1')!.productId;
    const second = ctx.products.getProduct('accounts/123/products/g2')!.productId;
    const put = (wooId: number, productId: string) => app.inject({ method: 'PUT', url: '/api/woocommerce/mappings', headers: { cookie }, payload: { wooId, productId } });
    expect((await put(1, first)).json()).toMatchObject({ wooId: 1, created: true });
    expect((await put(1, first)).json()).toMatchObject({ created: false });
    const detail = await app.inject({ method: 'GET', url: `/api/products/${first}`, headers: { cookie } });
    expect(detail.json().woocommerce).toMatchObject({ wooId: 1, present: true, sku: 'parent' });
    expect((await put(2, first)).statusCode).toBe(409);
    expect((await put(1, second)).statusCode).toBe(200);
    ctx.db.run('UPDATE woo_products SET sku = ? WHERE id = ?', ['changed-sku', 1]);
    const row = ctx.woocommerce.reconciliation('all', 50, 0).items.find((item) => item.wooId === 1)!;
    expect(row.candidates).toHaveLength(2);
    expect(row.candidates.every((candidate) => candidate.mappedWooId === 1)).toBe(true);
    await ctx.woocommerce.sync();
    expect(ctx.woocommerce.reconciliation('all', 50, 0).items.find((item) => item.wooId === 1)!.candidates.every((candidate) => candidate.mappedWooId === 1)).toBe(true);
    const removed = await app.inject({ method: 'POST', url: '/api/woocommerce/mappings/remove', headers: { cookie }, payload: { wooId: 1, productId: first } });
    expect(removed.json()).toEqual({ removed: true });
    expect(ctx.events.list({ type: 'woocommerce.mapping_removed', limit: 10 }).items).toHaveLength(1);
    expect((await put(2, first)).statusCode).toBe(200);
  });
});
