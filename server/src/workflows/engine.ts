import { productIdFromName } from '../google/merchant-api.js';
import type { MerchantApi } from '../google/merchant-api.js';
import type { Logger } from '../util/logger.js';
import type { EnrichmentService } from '../services/enrichment-service.js';
import type { AppEvent, EventLog } from '../services/event-log.js';
import type { ProductIssueRecord, ProductRecord, ProductStore } from '../services/product-store.js';
import type { ProductSignal, SignalsService } from '../services/signals-service.js';
import type { SyncService } from '../services/sync-service.js';
import { mapWithConcurrency } from '../util/pool.js';
import { evaluateCondition, renderDeep, renderTemplate } from './conditions.js';
import type { Step, Workflow } from './schema.js';
import type { RunLogEntry, WorkflowRun, WorkflowStore } from './workflow-store.js';

/** The view of a product that conditions and templates operate on. */
export interface ProductContext {
  name: string;
  productId: string;
  offerId: string;
  title: string | null;
  brand: string | null;
  link: string | null;
  feedLabel: string | null;
  contentLanguage: string | null;
  availability: string | null;
  dataSource: string | null;
  price: { amount: number; currency: string } | null;
  status: ProductRecord['aggregatedStatus'];
  issueCount: number;
  maxSeverity: string | null;
  issues: { code: string; level: string; severity: string | null; attribute: string | null; reportingContext: string | null; countries: string[]; description: string | null; firstSeenAt: string }[];
  issueCodes: string[];
  attributes: Record<string, unknown>;
  customAttributes: Record<string, string>;
  tags: string[];
  notes: string;
  fields: Record<string, string>;
  pushed: Record<string, unknown>;
  /** Product360 – null until metrics have been synced. */
  metrics: ProductSignal['metrics'] | null;
  market: ProductSignal['market'] | null;
  signals: { recommendation: string; previousRecommendation: string | null; scores: ProductSignal['scores']; reasons: string[] } | null;
}

/** Read-only access to signals (the engine never computes them). */
export type SignalsReader = Pick<SignalsService, 'get'>;

export interface RunContext {
  workflow: Workflow;
  trigger: string;
  events: AppEvent[];
  products: ProductContext[];
  stats: Record<string, number>;
  log: RunLogEntry[];
  stopped: boolean;
  startedAt: string;
}

export interface EngineDeps {
  store: WorkflowStore;
  products: ProductStore;
  enrichment: EnrichmentService;
  sync: SyncService;
  api: MerchantApi;
  events: EventLog;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Parallel API calls for per-product actions (default 8). */
  concurrency?: () => number;
  /** Product360 signals (optional – contexts get `metrics: null` without it). */
  signals?: SignalsReader;
}

export function toProductContext(record: ProductRecord, issues: ProductIssueRecord[], store: ProductStore, signals?: SignalsReader): ProductContext {
  const raw = store.getRawProduct(record.name) ?? {};
  const metadata = store.getMetadata(record.name);
  const customAttributes: Record<string, string> = {};
  for (const c of raw.customAttributes ?? []) if (c.name) customAttributes[c.name] = c.value ?? '';
  const signal = signals?.get(record.name) ?? null;
  return {
    name: record.name,
    productId: record.productId,
    offerId: record.offerId,
    title: record.title,
    brand: record.brand,
    link: record.link,
    feedLabel: record.feedLabel,
    contentLanguage: record.contentLanguage,
    availability: record.availability,
    dataSource: record.dataSource,
    price: record.price ? { amount: Number(record.price.amountMicros) / 1_000_000, currency: record.price.currencyCode } : null,
    status: record.aggregatedStatus,
    issueCount: record.issueCount,
    maxSeverity: record.maxSeverity,
    issues: issues.map((i) => ({
      code: i.code,
      level: i.level,
      severity: i.severity,
      attribute: i.attribute,
      reportingContext: i.reportingContext,
      countries: i.applicableCountries,
      description: i.description,
      firstSeenAt: i.firstSeenAt,
    })),
    issueCodes: [...new Set(issues.map((i) => i.code))],
    attributes: (raw.productAttributes as Record<string, unknown>) ?? {},
    customAttributes,
    tags: metadata.tags,
    notes: metadata.notes,
    fields: metadata.fields,
    pushed: metadata.pushedAttributes,
    metrics: signal?.metrics ?? null,
    market: signal?.market ?? null,
    signals: signal ? { recommendation: signal.recommendation, previousRecommendation: signal.previousRecommendation, scores: signal.scores, reasons: signal.reasons.map((r) => r.code) } : null,
  };
}

