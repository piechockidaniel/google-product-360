import { describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { ProductStore, computeAggregatedStatus } from '../src/services/product-store.js';
import type { Product } from '../src/google/types.js';

function product(issues: { code: string; severity?: string }[], overrides: Partial<Product> = {}): Product {
  return {
    name: 'accounts/1/products/pl~PL~sku1',
    offerId: 'sku1',
    contentLanguage: 'pl',
    feedLabel: 'PL',
    productAttributes: { title: 'T', price: { amountMicros: '1000000', currencyCode: 'PLN' } },
    productStatus: {
      itemLevelIssues: issues.map((i) => ({ code: i.code, severity: i.severity ?? 'DISAPPROVED', reportingContext: 'SHOPPING_ADS' })),
      destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', disapprovedCountries: issues.some((i) => i.severity !== 'DEMOTED') && issues.length ? ['PL'] : [], approvedCountries: issues.length ? [] : ['PL'] }],
    },
    ...overrides,
  };
}

describe('ProductStore issue tracking', () => {
  it('tracks new, persisting and resolved issues across upserts', () => {
    const store = new ProductStore(new Database(':memory:'));
    const first = store.upsertProduct(product([{ code: 'a' }, { code: 'b' }]), '2024-01-01T00:00:00.000Z');
    expect(first.isNewProduct).toBe(true);
    expect(first.newIssues.map((i) => i.code)).toEqual(['a', 'b']);

    const second = store.upsertProduct(product([{ code: 'b' }, { code: 'c' }]), '2024-01-02T00:00:00.000Z');
    expect(second.isNewProduct).toBe(false);
    expect(second.newIssues.map((i) => i.code)).toEqual(['c']);
    expect(second.resolvedIssues.map((i) => i.code)).toEqual(['a']);

    const open = store.listIssues({ open: true, productName: 'accounts/1/products/pl~PL~sku1' }).items;
    expect(open.map((i) => i.code).sort()).toEqual(['b', 'c']);
    expect(open.find((i) => i.code === 'b')?.firstSeenAt).toBe('2024-01-01T00:00:00.000Z');
    expect(store.listIssues({ since: '2024-01-01T12:00:00.000Z', open: true }).items.map((i) => i.code)).toEqual(['c']);
    expect(store.listIssues({ resolvedSince: '2024-01-01T12:00:00.000Z' }).items.map((i) => i.code)).toEqual(['a']);

    // re-appearing issue counts as new again
    const third = store.upsertProduct(product([{ code: 'a' }, { code: 'b' }, { code: 'c' }]), '2024-01-03T00:00:00.000Z');
    expect(third.newIssues.map((i) => i.code)).toEqual(['a']);
    expect(store.listIssues({ open: true }).items.find((i) => i.code === 'a')?.firstSeenAt).toBe('2024-01-03T00:00:00.000Z');
  });

  it('computes aggregated status and severity', () => {
    expect(computeAggregatedStatus(product([]))).toBe('APPROVED');
    expect(computeAggregatedStatus(product([{ code: 'x' }]))).toBe('DISAPPROVED');
    expect(
      computeAggregatedStatus({ productStatus: { destinationStatuses: [{ approvedCountries: ['PL'], disapprovedCountries: ['DE'] }] } }),
    ).toBe('PARTIALLY_APPROVED');
    expect(computeAggregatedStatus({ productStatus: { destinationStatuses: [{ pendingCountries: ['PL'] }] } })).toBe('PENDING');

    const store = new ProductStore(new Database(':memory:'));
    store.upsertProduct(product([{ code: 'w', severity: 'DEMOTED' }]));
    const rec = store.listProducts().items[0]!;
    expect(rec.maxSeverity).toBe('warning');
    expect(rec.issueCount).toBe(1);
  });

  it('marks missing products as deleted and resolves their issues', () => {
    const store = new ProductStore(new Database(':memory:'));
    store.upsertProduct(product([{ code: 'a' }]), '2024-01-01T00:00:00.000Z');
    const deleted = store.markMissingAsDeleted('2024-01-02T00:00:00.000Z', '2024-01-02T00:00:01.000Z');
    expect(deleted).toEqual(['accounts/1/products/pl~PL~sku1']);
    expect(store.listProducts().total).toBe(0);
    expect(store.listProducts({ includeDeleted: true }).total).toBe(1);
    expect(store.listIssues({ open: true }).total).toBe(0);
  });

  it('filters by tag, status and issue code', () => {
    const store = new ProductStore(new Database(':memory:'));
    store.upsertProduct(product([{ code: 'a' }]));
    store.upsertProduct(product([], { name: 'accounts/1/products/pl~PL~sku2', offerId: 'sku2' }));
    store.saveMetadata('accounts/1/products/pl~PL~sku2', { tags: ['vip', 'x'] });
    expect(store.listProducts({ tag: 'vip' }).items.map((p) => p.offerId)).toEqual(['sku2']);
    expect(store.listProducts({ status: ['DISAPPROVED'] }).items.map((p) => p.offerId)).toEqual(['sku1']);
    expect(store.listProducts({ issueCode: 'a' }).items.map((p) => p.offerId)).toEqual(['sku1']);
    expect(store.listProducts({ q: 'sku2' }).total).toBe(1);
    expect(store.allTags()).toEqual([{ tag: 'vip', count: 1 }, { tag: 'x', count: 1 }]);
  });
});
