import type { SearchAnalyticsRequest, SearchAnalyticsRow, SearchConsoleApi } from '../google/search-console-api.js';
import { MerchantApiError } from '../google/rest-client.js';
import type { MetricsStore, SearchPageRow, SearchQueryRow } from '../services/metrics-store.js';
import type { ProductStore } from '../services/product-store.js';
import { addDays, eachDay, isoDay } from '../util/dates.js';
import { canonicalizeUrl, urlBelongsToSite } from '../util/urls.js';
import type { ConnectionCheck, Connector, ConnectorLog, ConnectorSyncResult, SyncWindow } from './connector.js';

export interface SearchConsoleSettings {
  enabled: boolean;
  /** `sc-domain:example.com` or `https://www.example.com/` – chosen by the user from the property list. */
  siteUrl: string;
  /** ISO-3166-1 alpha-3 lower case (`pol`) – limits the pull to one market; empty = all countries. */
  countryFilter: string;
  /** Also pull rows limited to the MERCHANT_LISTINGS search appearance (product rich results). */
  merchantListings: boolean;
  /** `all` returns fresh-but-preliminary days, `final` only closed days. */
  dataState: 'all' | 'final';
}

/** Builds the search analytics request bodies – kept together so tests can assert them. */
export const SC_REQUESTS = {
  pagesForDay: (day: string, s: Pick<SearchConsoleSettings, 'countryFilter' | 'dataState'>, appearance?: string): SearchAnalyticsRequest => {
    const filters: NonNullable<SearchAnalyticsRequest['dimensionFilterGroups']>[number]['filters'] = [];
    if (s.countryFilter) filters.push({ dimension: 'country', operator: 'equals', expression: s.countryFilter.toLowerCase() });
    if (appearance) filters.push({ dimension: 'searchAppearance', operator: 'equals', expression: appearance });
    return {
      startDate: day,
      endDate: day,
      dimensions: ['page'],
      type: 'web',
      dataState: s.dataState,
      rowLimit: 25_000,
      startRow: 0,
      ...(filters.length ? { dimensionFilterGroups: [{ filters }] } : {}),
    };
  },
  queriesForPage: (pageUrl: string, from: string, to: string, s: Pick<SearchConsoleSettings, 'countryFilter'>): SearchAnalyticsRequest => ({
    startDate: from,
    endDate: to,
    dimensions: ['query'],
    type: 'web',
    dataState: 'all',
    rowLimit: 50,
    dimensionFilterGroups: [
      {
        filters: [
          { dimension: 'page', operator: 'equals', expression: pageUrl },
          ...(s.countryFilter ? [{ dimension: 'country' as const, operator: 'equals' as const, expression: s.countryFilter.toLowerCase() }] : []),
        ],
      },
    ],
  }),
};

/**
 * Pulls Google Search Console search analytics for the product landing pages
 * into `sc_page_daily`. Joins by canonical URL (product `link` ↔ page).
 */
export class SearchConsoleConnector implements Connector {
  readonly id = 'search_console' as const;
  /** Search Console keeps 16 months. */
  readonly maxBackfillDays = 480;
  readonly revisionWindowDays = 10;
  readonly lagDays = 2;

  constructor(
    private readonly api: () => SearchConsoleApi,
    private readonly products: ProductStore,
    private readonly metrics: MetricsStore,
    private readonly settings: () => SearchConsoleSettings,
    private readonly hasCredentials: () => boolean,
  ) {}

  isConfigured(): boolean {
    const s = this.settings();
    return s.enabled && !!s.siteUrl && this.hasCredentials();
  }

  /** Builds the product → URL map from the local product snapshot. */
  rebuildUrlMap(): { mapped: number; shared: number; total: number; outsideSite: number } {
    const site = this.settings().siteUrl;
    const entries: { productName: string; canonicalUrl: string }[] = [];
    let total = 0;
    let outsideSite = 0;
    for (const p of this.products.listAllProducts()) {
      total += 1;
      const url = canonicalizeUrl(p.link);
      if (!url) continue;
      if (site && !urlBelongsToSite(url, site)) {
        outsideSite += 1;
        continue;
      }
      entries.push({ productName: p.name, canonicalUrl: url });
    }
    return { ...this.metrics.rebuildUrlMap(entries), total, outsideSite };
  }