/** Resolves `now`, `+3d`, `-12h`, `+2w` or an ISO date/time against `base`. */
export function resolveRelativeTime(value: string, base: Date = new Date()): string {
  if (value === 'now') return base.toISOString();
  const rel = /^([+-])(\d+)([hdw])$/.exec(value);
  if (rel) {
    const n = Number(rel[2]) * (rel[1] === '-' ? -1 : 1);
    const ms = rel[3] === 'h' ? 3_600_000 : rel[3] === 'd' ? 86_400_000 : 7 * 86_400_000;
    return new Date(base.getTime() + n * ms).toISOString();
  }
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date/time "${value}"`);
  return d.toISOString();
}

/** `"89.99"` → fixed amount; `"-15%"` → percentage off the current price. Returns micros. */
export function resolveSalePriceMicros(spec: string, currentMicros: number | null): number {
  const pct = /^\s*-?\s*(\d+(?:[.,]\d+)?)\s*%\s*$/.exec(spec);
  if (pct) {
    if (currentMicros === null) throw new Error('Percentage sale price needs a current product price');
    const off = Number(pct[1]!.replace(',', '.')) / 100;
    return Math.round((currentMicros * (1 - off)) / 10_000) * 10_000;
  }
  const amount = Number(spec.replace(',', '.').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Invalid sale price "${spec}"`);
  return Math.round(amount * 1_000_000);
}

/**
 * Executes workflow definitions step by step against a working set of products.
 */
export class WorkflowEngine {
  private readonly running = new Map<number, Promise<WorkflowRun>>();

  constructor(private readonly deps: EngineDeps) {}

  isRunning(workflowId: number): boolean {
    return this.running.has(workflowId);
  }

  /** Runs a workflow. Concurrent runs of the same workflow are coalesced. */
  run(workflow: Workflow, trigger: string, events: AppEvent[] = []): Promise<WorkflowRun> {
    const inFlight = this.running.get(workflow.id);
    if (inFlight) return inFlight;
    const promise = this.execute(workflow, trigger, events).finally(() => this.running.delete(workflow.id));
    this.running.set(workflow.id, promise);
    return promise;
  }

  private async execute(workflow: Workflow, trigger: string, events: AppEvent[]): Promise<WorkflowRun> {
    const { store, logger } = this.deps;
    const run = store.startRun(workflow.id, trigger);
    const ctx: RunContext = {
      workflow,
      trigger,
      events,
      products: [],
      stats: { selected: 0, updated: 0, errors: 0 },
      log: [],
      stopped: false,
      startedAt: run.startedAt,
    };
    const log = (level: RunLogEntry['level'], message: string, step?: number, stepType?: string, data?: unknown) => {
      const entry: RunLogEntry = { time: new Date().toISOString(), level, message, ...(step !== undefined ? { step, stepType } : {}), ...(data !== undefined ? { data } : {}) };
      ctx.log.push(entry);
      logger.debug({ workflow: workflow.name, step, stepType }, message);
    };
    log('info', `Workflow "${workflow.name}" started (trigger: ${trigger}, ${events.length} event(s))`);

    let status: WorkflowRun['status'] = 'success';
    let error: string | null = null;
    try {
      for (let i = 0; i < workflow.steps.length; i += 1) {
        const step = workflow.steps[i]!;
        const stepLog = (level: RunLogEntry['level'], message: string, data?: unknown) => log(level, message, i + 1, step.type, data);
        await this.executeStep(step, ctx, stepLog);
        store.progressRun(run.id, ctx.log, ctx.stats);
        if (ctx.stopped) {
          status = 'stopped';
          break;
        }
      }
      log('info', `Workflow finished: ${JSON.stringify(ctx.stats)}`);
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      log('error', `Workflow failed: ${error}`);
      logger.error({ err, workflow: workflow.name }, 'Workflow failed');
    }
    const finished = store.finishRun(run.id, status, ctx.log, ctx.stats, error);
    this.deps.events.record(
      status === 'failed' ? 'workflow.failed' : 'workflow.completed',
      `Workflow "${workflow.name}" ${status} (${ctx.stats.selected ?? 0} selected, ${ctx.stats.updated ?? 0} updated, ${ctx.stats.errors ?? 0} errors)`,
      { severity: status === 'failed' ? 'error' : 'info', payload: { workflowId: workflow.id, runId: run.id, trigger, stats: ctx.stats } },
    );
    return finished;
  }

