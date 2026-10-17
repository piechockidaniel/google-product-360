import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app.js';

const csv = (schema: z.ZodTypeAny) => z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(schema).optional());

const querySchema = z.object({
  /** ISO timestamp, or the literal `lastLogin` */
  since: z.string().optional(),
  open: z.preprocess((v) => v !== 'false', z.boolean().default(true)),
  resolvedSince: z.string().optional(),
  level: csv(z.enum(['error', 'warning', 'info'])),
  code: z.string().optional(),
  reportingContext: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export function registerIssueRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/issues', async (request) => {
    const query = querySchema.parse(request.query);
    const user = request.session!.user;
    const since = query.since === 'lastLogin' ? (user.previousLoginAt ?? user.lastLoginAt ?? undefined) : query.since;
    const resolvedSince = query.resolvedSince === 'lastLogin' ? (user.previousLoginAt ?? user.lastLoginAt ?? undefined) : query.resolvedSince;
    const result = ctx.products.listIssues({
      since,
      resolvedSince,
      open: resolvedSince ? false : query.open,
      level: query.level,
      code: query.code,
      reportingContext: query.reportingContext,
      limit: query.limit,
      offset: query.offset,
    });
    return { ...result, since: since ?? null };
  });

  app.get('/issues/summary', async (request) => {
    const user = request.session!.user;
    const since = user.previousLoginAt ?? user.lastLoginAt ?? undefined;
    return { since: since ?? null, codes: ctx.products.issueSummary(since) };
  });

  app.get('/issues/account', async (request) => {
    const user = request.session!.user;
    const since = user.previousLoginAt ?? user.lastLoginAt ?? undefined;
    const open = ctx.accountIssues.list({ open: true });
    return { since: since ?? null, issues: open.map((i) => ({ ...i, isNew: !!since && i.firstSeenAt > since })) };
  });

  /** Rendered account issues from the Issue Resolution API (HTML content + actions). */
  app.get('/issues/account/rendered', async () => ({ issues: await ctx.account.renderAccountIssues() }));
}
