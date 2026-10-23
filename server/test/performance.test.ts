import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testContext } from './helpers.js';
import type { AppContext } from '../src/app.js';
import type { MockMerchantApi } from '../src/mock/mock-merchant-api.js';
import { mapWithConcurrency } from '../src/util/pool.js';
import { RestClient } from '../src/google/rest-client.js';
import { silentLogger } from '../src/util/logger.js';

describe('mapWithConcurrency', () => {
  it('limits parallelism, keeps order and captures errors', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      if (n === 4) throw new Error('boom');
      return n * 2;
    });
    expect(peak).toBe(3);
    expect(results.map((r) => (r.ok ? r.value : 'ERR'))).toEqual([2, 4, 6, 'ERR', 10, 12, 14, 16]);
  });

  it('can stop on the first error', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 1, async (n) => { if (n === 2) throw new Error('stop'); return n; }, { stopOnError: true })).rejects.toThrow('stop');
  });
});

describe('RestClient rate limiting', () => {
  it('pauses all workers after a 429 and honours Retry-After', async () => {
    const log: number[] = [];
    let calls = 0;
    const t0 = Date.now();
    const rest = new RestClient({
      baseUrl: 'https://x',
      tokenProvider: { getAccessToken: async () => 't' },
      logger: silentLogger,
      retryDelayMs: 1,
      fetchImpl: (async () => {
        calls += 1;
        log.push(Date.now() - t0);
        if (calls === 1) return new Response('{"error":{"message":"quota","status":"RESOURCE_EXHAUSTED"}}', { status: 429, headers: { 'retry-after': '1' } });
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    const a = rest.get('a'); // gets 429 with Retry-After: 1
    await new Promise((r) => setTimeout(r, 50));
    const b = rest.get('b'); // started during the cool-down -> must wait
    await Promise.all([a, b]);
    expect(rest.rateLimitHits).toBe(1);
    expect(calls).toBe(3);
    expect(log[1]).toBeGreaterThanOrEqual(950); // b's first send
    expect(log[2]).toBeGreaterThanOrEqual(950); // a's retry
  });
});

describe('bulk enrichment efficiency', () => {
  let ctx: AppContext;
  let mock: MockMerchantApi;
  beforeEach(() => {
    ({ ctx, mock } = testContext());
  });
  afterEach(async () => {
    await ctx.stop();
  });

  it('pushes to N products with N insert calls and a single data-source lookup', async () => {
    await ctx.sync.runFullSync('test');
    mock.callCounts.clear();
    const wf = ctx.workflows.create({
      name: 'bulk',
      trigger: { type: 'manual' },
      steps: [{ type: 'select_products', filter: {} }, { type: 'set_attributes', attributes: { customLabel0: 'x' } }],
    });
    const started = Date.now();
    const run = await ctx.engine.run(wf, 'manual');
    expect(run.status).toBe('success');
    expect(run.stats.updated).toBe(30);
    expect(mock.callCounts.get('insertProductInput')).toBe(30);
    // data sources are listed once for discovery + once for link verification, not per product
    expect(mock.callCounts.get('listDataSources')).toBeLessThanOrEqual(2);
    expect(run.log.some((l) => /parallel requests/.test(l.message))).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reads products in pages of 1000', async () => {
    const pages: number[] = [];
    for await (const page of ctx.api.listProductPages()) pages.push(page.length);
    expect(pages).toEqual([30]);
  });
});
