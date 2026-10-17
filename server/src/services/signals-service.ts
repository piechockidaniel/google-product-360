import { Database, now, toJson } from '../db/database.js';
import { addDays, isoDay } from '../util/dates.js';
import type { Logger } from '../util/logger.js';
import type { EventLog } from './event-log.js';
import type { BestSellerRow, MetricsStore, PerformanceTotals, PriceBenchmarkRow, SearchTotals } from './metrics-store.js';
import type { ProductStore, Recommendation } from './product-store.js';

/** Tunable thresholds (settings page). */
export interface SignalThresholds {
  /** Impressions in the 28-day window below which a product has "no data". */
  minImpressions: number;
  /** Price above benchmark (percent) that triggers REPRICE. */
  priceAboveBenchmarkPct: number;
  /** Week-over-week click drop (percent) that triggers WATCH. */
  clickDropPct: number;
}

export const DEFAULT_THRESHOLDS: SignalThresholds = { minImpressions: 20, priceAboveBenchmarkPct: 10, clickDropPct: 40 };

export interface SignalReason {
  code: string;
  params?: Record<string, string | number | null>;
}

export interface ProductSignal {
  productName: string;
  computedAt: string;
  windows: { end: string; w7: [string, string]; p7: [string, string]; w28: [string, string] };
  metrics: {
    impressions7d: number;
    clicks7d: number;
    impressionsPrev7d: number;
    clicksPrev7d: number;
    impressions28d: number;
    clicks28d: number;
    conversions28d: number;
    conversionValueMicros28d: number;
    ctr28d: number | null;
    categoryMedianCtr: number | null;
    clicksChangePct: number | null;
    /** Organic search (Search Console) – zeros when the connector is off or the product has no mapped page. */
    scImpressions28d: number;
    scClicks28d: number;
    scImpressionsPrev28d: number;
    scPosition28d: number | null;
    scImpressionsChangePct: number | null;
  };
  market: {
    priceVsBenchmark: number | null;
    benchmarkPriceMicros: number | null;
    suggestedPriceMicros: number | null;
    effectiveness: string | null;
    demand: string | null;
    demandChange: string | null;
    bestSellerRank: number | null;
  };
  scores: { demand: number; visibility: number; price: number | null; efficiency: number | null; health: number };
  recommendation: Recommendation;
  previousRecommendation: Recommendation | null;
  reasons: SignalReason[];
}

export interface RecomputeSummary {
  products: number;
  changed: number;
  byRecommendation: Record<string, number>;
  windowEnd: string;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

interface PeerStats {
  imp28: number[];
  imp7: number[];
  ctr: number[];
  medianCtr: number | null;
  /** organic impressions of the peers – null when Search Console is not connected */
  scImp28: number[] | null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Percentile rank (0..100) of `value` among `population` (ties count as below). */
function percentile(value: number, population: number[]): number {
  if (population.length <= 1) return 50;
  let below = 0;
  for (const v of population) if (v < value) below += 1;
  return (below / (population.length - 1)) * 100;
}

const EMPTY: PerformanceTotals = { impressions: 0, clicks: 0, conversions: 0, conversionValueMicros: 0, ctr: null };
const EMPTY_SC: SearchTotals = { clicks: 0, impressions: 0, ctr: null, position: null };

/** Position 1 → 100, position ≥ 31 → 0. */
function positionScore(position: number | null): number | null {
  if (position === null) return null;
  return clamp(100 - ((position - 1) / 30) * 100);
}

/**
 * Turns the raw metric tables into one explainable recommendation per product.
 * Rules are deliberately simple; every threshold is user-configurable and every
 * decision carries the reasons that produced it.
 */
export class SignalsService {
  constructor(
    private readonly db: Database,
    private readonly products: ProductStore,
    private readonly metrics: MetricsStore,
    private readonly events: EventLog,
    private readonly logger: Logger,
    private readonly thresholds: () => SignalThresholds = () => DEFAULT_THRESHOLDS,
  ) {}

  /** Window end = last day with performance data (Google lags a day or more). */
  windowEnd(): string {
    const latest = this.metrics.latestPerformanceDate();
    const yesterday = addDays(isoDay(), -1);
    return latest && latest < yesterday ? latest : yesterday;
  }

