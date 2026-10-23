/**
 * Catalog of product attributes that can be pushed through the enrichment
 * (supplemental) data source. Used for validation / coercion in the API,
 * the workflow engine and the UI form.
 */
export type AttributeType = 'string' | 'string[]' | 'boolean' | 'number' | 'price' | 'json';

export interface AttributeDefinition {
  name: string;
  type: AttributeType;
  label: string;
  group: 'Basic' | 'Category' | 'Identifiers' | 'Variants' | 'Custom labels' | 'Shipping & returns' | 'Ads' | 'Other';
  enum?: string[];
  help?: string;
}

export const ATTRIBUTE_CATALOG: AttributeDefinition[] = [
  { name: 'title', type: 'string', label: 'Title', group: 'Basic' },
  { name: 'description', type: 'string', label: 'Description', group: 'Basic' },
  { name: 'link', type: 'string', label: 'Link', group: 'Basic' },
  { name: 'mobileLink', type: 'string', label: 'Mobile link', group: 'Basic' },
  { name: 'imageLink', type: 'string', label: 'Image link', group: 'Basic' },
  { name: 'additionalImageLinks', type: 'string[]', label: 'Additional image links', group: 'Basic' },
  { name: 'lifestyleImageLinks', type: 'string[]', label: 'Lifestyle image links', group: 'Basic' },
  { name: 'availability', type: 'string', label: 'Availability', group: 'Basic', enum: ['IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'BACKORDER'] },
  { name: 'availabilityDate', type: 'string', label: 'Availability date (RFC 3339)', group: 'Basic' },
  { name: 'expirationDate', type: 'string', label: 'Expiration date (RFC 3339)', group: 'Basic' },
  { name: 'price', type: 'price', label: 'Price', group: 'Basic' },
  { name: 'salePrice', type: 'price', label: 'Sale price', group: 'Basic' },
  { name: 'salePriceEffectiveDate', type: 'json', label: 'Sale price effective date', group: 'Basic', help: '{"startTime":"2025-11-28T00:00:00Z","endTime":"2025-12-01T23:59:59Z"}' },
  { name: 'condition', type: 'string', label: 'Condition', group: 'Basic', enum: ['NEW', 'REFURBISHED', 'USED'] },
  { name: 'adult', type: 'boolean', label: 'Adult', group: 'Basic' },
  { name: 'pause', type: 'string', label: 'Pause', group: 'Basic', enum: ['ALL'], help: 'Set to ALL to pause the product everywhere' },

  { name: 'googleProductCategory', type: 'string', label: 'Google product category', group: 'Category' },
  { name: 'productTypes', type: 'string[]', label: 'Product types', group: 'Category' },
  { name: 'productHighlights', type: 'string[]', label: 'Product highlights', group: 'Category' },
  { name: 'productDetails', type: 'json', label: 'Product details (JSON array)', group: 'Category', help: '[{"sectionName":"","attributeName":"","attributeValue":""}]' },

  { name: 'brand', type: 'string', label: 'Brand', group: 'Identifiers' },
  { name: 'gtins', type: 'string[]', label: 'GTINs', group: 'Identifiers' },
  { name: 'mpn', type: 'string', label: 'MPN', group: 'Identifiers' },
  { name: 'identifierExists', type: 'boolean', label: 'Identifier exists', group: 'Identifiers' },

  { name: 'itemGroupId', type: 'string', label: 'Item group id', group: 'Variants' },
  { name: 'color', type: 'string', label: 'Color', group: 'Variants' },
  { name: 'size', type: 'string', label: 'Size', group: 'Variants' },
  { name: 'sizeSystem', type: 'string', label: 'Size system', group: 'Variants' },
  { name: 'sizeTypes', type: 'string[]', label: 'Size types', group: 'Variants' },
  { name: 'gender', type: 'string', label: 'Gender', group: 'Variants', enum: ['MALE', 'FEMALE', 'UNISEX'] },
  { name: 'ageGroup', type: 'string', label: 'Age group', group: 'Variants', enum: ['NEWBORN', 'INFANT', 'TODDLER', 'KIDS', 'ADULT'] },
  { name: 'material', type: 'string', label: 'Material', group: 'Variants' },
  { name: 'pattern', type: 'string', label: 'Pattern', group: 'Variants' },
  { name: 'multipack', type: 'string', label: 'Multipack', group: 'Variants' },
  { name: 'isBundle', type: 'boolean', label: 'Is bundle', group: 'Variants' },

  { name: 'customLabel0', type: 'string', label: 'Custom label 0', group: 'Custom labels' },
  { name: 'customLabel1', type: 'string', label: 'Custom label 1', group: 'Custom labels' },
  { name: 'customLabel2', type: 'string', label: 'Custom label 2', group: 'Custom labels' },
  { name: 'customLabel3', type: 'string', label: 'Custom label 3', group: 'Custom labels' },
  { name: 'customLabel4', type: 'string', label: 'Custom label 4', group: 'Custom labels' },

  { name: 'shippingLabel', type: 'string', label: 'Shipping label', group: 'Shipping & returns' },
  { name: 'returnPolicyLabel', type: 'string', label: 'Return policy label', group: 'Shipping & returns' },
  { name: 'transitTimeLabel', type: 'string', label: 'Transit time label', group: 'Shipping & returns' },
  { name: 'shipping', type: 'json', label: 'Shipping (JSON array)', group: 'Shipping & returns', help: '[{"country":"PL","service":"Courier","price":{"amountMicros":"14990000","currencyCode":"PLN"}}]' },
  { name: 'shippingWeight', type: 'json', label: 'Shipping weight', group: 'Shipping & returns', help: '{"value":1.5,"unit":"kg"}' },

  { name: 'adsLabels', type: 'string[]', label: 'Ads labels', group: 'Ads' },
  { name: 'adsRedirect', type: 'string', label: 'Ads redirect', group: 'Ads' },
  { name: 'includedDestinations', type: 'string[]', label: 'Included destinations', group: 'Ads' },
  { name: 'excludedDestinations', type: 'string[]', label: 'Excluded destinations', group: 'Ads' },
  { name: 'shoppingAdsExcludedCountries', type: 'string[]', label: 'Shopping ads excluded countries', group: 'Ads' },
  { name: 'canonicalLink', type: 'string', label: 'Canonical link', group: 'Other' },
];

const byName = new Map(ATTRIBUTE_CATALOG.map((a) => [a.name, a]));

export class AttributeValidationError extends Error {
  constructor(
    public readonly attribute: string,
    message: string,
  ) {
    super(`${attribute}: ${message}`);
    this.name = 'AttributeValidationError';
  }
}

function parsePrice(value: unknown, attribute: string): { amountMicros: string; currencyCode: string } {
  if (value && typeof value === 'object') {
    const v = value as { amountMicros?: unknown; currencyCode?: unknown; amount?: unknown };
    if (typeof v.currencyCode !== 'string' || !v.currencyCode) throw new AttributeValidationError(attribute, 'currencyCode required');
    if (v.amountMicros !== undefined) return { amountMicros: String(v.amountMicros), currencyCode: v.currencyCode };
    if (v.amount !== undefined) return { amountMicros: String(Math.round(Number(v.amount) * 1_000_000)), currencyCode: v.currencyCode };
  }
  if (typeof value === 'string') {
    // "19.99 PLN"
    const m = /^\s*([0-9]+(?:[.,][0-9]+)?)\s*([A-Za-z]{3})\s*$/.exec(value);
    if (m) return { amountMicros: String(Math.round(Number(m[1]!.replace(',', '.')) * 1_000_000)), currencyCode: m[2]!.toUpperCase() };
  }
  throw new AttributeValidationError(attribute, 'expected {"amountMicros","currencyCode"} or "19.99 PLN"');
}

/**
 * Coerces a loosely typed attribute map (as produced by the UI or a workflow
 * definition) into the exact JSON the Merchant API expects. Unknown attributes
 * are passed through untouched so newly introduced API fields keep working.
 * `null` values are preserved (they mean "remove").
 */
export function normalizeAttributes(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    if (raw === null || raw === '') {
      out[name] = null;
      continue;
    }
    const def = byName.get(name);
    if (!def) {
      out[name] = raw;
      continue;
    }
    switch (def.type) {
      case 'string':
        out[name] = String(raw);
        if (def.enum && !def.enum.includes(out[name] as string)) {
          throw new AttributeValidationError(name, `must be one of ${def.enum.join(', ')}`);
        }
        break;
      case 'string[]':
        out[name] = Array.isArray(raw) ? raw.map(String) : String(raw).split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
        break;
      case 'boolean':
        out[name] = typeof raw === 'boolean' ? raw : ['true', '1', 'yes'].includes(String(raw).toLowerCase());
        break;
      case 'number': {
        const n = Number(raw);
        if (Number.isNaN(n)) throw new AttributeValidationError(name, 'must be a number');
        out[name] = n;
        break;
      }
      case 'price':
        out[name] = parsePrice(raw, name);
        break;
      case 'json':
        if (typeof raw === 'string') {
          try {
            out[name] = JSON.parse(raw);
          } catch {
            throw new AttributeValidationError(name, 'must be valid JSON');
          }
        } else out[name] = raw;
        break;
    }
  }
  return out;
}
