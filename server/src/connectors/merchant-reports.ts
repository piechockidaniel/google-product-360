import { createHash } from 'node:crypto';
import type { MerchantApi } from '../google/merchant-api.js';
import { MerchantApiError } from '../google/rest-client.js';
import type { ReportRow } from '../google/types.js';
import type { ProductRecord, ProductStore } from '../services/product-store.js';
import type { BestSellerRow, CompetitiveVisibilityRow, MetricsStore, PerformanceRow, PriceBenchmarkRow } from '../services/metrics-store.js';
import { eachDay, isoDay, parseReportDate, weekStart } from '../util/dates.js';
import type { ConnectionCheck, Connector, ConnectorLog, ConnectorState, ConnectorSyncResult, SyncWindow } from './connector.js';

/** Report views used by the connector; the Market Insights ones may be unavailable. */
export const REPORT_VIEWS = {
  performance: 'product_performance_view',
  priceCompetitiveness: 'price_competitiveness_product_view',
  priceInsights: 'price_insights_product_view',
  bestSellers: 'best_sellers_product_cluster_view',
  competitiveVisibility: 'competitive_visibility_competitor_view',
} as const;
export type ReportViewKey = keyof typeof REPORT_VIEWS;
export const MARKET_INSIGHTS_VIEWS: ReportViewKey[] = ['priceCompetitiveness', 'priceInsights', 'bestSellers', 'competitiveVisibility'];

/** Merchant Center Query Language builders – kept together so tests can assert the exact strings. */
export const MCQL = {
  performance: (from: string, to: string) =>
    `SELECT date, offer_id, marketing_method, customer_country_code, impressions, clicks, conversions, conversion_value ` +
    `FROM product_performance_view WHERE date BETWEEN '${from}' AND '${to}'`,
  priceCompetitiveness: () =>
    `SELECT id, offer_id, title, brand, price, benchmark_price, report_country_code FROM price_competitiveness_product_view`,
  priceInsights: () =>
    `SELECT id, offer_id, price, suggested_price, predicted_impressions_change_fraction, ` +
    `predicted_clicks_change_fraction, predicted_conversions_change_fraction, effectiveness FROM price_insights_product_view`,
  bestSellers: (reportDate: string, granularity: 'WEEKLY' | 'MONTHLY', country?: string) =>
    `SELECT report_date, report_granularity, report_country_code, report_category_id, title, brand, category_l1, category_l2, variant_gtins, ` +
    `inventory_status, rank, previous_rank, relative_demand, previous_relative_demand, relative_demand_change FROM best_sellers_product_cluster_view ` +
    `WHERE report_date = '${reportDate}' AND report_granularity = '${granularity}'${country ? ` AND report_country_code = '${country}'` : ''}`,
  competitiveVisibility: (from: string, to: string, country: string, categoryId: string, trafficSource = 'ALL') =>
    `SELECT date, domain, is_your_domain, report_country_code, report_category_id, traffic_source, rank, ads_organic_ratio, page_overlap_rate, ` +
    `higher_position_rate, relative_visibility FROM competitive_visibility_competitor_view ` +
    `WHERE date BETWEEN '${from}' AND '${to}' AND report_country_code = '${country}' AND report_category_id = '${categoryId}' AND traffic_source = '${trafficSource}'`,
};

const num = (v: unknown): number => (v === undefined || v === null || v === '' ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number(v));

export interface MerchantReportsOptions {
  /** Maximum number of (country, category) pairs probed for competitive visibility per run. */
  maxVisibilityCategories?: number;
}

/**
 * Pulls the Merchant Center reports (performance + Market Insights) into the
 * local metrics tables. Uses the same credentials as everything else – no
 * extra setup on the Google side. Views that are not available for the
 * account (Market Insights disabled) are detected, remembered and skipped.
 */
export class MerchantReportsConnector implements Connector {
  readonly id = 'merchant_reports' as const;
  readonly maxBackfillDays = 730;
  readonly revisionWindowDays = 7;
  readonly lagDays = 1;

  constructor(
    private readonly api: MerchantApi,
    private readonly products: ProductStore,
    private readonly metrics: MetricsStore,
    private readonly state: ConnectorState,
    private readonly isApiConfigured: () => boolean,
    private readonly options: MerchantReportsOptions = {},
  ) {}

