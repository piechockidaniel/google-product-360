import type { SearchAnalyticsRequest, SearchAnalyticsRow, SearchConsoleApi, SearchConsoleSite } from '../google/search-console-api.js';
import { MerchantApiError } from '../google/rest-client.js';
import type { Product } from '../google/types.js';
import { eachDay, isoDay } from '../util/dates.js';
import { unitHash } from './mock-reports.js';

const NON_PRODUCT_PAGES = ['https://example-shop.pl/', 'https://example-shop.pl/c/lamps', 'https://example-shop.pl/c/jackets', 'https://example-shop.pl/blog/how-to-choose-a-backpack'];
const QUERY_SUFFIXES = ['', ' cena', ' opinie', ' sklep', ' promocja', ' najlepszy', ' test', ' czarny', ' tanio', ' outlet'];

/**
 * Synthetic Search Console. Page rows are a deterministic function of
 * (product, day); the organic series is correlated with, but different from,
 * the Merchant Center series so the UI shows two distinct signals.
 */
export class MockSearchConsoleApi implements SearchConsoleApi {
  /** Visible properties; change to simulate a missing share. */
  sites: SearchConsoleSite[] = [
    { siteUrl: 'sc-domain:example-shop.pl', permissionLevel: 'siteFullUser' },
    { siteUrl: 'https://example-shop.pl/', permissionLevel: 'siteOwner' },
  ];
  readonly calls: SearchAnalyticsRequest[] = [];
  /** Every call fails with this error (simulates missing API / permission). */
  failWith: MerchantApiError | null = null;
  /** Only `query` fails (site list still works). */
  failQueriesWith: MerchantApiError | null = null;

  constructor(private readonly products: () => Product[]) {}

  async listSites(): Promise<SearchConsoleSite[]> {
    if (this.failWith) throw this.failWith;
    return this.sites.map((s) => ({ ...s }));
  }

  async query(siteUrl: string, request: SearchAnalyticsRequest): Promise<SearchAnalyticsRow[]> {
    if (this.failWith) throw this.failWith;
    if (this.failQueriesWith) throw this.failQueriesWith;
    if (!this.sites.some((s) => s.siteUrl === siteUrl)) throw new MerchantApiError(`User does not have sufficient permission for site '${siteUrl}'.`, 403, 'PERMISSION_DENIED');
    this.calls.push(request);
    const all = this.generate(request);
    const start = request.startRow ?? 0;
    return all.slice(start, start + (request.rowLimit ?? 1000));
  }

  async queryAll(siteUrl: string, request: SearchAnalyticsRequest): Promise<SearchAnalyticsRow[]> {
    const rowLimit = request.rowLimit ?? 25_000;
    const out: SearchAnalyticsRow[] = [];
    let startRow = request.startRow ?? 0;
    for (;;) {
      const rows = await this.query(siteUrl, { ...request, rowLimit, startRow });
      out.push(...rows);
      if (rows.length < rowLimit) return out;
      startRow += rows.length;
    }
  }

  private generate(request: SearchAnalyticsRequest): SearchAnalyticsRow[] {
    const filters = request.dimensionFilterGroups?.flatMap((g) => g.filters) ?? [];
    const country = filters.find((f) => f.dimension === 'country')?.expression;
    const appearance = filters.find((f) => f.dimension === 'searchAppearance')?.expression;
    const pageFilter = filters.find((f) => f.dimension === 'page')?.expression;
    const dims = request.dimensions ?? [];
    const days = eachDay(request.startDate, request.endDate).filter((d) => d <= isoDay());
    const scale = (country ? 0.7 : 1) * (appearance === 'MERCHANT_LISTINGS' ? 0.35 : 1);

    if (dims[0] === 'query') {
      const product = this.products().find((p) => p.productAttributes?.link === pageFilter);
      if (!product) return [];
      const base = product.productAttributes?.title?.toLowerCase() ?? 'product';
      return QUERY_SUFFIXES.map((suffix, i) => {
        const impressions = Math.round((400 / (i + 1)) * (0.5 + unitHash(base, suffix)) * days.length * 0.1 * scale);
        const position = Math.round((3 + i * 1.7 + unitHash(base, suffix, 'pos') * 6) * 10) / 10;
        const ctr = Math.max(0.005, 0.25 / position);
        return { keys: [`${base}${suffix}`.trim()], clicks: Math.round(impressions * ctr), impressions, ctr, position };
      }).filter((r) => r.impressions > 0);
    }

    // dimensions: ['page'] (optionally aggregated over a date range)
    const rows: SearchAnalyticsRow[] = [];
    const pages: { url: string; pop: number; pos: number }[] = this.products().map((p) => ({
      url: p.productAttributes?.link ?? '',
      pop: unitHash(p.offerId ?? '', 'pop') * 0.8 + unitHash(p.offerId ?? '', 'sc') * 0.4,
      pos: 3 + unitHash(p.offerId ?? '', 'scpos') * 30,
    }));
    for (const np of NON_PRODUCT_PAGES) pages.push({ url: np, pop: 1.5, pos: 2 + unitHash(np) * 5 });
    for (const page of pages) {
      if (!page.url) continue;
      if (pageFilter && page.url !== pageFilter) continue;
      let impressions = 0;
      let clicks = 0;
      let weightedPos = 0;
      for (const day of days) {
        const noise = 0.6 + unitHash(page.url, day, 'scn') * 0.8;
        const imp = Math.round(8 * page.pop * 25 * noise * scale);
        if (imp <= 0) continue;
        const pos = Math.max(1, page.pos + (unitHash(page.url, day, 'scp') - 0.5) * 4);
        const ctr = Math.min(0.35, 0.28 / pos);
        impressions += imp;
        clicks += Math.round(imp * ctr);
        weightedPos += pos * imp;
      }
      if (impressions <= 0) continue;
      rows.push({ keys: [page.url], clicks, impressions, ctr: clicks / impressions, position: Math.round((weightedPos / impressions) * 10) / 10 });
    }
    rows.sort((a, b) => (b.clicks ?? 0) - (a.clicks ?? 0));
    return rows;
  }
}
