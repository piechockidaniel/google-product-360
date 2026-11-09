import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { HttpError } from '../server.js';

const configSchema = z.object({
  storeUrl: z.string().url().refine((value) => {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
  }, 'Use an HTTPS store URL without credentials, query or fragment'),
  consumerKey: z.string().trim().min(1).optional(),
  consumerSecret: z.string().trim().min(1).optional(),
  syncIntervalMinutes: z.number().int().min(0).max(1440).optional(),
  syncOnStartup: z.boolean().optional(),
});
const paging = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0) });
const search = z.string().trim().max(200).optional();
const reconciliationQuery = paging.extend({ status: z.enum(['all', 'matched', 'ambiguous', 'unmatched', 'no_sku']).default('all'), orderBy: z.enum(['wooId', 'sku', 'name', 'price', 'stockStatus', 'status', 'google']).default('wooId'), orderDir: z.enum(['asc', 'desc']).default('asc'), wooId: search, sku: search, name: search, price: search, stockStatus: search, google: search });
const orderQuery = paging.extend({ orderBy: z.enum(['number', 'status', 'date', 'items', 'total', 'currency']).default('date'), orderDir: z.enum(['asc', 'desc']).default('desc'), number: search, status: search, date: search, items: search, total: search, currency: search });

export function registerWooCommerceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/woocommerce/status', async () => ctx.woocommerce.status());
  app.put('/woocommerce/config', async (request) => {
    const input = configSchema.parse(request.body);
    const previous = ctx.settings.current();
    const storeUrl = input.storeUrl.replace(/\/$/, '');
    if (previous.wooStoreUrl && previous.wooStoreUrl !== storeUrl && (!input.consumerKey || !input.consumerSecret)) {
      throw new HttpError(400, 'New credentials are required when changing the WooCommerce store');
    }
    ctx.settings.update({ wooStoreUrl: storeUrl, ...(input.consumerKey ? { wooConsumerKey: input.consumerKey } : {}), ...(input.consumerSecret ? { wooConsumerSecret: input.consumerSecret } : {}), ...(input.syncIntervalMinutes !== undefined ? { wooSyncIntervalMinutes: input.syncIntervalMinutes } : {}), ...(input.syncOnStartup !== undefined ? { wooSyncOnStartup: input.syncOnStartup } : {}) });
    return ctx.woocommerce.status();
  });
  app.post('/woocommerce/test', async () => ctx.woocommerce.testConnection());
  app.post('/woocommerce/sync', async () => ctx.woocommerce.sync());
  app.post('/woocommerce/cancel', async () => ({ cancelled: ctx.woocommerce.cancel() }));
  app.get('/woocommerce/products', async (request) => {
    const { limit, offset } = paging.parse(request.query);
    return ctx.woocommerce.list('products', limit, offset);
  });
  app.get('/woocommerce/orders', async (request) => {
    return ctx.woocommerce.listOrders(orderQuery.parse(request.query));
  });
  app.get('/woocommerce/reconciliation', async (request) => {
    const { status, limit, offset, ...query } = reconciliationQuery.parse(request.query);
    return ctx.woocommerce.reconciliation(status, limit, offset, query);
  });
  app.put('/woocommerce/mappings', async (request) => {
    const body = z.object({ wooId: z.number().int().positive(), productId: z.string().min(1).max(1024) }).parse(request.body);
    return ctx.woocommerce.confirmMapping(body.wooId, body.productId);
  });
  app.post('/woocommerce/mappings/remove', async (request) => {
    const body = z.object({ wooId: z.number().int().positive(), productId: z.string().min(1).max(1024) }).parse(request.body);
    return { removed: ctx.woocommerce.removeMapping(body.wooId, body.productId) };
  });
}