  isConfigured(): boolean {
    return this.isApiConfigured();
  }

  /** Views detected as unavailable (persisted so we do not hammer them every night). */
  unavailableViews(): ReportViewKey[] {
    return this.state.get<ReportViewKey[]>(this.id, 'unavailableViews', []);
  }

  private markUnavailable(view: ReportViewKey, available: boolean): void {
    const set = new Set(this.unavailableViews());
    if (available) set.delete(view);
    else set.add(view);
    this.state.set(this.id, 'unavailableViews', [...set]);
  }

  /** Probes every view with a tiny query and records which ones work. */
  async testConnection(): Promise<ConnectionCheck> {
    const today = isoDay();
    const probes: { key: ReportViewKey; query: string }[] = [
      { key: 'performance', query: MCQL.performance(today, today) },
      { key: 'priceCompetitiveness', query: MCQL.priceCompetitiveness() },
      { key: 'priceInsights', query: MCQL.priceInsights() },
      { key: 'bestSellers', query: MCQL.bestSellers(weekStart(today), 'WEEKLY') },
    ];
    const capabilities: ConnectionCheck['capabilities'] = [];
    let error: string | undefined;
    for (const probe of probes) {
      try {
        await this.api.searchReport(probe.query, 1);
        capabilities.push({ id: REPORT_VIEWS[probe.key], available: true });
        this.markUnavailable(probe.key, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        capabilities.push({ id: REPORT_VIEWS[probe.key], available: false, message });
        if (probe.key === 'performance') error = message;
        else this.markUnavailable(probe.key, false);
      }
    }
    // Competitive visibility shares the Market Insights entitlement with best sellers.
    const bestSellers = capabilities.find((c) => c.id === REPORT_VIEWS.bestSellers);
    capabilities.push({ id: REPORT_VIEWS.competitiveVisibility, available: bestSellers?.available ?? false, message: bestSellers?.message });
    this.markUnavailable('competitiveVisibility', bestSellers?.available ?? false);
    const marketInsightsMissing = MARKET_INSIGHTS_VIEWS.some((v) => capabilities.find((c) => c.id === REPORT_VIEWS[v] && !c.available));
    return { ok: !error, capabilities, hint: error ? undefined : marketInsightsMissing ? 'market_insights_disabled' : undefined, error };
  }

  async sync(window: SyncWindow, log: ConnectorLog): Promise<ConnectorSyncResult> {
    const warnings: string[] = [];
    const stats: ConnectorSyncResult['stats'] = {};
    const index = this.products.offerIndex();
    const resolve = (offerId: string | undefined, country: string | undefined): ProductRecord | undefined => resolveProduct(index, offerId, country);

    // ---- performance (always)
    const perfRows = await this.api.searchReport(MCQL.performance(window.from, window.to));
    const performance: PerformanceRow[] = [];
    let unmatched = 0;
    for (const row of perfRows) {
      const v = row.productPerformanceView;
      if (!v) continue;
      const date = parseReportDate(v.date);
      const product = resolve(v.offerId, v.customerCountryCode);
      if (!date) continue;
      if (!product) {
        unmatched += 1;
        continue;
      }
      performance.push({
        productName: product.name,
        date,
        marketingMethod: v.marketingMethod ?? 'ALL',
        country: v.customerCountryCode ?? 'ALL',
        impressions: num(v.impressions),
        clicks: num(v.clicks),
        conversions: num(v.conversions),
        conversionValueMicros: num(v.conversionValue?.amountMicros),
      });
    }
    stats.performanceRows = this.metrics.upsertPerformance(performance);
    stats.performanceUnmatched = unmatched;
    log.info(`Performance: ${perfRows.length} report rows, ${stats.performanceRows} stored, ${unmatched} without a local product`);

    // ---- Market Insights views (optional)
    const today = isoDay();
    const benchmarks = new Map<string, PriceBenchmarkRow>();
    await this.optionalView('priceCompetitiveness', log, warnings, async () => {
      const rows = await this.api.searchReport(MCQL.priceCompetitiveness());
      for (const row of rows) {
        const v = row.priceCompetitivenessProductView;
        if (!v) continue;
        const product = resolve(v.offerId, v.reportCountryCode);
        if (!product) continue;
        const key = `${product.name}|${v.reportCountryCode ?? 'ALL'}`;
        benchmarks.set(key, {
          ...(benchmarks.get(key) ?? emptyBenchmark(product.name, today, v.reportCountryCode ?? 'ALL')),
          priceMicros: numOrNull(v.price?.amountMicros),
          benchmarkPriceMicros: numOrNull(v.benchmarkPrice?.amountMicros),
          currency: v.benchmarkPrice?.currencyCode ?? v.price?.currencyCode ?? null,
        });
      }
      stats.priceCompetitivenessRows = rows.length;
    });
    await this.optionalView('priceInsights', log, warnings, async () => {
      const rows = await this.api.searchReport(MCQL.priceInsights());
      for (const row of rows) {
        const v = row.priceInsightsProductView;
        if (!v) continue;
        const product = resolve(v.offerId, undefined);
        if (!product) continue;
        // Price insights are not per country – attach to every benchmark row of the product, or create an ALL row.
        const keys = [...benchmarks.keys()].filter((k) => k.startsWith(`${product.name}|`));
        const targets = keys.length ? keys : [`${product.name}|ALL`];
        for (const key of targets) {
          benchmarks.set(key, {
            ...(benchmarks.get(key) ?? emptyBenchmark(product.name, today, key.split('|')[1] ?? 'ALL')),
            priceMicros: benchmarks.get(key)?.priceMicros ?? numOrNull(v.price?.amountMicros),
            currency: benchmarks.get(key)?.currency ?? v.price?.currencyCode ?? null,
            suggestedPriceMicros: numOrNull(v.suggestedPrice?.amountMicros),
            predictedImpressionsChange: numOrNull(v.predictedImpressionsChangeFraction),
            predictedClicksChange: numOrNull(v.predictedClicksChangeFraction),
            predictedConversionsChange: numOrNull(v.predictedConversionsChangeFraction),
            effectiveness: v.effectiveness ?? null,
          });
        }
      }
      stats.priceInsightsRows = rows.length;
    });
    if (benchmarks.size) stats.priceBenchmarkRows = this.metrics.upsertPriceBenchmarks([...benchmarks.values()]);

    const categories = new Map<string, Set<string>>(); // country -> category ids (for competitive visibility)
    await this.optionalView('bestSellers', log, warnings, async () => {
      const gtins = this.products.gtinIndex();
      const weeks = [...new Set(eachDay(window.from, window.to).map(weekStart))].filter((w) => w <= today);
      let total = 0;
      for (const week of weeks) {
        const rows = await this.api.searchReport(MCQL.bestSellers(week, 'WEEKLY'));
        const mapped: BestSellerRow[] = [];
        for (const row of rows) {
          const v = row.bestSellersProductClusterView;
          if (!v) continue;
          const reportDate = parseReportDate(v.reportDate) ?? week;
          const variantGtins = v.variantGtins ?? [];
          const matched = variantGtins.map((g) => gtins.get(g)).find(Boolean) ?? null;
          const country = v.reportCountryCode ?? 'ALL';
          const categoryId = String(v.reportCategoryId ?? '');
          if (matched) {
            const set = categories.get(country) ?? new Set<string>();
            set.add(categoryId);
            categories.set(country, set);
          }
          mapped.push({
            reportDate,
            granularity: v.reportGranularity ?? 'WEEKLY',
            country,
            categoryId,
            clusterKey: clusterKey(v.title, v.brand, variantGtins),
            title: v.title ?? null,
            brand: v.brand ?? null,
            category: v.categoryL2 ?? v.categoryL1 ?? null,
            gtins: variantGtins,
            rank: numOrNull(v.rank),
            previousRank: numOrNull(v.previousRank),
            relativeDemand: v.relativeDemand ?? null,
            previousRelativeDemand: v.previousRelativeDemand ?? null,
            demandChange: v.relativeDemandChange ?? null,
            inventoryStatus: v.inventoryStatus ?? null,
            productName: matched,
          });
        }
        total += this.metrics.upsertBestSellers(mapped);
      }
      stats.bestSellerRows = total;
      stats.bestSellerWeeks = weeks.length;
    });

    await this.optionalView('competitiveVisibility', log, warnings, async () => {
      const pairs: { country: string; categoryId: string }[] = [];
      for (const [country, ids] of categories) for (const categoryId of ids) pairs.push({ country, categoryId });
      const limit = this.options.maxVisibilityCategories ?? 20;
      let total = 0;
      for (const pair of pairs.slice(0, limit)) {
        const rows = await this.api.searchReport(MCQL.competitiveVisibility(window.from, window.to, pair.country, pair.categoryId));
        const mapped: CompetitiveVisibilityRow[] = [];
        for (const row of rows) {
          const v = row.competitiveVisibilityCompetitorView;
          if (!v) continue;
          const date = parseReportDate(v.date);
          if (!date || !v.domain) continue;
          mapped.push({
            date,
            country: v.reportCountryCode ?? pair.country,
            categoryId: String(v.reportCategoryId ?? pair.categoryId),
            trafficSource: v.trafficSource ?? 'ALL',
            domain: v.domain,
            isYourDomain: !!v.isYourDomain,
            rank: numOrNull(v.rank),
            relativeVisibility: numOrNull(v.relativeVisibility),
            pageOverlapRate: numOrNull(v.pageOverlapRate),
            higherPositionRate: numOrNull(v.higherPositionRate),
            adsOrganicRatio: numOrNull(v.adsOrganicRatio),
          });
        }
        total += this.metrics.upsertCompetitiveVisibility(mapped);
      }
      stats.competitiveVisibilityRows = total;
      stats.competitiveVisibilityCategories = Math.min(pairs.length, limit);
    });

    const gauges: ConnectorSyncResult['gauges'] = {};
    if (this.unavailableViews().length) gauges.unavailableViews = this.unavailableViews().map((v) => REPORT_VIEWS[v]);
    return { stats, gauges, warnings };
  }

  /** Runs a Market Insights view; "not available" errors are remembered instead of failing the sync. */
  private async optionalView(view: ReportViewKey, log: ConnectorLog, warnings: string[], fn: () => Promise<void>): Promise<void> {
    if (this.unavailableViews().includes(view)) {
      log.info(`Skipping ${REPORT_VIEWS[view]} (not available for this account – re-check with "Test connection")`);
      return;
    }
    try {
      await fn();
    } catch (err) {
      if (err instanceof MerchantApiError && (err.status === 403 || err.status === 400 || err.status === 404)) {
        this.markUnavailable(view, false);
        const message = `${REPORT_VIEWS[view]} is not available: ${err.message}`;
        warnings.push(message);
        log.warn(message);
        return;
      }
      throw err;
    }
  }
}

function emptyBenchmark(productName: string, date: string, country: string): PriceBenchmarkRow {
  return {
    productName,
    date,
    country,
    priceMicros: null,
    benchmarkPriceMicros: null,
    currency: null,
    suggestedPriceMicros: null,
    predictedImpressionsChange: null,
    predictedClicksChange: null,
    predictedConversionsChange: null,
    effectiveness: null,
  };
}

export function clusterKey(title: string | undefined, brand: string | undefined, gtins: string[]): string {
  return createHash('sha1').update(`${brand ?? ''}|${title ?? ''}|${[...gtins].sort().join(',')}`).digest('hex').slice(0, 16);
}

/**
 * offer_id is unique per (content language, feed label), so the same id may
 * exist in several products. Prefer the product whose feed label equals the
 * report country, then fall back to the first product with that offer id.
 */
export function resolveProduct(index: Map<string, ProductRecord[]>, offerId: string | undefined, country: string | undefined): ProductRecord | undefined {
  if (!offerId) return undefined;
  const candidates = index.get(offerId) ?? index.get(offerId.toLowerCase());
  if (!candidates?.length) return undefined;
  if (candidates.length === 1) return candidates[0];
  if (country) {
    const byLabel = candidates.find((c) => c.feedLabel?.toUpperCase() === country.toUpperCase());
    if (byLabel) return byLabel;
  }
  return candidates[0];
}

export type { ReportRow };
