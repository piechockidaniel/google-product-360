import type { Product, ReportRow } from '../google/types.js';
import { MerchantApiError } from '../google/rest-client.js';
import { addDays, eachDay, isoDay, weekStart } from '../util/dates.js';

/**
 * Synthetic Merchant Center reports for the mock API. Every value is a pure
 * function of (product, day) so repeated queries return identical rows – the
 * metrics sync must be idempotent and tests need stable numbers.
 */

/** FNV-1a hash mapped to [0, 1). */
export function unitHash(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const text = parts.join('|');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x100000000;
}

export interface ParsedReportQuery {
  view: string;
  fields: string[];
  dateFrom?: string;
  dateTo?: string;
  equals: Record<string, string>;
}

/** Minimal Merchant Center Query Language parser – enough for the views the app uses. */
export function parseReportQuery(query: string): ParsedReportQuery {
  const normalized = query.replace(/\s+/g, ' ').trim();
  const m = /^SELECT (.+?) FROM ([a-z_]+)(?: WHERE (.+?))?(?: ORDER BY .+?)?(?: LIMIT \d+)?$/i.exec(normalized);
  if (!m) throw new MerchantApiError(`Invalid query: ${query}`, 400, 'INVALID_ARGUMENT');
  const parsed: ParsedReportQuery = { view: m[2]!.toLowerCase(), fields: m[1]!.split(',').map((f) => f.trim()), equals: {} };
  let where = m[3];
  if (where) {
    // BETWEEN contains its own AND – take those clauses out before splitting the rest.
    where = where.replace(/(\w+) BETWEEN '([\d-]+)' AND '([\d-]+)'/gi, (_all, _field: string, from: string, to: string) => {
      parsed.dateFrom = from;
      parsed.dateTo = to;
      return '';
    });
    for (const clause of where.split(/ AND /i)) {
      if (!clause.trim()) continue;
      const eq = /^(\w+) = '?([^']+?)'?$/i.exec(clause.trim());
      if (eq) {
        if (eq[1]!.toLowerCase() === 'date' || eq[1]!.toLowerCase() === 'report_date') {
          parsed.dateFrom = eq[2]!;
          parsed.dateTo = eq[2]!;
        } else parsed.equals[eq[1]!.toLowerCase()] = eq[2]!;
        continue;
      }
      throw new MerchantApiError(`Unsupported WHERE clause: ${clause}`, 400, 'INVALID_ARGUMENT');
    }
  }
  return parsed;
}

const COMPETITORS = ['megastore.example', 'shop-rival.example', 'discount-king.example', 'brandhouse.example'];

export interface MockReportOptions {
  /** Views that throw "not available" (simulates Market Insights being disabled). */
  unavailableViews?: Set<string>;
  /** Domain reported as `is_your_domain`. */
  ownDomain?: string;
}

/** Stable per-product "personality": popularity, trend and price position. */
function profile(product: Product) {
  const offerId = product.offerId ?? '';
  const popularity = unitHash(offerId, 'pop'); // 0..1
  const trend = (unitHash(offerId, 'trend') - 0.5) * 2; // -1..1 (negative = declining)
  const pricePosition = (unitHash(offerId, 'price') - 0.4) * 0.5; // -0.2..+0.3 vs benchmark
  const ctrFactor = 0.6 + unitHash(offerId, 'ctr') * 0.9; // 0.6..1.5
  return { popularity, trend, pricePosition, ctrFactor };
}

