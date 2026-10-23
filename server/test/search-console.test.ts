import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/http/server.js';
import { testContext } from './helpers.js';
import type { AppContext } from '../src/app.js';
import type { MockMerchantApi } from '../src/mock/mock-merchant-api.js';
import { MockSearchConsoleApi } from '../src/mock/mock-search-console.js';
import { SC_REQUESTS } from '../src/connectors/search-console.js';
import { SearchConsoleClient, encodeSiteUrl } from '../src/google/search-console-api.js';
import { RestClient, MerchantApiError } from '../src/google/rest-client.js';
import { canonicalizeUrl, siteHost, urlBelongsToSite } from '../src/util/urls.js';
import { addDays, isoDay } from '../src/util/dates.js';
import { silentLogger } from '../src/util/logger.js';

let ctx: AppContext;
let mock: MockMerchantApi;

beforeEach(() => {
  ({ ctx, mock } = testContext());
});
afterEach(async () => {
  await ctx.stop();
});

const enable = (patch: Record<string, unknown> = {}) => ctx.settings.update({ searchConsoleEnabled: true, searchConsoleSiteUrl: 'sc-domain:example-shop.pl', ...patch });
const scMock = () => ctx.searchConsoleApi() as MockSearchConsoleApi;

// ------------------------------------------------------------------ url helpers
describe('URL canonicalisation', () => {
  it('normalises host, tracking params, fragments, ports and trailing slashes', () => {
    expect(canonicalizeUrl('HTTPS://Shop.Example.com:443/p/sku-1/?utm_source=x&gclid=1#top')).toBe('https://shop.example.com/p/sku-1');
    expect(canonicalizeUrl('https://shop.example.com/p/sku-1?color=red&size=m')).toBe('https://shop.example.com/p/sku-1?color=red&size=m');
    expect(canonicalizeUrl('https://shop.example.com/p/sku-1?size=m&color=red')).toBe('https://shop.example.com/p/sku-1?color=red&size=m');
    expect(canonicalizeUrl('https://shop.example.com/')).toBe('https://shop.example.com/');
    expect(canonicalizeUrl('ftp://x/y')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
    expect(canonicalizeUrl(null)).toBeNull();
  });

  it('recognises domain and URL-prefix properties', () => {
    expect(siteHost('sc-domain:Example-Shop.pl')).toBe('example-shop.pl');
    expect(siteHost('https://www.example-shop.pl/')).toBe('www.example-shop.pl');
    expect(siteHost('nope')).toBeNull();
    expect(urlBelongsToSite('https://m.example-shop.pl/p/1', 'sc-domain:example-shop.pl')).toBe(true);
    expect(urlBelongsToSite('https://other.pl/p/1', 'sc-domain:example-shop.pl')).toBe(false);
    expect(urlBelongsToSite('https://www.example-shop.pl/p/1', 'https://www.example-shop.pl/')).toBe(true);
    expect(urlBelongsToSite('https://example-shop.pl/p/1', 'https://www.example-shop.pl/')).toBe(false);
    expect(urlBelongsToSite('x', 'https://www.example-shop.pl/')).toBe(false);
  });
});

// ------------------------------------------------------------------ REST client
describe('SearchConsoleClient', () => {
  it('encodes the site URL, pages through startRow and reports Google errors', async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/sites')) return new Response(JSON.stringify({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] }), { status: 200 });
      if (url.includes('forbidden')) return new Response(JSON.stringify({ error: { message: 'User does not have sufficient permission', status: 'PERMISSION_DENIED' } }), { status: 403 });
      const body = JSON.parse(String(init.body)) as { startRow?: number; rowLimit: number };
      const n = body.startRow === 0 ? body.rowLimit : 2; // first page full, second page short
      return new Response(JSON.stringify({ rows: Array.from({ length: n }, (_, i) => ({ keys: [`https://example.com/p/${(body.startRow ?? 0) + i}`], clicks: 1, impressions: 10, ctr: 0.1, position: 5 })) }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new SearchConsoleClient(new RestClient({ baseUrl: 'https://searchconsole.googleapis.com/webmasters/v3', tokenProvider: { getAccessToken: async () => 't' }, logger: silentLogger, fetchImpl }));
    expect(await client.listSites()).toEqual([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }]);
    expect(encodeSiteUrl('sc-domain:example.com')).toBe('sc-domain%3Aexample.com');
    expect(encodeSiteUrl('https://example.com/')).toBe('https%3A%2F%2Fexample.com%2F');

    const rows = await client.queryAll('sc-domain:example.com', { startDate: '2025-01-01', endDate: '2025-01-01', dimensions: ['page'], rowLimit: 3 });
    expect(rows).toHaveLength(5);
    expect(requests[1]!.url).toBe('https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
    expect((requests[1]!.body as { startRow: number }).startRow).toBe(0);
    expect((requests[2]!.body as { startRow: number }).startRow).toBe(3);
    await expect(client.query('forbidden', { startDate: '2025-01-01', endDate: '2025-01-01' })).rejects.toBeInstanceOf(MerchantApiError);
  });

  it('builds the request bodies', () => {
    const day = SC_REQUESTS.pagesForDay('2025-01-05', { countryFilter: 'pol', dataState: 'final' }, 'MERCHANT_LISTINGS');
    expect(day).toMatchObject({ startDate: '2025-01-05', endDate: '2025-01-05', dimensions: ['page'], type: 'web', dataState: 'final', rowLimit: 25000, startRow: 0 });
    expect(day.dimensionFilterGroups![0]!.filters).toEqual([
      { dimension: 'country', operator: 'equals', expression: 'pol' },
      { dimension: 'searchAppearance', operator: 'equals', expression: 'MERCHANT_LISTINGS' },
    ]);
    expect(SC_REQUESTS.pagesForDay('2025-01-05', { countryFilter: '', dataState: 'all' }).dimensionFilterGroups).toBeUndefined();
    const q = SC_REQUESTS.queriesForPage('https://x/p', '2025-01-01', '2025-01-28', { countryFilter: '' });
    expect(q.dimensions).toEqual(['query']);
    expect(q.dimensionFilterGroups![0]!.filters[0]).toEqual({ dimension: 'page', operator: 'equals', expression: 'https://x/p' });
  });
});

// ------------------------------------------------------------------ connector
describe('SearchConsoleConnector', () => {
  it('is off by default and configurable at runtime', async () => {
    expect(ctx.searchConsole.isConfigured()).toBe(false);
    expect(ctx.metricsSync.status().connectors.find((c) => c.id === 'search_console')!.configured).toBe(false);
    await ctx.sync.runFullSync('test');
    const result = await ctx.metricsSync.run('test');
    expect(result.runs.map((r) => r.connector)).toEqual(['merchant_reports']); // SC skipped
    enable();
    expect(ctx.searchConsole.isConfigured()).toBe(true);
    expect(ctx.metricsSync.status().connectors.find((c) => c.id === 'search_console')!.nextWindow!.to).toBe(addDays(isoDay(), -2)); // 2-day lag
  });

  it('tests the connection: property access, analytics probe and URL mapping', async () => {
    await ctx.sync.runFullSync('test');
    enable();
    const ok = await ctx.metricsSync.testConnection('search_console');
    expect(ok.ok).toBe(true);
    expect(ok.capabilities.map((c) => c.id)).toEqual(['property', 'search_analytics', 'url_mapping']);
    expect(ok.capabilities[2]!.message).toMatch(/30 of 30 products/);

    enable({ searchConsoleSiteUrl: 'https://not-shared.example/' });
    const missing = await ctx.metricsSync.testConnection('search_console');
    expect(missing.ok).toBe(false);
    expect(missing.hint).toBe('sc_property_missing');

    enable({ searchConsoleSiteUrl: 'https://example-shop.pl/' });
    scMock().sites[1]!.permissionLevel = 'siteUnverifiedUser';
    const unverified = await ctx.metricsSync.testConnection('search_console');
    expect(unverified.hint).toBe('sc_property_unverified');

    scMock().failWith = new MerchantApiError('forbidden', 403, 'PERMISSION_DENIED');
    const forbidden = await ctx.metricsSync.testConnection('search_console');
    expect(forbidden.ok).toBe(false);
    expect(forbidden.hint).toBe('sc_forbidden');
    scMock().failWith = null;

    // Products whose links point to another host are counted, not mapped.
    scMock().sites.push({ siteUrl: 'sc-domain:other-host.example', permissionLevel: 'siteFullUser' });
    enable({ searchConsoleSiteUrl: 'sc-domain:other-host.example' });
    const nomap = await ctx.metricsSync.testConnection('search_console');
    expect(nomap.hint).toBe('sc_no_mapping');
    expect(nomap.capabilities[2]!.message).toMatch(/0 of 30 products/);
  });

  it('pulls page rows per day, maps them to products and feeds the signals', async () => {
    await ctx.sync.runFullSync('test');
    enable({ metricsBackfillDays: 30 });
    const result = await ctx.metricsSync.run('test');
    const sc = result.runs.find((r) => r.connector === 'search_console')!;
    expect(sc.status).toBe('success');
    expect(sc.stats.mappedProducts).toBe(30);
    expect(Number(sc.stats.searchRows)).toBeGreaterThan(0);
    expect(Number(sc.stats.searchUnmatchedPages)).toBeGreaterThan(0); // homepage, category pages
    // 30 days -> one query per day (no merchant-listings pass)
    expect(scMock().calls.length).toBe(30);
    expect(scMock().calls.every((c) => c.dimensions?.[0] === 'page' && c.startDate === c.endDate)).toBe(true);
    expect(ctx.metrics.latestSearchDate()).toBe(addDays(isoDay(), -2));

    const product = ctx.products.listAllProducts()[0]!;
    const signal = ctx.signals.get(product.name)!;
    expect(signal.metrics.scImpressions28d).toBeGreaterThan(0);
    expect(signal.metrics.scPosition28d).toBeGreaterThan(0);
    expect(product.signal!.scImpressions28d).toBe(signal.metrics.scImpressions28d);
    const all = ctx.products.listAllProducts();
    // Organic data changes the demand score for at least some products compared with a MC-only recomputation.
    const withSc = all.map((p) => p.signal!.scores.demand);
    ctx.db.run('DELETE FROM sc_page_daily');
    ctx.metricsSync.recomputeSignals();
    const withoutSc = ctx.products.listAllProducts().map((p) => p.signal!.scores.demand);
    expect(withSc).not.toEqual(withoutSc);

    // Unmapped pages are reported for diagnostics.
    const to = addDays(isoDay(), -2);
    ctx.db.run('DELETE FROM sc_page_daily'); // cleared above – re-pull the revision window
    await ctx.metricsSync.run('test');
    const unmapped = ctx.metrics.unmappedPages(addDays(to, -9), to);
    expect(unmapped.some((u) => u.canonicalUrl === 'https://example-shop.pl/')).toBe(true);
  });

  it('optionally pulls the MERCHANT_LISTINGS appearance and honours the country filter', async () => {
    await ctx.sync.runFullSync('test');
    enable({ metricsBackfillDays: 7, searchConsoleMerchantListings: true, searchConsoleCountryFilter: 'pol' });
    await ctx.metricsSync.run('test', { connectors: ['search_console'] });
    const calls = scMock().calls;
    expect(calls.length).toBe(14);
    expect(calls.filter((c) => c.dimensionFilterGroups?.[0]?.filters.some((f) => f.dimension === 'searchAppearance')).length).toBe(7);
    expect(calls.every((c) => c.dimensionFilterGroups?.[0]?.filters.some((f) => f.dimension === 'country' && f.expression === 'pol'))).toBe(true);
    const product = ctx.products.listAllProducts()[0]!;
    const series = ctx.metrics.searchSeriesForProduct(product.name, addDays(isoDay(), -20), isoDay());
    expect(series.map((s) => s.appearance).sort()).toEqual(['ALL', 'MERCHANT_LISTINGS']);
  });

  it('serves top queries per product with a 24 h cache', async () => {
    await ctx.sync.runFullSync('test');
    enable();
    ctx.searchConsole.rebuildUrlMap();
    const product = ctx.products.listAllProducts()[0]!;
    const first = await ctx.searchConsole.queriesForProduct(product.name);
    expect(first!.rows.length).toBeGreaterThan(3);
    expect(first!.rows[0]!.query).toContain(product.title!.toLowerCase().split(' ')[0]!);
    const calls = scMock().calls.length;
    const second = await ctx.searchConsole.queriesForProduct(product.name);
    expect(scMock().calls.length).toBe(calls); // cached
    expect(second!.rows).toEqual(first!.rows);
    await ctx.searchConsole.queriesForProduct(product.name, 0);
    expect(scMock().calls.length).toBe(calls + 1); // forced refresh
    expect(await ctx.searchConsole.queriesForProduct('accounts/x/products/unknown')).toBeNull();
  });

  it('a failing pull is logged per connector without affecting the Merchant reports', async () => {
    await ctx.sync.runFullSync('test');
    enable({ metricsBackfillDays: 7 });
    scMock().failWith = new MerchantApiError('quota', 429, 'RESOURCE_EXHAUSTED');
    const result = await ctx.metricsSync.run('test');
    expect(result.runs.find((r) => r.connector === 'merchant_reports')!.status).toBe('success');
    expect(result.runs.find((r) => r.connector === 'search_console')!.status).toBe('failed');
    expect(result.signals).not.toBeNull(); // signals still recomputed from what succeeded
    expect(ctx.events.list({ type: 'metrics.failed' }).items.some((e) => (e.payload as { connector: string }).connector === 'search_console')).toBe(true);
  });
});

// ------------------------------------------------------------------ HTTP
describe('Search Console HTTP API', () => {
  let app: FastifyInstance;
  let cookie = '';

  beforeEach(async () => {
    app = await createServer(ctx);
    await ctx.sync.runFullSync('test');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin12345' } });
    cookie = login.headers['set-cookie'] as string;
  });
  afterEach(async () => {
    await app.close();
  });

  it('lists properties, saves the configuration, syncs and exposes organic data', async () => {
    const sites = await app.inject({ method: 'GET', url: '/api/metrics/connectors/search_console/sites', headers: { cookie } });
    expect(sites.statusCode).toBe(200);
    expect(sites.json().sites.map((s: { siteUrl: string }) => s.siteUrl)).toEqual(['https://example-shop.pl/', 'sc-domain:example-shop.pl']);

    const off = await app.inject({ method: 'GET', url: `/api/products/${ctx.products.listAllProducts()[0]!.productId}/search-queries`, headers: { cookie } });
    expect(off.json().enabled).toBe(false);

    const save = await app.inject({ method: 'PUT', url: '/api/setup/config', headers: { cookie }, payload: { searchConsoleEnabled: true, searchConsoleSiteUrl: 'sc-domain:example-shop.pl', metricsBackfillDays: 14 } });
    expect(save.statusCode).toBe(200);
    expect(save.json().searchConsoleSiteUrl).toBe('sc-domain:example-shop.pl');
    const badCountry = await app.inject({ method: 'PUT', url: '/api/setup/config', headers: { cookie }, payload: { searchConsoleCountryFilter: 'poland' } });
    expect(badCountry.statusCode).toBe(400);

    const test = await app.inject({ method: 'POST', url: '/api/metrics/connectors/search_console/test', headers: { cookie } });
    expect(test.json().ok).toBe(true);

    const sync = await app.inject({ method: 'POST', url: '/api/metrics/sync?wait=true', headers: { cookie } });
    expect(sync.json().runs.map((r: { connector: string; status: string }) => `${r.connector}:${r.status}`)).toEqual(['merchant_reports:success', 'search_console:success']);

    const status = await app.inject({ method: 'GET', url: '/api/metrics/status', headers: { cookie } });
    expect(status.json().searchConsole.enabled).toBe(true);
    expect(status.json().searchConsole.urlMap.mappedProducts).toBe(30);
    expect(status.json().freshness.searchThrough).toBe(addDays(isoDay(), -2));

    const mapping = await app.inject({ method: 'GET', url: '/api/metrics/connectors/search_console/mapping', headers: { cookie } });
    expect(mapping.statusCode).toBe(200);
    expect(mapping.json().mapped).toBe(30);
    expect(mapping.json().unmappedProducts).toEqual([]);
    expect(mapping.json().unmappedPages.length).toBeGreaterThan(0);

    const products = await app.inject({ method: 'GET', url: '/api/products?orderBy=organicImpressions28d&orderDir=desc&limit=2', headers: { cookie } });
    const items = products.json().items as { productId: string; signal: { scImpressions28d: number } }[];
    expect(items[0]!.signal.scImpressions28d).toBeGreaterThanOrEqual(items[1]!.signal.scImpressions28d);

    const p360 = await app.inject({ method: 'GET', url: `/api/products/${items[0]!.productId}/360?days=14`, headers: { cookie } });
    const body = p360.json();
    expect(body.search.enabled).toBe(true);
    expect(body.search.mapping.canonicalUrl).toMatch(/^https:\/\/example-shop\.pl\/p\//);
    expect(body.search.series[0].points.length).toBeGreaterThan(0);
    expect(body.search.totals.impressions).toBeGreaterThan(0);
    expect(body.freshness.searchThrough).toBeTruthy();

    const queries = await app.inject({ method: 'GET', url: `/api/products/${items[0]!.productId}/search-queries`, headers: { cookie } });
    expect(queries.json().enabled).toBe(true);
    expect(queries.json().rows.length).toBeGreaterThan(0);
    expect(queries.json().canonicalUrl).toBe(body.search.mapping.canonicalUrl);

    const dash = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } });
    expect(dash.json().insights.organic.current.impressions).toBeGreaterThan(0);
    expect(dash.json().insights.organic.through).toBe(addDays(isoDay(), -2));

    const catalog = await app.inject({ method: 'GET', url: '/api/workflows/catalog', headers: { cookie } });
    expect(catalog.json().fields).toContain('metrics.scPosition28d');
  });
});