  private templateContext(ctx: RunContext, product?: ProductContext): Record<string, unknown> {
    return {
      ...(product ?? {}),
      product,
      count: ctx.products.length,
      products: ctx.products,
      workflow: { id: ctx.workflow.id, name: ctx.workflow.name },
      trigger: ctx.trigger,
      events: ctx.events,
      stats: ctx.stats,
      now: new Date().toISOString(),
      date: new Date().toISOString().slice(0, 10),
    };
  }

  private loadContexts(records: ProductRecord[]): ProductContext[] {
    const { products } = this.deps;
    return records.map((r) => toProductContext(r, products.listIssues({ productName: r.name, open: true, limit: 500 }).items, products, this.deps.signals));
  }

  /**
   * Applies an API-bound action to every product in the working set with a
   * bounded number of parallel requests (the Merchant API has no batch
   * endpoint for products; parallelism within the quota is the way to scale).
   */
  private async forEachProduct(
    ctx: RunContext,
    stepLog: (level: RunLogEntry['level'], message: string, data?: unknown) => void,
    continueOnError: boolean,
    fn: (product: ProductContext) => Promise<void>,
  ): Promise<void> {
    const concurrency = this.deps.concurrency?.() ?? 8;
    const started = Date.now();
    await mapWithConcurrency(ctx.products, concurrency, fn, {
      stopOnError: !continueOnError,
      onResult: (result) => {
        if (result.ok) {
          ctx.stats.updated = (ctx.stats.updated ?? 0) + 1;
        } else {
          ctx.stats.errors = (ctx.stats.errors ?? 0) + 1;
          const message = result.error instanceof Error ? result.error.message : String(result.error);
          stepLog('error', `${result.item.offerId}: ${message}`);
        }
      },
    });
    if (ctx.products.length > 1) {
      stepLog('info', `Processed ${ctx.products.length} product(s) with ${Math.min(concurrency, ctx.products.length)} parallel requests in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  }

  private async executeStep(step: Step, ctx: RunContext, stepLog: (level: RunLogEntry['level'], message: string, data?: unknown) => void): Promise<void> {
    const { products, enrichment, sync, api, events } = this.deps;
    switch (step.type) {
      case 'select_products': {
        const { limit, ...filter } = step.filter;
        let records = products.listAllProducts(filter);
        if (limit) records = records.slice(0, limit);
        ctx.products = this.loadContexts(records);
        ctx.stats.selected = ctx.products.length;
        stepLog('info', `Selected ${ctx.products.length} product(s)`, { filter: step.filter });
        return;
      }
      case 'select_event_products': {
        const names = new Set<string>();
        for (const event of ctx.events) {
          if (!event.productName) continue;
          const payload = (event.payload ?? {}) as { level?: string; code?: string };
          if (step.levels && payload.level && !step.levels.includes(payload.level as 'error')) continue;
          if (step.issueCodes && payload.code && !step.issueCodes.includes(payload.code)) continue;
          names.add(event.productName);
        }
        const records: ProductRecord[] = [];
        for (const name of names) {
          const p = products.getProduct(name);
          if (p) records.push(p);
        }
        ctx.products = this.loadContexts(records);
        ctx.stats.selected = ctx.products.length;
        stepLog('info', `Selected ${ctx.products.length} product(s) from ${ctx.events.length} event(s)`);
        return;
      }
      case 'select_by_signal': {
        let records = products.listAllProducts({ recommendation: step.recommendation, category: step.category, orderBy: 'impressions7d', orderDir: 'desc' });
        if (step.minImpressions7d !== undefined) records = records.filter((r) => (r.signal?.impressions7d ?? 0) >= step.minImpressions7d!);
        if (step.minDemand !== undefined) records = records.filter((r) => (r.signal?.scores.demand ?? 0) >= step.minDemand!);
        if (step.limit) records = records.slice(0, step.limit);
        ctx.products = this.loadContexts(records);
        ctx.stats.selected = ctx.products.length;
        stepLog('info', `Selected ${ctx.products.length} product(s) with recommendation ${step.recommendation.join('/')}`, { minDemand: step.minDemand, category: step.category });
        return;
      }
      case 'filter': {
        const before = ctx.products.length;
        ctx.products = ctx.products.filter((p) => evaluateCondition(p, step.condition));
        ctx.stats.selected = ctx.products.length;
        stepLog('info', `Filter kept ${ctx.products.length} of ${before} product(s)`);
        return;
      }
      case 'limit': {
        ctx.products = ctx.products.slice(0, step.max);
        ctx.stats.selected = ctx.products.length;
        stepLog('info', `Limited working set to ${ctx.products.length}`);
        return;
      }
      case 'stop_if_empty': {
        if (ctx.products.length === 0) {
          ctx.stopped = true;
          stepLog('info', 'No products selected – stopping');
        }
        return;
      }
      case 'set_attributes': {
        await this.forEachProduct(ctx, stepLog, step.continueOnError, async (product) => {
          const tpl = this.templateContext(ctx, product);
          const attributes = renderDeep(step.attributes, tpl);
          const custom = step.customAttributes ? renderDeep(step.customAttributes, tpl) : undefined;
          await enrichment.pushAttributes(product.name, attributes, custom);
          stepLog('info', `${product.offerId}: pushed ${Object.keys(attributes).join(', ')}`);
        });
        return;
      }
      case 'set_sale_price': {
        const base = new Date();
        const startTime = resolveRelativeTime(step.from, base);
        const endTime = resolveRelativeTime(step.to, base);
        if (endTime <= startTime) throw new Error('Sale price window must end after it starts');
        await this.forEachProduct(ctx, stepLog, step.continueOnError, async (product) => {
          const spec = renderTemplate(step.price, this.templateContext(ctx, product));
          const currentMicros = product.price ? Math.round(product.price.amount * 1_000_000) : null;
          const amountMicros = resolveSalePriceMicros(spec, currentMicros);
          const currencyCode = step.currency ?? product.price?.currency;
          if (!currencyCode) throw new Error('Currency unknown – set "currency" on the step');
          await enrichment.pushAttributes(product.name, {
            salePrice: { amountMicros: String(amountMicros), currencyCode },
            salePriceEffectiveDate: { startTime, endTime },
          });
          stepLog('info', `${product.offerId}: sale price ${(amountMicros / 1_000_000).toFixed(2)} ${currencyCode} from ${startTime.slice(0, 16)} to ${endTime.slice(0, 16)}`);
        });
        return;
      }
      case 'clear_attributes': {
        await this.forEachProduct(ctx, stepLog, step.continueOnError, async (product) => {
          await enrichment.clearAttributes(product.name);
          stepLog('info', `${product.offerId}: cleared enrichment attributes`);
        });
        return;
      }
      case 'add_tags': {
        for (const product of ctx.products) {
          const tags = renderDeep(step.tags, this.templateContext(ctx, product));
          const meta = products.saveMetadata(product.name, { tags: [...product.tags, ...tags] });
          product.tags = meta.tags;
          ctx.stats.updated = (ctx.stats.updated ?? 0) + 1;
        }
        stepLog('info', `Added tags [${step.tags.join(', ')}] to ${ctx.products.length} product(s)`);
        return;
      }
      case 'remove_tags': {
        for (const product of ctx.products) {
          const meta = products.saveMetadata(product.name, { tags: product.tags.filter((t) => !step.tags.includes(t)) });
          product.tags = meta.tags;
          ctx.stats.updated = (ctx.stats.updated ?? 0) + 1;
        }
        stepLog('info', `Removed tags [${step.tags.join(', ')}] from ${ctx.products.length} product(s)`);
        return;
      }
      case 'set_note': {
        for (const product of ctx.products) {
          const note = renderTemplate(step.note, this.templateContext(ctx, product));
          const next = step.mode === 'append' && product.notes ? `${product.notes}\n${note}` : note;
          products.saveMetadata(product.name, { notes: next });
          product.notes = next;
          ctx.stats.updated = (ctx.stats.updated ?? 0) + 1;
        }
        stepLog('info', `Updated notes on ${ctx.products.length} product(s)`);
        return;
      }
      case 'refresh_products': {
        await this.forEachProduct(ctx, stepLog, step.continueOnError, async (product) => {
          await sync.refreshProduct(productIdFromName(product.name), `workflow:${ctx.workflow.name}`);
        });
        ctx.products = this.loadContexts(ctx.products.map((p) => products.getProduct(p.name)!).filter(Boolean));
        stepLog('info', `Refreshed ${ctx.products.length} product(s) from Google`);
        return;
      }
      case 'fetch_feed': {
        await api.fetchDataSource(step.dataSourceId);
        events.record('feed.fetch_requested', `Workflow "${ctx.workflow.name}" requested fetch of data source ${step.dataSourceId}`);
        stepLog('info', `Requested fetch of data source ${step.dataSourceId}`);
        return;
      }
      case 'sync': {
        const result = await sync.runFullSync(`workflow:${ctx.workflow.name}`);
        if (result.status === 'failed') throw new Error(result.error ?? 'Sync failed');
        stepLog('info', `Sync finished`, result.stats);
        // Reload the working set so later steps see fresh data.
        ctx.products = this.loadContexts(ctx.products.map((p) => products.getProduct(p.name)!).filter(Boolean));
        return;
      }
      case 'webhook': {
        if (step.skipIfEmpty && ctx.products.length === 0) {
          stepLog('info', 'Working set empty – webhook skipped');
          return;
        }
        const tpl = this.templateContext(ctx);
        const body = {
          workflow: ctx.workflow.name,
          trigger: ctx.trigger,
          message: step.message ? renderTemplate(step.message, tpl) : `${ctx.products.length} product(s) selected`,
          count: ctx.products.length,
          stats: ctx.stats,
          ...(step.includeProducts
            ? {
                products: ctx.products.map((p) => ({
                  offerId: p.offerId,
                  title: p.title,
                  status: p.status,
                  link: p.link,
                  issues: p.issues.map((i) => ({ code: i.code, level: i.level, description: i.description })),
                  tags: p.tags,
                })),
              }
            : {}),
        };
        const fetchImpl = this.deps.fetchImpl ?? fetch;
        const response = await fetchImpl(step.url, {
          method: step.method,
          headers: { 'Content-Type': 'application/json', ...(step.headers ?? {}) },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`Webhook responded with HTTP ${response.status}`);
        stepLog('info', `Webhook ${step.method} ${step.url} → ${response.status}`);
        return;
      }
      case 'log': {
        const message = renderTemplate(step.message, this.templateContext(ctx));
        stepLog(step.severity, message);
        events.record('workflow.log', `[${ctx.workflow.name}] ${message}`, { severity: step.severity, payload: { workflowId: ctx.workflow.id } });
        return;
      }
      default: {
        const exhaustive: never = step;
        throw new Error(`Unknown step type ${(exhaustive as { type: string }).type}`);
      }
    }
  }
}
