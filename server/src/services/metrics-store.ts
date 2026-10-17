import { Database, fromJson, now, toJson, type Row } from '../db/database.js';
import { addDays } from '../util/dates.js';

// ---------------------------------------------------------------- row types
export interface PerformanceRow {
  productName: string;
  date: string;
  marketingMethod: 'ADS' | 'ORGANIC' | 'ALL' | string;
  country: string;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValueMicros: number;
}

export interface PriceBenchmarkRow {
  productName: string;
  date: string;
  country: string;
  priceMicros: number | null;
  benchmarkPriceMicros: number | null;
  currency: string | null;
  suggestedPriceMicros: number | null;
  predictedImpressionsChange: number | null;
  predictedClicksChange: number | null;
  predictedConversionsChange: number | null;
  effectiveness: string | null;
}

export interface BestSellerRow {
  reportDate: string;
  granularity: string;
  country: string;
  categoryId: string;
  clusterKey: string;
  title: string | null;
  brand: string | null;
  category: string | null;
  gtins: string[];
  rank: number | null;
  previousRank: number | null;
  relativeDemand: string | null;
  previousRelativeDemand: string | null;
  demandChange: string | null;
  inventoryStatus: string | null;
  productName: string | null;
  /** joined */
  productId?: string | null;
  offerId?: string | null;
}

export interface CompetitiveVisibilityRow {
  date: string;
  country: string;
  categoryId: string;
  trafficSource: string;
  domain: string;
  isYourDomain: boolean;
  rank: number | null;
  relativeVisibility: number | null;
  pageOverlapRate: number | null;
  higherPositionRate: number | null;
  adsOrganicRatio: number | null;
}

export interface SearchPageRow {
  canonicalUrl: string;
  date: string;
  appearance: 'ALL' | 'MERCHANT_LISTINGS' | string;
  clicks: number;
  impressions: number;
  position: number | null;
}

export interface SearchPoint {
  date: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

export interface SearchTotals {
  clicks: number;
  impressions: number;
  ctr: number | null;
  /** impression-weighted average position */
  position: number | null;
}

export interface SearchQueryRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface UrlMapping {
  productName: string;
  canonicalUrl: string;
  shared: boolean;
}

export interface DailyPoint {
  date: string;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValueMicros: number;
}

export interface PerformanceTotals {
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValueMicros: number;
  ctr: number | null;
}

export interface MetricsSyncRun {
  id: number;
  connector: string;
  status: 'running' | 'success' | 'failed';
  windowFrom: string | null;
  windowTo: string | null;
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, unknown>;
  error: string | null;
}

function rowToRun(row: Row): MetricsSyncRun {
  return {
    id: Number(row.id),
    connector: row.connector as string,
    status: row.status as MetricsSyncRun['status'],
    windowFrom: (row.window_from as string | null) ?? null,
    windowTo: (row.window_to as string | null) ?? null,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    stats: fromJson<Record<string, unknown>>(row.stats, {}),
    error: (row.error as string | null) ?? null,
  };
}

function rowToBestSeller(row: Row): BestSellerRow {
  return {
    reportDate: row.report_date as string,
    granularity: row.granularity as string,
    country: row.country as string,
    categoryId: row.category_id as string,
    clusterKey: row.cluster_key as string,
    title: (row.title as string | null) ?? null,
    brand: (row.brand as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    gtins: fromJson<string[]>(row.gtins, []),
    rank: row.rank === null || row.rank === undefined ? null : Number(row.rank),
    previousRank: row.previous_rank === null || row.previous_rank === undefined ? null : Number(row.previous_rank),
    relativeDemand: (row.relative_demand as string | null) ?? null,
    previousRelativeDemand: (row.previous_relative_demand as string | null) ?? null,
    demandChange: (row.demand_change as string | null) ?? null,
    inventoryStatus: (row.inventory_status as string | null) ?? null,
    productName: (row.product_name as string | null) ?? null,
    productId: (row.product_id as string | null) ?? null,
    offerId: (row.offer_id as string | null) ?? null,
  };
}

function rowToBenchmark(row: Row): PriceBenchmarkRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    productName: row.product_name as string,
    date: row.date as string,
    country: row.country as string,
    priceMicros: num(row.price_micros),
    benchmarkPriceMicros: num(row.benchmark_price_micros),
    currency: (row.currency as string | null) ?? null,
    suggestedPriceMicros: num(row.suggested_price_micros),
    predictedImpressionsChange: num(row.predicted_impressions_change),
    predictedClicksChange: num(row.predicted_clicks_change),
    predictedConversionsChange: num(row.predicted_conversions_change),
    effectiveness: (row.effectiveness as string | null) ?? null,
  };
}

