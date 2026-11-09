import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Database, now } from '../db/database.js';
import type { EventLog } from './event-log.js';
import type { WooCommerceService } from './woocommerce-service.js';

export type AllegroEnvironment = 'sandbox' | 'production';
export interface AllegroOfferQuery {
  limit: number; offset: number; orderBy: 'id' | 'name' | 'status' | 'price' | 'stock'; orderDir: 'asc' | 'desc';
  id?: string; name?: string; status?: string; price?: string; stock?: string;
}
export type AllegroOfferAction =
  | { type: 'price'; amount: string; currency: string; expectedAmount: string; expectedCurrency: string }
  | { type: 'stock'; quantity: number; expectedQuantity: number }
  | { type: 'activate' | 'end'; expectedStatus: string };
type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };
type Connection = { client_id: string; client_secret: string; redirect_uri: string; tokens: string | null; seller_id: string | null; seller_login: string | null; offer_write_enabled: number };
const ENDPOINTS = {
  sandbox: { auth: 'https://allegro.pl.allegrosandbox.pl/auth/oauth', api: 'https://api.allegro.pl.allegrosandbox.pl' },
  production: { auth: 'https://allegro.pl/auth/oauth', api: 'https://api.allegro.pl' },
} as const;
const SCOPES = ['allegro:api:sale:offers:read', 'allegro:api:profile:read'];
export const ALLEGRO_TEMPLATE_FIELDS = ['category', 'parameters', 'description', 'images', 'delivery', 'afterSalesServices', 'payments', 'sellingMode'] as const;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

class AllegroError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

