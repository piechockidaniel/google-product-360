import { createHash } from 'node:crypto';
import { Database, fromJson, now, toJson, type Row } from '../db/database.js';
import type { ItemLevelIssue, Product } from '../google/types.js';
import { encodeProductId, productIdFromName } from '../google/merchant-api.js';

export type AggregatedStatus = 'APPROVED' | 'PARTIALLY_APPROVED' | 'DISAPPROVED' | 'PENDING' | 'NOT_ELIGIBLE' | 'UNKNOWN';
export type IssueLevel = 'error' | 'warning' | 'info';

export interface ProductRecord {
  name: string;
  productId: string;
  offerId: string;
  contentLanguage: string | null;
  feedLabel: string | null;
  title: string | null;
  brand: string | null;
  link: string | null;
  imageLink: string | null;
  price: { amountMicros: string; currencyCode: string } | null;
  availability: string | null;
  dataSource: string | null;
  aggregatedStatus: AggregatedStatus;
  issueCount: number;
  maxSeverity: IssueLevel | null;
  /** Google product category or first product type – used to compare against peers. */
  category: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  deletedAt: string | null;
  /** Product360 summary (present when signals have been computed). */
  signal: ProductSignalSummary | null;
}

export type Recommendation = 'SCALE' | 'FIX' | 'REPRICE' | 'OPTIMISE_LISTING' | 'WATCH' | 'PAUSE' | 'KEEP' | 'NO_DATA';
export const RECOMMENDATIONS: Recommendation[] = ['SCALE', 'FIX', 'REPRICE', 'OPTIMISE_LISTING', 'WATCH', 'PAUSE', 'KEEP', 'NO_DATA'];

export interface ProductSignalSummary {
  recommendation: Recommendation;
  clicks7d: number;
  impressions7d: number;
  clicksPrev7d: number;
  ctr28d: number | null;
  priceVsBenchmark: number | null;
  demand: string | null;
  scImpressions28d: number;
  scPosition28d: number | null;
  scores: Record<string, number>;
  computedAt: string;
}

export interface ProductWithDetails extends ProductRecord {
  product: Product;
  issues: ProductIssueRecord[];
  metadata: ProductMetadata;
}

export interface ProductIssueRecord {
  id: number;
  fingerprint: string;
  productName: string;
  productId: string;
  code: string;
  severity: string | null;
  level: IssueLevel;
  attribute: string | null;
  description: string | null;
  detail: string | null;
  documentation: string | null;
  reportingContext: string | null;
  resolution: string | null;
  applicableCountries: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  /** joined from products */
  offerId?: string;
  title?: string | null;
}

export interface ProductMetadata {
  productName: string;
  tags: string[];
  notes: string;
  fields: Record<string, string>;
  pushedAttributes: Record<string, unknown>;
  pushStatus: 'pending' | 'pushed' | 'error' | null;
  pushError: string | null;
  pushedAt: string | null;
  updatedAt: string | null;
}

export interface ProductQuery {
  q?: string;
  status?: AggregatedStatus[];
  severity?: IssueLevel[];
  issueCode?: string;
  tag?: string;
  feedLabel?: string;
  dataSource?: string;
  brand?: string;
  availability?: string;
  includeDeleted?: boolean;
  hasIssues?: boolean;
  category?: string;
  recommendation?: Recommendation[];
  limit?: number;
  offset?: number;
  orderBy?: (typeof PRODUCT_ORDER_COLUMNS)[number];
  orderDir?: 'asc' | 'desc';
}

export const PRODUCT_ORDER_COLUMNS = ['title', 'offerId', 'status', 'issues', 'lastSeen', 'clicks7d', 'impressions7d', 'demand', 'priceVsBenchmark', 'organicImpressions28d', 'organicPosition'] as const;

/** Category used for peer comparison: Google product category (leaf), else first product type. */
export function productCategory(product: Product): string | null {
  const attrs = product.productAttributes ?? {};
  const gpc = attrs.googleProductCategory?.trim();
  if (gpc) return gpc.split('>').pop()?.trim() || gpc;
  const type = attrs.productTypes?.[0]?.trim();
  if (type) return type.split('>').pop()?.trim() || type;
  return null;
}

export interface IssueQuery {
  since?: string;
  open?: boolean;
  resolvedSince?: string;
  level?: IssueLevel[];
  code?: string;
  productName?: string;
  reportingContext?: string;
  limit?: number;
  offset?: number;
}

