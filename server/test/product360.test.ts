import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/http/server.js';
import { testContext } from './helpers.js';
import type { AppContext } from '../src/app.js';
import type { MockMerchantApi } from '../src/mock/mock-merchant-api.js';
import { generateReport, parseReportQuery, unitHash } from '../src/mock/mock-reports.js';
import { MCQL, clusterKey, resolveProduct } from '../src/connectors/merchant-reports.js';
import { addDays, chunkRange, eachDay, isoDay, parseReportDate, weekStart } from '../src/util/dates.js';
import { resolveRelativeTime, resolveSalePriceMicros } from '../src/workflows/engine.js';
import type { ProductRecord } from '../src/services/product-store.js';

let ctx: AppContext;
let mock: MockMerchantApi;

beforeEach(() => {
  ({ ctx, mock } = testContext());
});
afterEach(async () => {
  await ctx.stop();
});

// ------------------------------------------------------------------ helpers
describe('date helpers', () => {
  it('adds days, enumerates ranges and chunks windows', () => {
    expect(addDays('2025-01-31', 1)).toBe('2025-02-01');
    expect(addDays('2025-03-01', -1)).toBe('2025-02-28');
    expect(eachDay('2025-01-30', '2025-02-01')).toEqual(['2025-01-30', '2025-01-31', '2025-02-01']);
    expect(chunkRange('2025-01-01', '2025-02-15', 31)).toEqual([
      { from: '2025-01-01', to: '2025-01-31' },
      { from: '2025-02-01', to: '2025-02-15' },
    ]);
    expect(weekStart('2025-01-05')).toBe('2024-12-30'); // Sunday -> previous Monday
    expect(weekStart('2025-01-06')).toBe('2025-01-06');
    expect(parseReportDate({ year: 2025, month: 3, day: 7 })).toBe('2025-03-07');
    expect(parseReportDate('2025-03-07')).toBe('2025-03-07');
    expect(parseReportDate('nope')).toBeNull();
  });
});

// ------------------------------------------------------------------ mock reports
describe('mock report generator', () => {
  it('parses Merchant Center Query Language', () => {
    const q = parseReportQuery(MCQL.bestSellers('2025-01-06', 'WEEKLY', 'PL'));
    expect(q.view).toBe('best_sellers_product_cluster_view');
    expect(q.dateFrom).toBe('2025-01-06');
    expect(q.equals).toEqual({ report_granularity: 'WEEKLY', report_country_code: 'PL' });
    const perf = parseReportQuery(MCQL.performance('2025-01-01', '2025-01-07'));
    expect(perf.view).toBe('product_performance_view');
    expect(perf.dateFrom).toBe('2025-01-01');
    expect(perf.dateTo).toBe('2025-01-07');
    expect(perf.fields).toContain('marketing_method');
    expect(() => parseReportQuery('DROP TABLE x')).toThrow();
  });

  it('is deterministic and respects the date window', async () => {
    const products = await mock.listAllProducts();
    const from = addDays(isoDay(), -3);
    const to = addDays(isoDay(), -1);
    const a = generateReport(MCQL.performance(from, to), products);
    const b = generateReport(MCQL.performance(from, to), products);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    for (const row of a) {
      const d = parseReportDate(row.productPerformanceView!.date)!;
      expect(d >= from && d <= to).toBe(true);
    }
    expect(unitHash('a')).not.toBe(unitHash('b'));
    expect(unitHash('a')).toBe(unitHash('a'));
  });

  it('simulates Market Insights being unavailable', async () => {
    mock.unavailableReportViews.add('price_competitiveness_product_view');
    await expect(mock.searchReport(MCQL.priceCompetitiveness())).rejects.toThrow(/Market Insights/);
    await expect(mock.searchReport(MCQL.priceInsights())).resolves.toBeInstanceOf(Array);
  });
});

