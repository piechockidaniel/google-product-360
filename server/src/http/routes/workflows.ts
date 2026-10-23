import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { WORKFLOW_TRIGGER_EVENTS } from '../../services/event-log.js';
import { RECOMMENDATIONS } from '../../services/product-store.js';
import { STEP_CATALOG, conditionOperators, workflowDefinitionSchema } from '../../workflows/schema.js';
import { WorkflowScheduler } from '../../workflows/scheduler.js';
import { WORKFLOW_TEMPLATES } from '../../workflows/templates.js';
import { badRequest, notFound } from '../server.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

export function registerWorkflowRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/workflows', async () => {
    const nextRuns = ctx.scheduler.nextRuns();
    return {
      workflows: ctx.workflows.list().map((w) => ({ ...w, nextRunAt: nextRuns[w.id] ?? null, running: ctx.engine.isRunning(w.id) })),
    };
  });

  app.get('/workflows/catalog', async () => ({
    steps: STEP_CATALOG,
    operators: conditionOperators,
    templates: WORKFLOW_TEMPLATES,
    events: WORKFLOW_TRIGGER_EVENTS,
    recommendations: RECOMMENDATIONS,
    fields: [
      'offerId',
      'title',
      'brand',
      'link',
      'feedLabel',
      'contentLanguage',
      'availability',
      'dataSource',
      'price.amount',
      'price.currency',
      'status',
      'issueCount',
      'maxSeverity',
      'issueCodes',
      'issues.level',
      'issues.attribute',
      'issues.reportingContext',
      'attributes.<name>',
      'customAttributes.<name>',
      'tags',
      'notes',
      'fields.<name>',
      'pushed.<name>',
      'signals.recommendation',
      'signals.previousRecommendation',
      'signals.scores.demand',
      'signals.scores.visibility',
      'signals.scores.price',
      'signals.scores.health',
      'signals.reasons',
      'metrics.impressions7d',
      'metrics.clicks7d',
      'metrics.clicksPrev7d',
      'metrics.clicksChangePct',
      'metrics.impressions28d',
      'metrics.clicks28d',
      'metrics.ctr28d',
      'metrics.conversions28d',
      'metrics.scImpressions28d',
      'metrics.scClicks28d',
      'metrics.scPosition28d',
      'metrics.scImpressionsChangePct',
      'market.priceVsBenchmark',
      'market.effectiveness',
      'market.demand',
      'market.demandChange',
      'market.bestSellerRank',
    ],
  }));

  app.post('/workflows/validate', async (request) => {
    const def = workflowDefinitionSchema.parse(request.body);
    let nextRun: string | null = null;
    if (def.trigger.type === 'schedule') {
      try {
        nextRun = WorkflowScheduler.validateCron(def.trigger.cron, def.trigger.timezone)?.toISOString() ?? null;
      } catch (err) {
        throw badRequest(`Invalid cron expression: ${(err as Error).message}`);
      }
    }
    return { ok: true, nextRun };
  });

  app.post('/workflows', async (request, reply) => {
    const def = workflowDefinitionSchema.parse(request.body);
    if (def.trigger.type === 'schedule') {
      try {
        WorkflowScheduler.validateCron(def.trigger.cron, def.trigger.timezone);
      } catch (err) {
        throw badRequest(`Invalid cron expression: ${(err as Error).message}`);
      }
    }
    const workflow = ctx.workflows.create(def);
    ctx.scheduler.reload();
    ctx.events.record('workflow.created', `Workflow "${workflow.name}" created`, { payload: { workflowId: workflow.id } });
    return reply.status(201).send(workflow);
  });

  app.get('/workflows/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const workflow = ctx.workflows.get(id);
    if (!workflow) throw notFound('Workflow not found');
    return { ...workflow, nextRunAt: ctx.scheduler.nextRuns()[id] ?? null, running: ctx.engine.isRunning(id) };
  });

  app.put('/workflows/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const body = request.body as Record<string, unknown>;
    if (body.trigger && (body.trigger as { type: string }).type === 'schedule') {
      try {
        WorkflowScheduler.validateCron((body.trigger as { cron: string }).cron, (body.trigger as { timezone?: string }).timezone);
      } catch (err) {
        throw badRequest(`Invalid cron expression: ${(err as Error).message}`);
      }
    }
    const workflow = ctx.workflows.update(id, body);
    if (!workflow) throw notFound('Workflow not found');
    ctx.scheduler.reload();
    return workflow;
  });

  app.delete('/workflows/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    if (!ctx.workflows.delete(id)) throw notFound('Workflow not found');
    ctx.scheduler.reload();
    return { ok: true };
  });

  /** Runs the workflow now; `?wait=true` blocks until it finishes. */
  app.post('/workflows/:id/run', async (request) => {
    const { id } = idParam.parse(request.params);
    const workflow = ctx.workflows.get(id);
    if (!workflow) throw notFound('Workflow not found');
    const wait = (request.query as { wait?: string }).wait === 'true';
    const promise = ctx.engine.run(workflow, 'manual');
    if (wait) return promise;
    promise.catch(() => undefined);
    return { started: true };
  });

  /** Dry run: executes only the selection/filter steps and returns the products that would be affected. */
  app.post('/workflows/preview', async (request) => {
    const def = workflowDefinitionSchema.parse(request.body);
    const readOnly = new Set(['select_products', 'select_by_signal', 'filter', 'limit', 'stop_if_empty']);
    const preview = { ...def, name: `[preview] ${def.name}`, steps: def.steps.filter((s) => readOnly.has(s.type)) };
    const { toProductContext } = await import('../../workflows/engine.js');
    const { evaluateCondition } = await import('../../workflows/conditions.js');
    let products = [] as ReturnType<typeof toProductContext>[];
    for (const step of preview.steps) {
      if (step.type === 'select_products') {
        const { limit, ...filter } = step.filter;
        let records = ctx.products.listAllProducts(filter);
        if (limit) records = records.slice(0, limit);
        products = records.map((r) => toProductContext(r, ctx.products.listIssues({ productName: r.name, open: true, limit: 500 }).items, ctx.products, ctx.signals));
      } else if (step.type === 'select_by_signal') {
        let records = ctx.products.listAllProducts({ recommendation: step.recommendation, category: step.category, orderBy: 'impressions7d', orderDir: 'desc' });
        if (step.minImpressions7d !== undefined) records = records.filter((r) => (r.signal?.impressions7d ?? 0) >= step.minImpressions7d!);
        if (step.minDemand !== undefined) records = records.filter((r) => (r.signal?.scores.demand ?? 0) >= step.minDemand!);
        if (step.limit) records = records.slice(0, step.limit);
        products = records.map((r) => toProductContext(r, ctx.products.listIssues({ productName: r.name, open: true, limit: 500 }).items, ctx.products, ctx.signals));
      } else if (step.type === 'filter') {
        products = products.filter((p) => evaluateCondition(p, step.condition));
      } else if (step.type === 'limit') {
        products = products.slice(0, step.max);
      }
    }
    return {
      count: products.length,
      skippedSteps: def.steps.filter((s) => !readOnly.has(s.type)).map((s) => s.type),
      products: products.slice(0, 100).map((p) => ({ productId: p.productId, offerId: p.offerId, title: p.title, status: p.status, issueCodes: p.issueCodes, tags: p.tags, recommendation: p.signals?.recommendation ?? null })),
    };
  });

  app.get('/workflows/:id/runs', async (request) => {
    const { id } = idParam.parse(request.params);
    return { runs: ctx.workflows.listRuns({ workflowId: id, limit: 50 }) };
  });

  app.get('/workflow-runs', async () => ({ runs: ctx.workflows.listRuns({ limit: 100 }) }));

  app.get('/workflow-runs/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const run = ctx.workflows.getRun(id);
    if (!run) throw notFound('Run not found');
    return run;
  });
}
