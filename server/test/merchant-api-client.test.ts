import { describe, expect, it } from 'vitest';
import { RestClient } from '../src/google/rest-client.js';
import { MerchantApiClient, buildProductId, lastSegment, productIdFromName } from '../src/google/merchant-api.js';
import { silentLogger } from '../src/util/logger.js';

function setup(responder: (url: string, init: RequestInit) => unknown = () => ({})) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const rest = new RestClient({
    baseUrl: 'https://merchantapi.googleapis.com',
    tokenProvider: { getAccessToken: async () => 'tok' },
    logger: silentLogger,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const result = responder(url, init);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { api: new MerchantApiClient(rest, { accountId: '9' }), calls };
}

describe('MerchantApiClient endpoints', () => {
  it('covers account, policies and shipping', async () => {
    const { api, calls } = setup((url) => (url.includes('/issues') ? { accountIssues: [{ title: 'x' }] } : url.includes('onlineReturnPolicies?') ? { onlineReturnPolicies: [{ label: 'p' }] } : {}));
    await api.getAccount();
    expect(await api.listAccountIssues()).toEqual([{ title: 'x' }]);
    await api.getHomepage();
    await api.getShippingSettings();
    expect(await api.listReturnPolicies()).toEqual([{ label: 'p' }]);
    await api.createReturnPolicy({ label: 'n' });
    await api.updateReturnPolicy('rp1', { label: 'u' }, 'label');
    await api.deleteReturnPolicy('rp1');
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://merchantapi.googleapis.com/', '')}`)).toEqual([
      'GET accounts/v1/accounts/9',
      'GET accounts/v1/accounts/9/issues?pageSize=100',
      'GET accounts/v1/accounts/9/homepage',
      'GET accounts/v1/accounts/9/shippingSettings',
      'GET accounts/v1/accounts/9/onlineReturnPolicies?pageSize=100',
      'POST accounts/v1/accounts/9/onlineReturnPolicies',
      'PATCH accounts/v1/accounts/9/onlineReturnPolicies/rp1?updateMask=label',
      'DELETE accounts/v1/accounts/9/onlineReturnPolicies/rp1',
    ]);
  });

  it('returns undefined for optional resources that 404', async () => {
    const { api } = setup(() => new Response('{"error":{"message":"nope","status":"NOT_FOUND"}}', { status: 404 }));
    expect(await api.getHomepage()).toBeUndefined();
    expect(await api.getShippingSettings()).toBeUndefined();
    expect(await api.getLatestFileUpload('1')).toBeUndefined();
    expect(await api.getDeveloperRegistration()).toBeUndefined();
    await expect(api.getAccount()).rejects.toMatchObject({ status: 404 });
  });

  it('propagates non-404 errors from optional resources', async () => {
    const { api } = setup(() => new Response('{"error":{"message":"denied","status":"PERMISSION_DENIED"}}', { status: 403 }));
    await expect(api.getHomepage()).rejects.toMatchObject({ status: 403 });
  });

  it('covers products and product inputs', async () => {
    const pages: Record<string, unknown> = { '': { products: [{ name: 'a' }], nextPageToken: 'n' }, n: { products: [{ name: 'b' }] } };
    const { api, calls } = setup((url) => (url.includes('/products?') ? pages[new URL(url).searchParams.get('pageToken') ?? ''] : {}));
    expect((await api.listAllProducts()).map((p) => p.name)).toEqual(['a', 'b']);
    await api.getProduct('pl~PL~x');
    await api.insertProductInput('accounts/9/dataSources/1', { offerId: 'x' });
    await api.patchProductInput('accounts/9/dataSources/1', 'pl~PL~x', { productAttributes: { title: 't' } }, 'title');
    await api.deleteProductInput('accounts/9/dataSources/1', 'pl~PL~x');
    const urls = calls.map((c) => `${c.method} ${c.url.replace('https://merchantapi.googleapis.com/', '')}`);
    expect(urls[0]).toBe('GET products/v1/accounts/9/products?pageSize=1000');
    expect(urls[1]).toBe('GET products/v1/accounts/9/products?pageSize=1000&pageToken=n');
    expect(urls[2]).toBe('GET products/v1/accounts/9/products/pl~PL~x');
    expect(urls[3]).toBe('POST products/v1/accounts/9/productInputs:insert?dataSource=accounts%2F9%2FdataSources%2F1');
    expect(urls[4]).toBe('PATCH products/v1/accounts/9/productInputs/pl~PL~x?dataSource=accounts%2F9%2FdataSources%2F1&updateMask=title');
    expect(urls[5]).toBe('DELETE products/v1/accounts/9/productInputs/pl~PL~x?dataSource=accounts%2F9%2FdataSources%2F1');
  });

  it('covers data sources, issue resolution, notifications, reports, quota and registration', async () => {
    const { api, calls } = setup((url) =>
      url.includes('/dataSources?')
        ? { dataSources: [{ name: 'd' }] }
        : url.includes('aggregateProductStatuses')
          ? { aggregateProductStatuses: [{ country: 'PL' }] }
          : url.includes('notificationsubscriptions?')
            ? { notificationSubscriptions: [{ name: 's' }] }
            : url.includes('reports:search')
              ? { results: [{ productView: {} }] }
              : url.includes('/quotas')
                ? { quotaGroups: [{ name: 'q' }] }
                : url.includes('render')
                  ? { renderedIssues: [{ title: 'r' }] }
                  : {},
    );
    expect(await api.listDataSources()).toEqual([{ name: 'd' }]);
    await api.getDataSource('5');
    await api.createDataSource({ displayName: 'x' });
    await api.updateDataSource('5', { displayName: 'y' }, 'displayName');
    await api.deleteDataSource('5');
    await api.fetchDataSource('5');
    await api.getLatestFileUpload('5');
    expect(await api.renderAccountIssues('pl-PL', 'Europe/Warsaw')).toEqual([{ title: 'r' }]);
    expect(await api.renderProductIssues('pl~PL~x')).toEqual([{ title: 'r' }]);
    expect(await api.listAggregateProductStatuses('country = "PL"')).toEqual([{ country: 'PL' }]);
    expect(await api.listNotificationSubscriptions()).toEqual([{ name: 's' }]);
    await api.createNotificationSubscription({ callBackUri: 'https://x' });
    await api.deleteNotificationSubscription('sub1');
    expect(await api.searchReport('SELECT id FROM product_view')).toEqual([{ productView: {} }]);
    expect(await api.listQuotas()).toEqual([{ name: 'q' }]);
    await api.getDeveloperRegistration();
    await api.registerGcp('a@b.c');
    const urls = calls.map((c) => `${c.method} ${c.url.replace('https://merchantapi.googleapis.com/', '')}`);
    expect(urls).toContain('GET datasources/v1/accounts/9/dataSources/5');
    expect(urls).toContain('POST datasources/v1/accounts/9/dataSources');
    expect(urls).toContain('PATCH datasources/v1/accounts/9/dataSources/5?updateMask=displayName');
    expect(urls).toContain('DELETE datasources/v1/accounts/9/dataSources/5');
    expect(urls).toContain('POST datasources/v1/accounts/9/dataSources/5:fetch');
    expect(urls).toContain('GET datasources/v1/accounts/9/dataSources/5/fileUploads/latest');
    expect(urls).toContain('POST issueresolution/v1/accounts/9:renderaccountissues?languageCode=pl-PL&timeZone=Europe%2FWarsaw');
    expect(urls).toContain('GET issueresolution/v1/accounts/9/aggregateProductStatuses?pageSize=100&filter=country+%3D+%22PL%22');
    expect(urls).toContain('DELETE notifications/v1/accounts/9/notificationsubscriptions/sub1');
    expect(urls).toContain('POST reports/v1/accounts/9/reports:search');
    expect(urls).toContain('GET quota/v1/accounts/9/quotas?pageSize=100');
    expect(urls).toContain('GET accounts/v1/accounts/9/developerRegistration');
    expect(urls).toContain('POST accounts/v1/accounts/9/developerRegistration:registerGcp');
    expect(calls.at(-1)!.body).toEqual({ developerEmail: 'a@b.c' });
  });

  it('has id helpers', () => {
    expect(buildProductId('pl', 'PL', 'x')).toBe('pl~PL~x');
    expect(buildProductId('pl', 'PL', 'x', true)).toBe('local~pl~PL~x');
    expect(productIdFromName('accounts/1/products/pl~PL~x')).toBe('pl~PL~x');
    expect(productIdFromName('weird')).toBe('weird');
    expect(lastSegment('a/b/c')).toBe('c');
  });
});