  recompute(): RecomputeSummary {
    const t = this.thresholds();
    const end = this.windowEnd();
    const windows = {
      w7: [addDays(end, -6), end] as [string, string],
      p7: [addDays(end, -13), addDays(end, -7)] as [string, string],
      w28: [addDays(end, -27), end] as [string, string],
    };
    const perf = this.metrics.performanceByProduct([
      { key: 'w7', from: windows.w7[0], to: windows.w7[1] },
      { key: 'p7', from: windows.p7[0], to: windows.p7[1] },
      { key: 'w28', from: windows.w28[0], to: windows.w28[1] },
    ]);
    const benchmarks = this.metrics.latestPriceBenchmarks();
    const bestSellers = this.metrics.latestBestSellersByProduct();
    const hasSearch = this.metrics.latestSearchDate() !== null;
    const search = hasSearch
      ? this.metrics.searchTotalsByProduct([
          { key: 'w28', from: windows.w28[0], to: windows.w28[1] },
          { key: 'p28', from: addDays(windows.w28[0], -28), to: addDays(windows.w28[0], -1) },
        ])
      : new Map<string, Record<string, SearchTotals>>();
    const inputs = this.products.signalInputs();
    const previous = new Map(this.db.all<{ product_name: string; recommendation: string }>('SELECT product_name, recommendation FROM product_signals').map((r) => [r.product_name, r.recommendation as Recommendation]));

    // ---- peer groups (category with >= 5 products, otherwise the whole catalogue)
    const byCategory = new Map<string, typeof inputs>();
    for (const p of inputs) {
      const key = p.category ?? '';
      byCategory.set(key, [...(byCategory.get(key) ?? []), p]);
    }
    const groupOf = (category: string | null) => {
      const group = byCategory.get(category ?? '') ?? [];
      return group.length >= 5 ? group : inputs;
    };
    const impressions28 = (name: string) => perf.get(name)?.w28?.impressions ?? 0;
    const impressions7 = (name: string) => perf.get(name)?.w7?.impressions ?? 0;
    const ctr28 = (name: string) => perf.get(name)?.w28?.ctr ?? null;
    const scImpressions28 = (name: string) => search.get(name)?.w28?.impressions ?? 0;
    const groupStats = new Map<string, PeerStats>();
    const statsFor = (category: string | null) => {
      const key = category ?? '';
      let s = groupStats.get(key);
      if (!s) {
        const group = groupOf(category);
        const ctrs = group.map((g) => (impressions28(g.name) >= t.minImpressions ? ctr28(g.name) : null)).filter((v): v is number => v !== null);
        s = { imp28: group.map((g) => impressions28(g.name)), imp7: group.map((g) => impressions7(g.name)), ctr: ctrs, medianCtr: median(ctrs), scImp28: hasSearch ? group.map((g) => scImpressions28(g.name)) : null };
        groupStats.set(key, s);
      }
      return s;
    };

    const computedAt = now();
    const byRecommendation: Record<string, number> = {};
    let changed = 0;
    const changes: { name: string; previous: Recommendation | null; next: Recommendation }[] = [];

    this.db.transaction(() => {
      this.db.run('DELETE FROM product_signals WHERE product_name NOT IN (SELECT name FROM products WHERE deleted_at IS NULL)');
      for (const p of inputs) {
        const signal = this.compute(p, perf.get(p.name) ?? {}, search.get(p.name) ?? {}, benchmarks.get(p.name) ?? null, bestSellers.get(p.name) ?? null, statsFor(p.category), t, end, windows, computedAt);
        const prev = previous.get(p.name) ?? null;
        signal.previousRecommendation = prev;
        this.save(signal);
        byRecommendation[signal.recommendation] = (byRecommendation[signal.recommendation] ?? 0) + 1;
        if (prev && prev !== signal.recommendation) {
          changed += 1;
          changes.push({ name: p.name, previous: prev, next: signal.recommendation });
        }
      }
    });

    for (const c of changes.slice(0, 500)) {
      this.events.record('signal.changed', `Recommendation changed ${c.previous} → ${c.next}`, {
        severity: c.next === 'FIX' || c.next === 'PAUSE' ? 'warning' : 'info',
        payload: { previous: c.previous, recommendation: c.next },
        productName: c.name,
      });
    }
    this.logger.info({ products: inputs.length, changed, byRecommendation, end }, 'Signals recomputed');
    return { products: inputs.length, changed, byRecommendation, windowEnd: end };
  }