// ------------------------------------------------------------------ connector helpers
describe('merchant reports connector helpers', () => {
  const rec = (name: string, offerId: string, feedLabel: string): ProductRecord =>
    ({ name, offerId, feedLabel }) as unknown as ProductRecord;

  it('resolves offer ids to products preferring the report country', () => {
    const pl = rec('accounts/1/products/pl~PL~SKU-1', 'SKU-1', 'PL');
    const de = rec('accounts/1/products/de~DE~SKU-1', 'SKU-1', 'DE');
    const index = new Map([
      ['SKU-1', [pl, de]],
      ['sku-1', [pl, de]],
    ]);
    expect(resolveProduct(index, 'SKU-1', 'DE')).toBe(de);
    expect(resolveProduct(index, 'SKU-1', 'FR')).toBe(pl);
    expect(resolveProduct(index, 'sku-1', undefined)).toBe(pl);
    expect(resolveProduct(index, 'unknown', 'PL')).toBeUndefined();
    expect(resolveProduct(index, undefined, 'PL')).toBeUndefined();
  });

  it('builds stable cluster keys', () => {
    expect(clusterKey('A', 'B', ['2', '1'])).toBe(clusterKey('A', 'B', ['1', '2']));
    expect(clusterKey('A', 'B', ['1'])).not.toBe(clusterKey('A', 'C', ['1']));
  });

  it('query builders reference the right views', () => {
    expect(MCQL.performance('2025-01-01', '2025-01-02')).toContain("FROM product_performance_view WHERE date BETWEEN '2025-01-01' AND '2025-01-02'");
    expect(MCQL.competitiveVisibility('2025-01-01', '2025-01-02', 'PL', '123')).toContain("report_category_id = '123' AND traffic_source = 'ALL'");
  });
});

// ------------------------------------------------------------------ metrics sync + signals
describe('MetricsSyncService', () => {
  it('backfills on the first run, then pulls the revision window; recomputes signals and emits events', async () => {
    await ctx.sync.runFullSync('test');
    const status0 = ctx.metricsSync.status();
    expect(status0.connectors.map((c) => c.id)).toEqual(['merchant_reports', 'search_console']);
    expect(status0.connectors[0]!.configured).toBe(true);
    expect(status0.signals.computed).toBe(false);

    const first = await ctx.metricsSync.run('test');
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]!.status).toBe('success');
    expect(first.runs[0]!.stats.backfill).toBe(true);
    expect(Number(first.runs[0]!.stats.performanceRows)).toBeGreaterThan(0);
    expect(Number(first.runs[0]!.stats.bestSellerRows)).toBeGreaterThan(0);
    expect(Number(first.runs[0]!.stats.priceBenchmarkRows)).toBeGreaterThan(0);
    expect(Number(first.runs[0]!.stats.competitiveVisibilityRows)).toBeGreaterThan(0);
    expect(first.runs[0]!.stats.performanceUnmatched).toBe(0);
    // 90 days of backfill -> 3 chunks of <= 31 days
    expect(first.runs[0]!.stats.chunks).toBe(3);
    expect(first.signals?.products).toBe(30);
    expect(ctx.events.list({ type: 'metrics.synced' }).total).toBe(1);

    const status1 = ctx.metricsSync.status();
    expect(status1.signals.computed).toBe(true);
    const next = status1.connectors[0]!.nextWindow!;
    expect(next.to).toBe(addDays(isoDay(), -1));
    expect(next.from).toBe(addDays(next.to, -6)); // revision window of 7 days

    const calls = mock.callCounts.get('searchReport') ?? 0;
    const second = await ctx.metricsSync.run('test');
    expect(second.runs[0]!.stats.backfill).toBe(false);
    expect(second.runs[0]!.stats.chunks).toBe(1);
    expect((mock.callCounts.get('searchReport') ?? 0) - calls).toBeLessThan(calls); // much smaller pull
    // Idempotent: the same rows are upserted, row counts do not grow.
    const rows = ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM mc_product_performance_daily')!.c;
    await ctx.metricsSync.run('test');
    expect(ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM mc_product_performance_daily')!.c).toBe(rows);
  });

  it('keeps going when Market Insights views are unavailable and remembers it', async () => {
    await ctx.sync.runFullSync('test');
    mock.unavailableReportViews.add('price_competitiveness_product_view').add('best_sellers_product_cluster_view');
    const result = await ctx.metricsSync.run('test');
    expect(result.runs[0]!.status).toBe('success');
    const stats = result.runs[0]!.stats;
    expect(stats.unavailableViews).toEqual(expect.arrayContaining(['price_competitiveness_product_view', 'best_sellers_product_cluster_view']));
    expect((stats.warnings as string[]).length).toBeGreaterThan(0);
    expect(stats.bestSellerRows).toBeUndefined();
    expect(stats.priceInsightsRows).toBeDefined(); // the other Market Insights view still worked
    expect(ctx.signals.hasSignals()).toBe(true);

    const calls = mock.callCounts.get('searchReport') ?? 0;
    await ctx.metricsSync.run('test');
    // The unavailable views are skipped without calling the API again.
    const queries = (mock.callCounts.get('searchReport') ?? 0) - calls;
    expect(queries).toBeLessThanOrEqual(3);

    // "Test connection" re-probes every view and clears the flag once it works again.
    mock.unavailableReportViews.clear();
    const check = await ctx.metricsSync.testConnection('merchant_reports');
    expect(check.ok).toBe(true);
    expect(check.capabilities.every((c) => c.available)).toBe(true);
    const result3 = await ctx.metricsSync.run('test');
    expect(Number(result3.runs[0]!.stats.bestSellerRows)).toBeGreaterThan(0);
  });

  it('reports a failing performance view as a connection error', async () => {
    await ctx.sync.runFullSync('test');
    mock.unavailableReportViews.add('product_performance_view');
    const check = await ctx.metricsSync.testConnection('merchant_reports');
    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/not available/);
    const result = await ctx.metricsSync.run('test');
    expect(result.runs[0]!.status).toBe('failed');
    expect(ctx.events.list({ type: 'metrics.failed' }).total).toBe(1);
    expect(result.signals).toBeNull();
  });

  it('prunes rows older than the retention window', async () => {
    await ctx.sync.runFullSync('test');
    ctx.settings.update({ metricsBackfillDays: 30, metricsRetentionDays: 30 });
    await ctx.metricsSync.run('test');
    const oldest = ctx.db.get<{ d: string }>('SELECT MIN(date) AS d FROM mc_product_performance_daily')!.d;
    expect(oldest >= addDays(isoDay(), -30)).toBe(true);
  });
});

