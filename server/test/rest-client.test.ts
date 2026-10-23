import { describe, expect, it } from 'vitest';
import { MerchantApiError, RestClient, collectAll } from '../src/google/rest-client.js';
import { MerchantApiClient, decodeProductId, encodeProductId } from '../src/google/merchant-api.js';
import { silentLogger } from '../src/util/logger.js';

function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const rest = new RestClient({
    baseUrl: 'https://merchantapi.googleapis.com',
    tokenProvider: { getAccessToken: async () => 'tok' },
    logger: silentLogger,
    retryDelayMs: 1,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }) as unknown as typeof fetch,
  });
  return { rest, calls };
}

describe('RestClient', () => {
  it('adds auth header, serializes body and parses JSON', async () => {
    const { rest, calls } = client(() => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const result = await rest.post<{ ok: number }>('products/v1/accounts/1/productInputs:insert', { body: { a: 1 }, query: { dataSource: 'accounts/1/dataSources/2' } });
    expect(result).toEqual({ ok: 1 });
    expect(calls[0]!.url).toBe('https://merchantapi.googleapis.com/products/v1/accounts/1/productInputs:insert?dataSource=accounts%2F1%2FdataSources%2F2');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(calls[0]!.init.body).toBe('{"a":1}');
  });

  it('retries on 429/5xx and surfaces Google error envelopes', async () => {
    let n = 0;
    const { rest, calls } = client(() => {
      n += 1;
      if (n < 3) return new Response('{"error":{"message":"slow down","status":"RESOURCE_EXHAUSTED"}}', { status: 429 });
      return new Response('{"fine":true}', { status: 200 });
    });
    expect(await rest.get('x')).toEqual({ fine: true });
    expect(calls).toHaveLength(3);

    const failing = client(() => new Response('{"error":{"message":"nope","status":"NOT_FOUND"}}', { status: 404 }));
    await expect(failing.rest.get('y')).rejects.toMatchObject({ status: 404, googleStatus: 'NOT_FOUND', message: 'nope' } satisfies Partial<MerchantApiError>);
    expect(failing.calls).toHaveLength(1);
  });

  it('paginates', async () => {
    const pages: Record<string, unknown> = { '': { items: [1, 2], nextPageToken: 'p2' }, p2: { items: [3] } };
    const { rest } = client((url) => new Response(JSON.stringify(pages[new URL(url).searchParams.get('pageToken') ?? ''])));
    const all = await collectAll((t) => rest.get<{ items: number[]; nextPageToken?: string }>('list', { query: { pageToken: t } }), (r) => r.items);
    expect(all).toEqual([1, 2, 3]);
  });
});

describe('MerchantApiClient', () => {
  it('builds v1 endpoints', async () => {
    const { rest, calls } = client(() => new Response('{}'));
    const api = new MerchantApiClient(rest, { accountId: '123' });
    await api.getAccount();
    await api.getProduct('pl~PL~sku/1');
    await api.fetchDataSource('55');
    await api.renderProductIssues('pl~PL~x', 'pl-PL');
    await api.createNotificationSubscription({ registeredEvent: 'PRODUCT_STATUS_CHANGE', callBackUri: 'https://x' });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET https://merchantapi.googleapis.com/accounts/v1/accounts/123',
      'GET https://merchantapi.googleapis.com/products/v1/accounts/123/products/pl~PL~sku%2F1',
      'POST https://merchantapi.googleapis.com/datasources/v1/accounts/123/dataSources/55:fetch',
      'POST https://merchantapi.googleapis.com/issueresolution/v1/accounts/123/products/pl~PL~x:renderproductissues?languageCode=pl-PL',
      'POST https://merchantapi.googleapis.com/notifications/v1/accounts/123/notificationsubscriptions',
    ]);
  });

  it('encodes product ids as unpadded base64url', () => {
    expect(encodeProductId('en~US~sku/123')).toBe('ZW5-VVN-c2t1LzEyMw');
    expect(decodeProductId('ZW5-VVN-c2t1LzEyMw')).toBe('en~US~sku/123');
  });
});
