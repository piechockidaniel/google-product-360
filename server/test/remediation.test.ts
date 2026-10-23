import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/http/server.js';
import { testContext } from './helpers.js';
import type { AppContext } from '../src/app.js';

describe('durable remediation operations', () => {
  let ctx: AppContext;
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ ctx } = testContext());
    app = await createServer(ctx);
    await ctx.sync.runFullSync('test');
  });

  afterEach(async () => {
    await app.close();
    await ctx.stop();
  });

  it('offers only deterministic title fixes and reconciles the refreshed product', async () => {
    const candidate = ctx
      .products
      .listProducts({ limit: 100 })
      .items
      .map((item) => ctx.products.getProduct(item.name))
      .find((product) => product && ctx.remediations.proposals(product.name).length > 0);
    expect(candidate).toBeTruthy();
    const product = candidate!;
    const proposal = ctx.remediations.proposals(product.name)[0]!;
    expect(proposal.attribute).toBe('title');
    expect(proposal.proposedValue).not.toBe(product.product.productAttributes?.title);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin12345' } });
    const cookie = login.headers['set-cookie'] as string;
    const start = await app.inject({
      method: 'POST',
      url: `/api/products/${product.productId}/remediations`,
      headers: { cookie },
      payload: { issueCode: proposal.issueCode },
    });
    expect(start.statusCode).toBe(202);
    expect(start.json().status).toMatch(/queued|running|pending_google/);

    await new Promise((resolve) => setTimeout(resolve, 150));
    const operation = ctx.remediations.get(start.json().id);
    expect(operation?.status).toBe('succeeded');
    expect(operation?.events.map((event) => event.type)).toEqual(expect.arrayContaining(['queued', 'running', 'submitted', 'succeeded']));
    expect(ctx.products.getProduct(product.name)?.issues.some((issue) => issue.code === proposal.issueCode)).toBe(false);
  });
});