export function severityToLevel(severity: string | undefined | null): IssueLevel {
  switch (severity) {
    case 'DISAPPROVED':
    case 'ERROR':
    case 'CRITICAL':
      return 'error';
    case 'DEMOTED':
    case 'WARNING':
      return 'warning';
    default:
      return 'info';
  }
}

const LEVEL_RANK: Record<IssueLevel, number> = { error: 3, warning: 2, info: 1 };

export function computeAggregatedStatus(product: Product): AggregatedStatus {
  const statuses = product.productStatus?.destinationStatuses ?? [];
  let approved = 0;
  let disapproved = 0;
  let pending = 0;
  for (const s of statuses) {
    approved += s.approvedCountries?.length ?? 0;
    disapproved += s.disapprovedCountries?.length ?? 0;
    pending += s.pendingCountries?.length ?? 0;
  }
  if (disapproved > 0 && approved > 0) return 'PARTIALLY_APPROVED';
  if (disapproved > 0) return 'DISAPPROVED';
  if (pending > 0) return 'PENDING';
  if (approved > 0) return 'APPROVED';
  if (statuses.length === 0) {
    // No destination statuses: fall back to the issues to make a guess.
    const issues = product.productStatus?.itemLevelIssues ?? [];
    if (issues.some((i) => i.severity === 'DISAPPROVED')) return 'DISAPPROVED';
    if (issues.some((i) => i.resolution === 'PENDING_PROCESSING')) return 'PENDING';
    return 'UNKNOWN';
  }
  return 'NOT_ELIGIBLE';
}

export function issueFingerprint(productName: string, issue: ItemLevelIssue): string {
  const key = [productName, issue.code ?? '', issue.reportingContext ?? '', issue.attribute ?? ''].join('|');
  return createHash('sha1').update(key).digest('hex');
}

export function accountIssueFingerprint(name: string | undefined, title: string | undefined): string {
  return createHash('sha1').update(`account|${name ?? ''}|${title ?? ''}`).digest('hex');
}