describe('SignalsService', () => {
  beforeEach(async () => {
    await ctx.sync.runFullSync('test');
    await ctx.metricsSync.run('test');
  });

  it('assigns every product a recommendation with reasons and scores', () => {
    const products = ctx.products.listAllProducts();
    const recommendations = new Set<string>();
    for (const p of products) {
      const signal = ctx.signals.get(p.name);
      expect(signal).not.toBeNull();
      expect(signal!.reasons.length).toBeGreaterThan(0);
      expect(signal!.scores.demand).toBeGreaterThanOrEqual(0);
      expect(signal!.scores.demand).toBeLessThanOrEqual(100);
      expect(signal!.scores.health).toBeLessThanOrEqual(100);
      recommendations.add(signal!.recommendation);
      expect(p.signal?.recommendation).toBe(signal!.recommendation);
    }
    // The synthetic data is varied enough to hit several buckets.
    expect(recommendations.size).toBeGreaterThanOrEqual(3);
    const counts = ctx.products.recommendationCounts();
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(products.length);
  });

  it('recommends FIX for disapproved products with traffic and emits signal.changed on transitions', async () => {
    const approved = ctx.products.listAllProducts({ status: ['APPROVED'] }).find((p) => (p.signal?.impressions7d ?? 0) > 50)!;
    expect(approved).toBeDefined();
    expect(approved.signal!.recommendation).not.toBe('FIX');
    const id = approved.name.split('/products/')[1]!;
    mock.setProductIssues(id, [{ code: 'policy_violation', severity: 'DISAPPROVED', reportingContext: 'SHOPPING_ADS', description: 'x' }]);
    await ctx.sync.refreshProduct(id, 'test');
    const summary = ctx.metricsSync.recomputeSignals();
    expect(summary.changed).toBeGreaterThanOrEqual(1);
    const signal = ctx.signals.get(approved.name)!;
    expect(signal.recommendation).toBe('FIX');
    expect(signal.previousRecommendation).toBe(approved.signal!.recommendation);
    expect(signal.reasons.map((r) => r.code)).toContain('disapproved');
    const events = ctx.events.list({ type: 'signal.changed' }).items;
    expect(events.some((e) => e.productName === approved.name && (e.payload as { recommendation: string }).recommendation === 'FIX')).toBe(true);
  });

  it('a full product sync triggers a recomputation', async () => {
    const before = ctx.signals.get(ctx.products.listAllProducts()[0]!.name)!.computedAt;
    await new Promise((r) => setTimeout(r, 5));
    await ctx.sync.runFullSync('test');
    const after = ctx.signals.get(ctx.products.listAllProducts()[0]!.name)!.computedAt;
    expect(after >= before).toBe(true);
  });

  it('reacts to threshold changes', () => {
    ctx.settings.update({ signalMinImpressions: 100000 });
    const counts = ctx.products.recommendationCounts();
    // With an absurd minimum nothing has "data"; only Market Insights rows keep products out of NO_DATA.
    expect((counts.NO_DATA ?? 0) + (counts.REPRICE ?? 0) + (counts.WATCH ?? 0) + (counts.SCALE ?? 0) + (counts.KEEP ?? 0) + (counts.FIX ?? 0)).toBe(30);
    expect(counts.OPTIMISE_LISTING ?? 0).toBe(0);
  });
});