describe('Search Console edge cases', () => {
  it('reports a failing analytics probe while the property itself is accessible', async () => {
    await ctx.sync.runFullSync('test');
    enable();
    scMock().failQueriesWith = new MerchantApiError('backend error', 500, 'INTERNAL');
    const check = await ctx.metricsSync.testConnection('search_console');
    expect(check.ok).toBe(false);
    expect(check.hint).toBe('sc_api');
    expect(check.capabilities.find((c) => c.id === 'property')!.available).toBe(true);
    expect(check.capabilities.find((c) => c.id === 'search_analytics')!.available).toBe(false);
  });

  it('the not-configured stub rejects every call', async () => {
    const { createNotConfiguredSearchConsoleApi } = await import('../src/google/search-console-api.js');
    const api = createNotConfiguredSearchConsoleApi();
    await expect(api.listSites()).rejects.toThrow(/not configured/);
    await expect(api.query('x', { startDate: '2025-01-01', endDate: '2025-01-01' })).rejects.toThrow(/not configured/);
    await expect(api.queryAll('x', { startDate: '2025-01-01', endDate: '2025-01-01' })).rejects.toThrow(/not configured/);
  });

  it('keeps products mapped only when the page lies inside a URL-prefix property', async () => {
    await ctx.sync.runFullSync('test');
    scMock().sites.push({ siteUrl: 'https://example-shop.pl/p/', permissionLevel: 'siteOwner' }, { siteUrl: 'https://example-shop.pl/blog/', permissionLevel: 'siteOwner' });
    enable({ searchConsoleSiteUrl: 'https://example-shop.pl/p/' });
    expect(ctx.searchConsole.rebuildUrlMap().mapped).toBe(30);
    enable({ searchConsoleSiteUrl: 'https://example-shop.pl/blog/' });
    const map = ctx.searchConsole.rebuildUrlMap();
    expect(map.mapped).toBe(0);
    expect(map.outsideSite).toBe(30);
  });
});
