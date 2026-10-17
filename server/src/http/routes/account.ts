import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.js';
import type { OnlineReturnPolicy } from '../../google/types.js';

export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/account', async () => ctx.account.overview());

  app.get('/account/shipping-settings', async () => ({ shippingSettings: (await ctx.account.getShippingSettings()) ?? null }));

  app.get('/account/return-policies', async () => ({ policies: await ctx.account.listReturnPolicies() }));

  app.post('/account/return-policies', async (request, reply) => {
    const policy = request.body as OnlineReturnPolicy;
    return reply.status(201).send(await ctx.account.createReturnPolicy(policy));
  });

  app.put<{ Params: { id: string } }>('/account/return-policies/:id', async (request) =>
    ctx.account.updateReturnPolicy(request.params.id, request.body as OnlineReturnPolicy),
  );

  app.delete<{ Params: { id: string } }>('/account/return-policies/:id', async (request) => {
    await ctx.account.deleteReturnPolicy(request.params.id);
    return { ok: true };
  });
}