function rowToVisibility(row: Row): CompetitiveVisibilityRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    date: row.date as string,
    country: row.country as string,
    categoryId: row.category_id as string,
    trafficSource: row.traffic_source as string,
    domain: row.domain as string,
    isYourDomain: Number(row.is_your_domain) === 1,
    rank: num(row.rank),
    relativeVisibility: num(row.relative_visibility),
    pageOverlapRate: num(row.page_overlap_rate),
    higherPositionRate: num(row.higher_position_rate),
    adsOrganicRatio: num(row.ads_organic_ratio),
  };
}

/**
 * Repository for every time series / market table that Product360 reads.
 * Writers are the connectors, readers are the signals service, the API and
 * the workflow engine.
 */
export class MetricsStore {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------ writes
  upsertPerformance(rows: PerformanceRow[]): number {
    let written = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        if (r.impressions === 0 && r.clicks === 0 && r.conversions === 0) {
          // Sparse storage: a zero row only has to remove a previously stored non-zero value.
          this.db.run('DELETE FROM mc_product_performance_daily WHERE product_name = ? AND date = ? AND marketing_method = ? AND country = ?', [r.productName, r.date, r.marketingMethod, r.country]);
          continue;
        }
        this.db.run(
          `INSERT INTO mc_product_performance_daily (product_name, date, marketing_method, country, impressions, clicks, conversions, conversion_value_micros)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(product_name, date, marketing_method, country) DO UPDATE SET impressions = excluded.impressions, clicks = excluded.clicks,
             conversions = excluded.conversions, conversion_value_micros = excluded.conversion_value_micros`,
          [r.productName, r.date, r.marketingMethod, r.country, r.impressions, r.clicks, r.conversions, r.conversionValueMicros],
        );
        written += 1;
      }
    });
    return written;
  }

  upsertPriceBenchmarks(rows: PriceBenchmarkRow[]): number {
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run(
          `INSERT INTO mc_price_benchmark_daily (product_name, date, country, price_micros, benchmark_price_micros, currency, suggested_price_micros,
             predicted_impressions_change, predicted_clicks_change, predicted_conversions_change, effectiveness)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(product_name, date, country) DO UPDATE SET
             price_micros = COALESCE(excluded.price_micros, mc_price_benchmark_daily.price_micros),
             benchmark_price_micros = COALESCE(excluded.benchmark_price_micros, mc_price_benchmark_daily.benchmark_price_micros),
             currency = COALESCE(excluded.currency, mc_price_benchmark_daily.currency),
             suggested_price_micros = COALESCE(excluded.suggested_price_micros, mc_price_benchmark_daily.suggested_price_micros),
             predicted_impressions_change = COALESCE(excluded.predicted_impressions_change, mc_price_benchmark_daily.predicted_impressions_change),
             predicted_clicks_change = COALESCE(excluded.predicted_clicks_change, mc_price_benchmark_daily.predicted_clicks_change),
             predicted_conversions_change = COALESCE(excluded.predicted_conversions_change, mc_price_benchmark_daily.predicted_conversions_change),
             effectiveness = COALESCE(excluded.effectiveness, mc_price_benchmark_daily.effectiveness)`,
          [
            r.productName,
            r.date,
            r.country,
            r.priceMicros,
            r.benchmarkPriceMicros,
            r.currency,
            r.suggestedPriceMicros,
            r.predictedImpressionsChange,
            r.predictedClicksChange,
            r.predictedConversionsChange,
            r.effectiveness,
          ],
        );
      }
    });
    return rows.length;
  }

  upsertBestSellers(rows: BestSellerRow[]): number {
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run(
          `INSERT INTO mc_best_sellers (report_date, granularity, country, category_id, cluster_key, title, brand, category, gtins, rank, previous_rank,
             relative_demand, previous_relative_demand, demand_change, inventory_status, product_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(report_date, granularity, country, category_id, cluster_key) DO UPDATE SET title = excluded.title, brand = excluded.brand,
             category = excluded.category, gtins = excluded.gtins, rank = excluded.rank, previous_rank = excluded.previous_rank,
             relative_demand = excluded.relative_demand, previous_relative_demand = excluded.previous_relative_demand, demand_change = excluded.demand_change,
             inventory_status = excluded.inventory_status, product_name = excluded.product_name`,
          [
            r.reportDate,
            r.granularity,
            r.country,
            r.categoryId,
            r.clusterKey,
            r.title,
            r.brand,
            r.category,
            toJson(r.gtins),
            r.rank,
            r.previousRank,
            r.relativeDemand,
            r.previousRelativeDemand,
            r.demandChange,
            r.inventoryStatus,
            r.productName,
          ],
        );
      }
    });
    return rows.length;
  }

  upsertCompetitiveVisibility(rows: CompetitiveVisibilityRow[]): number {
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run(
          `INSERT INTO mc_competitive_visibility_daily (date, country, category_id, traffic_source, domain, is_your_domain, rank, relative_visibility,
             page_overlap_rate, higher_position_rate, ads_organic_ratio)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(date, country, category_id, traffic_source, domain) DO UPDATE SET is_your_domain = excluded.is_your_domain, rank = excluded.rank,
             relative_visibility = excluded.relative_visibility, page_overlap_rate = excluded.page_overlap_rate,
             higher_position_rate = excluded.higher_position_rate, ads_organic_ratio = excluded.ads_organic_ratio`,
          [r.date, r.country, r.categoryId, r.trafficSource, r.domain, r.isYourDomain ? 1 : 0, r.rank, r.relativeVisibility, r.pageOverlapRate, r.higherPositionRate, r.adsOrganicRatio],
        );
      }
    });
    return rows.length;
  }

  /** Deletes daily rows older than the retention window. Returns the number of removed rows. */
  prune(retentionDays: number, today: string): number {
    const cutoff = addDays(today, -retentionDays);
    let removed = 0;
    removed += this.db.run('DELETE FROM mc_product_performance_daily WHERE date < ?', [cutoff]).changes;
    removed += this.db.run('DELETE FROM mc_price_benchmark_daily WHERE date < ?', [cutoff]).changes;
    removed += this.db.run('DELETE FROM mc_best_sellers WHERE report_date < ?', [cutoff]).changes;
    removed += this.db.run('DELETE FROM mc_competitive_visibility_daily WHERE date < ?', [cutoff]).changes;
    removed += this.db.run('DELETE FROM sc_page_daily WHERE date < ?', [cutoff]).changes;
    removed += this.db.run('DELETE FROM sc_page_queries WHERE window_to < ?', [cutoff]).changes;
    return removed;
  }

  // ------------------------------------------------------------ url map (Search Console join key)
  /** Replaces the whole map. `entries` already carry canonical URLs; products without a URL are dropped. */
  rebuildUrlMap(entries: { productName: string; canonicalUrl: string }[]): { mapped: number; shared: number } {
    const byUrl = new Map<string, number>();
    for (const e of entries) byUrl.set(e.canonicalUrl, (byUrl.get(e.canonicalUrl) ?? 0) + 1);
    const ts = now();
    let shared = 0;
    this.db.transaction(() => {
      this.db.run('DELETE FROM product_url_map');
      for (const e of entries) {
        const isShared = (byUrl.get(e.canonicalUrl) ?? 0) > 1;
        if (isShared) shared += 1;
        this.db.run('INSERT INTO product_url_map (product_name, canonical_url, shared_url, updated_at) VALUES (?, ?, ?, ?)', [e.productName, e.canonicalUrl, isShared ? 1 : 0, ts]);
      }
    });
    return { mapped: entries.length, shared };
  }

  urlFor(productName: string): UrlMapping | null {
    const row = this.db.get<{ canonical_url: string; shared_url: number }>('SELECT canonical_url, shared_url FROM product_url_map WHERE product_name = ?', [productName]);
    return row ? { productName, canonicalUrl: row.canonical_url, shared: Number(row.shared_url) === 1 } : null;
  }

  /** All mapped URLs (for matching Search Console pages). */
  mappedUrls(): Set<string> {
    return new Set(this.db.all<{ u: string }>('SELECT DISTINCT canonical_url AS u FROM product_url_map').map((r) => r.u));
  }

  urlMapStats(): { mappedProducts: number; sharedProducts: number; distinctUrls: number } {
    const r = this.db.get<{ m: number; s: number; d: number }>('SELECT COUNT(*) AS m, COALESCE(SUM(shared_url),0) AS s, COUNT(DISTINCT canonical_url) AS d FROM product_url_map');
    return { mappedProducts: Number(r?.m ?? 0), sharedProducts: Number(r?.s ?? 0), distinctUrls: Number(r?.d ?? 0) };
  }

  /** Pages with traffic that do not belong to any product (diagnostics). */
  unmappedPages(from: string, to: string, limit = 50): { canonicalUrl: string; clicks: number; impressions: number }[] {
    return this.db
      .all<{ u: string; c: number; i: number }>(
        `SELECT s.canonical_url AS u, SUM(s.clicks) AS c, SUM(s.impressions) AS i FROM sc_page_daily s
         WHERE s.appearance = 'ALL' AND s.date BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM product_url_map m WHERE m.canonical_url = s.canonical_url)
         GROUP BY s.canonical_url ORDER BY i DESC LIMIT ?`,
        [from, to, limit],
      )
      .map((r) => ({ canonicalUrl: r.u, clicks: Number(r.c), impressions: Number(r.i) }));
  }

  // ------------------------------------------------------------ writes: search console
  upsertSearchPages(rows: SearchPageRow[]): number {
    let written = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        if (r.clicks === 0 && r.impressions === 0) {
          this.db.run('DELETE FROM sc_page_daily WHERE canonical_url = ? AND date = ? AND appearance = ?', [r.canonicalUrl, r.date, r.appearance]);
          continue;
        }
        this.db.run(
          `INSERT INTO sc_page_daily (canonical_url, date, appearance, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(canonical_url, date, appearance) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions, position = excluded.position`,
          [r.canonicalUrl, r.date, r.appearance, r.clicks, r.impressions, r.position],
        );
        written += 1;
      }
    });
    return written;
  }

  saveQueries(canonicalUrl: string, window: { from: string; to: string }, rows: SearchQueryRow[]): void {
    const ts = now();
    this.db.transaction(() => {
      this.db.run('DELETE FROM sc_page_queries WHERE canonical_url = ?', [canonicalUrl]);
      for (const r of rows) {
        this.db.run(
          'INSERT INTO sc_page_queries (canonical_url, query, window_from, window_to, clicks, impressions, ctr, position, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [canonicalUrl, r.query, window.from, window.to, r.clicks, r.impressions, r.ctr, r.position, ts],
        );
      }
    });
  }

  getQueries(canonicalUrl: string): { rows: SearchQueryRow[]; window: { from: string; to: string }; fetchedAt: string } | null {
    const rows = this.db.all<Row>('SELECT * FROM sc_page_queries WHERE canonical_url = ? ORDER BY impressions DESC', [canonicalUrl]);
    if (!rows.length) return null;
    const first = rows[0]!;
    return {
      window: { from: first.window_from as string, to: first.window_to as string },
      fetchedAt: first.fetched_at as string,
      rows: rows.map((r) => ({
        query: r.query as string,
        clicks: Number(r.clicks),
        impressions: Number(r.impressions),
        ctr: r.ctr === null ? null : Number(r.ctr),
        position: r.position === null ? null : Number(r.position),
      })),
    };
  }

  // ------------------------------------------------------------ reads: search console
  latestSearchDate(): string | null {
    return this.db.get<{ d: string | null }>('SELECT MAX(date) AS d FROM sc_page_daily')?.d ?? null;
  }

  earliestSearchDate(): string | null {
    return this.db.get<{ d: string | null }>('SELECT MIN(date) AS d FROM sc_page_daily')?.d ?? null;
  }

  searchSeriesForProduct(productName: string, from: string, to: string): { appearance: string; points: SearchPoint[] }[] {
    const mapping = this.urlFor(productName);
    if (!mapping) return [];
    const rows = this.db.all<{ appearance: string; date: string; clicks: number; impressions: number; position: number | null }>(
      'SELECT appearance, date, clicks, impressions, position FROM sc_page_daily WHERE canonical_url = ? AND date BETWEEN ? AND ? ORDER BY date',
      [mapping.canonicalUrl, from, to],
    );
    const by = new Map<string, SearchPoint[]>();
    for (const r of rows) {
      const list = by.get(r.appearance) ?? [];
      list.push({ date: r.date, clicks: Number(r.clicks), impressions: Number(r.impressions), position: r.position === null ? null : Number(r.position) });
      by.set(r.appearance, list);
    }
    return [...by.entries()].map(([appearance, points]) => ({ appearance, points }));
  }

  searchTotalsForProduct(productName: string, from: string, to: string, appearance = 'ALL'): SearchTotals {
    const mapping = this.urlFor(productName);
    if (!mapping) return { clicks: 0, impressions: 0, ctr: null, position: null };
    const r = this.db.get<{ c: number; i: number; wp: number | null }>(
      `SELECT COALESCE(SUM(clicks),0) AS c, COALESCE(SUM(impressions),0) AS i, SUM(position * impressions) AS wp
       FROM sc_page_daily WHERE canonical_url = ? AND appearance = ? AND date BETWEEN ? AND ?`,
      [mapping.canonicalUrl, appearance, from, to],
    );
    return this.searchTotals(r);
  }

  /** Per-product totals for several windows (signals). Shared URLs are attributed to every product using them. */
  searchTotalsByProduct(windows: { key: string; from: string; to: string }[]): Map<string, Record<string, SearchTotals>> {
    const out = new Map<string, Record<string, SearchTotals>>();
    for (const w of windows) {
      const rows = this.db.all<{ product_name: string; c: number; i: number; wp: number | null }>(
        `SELECT m.product_name, SUM(s.clicks) AS c, SUM(s.impressions) AS i, SUM(s.position * s.impressions) AS wp
         FROM sc_page_daily s JOIN product_url_map m ON m.canonical_url = s.canonical_url
         WHERE s.appearance = 'ALL' AND s.date BETWEEN ? AND ? GROUP BY m.product_name`,
        [w.from, w.to],
      );
      for (const r of rows) {
        const entry = out.get(r.product_name) ?? {};
        entry[w.key] = this.searchTotals(r);
        out.set(r.product_name, entry);
      }
    }
    return out;
  }

  /** Organic totals over all mapped product pages (dashboard). */
  searchCatalogueTotals(from: string, to: string): SearchTotals & { pages: number } {
    const r = this.db.get<{ c: number; i: number; wp: number | null; p: number }>(
      `SELECT COALESCE(SUM(s.clicks),0) AS c, COALESCE(SUM(s.impressions),0) AS i, SUM(s.position * s.impressions) AS wp, COUNT(DISTINCT s.canonical_url) AS p
       FROM sc_page_daily s WHERE s.appearance = 'ALL' AND s.date BETWEEN ? AND ? AND EXISTS (SELECT 1 FROM product_url_map m WHERE m.canonical_url = s.canonical_url)`,
      [from, to],
    );
    return { ...this.searchTotals(r), pages: Number(r?.p ?? 0) };
  }

  searchCatalogueSeries(from: string, to: string): SearchPoint[] {
    return this.db
      .all<{ date: string; c: number; i: number; wp: number | null }>(
        `SELECT s.date, SUM(s.clicks) AS c, SUM(s.impressions) AS i, SUM(s.position * s.impressions) AS wp
         FROM sc_page_daily s WHERE s.appearance = 'ALL' AND s.date BETWEEN ? AND ? AND EXISTS (SELECT 1 FROM product_url_map m WHERE m.canonical_url = s.canonical_url)
         GROUP BY s.date ORDER BY s.date`,
        [from, to],
      )
      .map((r) => ({ date: r.date, clicks: Number(r.c), impressions: Number(r.i), position: r.i && r.wp !== null ? Math.round((Number(r.wp) / Number(r.i)) * 10) / 10 : null }));
  }

  private searchTotals(r: { c?: number; i?: number; wp?: number | null } | undefined): SearchTotals {
    const clicks = Number(r?.c ?? 0);
    const impressions = Number(r?.i ?? 0);
    return {
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : null,
      position: impressions > 0 && r?.wp !== null && r?.wp !== undefined ? Math.round((Number(r.wp) / impressions) * 10) / 10 : null,
    };
  }

  // ------------------------------------------------------------ reads: performance
  /** Daily series for a product, optionally split by marketing method. */
  performanceSeries(productName: string, from: string, to: string): { method: string; points: DailyPoint[] }[] {
    const rows = this.db.all<{ marketing_method: string; date: string; impressions: number; clicks: number; conversions: number; conversion_value_micros: number }>(
      `SELECT marketing_method, date, SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(conversions) AS conversions, SUM(conversion_value_micros) AS conversion_value_micros
       FROM mc_product_performance_daily WHERE product_name = ? AND date BETWEEN ? AND ? GROUP BY marketing_method, date ORDER BY date`,
      [productName, from, to],
    );
    const byMethod = new Map<string, DailyPoint[]>();
    for (const r of rows) {
      const list = byMethod.get(r.marketing_method) ?? [];
      list.push({ date: r.date, impressions: Number(r.impressions), clicks: Number(r.clicks), conversions: Number(r.conversions), conversionValueMicros: Number(r.conversion_value_micros) });
      byMethod.set(r.marketing_method, list);
    }
    return [...byMethod.entries()].map(([method, points]) => ({ method, points }));
  }

  performanceTotals(productName: string, from: string, to: string): PerformanceTotals {
    const r = this.db.get<{ i: number; c: number; cv: number; v: number }>(
      `SELECT COALESCE(SUM(impressions),0) AS i, COALESCE(SUM(clicks),0) AS c, COALESCE(SUM(conversions),0) AS cv, COALESCE(SUM(conversion_value_micros),0) AS v
       FROM mc_product_performance_daily WHERE product_name = ? AND date BETWEEN ? AND ?`,
      [productName, from, to],
    );
    return this.totals(r);
  }

  /** Totals for the whole catalogue in a window (dashboard). */
  catalogueTotals(from: string, to: string): PerformanceTotals & { products: number } {
    const r = this.db.get<{ i: number; c: number; cv: number; v: number; p: number }>(
      `SELECT COALESCE(SUM(impressions),0) AS i, COALESCE(SUM(clicks),0) AS c, COALESCE(SUM(conversions),0) AS cv, COALESCE(SUM(conversion_value_micros),0) AS v,
              COUNT(DISTINCT product_name) AS p
       FROM mc_product_performance_daily WHERE date BETWEEN ? AND ?`,
      [from, to],
    );
    return { ...this.totals(r), products: Number(r?.p ?? 0) };
  }

  /** Daily catalogue totals (dashboard chart). */
  catalogueSeries(from: string, to: string): { method: string; points: DailyPoint[] }[] {
    const rows = this.db.all<{ marketing_method: string; date: string; impressions: number; clicks: number; conversions: number; conversion_value_micros: number }>(
      `SELECT marketing_method, date, SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(conversions) AS conversions, SUM(conversion_value_micros) AS conversion_value_micros
       FROM mc_product_performance_daily WHERE date BETWEEN ? AND ? GROUP BY marketing_method, date ORDER BY date`,
      [from, to],
    );
    const byMethod = new Map<string, DailyPoint[]>();
    for (const r of rows) {
      const list = byMethod.get(r.marketing_method) ?? [];
      list.push({ date: r.date, impressions: Number(r.impressions), clicks: Number(r.clicks), conversions: Number(r.conversions), conversionValueMicros: Number(r.conversion_value_micros) });
      byMethod.set(r.marketing_method, list);
    }
    return [...byMethod.entries()].map(([method, points]) => ({ method, points }));
  }

  /**
   * Per-product totals for two windows at once (used by the signals service
   * for the whole catalogue in one query).
   */
  performanceByProduct(windows: { key: string; from: string; to: string }[]): Map<string, Record<string, PerformanceTotals>> {
    const out = new Map<string, Record<string, PerformanceTotals>>();
    for (const w of windows) {
      const rows = this.db.all<{ product_name: string; i: number; c: number; cv: number; v: number }>(
        `SELECT product_name, SUM(impressions) AS i, SUM(clicks) AS c, SUM(conversions) AS cv, SUM(conversion_value_micros) AS v
         FROM mc_product_performance_daily WHERE date BETWEEN ? AND ? GROUP BY product_name`,
        [w.from, w.to],
      );
      for (const r of rows) {
        const entry = out.get(r.product_name) ?? {};
        entry[w.key] = this.totals(r);
        out.set(r.product_name, entry);
      }
    }
    return out;
  }

  latestPerformanceDate(): string | null {
    return this.db.get<{ d: string | null }>('SELECT MAX(date) AS d FROM mc_product_performance_daily')?.d ?? null;
  }

  earliestPerformanceDate(): string | null {
    return this.db.get<{ d: string | null }>('SELECT MIN(date) AS d FROM mc_product_performance_daily')?.d ?? null;
  }

  private totals(r: { i?: number; c?: number; cv?: number; v?: number } | undefined): PerformanceTotals {
    const impressions = Number(r?.i ?? 0);
    const clicks = Number(r?.c ?? 0);
    return { impressions, clicks, conversions: Number(r?.cv ?? 0), conversionValueMicros: Number(r?.v ?? 0), ctr: impressions > 0 ? clicks / impressions : null };
  }

  // ------------------------------------------------------------ reads: price
  latestPriceBenchmark(productName: string): PriceBenchmarkRow | null {
    const row = this.db.get('SELECT * FROM mc_price_benchmark_daily WHERE product_name = ? ORDER BY date DESC LIMIT 1', [productName]);
    return row ? rowToBenchmark(row) : null;
  }

  priceBenchmarkSeries(productName: string, from: string, to: string): PriceBenchmarkRow[] {
    return this.db.all('SELECT * FROM mc_price_benchmark_daily WHERE product_name = ? AND date BETWEEN ? AND ? ORDER BY date', [productName, from, to]).map(rowToBenchmark);
  }

  /** Latest benchmark row per product (signals). */
  latestPriceBenchmarks(): Map<string, PriceBenchmarkRow> {
    const rows = this.db.all(
      `SELECT b.* FROM mc_price_benchmark_daily b
       JOIN (SELECT product_name, MAX(date) AS d FROM mc_price_benchmark_daily GROUP BY product_name) m ON m.product_name = b.product_name AND m.d = b.date`,
    );
    return new Map(rows.map((r) => [r.product_name as string, rowToBenchmark(r)]));
  }

  // ------------------------------------------------------------ reads: best sellers
  latestBestSellerReportDate(granularity = 'WEEKLY'): string | null {
    return this.db.get<{ d: string | null }>('SELECT MAX(report_date) AS d FROM mc_best_sellers WHERE granularity = ?', [granularity])?.d ?? null;
  }

  bestSellersForProduct(productName: string): BestSellerRow[] {
    const latest = this.latestBestSellerReportDate();
    if (!latest) return [];
    return this.db.all('SELECT * FROM mc_best_sellers WHERE product_name = ? AND report_date = ? ORDER BY country', [productName, latest]).map(rowToBestSeller);
  }

  /** Latest best-seller row per carried product (signals). */
  latestBestSellersByProduct(): Map<string, BestSellerRow> {
    const latest = this.latestBestSellerReportDate();
    if (!latest) return new Map();
    const rows = this.db.all('SELECT * FROM mc_best_sellers WHERE product_name IS NOT NULL AND report_date = ? ORDER BY rank', [latest]);
    const out = new Map<string, BestSellerRow>();
    for (const r of rows) {
      const name = r.product_name as string;
      if (!out.has(name)) out.set(name, rowToBestSeller(r));
    }
    return out;
  }

  listBestSellers(query: { country?: string; category?: string; carried?: boolean; demandChange?: string; granularity?: string; limit?: number; offset?: number } = {}): {
    items: BestSellerRow[];
    total: number;
    reportDate: string | null;
  } {
    const granularity = query.granularity ?? 'WEEKLY';
    const reportDate = this.latestBestSellerReportDate(granularity);
    if (!reportDate) return { items: [], total: 0, reportDate: null };
    const where = ['b.report_date = ?', 'b.granularity = ?'];
    const params: (string | number)[] = [reportDate, granularity];
    if (query.country) {
      where.push('b.country = ?');
      params.push(query.country);
    }
    if (query.category) {
      where.push('(b.category = ? OR b.category_id = ?)');
      params.push(query.category, query.category);
    }
    if (query.carried === true) where.push('b.product_name IS NOT NULL');
    if (query.carried === false) where.push('b.product_name IS NULL');
    if (query.demandChange) {
      where.push('b.demand_change = ?');
      params.push(query.demandChange);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = Number(this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM mc_best_sellers b ${whereSql}`, params)?.c ?? 0);
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    const offset = Math.max(query.offset ?? 0, 0);
    const rows = this.db.all(
      `SELECT b.*, p.product_id, p.offer_id FROM mc_best_sellers b LEFT JOIN products p ON p.name = b.product_name
       ${whereSql} ORDER BY b.country, b.category, b.rank LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { items: rows.map(rowToBestSeller), total, reportDate };
  }

  bestSellerFacets(): { countries: string[]; categories: { id: string; name: string | null }[] } {
    const latest = this.latestBestSellerReportDate();
    if (!latest) return { countries: [], categories: [] };
    return {
      countries: this.db.all<{ c: string }>('SELECT DISTINCT country AS c FROM mc_best_sellers WHERE report_date = ? ORDER BY 1', [latest]).map((r) => r.c),
      categories: this.db
        .all<{ id: string; name: string | null }>('SELECT DISTINCT category_id AS id, category AS name FROM mc_best_sellers WHERE report_date = ? ORDER BY 2', [latest])
        .map((r) => ({ id: r.id, name: r.name })),
    };
  }

  // ------------------------------------------------------------ reads: competitive visibility
  latestVisibilityDate(): string | null {
    return this.db.get<{ d: string | null }>('SELECT MAX(date) AS d FROM mc_competitive_visibility_daily')?.d ?? null;
  }

  /** Competitor table for the last 28 days: averages per domain. */
  competitiveVisibility(query: { country?: string; categoryId?: string; trafficSource?: string; from: string; to: string }): {
    rows: (Omit<CompetitiveVisibilityRow, 'date' | 'rank'> & { days: number; avgRank: number | null })[];
  } {
    const where = ['date BETWEEN ? AND ?'];
    const params: (string | number)[] = [query.from, query.to];
    if (query.country) {
      where.push('country = ?');
      params.push(query.country);
    }
    if (query.categoryId) {
      where.push('category_id = ?');
      params.push(query.categoryId);
    }
    where.push('traffic_source = ?');
    params.push(query.trafficSource ?? 'ALL');
    const rows = this.db.all<Row>(
      `SELECT country, category_id, traffic_source, domain, MAX(is_your_domain) AS is_your_domain, COUNT(*) AS days, AVG(rank) AS avg_rank,
              AVG(relative_visibility) AS relative_visibility, AVG(page_overlap_rate) AS page_overlap_rate, AVG(higher_position_rate) AS higher_position_rate,
              AVG(ads_organic_ratio) AS ads_organic_ratio
       FROM mc_competitive_visibility_daily WHERE ${where.join(' AND ')}
       GROUP BY country, category_id, traffic_source, domain ORDER BY country, category_id, relative_visibility DESC`,
      params,
    );
    return {
      rows: rows.map((r) => {
        const v = rowToVisibility({ ...r, date: query.to, rank: null });
        const { date: _date, rank: _rank, ...rest } = v;
        return { ...rest, days: Number(r.days), avgRank: r.avg_rank === null ? null : Math.round(Number(r.avg_rank) * 10) / 10 };
      }),
    };
  }

  visibilityFacets(): { countries: string[]; categories: string[] } {
    return {
      countries: this.db.all<{ c: string }>('SELECT DISTINCT country AS c FROM mc_competitive_visibility_daily ORDER BY 1').map((r) => r.c),
      categories: this.db.all<{ c: string }>('SELECT DISTINCT category_id AS c FROM mc_competitive_visibility_daily ORDER BY 1').map((r) => r.c),
    };
  }

  // ------------------------------------------------------------ sync runs
  startRun(connector: string, window: { from: string; to: string } | null): MetricsSyncRun {
    const startedAt = now();
    const id = Number(
      this.db.run("INSERT INTO metrics_sync_runs (connector, status, window_from, window_to, started_at) VALUES (?, 'running', ?, ?, ?)", [connector, window?.from ?? null, window?.to ?? null, startedAt]).lastInsertRowid,
    );
    return this.getRun(id)!;
  }

  finishRun(id: number, status: 'success' | 'failed', stats: Record<string, unknown>, error: string | null = null): MetricsSyncRun {
    this.db.run('UPDATE metrics_sync_runs SET status = ?, finished_at = ?, stats = ?, error = ? WHERE id = ?', [status, now(), toJson(stats), error, id]);
    return this.getRun(id)!;
  }

  getRun(id: number): MetricsSyncRun | undefined {
    const row = this.db.get('SELECT * FROM metrics_sync_runs WHERE id = ?', [id]);
    return row ? rowToRun(row) : undefined;
  }

  lastRun(connector?: string): MetricsSyncRun | undefined {
    const row = connector
      ? this.db.get('SELECT * FROM metrics_sync_runs WHERE connector = ? ORDER BY id DESC LIMIT 1', [connector])
      : this.db.get('SELECT * FROM metrics_sync_runs ORDER BY id DESC LIMIT 1');
    return row ? rowToRun(row) : undefined;
  }

  lastSuccessfulRun(connector: string): MetricsSyncRun | undefined {
    const row = this.db.get("SELECT * FROM metrics_sync_runs WHERE connector = ? AND status = 'success' ORDER BY id DESC LIMIT 1", [connector]);
    return row ? rowToRun(row) : undefined;
  }

  listRuns(limit = 20, connector?: string): MetricsSyncRun[] {
    const rows = connector
      ? this.db.all('SELECT * FROM metrics_sync_runs WHERE connector = ? ORDER BY id DESC LIMIT ?', [connector, limit])
      : this.db.all('SELECT * FROM metrics_sync_runs ORDER BY id DESC LIMIT ?', [limit]);
    return rows.map(rowToRun);
  }

  /** Marks runs left in `running` state by a crash as failed. */
  failStaleRuns(): number {
    return this.db.run("UPDATE metrics_sync_runs SET status = 'failed', finished_at = ?, error = 'Interrupted (server restarted)' WHERE status = 'running'", [now()]).changes;
  }
}
