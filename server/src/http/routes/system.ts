import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { HttpError } from '../server.js';

const csv = (schema: z.ZodTypeAny) => z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(schema).optional());

const eventsQuery = z.object({
  since: z.string().optional(),
  type: z.string().optional(),
  types: csv(z.string()),
  severity: csv(z.enum(['info', 'warning', 'error'])),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/sync', async (request) => {
    const wait = (request.query as { wait?: string }).wait === 'true';
    const promise = ctx.sync.runFullSync('manual');
    if (wait) return promise;
    promise.catch(() => undefined);
    return { started: true, running: true };
  });

  app.get('/sync/status', async () => ({
    running: ctx.sync.isRunning,
    lastRun: ctx.sync.lastRun() ?? null,
    lastSuccessfulRun: ctx.sync.lastSuccessfulRun() ?? null,
    runs: ctx.sync.listRuns(20),
    intervalMinutes: ctx.settings.current().syncIntervalMinutes,
  }));

  app.get('/events', async (request) => {
    const query = eventsQuery.parse(request.query);
    const user = request.session!.user;
    const since = query.since === 'lastLogin' ? (user.previousLoginAt ?? user.lastLoginAt ?? undefined) : query.since;
    return ctx.events.list({ ...query, since });
  });

  /** Merchant API quota usage (from the quota sub-API). */
  app.get('/settings/quota', async () => {
    const groups = await ctx.api.listQuotas();
    return {
      groups: groups.map((g) => ({
        name: g.name?.split('/').pop() ?? '',
        usage: Number(g.quotaUsage ?? 0),
        dailyLimit: Number(g.quotaLimit ?? 0),
        minuteLimit: Number(g.quotaMinuteLimit ?? 0),
        methods: (g.methodDetails ?? []).map((m) => `${m.subapi ?? ''}.${m.method ?? ''}`),
      })),
      apiConcurrency: ctx.settings.current().apiConcurrency,
    };
  });

  app.get('/settings', async () => {
    const s = ctx.settings.current();
    return {
      accountId: ctx.api.accountName,
      mock: s.mock,
      configured: ctx.settings.isConfigured(),
      apiBaseUrl: s.apiBaseUrl,
      apiVersion: s.apiVersion,
      publicUrl: s.publicUrl,
      webhookUrl: ctx.notifications.callbackUrl,
      syncIntervalMinutes: s.syncIntervalMinutes,
      enrichmentDataSourceName: s.enrichmentDataSourceName,
      languageCode: s.languageCode,
      timeZone: s.timeZone,
      users: ctx.auth.listUsers(),
    };
  });

  app.post('/settings/users', async (request, reply) => {
    const body = z.object({ username: z.string().min(1).max(64), password: z.string().min(8) }).parse(request.body);
    if (ctx.auth.getUserByUsername(body.username)) throw new HttpError(409, 'User already exists');
    return reply.status(201).send(ctx.auth.createUser(body.username, body.password));
  });

  app.delete<{ Params: { id: string } }>('/settings/users/:id', async (request) => {
    const id = Number(request.params.id);
    if (id === request.session!.user.id) throw new HttpError(400, 'You cannot delete yourself');
    ctx.auth.deleteUser(id);
    return { ok: true };
  });

  // ---- development helpers (only with the mock API)
  app.post('/dev/mock/simulate-changes', async () => {
    if (!ctx.mock) throw new HttpError(400, 'Only available in mock mode');
    const changes = ctx.mock.simulateChanges();
    return changes;
  });

  /** Demo tour: Google "re-processes" the catalogue, then a product sync + metrics refresh run – shows the "since last login" views and recommendation changes. */
  app.post('/dev/mock/simulate-day', async () => {
    if (!ctx.mock) throw new HttpError(400, 'Only available in mock mode');
    const changes = ctx.mock.simulateChanges();
    const sync = await ctx.sync.runFullSync('demo:simulate-day');
    const metrics = await ctx.metricsSync.run('demo:simulate-day');
    return { changes, sync: sync.stats, signals: metrics.signals };
  });
}