  async testConnection(): Promise<ConnectionCheck> {
    const s = this.settings();
    const capabilities: ConnectionCheck['capabilities'] = [];
    let error: string | undefined;
    let hint: string | undefined;
    try {
      const sites = await this.api().listSites();
      const site = sites.find((x) => x.siteUrl === s.siteUrl);
      if (!site) {
        capabilities.push({ id: 'property', available: false, message: `Property ${s.siteUrl} is not shared with the service account (${sites.length} visible)` });
        error = 'Property not accessible';
        hint = 'sc_property_missing';
      } else if (site.permissionLevel === 'siteUnverifiedUser') {
        capabilities.push({ id: 'property', available: false, message: 'Property is not verified for this user' });
        error = 'Property not verified';
        hint = 'sc_property_unverified';
      } else capabilities.push({ id: 'property', available: true, message: site.permissionLevel });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      capabilities.push({ id: 'property', available: false, message });
      error = message;
      hint = err instanceof MerchantApiError && err.status === 403 ? 'sc_forbidden' : 'sc_api';
    }
    if (!error) {
      try {
        const day = addDays(isoDay(), -3);
        await this.api().query(s.siteUrl, { ...SC_REQUESTS.pagesForDay(day, s), rowLimit: 1 });
        capabilities.push({ id: 'search_analytics', available: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        capabilities.push({ id: 'search_analytics', available: false, message });
        error = message;
        hint = 'sc_api';
      }
    }
    const map = this.rebuildUrlMap();
    capabilities.push({
      id: 'url_mapping',
      available: map.mapped > 0,
      message: `${map.mapped} of ${map.total} products have a landing page inside the property${map.outsideSite ? ` (${map.outsideSite} point to another host)` : ''}${map.shared ? `, ${map.shared} share a URL with variants` : ''}`,
    });
    if (!error && map.mapped === 0 && map.total > 0) hint = 'sc_no_mapping';
    return { ok: !error, capabilities, hint, error };
  }

  async sync(window: SyncWindow, log: ConnectorLog): Promise<ConnectorSyncResult> {
    const s = this.settings();
    const map = this.rebuildUrlMap();
    const mapped = this.metrics.mappedUrls();
    const gauges: ConnectorSyncResult['gauges'] = { mappedProducts: map.mapped, sharedUrlProducts: map.shared, productsOutsideSite: map.outsideSite };
    const stats: ConnectorSyncResult['stats'] = {};
    let pageRows = 0;
    let stored = 0;
    let unmatchedPages = 0;
    const appearances: (string | undefined)[] = [undefined, ...(s.merchantListings ? ['MERCHANT_LISTINGS'] : [])];
    const today = isoDay();
    for (const day of eachDay(window.from, window.to)) {
      if (day > today) break;
      for (const appearance of appearances) {
        const rows = await this.api().queryAll(s.siteUrl, SC_REQUESTS.pagesForDay(day, s, appearance));
        pageRows += rows.length;
        const mappedRows: SearchPageRow[] = [];
        for (const row of rows) {
          const url = canonicalizeUrl(row.keys?.[0]);
          if (!url) continue;
          if (!mapped.has(url)) {
            // Unmatched pages are kept too (diagnostics, future products); only counted separately.
            if (!appearance) unmatchedPages += 1;
          }
          mappedRows.push({ canonicalUrl: url, date: day, appearance: appearance ?? 'ALL', clicks: Math.round(row.clicks ?? 0), impressions: Math.round(row.impressions ?? 0), position: row.position ?? null });
        }
        stored += this.metrics.upsertSearchPages(mappedRows);
      }
    }
    stats.searchRows = pageRows;
    stats.searchRowsStored = stored;
    stats.searchUnmatchedPages = unmatchedPages;
    log.info(`Search Console: ${pageRows} page rows for ${window.from}–${window.to}, ${stored} stored, ${unmatchedPages} rows for pages without a product`);
    return { stats, gauges, warnings: [] };
  }

  /** Top queries for one product page (live call, cached per URL until `maxAgeHours`). */
  async queriesForProduct(productName: string, maxAgeHours = 24): Promise<{ rows: SearchQueryRow[]; window: { from: string; to: string }; fetchedAt: string; canonicalUrl: string } | null> {
    const mapping = this.metrics.urlFor(productName);
    if (!mapping) return null;
    const cached = this.metrics.getQueries(mapping.canonicalUrl);
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < maxAgeHours * 3_600_000) return { ...cached, canonicalUrl: mapping.canonicalUrl };
    const s = this.settings();
    const to = addDays(isoDay(), -this.lagDays);
    const from = addDays(to, -27);
    const rows = await this.api().query(s.siteUrl, SC_REQUESTS.queriesForPage(mapping.canonicalUrl, from, to, s));
    const mappedRows = rows
      .map(toQueryRow)
      .filter((r): r is SearchQueryRow => r !== null)
      .sort((a, b) => b.impressions - a.impressions);
    this.metrics.saveQueries(mapping.canonicalUrl, { from, to }, mappedRows);
    return { rows: mappedRows, window: { from, to }, fetchedAt: new Date().toISOString(), canonicalUrl: mapping.canonicalUrl };
  }
}

function toQueryRow(row: SearchAnalyticsRow): SearchQueryRow | null {
  const query = row.keys?.[0];
  if (!query) return null;
  return {
    query,
    clicks: Math.round(row.clicks ?? 0),
    impressions: Math.round(row.impressions ?? 0),
    ctr: row.ctr ?? null,
    position: row.position === undefined ? null : Math.round(row.position * 10) / 10,
  };
}
