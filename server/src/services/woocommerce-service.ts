import { Database, fromJson, now, toJson } from '../db/database.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { SettingsService } from './settings-service.js';
import type { EventLog } from './event-log.js';

type WooObject = Record<string, unknown>;
type MatchStatus = 'matched' | 'ambiguous' | 'unmatched' | 'no_sku';
class WooMappingError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
export interface WooOrderQuery {
  limit: number; offset: number;
  orderBy: 'number' | 'status' | 'date' | 'items' | 'total' | 'currency'; orderDir: 'asc' | 'desc';
  number?: string; status?: string; date?: string; items?: string; total?: string; currency?: string;
}
export interface WooMatchQuery {
  orderBy: 'wooId' | 'sku' | 'name' | 'price' | 'stockStatus' | 'status' | 'google'; orderDir: 'asc' | 'desc';
  wooId?: string; sku?: string; name?: string; price?: string; stockStatus?: string; google?: string;
}
const WOO_PAGE_SIZE = 25;
const WOO_TIMEOUT_MS = 60_000;
const WOO_MAX_ATTEMPTS = 3;
interface SyncProgress {
  stage: 'products' | 'variations' | 'orders' | 'saving';
  page: number;
  totalPages: number | null;
  products: number;
  variations: number;
  variationProductsDone: number;
  variationProductsTotal: number;
  orders: number;
  attempt: number;
  startedAt: string;
}

/** Read-only WooCommerce snapshot. Customer and payment details are deliberately not retained. */
export class WooCommerceService {
  private running: Promise<{ products: number; orders: number; syncedAt: string }> | null = null;
  private progress: SyncProgress | null = null;
  private controller: AbortController | null = null;
  private lastError: string | null = null;
  private runId: number | null = null;
  private lastStaleCheck = 0;

  constructor(private readonly db: Database, private readonly settings: SettingsService, private readonly events: EventLog, private readonly fetchImpl: typeof fetch = fetch) {}

