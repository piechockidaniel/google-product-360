import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/http/server.js';
import { silentLogger } from '../src/util/logger.js';
import { AllegroService } from '../src/services/allegro-service.js';

let ctx: AppContext;
let app: FastifyInstance;
let cookie: string;
let calls: { url: string; body: string; authorization: string | null; method: string }[];
let expiresIn: number;
let failOffers: boolean;
let fetchMock: typeof fetch;
let patchResult: 'accepted' | 'timeout' | 'bad-location';
let currentPrice: string;

beforeEach(async () => {
  calls = []; expiresIn = 3600; failOffers = false; patchResult = 'accepted'; currentPrice = '99';
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input); const body = String(init?.body ?? '');
    calls.push({ url, body, authorization: new Headers(init?.headers).get('authorization'), method: init?.method ?? 'GET' });
    if (url.endsWith('/token')) return Response.json({ access_token: body.includes('refresh_token') ? 'access-refreshed' : 'access-original', refresh_token: body.includes('refresh_token') ? 'refresh-rotated' : 'refresh-original', expires_in: expiresIn });
    if (url.endsWith('/me')) return Response.json({ id: 'seller-1', login: 'demo-seller' });
    if (url.includes('/sale/product-offers/') && init?.method === 'PATCH') {
      if (patchResult === 'timeout') throw new Error('timeout');
      return new Response(null, { status: 202, headers: { location: patchResult === 'bad-location' ? 'https://attacker.example/operations/1' : '/sale/product-offers/offer-1/operations/operation-1' } });
    }
    if (url.endsWith('/operations/operation-1')) return new Response(null, { status: 303 });
    if (url.includes('/sale/product-offers/')) return Response.json({ id: 'offer-1', category: { id: 'category-1' }, description: { sections: [] }, images: ['https://example.test/image.jpg'], sellingMode: { format: 'BUY_NOW', price: { amount: currentPrice, currency: 'PLN' } }, stock: { available: 7 }, publication: { status: 'ACTIVE' }, productSet: [{ product: { id: 'product-id' } }] });
    if (url.includes('/sale/offers?')) return failOffers ? new Response('', { status: 500 }) : Response.json({ offers: [{ id: 'offer-1', name: 'Example' }], totalCount: 1 });
    return new Response('', { status: 404 });
  };
  fetchMock = fakeFetch;
  const config = loadConfig({ NODE_ENV: 'test', MERCHANT_MOCK: 'true', DATABASE_PATH: ':memory:', ADMIN_PASSWORD: 'admin12345', SESSION_SECRET: 'test-secret-test-secret-test', SYNC_INTERVAL_MINUTES: '0', SYNC_ON_STARTUP: 'false', LOG_LEVEL: 'silent' });
  ctx = buildApp(config, silentLogger, { fetchImpl: fakeFetch });
  app = await createServer(ctx);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin12345' } });
  cookie = login.headers['set-cookie'] as string;
});
afterEach(async () => { await app.close(); await ctx.stop(); });

