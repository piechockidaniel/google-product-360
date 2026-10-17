import { describe, expect, it } from 'vitest';
import { evaluateCondition, getPath, renderTemplate } from '../src/workflows/conditions.js';

const product = {
  offerId: 'SKU-1',
  title: 'Acme Lamp',
  status: 'DISAPPROVED',
  issueCount: 2,
  price: { amount: 19.99, currency: 'PLN' },
  issueCodes: ['missing_gtin', 'price_mismatch'],
  issues: [
    { code: 'missing_gtin', level: 'warning' },
    { code: 'price_mismatch', level: 'error' },
  ],
  attributes: { brand: 'Acme', customLabel0: '' },
  tags: ['promo'],
};

describe('getPath', () => {
  it('resolves nested paths and maps over arrays', () => {
    expect(getPath(product, 'price.currency')).toBe('PLN');
    expect(getPath(product, 'issues.code')).toEqual(['missing_gtin', 'price_mismatch']);
    expect(getPath(product, 'issues.0.level')).toBe('warning');
    expect(getPath(product, 'nope.deeper')).toBeUndefined();
  });
});

describe('evaluateCondition', () => {
  it('supports comparison operators', () => {
    expect(evaluateCondition(product, { field: 'status', op: 'eq', value: 'disapproved' })).toBe(true);
    expect(evaluateCondition(product, { field: 'status', op: 'neq', value: 'APPROVED' })).toBe(true);
    expect(evaluateCondition(product, { field: 'issueCount', op: 'gte', value: 2 })).toBe(true);
    expect(evaluateCondition(product, { field: 'price.amount', op: 'lt', value: '20' })).toBe(true);
    expect(evaluateCondition(product, { field: 'title', op: 'starts_with', value: 'acme' })).toBe(true);
    expect(evaluateCondition(product, { field: 'title', op: 'regex', value: '^Acme L' })).toBe(true);
  });

  it('supports array operators', () => {
    expect(evaluateCondition(product, { field: 'issueCodes', op: 'contains', value: 'missing_gtin' })).toBe(true);
    expect(evaluateCondition(product, { field: 'issueCodes', op: 'not_contains', value: 'generic_title' })).toBe(true);
    expect(evaluateCondition(product, { field: 'issues.level', op: 'in', value: ['error'] })).toBe(true);
    expect(evaluateCondition(product, { field: 'tags', op: 'in', value: ['x', 'promo'] })).toBe(true);
    expect(evaluateCondition(product, { field: 'issues', op: 'gt', value: 1 })).toBe(true); // array length
  });

  it('supports existence / emptiness', () => {
    expect(evaluateCondition(product, { field: 'attributes.customLabel0', op: 'is_empty' })).toBe(true);
    expect(evaluateCondition(product, { field: 'attributes.customLabel1', op: 'not_exists' })).toBe(true);
    expect(evaluateCondition(product, { field: 'attributes.brand', op: 'is_not_empty' })).toBe(true);
  });

  it('supports all / any / not groups', () => {
    expect(
      evaluateCondition(product, {
        all: [{ field: 'status', op: 'eq', value: 'DISAPPROVED' }, { any: [{ field: 'tags', op: 'contains', value: 'nope' }, { field: 'tags', op: 'contains', value: 'promo' }] }],
      }),
    ).toBe(true);
    expect(evaluateCondition(product, { not: { field: 'status', op: 'eq', value: 'DISAPPROVED' } })).toBe(false);
  });
});

describe('renderTemplate', () => {
  it('replaces placeholders', () => {
    expect(renderTemplate('{{offerId}} – {{attributes.brand}} ({{issueCodes}})', product)).toBe('SKU-1 – Acme (missing_gtin, price_mismatch)');
    expect(renderTemplate('x{{missing}}y', product)).toBe('xy');
  });
});