  private config() {
    const { wooStoreUrl, wooConsumerKey, wooConsumerSecret } = this.settings.current();
    if (!wooStoreUrl || !wooConsumerKey || !wooConsumerSecret) throw new Error('Configure the WooCommerce store URL and API credentials first');
    const url = new URL(wooStoreUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('WooCommerce store URL must be an HTTPS URL without credentials, query or fragment');
    return { base: url.toString().replace(/\/$/, ''), key: wooConsumerKey, secret: wooConsumerSecret };
  }

  private async pages(path: string, config: ReturnType<WooCommerceService['config']>, firstPageOnly = false, stage?: 'products' | 'variations' | 'orders'): Promise<WooObject[]> {
    const all: WooObject[] = [];
    const ids = new Set<number>();
    let page = 1;
    let totalPages = 1;
    let total: number | undefined;
    do {
      if (stage && this.controller?.signal.aborted) throw new Error('WooCommerce synchronization cancelled');
      if (stage && this.progress) { this.progress.stage = stage; this.progress.page = page; this.progress.totalPages = page === 1 ? null : totalPages; this.saveProgress(); }
      const url = new URL(`${config.base}/wp-json/wc/v3/${path}`);
      url.searchParams.set('per_page', firstPageOnly ? '1' : String(WOO_PAGE_SIZE));
      url.searchParams.set('page', String(page));
      let data: unknown;
      let response: Response | undefined;
      for (let attempt = 1; attempt <= WOO_MAX_ATTEMPTS; attempt++) {
        if (stage && this.progress) { this.progress.attempt = attempt; this.saveProgress(); }
        let retryAfterMs = 0;
        try {
          response = await this.fetchImpl(url, {
            headers: { Authorization: `Basic ${Buffer.from(`${config.key}:${config.secret}`).toString('base64')}`, Accept: 'application/json' },
            redirect: 'error',
            signal: stage && this.controller ? AbortSignal.any([this.controller.signal, AbortSignal.timeout(WOO_TIMEOUT_MS)]) : AbortSignal.timeout(WOO_TIMEOUT_MS),
          });
          if (!response.ok) {
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter && /^\d+$/.test(retryAfter)) retryAfterMs = Math.min(Number(retryAfter) * 1000, 30_000);
            if ((response.status === 429 || response.status >= 500) && attempt < WOO_MAX_ATTEMPTS) throw new WooRetryError(response.status);
            throw new Error(`WooCommerce ${path} page ${page} returned HTTP ${response.status}`);
          }
          data = await response.json();
          break;
        } catch (error) {
          if (stage && this.controller?.signal.aborted) throw new Error('WooCommerce synchronization cancelled');
          const transient = error instanceof WooRetryError || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'TypeError'));
          if (transient && attempt < WOO_MAX_ATTEMPTS) {
            try { await delay(Math.max(retryAfterMs, 500 * 2 ** (attempt - 1)), undefined, stage && this.controller ? { signal: this.controller.signal } : undefined); }
            catch { if (stage && this.controller?.signal.aborted) throw new Error('WooCommerce synchronization cancelled'); throw error; }
            continue;
          }
          if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`WooCommerce ${path} page ${page} timed out after ${WOO_TIMEOUT_MS / 1000} seconds (attempt ${attempt}). Check the store server and try again.`);
          if (error instanceof TypeError) throw new Error(`WooCommerce ${path} page ${page} could not be reached (attempt ${attempt}). Check the connection and try again.`);
          throw error;
        }
      }
      if (!response) throw new Error(`WooCommerce ${path} page ${page} returned no response`);
      if (!Array.isArray(data)) throw new Error(`Invalid WooCommerce ${path} response`);
      const header = response.headers.get('x-wp-totalpages');
      if (!header || !/^\d+$/.test(header)) throw new Error(`WooCommerce ${path} did not provide a valid pagination header`);
      const pages = Number(header);
      if (!Number.isSafeInteger(pages) || pages > 10000 || (page > 1 && pages !== totalPages)) throw new Error(`WooCommerce ${path} pagination changed during synchronization`);
      totalPages = pages;
      if (stage && this.progress) this.progress.totalPages = totalPages;
      const totalHeader = response.headers.get('x-wp-total');
      if (totalHeader !== null) {
        if (!/^\d+$/.test(totalHeader) || !Number.isSafeInteger(Number(totalHeader))) throw new Error(`Invalid WooCommerce ${path} total`);
        const nextTotal = Number(totalHeader);
        if (total !== undefined && total !== nextTotal) throw new Error(`WooCommerce ${path} total changed during synchronization`);
        total = nextTotal;
      } else if (total !== undefined) throw new Error(`WooCommerce ${path} total disappeared during synchronization`);
      for (const item of data) {
        if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.id) || item.id <= 0 || ids.has(item.id)) throw new Error(`Invalid or duplicate WooCommerce ${path} ID`);
        ids.add(item.id);
        all.push(item as WooObject);
      }
      if (stage && this.progress) { this.progress[stage] += data.length; this.saveProgress(); }
      if (page < totalPages && data.length === 0) throw new Error(`WooCommerce ${path} returned an incomplete page`);
      page++;
    } while (!firstPageOnly && page <= totalPages);
    if (!firstPageOnly && total !== undefined && total !== all.length) throw new Error(`WooCommerce ${path} returned an incomplete snapshot`);
    return all;
  }

  async testConnection(): Promise<{ ok: true }> {
    const config = this.config();
    // Test both permissions; neither endpoint is written to.
    await this.pages('products', config, true);
    await this.pages('orders', config, true);
    return { ok: true };
  }

  sync(): Promise<{ products: number; orders: number; syncedAt: string }> {
    if (this.running) return this.running;
    this.lastError = null;
    this.controller = new AbortController();
    this.progress = { stage: 'products', page: 0, totalPages: null, products: 0, variations: 0, variationProductsDone: 0, variationProductsTotal: 0, orders: 0, attempt: 1, startedAt: now() };
    this.runId = Number(this.db.run('INSERT INTO woo_sync_runs (store_url, status, started_at, heartbeat_at, progress) VALUES (?, ?, ?, ?, ?)', [this.settings.current().wooStoreUrl, 'running', this.progress.startedAt, this.progress.startedAt, toJson(this.progress)]).lastInsertRowid);
    this.running = this.doSync().finally(() => { this.running = null; });
    return this.running;
  }

  cancel(): boolean {
    if (!this.running || !this.controller) return false;
    this.controller.abort();
    return true;
  }

  async shutdown(): Promise<void> {
    const pending = this.running;
    this.cancel();
    if (pending) await pending.catch(() => undefined);
  }

  /** A dead run cannot heartbeat for longer than a request timeout plus a grace period. */
  failStaleRuns(): void {
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    this.db.run("UPDATE woo_sync_runs SET status = 'interrupted', finished_at = ?, error = 'Synchronization interrupted' WHERE status = 'running' AND heartbeat_at < ?", [now(), cutoff]);
    this.lastStaleCheck = Date.now();
  }

  private saveProgress(): void {
    if (this.runId !== null && this.progress) this.db.run('UPDATE woo_sync_runs SET heartbeat_at = ?, progress = ? WHERE id = ?', [now(), toJson(this.progress), this.runId]);
  }

  private async doSync(): Promise<{ products: number; orders: number; syncedAt: string }> {
    try {
      const config = this.config();
      const products = await this.pages('products', config, false, 'products');
      const variations: WooObject[] = [];
      const variableProducts = products.filter((product) => product.type === 'variable');
      if (this.progress) { this.progress.variationProductsTotal = variableProducts.length; this.saveProgress(); }
      for (const product of variableProducts) {
        const children = await this.pages(`products/${product.id}/variations`, config, false, 'variations');
        variations.push(...children.map((child) => ({ ...child, parent_id: product.id })));
        if (this.progress) { this.progress.variationProductsDone++; this.saveProgress(); }
      }
      const orders = await this.pages('orders', config, false, 'orders');
      if (this.controller?.signal.aborted) throw new Error('WooCommerce synchronization cancelled');
      const latest = this.config();
      if (latest.base !== config.base || latest.key !== config.key || latest.secret !== config.secret) throw new Error('WooCommerce connection changed during synchronization');
      const syncedAt = now();
      if (this.progress) { this.progress.stage = 'saving'; this.saveProgress(); }
      this.db.transaction(() => {
        this.db.run('DELETE FROM woo_products');
        this.db.run('DELETE FROM woo_orders');
        for (const p of [...products, ...variations]) {
          const fields = pick(p, ['id', 'parent_id', 'sku', 'name', 'type', 'status', 'permalink', 'description', 'short_description', 'price', 'regular_price', 'sale_price', 'stock_status', 'stock_quantity', 'manage_stock', 'images', 'image', 'categories', 'attributes', 'date_modified_gmt']);
          this.db.run('INSERT INTO woo_products (id, parent_id, sku, data) VALUES (?, ?, ?, ?)', [Number(p.id), p.parent_id ? Number(p.parent_id) : null, typeof p.sku === 'string' ? p.sku : '', toJson(fields)]);
        }
        for (const o of orders) {
          const fields = pick(o, ['id', 'number', 'status', 'currency', 'total', 'total_tax', 'shipping_total', 'discount_total', 'date_created_gmt', 'date_modified_gmt']);
          fields.line_items = Array.isArray(o.line_items) ? o.line_items.map((item: WooObject) => pick(item, ['id', 'name', 'product_id', 'variation_id', 'quantity', 'sku', 'subtotal', 'total', 'total_tax'])) : [];
          this.db.run('INSERT INTO woo_orders (id, data) VALUES (?, ?)', [Number(o.id), toJson(fields)]);
        }
        this.db.run('INSERT INTO woo_sync_state (id, store_url, synced_at, product_count, order_count) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET store_url=excluded.store_url, synced_at=excluded.synced_at, product_count=excluded.product_count, order_count=excluded.order_count', [config.base, syncedAt, products.length + variations.length, orders.length]);
        if (this.runId !== null) this.db.run("UPDATE woo_sync_runs SET status = 'success', finished_at = ?, heartbeat_at = ?, progress = ? WHERE id = ?", [syncedAt, syncedAt, toJson(this.progress), this.runId]);
      });
      const result = { products: products.length + variations.length, orders: orders.length, syncedAt };
      this.events.record('woocommerce.sync_completed', 'WooCommerce products and orders synchronized', { payload: result });
      return result;
    } catch (error) {
      this.lastError = error instanceof Error && error.message === 'WooCommerce synchronization cancelled' ? error.message : null;
      const message = error instanceof Error && /^WooCommerce [\w/]+ page \d+ (timed out|returned HTTP \d+|could not be reached)/.test(error.message)
        ? error.message : this.lastError ?? 'WooCommerce synchronization failed';
      this.lastError = message;
      if (this.runId !== null) this.db.run('UPDATE woo_sync_runs SET status = ?, finished_at = ?, heartbeat_at = ?, error = ? WHERE id = ?', [this.controller?.signal.aborted ? 'cancelled' : 'failed', now(), now(), message, this.runId]);
      this.events.record('woocommerce.sync_failed', message, { severity: this.controller?.signal.aborted ? 'warning' : 'error' });
      throw error;
    } finally {
      this.progress = null;
      this.controller = null;
      this.runId = null;
    }
  }

  status() {
    if (Date.now() - this.lastStaleCheck > 60_000) this.failStaleRuns();
    const s = this.settings.current();
    const state = this.db.get<{ store_url: string; synced_at: string; product_count: number; order_count: number }>('SELECT * FROM woo_sync_state WHERE id = 1');
    let current = '';
    try { current = new URL(s.wooStoreUrl).toString().replace(/\/$/, ''); } catch { /* not configured */ }
    const matches = !!state && state.store_url === current;
    const run = this.db.get<{ id: number; status: string; started_at: string; finished_at: string | null; error: string | null }>('SELECT id, status, started_at, finished_at, error FROM woo_sync_runs WHERE store_url = ? ORDER BY id DESC LIMIT 1', [s.wooStoreUrl]);
    return { configured: !!s.wooStoreUrl && !!s.wooConsumerKey && !!s.wooConsumerSecret, storeUrl: s.wooStoreUrl, syncIntervalMinutes: s.wooSyncIntervalMinutes, syncOnStartup: s.wooSyncOnStartup, running: !!this.running, progress: this.progress, lastError: this.lastError, lastRun: run ?? null, syncedAt: matches ? state.synced_at : null, products: matches ? Number(state.product_count) : 0, orders: matches ? Number(state.order_count) : 0 };
  }

  list(kind: 'products' | 'orders', limit: number, offset: number) {
    if (!this.status().syncedAt) return { items: [], total: 0, limit, offset };
    const table = kind === 'products' ? 'woo_products' : 'woo_orders';
    const total = Number(this.db.get<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table}`)?.total ?? 0);
    const order = kind === 'orders' ? 'DESC' : 'ASC';
    const items = this.db.all<{ data: string }>(`SELECT data FROM ${table} ORDER BY id ${order} LIMIT ? OFFSET ?`, [limit, offset]).map((row) => fromJson<WooObject>(row.data, {}));
    return { items, total, limit, offset };
  }

  listOrders(query: WooOrderQuery) {
    const { limit, offset } = query;
    if (!this.status().syncedAt) return { items: [], total: 0, limit, offset };
    const fields = {
      number: "COALESCE(json_extract(o.data, '$.number'), CAST(o.id AS TEXT))",
      status: "json_extract(o.data, '$.status')",
      date: "json_extract(o.data, '$.date_created_gmt')",
      total: "json_extract(o.data, '$.total')",
      currency: "json_extract(o.data, '$.currency')",
    };
    const conditions: string[] = [];
    const params: string[] = [];
    const pattern = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
    for (const field of ['number', 'status', 'date', 'total', 'currency'] as const) {
      if (query[field]) { conditions.push(`CAST(${fields[field]} AS TEXT) LIKE ? ESCAPE '\\'`); params.push(pattern(query[field])); }
    }
    if (query.items) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(o.data, '$.line_items') item WHERE CAST(json_extract(item.value, '$.name') AS TEXT) LIKE ? ESCAPE '\\')");
      params.push(pattern(query.items));
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sort = query.orderBy === 'items' ? "(SELECT MIN(json_extract(item.value, '$.name')) FROM json_each(o.data, '$.line_items') item)" : query.orderBy === 'total' ? `CAST(${fields.total} AS REAL)` : fields[query.orderBy];
    const dir = query.orderDir === 'desc' ? 'DESC' : 'ASC';
    const total = Number(this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM woo_orders o ${where}`, params)?.count ?? 0);
    const rows = this.db.all<{ data: string }>(`SELECT o.data FROM woo_orders o ${where} ORDER BY ${sort} IS NULL, ${sort} ${dir}, o.id ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { items: rows.map((row) => fromJson<WooObject>(row.data, {})), total, limit, offset };
  }

  confirmMapping(wooId: number, productId: string) {
    const state = this.status();
    if (!state.syncedAt) throw new WooMappingError(409, 'Synchronize this WooCommerce store before mapping products');
    const woo = this.db.get<{ id: number }>('SELECT id FROM woo_products WHERE id = ?', [wooId]);
    const google = this.db.get<{ name: string; offer_id: string }>('SELECT name, offer_id FROM products WHERE product_id = ? AND deleted_at IS NULL', [productId]);
    if (!woo || !google) throw new WooMappingError(404, 'WooCommerce or Google product not found in the current snapshot');
    const store = new URL(state.storeUrl).toString().replace(/\/$/, '');
    const existing = this.db.get<{ woo_id: number }>('SELECT woo_id FROM woo_google_mappings WHERE store_url = ? AND google_product_name = ?', [store, google.name]);
    if (existing && Number(existing.woo_id) !== wooId) throw new WooMappingError(409, 'Google product is already mapped to a different WooCommerce product; remove that mapping first');
    if (!existing) {
      this.db.transaction(() => {
        this.db.run('INSERT INTO woo_google_mappings (store_url, woo_id, google_product_name, created_at) VALUES (?, ?, ?, ?)', [store, wooId, google.name, now()]);
        this.events.record('woocommerce.mapping_confirmed', `Mapped WooCommerce product ${wooId} to Google offer ${google.offer_id}`, { payload: { wooId, productName: google.name } });
      });
    }
    return { wooId, productId, created: !existing };
  }

  removeMapping(wooId: number, productId: string): boolean {
    const state = this.status();
    if (!state.syncedAt) throw new WooMappingError(409, 'Synchronize this WooCommerce store before changing mappings');
    const store = new URL(state.storeUrl).toString().replace(/\/$/, '');
    const google = this.db.get<{ name: string }>('SELECT name FROM products WHERE product_id = ?', [productId]);
    if (!google) return false;
    return this.db.transaction(() => {
      const removed = this.db.run('DELETE FROM woo_google_mappings WHERE store_url = ? AND woo_id = ? AND google_product_name = ?', [store, wooId, google.name]);
      if (removed.changes) this.events.record('woocommerce.mapping_removed', `Removed WooCommerce product ${wooId} mapping`, { payload: { wooId, productName: google.name } });
      return removed.changes > 0;
    });
  }

  sourceForGoogle(productName: string) {
    const state = this.status();
    if (!state.syncedAt) return null;
    const store = new URL(state.storeUrl).toString().replace(/\/$/, '');
    const row = this.db.get<{ woo_id: number; data: string | null }>('SELECT m.woo_id, w.data FROM woo_google_mappings m LEFT JOIN woo_products w ON w.id = m.woo_id WHERE m.store_url = ? AND m.google_product_name = ?', [store, productName]);
    if (!row) return null;
    const data = row.data ? fromJson<WooObject>(row.data, {}) : null;
    return { wooId: Number(row.woo_id), present: !!data, syncedAt: state.syncedAt, sku: typeof data?.sku === 'string' ? data.sku : null, name: typeof data?.name === 'string' ? data.name : null, price: typeof data?.price === 'string' ? data.price : null, stockStatus: typeof data?.stock_status === 'string' ? data.stock_status : null, stockQuantity: typeof data?.stock_quantity === 'number' ? data.stock_quantity : null };
  }

  /** Exact SKU/offer ID matches are proposals, not an automatic merge or source-of-truth switch. */
  reconciliation(filter: MatchStatus | 'all', limit: number, offset: number, query?: WooMatchQuery) {
    const summary = { matched: 0, ambiguous: 0, unmatched: 0, no_sku: 0, merchantOnly: 0 };
    if (!this.status().syncedAt) return { summary, items: [], total: 0, limit, offset, syncedAt: null };
    const wooRows = this.db.all<{ id: number; parent_id: number | null; sku: string; data: string }>('SELECT id, parent_id, sku, data FROM woo_products ORDER BY id');
    const merchantRows = this.db.all<{ name: string; product_id: string; offer_id: string; title: string | null }>(
      'SELECT name, product_id, offer_id, title FROM products WHERE deleted_at IS NULL ORDER BY name',
    );
    const wooCounts = new Map<string, number>();
    const wooIds = new Set(wooRows.map((row) => Number(row.id)));
    const merchantByOffer = new Map<string, typeof merchantRows>();
    const merchantByName = new Map(merchantRows.map((row) => [row.name, row]));
    const store = new URL(this.status().storeUrl).toString().replace(/\/$/, '');
    const mappings = this.db.all<{ woo_id: number; google_product_name: string }>('SELECT woo_id, google_product_name FROM woo_google_mappings WHERE store_url = ?', [store]);
    const mappedByGoogle = new Map(mappings.map((row) => [row.google_product_name, Number(row.woo_id)]));
    const mappedByWoo = new Map<number, typeof merchantRows>();
    for (const row of mappings) {
      const google = merchantByName.get(row.google_product_name);
      if (!google) continue;
      const mapped = mappedByWoo.get(Number(row.woo_id)) ?? [];
      mapped.push(google);
      mappedByWoo.set(Number(row.woo_id), mapped);
    }
    for (const row of wooRows) if (row.sku) wooCounts.set(row.sku, (wooCounts.get(row.sku) ?? 0) + 1);
    for (const row of merchantRows) {
      const matches = merchantByOffer.get(row.offer_id) ?? [];
      matches.push(row);
      merchantByOffer.set(row.offer_id, matches);
      const mappedWooId = mappedByGoogle.get(row.name);
      if ((!row.offer_id || !wooCounts.has(row.offer_id)) && (mappedWooId === undefined || !wooIds.has(mappedWooId))) summary.merchantOnly++;
    }
    const items = wooRows.map((row) => {
      const proposed = row.sku ? merchantByOffer.get(row.sku) ?? [] : [];
      const candidates = [...new Map([...(mappedByWoo.get(Number(row.id)) ?? []), ...proposed].map((p) => [p.name, p])).values()];
      const status: MatchStatus = !row.sku ? 'no_sku' : (wooCounts.get(row.sku) ?? 0) > 1 || proposed.length > 1 ? 'ambiguous' : proposed.length === 1 ? 'matched' : 'unmatched';
      summary[status]++;
      const data = fromJson<WooObject>(row.data, {});
      return {
        wooId: Number(row.id), parentId: row.parent_id === null ? null : Number(row.parent_id), sku: row.sku,
        name: typeof data.name === 'string' ? data.name : null, type: typeof data.type === 'string' ? data.type : (row.parent_id ? 'variation' : null),
        price: typeof data.price === 'string' ? data.price : null, stockStatus: typeof data.stock_status === 'string' ? data.stock_status : null,
        status, candidates: candidates.map((item) => ({ name: item.name, productId: item.product_id, offerId: item.offer_id, title: item.title, mappedWooId: mappedByGoogle.get(item.name) ?? null })),
      };
    });
    const contains = (value: unknown, search?: string) => !search || String(value ?? '').toLocaleLowerCase().includes(search.toLocaleLowerCase());
    const filtered = items.filter((item) => (filter === 'all' || item.status === filter) &&
      contains(item.wooId, query?.wooId) && contains(item.sku, query?.sku) && contains(item.name, query?.name) &&
      contains(item.price, query?.price) && contains(item.stockStatus, query?.stockStatus) &&
      contains(item.candidates.map((candidate) => `${candidate.offerId} ${candidate.title ?? ''}`).join(' '), query?.google));
    if (query) {
      const value = (item: typeof items[number]) => query.orderBy === 'google' ? item.candidates.map((c) => `${c.offerId} ${c.title ?? ''}`).join(' ') : item[query.orderBy];
      const dir = query.orderDir === 'desc' ? -1 : 1;
      filtered.sort((a, b) => {
        const av = value(a); const bv = value(b);
        if (av === null || av === '') return bv === null || bv === '' ? a.wooId - b.wooId : 1;
        if (bv === null || bv === '') return -1;
        const result = query.orderBy === 'price' ? Number(av) - Number(bv) : typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { sensitivity: 'base', numeric: true });
        return (Number.isFinite(result) ? result * dir : 0) || a.wooId - b.wooId;
      });
    }
    return { summary, items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset, syncedAt: this.status().syncedAt };
  }
}

class WooRetryError extends Error {
  constructor(readonly status: number) { super(`Retryable WooCommerce HTTP ${status}`); }
}

function pick(value: WooObject, keys: string[]): WooObject {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}