/** Seller OAuth and read-only offer access. Credentials and tokens never leave the server. */
export class AllegroService {
  private readonly key: Buffer;
  private readonly refreshes = new Map<AllegroEnvironment, Promise<Tokens>>();
  private readonly syncs = new Map<AllegroEnvironment, Promise<{ count: number; syncedAt: string }>>();
  private readonly progress = new Map<AllegroEnvironment, { loaded: number; total: number | null }>();
  constructor(private readonly db: Database, secret: string, private readonly events: EventLog, private readonly woocommerce: WooCommerceService, private readonly fetchImpl: typeof fetch = fetch) {
    this.key = scryptSync(secret, 'product360-allegro-v1', 32);
  }
  private seal(value: unknown): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
  }
  private open<T>(value: string): T {
    const [version, iv, tag, data] = value.split(':');
    if (version !== 'v1' || !iv || !tag || !data) throw new AllegroError(409, 'Stored Allegro credentials cannot be read');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString()) as T;
    } catch { throw new AllegroError(409, 'Stored Allegro credentials cannot be read; check SESSION_SECRET'); }
  }
  private connection(env: AllegroEnvironment): Connection {
    const row = this.db.get<Connection>('SELECT client_id, client_secret, redirect_uri, tokens, seller_id, seller_login, offer_write_enabled FROM allegro_connections WHERE environment = ?', [env]);
    if (!row) throw new AllegroError(409, 'Configure the Allegro application first');
    return row;
  }
  status(env: AllegroEnvironment) {
    const row = this.db.get<Connection>('SELECT client_id, client_secret, redirect_uri, tokens, seller_id, seller_login, offer_write_enabled FROM allegro_connections WHERE environment = ?', [env]);
    const sync = row?.seller_id ? this.db.get<{ synced_at: string; offer_count: number }>('SELECT synced_at, offer_count FROM allegro_offer_sync_state WHERE environment = ? AND seller_id = ?', [env, row.seller_id]) : undefined;
    return { environment: env, configured: !!row, connected: !!row?.tokens, clientId: row?.client_id ?? '', redirectUri: row?.redirect_uri ?? '', sellerId: row?.seller_id ?? null, sellerLogin: row?.seller_login ?? null, offerWriteEnabled: !!row?.offer_write_enabled, scopes: row?.offer_write_enabled ? [...SCOPES, 'allegro:api:sale:offers:write'] : SCOPES, syncedAt: sync?.synced_at ?? null, offerCount: Number(sync?.offer_count ?? 0), running: this.syncs.has(env), progress: this.progress.get(env) ?? null };
  }
  configure(env: AllegroEnvironment, clientId: string, secret: string | undefined, redirectUri: string, enableOfferWrites = false) {
    if (env !== 'sandbox' && enableOfferWrites) throw new AllegroError(400, 'Offer writes are available only in sandbox until the integration is validated');
    const uri = new URL(redirectUri);
    if ((uri.protocol !== 'https:' && !(uri.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname))) || uri.username || uri.password || uri.search || uri.hash || !uri.pathname.endsWith('/api/allegro/callback')) {
      throw new AllegroError(400, 'Use an HTTPS callback (or localhost HTTP) ending in /api/allegro/callback, without query or credentials');
    }
    const old = this.db.get<Connection>('SELECT client_id, client_secret, redirect_uri, tokens, seller_id, seller_login, offer_write_enabled FROM allegro_connections WHERE environment = ?', [env]);
    if ((!old || old.client_id !== clientId) && !secret) throw new AllegroError(400, 'Client secret is required for a new Allegro application');
    const oldSecret = old ? this.open<string>(old.client_secret) : null;
    const nextSecret = secret ?? oldSecret!;
    const changed = !old || old.client_id !== clientId || old.redirect_uri !== redirectUri || oldSecret !== nextSecret || !!old.offer_write_enabled !== enableOfferWrites;
    this.db.run(`INSERT INTO allegro_connections (environment, client_id, client_secret, redirect_uri, tokens, seller_id, seller_login, updated_at, offer_write_enabled)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?) ON CONFLICT(environment) DO UPDATE SET client_id=excluded.client_id, client_secret=excluded.client_secret,
      redirect_uri=excluded.redirect_uri, offer_write_enabled=excluded.offer_write_enabled, tokens=?, seller_id=?, seller_login=?, updated_at=excluded.updated_at`,
    [env, clientId, this.seal(nextSecret), redirectUri, now(), enableOfferWrites ? 1 : 0, changed ? null : old?.tokens ?? null, changed ? null : old?.seller_id ?? null, changed ? null : old?.seller_login ?? null]);
    this.events.record('allegro.configured', `Allegro ${env} application configured`);
    return this.status(env);
  }
  authorize(env: AllegroEnvironment, sessionId: string): string {
    const connection = this.connection(env);
    const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const signature = hash(`${connection.client_id}\0${connection.redirect_uri}\0${this.open<string>(connection.client_secret)}\0${connection.offer_write_enabled}`);
    this.db.run('DELETE FROM allegro_oauth_states WHERE expires_at < ?', [now()]);
    this.db.run('INSERT INTO allegro_oauth_states (state_hash, session_hash, environment, verifier, config_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [hash(state), hash(sessionId), env, this.seal(verifier), signature, new Date(Date.now() + 10 * 60_000).toISOString()]);
    const url = new URL(`${ENDPOINTS[env].auth}/authorize`);
    const scopes = connection.offer_write_enabled ? [...SCOPES, 'allegro:api:sale:offers:write'] : SCOPES;
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: connection.client_id, redirect_uri: connection.redirect_uri, state, code_challenge: challenge, code_challenge_method: 'S256', scope: scopes.join(' ') })) url.searchParams.set(key, value);
    return url.toString();
  }
  async complete(state: string, code: string, sessionId: string): Promise<AllegroEnvironment> {
    const stateHash = hash(state);
    const row = this.db.transaction(() => {
      const item = this.db.get<{ environment: AllegroEnvironment; verifier: string; config_hash: string; expires_at: string }>('SELECT environment, verifier, config_hash, expires_at FROM allegro_oauth_states WHERE state_hash = ? AND session_hash = ?', [stateHash, hash(sessionId)]);
      if (item) this.db.run('DELETE FROM allegro_oauth_states WHERE state_hash = ?', [stateHash]);
      return item;
    });
    if (!row || row.expires_at < now()) throw new AllegroError(400, 'Allegro authorization expired or belongs to a different session');
    const connection = this.connection(row.environment);
    if (row.config_hash !== hash(`${connection.client_id}\0${connection.redirect_uri}\0${this.open<string>(connection.client_secret)}\0${connection.offer_write_enabled}`)) throw new AllegroError(409, 'Allegro application settings changed during authorization');
    // Allegro's PKCE code exchange uses client_id and verifier in the request body, without Basic auth.
    const tokens = await this.tokenRequest(row.environment, new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: connection.redirect_uri, client_id: connection.client_id, code_verifier: this.open<string>(row.verifier) }));
    const profile = await this.apiGet(row.environment, '/me', tokens.accessToken);
    if (typeof profile.id !== 'string' || typeof profile.login !== 'string') throw new AllegroError(502, 'Allegro did not return a seller identity');
    const updated = this.db.run('UPDATE allegro_connections SET tokens = ?, seller_id = ?, seller_login = ?, updated_at = ? WHERE environment = ? AND client_id = ? AND client_secret = ? AND redirect_uri = ? AND offer_write_enabled = ?', [this.seal(tokens), profile.id, profile.login, now(), row.environment, connection.client_id, connection.client_secret, connection.redirect_uri, connection.offer_write_enabled]);
    if (!updated.changes) throw new AllegroError(409, 'Allegro application settings changed during authorization');
    this.events.record('allegro.connected', `Allegro ${row.environment} seller connected`, { payload: { sellerId: profile.id } });
    return row.environment;
  }
  private async tokenRequest(env: AllegroEnvironment, body: URLSearchParams, authorization?: string): Promise<Tokens> {
    const response = await this.fetchImpl(`${ENDPOINTS[env].auth}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new AllegroError(502, `Allegro authorization failed (HTTP ${response.status}); reconnect the account`);
    const raw = await response.json() as Record<string, unknown>;
    if (typeof raw.access_token !== 'string' || typeof raw.refresh_token !== 'string' || typeof raw.expires_in !== 'number' || raw.expires_in <= 0) throw new AllegroError(502, 'Allegro returned an invalid token response');
    return { accessToken: raw.access_token, refreshToken: raw.refresh_token, expiresAt: Date.now() + raw.expires_in * 1000 };
  }
  private async access(env: AllegroEnvironment): Promise<string> {
    const connection = this.connection(env);
    if (!connection.tokens) throw new AllegroError(409, 'Connect the Allegro seller account first');
    const current = this.open<Tokens>(connection.tokens);
    if (current.expiresAt > Date.now() + 60_000) return current.accessToken;
    let running = this.refreshes.get(env);
    if (!running) {
      running = this.refresh(env, connection, current).finally(() => this.refreshes.delete(env));
      this.refreshes.set(env, running);
    }
    return (await running).accessToken;
  }
  private async refresh(env: AllegroEnvironment, connection: Connection, current: Tokens): Promise<Tokens> {
    const owner = randomUUID();
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const acquired = this.db.run(`INSERT INTO allegro_refresh_leases (environment, owner, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(environment) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at WHERE allegro_refresh_leases.expires_at < ?`, [env, owner, Date.now() + 45_000, Date.now()]);
      if (acquired.changes) {
        try {
          const latest = this.connection(env);
          if (!latest.tokens) throw new AllegroError(409, 'Allegro connection changed during token refresh; reconnect');
          const latestTokens = this.open<Tokens>(latest.tokens);
          if (latest.tokens !== connection.tokens) {
            if (latestTokens.expiresAt > Date.now() + 60_000) return latestTokens;
            throw new AllegroError(409, 'Allegro connection changed during token refresh; reconnect');
          }
          const secret = this.open<string>(latest.client_secret);
          const tokens = await this.tokenRequest(env, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken }), `Basic ${Buffer.from(`${latest.client_id}:${secret}`).toString('base64')}`);
          const updated = this.db.run('UPDATE allegro_connections SET tokens = ?, updated_at = ? WHERE environment = ? AND tokens = ?', [this.seal(tokens), now(), env, latest.tokens]);
          if (!updated.changes) throw new AllegroError(409, 'Allegro connection changed during token refresh; reconnect');
          return tokens;
        } finally {
          this.db.run('DELETE FROM allegro_refresh_leases WHERE environment = ? AND owner = ?', [env, owner]);
        }
      }
      await delay(250);
    }
    throw new AllegroError(503, 'Allegro token refresh is already in progress; try again');
  }
  private async apiGet(env: AllegroEnvironment, path: string, token: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${ENDPOINTS[env].api}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.allegro.public.v1+json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new AllegroError(response.status === 401 || response.status === 403 ? response.status : 502, `Allegro request failed (HTTP ${response.status})`);
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AllegroError(502, 'Allegro returned an invalid response');
    return data as Record<string, unknown>;
  }
  async testConnection(env: AllegroEnvironment) {
    const profile = await this.apiGet(env, '/me', await this.access(env));
    if (typeof profile.id !== 'string' || profile.id !== this.connection(env).seller_id) throw new AllegroError(409, 'The authorized Allegro seller changed; reconnect');
    return { ok: true };
  }
  syncOffers(env: AllegroEnvironment): Promise<{ count: number; syncedAt: string }> {
    const running = this.syncs.get(env);
    if (running) return running;
    this.progress.set(env, { loaded: 0, total: null });
    const operation = this.doSyncOffers(env).finally(() => { this.syncs.delete(env); this.progress.delete(env); });
    this.syncs.set(env, operation);
    return operation;
  }
  private async doSyncOffers(env: AllegroEnvironment): Promise<{ count: number; syncedAt: string }> {
    const initial = this.connection(env);
    if (!initial.tokens || !initial.seller_id) throw new AllegroError(409, 'Connect the Allegro seller account first');
    const offers: Record<string, unknown>[] = []; const seen = new Set<string>(); let expected: number | undefined;
    for (;;) {
      const query = new URLSearchParams({ limit: '100', offset: String(offers.length) });
      for (const status of ['INACTIVE', 'ACTIVATING', 'ACTIVE', 'ENDED']) query.append('publication.status', status);
      const data = await this.apiGet(env, `/sale/offers?${query}`, await this.access(env));
      if (!Array.isArray(data.offers) || !Number.isSafeInteger(data.totalCount) || Number(data.totalCount) < 0) throw new AllegroError(502, 'Allegro returned an invalid offers response');
      if (expected !== undefined && expected !== data.totalCount) throw new AllegroError(409, 'Allegro offer count changed during synchronization; try again');
      expected = Number(data.totalCount);
      for (const offer of data.offers) {
        if (!offer || typeof offer !== 'object' || Array.isArray(offer) || typeof offer.id !== 'string' || !offer.id || seen.has(offer.id)) throw new AllegroError(502, 'Allegro returned an invalid or duplicate offer');
        seen.add(offer.id); offers.push(offer as Record<string, unknown>);
      }
      this.progress.set(env, { loaded: offers.length, total: expected });
      if (offers.length === expected) break;
      if (!data.offers.length || offers.length > expected || offers.length >= 10_000_000) throw new AllegroError(502, 'Allegro returned an incomplete offer snapshot');
    }
    const current = this.connection(env);
    if (!current.tokens || current.seller_id !== initial.seller_id || current.client_id !== initial.client_id) throw new AllegroError(409, 'Allegro connection changed during synchronization');
    const syncedAt = now(); const seller = initial.seller_id;
    this.db.transaction(() => {
      this.db.run('DELETE FROM allegro_offers WHERE environment = ? AND seller_id = ?', [env, seller]);
      for (const offer of offers) this.db.run('INSERT INTO allegro_offers (environment, seller_id, offer_id, data) VALUES (?, ?, ?, ?)', [env, seller, String(offer.id), JSON.stringify(offer)]);
      this.db.run('INSERT INTO allegro_offer_sync_state (environment, seller_id, synced_at, offer_count) VALUES (?, ?, ?, ?) ON CONFLICT(environment, seller_id) DO UPDATE SET synced_at=excluded.synced_at, offer_count=excluded.offer_count', [env, seller, syncedAt, offers.length]);
    });
    this.events.record('allegro.offers_synced', `Allegro ${env} offers synchronized`, { payload: { sellerId: seller, count: offers.length } });
    return { count: offers.length, syncedAt };
  }
  offers(env: AllegroEnvironment, query: AllegroOfferQuery) {
    const connection = this.connection(env); const seller = connection.seller_id;
    if (!connection.tokens || !seller) throw new AllegroError(409, 'Connect the Allegro seller account first');
    const fields = { id: 'o.offer_id', name: "json_extract(o.data, '$.name')", status: "json_extract(o.data, '$.publication.status')", price: "json_extract(o.data, '$.sellingMode.price.amount')", stock: "json_extract(o.data, '$.stock.available')" };
    const where = ['o.environment = ?', 'o.seller_id = ?']; const params: string[] = [env, seller];
    for (const field of ['id', 'name', 'status', 'price', 'stock'] as const) if (query[field]) {
      where.push(`CAST(${fields[field]} AS TEXT) LIKE ? ESCAPE '\\'`); params.push(`%${query[field]!.replace(/[\\%_]/g, '\\$&')}%`);
    }
    const conditions = where.join(' AND ');
    const sort = query.orderBy === 'price' || query.orderBy === 'stock' ? `CAST(${fields[query.orderBy]} AS REAL)` : fields[query.orderBy];
    const direction = query.orderDir === 'desc' ? 'DESC' : 'ASC';
    const total = Number(this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM allegro_offers o WHERE ${conditions}`, params)?.count ?? 0);
    const rows = this.db.all<{ data: string }>(`SELECT o.data FROM allegro_offers o WHERE ${conditions} ORDER BY ${sort} IS NULL, ${sort} ${direction}, o.offer_id ASC LIMIT ? OFFSET ?`, [...params, query.limit, query.offset]);
    return { environment: env, offers: rows.map((r) => JSON.parse(r.data) as Record<string, unknown>), total, limit: query.limit, offset: query.offset };
  }

  async templatePreview(env: AllegroEnvironment, offerId: string) {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(offerId)) throw new AllegroError(400, 'Invalid Allegro offer ID');
    const current = this.connection(env);
    if (!current.seller_id) throw new AllegroError(409, 'Connect the Allegro seller account first');
    const offer = await this.apiGet(env, `/sale/product-offers/${encodeURIComponent(offerId)}`, await this.access(env));
    if (this.connection(env).seller_id !== current.seller_id) throw new AllegroError(409, 'Allegro seller changed during offer lookup');
    const fields: Record<string, unknown> = {};
    for (const key of ALLEGRO_TEMPLATE_FIELDS) {
      if (key === 'sellingMode') {
        const mode = offer.sellingMode;
        if (mode && typeof mode === 'object' && !Array.isArray(mode) && typeof (mode as Record<string, unknown>).format === 'string') fields.sellingMode = { format: (mode as Record<string, unknown>).format };
      } else if (offer[key] !== undefined && offer[key] !== null) fields[key] = offer[key];
    }
    return { offerId, fields };
  }

  async createTemplate(env: AllegroEnvironment, offerId: string, name: string, selected: string[]) {
    const connection = this.connection(env);
    if (!connection.tokens || !connection.seller_id) throw new AllegroError(409, 'Connect the Allegro seller account first');
    const preview = await this.templatePreview(env, offerId);
    if (this.connection(env).seller_id !== connection.seller_id) throw new AllegroError(409, 'Allegro seller changed during template creation');
    const data = Object.fromEntries(selected.filter((field) => Object.prototype.hasOwnProperty.call(preview.fields, field)).map((field) => [field, preview.fields[field]]));
    if (!Object.keys(data).length) throw new AllegroError(400, 'Select at least one available reusable field');
    const id = randomUUID(); const createdAt = now(); const json = JSON.stringify(data);
    this.db.transaction(() => {
      this.db.run('INSERT INTO allegro_offer_templates (id, environment, seller_id, name, source_offer_id, version, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)', [id, env, connection.seller_id!, name, offerId, json, createdAt, createdAt]);
      this.db.run('INSERT INTO allegro_offer_template_versions (template_id, version, name, data, created_at) VALUES (?, 1, ?, ?, ?)', [id, name, json, createdAt]);
      this.events.record('allegro.template_created', `Allegro ${env} template created`, { payload: { templateId: id, sellerId: connection.seller_id, sourceOfferId: offerId } });
    });
    return { id, name, sourceOfferId: offerId, version: 1, data, createdAt, updatedAt: createdAt };
  }
  templates(env: AllegroEnvironment) {
    const connection = this.connection(env);
    if (!connection.tokens || !connection.seller_id) throw new AllegroError(409, 'Connect the Allegro seller account first');
    return this.db.all<{ id: string; name: string; source_offer_id: string; version: number; data: string; created_at: string; updated_at: string }>('SELECT id, name, source_offer_id, version, data, created_at, updated_at FROM allegro_offer_templates WHERE environment = ? AND seller_id = ? ORDER BY name, id', [env, connection.seller_id]).map((row) => ({ id: row.id, name: row.name, sourceOfferId: row.source_offer_id, version: Number(row.version), data: JSON.parse(row.data) as Record<string, unknown>, createdAt: row.created_at, updatedAt: row.updated_at }));
  }
  updateTemplate(env: AllegroEnvironment, id: string, name: string, version: number, data: Record<string, unknown>) {
    const connection = this.connection(env);
    if (!connection.tokens || !connection.seller_id) throw new AllegroError(409, 'Connect the Allegro seller account first');
    if (!Object.keys(data).length || Object.keys(data).some((field) => !(ALLEGRO_TEMPLATE_FIELDS as readonly string[]).includes(field))) throw new AllegroError(400, 'Template contains an unsupported field');
    const mode = data.sellingMode;
    if (mode !== undefined && (!mode || typeof mode !== 'object' || Array.isArray(mode) || Object.keys(mode).some((field) => field !== 'format') || typeof (mode as Record<string, unknown>).format !== 'string')) throw new AllegroError(400, 'Only the selling format can be saved in a template');
    const next = version + 1; const updatedAt = now(); const json = JSON.stringify(data);
    this.db.transaction(() => {
      const update = this.db.run('UPDATE allegro_offer_templates SET name = ?, data = ?, version = ?, updated_at = ? WHERE id = ? AND environment = ? AND seller_id = ? AND version = ?', [name, json, next, updatedAt, id, env, connection.seller_id, version]);
      if (!update.changes) throw new AllegroError(409, 'Template changed or is unavailable; reload before saving');
      this.db.run('INSERT INTO allegro_offer_template_versions (template_id, version, name, data, created_at) VALUES (?, ?, ?, ?, ?)', [id, next, name, json, updatedAt]);
      this.events.record('allegro.template_updated', `Allegro ${env} template updated`, { payload: { templateId: id, version: next } });
    });
    return this.templates(env).find((row) => row.id === id)!;
  }
  createDraft(env: AllegroEnvironment, templateId: string, wooId: number, amount: string, currency: string) {
    const connection = this.connection(env);
    if (!connection.tokens || !connection.seller_id) throw new AllegroError(409, 'Connect the Allegro seller account first');
    const woo = this.woocommerce.status();
    if (!woo.syncedAt) throw new AllegroError(409, 'Synchronize the WooCommerce store before creating a draft');
    const template = this.db.get<{ id: string; version: number; data: string }>('SELECT id, version, data FROM allegro_offer_templates WHERE id = ? AND environment = ? AND seller_id = ?', [templateId, env, connection.seller_id]);
    const product = this.db.get<{ data: string }>('SELECT data FROM woo_products WHERE id = ?', [wooId]);
    if (!template || !product) throw new AllegroError(404, 'Template or WooCommerce product not found');
    if (/^0+(?:\.0+)?$/.test(amount)) throw new AllegroError(400, 'The marketplace price must be greater than zero');
    const id = randomUUID(); const timestamp = now();
    const data = { template: JSON.parse(template.data) as Record<string, unknown>, product: JSON.parse(product.data) as Record<string, unknown>, price: { amount, currency } };
    this.db.transaction(() => {
      this.db.run('INSERT INTO allegro_offer_drafts (id, environment, seller_id, template_id, template_version, woo_store_url, woo_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, env, connection.seller_id!, templateId, template.version, woo.storeUrl, wooId, JSON.stringify(data), timestamp, timestamp]);
      this.events.record('allegro.draft_created', `Local Allegro ${env} offer draft created`, { payload: { draftId: id, templateId, templateVersion: template.version, wooId } });
    });
    return { id, templateId, templateVersion: Number(template.version), wooId, data, createdAt: timestamp };
  }
  drafts(env: AllegroEnvironment) {
    const connection = this.connection(env);
    if (!connection.tokens || !connection.seller_id) throw new AllegroError(409, 'Connect the Allegro seller account first');
    return this.db.all<{ id: string; template_id: string; template_version: number; woo_id: number; data: string; created_at: string }>('SELECT id, template_id, template_version, woo_id, data, created_at FROM allegro_offer_drafts WHERE environment = ? AND seller_id = ? ORDER BY created_at DESC, id LIMIT 500', [env, connection.seller_id]).map((row) => ({ id: row.id, templateId: row.template_id, templateVersion: Number(row.template_version), wooId: Number(row.woo_id), data: JSON.parse(row.data) as Record<string, unknown>, createdAt: row.created_at }));
  }

  private operationRow(env: AllegroEnvironment, id: string) {
    const seller = this.connection(env).seller_id;
    const row = seller ? this.db.get<{ id: string; offer_id: string; actor_id: number; action: string; requested: string; status: string; operation_path: string | null; message: string | null; created_at: string; updated_at: string }>('SELECT id, offer_id, actor_id, action, requested, status, operation_path, message, created_at, updated_at FROM allegro_offer_operations WHERE id = ? AND environment = ? AND seller_id = ?', [id, env, seller]) : undefined;
    if (!row) throw new AllegroError(404, 'Offer operation not found');
    return { id: row.id, offerId: row.offer_id, actorId: Number(row.actor_id), action: row.action, requested: JSON.parse(row.requested) as AllegroOfferAction, status: row.status, operationPath: row.operation_path, message: row.message, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  operations(env: AllegroEnvironment) {
    this.recoverStaleOperations();
    const connection = this.connection(env);
    if (!connection.tokens || !connection.seller_id) throw new AllegroError(409, 'Connect the Allegro seller account first');
    const ids = this.db.all<{ id: string }>('SELECT id FROM allegro_offer_operations WHERE environment = ? AND seller_id = ? ORDER BY created_at DESC, id LIMIT 100', [env, connection.seller_id]);
    return ids.map((row) => this.operationRow(env, row.id));
  }
  recoverStaleOperations(): void {
    this.db.run("UPDATE allegro_offer_operations SET status = 'uncertain', message = 'The request was interrupted; verify the offer before retrying', updated_at = ? WHERE status = 'sending' AND updated_at < ?", [now(), new Date(Date.now() - 5 * 60_000).toISOString()]);
  }
  private matchesOffer(offer: Record<string, unknown>, action: AllegroOfferAction, desired: boolean): boolean {
    if (action.type === 'price') {
      const mode = offer.sellingMode as { price?: { amount?: string | number; currency?: string } } | undefined;
      const amount = desired ? action.amount : action.expectedAmount;
      const currency = desired ? action.currency : action.expectedCurrency;
      return mode?.price?.amount !== undefined && Number(mode.price.amount) === Number(amount) && mode.price.currency === currency;
    }
    if (action.type === 'stock') {
      const stock = offer.stock as { available?: number } | undefined;
      return stock?.available === (desired ? action.quantity : action.expectedQuantity);
    }
    const publication = offer.publication as { status?: string } | undefined;
    return publication?.status === (desired ? (action.type === 'activate' ? 'ACTIVE' : 'ENDED') : action.expectedStatus);
  }
  async changeOffer(env: AllegroEnvironment, offerId: string, id: string, actorId: number, action: AllegroOfferAction) {
    if (env !== 'sandbox') throw new AllegroError(403, 'Offer writes are restricted to sandbox until the integration is validated');
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(offerId)) throw new AllegroError(400, 'Invalid Allegro offer ID');
    const connection = this.connection(env);
    if (!connection.tokens || !connection.seller_id || !connection.offer_write_enabled) throw new AllegroError(409, 'Enable sandbox offer writes and reconnect the seller account');
    const existing = this.db.get<{ id: string; environment: string; seller_id: string; offer_id: string; actor_id: number; requested: string }>('SELECT id, environment, seller_id, offer_id, actor_id, requested FROM allegro_offer_operations WHERE id = ?', [id]);
    if (existing) {
      if (existing.environment !== env || existing.seller_id !== connection.seller_id || existing.offer_id !== offerId || Number(existing.actor_id) !== actorId || existing.requested !== JSON.stringify(action)) throw new AllegroError(409, 'Operation ID is already used for a different request');
      return this.operationRow(env, id);
    }
    const token = await this.access(env);
    const latest = await this.apiGet(env, `/sale/product-offers/${encodeURIComponent(offerId)}`, token);
    if (!this.matchesOffer(latest, action, false)) throw new AllegroError(409, 'The offer changed since it was displayed; synchronize and review it again');
    if (this.matchesOffer(latest, action, true)) throw new AllegroError(400, 'The requested value is already present on the offer');
    const current = this.connection(env);
    if (current.seller_id !== connection.seller_id || !current.offer_write_enabled || current.client_id !== connection.client_id || current.client_secret !== connection.client_secret || current.redirect_uri !== connection.redirect_uri) throw new AllegroError(409, 'Allegro connection changed before the operation');
    const payload = action.type === 'price' ? { sellingMode: { price: { amount: action.amount, currency: action.currency } } } : action.type === 'stock' ? { stock: { available: action.quantity } } : { publication: { status: action.type === 'activate' ? 'ACTIVE' : 'ENDED' } };
    const timestamp = now();
    try {
      this.db.transaction(() => {
        this.db.run('INSERT INTO allegro_offer_operations (id, environment, seller_id, offer_id, actor_id, action, requested, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, env, connection.seller_id!, offerId, actorId, action.type, JSON.stringify(action), 'sending', timestamp, timestamp]);
        this.events.record('allegro.offer_operation_started', `Sandbox offer ${action.type} requested`, { payload: { operationId: id, offerId, actorId, environment: env } });
      });
    } catch {
      const duplicate = this.db.get<{ environment: string; seller_id: string; offer_id: string; actor_id: number; requested: string }>('SELECT environment, seller_id, offer_id, actor_id, requested FROM allegro_offer_operations WHERE id = ?', [id]);
      if (duplicate) {
        if (duplicate.environment !== env || duplicate.seller_id !== connection.seller_id || duplicate.offer_id !== offerId || Number(duplicate.actor_id) !== actorId || duplicate.requested !== JSON.stringify(action)) throw new AllegroError(409, 'Operation ID is already used for a different request');
        return this.operationRow(env, id);
      }
      throw new AllegroError(500, 'Could not record the offer operation');
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${ENDPOINTS[env].api}/sale/product-offers/${encodeURIComponent(offerId)}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.allegro.public.v1+json', 'Content-Type': 'application/vnd.allegro.public.v1+json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      this.updateOperation(id, 'uncertain', 'Request outcome is unknown; check the offer before retrying');
      return this.operationRow(env, id);
    }
    if (response.status === 202) {
      const location = response.headers.get('location');
      let path: string | null = null;
      try {
        if (location) {
          const target = new URL(location, ENDPOINTS[env].api);
          const expectedPrefix = `/sale/product-offers/${encodeURIComponent(offerId)}/operations/`;
          if (target.origin === ENDPOINTS[env].api && target.pathname.startsWith(expectedPrefix) && /^[a-zA-Z0-9-]+$/.test(target.pathname.slice(expectedPrefix.length)) && !target.search && !target.hash) path = target.pathname;
        }
      } catch { /* do not follow untrusted locations */ }
      if (!path) this.updateOperation(id, 'uncertain', 'Allegro accepted the request without a valid operation location; verify the offer');
      else { this.db.run('UPDATE allegro_offer_operations SET operation_path = ? WHERE id = ?', [path, id]); this.updateOperation(id, 'pending', 'Allegro is processing the request'); }
    } else if (response.ok) {
      try {
        const actual = await this.apiGet(env, `/sale/product-offers/${encodeURIComponent(offerId)}`, await this.access(env));
        this.updateOperation(id, this.matchesOffer(actual, action, true) ? 'succeeded' : 'uncertain', this.matchesOffer(actual, action, true) ? 'Offer change verified' : 'Allegro returned success but the requested value is not yet visible');
      } catch { this.updateOperation(id, 'uncertain', 'Allegro returned success but the offer could not be verified'); }
    } else {
      this.updateOperation(id, response.status >= 500 ? 'uncertain' : 'failed', `Allegro returned HTTP ${response.status}`);
    }
    return this.operationRow(env, id);
  }
  private updateOperation(id: string, status: 'pending' | 'succeeded' | 'failed' | 'uncertain', message: string): void {
    this.db.transaction(() => {
      this.db.run('UPDATE allegro_offer_operations SET status = ?, message = ?, updated_at = ? WHERE id = ?', [status, message, now(), id]);
      this.events.record('allegro.offer_operation_updated', `Sandbox offer operation ${status}`, { severity: status === 'failed' || status === 'uncertain' ? 'warning' : 'info', payload: { operationId: id, status } });
    });
  }
  async checkOperation(env: AllegroEnvironment, id: string) {
    this.recoverStaleOperations();
    const operation = this.operationRow(env, id);
    if (operation.status === 'succeeded' || operation.status === 'failed') return operation;
    if (operation.status === 'sending') throw new AllegroError(409, 'The request is still being sent');
    const token = await this.access(env);
    if (operation.operationPath) {
      const response = await this.fetchImpl(`${ENDPOINTS[env].api}${operation.operationPath}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.allegro.public.v1+json' }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      if (response.status === 202) return operation;
      if (response.status === 422) { this.updateOperation(id, 'failed', 'Allegro rejected the operation'); return this.operationRow(env, id); }
      if (response.status !== 303) throw new AllegroError(502, `Could not check Allegro operation (HTTP ${response.status})`);
    }
    const actual = await this.apiGet(env, `/sale/product-offers/${encodeURIComponent(operation.offerId)}`, token);
    if (this.matchesOffer(actual, operation.requested, true)) this.updateOperation(id, 'succeeded', 'Offer change verified');
    return this.operationRow(env, id);
  }
}
