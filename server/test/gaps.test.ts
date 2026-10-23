import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/http/server.js';
import { testContext } from './helpers.js';
import type { AppContext } from '../src/app.js';
import type { MockMerchantApi } from '../src/mock/mock-merchant-api.js';
import { SyncScheduler } from '../src/jobs/sync-scheduler.js';
import { silentLogger } from '../src/util/logger.js';
import { evaluateCondition, renderDeep } from '../src/workflows/conditions.js';
import { createNotConfiguredApi } from '../src/google/switchable-api.js';
import { Database } from '../src/db/database.js';

const FAKE_KEY = JSON.stringify({ type: 'service_account', project_id: 'p', private_key: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n', client_email: 'a@p.iam.gserviceaccount.com' });

let ctx: AppContext;
let mock: MockMerchantApi;
let app: FastifyInstance;
let cookie = '';

beforeEach(async () => {
  ({ ctx, mock } = testContext());
  app = await createServer(ctx);
  await ctx.sync.runFullSync('test');
  cookie = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin12345' } })).headers['set-cookie'] as string;
});
afterEach(async () => {
  await app.close();
  await ctx.stop();
});

describe('setup error paths', () => {
  it('test-connection and register-gcp with real (unreachable) credentials report hints', async () => {
    const test = await app.inject({ method: 'POST', url: '/api/setup/test-connection', headers: { cookie }, payload: { mock: false, merchantAccountId: '1', serviceAccountJson: FAKE_KEY } });
    expect(test.json().ok).toBe(false);
    expect(test.json().hint).toBeTruthy();
    const badKey = await app.inject({ method: 'POST', url: '/api/setup/test-connection', headers: { cookie }, payload: { mock: false, merchantAccountId: '1', serviceAccountJson: '{"type":"x"}' } });
    expect(badKey.json().error).toMatch(/service account/);
    const noKey = await app.inject({ method: 'POST', url: '/api/setup/test-connection', headers: { cookie }, payload: { mock: false, merchantAccountId: '1', serviceAccountJson: null } });
    expect(noKey.json().error).toMatch(/key is required/);
    const reg = await app.inject({ method: 'POST', url: '/api/setup/register-gcp', headers: { cookie }, payload: { mock: false, merchantAccountId: '1', serviceAccountJson: FAKE_KEY, developerEmail: 'admin@example.com' } });
    expect(reg.json().ok).toBe(false);
    expect(reg.json().hint).toBeTruthy();
    const regMissing = await app.inject({ method: 'POST', url: '/api/setup/register-gcp', headers: { cookie }, payload: { mock: false, merchantAccountId: '', developerEmail: 'admin@example.com' } });
    expect(regMissing.statusCode).toBe(400);
    const invalidKey = await app.inject({ method: 'POST', url: '/api/setup/inspect-key', headers: { cookie }, payload: { serviceAccountJson: 'nope' } });
    expect(invalidKey.statusCode).toBe(400);
    const badUpdate = await app.inject({ method: 'PUT', url: '/api/setup/config', headers: { cookie }, payload: { merchantAccountId: 'abc' } });
    expect(badUpdate.statusCode).toBe(400);
    const secret = await app.inject({ method: 'POST', url: '/api/setup/generate-secret', headers: { cookie } });
    expect(secret.json().secret.length).toBeGreaterThan(16);
    expect((await app.inject({ method: 'GET', url: '/api/setup/config', headers: { cookie } })).json().configured).toBe(true);
  });

  it('complete refuses when unconfigured', async () => {
    ctx.settings.update({ mock: false, merchantAccountId: '', serviceAccountJson: null });
    const done = await app.inject({ method: 'POST', url: '/api/setup/complete', headers: { cookie } });
    expect(done.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json().configured).toBe(false);
  });
});

describe('not-configured api', () => {
  it('rejects every call', async () => {
    const api = createNotConfiguredApi();
    expect(api.accountId).toBe('');
    await expect(api.getAccount()).rejects.toThrow(/not configured/);
    await expect((async () => { for await (const _p of api.listProductPages()) { /* never */ } })()).rejects.toThrow(/not configured/);
  });
});

describe('SyncScheduler', () => {
  it('starts, reconfigures, skips when disabled and stops', async () => {
    let runs = 0;
    let enabled = false;
    const sync = { runFullSync: async () => { runs += 1; return {} as never } } as unknown as ConstructorParameters<typeof SyncScheduler>[0];
    const s = new SyncScheduler(sync, 0, silentLogger, () => enabled);
    s.start(true);
    await new Promise((r) => setTimeout(r, 1100));
    expect(runs).toBe(0); // skipped: not enabled
    enabled = true;
    s.reconfigure(1);
    s.reconfigure(1);
    s.stop();
    const s2 = new SyncScheduler({ runFullSync: async () => { throw new Error('x'); } } as never, 0, silentLogger);
    s2.start(true);
    await new Promise((r) => setTimeout(r, 1100));
    s2.stop();
  });
});

describe('sync failure path', () => {
  it('records a failed run when the API throws', async () => {
    mock.listProductPages = (async function* () { throw new Error('api down'); }) as never;
    const run = await ctx.sync.runFullSync('test');
    expect(run.status).toBe('failed');
    expect(run.error).toBe('api down');
    expect(ctx.sync.lastSuccessfulRun()?.status).toBe('success');
    expect(ctx.events.list({ type: 'sync.failed' }).total).toBe(1);
  });

  it('marks products missing from the account as deleted', async () => {
    const id = mock.productIds()[0]!;
    await mock.deleteProductInput(`${mock.accountName}/dataSources/101`, id);
    const run = await ctx.sync.runFullSync('test');
    expect(run.stats.deletedProducts).toBe(1);
    expect(ctx.products.productStats().deleted).toBe(1);
  });
});

describe('engine step branches', () => {
  it('runs refresh, fetch_feed, sync, clear_attributes and failing webhook', async () => {
    const wf = ctx.workflows.create({
      name: 'branches',
      trigger: { type: 'manual' },
      steps: [
        { type: 'select_products', filter: { limit: 2 } },
        { type: 'set_attributes', attributes: { customLabel0: 'x' } },
        { type: 'clear_attributes' },
        { type: 'refresh_products' },
        { type: 'fetch_feed', dataSourceId: '101' },
        { type: 'sync' },
        { type: 'remove_tags', tags: ['none'] },
        { type: 'set_note', note: 'n', mode: 'replace' },
        { type: 'webhook', url: 'https://hooks.example/x', skipIfEmpty: false, includeProducts: false },
      ],
    });
    const { WorkflowEngine } = await import('../src/workflows/engine.js');
    const engine = new WorkflowEngine({ store: ctx.workflows, products: ctx.products, enrichment: ctx.enrichment, sync: ctx.sync, api: ctx.api, events: ctx.events, logger: ctx.logger, fetchImpl: (async () => new Response('no', { status: 500 })) as never });
    const run = await engine.run(wf, 'manual');
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/HTTP 500/);
    expect(run.log.some((l) => /Requested fetch/.test(l.message))).toBe(true);
    expect(run.log.some((l) => /Sync finished/.test(l.message))).toBe(true);
  });

  it('aborts on the first error when continueOnError is false', async () => {
    const wf = ctx.workflows.create({
      name: 'strict',
      trigger: { type: 'manual' },
      steps: [{ type: 'select_products', filter: { limit: 3 } }, { type: 'set_attributes', attributes: { availability: 'NOPE' }, continueOnError: false }],
    });
    const run = await ctx.engine.run(wf, 'manual');
    expect(run.status).toBe('failed');
    // in-flight parallel requests finish, but no further products are started
    expect(run.stats.errors).toBeGreaterThanOrEqual(1);
    expect(run.stats.errors).toBeLessThanOrEqual(3);
  });

  it('skips empty webhook and coalesces concurrent runs', async () => {
    const wf = ctx.workflows.create({ name: 'empty', trigger: { type: 'manual' }, steps: [{ type: 'select_products', filter: { brand: 'nobody' } }, { type: 'webhook', url: 'https://x.example/h' }] });
    const [a, b] = await Promise.all([ctx.engine.run(wf, 'manual'), ctx.engine.run(wf, 'manual')]);
    expect(a.id).toBe(b.id);
    expect(a.log.some((l) => /webhook skipped/.test(l.message))).toBe(true);
    expect(ctx.workflows.failStaleRuns()).toBe(0);
  });
});

describe('conditions & templates (remaining operators)', () => {
  it('handles comparisons with arrays, regex on arrays, mismatched types and ends_with', () => {
    const subject = { tags: ['a', 'b'], title: 'Hello World', n: 5, s: 'x' };
    expect(evaluateCondition(subject, { field: 'tags', op: 'regex', value: '^b$' })).toBe(true);
    expect(evaluateCondition(subject, { field: 'title', op: 'ends_with', value: 'world' })).toBe(true);
    expect(evaluateCondition(subject, { field: 'n', op: 'gt', value: 'abc' })).toBe(false);
    expect(evaluateCondition(subject, { field: 'missing', op: 'gt', value: 1 })).toBe(false);
    expect(evaluateCondition(subject, { field: 'n', op: 'lte', value: 5 })).toBe(true);
    expect(evaluateCondition(subject, { field: 'tags', op: 'neq', value: 'zzz' })).toBe(true);
    expect(evaluateCondition(subject, { field: 'n', op: 'contains', value: 5 })).toBe(false);
    expect(evaluateCondition(subject, { field: 'tags', op: 'not_in', value: 'q' })).toBe(true);
    expect(evaluateCondition(subject, { field: 'tags', op: 'starts_with', value: 'a' })).toBe(false);
    expect(evaluateCondition(subject, { field: 'n', op: 'bogus' as never })).toBe(false);
    expect(renderDeep({ a: ['{{s}}', { b: '{{n}}' }], c: 1 }, subject)).toEqual({ a: ['x', { b: '5' }], c: 1 });
  });
});

describe('database helpers', () => {
  it('rolls back failed transactions and supports named params', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    expect(() => db.transaction(() => { db.run('INSERT INTO t (v) VALUES (?)', ['a']); throw new Error('rollback'); })).toThrow('rollback');
    expect(db.all('SELECT * FROM t')).toEqual([]);
    db.run('INSERT INTO t (v) VALUES ($v)', { $v: 'named' });
    expect(db.get<{ v: string }>('SELECT v FROM t WHERE v = $v', { $v: 'named' })?.v).toBe('named');
    db.close();
  });
});