  private compute(
    p: ReturnType<ProductStore['signalInputs']>[number],
    perf: Record<string, PerformanceTotals>,
    search: Record<string, SearchTotals>,
    benchmark: PriceBenchmarkRow | null,
    bestSeller: BestSellerRow | null,
    peers: PeerStats,
    t: SignalThresholds,
    end: string,
    windows: { w7: [string, string]; p7: [string, string]; w28: [string, string] },
    computedAt: string,
  ): ProductSignal {
    const w7 = perf.w7 ?? EMPTY;
    const p7 = perf.p7 ?? EMPTY;
    const w28 = perf.w28 ?? EMPTY;
    const sc28 = search.w28 ?? EMPTY_SC;
    const scPrev28 = search.p28 ?? EMPTY_SC;
    const reasons: SignalReason[] = [];

    // ---- market inputs
    const benchmarkMicros = benchmark?.benchmarkPriceMicros ?? null;
    const priceMicros = p.priceMicros ?? benchmark?.priceMicros ?? null;
    const priceVsBenchmark = benchmarkMicros && priceMicros ? priceMicros / benchmarkMicros - 1 : null;
    const demand = bestSeller?.relativeDemand ?? null;
    const demandChange = bestSeller?.demandChange ?? null;

    // ---- scores
    // Demand blends paid/free-listing impressions with organic search impressions when Search Console is connected.
    let demandScore = percentile(w28.impressions, peers.imp28);
    if (peers.scImp28) demandScore = (demandScore + percentile(sc28.impressions, peers.scImp28)) / 2;
    if (demandChange === 'RISER') demandScore += 15;
    if (demandChange === 'SINKER') demandScore -= 15;
    if (demand === 'VERY_HIGH') demandScore += 10;
    else if (demand === 'HIGH') demandScore += 5;
    else if (demand === 'LOW') demandScore -= 5;
    else if (demand === 'VERY_LOW') demandScore -= 10;
    const ctrPercentile = w28.ctr !== null && w28.impressions >= t.minImpressions ? percentile(w28.ctr, peers.ctr) : 0;
    const organicPosition = positionScore(sc28.impressions > 0 ? sc28.position : null);
    const visibilityScore = organicPosition === null ? 0.5 * percentile(w7.impressions, peers.imp7) + 0.5 * ctrPercentile : (percentile(w7.impressions, peers.imp7) + ctrPercentile + organicPosition) / 3;
    const priceScore = priceVsBenchmark === null ? null : clamp(100 - ((priceVsBenchmark + 0.05) / 0.2) * 100);
    let healthScore = p.status === 'APPROVED' ? 100 : p.status === 'PENDING' ? 60 : p.status === 'PARTIALLY_APPROVED' ? 40 : p.status === 'DISAPPROVED' ? 0 : 50;
    if (p.maxSeverity === 'error') healthScore = Math.min(healthScore, 20);
    else if (p.maxSeverity === 'warning') healthScore = Math.min(healthScore, 70);
    if (p.availability === 'OUT_OF_STOCK') healthScore = Math.min(healthScore, 50);
    const scores = { demand: clamp(demandScore), visibility: clamp(visibilityScore), price: priceScore, efficiency: null, health: clamp(healthScore) };

    // ---- derived facts
    const hasData = w28.impressions >= t.minImpressions;
    const clicksChangePct = p7.clicks >= 5 ? ((w7.clicks - p7.clicks) / p7.clicks) * 100 : null;
    const ctrBelowMedian = hasData && w28.ctr !== null && peers.medianCtr !== null && w28.ctr < peers.medianCtr;
    const ctrFarBelowMedian = hasData && w28.ctr !== null && peers.medianCtr !== null && w28.ctr < peers.medianCtr * 0.5;
    const priceTooHigh = priceVsBenchmark !== null && priceVsBenchmark * 100 > t.priceAboveBenchmarkPct;
    const scImpressionsChangePct = scPrev28.impressions >= 100 ? ((sc28.impressions - scPrev28.impressions) / scPrev28.impressions) * 100 : null;
    // Organic "easy win": the page already ranks on page 1–2 with real volume – better title/content can move it up.
    const organicOpportunity = sc28.position !== null && sc28.position >= 6 && sc28.position <= 20 && sc28.impressions >= Math.max(300, 10 * t.minImpressions);
    const organicReason: SignalReason = { code: 'sc_position_opportunity', params: { position: sc28.position, impressions: sc28.impressions, clicks: sc28.clicks } };
    const pct = (n: number) => Math.round(n * 100);
    /** Rates (CTR) keep 4 decimals so the UI can show "1.85 %". */
    const rate = (n: number) => Math.round(n * 10000) / 10000;

    // ---- recommendation (first matching rule wins)
    let recommendation: Recommendation;
    if (!hasData && !benchmark && !bestSeller && sc28.impressions < t.minImpressions) {
      recommendation = 'NO_DATA';
      reasons.push({ code: 'no_data', params: { impressions: w28.impressions, min: t.minImpressions } });
    } else if (scores.health <= 40 && (scores.demand >= 50 || hasData)) {
      recommendation = 'FIX';
      reasons.push({ code: p.status === 'DISAPPROVED' || p.status === 'PARTIALLY_APPROVED' ? 'disapproved' : 'has_errors', params: { status: p.status } });
      if (scores.demand >= 50) reasons.push({ code: 'high_demand', params: { score: scores.demand } });
    } else if (priceTooHigh && (ctrBelowMedian || benchmark?.effectiveness === 'HIGH' || benchmark?.effectiveness === 'MEDIUM')) {
      recommendation = 'REPRICE';
      reasons.push({ code: 'price_above_benchmark', params: { pct: pct(priceVsBenchmark!) } });
      if (ctrBelowMedian) reasons.push({ code: 'ctr_below_median', params: { ctr: rate(w28.ctr!), median: rate(peers.medianCtr!) } });
      if (benchmark?.suggestedPriceMicros) reasons.push({ code: 'suggested_price', params: { price: benchmark.suggestedPriceMicros / 1_000_000, currency: benchmark.currency, effectiveness: benchmark.effectiveness } });
    } else if (ctrFarBelowMedian && !priceTooHigh) {
      recommendation = 'OPTIMISE_LISTING';
      reasons.push({ code: 'ctr_far_below_median', params: { ctr: rate(w28.ctr!), median: rate(peers.medianCtr!) } });
      if (organicOpportunity) reasons.push(organicReason);
      reasons.push({ code: 'price_ok' });
    } else if (demandChange === 'SINKER' || (clicksChangePct !== null && clicksChangePct < -t.clickDropPct) || (scImpressionsChangePct !== null && scImpressionsChangePct < -t.clickDropPct)) {
      recommendation = 'WATCH';
      if (demandChange === 'SINKER') reasons.push({ code: 'demand_sinker', params: { rank: bestSeller?.rank ?? null, previousRank: bestSeller?.previousRank ?? null } });
      if (clicksChangePct !== null && clicksChangePct < -t.clickDropPct) reasons.push({ code: 'clicks_dropped', params: { pct: Math.round(-clicksChangePct), clicks: w7.clicks, previous: p7.clicks } });
      if (scImpressionsChangePct !== null && scImpressionsChangePct < -t.clickDropPct) reasons.push({ code: 'sc_impressions_dropped', params: { pct: Math.round(-scImpressionsChangePct), impressions: sc28.impressions, previous: scPrev28.impressions } });
    } else if (scores.demand >= 60 && scores.health >= 70 && !priceTooHigh) {
      // Healthy, in demand, not over-priced: worth more budget / a push campaign. (A CTR far below the
      // category median was already routed to OPTIMISE_LISTING above.)
      recommendation = 'SCALE';
      reasons.push({ code: 'high_demand', params: { score: scores.demand } });
      if (demandChange === 'RISER') reasons.push({ code: 'demand_riser', params: { rank: bestSeller?.rank ?? null, previousRank: bestSeller?.previousRank ?? null } });
      if (!ctrBelowMedian && w28.ctr !== null) reasons.push({ code: 'ctr_at_or_above_median', params: { ctr: rate(w28.ctr) } });
      if (priceVsBenchmark !== null && priceVsBenchmark <= 0) reasons.push({ code: 'price_competitive', params: { pct: pct(priceVsBenchmark) } });
      if (clicksChangePct !== null && clicksChangePct > 20) reasons.push({ code: 'clicks_growing', params: { pct: Math.round(clicksChangePct) } });
      if (sc28.position !== null && sc28.position <= 5 && sc28.impressions >= t.minImpressions) reasons.push({ code: 'sc_strong_position', params: { position: sc28.position, impressions: sc28.impressions } });
      if (organicOpportunity) reasons.push(organicReason); // scale *and* polish the listing
    } else if (organicOpportunity && !priceTooHigh) {
      // Not a scaling candidate, but organic search already shows real interest on page 1–2.
      recommendation = 'OPTIMISE_LISTING';
      reasons.push(organicReason);
      reasons.push({ code: 'price_ok' });
    } else {
      recommendation = 'KEEP';
      reasons.push({ code: 'steady', params: { clicks: w7.clicks, impressions: w7.impressions } });
      if (priceTooHigh) reasons.push({ code: 'price_above_benchmark_tolerated', params: { pct: pct(priceVsBenchmark!) } });
      if (scores.health < 70) reasons.push({ code: 'health_limits', params: { status: p.status, availability: p.availability } });
    }

    return {
      productName: p.name,
      computedAt,
      windows: { end, ...windows },
      metrics: {
        impressions7d: w7.impressions,
        clicks7d: w7.clicks,
        impressionsPrev7d: p7.impressions,
        clicksPrev7d: p7.clicks,
        impressions28d: w28.impressions,
        clicks28d: w28.clicks,
        conversions28d: w28.conversions,
        conversionValueMicros28d: w28.conversionValueMicros,
        ctr28d: w28.ctr,
        categoryMedianCtr: peers.medianCtr,
        clicksChangePct: clicksChangePct === null ? null : Math.round(clicksChangePct),
        scImpressions28d: sc28.impressions,
        scClicks28d: sc28.clicks,
        scImpressionsPrev28d: scPrev28.impressions,
        scPosition28d: sc28.position,
        scImpressionsChangePct: scImpressionsChangePct === null ? null : Math.round(scImpressionsChangePct),
      },
      market: {
        priceVsBenchmark,
        benchmarkPriceMicros: benchmarkMicros,
        suggestedPriceMicros: benchmark?.suggestedPriceMicros ?? null,
        effectiveness: benchmark?.effectiveness ?? null,
        demand,
        demandChange,
        bestSellerRank: bestSeller?.rank ?? null,
      },
      scores,
      recommendation,
      previousRecommendation: null,
      reasons,
    };
  }