// ------------------------------------------------------------------ workflows
describe('workflow integration', () => {
  it('resolves relative times and sale prices', () => {
    const base = new Date('2025-01-01T00:00:00Z');
    expect(resolveRelativeTime('now', base)).toBe('2025-01-01T00:00:00.000Z');
    expect(resolveRelativeTime('+3d', base)).toBe('2025-01-04T00:00:00.000Z');
    expect(resolveRelativeTime('-12h', base)).toBe('2024-12-31T12:00:00.000Z');
    expect(resolveRelativeTime('+1w', base)).toBe('2025-01-08T00:00:00.000Z');
    expect(resolveRelativeTime('2025-02-01', base)).toBe('2025-02-01T00:00:00.000Z');
    expect(() => resolveRelativeTime('yesterday', base)).toThrow();
    expect(resolveSalePriceMicros('89.99', null)).toBe(89_990_000);
    expect(resolveSalePriceMicros('-15%', 100_000_000)).toBe(85_000_000);
    expect(resolveSalePriceMicros('20 %', 50_000_000)).toBe(40_000_000);
    expect(() => resolveSalePriceMicros('-15%', null)).toThrow();
    expect(() => resolveSalePriceMicros('abc', null)).toThrow();
  });

  it('select_by_signal, conditions on metrics and set_sale_price work end to end', async () => {
    await ctx.sync.runFullSync('test');
    await ctx.metricsSync.run('test');
    const counts = ctx.products.recommendationCounts();
    const [bucket] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
    const wf = ctx.workflows.create({
      name: 'p360',
      trigger: { type: 'manual' },
      steps: [
        { type: 'select_by_signal', recommendation: [bucket as 'SCALE'], limit: 5 },
        { type: 'filter', condition: { field: 'signals.recommendation', op: 'eq', value: bucket } },
        { type: 'filter', condition: { field: 'metrics.impressions28d', op: 'gte', value: 0 } },
        { type: 'set_sale_price', price: '-10%', from: 'now', to: '+3d' },
        { type: 'add_tags', tags: ['sale-{{signals.recommendation}}'] },
      ],
    });
    const run = await ctx.engine.run(wf, 'manual');
    expect(run.status).toBe('success');
    expect(run.stats.selected).toBe(Math.min(5, counts[bucket]!));
    expect(run.stats.errors ?? 0).toBe(0);
    const tagged = ctx.products.listAllProducts({ tag: `sale-${bucket}` });
    expect(tagged.length).toBe(run.stats.selected);
    const status = await ctx.enrichment.status();
    const input = mock.getSupplementalInput(tagged[0]!.name.split('/products/')[1]!, status.dataSource!.name!);
    const attrs = input?.productAttributes as { salePrice?: { amountMicros: string; currencyCode: string }; salePriceEffectiveDate?: { startTime: string; endTime: string } };
    expect(attrs.salePrice?.currencyCode).toMatch(/PLN|EUR/);
    expect(Number(attrs.salePrice?.amountMicros)).toBeLessThan(Number(tagged[0]!.price!.amountMicros));
    expect(attrs.salePriceEffectiveDate?.endTime! > attrs.salePriceEffectiveDate?.startTime!).toBe(true);
  });

  it('accepts the new trigger events and rejects invalid relative times', () => {
    expect(() => ctx.workflows.create({ name: 'x', trigger: { type: 'event', event: 'signal.changed', debounceSeconds: 5 }, steps: [{ type: 'log', message: 'hi' }] })).not.toThrow();
    expect(() => ctx.workflows.create({ name: 'y', trigger: { type: 'manual' }, steps: [{ type: 'set_sale_price', price: '1', from: 'now', to: 'soon' } as never] })).toThrow();
  });

  it('the Product360 templates validate', async () => {
    const { WORKFLOW_TEMPLATES } = await import('../src/workflows/templates.js');
    const { workflowDefinitionSchema } = await import('../src/workflows/schema.js');
    for (const tpl of WORKFLOW_TEMPLATES) expect(() => workflowDefinitionSchema.parse(tpl.definition)).not.toThrow();
    expect(WORKFLOW_TEMPLATES.filter((t) => t.id.startsWith('p360-')).length).toBe(4);
  });
});

