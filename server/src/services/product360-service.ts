import { addDays } from '../util/dates.js';
import type { BestSellerRow, DailyPoint, MetricsStore, PerformanceTotals, PriceBenchmarkRow, SearchPoint, SearchTotals, UrlMapping } from './metrics-store.js';
import type { MetricsSyncService } from './metrics-sync-service.js';
import type { ProductRecord, ProductStore, ProductWithDetails, Recommendation } from './product-store.js';
import type { ProductSignal, SignalsService } from './signals-service.js';

export interface Product360 {
  product: ProductWithDetails;
  signal: ProductSignal | null;
  /** Last 90 days, per marketing method. */
  /** `previousTotals` is null when the comparison window is not fully covered by loaded data (avoids bogus +9000 % deltas). */
  performance: { from: string; to: string; series: { method: string; points: DailyPoint[] }[]; totals: PerformanceTotals; previousTotals: PerformanceTotals | null };
  price: { latest: PriceBenchmarkRow | null; series: PriceBenchmarkRow[] };
  bestSellers: BestSellerRow[];
  /** Competitors in the product's best-seller categories (average of the last 28 days). */
  competitors: ReturnType<MetricsStore['competitiveVisibility']>['rows'];
  /** Organic search (Search Console); `mapping` is null when the product has no landing page inside the property. */
  search: {
    enabled: boolean;
    mapping: UrlMapping | null;
    series: { appearance: string; points: SearchPoint[] }[];
    totals: SearchTotals;
    previousTotals: SearchTotals | null;
  };
  freshness: { performanceThrough: string | null; bestSellersThrough: string | null; visibilityThrough: string | null; searchThrough: string | null };
}

export interface DashboardInsights {
  enabled: boolean;
  computed: boolean;
  windowEnd: string | null;
  totals: { current: PerformanceTotals & { products: number }; previous: PerformanceTotals & { products: number }; window: { from: string; to: string } };
  series: { method: string; points: DailyPoint[] }[];
  recommendationCounts: Record<string, number>;
  /** Organic totals over mapped product pages (7 days vs previous 7 days); null when Search Console is off. */
  organic: { current: SearchTotals & { pages: number }; previous: SearchTotals & { pages: number }; through: string | null } | null;
  optimise: ProductRecord[];
  focus: ProductRecord[];
  fix: ProductRecord[];
  priceOpportunities: ProductRecord[];
  watch: ProductRecord[];
  trendingNotCarried: BestSellerRow[];
  connectors: ReturnType<MetricsSyncService['status']>['connectors'];
}

/** A comparison window starting at `from` is only meaningful when data reaches back that far. */
function covered(earliest: string | null, from: string): boolean {
  return earliest !== null && earliest <= from;
}

/** Read model over the metric tables; nothing here talks to Google. */
export class Product360Service {
  constructor(
    private readonly products: ProductStore,
    private readonly metrics: MetricsStore,
    private readonly signals: SignalsService,
    private readonly metricsSync: MetricsSyncService,
    private readonly searchEnabled: () => boolean = () => false,
  ) {}

  forProduct(product: ProductWithDetails, days = 90): Product360 {
    const end = this.signals.windowEnd();
    const from = addDays(end, -(days - 1));
    const prevFrom = addDays(from, -days);
    const prevTo = addDays(from, -1);
    const signal = this.signals.get(product.name);
    const latest = this.metrics.latestPriceBenchmark(product.name);
    if (signal && latest) {
      signal.market.benchmarkPriceMicros = latest.benchmarkPriceMicros;
      signal.market.suggestedPriceMicros = latest.suggestedPriceMicros;
    }
    const bestSellers = this.metrics.bestSellersForProduct(product.name);
    const competitorRows: Product360['competitors'] = [];
    const seen = new Set<string>();
    for (const b of bestSellers) {
      const key = `${b.country}|${b.categoryId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      competitorRows.push(...this.metrics.competitiveVisibility({ country: b.country, categoryId: b.categoryId, from: addDays(end, -27), to: end }).rows);
    }
    return {
      product,
      signal,
      performance: {
        from,
        to: end,
        series: this.metrics.performanceSeries(product.name, from, end),
        totals: this.metrics.performanceTotals(product.name, from, end),
        previousTotals: covered(this.metrics.earliestPerformanceDate(), prevFrom) ? this.metrics.performanceTotals(product.name, prevFrom, prevTo) : null,
      },
      price: { latest, series: this.metrics.priceBenchmarkSeries(product.name, from, end) },
      bestSellers,
      competitors: competitorRows,
      search: {
        enabled: this.searchEnabled(),
        mapping: this.metrics.urlFor(product.name),
        series: this.metrics.searchSeriesForProduct(product.name, from, end),
        totals: this.metrics.searchTotalsForProduct(product.name, from, end),
        previousTotals: covered(this.metrics.earliestSearchDate(), prevFrom) ? this.metrics.searchTotalsForProduct(product.name, prevFrom, prevTo) : null,
      },
      freshness: {
        performanceThrough: this.metrics.latestPerformanceDate(),
        bestSellersThrough: this.metrics.latestBestSellerReportDate(),
        visibilityThrough: this.metrics.latestVisibilityDate(),
        searchThrough: this.metrics.latestSearchDate(),
      },
    };
  }

  dashboard(enabled: boolean): DashboardInsights {
    const status = this.metricsSync.status();
    const computed = status.signals.computed;
    const end = this.signals.windowEnd();
    const from = addDays(end, -6);
    const prevFrom = addDays(from, -7);
    const prevTo = addDays(from, -1);
    const pick = (r: Recommendation, n = 8) => (computed ? this.products.listByRecommendation(r, n) : []);
    return {
      enabled,
      computed,
      windowEnd: computed ? end : null,
      totals: { current: this.metrics.catalogueTotals(from, end), previous: this.metrics.catalogueTotals(prevFrom, prevTo), window: { from, to: end } },
      series: this.metrics.catalogueSeries(addDays(end, -27), end),
      recommendationCounts: computed ? this.products.recommendationCounts() : {},
      organic: this.searchEnabled()
        ? (() => {
            const through = this.metrics.latestSearchDate();
            const to = through && through < end ? through : end;
            const f = addDays(to, -6);
            return { current: this.metrics.searchCatalogueTotals(f, to), previous: this.metrics.searchCatalogueTotals(addDays(f, -7), addDays(f, -1)), through };
          })()
        : null,
      optimise: pick('OPTIMISE_LISTING'),
      focus: pick('SCALE'),
      fix: pick('FIX'),
      priceOpportunities: pick('REPRICE'),
      watch: pick('WATCH'),
      trendingNotCarried: this.metrics.listBestSellers({ carried: false, demandChange: 'RISER', limit: 8 }).items,
      connectors: status.connectors,
    };
  }
}
