import type { RestClient } from './rest-client.js';

/** Google Search Console API (Webmasters v3) – the parts Product360 needs. */

export interface SearchConsoleSite {
  siteUrl: string;
  /** siteOwner | siteFullUser | siteRestrictedUser | siteUnverifiedUser */
  permissionLevel: string;
}

export type SearchDimension = 'date' | 'page' | 'query' | 'country' | 'device' | 'searchAppearance';

export interface SearchAnalyticsFilter {
  dimension: SearchDimension;
  operator?: 'equals' | 'notEquals' | 'contains' | 'notContains' | 'includingRegex' | 'excludingRegex';
  expression: string;
}

export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions?: SearchDimension[];
  type?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
  dimensionFilterGroups?: { groupType?: 'and'; filters: SearchAnalyticsFilter[] }[];
  aggregationType?: 'auto' | 'byPage' | 'byProperty';
  rowLimit?: number;
  startRow?: number;
  dataState?: 'final' | 'all';
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
}

export interface SearchConsoleApi {
  listSites(): Promise<SearchConsoleSite[]>;
  query(siteUrl: string, request: SearchAnalyticsRequest): Promise<SearchAnalyticsRow[]>;
  /** Pages through `startRow` until fewer than `rowLimit` rows come back. */
  queryAll(siteUrl: string, request: SearchAnalyticsRequest): Promise<SearchAnalyticsRow[]>;
}

export const SEARCH_CONSOLE_BASE_URL = 'https://searchconsole.googleapis.com/webmasters/v3';
/** Hard limit of the API per request. */
export const SEARCH_CONSOLE_ROW_LIMIT = 25_000;

/** The `siteUrl` path segment must be percent-encoded as a whole (`sc-domain:example.com`, `https://shop.example/`). */
export function encodeSiteUrl(siteUrl: string): string {
  return encodeURIComponent(siteUrl);
}

export class SearchConsoleClient implements SearchConsoleApi {
  constructor(private readonly http: RestClient) {}

  async listSites(): Promise<SearchConsoleSite[]> {
    const r = await this.http.get<{ siteEntry?: SearchConsoleSite[] }>('sites');
    return r.siteEntry ?? [];
  }

  async query(siteUrl: string, request: SearchAnalyticsRequest): Promise<SearchAnalyticsRow[]> {
    const r = await this.http.post<SearchAnalyticsResponse>(`sites/${encodeSiteUrl(siteUrl)}/searchAnalytics/query`, { body: request });
    return r.rows ?? [];
  }

  async queryAll(siteUrl: string, request: SearchAnalyticsRequest): Promise<SearchAnalyticsRow[]> {
    const rowLimit = request.rowLimit ?? SEARCH_CONSOLE_ROW_LIMIT;
    const all: SearchAnalyticsRow[] = [];
    let startRow = request.startRow ?? 0;
    for (;;) {
      const rows = await this.query(siteUrl, { ...request, rowLimit, startRow });
      all.push(...rows);
      if (rows.length < rowLimit) return all;
      startRow += rows.length;
    }
  }
}

/** Rejects every call until the connector has been configured. */
export function createNotConfiguredSearchConsoleApi(): SearchConsoleApi {
  const reject = () => Promise.reject(new Error('Search Console connector is not configured'));
  return { listSites: reject, query: reject, queryAll: reject };
}