function rowToProduct(row: Row): ProductRecord {
  return {
    name: row.name as string,
    productId: row.product_id as string,
    offerId: row.offer_id as string,
    contentLanguage: (row.content_language as string | null) ?? null,
    feedLabel: (row.feed_label as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    brand: (row.brand as string | null) ?? null,
    link: (row.link as string | null) ?? null,
    imageLink: (row.image_link as string | null) ?? null,
    price:
      row.price_micros !== null && row.price_micros !== undefined
        ? { amountMicros: String(row.price_micros), currencyCode: (row.currency_code as string) ?? '' }
        : null,
    availability: (row.availability as string | null) ?? null,
    dataSource: (row.data_source as string | null) ?? null,
    aggregatedStatus: row.aggregated_status as AggregatedStatus,
    issueCount: Number(row.issue_count ?? 0),
    maxSeverity: (row.max_severity as IssueLevel | null) ?? null,
    category: (row.category as string | null) ?? null,
    firstSeenAt: row.first_seen_at as string,
    lastSeenAt: row.last_seen_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
    signal: row.s_recommendation
      ? {
          recommendation: row.s_recommendation as Recommendation,
          clicks7d: Number(row.s_clicks_7d ?? 0),
          impressions7d: Number(row.s_impressions_7d ?? 0),
          clicksPrev7d: Number(row.s_clicks_prev_7d ?? 0),
          ctr28d: row.s_ctr_28d === null || row.s_ctr_28d === undefined ? null : Number(row.s_ctr_28d),
          priceVsBenchmark: row.s_price_vs_benchmark === null || row.s_price_vs_benchmark === undefined ? null : Number(row.s_price_vs_benchmark),
          demand: (row.s_demand as string | null) ?? null,
          scImpressions28d: Number(row.s_sc_impressions_28d ?? 0),
          scPosition28d: row.s_sc_position_28d === null || row.s_sc_position_28d === undefined ? null : Number(row.s_sc_position_28d),
          scores: fromJson<Record<string, number>>(row.s_scores, {}),
          computedAt: row.s_computed_at as string,
        }
      : null,
  };
}

/** Columns of product_signals joined into product rows (alias `s`). */
const SIGNAL_COLUMNS =
  's.recommendation AS s_recommendation, s.mc_clicks_7d AS s_clicks_7d, s.mc_impressions_7d AS s_impressions_7d, s.mc_clicks_prev_7d AS s_clicks_prev_7d, ' +
  's.mc_ctr_28d AS s_ctr_28d, s.price_vs_benchmark AS s_price_vs_benchmark, s.demand AS s_demand, s.scores AS s_scores, s.computed_at AS s_computed_at, ' +
  's.sc_impressions_28d AS s_sc_impressions_28d, s.sc_position_28d AS s_sc_position_28d';
const SIGNAL_JOIN = 'LEFT JOIN product_signals s ON s.product_name = p.name';

function rowToIssue(row: Row): ProductIssueRecord {
  const severity = (row.severity as string | null) ?? null;
  return {
    id: Number(row.id),
    fingerprint: row.fingerprint as string,
    productName: row.product_name as string,
    productId: encodeProductId(productIdFromName(row.product_name as string)),
    code: row.code as string,
    severity,
    level: severityToLevel(severity),
    attribute: (row.attribute as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    detail: (row.detail as string | null) ?? null,
    documentation: (row.documentation as string | null) ?? null,
    reportingContext: (row.reporting_context as string | null) ?? null,
    resolution: (row.resolution as string | null) ?? null,
    applicableCountries: fromJson<string[]>(row.applicable_countries, []),
    firstSeenAt: row.first_seen_at as string,
    lastSeenAt: row.last_seen_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? null,
    offerId: row.offer_id as string | undefined,
    title: (row.title as string | null) ?? null,
  };
}

function rowToMetadata(row: Row | undefined, productName: string): ProductMetadata {
  if (!row) {
    return { productName, tags: [], notes: '', fields: {}, pushedAttributes: {}, pushStatus: null, pushError: null, pushedAt: null, updatedAt: null };
  }
  return {
    productName,
    tags: fromJson<string[]>(row.tags, []),
    notes: (row.notes as string) ?? '',
    fields: fromJson<Record<string, string>>(row.fields, {}),
    pushedAttributes: fromJson<Record<string, unknown>>(row.pushed_attributes, {}),
    pushStatus: (row.push_status as ProductMetadata['pushStatus']) ?? null,
    pushError: (row.push_error as string | null) ?? null,
    pushedAt: (row.pushed_at as string | null) ?? null,
    updatedAt: (row.updated_at as string | null) ?? null,
  };
}

export interface UpsertResult {
  newIssues: ProductIssueRecord[];
  resolvedIssues: ProductIssueRecord[];
  isNewProduct: boolean;
  statusChanged: boolean;
  previousStatus: AggregatedStatus | null;
}

/**
 * Repository for the locally stored product snapshot, product issues and metadata.
 */
export class ProductStore {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------ products
  upsertProduct(product: Product, seenAt: string = now()): UpsertResult {
    const name = product.name!;
    const attrs = product.productAttributes ?? {};
    const issues = product.productStatus?.itemLevelIssues ?? [];
    const status = computeAggregatedStatus(product);
    const levels = issues.map((i) => severityToLevel(i.severity));
    const maxSeverity = levels.length ? levels.reduce((a, b) => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b)) : null;

    const existing = this.db.get<{ aggregated_status: string; first_seen_at: string }>(
      'SELECT aggregated_status, first_seen_at FROM products WHERE name = ?',
      [name],
    );

    this.db.run(
      `INSERT INTO products (name, product_id, offer_id, content_language, feed_label, title, brand, link, image_link,
          price_micros, currency_code, availability, data_source, aggregated_status, issue_count, max_severity, raw_json,
          first_seen_at, last_seen_at, deleted_at, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(name) DO UPDATE SET
          product_id = excluded.product_id, offer_id = excluded.offer_id, content_language = excluded.content_language,
          feed_label = excluded.feed_label, title = excluded.title, brand = excluded.brand, link = excluded.link,
          image_link = excluded.image_link, price_micros = excluded.price_micros, currency_code = excluded.currency_code,
          availability = excluded.availability, data_source = excluded.data_source, aggregated_status = excluded.aggregated_status,
          issue_count = excluded.issue_count, max_severity = excluded.max_severity, raw_json = excluded.raw_json,
          last_seen_at = excluded.last_seen_at, deleted_at = NULL, category = excluded.category`,
      [
        name,
        encodeProductId(productIdFromName(name)),
        product.offerId ?? '',
        product.contentLanguage ?? null,
        product.feedLabel ?? null,
        attrs.title ?? null,
        attrs.brand ?? null,
        attrs.link ?? null,
        attrs.imageLink ?? null,
        attrs.price?.amountMicros !== undefined ? Number(attrs.price.amountMicros) : null,
        attrs.price?.currencyCode ?? null,
        attrs.availability ?? null,
        product.dataSource ?? null,
        status,
        issues.length,
        maxSeverity,
        toJson(product),
        existing?.first_seen_at ?? seenAt,
        seenAt,
        productCategory(product),
      ],
    );

    const diff = this.syncIssues(name, issues, seenAt);
    return {
      ...diff,
      isNewProduct: !existing,
      statusChanged: !!existing && existing.aggregated_status !== status,
      previousStatus: (existing?.aggregated_status as AggregatedStatus | undefined) ?? null,
    };
  }

  /** Marks products not seen in the latest full sync as deleted and resolves their issues. */
  markMissingAsDeleted(seenBefore: string, deletedAt: string = now()): string[] {
    const missing = this.db.all<{ name: string }>('SELECT name FROM products WHERE last_seen_at < ? AND deleted_at IS NULL', [seenBefore]);
    for (const { name } of missing) {
      this.db.run('UPDATE products SET deleted_at = ? WHERE name = ?', [deletedAt, name]);
      this.db.run('UPDATE product_issues SET resolved_at = ? WHERE product_name = ? AND resolved_at IS NULL', [deletedAt, name]);
    }
    return missing.map((m) => m.name);
  }

  getProduct(name: string): ProductWithDetails | undefined {
    const row = this.db.get(`SELECT p.*, ${SIGNAL_COLUMNS} FROM products p ${SIGNAL_JOIN} WHERE p.name = ?`, [name]);
    if (!row) return undefined;
    return {
      ...rowToProduct(row),
      product: fromJson<Product>(row.raw_json, {}),
      issues: this.listIssues({ productName: name, open: true }).items,
      metadata: this.getMetadata(name),
    };
  }

  getProductByEncodedId(productId: string): ProductWithDetails | undefined {
    const row = this.db.get<{ name: string }>('SELECT name FROM products WHERE product_id = ?', [productId]);
    return row ? this.getProduct(row.name) : undefined;
  }

  getRawProduct(name: string): Product | undefined {
    const row = this.db.get<{ raw_json: string }>('SELECT raw_json FROM products WHERE name = ?', [name]);
    return row ? fromJson<Product>(row.raw_json, {}) : undefined;
  }

  listProducts(query: ProductQuery = {}): { items: ProductRecord[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!query.includeDeleted) where.push('p.deleted_at IS NULL');
    if (query.q) {
      where.push('(p.title LIKE ? OR p.offer_id LIKE ? OR p.brand LIKE ?)');
      const like = `%${query.q}%`;
      params.push(like, like, like);
    }
    if (query.status?.length) {
      where.push(`p.aggregated_status IN (${query.status.map(() => '?').join(',')})`);
      params.push(...query.status);
    }
    if (query.severity?.length) {
      where.push(`p.max_severity IN (${query.severity.map(() => '?').join(',')})`);
      params.push(...query.severity);
    }
    if (query.hasIssues === true) where.push('p.issue_count > 0');
    if (query.hasIssues === false) where.push('p.issue_count = 0');
    if (query.feedLabel) {
      where.push('p.feed_label = ?');
      params.push(query.feedLabel);
    }
    if (query.dataSource) {
      where.push('p.data_source = ?');
      params.push(query.dataSource);
    }
    if (query.brand) {
      where.push('p.brand = ?');
      params.push(query.brand);
    }
    if (query.availability) {
      where.push('p.availability = ?');
      params.push(query.availability);
    }
    if (query.issueCode) {
      where.push('EXISTS (SELECT 1 FROM product_issues i WHERE i.product_name = p.name AND i.resolved_at IS NULL AND i.code = ?)');
      params.push(query.issueCode);
    }
    if (query.tag) {
      where.push("EXISTS (SELECT 1 FROM product_metadata m, json_each(m.tags) t WHERE m.product_name = p.name AND t.value = ?)");
      params.push(query.tag);
    }
    if (query.category) {
      where.push('p.category = ?');
      params.push(query.category);
    }
    if (query.recommendation?.length) {
      where.push(`COALESCE(s.recommendation, 'NO_DATA') IN (${query.recommendation.map(() => '?').join(',')})`);
      params.push(...query.recommendation);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderColumn =
      {
        title: 'p.title',
        offerId: 'p.offer_id',
        status: 'p.aggregated_status',
        issues: 'p.issue_count',
        lastSeen: 'p.last_seen_at',
        clicks7d: 'COALESCE(s.mc_clicks_7d, 0)',
        impressions7d: 'COALESCE(s.mc_impressions_7d, 0)',
        demand: "COALESCE(json_extract(s.scores, '$.demand'), -1)",
        priceVsBenchmark: 'COALESCE(s.price_vs_benchmark, -999)',
        organicImpressions28d: 'COALESCE(s.sc_impressions_28d, 0)',
        organicPosition: 'COALESCE(s.sc_position_28d, 999)',
      }[query.orderBy ?? 'offerId'] ?? 'p.offer_id';
    const dir = query.orderDir === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 1000);
    const offset = Math.max(query.offset ?? 0, 0);

    const total = Number(this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM products p ${SIGNAL_JOIN} ${whereSql}`, params)?.c ?? 0);
    const rows = this.db.all(`SELECT p.*, ${SIGNAL_COLUMNS} FROM products p ${SIGNAL_JOIN} ${whereSql} ORDER BY ${orderColumn} ${dir}, p.name ASC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    return { items: rows.map(rowToProduct), total };
  }

  /** Products that appear in a signal bucket, most relevant first (dashboard lists). */
  listByRecommendation(recommendation: Recommendation, limit = 10): ProductRecord[] {
    return this.listProducts({ recommendation: [recommendation], orderBy: 'impressions7d', orderDir: 'desc', limit }).items;
  }

  recommendationCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.db.all<{ r: string; c: number }>(
      `SELECT COALESCE(s.recommendation, 'NO_DATA') AS r, COUNT(*) AS c FROM products p ${SIGNAL_JOIN} WHERE p.deleted_at IS NULL GROUP BY 1`,
    )) {
      out[row.r] = Number(row.c);
    }
    return out;
  }

  /** offer_id -> products (several when the same id exists for more feed labels / languages). */
  offerIndex(): Map<string, ProductRecord[]> {
    const index = new Map<string, ProductRecord[]>();
    for (const p of this.listAllProducts({ includeDeleted: true })) {
      for (const key of new Set([p.offerId, p.offerId.toLowerCase()])) index.set(key, [...(index.get(key) ?? []), p]);
    }
    return index;
  }

  /** gtin -> product name (first active product carrying the GTIN). */
  gtinIndex(): Map<string, string> {
    const index = new Map<string, string>();
    const rows = this.db.all<{ name: string; g: string }>(
      "SELECT p.name, g.value AS g FROM products p, json_each(json_extract(p.raw_json, '$.productAttributes.gtins')) g WHERE p.deleted_at IS NULL",
    );
    for (const r of rows) if (!index.has(r.g)) index.set(r.g, r.name);
    return index;
  }

  /** Lightweight rows for the signals service (every active product). */
  signalInputs(): { name: string; category: string | null; brand: string | null; status: AggregatedStatus; maxSeverity: IssueLevel | null; availability: string | null; priceMicros: number | null }[] {
    return this.db
      .all<{ name: string; category: string | null; brand: string | null; aggregated_status: string; max_severity: string | null; availability: string | null; price_micros: number | null }>(
        'SELECT name, category, brand, aggregated_status, max_severity, availability, price_micros FROM products WHERE deleted_at IS NULL',
      )
      .map((r) => ({
        name: r.name,
        category: r.category,
        brand: r.brand,
        status: r.aggregated_status as AggregatedStatus,
        maxSeverity: (r.max_severity as IssueLevel | null) ?? null,
        availability: r.availability,
        priceMicros: r.price_micros === null ? null : Number(r.price_micros),
      }));
  }

  /** Returns every product matching the query (used by workflows). */
  listAllProducts(query: ProductQuery = {}): ProductRecord[] {
    const out: ProductRecord[] = [];
    let offset = 0;
    for (;;) {
      const page = this.listProducts({ ...query, limit: 1000, offset }).items;
      out.push(...page);
      if (page.length < 1000) return out;
      offset += 1000;
    }
  }

  productStats(): {
    total: number;
    byStatus: Record<string, number>;
    withErrors: number;
    withWarnings: number;
    deleted: number;
  } {
    const byStatus: Record<string, number> = {};
    for (const row of this.db.all<{ s: string; c: number }>(
      'SELECT aggregated_status AS s, COUNT(*) AS c FROM products WHERE deleted_at IS NULL GROUP BY aggregated_status',
    )) {
      byStatus[row.s] = Number(row.c);
    }
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const withErrors = Number(this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM products WHERE deleted_at IS NULL AND max_severity = 'error'")?.c ?? 0);
    const withWarnings = Number(this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM products WHERE deleted_at IS NULL AND max_severity = 'warning'")?.c ?? 0);
    const deleted = Number(this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM products WHERE deleted_at IS NOT NULL')?.c ?? 0);
    return { total, byStatus, withErrors, withWarnings, deleted };
  }

  distinctValues(column: 'brand' | 'feed_label' | 'data_source' | 'availability' | 'category'): string[] {
    return this.db
      .all<{ v: string }>(`SELECT DISTINCT ${column} AS v FROM products WHERE deleted_at IS NULL AND ${column} IS NOT NULL ORDER BY 1`)
      .map((r) => r.v);
  }

  // ------------------------------------------------------------ issues
  private syncIssues(productName: string, issues: ItemLevelIssue[], seenAt: string): Pick<UpsertResult, 'newIssues' | 'resolvedIssues'> {
    const openRows = this.db.all<{ fingerprint: string; id: number }>(
      'SELECT id, fingerprint FROM product_issues WHERE product_name = ? AND resolved_at IS NULL',
      [productName],
    );
    const open = new Map(openRows.map((r) => [r.fingerprint, r.id]));
    const seen = new Set<string>();
    const newIssues: ProductIssueRecord[] = [];

    for (const issue of issues) {
      const fp = issueFingerprint(productName, issue);
      if (seen.has(fp)) continue;
      seen.add(fp);
      const params = [
        issue.severity ?? null,
        issue.description ?? null,
        issue.detail ?? null,
        issue.documentation ?? null,
        issue.resolution ?? null,
        toJson(issue.applicableCountries ?? []),
        seenAt,
      ];
      if (open.has(fp)) {
        this.db.run(
          `UPDATE product_issues SET severity = ?, description = ?, detail = ?, documentation = ?, resolution = ?,
             applicable_countries = ?, last_seen_at = ? WHERE fingerprint = ?`,
          [...params, fp],
        );
      } else {
        // Either brand new, or it was resolved earlier and has re-appeared -> new occurrence.
        this.db.run(
          `INSERT INTO product_issues (fingerprint, product_name, code, severity, attribute, description, detail, documentation,
             reporting_context, resolution, applicable_countries, first_seen_at, last_seen_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(fingerprint) DO UPDATE SET severity = excluded.severity, description = excluded.description,
             detail = excluded.detail, documentation = excluded.documentation, resolution = excluded.resolution,
             applicable_countries = excluded.applicable_countries, first_seen_at = excluded.first_seen_at,
             last_seen_at = excluded.last_seen_at, resolved_at = NULL`,
          [
            fp,
            productName,
            issue.code ?? 'unknown',
            issue.severity ?? null,
            issue.attribute ?? null,
            issue.description ?? null,
            issue.detail ?? null,
            issue.documentation ?? null,
            issue.reportingContext ?? null,
            issue.resolution ?? null,
            toJson(issue.applicableCountries ?? []),
            seenAt,
            seenAt,
          ],
        );
        const row = this.db.get('SELECT * FROM product_issues WHERE fingerprint = ?', [fp]);
        if (row) newIssues.push(rowToIssue(row));
      }
    }

    const resolvedIssues: ProductIssueRecord[] = [];
    for (const [fp, id] of open) {
      if (seen.has(fp)) continue;
      this.db.run('UPDATE product_issues SET resolved_at = ? WHERE id = ?', [seenAt, id]);
      const row = this.db.get('SELECT * FROM product_issues WHERE id = ?', [id]);
      if (row) resolvedIssues.push(rowToIssue(row));
    }
    return { newIssues, resolvedIssues };
  }

  listIssues(query: IssueQuery = {}): { items: ProductIssueRecord[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.open) where.push('i.resolved_at IS NULL');
    if (query.since) {
      where.push('i.first_seen_at > ?');
      params.push(query.since);
    }
    if (query.resolvedSince) {
      where.push('i.resolved_at > ?');
      params.push(query.resolvedSince);
    }
    if (query.level?.length) {
      const sev: string[] = [];
      for (const l of query.level) {
        if (l === 'error') sev.push('DISAPPROVED', 'ERROR');
        if (l === 'warning') sev.push('DEMOTED', 'WARNING');
        if (l === 'info') sev.push('NOT_IMPACTED', 'INFO', 'SEVERITY_UNSPECIFIED');
      }
      where.push(`COALESCE(i.severity, 'SEVERITY_UNSPECIFIED') IN (${sev.map(() => '?').join(',')})`);
      params.push(...sev);
    }
    if (query.code) {
      where.push('i.code = ?');
      params.push(query.code);
    }
    if (query.productName) {
      where.push('i.product_name = ?');
      params.push(query.productName);
    }
    if (query.reportingContext) {
      where.push('i.reporting_context = ?');
      params.push(query.reportingContext);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 5000);
    const offset = Math.max(query.offset ?? 0, 0);
    const total = Number(this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM product_issues i ${whereSql}`, params)?.c ?? 0);
    const rows = this.db.all(
      `SELECT i.*, p.offer_id, p.title FROM product_issues i LEFT JOIN products p ON p.name = i.product_name
       ${whereSql} ORDER BY i.first_seen_at DESC, i.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { items: rows.map(rowToIssue), total };
  }

  issueSummary(since?: string): { code: string; severity: string | null; level: IssueLevel; description: string | null; attribute: string | null; count: number; newCount: number }[] {
    const rows = this.db.all<{ code: string; severity: string | null; description: string | null; attribute: string | null; count: number; new_count: number }>(
      `SELECT code, MAX(severity) AS severity, MAX(description) AS description, MAX(attribute) AS attribute, COUNT(*) AS count,
              SUM(CASE WHEN first_seen_at > ? THEN 1 ELSE 0 END) AS new_count
       FROM product_issues WHERE resolved_at IS NULL GROUP BY code ORDER BY count DESC`,
      [since ?? ''],
    );
    return rows.map((r) => ({
      code: r.code,
      severity: r.severity,
      level: severityToLevel(r.severity),
      description: r.description,
      attribute: r.attribute,
      count: Number(r.count),
      newCount: Number(r.new_count),
    }));
  }

  // ------------------------------------------------------------ metadata
  getMetadata(productName: string): ProductMetadata {
    return rowToMetadata(this.db.get('SELECT * FROM product_metadata WHERE product_name = ?', [productName]), productName);
  }

  saveMetadata(productName: string, patch: Partial<Pick<ProductMetadata, 'tags' | 'notes' | 'fields'>>): ProductMetadata {
    const current = this.getMetadata(productName);
    const next = {
      tags: [...new Set((patch.tags ?? current.tags).map((t) => t.trim()).filter(Boolean))].sort(),
      notes: patch.notes ?? current.notes,
      fields: patch.fields ?? current.fields,
    };
    this.db.run(
      `INSERT INTO product_metadata (product_name, tags, notes, fields, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(product_name) DO UPDATE SET tags = excluded.tags, notes = excluded.notes, fields = excluded.fields, updated_at = excluded.updated_at`,
      [productName, toJson(next.tags), next.notes, toJson(next.fields), now()],
    );
    return this.getMetadata(productName);
  }

  savePushedAttributes(
    productName: string,
    attributes: Record<string, unknown>,
    status: 'pending' | 'pushed' | 'error',
    error: string | null = null,
  ): ProductMetadata {
    const ts = now();
    this.db.run(
      `INSERT INTO product_metadata (product_name, pushed_attributes, push_status, push_error, pushed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(product_name) DO UPDATE SET pushed_attributes = excluded.pushed_attributes, push_status = excluded.push_status,
         push_error = excluded.push_error, pushed_at = excluded.pushed_at, updated_at = excluded.updated_at`,
      [productName, toJson(attributes), status, error, status === 'pushed' ? ts : null, ts],
    );
    return this.getMetadata(productName);
  }

  allTags(): { tag: string; count: number }[] {
    return this.db
      .all<{ tag: string; count: number }>(
        'SELECT t.value AS tag, COUNT(*) AS count FROM product_metadata m, json_each(m.tags) t GROUP BY t.value ORDER BY count DESC, tag ASC',
      )
      .map((r) => ({ tag: r.tag, count: Number(r.count) }));
  }
}