function dayIndex(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

export function generateReport(query: string, products: Product[], options: MockReportOptions = {}): ReportRow[] {
  const q = parseReportQuery(query);
  if (options.unavailableViews?.has(q.view)) {
    throw new MerchantApiError(`The ${q.view} report is not available for this account. Enable Market Insights in Merchant Center.`, 403, 'PERMISSION_DENIED');
  }
  const today = isoDay();
  const from = q.dateFrom ?? addDays(today, -7);
  const to = q.dateTo ?? today;
  switch (q.view) {
    case 'product_performance_view':
      return performanceRows(products, from, to);
    case 'price_competitiveness_product_view':
      return priceCompetitivenessRows(products);
    case 'price_insights_product_view':
      return priceInsightsRows(products);
    case 'best_sellers_product_cluster_view':
      return bestSellersRows(products, q, from, to);
    case 'competitive_visibility_competitor_view':
      return competitiveVisibilityRows(products, q, from, to, options.ownDomain ?? 'example-shop.pl');
    default:
      throw new MerchantApiError(`Unknown report view ${q.view}`, 400, 'INVALID_ARGUMENT');
  }
}

function performanceRows(products: Product[], from: string, to: string): ReportRow[] {
  const rows: ReportRow[] = [];
  const todayIdx = dayIndex(isoDay());
  for (const product of products) {
    const p = profile(product);
    const status = product.productStatus;
    const disapproved = status?.destinationStatuses?.some((d) => (d.disapprovedCountries?.length ?? 0) > 0) ?? false;
    const country = product.feedLabel ?? 'PL';
    for (const day of eachDay(from, to)) {
      if (day > isoDay()) break;
      const age = todayIdx - dayIndex(day); // days ago
      // Base daily impressions: 5..400 scaled by popularity, trend over ~60 days, weekly seasonality.
      const trendFactor = Math.max(0.2, 1 + p.trend * (-(age - 30) / 60));
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
      const seasonal = weekday === 0 || weekday === 6 ? 0.8 : 1.05;
      const noise = 0.7 + unitHash(product.offerId ?? '', day, 'n') * 0.6;
      const base = (5 + p.popularity * 400) * trendFactor * seasonal * noise * (disapproved ? 0.15 : 1);
      for (const method of ['ADS', 'ORGANIC'] as const) {
        const share = method === 'ADS' ? 0.65 : 0.35;
        const impressions = Math.round(base * share);
        if (impressions <= 0) continue;
        const ctr = 0.012 * p.ctrFactor * (method === 'ADS' ? 1.2 : 0.8) * Math.max(0.5, 1 - p.pricePosition);
        const clicks = Math.round(impressions * ctr + unitHash(product.offerId ?? '', day, method) * 0.8);
        const convRate = 0.02 * (1 + p.popularity) * Math.max(0.3, 1 - p.pricePosition * 2);
        const conversions = Math.round(clicks * convRate * 10) / 10;
        const priceMicros = Number(product.productAttributes?.price?.amountMicros ?? 0);
        rows.push({
          productPerformanceView: {
            date: { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)), day: Number(day.slice(8, 10)) },
            offerId: product.offerId,
            title: product.productAttributes?.title,
            brand: product.productAttributes?.brand,
            marketingMethod: method,
            customerCountryCode: country,
            impressions: String(impressions),
            clicks: String(clicks),
            clickThroughRate: impressions ? clicks / impressions : 0,
            conversions,
            conversionValue: { amountMicros: String(Math.round(conversions * priceMicros)), currencyCode: product.productAttributes?.price?.currencyCode ?? 'PLN' },
          },
        });
      }
    }
  }
  return rows;
}

function priceCompetitivenessRows(products: Product[]): ReportRow[] {
  return products
    .filter((product) => unitHash(product.offerId ?? '', 'bench') > 0.15) // not every product has a benchmark
    .map((product) => {
      const p = profile(product);
      const price = product.productAttributes?.price;
      const priceMicros = Number(price?.amountMicros ?? 0);
      const benchmark = Math.round(priceMicros / (1 + p.pricePosition) / 10000) * 10000;
      return {
        priceCompetitivenessProductView: {
          id: product.name?.split('/products/')[1],
          offerId: product.offerId,
          title: product.productAttributes?.title,
          brand: product.productAttributes?.brand,
          price,
          benchmarkPrice: { amountMicros: String(benchmark), currencyCode: price?.currencyCode ?? 'PLN' },
          reportCountryCode: product.feedLabel ?? 'PL',
        },
      };
    });
}

function priceInsightsRows(products: Product[]): ReportRow[] {
  return products
    .filter((product) => profile(product).pricePosition > 0.05)
    .map((product) => {
      const p = profile(product);
      const price = product.productAttributes?.price;
      const priceMicros = Number(price?.amountMicros ?? 0);
      const suggested = Math.round((priceMicros * (1 - p.pricePosition * 0.6)) / 10000) * 10000;
      return {
        priceInsightsProductView: {
          id: product.name?.split('/products/')[1],
          offerId: product.offerId,
          price,
          suggestedPrice: { amountMicros: String(suggested), currencyCode: price?.currencyCode ?? 'PLN' },
          predictedImpressionsChangeFraction: Math.round(p.pricePosition * 80) / 100,
          predictedClicksChangeFraction: Math.round(p.pricePosition * 120) / 100,
          predictedConversionsChangeFraction: Math.round(p.pricePosition * 150) / 100,
          effectiveness: p.pricePosition > 0.2 ? 'HIGH' : p.pricePosition > 0.12 ? 'MEDIUM' : 'LOW',
        },
      };
    });
}

const DEMAND_LEVELS = ['VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'];