// ------------------------------------------------------------------ HTTP
describe('Product360 HTTP API', () => {
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

  it('exposes status, sync, product 360, market views, facets and dashboard insights', async () => {
    const status0 = await app.inject({ method: 'GET', url: '/api/metrics/status', headers: { cookie } });
    expect(status0.statusCode).toBe(200);
    expect(status0.json().signals.computed).toBe(false);
    expect(status0.json().settings.thresholds.priceAboveBenchmarkPct).toBe(10);

    const dash0 = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } });
    expect(dash0.json().insights.computed).toBe(false);
    expect(dash0.json().insights.enabled).toBe(true);

    const sync = await app.inject({ method: 'POST', url: '/api/metrics/sync?wait=true', headers: { cookie } });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().runs[0].status).toBe('success');

    const status1 = await app.inject({ method: 'GET', url: '/api/metrics/status', headers: { cookie } });
    expect(status1.json().signals.computed).toBe(true);
    expect(status1.json().runs.length).toBe(1);
    expect(status1.json().freshness.performanceThrough).toBeTruthy();

    const test = await app.inject({ method: 'POST', url: '/api/metrics/connectors/merchant_reports/test', headers: { cookie } });
    expect(test.statusCode).toBe(200);
    expect(test.json().ok).toBe(true);
    expect(test.json().capabilities.length).toBe(5);
    const unknown = await app.inject({ method: 'POST', url: '/api/metrics/connectors/nope/test', headers: { cookie } });
    expect(unknown.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/metrics/connectors/google_ads/test', headers: { cookie } });
    expect(missing.statusCode).toBe(400);

    const products = await app.inject({ method: 'GET', url: '/api/products?orderBy=clicks7d&orderDir=desc&limit=3', headers: { cookie } });
    expect(products.statusCode).toBe(200);
    const items = products.json().items as { productId: string; signal: { clicks7d: number; recommendation: string } }[];
    expect(items[0]!.signal.clicks7d).toBeGreaterThanOrEqual(items[1]!.signal.clicks7d);
    const reco = items[0]!.signal.recommendation;
    const filtered = await app.inject({ method: 'GET', url: `/api/products?recommendation=${reco}`, headers: { cookie } });
    expect((filtered.json().items as { signal: { recommendation: string } }[]).every((p) => p.signal.recommendation === reco)).toBe(true);

    const facets = await app.inject({ method: 'GET', url: '/api/products/facets', headers: { cookie } });
    expect(facets.json().signalsComputed).toBe(true);
    expect(facets.json().categories.length).toBeGreaterThan(0);
    expect(Object.keys(facets.json().recommendations).length).toBeGreaterThan(0);

    const p360 = await app.inject({ method: 'GET', url: `/api/products/${items[0]!.productId}/360?days=30`, headers: { cookie } });
    expect(p360.statusCode).toBe(200);
    const body = p360.json();
    expect(body.signal.recommendation).toBe(reco);
    expect(body.performance.series.length).toBeGreaterThan(0);
    expect(body.performance.totals.clicks).toBeGreaterThan(0);
    expect(body.freshness.performanceThrough).toBeTruthy();
    expect(Array.isArray(body.bestSellers)).toBe(true);
    const notFound = await app.inject({ method: 'GET', url: '/api/products/bm9wZQ/360', headers: { cookie } });
    expect(notFound.statusCode).toBe(404);

    const best = await app.inject({ method: 'GET', url: '/api/market/best-sellers?carried=false&limit=5', headers: { cookie } });
    expect(best.statusCode).toBe(200);
    expect(best.json().items.length).toBeGreaterThan(0);
    expect(best.json().items.every((b: { productName: string | null }) => b.productName === null)).toBe(true);
    expect(best.json().facets.countries).toEqual(expect.arrayContaining(['PL']));
    const bestCarried = await app.inject({ method: 'GET', url: '/api/market/best-sellers?carried=true&country=PL', headers: { cookie } });
    expect(bestCarried.json().items.every((b: { productId: string | null }) => !!b.productId)).toBe(true);

    const competitors = await app.inject({ method: 'GET', url: '/api/market/competitors?country=PL', headers: { cookie } });
    expect(competitors.statusCode).toBe(200);
    expect(competitors.json().rows.length).toBeGreaterThan(0);
    expect(competitors.json().rows.some((r: { isYourDomain: boolean }) => r.isYourDomain)).toBe(true);

    const overview = await app.inject({ method: 'GET', url: '/api/market/overview', headers: { cookie } });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().totals7d.impressions).toBeGreaterThan(0);

    const dash = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } });
    const insights = dash.json().insights;
    expect(insights.computed).toBe(true);
    expect(insights.totals.current.impressions).toBeGreaterThan(0);
    expect(insights.series.length).toBeGreaterThan(0);
    expect(Object.values(insights.recommendationCounts as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(30);

    const recompute = await app.inject({ method: 'POST', url: '/api/metrics/recompute', headers: { cookie } });
    expect(recompute.statusCode).toBe(200);
    expect(recompute.json().products).toBe(30);

    const catalog = await app.inject({ method: 'GET', url: '/api/workflows/catalog', headers: { cookie } });
    expect(catalog.json().events).toContain('signal.changed');
    expect(catalog.json().fields).toContain('signals.recommendation');
    expect(catalog.json().steps.map((s: { type: string }) => s.type)).toEqual(expect.arrayContaining(['select_by_signal', 'set_sale_price']));

    const preview = await app.inject({
      method: 'POST',
      url: '/api/workflows/preview',
      headers: { cookie },
      payload: { name: 'p', trigger: { type: 'manual' }, steps: [{ type: 'select_by_signal', recommendation: [reco] }, { type: 'set_sale_price', price: '-5%', to: '+1d' }] },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().count).toBeGreaterThan(0);
    expect(preview.json().skippedSteps).toEqual(['set_sale_price']);
    expect(preview.json().products[0].recommendation).toBe(reco);
  });

  it('updates metric settings through the setup config endpoint', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/setup/config', headers: { cookie }, payload: { metricsSyncCron: '30 5 * * *', signalPriceAbovePct: 25 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().metricsSyncCron).toBe('30 5 * * *');
    expect(res.json().signalPriceAbovePct).toBe(25);
    const status = await app.inject({ method: 'GET', url: '/api/metrics/status', headers: { cookie } });
    expect(status.json().settings.cron).toBe('30 5 * * *');
    const bad = await app.inject({ method: 'PUT', url: '/api/setup/config', headers: { cookie }, payload: { metricsBackfillDays: 5 } });
    expect(bad.statusCode).toBe(400);
  });
});