async function connect(enableOfferWrites = false) {
  const configured = await app.inject({ method: 'PUT', url: '/api/allegro/config', headers: { cookie }, payload: { environment: 'sandbox', clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://localhost:8080/api/allegro/callback', enableOfferWrites } });
  expect(configured.statusCode).toBe(200);
  const start = await app.inject({ method: 'POST', url: '/api/allegro/authorize', headers: { cookie }, payload: { environment: 'sandbox' } });
  const url = new URL(start.json().url);
  expect(url.hostname).toBe('allegro.pl.allegrosandbox.pl');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('scope')).toContain('allegro:api:sale:offers:read');
  expect(url.searchParams.get('scope')?.includes('allegro:api:sale:offers:write')).toBe(enableOfferWrites);
  const state = url.searchParams.get('state')!;
  const callback = await app.inject({ method: 'GET', url: `/api/allegro/callback?state=${state}&code=one-time-code`, headers: { cookie } });
  expect(callback.headers.location).toBe('/allegro?connection=success&environment=sandbox');
  return state;
}

describe('Allegro seller connection', () => {
  it('checks the current price, sends one sandbox change and verifies the asynchronous result', async () => {
    await connect(true);
    const operationId = '7b3a4fb9-7466-4cf2-920e-b439376a0e53';
    const action = { type: 'price', amount: '105.00', currency: 'PLN', expectedAmount: '99', expectedCurrency: 'PLN' };
    const send = () => app.inject({ method: 'POST', url: '/api/allegro/offers/offer-1/operations', headers: { cookie }, payload: { environment: 'sandbox', operationId, action } });
    expect((await send()).json().status).toBe('pending');
    expect((await send()).json().status).toBe('pending');
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    const conflict = await app.inject({ method: 'POST', url: '/api/allegro/offers/offer-1/operations', headers: { cookie }, payload: { environment: 'sandbox', operationId, action: { ...action, amount: '106' } } });
    expect(conflict.statusCode).toBe(409);
    currentPrice = '105';
    const check = await app.inject({ method: 'POST', url: `/api/allegro/operations/${operationId}/check`, headers: { cookie }, payload: { environment: 'sandbox' } });
    expect(check.json().status).toBe('succeeded');
    expect(ctx.db.all('SELECT * FROM allegro_offer_operations')).toHaveLength(1);
  });

  it('does not send stale changes or production writes and preserves unknown outcomes', async () => {
    await connect(true);
    const action = { type: 'price', amount: '105', currency: 'PLN', expectedAmount: '98', expectedCurrency: 'PLN' };
    const operationId = '7b3a4fb9-7466-4cf2-920e-b439376a0e53';
    const submit = (environment: string, value = action) => app.inject({ method: 'POST', url: '/api/allegro/offers/offer-1/operations', headers: { cookie }, payload: { environment, operationId, action: value } });
    expect((await submit('sandbox')).statusCode).toBe(409);
    expect((await submit('production')).statusCode).toBe(403);
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    patchResult = 'timeout';
    expect((await submit('sandbox', { ...action, expectedAmount: '99' })).json().status).toBe('uncertain');
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('does not follow an untrusted operation location and recovers interrupted sends', async () => {
    await connect(true); patchResult = 'bad-location';
    const operationId = '7b3a4fb9-7466-4cf2-920e-b439376a0e53';
    const response = await app.inject({ method: 'POST', url: '/api/allegro/offers/offer-1/operations', headers: { cookie }, payload: { environment: 'sandbox', operationId, action: { type: 'stock', quantity: 4, expectedQuantity: 7 } } });
    expect(response.json().status).toBe('uncertain');
    expect(response.json().operationPath).toBeNull();
    ctx.db.run("UPDATE allegro_offer_operations SET status = 'sending', updated_at = ? WHERE id = ?", ['2000-01-01T00:00:00.000Z', operationId]);
    expect(ctx.allegro.operations('sandbox')[0]?.status).toBe('uncertain');
    expect(calls.some((call) => call.url.includes('attacker.example'))).toBe(false);
  });
  it('binds one-time OAuth state to the session, encrypts secrets, and isolates environments', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/allegro/status' })).statusCode).toBe(401);
    const state = await connect();
    const again = await app.inject({ method: 'GET', url: `/api/allegro/callback?state=${state}&code=one-time-code`, headers: { cookie } });
    expect(again.headers.location).toBe('/allegro?connection=failed');
    const status = await app.inject({ method: 'GET', url: '/api/allegro/status?environment=sandbox', headers: { cookie } });
    expect(status.json()).toMatchObject({ connected: true, sellerId: 'seller-1', sellerLogin: 'demo-seller' });
    expect(status.body).not.toContain('client-secret');
    expect(status.body).not.toContain('access-original');
    const row = ctx.db.get<{ client_secret: string; tokens: string }>('SELECT client_secret, tokens FROM allegro_connections WHERE environment = ?', ['sandbox'])!;
    expect(row.client_secret).toMatch(/^v1:/);
    expect(row.tokens).toMatch(/^v1:/);
    expect(row.tokens).not.toContain('refresh-original');
    expect(ctx.allegro.status('production').configured).toBe(false);
    const exchange = calls.find((call) => call.url.endsWith('/token'))!;
    expect(exchange.body).toContain('code_verifier=');
    expect(exchange.authorization).toBeNull();
    expect(exchange.url).not.toContain('one-time-code');
    expect((await app.inject({ method: 'POST', url: '/api/allegro/sync', headers: { cookie }, payload: { environment: 'sandbox' } })).statusCode).toBe(200);
    const offers = await app.inject({ method: 'GET', url: '/api/allegro/offers?environment=sandbox', headers: { cookie } });
    expect(offers.json()).toMatchObject({ total: 1, offers: [{ id: 'offer-1' }] });
    expect(calls.find((call) => call.url.includes('/sale/offers?'))?.authorization).toBe('Bearer access-original');
  });

  it('refreshes expired access once for concurrent requests and persists the rotated token', async () => {
    expiresIn = 1;
    await connect();
    expiresIn = 3600;
    const [first, second] = await Promise.all([ctx.allegro.testConnection('sandbox'), ctx.allegro.testConnection('sandbox')]);
    expect(first.ok).toBe(true); expect(second.ok).toBe(true);
    const refreshes = calls.filter((call) => call.body.includes('grant_type=refresh_token'));
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.authorization).toMatch(/^Basic /);
    await ctx.allegro.testConnection('sandbox');
    expect(calls.filter((call) => call.body.includes('grant_type=refresh_token'))).toHaveLength(1);
  });

  it('coordinates token rotation across service instances sharing a database', async () => {
    expiresIn = 1;
    await connect();
    expiresIn = 3600;
    const other = new AllegroService(ctx.db, ctx.config.SESSION_SECRET, ctx.events, ctx.woocommerce, fetchMock);
    await Promise.all([ctx.allegro.testConnection('sandbox'), other.testConnection('sandbox')]);
    expect(calls.filter((call) => call.body.includes('grant_type=refresh_token'))).toHaveLength(1);
    expect(ctx.db.all('SELECT * FROM allegro_refresh_leases')).toHaveLength(0);
  });

  it('rejects unsafe callback URLs and configuration changes without a new secret', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/allegro/config', headers: { cookie }, payload: { environment: 'sandbox', clientId: 'a', clientSecret: 'b', redirectUri: 'http://remote.example/api/allegro/callback' } });
    expect(bad.statusCode).toBe(400);
    await connect();
    const changed = await app.inject({ method: 'PUT', url: '/api/allegro/config', headers: { cookie }, payload: { environment: 'sandbox', clientId: 'another', redirectUri: 'http://localhost:8080/api/allegro/callback' } });
    expect(changed.statusCode).toBe(400);
    expect(ctx.allegro.status('sandbox').connected).toBe(true);
  });

  it('rejects a callback from a different session without consuming the valid state', async () => {
    await app.inject({ method: 'PUT', url: '/api/allegro/config', headers: { cookie }, payload: { environment: 'sandbox', clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://localhost:8080/api/allegro/callback' } });
    const start = await app.inject({ method: 'POST', url: '/api/allegro/authorize', headers: { cookie }, payload: { environment: 'sandbox' } });
    const state = new URL(start.json().url).searchParams.get('state');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin12345' } });
    const otherCookie = login.headers['set-cookie'] as string;
    const wrong = await app.inject({ method: 'GET', url: `/api/allegro/callback?state=${state}&code=code`, headers: { cookie: otherCookie } });
    expect(wrong.headers.location).toBe('/allegro?connection=failed');
    const right = await app.inject({ method: 'GET', url: `/api/allegro/callback?state=${state}&code=code`, headers: { cookie } });
    expect(right.headers.location).toBe('/allegro?connection=success&environment=sandbox');
  });

  it('filters and sorts the entire offer snapshot and preserves it when the remote sync fails', async () => {
    await connect();
    await ctx.allegro.syncOffers('sandbox');
    for (let i = 1; i <= 30; i++) {
      ctx.db.run('INSERT INTO allegro_offers (environment, seller_id, offer_id, data) VALUES (?, ?, ?, ?)', ['sandbox', 'seller-1', `id-${i}`, JSON.stringify({ id: `id-${i}`, name: `Example ${i}`, publication: { status: i % 2 ? 'ACTIVE' : 'ENDED' }, stock: { available: i }, sellingMode: { price: { amount: String(i), currency: 'PLN' } } })]);
    }
    const result = await app.inject({ method: 'GET', url: '/api/allegro/offers?environment=sandbox&status=ENDED&orderBy=price&orderDir=desc&limit=5&offset=5', headers: { cookie } });
    expect(result.statusCode).toBe(200);
    expect(result.json().total).toBe(15);
    expect(result.json().offers.map((item: { id: string }) => item.id)).toEqual(['id-20', 'id-18', 'id-16', 'id-14', 'id-12']);
    failOffers = true;
    await expect(ctx.allegro.syncOffers('sandbox')).rejects.toThrow('Allegro request failed');
    expect((await app.inject({ method: 'GET', url: '/api/allegro/offers?environment=sandbox', headers: { cookie } })).json().total).toBe(31);
    expect(ctx.allegro.status('sandbox').offerCount).toBe(1);
  });

  it('creates seller-scoped local templates from selected fields and keeps revisions without copying offer identity or price', async () => {
    await connect();
    const preview = await app.inject({ method: 'GET', url: '/api/allegro/offers/offer-1/template-preview?environment=sandbox', headers: { cookie } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().fields).toEqual({ category: { id: 'category-1' }, description: { sections: [] }, images: ['https://example.test/image.jpg'], sellingMode: { format: 'BUY_NOW' } });
    const create = await app.inject({ method: 'POST', url: '/api/allegro/templates/from-offer', headers: { cookie }, payload: { environment: 'sandbox', offerId: 'offer-1', name: 'Toys', fields: ['category', 'sellingMode'] } });
    expect(create.statusCode).toBe(201);
    const template = create.json();
    expect(template.data).toEqual({ category: { id: 'category-1' }, sellingMode: { format: 'BUY_NOW' } });
    const update = await app.inject({ method: 'PUT', url: `/api/allegro/templates/${template.id}`, headers: { cookie }, payload: { environment: 'sandbox', version: 1, name: 'Toys v2', data: { category: { id: 'category-2' } } } });
    expect(update.json()).toMatchObject({ version: 2, name: 'Toys v2' });
    const stale = await app.inject({ method: 'PUT', url: `/api/allegro/templates/${template.id}`, headers: { cookie }, payload: { environment: 'sandbox', version: 1, name: 'Old edit', data: { category: {} } } });
    expect(stale.statusCode).toBe(409);
    const forbidden = await app.inject({ method: 'PUT', url: `/api/allegro/templates/${template.id}`, headers: { cookie }, payload: { environment: 'sandbox', version: 2, name: 'Invalid', data: { stock: { available: 100 } } } });
    expect(forbidden.statusCode).toBe(400);
    expect(ctx.db.all('SELECT version FROM allegro_offer_template_versions WHERE template_id = ? ORDER BY version', [template.id])).toHaveLength(2);
    ctx.settings.update({ wooStoreUrl: 'https://shop.example', wooConsumerKey: 'key', wooConsumerSecret: 'secret' });
    ctx.db.run('INSERT INTO woo_sync_state (id, store_url, synced_at, product_count, order_count) VALUES (1, ?, ?, ?, ?)', ['https://shop.example', new Date().toISOString(), 1, 0]);
    ctx.db.run('INSERT INTO woo_products (id, sku, data) VALUES (?, ?, ?)', [21, 'SKU-21', JSON.stringify({ id: 21, sku: 'SKU-21', name: 'Woo item', price: '8.00' })]);
    const draft = await app.inject({ method: 'POST', url: '/api/allegro/drafts', headers: { cookie }, payload: { environment: 'sandbox', templateId: template.id, wooId: 21, amount: '15.50', currency: 'PLN' } });
    expect(draft.statusCode).toBe(201);
    expect(draft.json()).toMatchObject({ wooId: 21, templateVersion: 2, data: { product: { sku: 'SKU-21', price: '8.00' }, price: { amount: '15.50', currency: 'PLN' }, template: { category: { id: 'category-2' } } } });
    const zero = await app.inject({ method: 'POST', url: '/api/allegro/drafts', headers: { cookie }, payload: { environment: 'sandbox', templateId: template.id, wooId: 21, amount: '0.00', currency: 'PLN' } });
    expect(zero.statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: `/api/allegro/templates/${template.id}`, headers: { cookie }, payload: { environment: 'sandbox', version: 2, name: 'Toys v3', data: { category: { id: 'category-3' } } } });
    const saved = (await app.inject({ method: 'GET', url: '/api/allegro/drafts?environment=sandbox', headers: { cookie } })).json().items[0];
    expect(saved).toMatchObject({ templateVersion: 2, data: { template: { category: { id: 'category-2' } } } });
    expect(calls.filter((call) => call.url.includes('/sale/product-offers/')).every((call) => !call.body)).toBe(true);
  });
});
