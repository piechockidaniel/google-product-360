import { describe, expect, it } from 'vitest';
import { AttributeValidationError, normalizeAttributes } from '../src/services/attribute-catalog.js';

describe('normalizeAttributes', () => {
  it('coerces values according to the catalog', () => {
    expect(
      normalizeAttributes({
        customLabel0: 'promo',
        productHighlights: 'a\nb, c',
        adult: 'false',
        price: '19.99 PLN',
        salePrice: { amount: 5, currencyCode: 'EUR' },
        gtins: ['1', '2'],
        shipping: '[{"country":"PL"}]',
        unknownAttribute: { foo: 1 },
        removeMe: null,
        alsoRemove: '',
      }),
    ).toEqual({
      customLabel0: 'promo',
      productHighlights: ['a', 'b', 'c'],
      adult: false,
      price: { amountMicros: '19990000', currencyCode: 'PLN' },
      salePrice: { amountMicros: '5000000', currencyCode: 'EUR' },
      gtins: ['1', '2'],
      shipping: [{ country: 'PL' }],
      unknownAttribute: { foo: 1 },
      removeMe: null,
      alsoRemove: null,
    });
  });

  it('rejects invalid enum values, prices and JSON', () => {
    expect(() => normalizeAttributes({ availability: 'MAYBE' })).toThrow(AttributeValidationError);
    expect(() => normalizeAttributes({ price: 'cheap' })).toThrow(/price/);
    expect(() => normalizeAttributes({ shipping: '{oops' })).toThrow(/JSON/);
  });
});
