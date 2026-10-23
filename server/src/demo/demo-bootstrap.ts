import type { AppContext } from '../app.js';
import { WORKFLOW_TEMPLATES } from '../workflows/templates.js';
import { workflowDefinitionSchema } from '../workflows/schema.js';

/** Demo credentials (also the defaults of ADMIN_USERNAME / ADMIN_PASSWORD in demo mode). */
export const DEMO_LOGIN = { username: 'demo', password: 'demo1234' };

/** Templates installed as workflows; the ones that would call an external webhook stay disabled. */
const DEMO_WORKFLOWS: { id: string; enabled: boolean }[] = [
  { id: 'tag-disapproved', enabled: true },
  { id: 'p360-label-scale', enabled: true },
  { id: 'p360-organic-easy-wins', enabled: true },
  { id: 'p360-watch-alert', enabled: false },
  { id: 'p360-reprice-weekend', enabled: false },
  { id: 'label-missing-gtin', enabled: false },
];

export interface DemoBootstrapResult {
  settingsApplied: boolean;
  workflowsInstalled: string[];
}

/**
 * Puts a fresh installation into the state a prospect should see: setup
 * completed, Search Console connected to the synthetic property, a longer
 * metrics history and the Product360 workflows installed. Idempotent.
 */
export function bootstrapDemo(ctx: AppContext): DemoBootstrapResult {
  const current = ctx.settings.current();
  let settingsApplied = false;
  if (!current.setupCompletedAt || !current.searchConsoleEnabled) {
    ctx.settings.update({
      mock: true,
      setupCompletedAt: current.setupCompletedAt ?? new Date().toISOString(),
      syncIntervalMinutes: 15,
      metricsEnabled: true,
      metricsBackfillDays: 120,
      searchConsoleEnabled: true,
      searchConsoleSiteUrl: 'sc-domain:example-shop.pl',
      searchConsoleMerchantListings: true,
      searchConsoleDataState: 'all',
    });
    settingsApplied = true;
  }
  const existing = new Set(ctx.workflows.list().map((w) => w.name));
  const installed: string[] = [];
  for (const item of DEMO_WORKFLOWS) {
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === item.id);
    if (!template) continue;
    const definition = workflowDefinitionSchema.parse({ ...template.definition, enabled: item.enabled });
    if (existing.has(definition.name)) continue;
    ctx.workflows.create(definition);
    installed.push(definition.name);
  }
  if (installed.length) ctx.scheduler.reload();
  if (settingsApplied || installed.length) {
    ctx.events.record('demo.bootstrapped', `Demo prepared: ${installed.length} workflow(s) installed, Search Console connected to sc-domain:example-shop.pl`, {
      payload: { workflows: installed, settingsApplied },
    });
  }
  return { settingsApplied, workflowsInstalled: installed };
}

/**
 * Loads products and metrics synchronously so the first page a visitor opens
 * is already populated. Returns a summary for the start-up log.
 */
export async function warmUpDemo(ctx: AppContext): Promise<{ products: number; recommendations: Record<string, number> }> {
  const sync = await ctx.sync.runFullSync('demo');
  const metrics = await ctx.metricsSync.run('demo');
  return { products: sync.stats.products ?? 0, recommendations: metrics.signals?.byRecommendation ?? {} };
}
