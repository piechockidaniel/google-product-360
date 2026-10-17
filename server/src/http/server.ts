import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { AppContext } from '../app.js';
import { MerchantApiError } from '../google/rest-client.js';
import { AttributeValidationError } from '../services/attribute-catalog.js';
import type { Session } from '../services/auth-service.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerProductRoutes } from './routes/products.js';
import { registerIssueRoutes } from './routes/issues.js';
import { registerFeedRoutes } from './routes/feeds.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { NotConfiguredError } from '../google/switchable-api.js';

export const SESSION_COOKIE = 'gmc_session';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
  }
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function notFound(message = 'Not found'): HttpError {
  return new HttpError(404, message);
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError(400, message, details);
}

export async function createServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.logger as FastifyInstance['log'],
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(fastifyCookie, { secret: ctx.config.SESSION_SECRET });

  // ---- session resolution
  app.decorateRequest('session', null);
  app.addHook('onRequest', async (request) => {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    request.session = ctx.auth.getSession(unsigned.value) ?? null;
  });

  // ---- error handling
  app.setErrorHandler((error: unknown, _request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation failed', details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (error instanceof AttributeValidationError) {
      return reply.status(400).send({ error: error.message, details: { attribute: error.attribute } });
    }
    if (error instanceof NotConfiguredError) {
      return reply.status(409).send({ error: error.message, code: 'not_configured' });
    }
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.message, details: error.details });
    }
    if (error instanceof MerchantApiError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      return reply.status(status).send({ error: `Merchant API: ${error.message}`, googleStatus: error.googleStatus, details: error.details });
    }
    const err = error as { statusCode?: number; message?: string; validation?: unknown };
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.message ?? 'Bad request', details: err.validation });
    }
    ctx.logger.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({ error: err.message ?? 'Internal server error' });
  });

  // ---- API
  await app.register(
    async (api) => {
      // Public endpoints
      registerAuthRoutes(api, ctx);
      registerSetupRoutes(api, ctx);
      registerNotificationRoutes(api, ctx); // contains the public webhook + authenticated subscription management

      // Everything below requires a session
      await api.register(async (secured) => {
        secured.addHook('preHandler', async (request) => {
          if (!request.session) throw new HttpError(401, 'Authentication required');
        });
        registerDashboardRoutes(secured, ctx);
        registerProductRoutes(secured, ctx);
        registerIssueRoutes(secured, ctx);
        registerFeedRoutes(secured, ctx);
        registerWorkflowRoutes(secured, ctx);
        registerAccountRoutes(secured, ctx);
        registerSystemRoutes(secured, ctx);
        registerMetricsRoutes(secured, ctx);
      });
    },
    { prefix: '/api' },
  );

  app.get('/healthz', async () => ({ ok: true, mock: ctx.settings.current().mock, configured: ctx.settings.isConfigured(), time: new Date().toISOString() }));

  // ---- static client (production build)
  const clientDir = ctx.config.clientDistDir;
  if (fs.existsSync(path.join(clientDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: clientDir, prefix: '/', index: ['index.html'] });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply
        .status(200)
        .type('text/html')
        .send('<h1>GMC Manager API is running</h1><p>The web client has not been built. Run <code>npm run build</code> or use the Vite dev server.</p>');
    });
  }

  return app;
}
