import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { decodeProductId } from '../../google/merchant-api.js';
import { ATTRIBUTE_CATALOG } from '../../services/attribute-catalog.js';
import { PRODUCT_ORDER_COLUMNS } from '../../services/product-store.js';
import { mapWithConcurrency } from '../../util/pool.js';
import { notFound } from '../server.js';

const csv = (schema: z.ZodTypeAny) => z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(schema).optional());

const listQuerySchema = z.object({
  q: z.string().optional(),
  status: csv(z.enum(['APPROVED', 'PARTIALLY_APPROVED', 'DISAPPROVED', 'PENDING', 'NOT_ELIGIBLE', 'UNKNOWN'])),
  severity: csv(z.enum(['error', 'warning', 'info'])),
  issueCode: z.string().optional(),
  tag: z.string().optional(),
  feedLabel: z.string().optional(),
  dataSource: z.string().optional(),
  brand: z.string().optional(),
  availability: z.string().optional(),
  hasIssues: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : undefined), z.boolean().optional()),
  includeDeleted: z.preprocess((v) => v === 'true', z.boolean().optional()),
  category: z.string().optional(),
  recommendation: csv(z.enum(['SCALE', 'FIX', 'REPRICE', 'OPTIMISE_LISTING', 'WATCH', 'PAUSE', 'KEEP', 'NO_DATA'])),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  orderBy: z.enum(PRODUCT_ORDER_COLUMNS).optional(),
  orderDir: z.enum(['asc', 'desc']).optional(),
});

const metadataSchema = z.object({
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  fields: z.record(z.string()).optional(),
});

const attributesSchema = z.object({
  attributes: z.record(z.unknown()).default({}),
  customAttributes: z.array(z.object({ name: z.string().min(1), value: z.string() })).optional(),
});

const bulkSchema = z.object({
  productIds: z.array(z.string().min(1)).min(1).max(500),
  attributes: z.record(z.unknown()).optional(),
  customAttributes: z.array(z.object({ name: z.string().min(1), value: z.string() })).optional(),
  addTags: z.array(z.string()).optional(),
  removeTags: z.array(z.string()).optional(),
});

const remediationSchema = z.object({ issueCode: z.string().min(1) });

