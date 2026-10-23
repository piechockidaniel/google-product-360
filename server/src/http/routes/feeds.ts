import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.js';
import { createFeedSchema, updateFeedSchema } from '../../services/feed-service.js';

export function registerFeedRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/feeds', async () => ({ feeds: await ctx.feeds.list(true) }));

  app.post('/feeds', async (request, reply) => {
    const input = createFeedSchema.parse(request.body);
    const feed = await ctx.feeds.create(input);
    return reply.status(201).send(feed);
  });

  app.get<{ Params: { id: string } }>('/feeds/:id', async (request) => ctx.feeds.get(request.params.id));

  app.patch<{ Params: { id: string } }>('/feeds/:id', async (request) => {
    const input = updateFeedSchema.parse(request.body);
    return ctx.feeds.update(request.params.id, input);
  });

  app.delete<{ Params: { id: string } }>('/feeds/:id', async (request) => {
    await ctx.feeds.delete(request.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/feeds/:id/fetch', async (request) => {
    await ctx.feeds.fetchNow(request.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/feeds/:id/latest-upload', async (request) => ({
    upload: (await ctx.api.getLatestFileUpload(request.params.id)) ?? null,
  }));

  // ---- enrichment (supplemental) data source
  app.get('/feeds/enrichment/status', async () => ctx.enrichment.status());
  app.post('/feeds/enrichment/ensure', async () => {
    await ctx.enrichment.ensureDataSource(true);
    return ctx.enrichment.status();
  });
}
