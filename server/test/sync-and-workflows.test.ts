import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testContext } from './helpers.js';
import type { AppContext } from '../src/app.js';
import type { MockMerchantApi } from '../src/mock/mock-merchant-api.js';

let ctx: AppContext;
let mock: MockMerchantApi;

beforeEach(() => {
  ({ ctx, mock } = testContext());
});
afterEach(async () => {
  await ctx.stop();
});

describe('SyncService', () => {
  it('imports products and issues, then detects changes', async () => {
    const run = await ctx.sync.runFullSync('test');
    expect(run.status).toBe('success');
    expect(run.stats.products).toBe(30);
    expect(ctx.products.productStats().total).toBe(30);
    expect(ctx.events.list({ type: 'sync.completed' }).total).toBe(1);

    const id = mock.productIds()[0]!;
    mock.setProductIssues(id, [{ code: 'brand_new_issue', severity: 'DISAPPROVED', reportingContext: 'SHOPPING_ADS', description: 'New' }]);
    const second = await ctx.sync.runFullSync('test');
    expect(second.stats.newIssues).toBeGreaterThanOrEqual(1);
    expect(ctx.events.list({ type: 'issue.new' }).items.some((e) => (e.payload as { code: string }).code === 'brand_new_issue')).toBe(true);
  });

  it('refreshes a single product', async () => {
    await ctx.sync.runFullSync('test');
    const id = mock.productIds()[1]!;
    mock.setProductIssues(id, []);
    const refreshed = await ctx.sync.refreshProduct(id, 'test');
    expect(refreshed?.issues).toEqual([]);
    expect(refreshed?.aggregatedStatus).toBe('APPROVED');
  });
});

describe('EnrichmentService', () => {
  it('creates + links the supplemental data source and pushes merged attributes', async () => {
    await ctx.sync.runFullSync('test');
    const name = `${mock.accountName}/products/${mock.productIds()[0]}`;
    await ctx.enrichment.pushAttributes(name, { customLabel0: 'a', productHighlights: 'x\ny' });
    await ctx.enrichment.pushAttributes(name, { customLabel1: 'b', customLabel0: null });
    const status = await ctx.enrichment.status();
    expect(status.dataSource?.displayName).toBe('GMC Manager enrichment');
    expect(status.unlinkedPrimaries).toEqual([]);
    const input = mock.getSupplementalInput(mock.productIds()[0]!, status.dataSource!.name!);
    expect(input?.productAttributes).toEqual({ productHighlights: ['x', 'y'], customLabel1: 'b' });
    expect(ctx.products.getMetadata(name).pushStatus).toBe('pushed');
    await ctx.enrichment.clearAttributes(name);
    expect(mock.getSupplementalInput(mock.productIds()[0]!, status.dataSource!.name!)).toBeUndefined();
  });
});

describe('WorkflowEngine', () => {
  it('runs selection, filter and action steps', async () => {
    await ctx.sync.runFullSync('test');
    const calls: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const { WorkflowEngine } = await import('../src/workflows/engine.js');
    const engine = new WorkflowEngine({ store: ctx.workflows, products: ctx.products, enrichment: ctx.enrichment, sync: ctx.sync, api: ctx.api, events: ctx.events, logger: ctx.logger, fetchImpl });
    const wf = ctx.workflows.create({
      name: 'test',
      trigger: { type: 'manual' },
      steps: [
        { type: 'select_products', filter: { hasIssues: true } },
        { type: 'filter', condition: { field: 'issues.level', op: 'contains', value: 'error' } },
        { type: 'limit', max: 3 },
        { type: 'add_tags', tags: ['flagged-{{date}}'] },
        { type: 'set_attributes', attributes: { customLabel4: '{{brand}}' } },
        { type: 'set_note', note: 'seen {{offerId}}', mode: 'append' },
        { type: 'webhook', url: 'https://hooks.example/x', message: '{{count}} products' },
        { type: 'log', message: 'done {{count}}' },
      ],
    });
    const run = await engine.run(wf, 'manual');
    expect(run.status).toBe('success');
    expect(run.stats.selected).toBe(3);
    expect(run.stats.errors).toBe(0);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { message: string; products: unknown[] }).message).toBe('3 products');
    expect((calls[0] as { products: unknown[] }).products).toHaveLength(3);
    const tagged = ctx.products.listProducts({ tag: `flagged-${new Date().toISOString().slice(0, 10)}` });
    expect(tagged.total).toBe(3);
    const meta = ctx.products.getMetadata(tagged.items[0]!.name);
    expect(meta.pushedAttributes.customLabel4).toBe(tagged.items[0]!.brand);
    expect(meta.notes).toContain(`seen ${tagged.items[0]!.offerId}`);
    expect(run.log.some((l) => l.message === 'done 3')).toBe(true);
  });

  it('stops when the working set is empty', async () => {
    await ctx.sync.runFullSync('test');
    const wf = ctx.workflows.create({
      name: 'empty',
      trigger: { type: 'manual' },
      steps: [{ type: 'select_products', filter: { brand: 'does-not-exist' } }, { type: 'stop_if_empty' }, { type: 'log', message: 'should not run' }],
    });
    const run = await ctx.engine.run(wf, 'manual');
    expect(run.status).toBe('stopped');
    expect(run.log.some((l) => l.message === 'should not run')).toBe(false);
  });

  it('is triggered by events with debounce and receives the event products', async () => {
    await ctx.sync.runFullSync('test');
    ctx.workflows.create({
      name: 'on-new-issues',
      trigger: { type: 'event', event: 'issue.new', debounceSeconds: 0 },
      steps: [{ type: 'select_event_products', levels: ['error'] }, { type: 'add_tags', tags: ['needs-attention'] }],
    });
    ctx.scheduler.start();
    const ids = mock.productIds().slice(0, 2);
    for (const id of ids) mock.setProductIssues(id, [{ code: 'evt_issue', severity: 'DISAPPROVED', reportingContext: 'SHOPPING_ADS' }]);
    await ctx.sync.runFullSync('test');
    await new Promise((r) => setTimeout(r, 150));
    const runs = ctx.workflows.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe('event:issue.new');
    expect(runs[0]!.stats.selected).toBe(2);
    expect(ctx.products.listProducts({ tag: 'needs-attention' }).total).toBe(2);
  });

  it('rejects invalid definitions', () => {
    expect(() => ctx.workflows.create({ name: 'x', trigger: { type: 'manual' }, steps: [{ type: 'nope' }] })).toThrow();
    expect(() => ctx.workflows.create({ name: 'x', trigger: { type: 'schedule' }, steps: [{ type: 'sync' }] })).toThrow();
  });
});