export function registerProductRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/products', async (request) => {
    const query = listQuerySchema.parse(request.query);
    const result = ctx.products.listProducts(query);
    return { ...result, limit: query.limit ?? 50, offset: query.offset ?? 0 };
  });

  app.get('/products/facets', async () => ({
    brands: ctx.products.distinctValues('brand'),
    feedLabels: ctx.products.distinctValues('feed_label'),
    dataSources: ctx.products.distinctValues('data_source'),
    availability: ctx.products.distinctValues('availability'),
    tags: ctx.products.allTags(),
    issueCodes: ctx.products.issueSummary(),
    attributeCatalog: ATTRIBUTE_CATALOG,
    categories: ctx.products.distinctValues('category'),
    recommendations: ctx.products.recommendationCounts(),
    signalsComputed: ctx.signals.hasSignals(),
    searchConsoleEnabled: ctx.searchConsole.isConfigured(),
  }));

  app.get<{ Params: { id: string } }>('/products/:id', async (request) => {
    const product = ctx.products.getProductByEncodedId(request.params.id);
    if (!product) throw notFound('Product not found in local snapshot');
    return product;
  });

  /** Product360: everything we know about one product (metrics, market, signal). */
  app.get<{ Params: { id: string } }>('/products/:id/360', async (request) => {
    const product = ctx.products.getProductByEncodedId(request.params.id);
    if (!product) throw notFound('Product not found in local snapshot');
    const days = Number((request.query as { days?: string }).days ?? 90);
    return ctx.product360.forProduct(product, Number.isFinite(days) ? Math.min(Math.max(days, 7), 400) : 90);
  });

  /** Product360: top organic queries of the product's landing page (live Search Console call, cached 24 h). */
  app.get<{ Params: { id: string } }>('/products/:id/search-queries', async (request) => {
    const product = ctx.products.getProductByEncodedId(request.params.id);
    if (!product) throw notFound('Product not found in local snapshot');
    if (!ctx.searchConsole.isConfigured()) return { enabled: false, canonicalUrl: null, rows: [], window: null, fetchedAt: null };
    const refresh = (request.query as { refresh?: string }).refresh === 'true';
    const result = await ctx.searchConsole.queriesForProduct(product.name, refresh ? 0 : 24);
    if (!result) return { enabled: true, canonicalUrl: null, rows: [], window: null, fetchedAt: null };
    return { enabled: true, ...result };
  });

  /** Live re-read from Google. */
  app.post<{ Params: { id: string } }>('/products/:id/refresh', async (request) => {
    const product = await ctx.sync.refreshProduct(decodeProductId(request.params.id), 'manual');
    if (!product) throw notFound('Product not found');
    return product;
  });

  /** Rendered (human readable, with resolution actions) issues from the issue resolution API. */
  app.get<{ Params: { id: string } }>('/products/:id/rendered-issues', async (request) => {
    const issues = await ctx.account.renderProductIssues(decodeProductId(request.params.id));
    return { issues };
  });

  app.get<{ Params: { id: string } }>('/products/:id/history', async (request) => {
    const product = ctx.products.getProductByEncodedId(request.params.id);
    if (!product) throw notFound('Product not found in local snapshot');
    return {
      issues: ctx.products.listIssues({ productName: product.name, limit: 500 }).items,
      events: ctx.events.list({ limit: 100 }).items.filter((e) => e.productName === product.name),
    };
  });

  app.get<{ Params: { id: string } }>('/products/:id/remediations', async (request) => {
    const product = ctx.products.getProductByEncodedId(request.params.id);
    if (!product) throw notFound('Product not found in local snapshot');
    return { proposals: ctx.remediations.proposals(product.name), operations: ctx.remediations.list(product.name) };
  });

  app.post<{ Params: { id: string } }>('/products/:id/remediations', async (request, reply) => {
    const product = ctx.products.getProductByEncodedId(request.params.id);
    if (!product) throw notFound('Product not found in local snapshot');
    const body = remediationSchema.parse(request.body);
    const operation = ctx.remediations.create(product.name, body.issueCode);
    return reply.status(202).send(operation);
  });

  app.get<{ Params: { operationId: string } }>('/remediations/:operationId', async (request) => {
    const operation = ctx.remediations.get(request.params.operationId);
    if (!operation) throw notFound('Remediation operation not found');
    return operation;
  });

  app.put<{ Params: { id: string } }>('/products/:id/metadata', async (request) => {
    const product = ctx.products.getProductByEncodedId(request.params.id);
    if (!product) throw notFound('Product not found in local snapshot');
    const body = metadataSchema.parse(request.body);
    const metadata = ctx.products.saveMetadata(product.name, body);
    ctx.events.record('metadata.updated', `Updated local metadata of ${product.offerId}`, { productName: product.name, payload: body });
    return metadata;
  });

  /** Push attributes to Google via the enrichment data source. */
  app.post<{ Params: { id: string } }>('/products/:id/attributes', async (request) => {
    const product = ctx.products.getProductByEncodedId(request.params.id);
    if (!product) throw notFound('Product not found in local snapshot');
    const body = attributesSchema.parse(request.body);
    const result = await ctx.enrichment.pushAttributes(product.name, body.attributes, body.customAttributes);
    return result;
  });

  app.delete<{ Params: { id: string } }>('/products/:id/attributes', async (request) => {
    const product = ctx.products.getProductByEncodedId(request.params.id);
    if (!product) throw notFound('Product not found in local snapshot');
    return ctx.enrichment.clearAttributes(product.name);
  });

  /** Bulk operation on many products at once. */
  app.post('/products/bulk', async (request) => {
    const body = bulkSchema.parse(request.body);
    const pushes = (body.attributes && Object.keys(body.attributes).length) || body.customAttributes;
    if (pushes) await ctx.enrichment.ensureDataSource(); // once, not per product
    const pooled = await mapWithConcurrency(body.productIds, ctx.settings.current().apiConcurrency, async (productId) => {
      const product = ctx.products.getProductByEncodedId(productId);
      if (!product) throw new Error('not found');
      if (body.addTags?.length || body.removeTags?.length) {
        const tags = new Set(product.metadata.tags);
        for (const t of body.addTags ?? []) tags.add(t);
        for (const t of body.removeTags ?? []) tags.delete(t);
        ctx.products.saveMetadata(product.name, { tags: [...tags] });
      }
      if (pushes) await ctx.enrichment.pushAttributes(product.name, body.attributes ?? {}, body.customAttributes);
    });
    const results = pooled.map((r) => ({ productId: r.item, ok: r.ok, ...(r.ok ? {} : { error: r.error instanceof Error ? r.error.message : String(r.error) }) }));
    return { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  });
}