function bestSellersRows(products: Product[], q: ParsedReportQuery, from: string, to: string): ReportRow[] {
  const granularity = (q.equals.report_granularity ?? 'WEEKLY').toUpperCase();
  const countries = q.equals.report_country_code ? [q.equals.report_country_code] : [...new Set(products.map((p) => p.feedLabel ?? 'PL'))];
  const reportDates = new Set<string>();
  for (const day of eachDay(from, to)) reportDates.add(granularity === 'MONTHLY' ? `${day.slice(0, 7)}-01` : weekStart(day));
  const rows: ReportRow[] = [];
  // Clusters: every product type gets a "category"; each category lists the carried products + some we do not carry.
  const byType = new Map<string, Product[]>();
  for (const p of products) {
    const type = p.productAttributes?.productTypes?.[0] ?? 'Other';
    byType.set(type, [...(byType.get(type) ?? []), p]);
  }
  for (const reportDate of reportDates) {
    for (const country of countries) {
      for (const [type, members] of byType) {
        const categoryId = String(1000 + Math.floor(unitHash(type) * 9000));
        const candidates = members
          .filter((m) => (m.feedLabel ?? 'PL') === country)
          .map((m) => ({ key: m.offerId ?? '', title: m.productAttributes?.title ?? '', brand: m.productAttributes?.brand ?? '', gtins: m.productAttributes?.gtins ?? [], carried: true, product: m }));
        for (let i = 0; i < 3; i += 1) {
          candidates.push({ key: `${type}-other-${i}`, title: `${['Zenith', 'Orbit', 'Polar'][i]} ${type} Pro`, brand: ['Zenith', 'Orbit', 'Polar'][i]!, gtins: [`4000${String(i).padStart(9, '0')}`], carried: false, product: undefined as unknown as Product });
        }
        const ranked = candidates
          .map((c) => ({ ...c, score: unitHash(c.key, reportDate, 'rank') + (c.carried ? profile(c.product).popularity : 0.5) }))
          .sort((a, b) => b.score - a.score);
        ranked.forEach((c, idx) => {
          const rank = idx + 1;
          const prevRank = Math.max(1, rank + Math.round((unitHash(c.key, reportDate, 'prev') - 0.5) * 4));
          const demandIdx = Math.min(4, Math.max(0, 4 - Math.floor((rank - 1) / Math.max(1, ranked.length / 5))));
          const prevDemandIdx = Math.min(4, Math.max(0, demandIdx + (prevRank > rank ? -1 : prevRank < rank ? 1 : 0)));
          rows.push({
            bestSellersProductClusterView: {
              reportDate: { year: Number(reportDate.slice(0, 4)), month: Number(reportDate.slice(5, 7)), day: Number(reportDate.slice(8, 10)) },
              reportGranularity: granularity,
              reportCountryCode: country,
              reportCategoryId: categoryId,
              title: c.title,
              brand: c.brand,
              categoryL1: type,
              variantGtins: c.gtins,
              inventoryStatus: c.carried ? (c.product.productAttributes?.availability === 'OUT_OF_STOCK' ? 'OUT_OF_STOCK' : 'IN_STOCK') : 'NOT_IN_INVENTORY',
              rank: String(rank),
              previousRank: String(prevRank),
              relativeDemand: DEMAND_LEVELS[demandIdx],
              previousRelativeDemand: DEMAND_LEVELS[prevDemandIdx],
              relativeDemandChange: prevRank > rank + 1 ? 'RISER' : prevRank < rank - 1 ? 'SINKER' : 'FLAT',
            },
          });
        });
      }
    }
  }
  return rows;
}

function competitiveVisibilityRows(products: Product[], q: ParsedReportQuery, from: string, to: string, ownDomain: string): ReportRow[] {
  const countries = q.equals.report_country_code ? [q.equals.report_country_code] : [...new Set(products.map((p) => p.feedLabel ?? 'PL'))];
  const sources = q.equals.traffic_source ? [q.equals.traffic_source.toUpperCase()] : ['ALL'];
  const types = [...new Set(products.map((p) => p.productAttributes?.productTypes?.[0] ?? 'Other'))];
  const rows: ReportRow[] = [];
  for (const day of eachDay(from, to)) {
    if (day > isoDay()) break;
    for (const country of countries) {
      for (const type of types) {
        const categoryId = String(1000 + Math.floor(unitHash(type) * 9000));
        if (q.equals.report_category_id && q.equals.report_category_id !== categoryId) continue;
        for (const source of sources) {
          const domains = [ownDomain, ...COMPETITORS].map((domain) => ({ domain, vis: unitHash(domain, type, country, day.slice(0, 7)) * (domain === ownDomain ? 1.1 : 1) }));
          domains.sort((a, b) => b.vis - a.vis);
          domains.forEach((d, idx) => {
            rows.push({
              competitiveVisibilityCompetitorView: {
                date: day,
                domain: d.domain,
                isYourDomain: d.domain === ownDomain,
                reportCountryCode: country,
                reportCategoryId: categoryId,
                trafficSource: source,
                rank: String(idx + 1),
                adsOrganicRatio: Math.round(unitHash(d.domain, 'ratio') * 300) / 100,
                pageOverlapRate: d.domain === ownDomain ? 1 : Math.round(unitHash(d.domain, type, 'overlap') * 60) / 100,
                higherPositionRate: d.domain === ownDomain ? 0 : Math.round(unitHash(d.domain, type, 'higher') * 70) / 100,
                relativeVisibility: Math.round((d.vis / domains[0]!.vis) * 100) / 100,
              },
            });
          });
        }
      }
    }
  }
  return rows;
}