  private save(s: ProductSignal): void {
    this.db.run(
      `INSERT INTO product_signals (product_name, computed_at, mc_impressions_7d, mc_clicks_7d, mc_impressions_prev_7d, mc_clicks_prev_7d, mc_impressions_28d, mc_clicks_28d,
         mc_conversions_28d, mc_conversion_value_micros_28d, mc_ctr_28d, price_vs_benchmark, effectiveness, demand, demand_change, best_seller_rank, scores, recommendation,
         previous_recommendation, reasons, sc_impressions_28d, sc_clicks_28d, sc_impressions_prev_28d, sc_position_28d)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(product_name) DO UPDATE SET computed_at = excluded.computed_at, mc_impressions_7d = excluded.mc_impressions_7d, mc_clicks_7d = excluded.mc_clicks_7d,
         mc_impressions_prev_7d = excluded.mc_impressions_prev_7d, mc_clicks_prev_7d = excluded.mc_clicks_prev_7d, mc_impressions_28d = excluded.mc_impressions_28d,
         mc_clicks_28d = excluded.mc_clicks_28d, mc_conversions_28d = excluded.mc_conversions_28d, mc_conversion_value_micros_28d = excluded.mc_conversion_value_micros_28d,
         mc_ctr_28d = excluded.mc_ctr_28d, price_vs_benchmark = excluded.price_vs_benchmark, effectiveness = excluded.effectiveness, demand = excluded.demand,
         demand_change = excluded.demand_change, best_seller_rank = excluded.best_seller_rank, scores = excluded.scores, recommendation = excluded.recommendation,
         previous_recommendation = excluded.previous_recommendation, reasons = excluded.reasons, sc_impressions_28d = excluded.sc_impressions_28d,
         sc_clicks_28d = excluded.sc_clicks_28d, sc_impressions_prev_28d = excluded.sc_impressions_prev_28d, sc_position_28d = excluded.sc_position_28d`,
      [
        s.productName,
        s.computedAt,
        s.metrics.impressions7d,
        s.metrics.clicks7d,
        s.metrics.impressionsPrev7d,
        s.metrics.clicksPrev7d,
        s.metrics.impressions28d,
        s.metrics.clicks28d,
        s.metrics.conversions28d,
        s.metrics.conversionValueMicros28d,
        s.metrics.ctr28d,
        s.market.priceVsBenchmark,
        s.market.effectiveness,
        s.market.demand,
        s.market.demandChange,
        s.market.bestSellerRank,
        toJson(s.scores),
        s.recommendation,
        s.previousRecommendation,
        toJson(s.reasons),
        s.metrics.scImpressions28d,
        s.metrics.scClicks28d,
        s.metrics.scImpressionsPrev28d,
        s.metrics.scPosition28d,
      ],
    );
  }

