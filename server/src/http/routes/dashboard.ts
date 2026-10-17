import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.js';
import { encodeProductId, productIdFromName } from '../../google/merchant-api.js';

import type { AccountFlag as Flag } from '../../services/account-service.js';

/** Drops flags that say the same thing (e.g. homepage-not-claimed from two sources). */
function dedupeFlags(flags: Flag[]): Flag[] {
  const out: Flag[] = [];
  for (const flag of flags) {
    const key = flag.message.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const duplicate = out.some((f) => {
      const other = f.message.toLowerCase().replace(/[^a-z0-9 ]/g, '');
      return other === key || (f.documentationUri && f.documentationUri === flag.documentationUri);
    });
    if (!duplicate) out.push(flag);
  }
  return out;
}

/**
 * Single endpoint feeding the dashboard: account health, product statistics,
 * and everything that changed since the user's previous login.
 */
export function registerDashboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/dashboard', async (request) => {
    const user = request.session!.user;
    const since = user.previousLoginAt ?? user.lastLoginAt ?? '';

    const [overview, feeds] = await Promise.all([
      ctx.account.overview(),
      ctx.feeds.list(true).catch((err: Error) => {
        ctx.logger.warn({ err }, 'Could not list feeds for dashboard');
        return [];
      }),
    ]);

    const stats = ctx.products.productStats();
    const newIssues = ctx.products.listIssues({ since, open: true, limit: 200 });
    const resolvedIssues = ctx.products.listIssues({ resolvedSince: since, limit: 200 });
    const newAccountIssues = ctx.accountIssues.list({ since, open: true });
    const issueSummary = ctx.products.issueSummary(since);
    const recentEvents = ctx.events.list({ since, limit: 50, severity: ['warning', 'error'] });
    const statusChanges = ctx.events.list({ since, types: ['product.status_changed', 'product.deleted'], limit: 100 });
    const notifications = ctx.events.list({ since, types: ['notification.received'], limit: 100 });
    const workflowRuns = ctx.workflows.listRuns({ since, limit: 20 });
    const signalChanges = ctx.events.list({ since, types: ['signal.changed'], limit: 100 });
    const lastSync = ctx.sync.lastRun() ?? null;

    const feedFlags = feeds
      .filter((f) => f.health === 'error' || f.health === 'warning')
      .map(
        (f): Flag => ({
          level: f.health as 'error' | 'warning',
          code: 'feed_health',
          params: { name: f.displayName, state: f.lastUpload?.processingState ?? 'unknown state', issues: f.lastUpload?.issues?.length ?? 0 },
          message: `Feed "${f.displayName}": ${f.lastUpload?.processingState ?? 'unknown state'}${f.lastUpload?.issues?.length ? `, ${f.lastUpload.issues.length} processing issue(s)` : ''}`,
        }),
      );
    const syncFlags: Flag[] = lastSync?.status === 'failed' ? [{ level: 'error', code: 'sync_failed', params: { error: lastSync.error ?? '' }, message: `Last sync failed: ${lastSync.error}` }] : [];
    const productFlags: Flag[] = [];
    if (stats.total > 0) {
      const disapproved = (stats.byStatus.DISAPPROVED ?? 0) + (stats.byStatus.PARTIALLY_APPROVED ?? 0);
      if (disapproved / stats.total > 0.1) productFlags.push({ level: 'error', code: 'disapproved_ratio', params: { disapproved, total: stats.total }, message: `${disapproved} of ${stats.total} products are (partially) disapproved` });
      else if (disapproved > 0) productFlags.push({ level: 'warning', code: 'disapproved_some', params: { disapproved }, message: `${disapproved} product(s) are (partially) disapproved` });
    }
    const metricsLast = ctx.metrics.lastRun();
    const metricsFlags: Flag[] =
      metricsLast?.status === 'failed'
        ? [{ level: 'warning', code: 'metrics_failed', params: { connector: metricsLast.connector, error: metricsLast.error ?? '' }, message: `Metrics sync (${metricsLast.connector}) failed: ${metricsLast.error}` }]
        : [];
    const flags = dedupeFlags([...overview.flags, ...feedFlags, ...syncFlags, ...productFlags, ...metricsFlags]);
    const health = flags.some((f) => f.level === 'error') ? 'error' : flags.some((f) => f.level === 'warning') ? 'warning' : 'ok';

    return {
      since,
      user,
      health,
      flags,
      account: overview.account,
      homepage: overview.homepage,
      accountIssues: overview.issues,
      aggregateStatuses: overview.aggregateStatuses,
      productStats: stats,
      feeds: feeds.map(({ raw: _raw, ...f }) => f),
      lastSync,
      syncRunning: ctx.sync.isRunning,
      insights: ctx.product360.dashboard(ctx.settings.current().metricsEnabled),
      sinceLastLogin: {
        newIssues: newIssues.items,
        newIssueCount: newIssues.total,
        resolvedIssues: resolvedIssues.items,
        resolvedIssueCount: resolvedIssues.total,
        newAccountIssues,
        statusChanges: statusChanges.items,
        notifications: notifications.items,
        warningsAndErrors: recentEvents.items,
        workflowRuns,
        signalChanges: signalChanges.items.map((e) => ({
          ...e,
          productId: e.productName ? encodeProductId(productIdFromName(e.productName)) : null,
          offerId: e.productName ? (productIdFromName(e.productName).split('~').pop() ?? null) : null,
        })),
        signalChangeCount: signalChanges.total,
      },
      issueSummary,
    };
  });
}
