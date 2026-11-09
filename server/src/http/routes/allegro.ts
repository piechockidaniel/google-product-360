import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { ALLEGRO_TEMPLATE_FIELDS } from '../../services/allegro-service.js';

const env = z.enum(['sandbox', 'production']);
const config = z.object({ clientId: z.string().trim().min(1).max(256), clientSecret: z.string().min(1).max(1024).optional(), redirectUri: z.string().url().max(2048), enableOfferWrites: z.boolean().default(false) });
const filter = z.string().trim().max(200).optional();
const paging = z.object({ environment: env.default('sandbox'), limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(9_999_900).default(0), orderBy: z.enum(['id', 'name', 'status', 'price', 'stock']).default('id'), orderDir: z.enum(['asc', 'desc']).default('asc'), id: filter, name: filter, status: filter, price: filter, stock: filter });
const money = z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/).refine((value) => !/^0+(?:\.0+)?$/.test(value), 'Amount must be positive');
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('price'), amount: money, currency: z.string().regex(/^[A-Z]{3}$/), expectedAmount: money, expectedCurrency: z.string().regex(/^[A-Z]{3}$/) }),
  z.object({ type: z.literal('stock'), quantity: z.number().int().min(0).max(1_000_000), expectedQuantity: z.number().int().min(0) }),
  z.object({ type: z.literal('activate'), expectedStatus: z.string().min(1).max(32) }),
  z.object({ type: z.literal('end'), expectedStatus: z.string().min(1).max(32) }),
]);

export function registerAllegroRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/allegro/status', async (request) => ctx.allegro.status(z.object({ environment: env.default('sandbox') }).parse(request.query).environment));
  app.put('/allegro/config', async (request) => {
    const body = config.extend({ environment: env }).parse(request.body);
    return ctx.allegro.configure(body.environment, body.clientId, body.clientSecret, body.redirectUri, body.enableOfferWrites);
  });
  app.post('/allegro/authorize', async (request) => {
    const body = z.object({ environment: env }).parse(request.body);
    return { url: ctx.allegro.authorize(body.environment, request.session!.id) };
  });
  app.get('/allegro/callback', async (request, reply) => {
    const parsed = z.object({ code: z.string().max(4096).optional(), state: z.string().max(256).optional(), error: z.string().max(256).optional() }).safeParse(request.query);
    if (!parsed.success || !parsed.data.code || !parsed.data.state || parsed.data.error) return reply.redirect('/allegro?connection=failed');
    try {
      const environment = await ctx.allegro.complete(parsed.data.state, parsed.data.code, request.session!.id);
      return reply.redirect(`/allegro?connection=success&environment=${environment}`);
    } catch {
      ctx.logger.warn('Allegro authorization failed');
      return reply.redirect('/allegro?connection=failed');
    }
  });
  app.get('/allegro/offers', async (request) => {
    const { environment, ...query } = paging.parse(request.query);
    return ctx.allegro.offers(environment, query);
  });
  app.post('/allegro/sync', async (request) => ctx.allegro.syncOffers(z.object({ environment: env }).parse(request.body).environment));
  app.post('/allegro/test', async (request) => ctx.allegro.testConnection(z.object({ environment: env }).parse(request.body).environment));
  app.get<{ Params: { offerId: string } }>('/allegro/offers/:offerId/template-preview', async (request) => {
    const query = z.object({ environment: env.default('sandbox') }).parse(request.query);
    return ctx.allegro.templatePreview(query.environment, request.params.offerId);
  });
  app.get('/allegro/templates', async (request) => {
    const query = z.object({ environment: env.default('sandbox') }).parse(request.query);
    return { items: ctx.allegro.templates(query.environment) };
  });
  app.post('/allegro/templates/from-offer', async (request, reply) => {
    const body = z.object({ environment: env, offerId: z.string().min(1).max(128), name: z.string().trim().min(1).max(100), fields: z.array(z.enum(ALLEGRO_TEMPLATE_FIELDS)).min(1).max(ALLEGRO_TEMPLATE_FIELDS.length) }).parse(request.body);
    return reply.status(201).send(await ctx.allegro.createTemplate(body.environment, body.offerId, body.name, [...new Set(body.fields)]));
  });
  app.put<{ Params: { id: string } }>('/allegro/templates/:id', async (request) => {
    const body = z.object({ environment: env, name: z.string().trim().min(1).max(100), version: z.number().int().positive(), data: z.record(z.string(), z.unknown()) }).parse(request.body);
    return ctx.allegro.updateTemplate(body.environment, request.params.id, body.name, body.version, body.data);
  });
  app.get('/allegro/drafts', async (request) => {
    const query = z.object({ environment: env.default('sandbox') }).parse(request.query);
    return { items: ctx.allegro.drafts(query.environment) };
  });
  app.post('/allegro/drafts', async (request, reply) => {
    const body = z.object({ environment: env, templateId: z.string().uuid(), wooId: z.number().int().positive(), amount: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/), currency: z.string().regex(/^[A-Z]{3}$/) }).parse(request.body);
    return reply.status(201).send(ctx.allegro.createDraft(body.environment, body.templateId, body.wooId, body.amount, body.currency));
  });
  app.get('/allegro/operations', async (request) => {
    const query = z.object({ environment: env.default('sandbox') }).parse(request.query);
    return { items: ctx.allegro.operations(query.environment) };
  });
  app.post<{ Params: { offerId: string } }>('/allegro/offers/:offerId/operations', async (request) => {
    const body = z.object({ environment: env, operationId: z.string().uuid(), action }).parse(request.body);
    return ctx.allegro.changeOffer(body.environment, request.params.offerId, body.operationId, request.session!.user.id, body.action);
  });
  app.post<{ Params: { id: string } }>('/allegro/operations/:id/check', async (request) => {
    const body = z.object({ environment: env }).parse(request.body);
    return ctx.allegro.checkOperation(body.environment, request.params.id);
  });
}