  /** Full signal for one product (null when never computed). */
  get(productName: string): ProductSignal | null {
    const row = this.db.get('SELECT * FROM product_signals WHERE product_name = ?', [productName]);
    if (!row) return null;
    const end = this.windowEnd();
    const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const clicks7 = Number(row.mc_clicks_7d);
    const clicksPrev7 = Number(row.mc_clicks_prev_7d);
    const scores = JSON.parse(row.scores as string) as ProductSignal['scores'];
    return {
      productName,
      computedAt: row.computed_at as string,
      windows: { end, w7: [addDays(end, -6), end], p7: [addDays(end, -13), addDays(end, -7)], w28: [addDays(end, -27), end] },
      metrics: {
        impressions7d: Number(row.mc_impressions_7d),
        clicks7d: clicks7,
        impressionsPrev7d: Number(row.mc_impressions_prev_7d),
        clicksPrev7d: clicksPrev7,
        impressions28d: Number(row.mc_impressions_28d),
        clicks28d: Number(row.mc_clicks_28d),
        conversions28d: Number(row.mc_conversions_28d),
        conversionValueMicros28d: Number(row.mc_conversion_value_micros_28d),
        ctr28d: numOrNull(row.mc_ctr_28d),
        categoryMedianCtr: null,
        clicksChangePct: clicksPrev7 >= 5 ? Math.round(((clicks7 - clicksPrev7) / clicksPrev7) * 100) : null,
        scImpressions28d: Number(row.sc_impressions_28d ?? 0),
        scClicks28d: Number(row.sc_clicks_28d ?? 0),
        scImpressionsPrev28d: Number(row.sc_impressions_prev_28d ?? 0),
        scPosition28d: numOrNull(row.sc_position_28d),
        scImpressionsChangePct:
          Number(row.sc_impressions_prev_28d ?? 0) >= 100 ? Math.round(((Number(row.sc_impressions_28d ?? 0) - Number(row.sc_impressions_prev_28d)) / Number(row.sc_impressions_prev_28d)) * 100) : null,
      },
      market: {
        priceVsBenchmark: numOrNull(row.price_vs_benchmark),
        benchmarkPriceMicros: null,
        suggestedPriceMicros: null,
        effectiveness: (row.effectiveness as string | null) ?? null,
        demand: (row.demand as string | null) ?? null,
        demandChange: (row.demand_change as string | null) ?? null,
        bestSellerRank: numOrNull(row.best_seller_rank),
      },
      scores,
      recommendation: row.recommendation as Recommendation,
      previousRecommendation: (row.previous_recommendation as Recommendation | null) ?? null,
      reasons: JSON.parse(row.reasons as string) as SignalReason[],
    };
  }

  hasSignals(): boolean {
    return Number(this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM product_signals')?.c ?? 0) > 0;
  }
}
