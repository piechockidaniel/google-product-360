import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import type { ConnectorId } from '../../connectors/connector.js';
import { addDays } from '../../util/dates.js';
import { badRequest } from '../server.js';

const connectorId = z.enum(['merchant_reports', 'search_console', 'google_ads']);
const csv = (schema: z.ZodTypeAny) => z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(schema).optional());

const bestSellersQuery = z.object({
  country: z.string().optional(),
  category: z.string().optional(),
  carried: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : undefined), z.boolean().optional()),
  demandChange: z.enum(['RISER', 'FLAT', 'SINKER']).optional(),
  granularity: z.enum(['WEEKLY', 'MONTHLY']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const competitorsQuery = z.object({
  country: z.string().optional(),
  categoryId: z.string().optional(),
  trafficSource: z.enum(['ALL', 'ADS', 'ORGANIC']).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
});

/** Product360: metrics connectors, market views and sync control. */
export function registerMetricsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/metrics/status', async () => ({
    ...ctx.metricsSync.status(),
    nextRunAt: ctx.metricsScheduler.nextRun(),
    settings: {
      cron: ctx.settings.current().metricsSyncCron,
      backfillDays: ctx.settings.current().metricsBackfillDays,
      retentionDays: ctx.settings.current().metricsRetentionDays,
      thresholds: {
        minImpressions: ctx.settings.current().signalMinImpressions,
        priceAboveBenchmarkPct: ctx.settings.current().signalPriceAbovePct,
        clickDropPct: ctx.settings.current().signalClickDropPct,
      },
    },
    runs: ctx.metrics.listRuns(20),
    freshness: {
      performanceThrough: ctx.metrics.latestPerformanceDate(),
      bestSellersThrough: ctx.metrics.latestBestSellerReportDate(),
      visibilityThrough: ctx.metrics.latestVisibilityDate(),
      searchThrough: ctx.metrics.latestSearchDate(),
    },
    searchConsole: {
      enabled: ctx.settings.current().searchConsoleEnabled,
      siteUrl: ctx.settings.current().searchConsoleSiteUrl,
      countryFilter: ctx.settings.current().searchConsoleCountryFilter,
      merchantListings: ctx.settings.current().searchConsoleMerchantListings,
      dataState: ctx.settings.current().searchConsoleDataState,
      urlMap: ctx.metrics.urlMapStats(),
    },
  }));

  /** Search Console properties visible to the service account (for the property picker). */
  app.get('/metrics/connectors/search_console/sites', async () => {
    const sites = await ctx.searchConsoleApi().listSites();
    return { sites: sites.sort((a, b) => a.siteUrl.localeCompare(b.siteUrl)), current: ctx.settings.current().searchConsoleSiteUrl };
  });

  /** URL-join diagnostics: how many products map to a page, pages with traffic that belong to no product. */
  app.get('/metrics/connectors/search_console/mapping', async () => {
    const map = ctx.searchConsole.rebuildUrlMap();
    const to = ctx.metrics.latestSearchDate() ?? ctx.signals.windowEnd();
    const from = addDays(to, -27);
    const unmappedProducts = ctx.products
      .listAllProducts()
      .filter((p) => !ctx.metrics.urlFor(p.name))
      .slice(0, 50)
      .map((p) => ({ productId: p.productId, offerId: p.offerId, title: p.title, link: p.link }));
    return { ...map, stats: ctx.metrics.urlMapStats(), unmappedProducts, unmappedPages: ctx.metrics.unmappedPages(from, to), window: { from, to } };
  });

  app.post('/metrics/sync', async (request) => {
    const query = z
      .object({
        wait: z.enum(['true', 'false']).optional(),
        connector: csv(connectorId),
        backfill: z.enum(['true', 'false']).optional(),
      })
      .parse(request.query);
    const promise = ctx.metricsSync.run('manual', { connectors: query.connector as ConnectorId[] | undefined, backfill: query.backfill === 'true' });
    if (query.wait === 'true') return promise;
    promise.catch(() => undefined);
    return { started: true, running: true };
  });

  app.post('/metrics/recompute', async () => ctx.metricsSync.recomputeSignals());

  app.post<{ Params: { id: string } }>('/metrics/connectors/:id/test', async (request) => {
    const id = connectorId.safeParse(request.params.id);
    if (!id.success) throw badRequest('Unknown connector');
    if (!ctx.metricsSync.connector(id.data)) throw badRequest('Connector not available in this installation');
    return ctx.metricsSync.testConnection(id.data);
  });

  // ---- market views
  app.get('/market/best-sellers', async (request) => {
    const query = bestSellersQuery.parse(request.query);
    return { ...ctx.metrics.listBestSellers(query), facets: ctx.metrics.bestSellerFacets() };
  });

  app.get('/market/competitors', async (request) => {
    const query = competitorsQuery.parse(request.query);
    const to = ctx.metrics.latestVisibilityDate() ?? ctx.signals.windowEnd();
    const from = addDays(to, -((query.days ?? 28) - 1));
    return { ...ctx.metrics.competitiveVisibility({ ...query, from, to }), window: { from, to }, facets: ctx.metrics.visibilityFacets() };
  });

  app.get('/market/overview', async () => {
    const end = ctx.signals.windowEnd();
    return {
      windowEnd: end,
      totals7d: ctx.metrics.catalogueTotals(addDays(end, -6), end),
      totalsPrev7d: ctx.metrics.catalogueTotals(addDays(end, -13), addDays(end, -7)),
      series: ctx.metrics.catalogueSeries(addDays(end, -89), end),
      recommendationCounts: ctx.products.recommendationCounts(),
      bestSellers: ctx.metrics.bestSellerFacets(),
      risers: ctx.metrics.listBestSellers({ demandChange: 'RISER', limit: 20 }).items,
      sinkers: ctx.metrics.listBestSellers({ demandChange: 'SINKER', carried: true, limit: 20 }).items,
      notCarried: ctx.metrics.listBestSellers({ carried: false, limit: 20 }).items,
    };
  });
}