// ------------------------------------------------------------------ scheduler
describe('MetricsScheduler', () => {
  it('schedules by cron, runs once on startup when nothing was loaded, reconfigures and stops', async () => {
    const { MetricsScheduler } = await import('../src/jobs/metrics-scheduler.js');
    const { silentLogger } = await import('../src/util/logger.js');
    let runs = 0;
    let loaded = false;
    const sync = {
      run: async () => {
        runs += 1;
        loaded = true;
        return {} as never;
      },
      status: () => ({ connectors: [{ lastSuccessfulRun: loaded ? {} : null }] }),
    } as unknown as ConstructorParameters<typeof MetricsScheduler>[0];

    let enabled = false;
    const s = new MetricsScheduler(sync, { enabled: true, cron: '0 4 * * *', timezone: 'Europe/Warsaw' }, silentLogger, () => enabled);
    s.start(false);
    expect(s.nextRun()).toBeTruthy();
    s.reconfigure({ enabled: true, cron: '0 4 * * *', timezone: 'Europe/Warsaw' }); // no change
    s.reconfigure({ enabled: false, cron: '0 4 * * *', timezone: 'Europe/Warsaw' });
    expect(s.nextRun()).toBeNull();
    s.reconfigure({ enabled: true, cron: 'not a cron', timezone: 'Europe/Warsaw' });
    expect(s.nextRun()).toBeNull(); // invalid cron is logged, not thrown
    s.stop();

    // startup run: skipped while not enabled, executed once enabled and nothing loaded, skipped afterwards
    const tick = (scheduler: InstanceType<typeof MetricsScheduler>, reason: string) => (scheduler as unknown as { tick(r: string): Promise<void> }).tick(reason);
    await tick(s, 'startup');
    expect(runs).toBe(0);
    enabled = true;
    await tick(s, 'startup');
    expect(runs).toBe(1);
    await tick(s, 'startup');
    expect(runs).toBe(1);
    await tick(s, 'schedule');
    expect(runs).toBe(2);

    const failing = new MetricsScheduler({ run: async () => { throw new Error('boom'); }, status: () => ({ connectors: [] }) } as never, { enabled: true, cron: '0 4 * * *', timezone: 'UTC' }, silentLogger);
    await tick(failing, 'schedule'); // error is swallowed and logged
    failing.stop();
  });

  it('is wired into the app and follows settings changes', () => {
    expect(ctx.metricsScheduler.nextRun()).toBeNull(); // not started in tests
    ctx.metricsScheduler.start(false);
    expect(ctx.metricsScheduler.nextRun()).toBeTruthy();
    ctx.settings.update({ metricsEnabled: false });
    expect(ctx.metricsScheduler.nextRun()).toBeNull();
    ctx.settings.update({ metricsEnabled: true, metricsSyncCron: '15 3 * * *' });
    expect(ctx.metricsScheduler.nextRun()).toMatch(/T0[0-9]:15/);
  });
});

