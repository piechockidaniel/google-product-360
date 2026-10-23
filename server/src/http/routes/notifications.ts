import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.js';
import type { ProductStatusChangeMessage } from '../../google/types.js';
import { HttpError } from '../server.js';

export function registerNotificationRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Public endpoint Google calls for PRODUCT_STATUS_CHANGE notifications.
   * Protected by the secret path segment; always answers 200 quickly so Google
   * does not retry (processing happens asynchronously).
   */
  app.post<{ Params: { secret: string } }>('/webhooks/merchant/:secret', async (request, reply) => {
    if (request.params.secret !== ctx.settings.current().webhookSecret) {
      ctx.logger.warn({ ip: request.ip }, 'Webhook called with invalid secret');
      throw new HttpError(404, 'Not found');
    }
    const body = request.body as ProductStatusChangeMessage | { message?: { data?: string } } | undefined;
    let message: ProductStatusChangeMessage | undefined;
    // Accept both the direct JSON message and a Pub/Sub style envelope with base64 data.
    if (body && 'message' in body && body.message?.data) {
      try {
        message = JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf8')) as ProductStatusChangeMessage;
      } catch {
        message = undefined;
      }
    } else {
      message = body as ProductStatusChangeMessage | undefined;
    }
    if (message && typeof message === 'object') ctx.notifications.handleIncoming(message);
    return reply.status(200).send({ ok: true });
  });

  app.register(async (secured) => {
    secured.addHook('preHandler', async (request) => {
      if (!request.session) throw new HttpError(401, 'Authentication required');
    });
    secured.get('/notifications/subscriptions', async () => ({
      callbackUrl: ctx.notifications.callbackUrl,
      subscriptions: await ctx.notifications.list(),
    }));
    secured.post('/notifications/subscriptions', async (_request, reply) => reply.status(201).send(await ctx.notifications.subscribe()));
    secured.delete<{ Params: { id: string } }>('/notifications/subscriptions/:id', async (request) => {
      await ctx.notifications.unsubscribe(request.params.id);
      return { ok: true };
    });
    /** Simulates an incoming Google notification (useful to test workflows end-to-end). */
    secured.post('/notifications/simulate', async (request) => {
      ctx.notifications.handleIncoming(request.body as ProductStatusChangeMessage);
      return { ok: true };
    });
  });
}