// ------------------------------------------------------------------ edge cases
describe('edge cases', () => {
  it('counts report rows whose offer id has no local product and skips rows without a date', async () => {
    await ctx.sync.runFullSync('test');
    const { MerchantReportsConnector } = await import('../src/connectors/merchant-reports.js');
    const { ConnectorState } = await import('../src/connectors/connector.js');
    const known = ctx.products.listAllProducts()[0]!;
    const fakeApi = {
      searchReport: async (query: string) => {
        if (!query.includes('product_performance_view')) return [];
        return [
          { productPerformanceView: { date: '2025-01-02', offerId: 'GHOST-1', marketingMethod: 'ADS', impressions: '10', clicks: '1' } },
          { productPerformanceView: { offerId: known.offerId, marketingMethod: 'ADS', impressions: '10', clicks: '1' } }, // no date
          { productPerformanceView: { date: '2025-01-02', offerId: known.offerId, customerCountryCode: known.feedLabel ?? 'PL', marketingMethod: 'ORGANIC', impressions: '7', clicks: '2' } },
          { productPerformanceView: { date: '2025-01-03', offerId: known.offerId, marketingMethod: 'ORGANIC', impressions: '0', clicks: '0' } }, // zero row -> not stored
        ];
      },
    } as unknown as typeof ctx.api;
    const connector = new MerchantReportsConnector(fakeApi, ctx.products, ctx.metrics, new ConnectorState(ctx.db), () => true);
    const result = await connector.sync({ from: '2025-01-01', to: '2025-01-03' }, { info: () => undefined, warn: () => undefined });
    expect(result.stats.performanceUnmatched).toBe(1);
    expect(result.stats.performanceRows).toBe(1);
    expect(ctx.metrics.performanceTotals(known.name, '2025-01-01', '2025-01-03')).toMatchObject({ impressions: 7, clicks: 2 });
    // A non-"unavailable" error (e.g. 500) aborts the sync instead of being swallowed.
    const { MerchantApiError } = await import('../src/google/rest-client.js');
    const failing = { searchReport: async () => { throw new MerchantApiError('boom', 500, 'INTERNAL'); } } as unknown as typeof ctx.api;
    await expect(new MerchantReportsConnector(failing, ctx.products, ctx.metrics, new ConnectorState(ctx.db), () => true).sync({ from: '2025-01-01', to: '2025-01-01' }, { info: () => undefined, warn: () => undefined })).rejects.toThrow('boom');
  });

  it('gives NO_DATA to a product without traffic or market data', async () => {
    await ctx.sync.runFullSync('test');
    await ctx.metricsSync.run('test');
    ctx.products.upsertProduct({
      name: `${mock.accountName}/products/pl~PL~NEW-1`,
      offerId: 'NEW-1',
      contentLanguage: 'pl',
      feedLabel: 'PL',
      productAttributes: { title: 'Brand new', price: { amountMicros: '1000000', currencyCode: 'PLN' }, availability: 'IN_STOCK' },
      productStatus: { itemLevelIssues: [], destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', approvedCountries: ['PL'] }] },
    });
    ctx.metricsSync.recomputeSignals();
    const signal = ctx.signals.get(`${mock.accountName}/products/pl~PL~NEW-1`)!;
    expect(signal.recommendation).toBe('NO_DATA');
    expect(signal.reasons[0]!.code).toBe('no_data');
    expect(ctx.products.recommendationCounts().NO_DATA).toBe(1);
  });

  it('marks interrupted metrics runs as failed on start and lists runs per connector', () => {
    ctx.metrics.startRun('merchant_reports', { from: '2025-01-01', to: '2025-01-02' });
    ctx.metrics.startRun('search_console', null);
    expect(ctx.metrics.failStaleRuns()).toBe(2);
    expect(ctx.metrics.listRuns(10, 'search_console')).toHaveLength(1);
    expect(ctx.metrics.listRuns(10)).toHaveLength(2);
    expect(ctx.metrics.lastRun('search_console')!.error).toMatch(/Interrupted/);
    expect(ctx.metrics.lastSuccessfulRun('search_console')).toBeUndefined();
  });

  it('raises a dashboard flag when the last metrics pull failed', async () => {
    const app = await createServer(ctx);
    try {
      await ctx.sync.runFullSync('test');
      mock.unavailableReportViews.add('product_performance_view');
      await ctx.metricsSync.run('test');
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin12345' } });
      const dash = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: login.headers['set-cookie'] as string } });
      expect(dash.json().flags.some((f: { code: string }) => f.code === 'metrics_failed')).toBe(true);
    } finally {
      await app.close();
    }
  });
});
