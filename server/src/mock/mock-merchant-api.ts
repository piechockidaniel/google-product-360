import type { MerchantApi } from '../google/merchant-api.js';
import { buildProductId, lastSegment, productIdFromName, encodeProductId, decodeProductId } from '../google/merchant-api.js';
import { MerchantApiError } from '../google/rest-client.js';
import type {
  Account,
  AccountIssue,
  AggregateProductStatus,
  DataSource,
  FileUpload,
  Homepage,
  ItemLevelIssue,
  NotificationSubscription,
  OnlineReturnPolicy,
  Product,
  ProductAttributes,
  ProductInput,
  DeveloperRegistration,
  QuotaGroup,
  RenderedIssue,
  ReportRow,
  ShippingSettings,
} from '../google/types.js';
import { generateReport } from './mock-reports.js';

/** Deterministic pseudo random generator so the mock data is stable between restarts. */
class Rng {
  constructor(private seed: number) {}
  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const ISSUE_CATALOG: ItemLevelIssue[] = [
  {
    code: 'image_link_broken',
    severity: 'DISAPPROVED',
    resolution: 'MERCHANT_ACTION',
    attribute: 'image_link',
    reportingContext: 'SHOPPING_ADS',
    description: 'Invalid image [image link]',
    detail: "The image couldn't be retrieved. Make sure the URL is correct and the image is accessible.",
    documentation: 'https://support.google.com/merchants/answer/6098288',
    applicableCountries: ['PL'],
  },
  {
    code: 'price_mismatch',
    severity: 'DISAPPROVED',
    resolution: 'MERCHANT_ACTION',
    attribute: 'price',
    reportingContext: 'SHOPPING_ADS',
    description: 'Mismatched value (page crawl) [price]',
    detail: 'The price in your product data does not match the price on your landing page.',
    documentation: 'https://support.google.com/merchants/answer/6098334',
    applicableCountries: ['PL'],
  },
  {
    code: 'missing_gtin',
    severity: 'DEMOTED',
    resolution: 'MERCHANT_ACTION',
    attribute: 'gtin',
    reportingContext: 'SHOPPING_ADS',
    description: 'Limited performance due to missing identifiers [gtin]',
    detail: 'Add a GTIN to improve the performance of this product.',
    documentation: 'https://support.google.com/merchants/answer/6324461',
    applicableCountries: ['PL', 'DE'],
  },
  {
    code: 'missing_shipping',
    severity: 'DISAPPROVED',
    resolution: 'MERCHANT_ACTION',
    attribute: 'shipping',
    reportingContext: 'SHOPPING_ADS',
    description: 'Missing value [shipping]',
    detail: 'No shipping information could be found for this product for the target country.',
    documentation: 'https://support.google.com/merchants/answer/6324484',
    applicableCountries: ['DE'],
  },
  {
    code: 'generic_title',
    severity: 'DEMOTED',
    resolution: 'MERCHANT_ACTION',
    attribute: 'title',
    reportingContext: 'SHOPPING_ADS',
    description: 'Generic title [title]',
    detail: 'Use a specific, descriptive title that includes brand, product type and distinguishing attributes.',
    documentation: 'https://support.google.com/merchants/answer/6324415',
    applicableCountries: ['PL'],
  },
  {
    code: 'pending_initial_policy_review',
    severity: 'NOT_IMPACTED',
    resolution: 'PENDING_PROCESSING',
    reportingContext: 'SHOPPING_ADS',
    description: 'Pending initial review',
    detail: 'This product is being reviewed. No action is needed.',
    documentation: 'https://support.google.com/merchants/answer/2948694',
    applicableCountries: ['PL'],
  },
  {
    code: 'policy_violation',
    severity: 'DISAPPROVED',
    resolution: 'MERCHANT_ACTION',
    reportingContext: 'SHOPPING_ADS',
    description: 'Violation of Shopping ads policy',
    detail: 'This product violates the Shopping ads policy (misrepresentation).',
    documentation: 'https://support.google.com/merchants/answer/6149970',
    applicableCountries: ['PL', 'DE'],
  },
];

const BRANDS = ['Acme', 'Nordlite', 'Kubo', 'Fjell', 'Vitra', 'Lumen'];
const TYPES = ['Backpack', 'Lamp', 'Jacket', 'Chair', 'Headphones', 'Kettle', 'Sneakers', 'Desk', 'Bottle', 'Blanket'];
const COLORS = ['Black', 'Blue', 'Olive', 'Sand', 'Red', 'Grey'];

interface MockProduct {
  product: Product;
  /** attributes pushed through supplemental data sources keyed by data source name */
  supplemental: Map<string, ProductInput>;
}

export interface MockMerchantApiOptions {
  accountId?: string;
  productCount?: number;
  seed?: number;
}

/**
 * In-memory Merchant API used when MERCHANT_MOCK=true. Behaves like the real
 * API closely enough to exercise every feature of the app without Google.
 */
export class MockMerchantApi implements MerchantApi {
  readonly accountId: string;
  readonly accountName: string;

  private readonly rng: Rng;
  private readonly products = new Map<string, MockProduct>();
  private readonly dataSources = new Map<string, DataSource>();
  private readonly subscriptions = new Map<string, NotificationSubscription>();
  private readonly returnPolicies = new Map<string, OnlineReturnPolicy>();
  private accountIssues: AccountIssue[] = [];
  private nextId = 1000;
  readonly fetchLog: string[] = [];

  constructor(options: MockMerchantApiOptions = {}) {
    this.accountId = options.accountId ?? '1234567890';
    this.accountName = `accounts/${this.accountId}`;
    this.rng = new Rng(options.seed ?? 42);
    this.seed(options.productCount ?? 60);
  }

  // ------------------------------------------------------------- seeding
  private seed(count: number): void {
    const primary: DataSource = {
      name: `${this.accountName}/dataSources/101`,
      dataSourceId: '101',
      displayName: 'Main shop feed (PL)',
      input: 'FILE',
      fileInput: {
        fileInputType: 'FETCH',
        fileName: 'products-pl.xml',
        fetchSettings: {
          enabled: true,
          frequency: 'FREQUENCY_DAILY',
          timeOfDay: { hours: 4, minutes: 30 },
          timeZone: 'Europe/Warsaw',
          fetchUri: 'https://example-shop.pl/feeds/google-products.xml',
        },
      },
      primaryProductDataSource: { feedLabel: 'PL', contentLanguage: 'pl', countries: ['PL'] },
    };
    const primaryDe: DataSource = {
      name: `${this.accountName}/dataSources/102`,
      dataSourceId: '102',
      displayName: 'Main shop feed (DE)',
      input: 'FILE',
      fileInput: {
        fileInputType: 'FETCH',
        fileName: 'products-de.xml',
        fetchSettings: {
          enabled: true,
          frequency: 'FREQUENCY_DAILY',
          timeOfDay: { hours: 5, minutes: 0 },
          timeZone: 'Europe/Berlin',
          fetchUri: 'https://example-shop.pl/feeds/google-products-de.xml',
        },
      },
      primaryProductDataSource: { feedLabel: 'DE', contentLanguage: 'de', countries: ['DE'] },
    };
    const api: DataSource = {
      name: `${this.accountName}/dataSources/103`,
      dataSourceId: '103',
      displayName: 'API products',
      input: 'API',
      primaryProductDataSource: {},
    };
    for (const ds of [primary, primaryDe, api]) this.dataSources.set(ds.dataSourceId!, ds);

    for (let i = 1; i <= count; i += 1) {
      const brand = this.rng.pick(BRANDS);
      const type = this.rng.pick(TYPES);
      const color = this.rng.pick(COLORS);
      const de = i % 4 === 0;
      const lang = de ? 'de' : 'pl';
      const feedLabel = de ? 'DE' : 'PL';
      const offerId = `SKU-${String(i).padStart(4, '0')}`;
      const id = buildProductId(lang, feedLabel, offerId);
      const issues: ItemLevelIssue[] = [];
      if (this.rng.chance(0.45)) issues.push({ ...this.rng.pick(ISSUE_CATALOG) });
      if (this.rng.chance(0.15)) {
        const extra = this.rng.pick(ISSUE_CATALOG);
        if (!issues.some((x) => x.code === extra.code)) issues.push({ ...extra });
      }
      const priceMicros = String(Math.round((20 + this.rng.next() * 480) * 100) * 10000);
      const product: Product = {
        name: `${this.accountName}/products/${id}`,
        base64EncodedName: `${this.accountName}/products/${encodeProductId(id)}`,
        offerId,
        contentLanguage: lang,
        feedLabel,
        dataSource: de ? primaryDe.name : primary.name,
        productAttributes: {
          title: issues.some((issue) => issue.code === 'generic_title') ? `${type} ${color}` : `${brand} ${type} ${color}`,
          description: `The ${brand} ${type} in ${color.toLowerCase()} – durable, lightweight and made to last.`,
          link: `https://example-shop.pl/p/${offerId.toLowerCase()}`,
          imageLink: `https://example-shop.pl/img/${offerId.toLowerCase()}.jpg`,
          brand,
          condition: 'NEW',
          availability: this.rng.chance(0.85) ? 'IN_STOCK' : 'OUT_OF_STOCK',
          price: { amountMicros: priceMicros, currencyCode: de ? 'EUR' : 'PLN' },
          googleProductCategory: type === 'Jacket' || type === 'Sneakers' ? 'Apparel & Accessories' : 'Home & Garden',
          productTypes: [`${type}s`],
          color,
          gtins: issues.some((x) => x.code === 'missing_gtin') ? undefined : [`590${String(1000000000 + i).slice(0, 10)}`],
          itemGroupId: `GRP-${type.toUpperCase()}`,
        },
        customAttributes: [],
        productStatus: {
          creationDate: '2024-03-01T10:00:00Z',
          lastUpdateDate: new Date(Date.now() - Math.floor(this.rng.next() * 5) * 86400_000).toISOString(),
          googleExpirationDate: new Date(Date.now() + 25 * 86400_000).toISOString(),
          itemLevelIssues: issues,
          destinationStatuses: [this.destinationStatusFor(issues, feedLabel)],
        },
      };
      this.products.set(id, { product, supplemental: new Map() });
    }

    this.accountIssues = [
      {
        name: `${this.accountName}/issues/homepage-not-claimed`,
        title: 'Website not claimed',
        severity: 'ERROR',
        detail: 'Claim your website in Merchant Center so your products can be served.',
        documentationUri: 'https://support.google.com/merchants/answer/176793',
        impactedDestinations: [{ reportingContext: 'SHOPPING_ADS', impacts: [{ regionCode: 'PL', severity: 'ERROR' }] }],
      },
      {
        name: `${this.accountName}/issues/missing-return-policy`,
        title: 'Missing return policy',
        severity: 'SUGGESTION',
        detail: 'Add a return policy to improve customer trust and eligibility for free listings.',
        documentationUri: 'https://support.google.com/merchants/answer/10220642',
        impactedDestinations: [{ reportingContext: 'FREE_LISTINGS', impacts: [{ regionCode: 'PL', severity: 'SUGGESTION' }] }],
      },
    ];

    this.returnPolicies.set('rp-1', {
      name: `${this.accountName}/onlineReturnPolicies/rp-1`,
      returnPolicyId: 'rp-1',
      label: 'Standard 30 days',
      countries: ['PL', 'DE'],
      policy: { type: 'NUMBER_OF_DAYS_AFTER_DELIVERY', days: '30' },
      returnMethods: ['BY_MAIL'],
      itemConditions: ['NEW'],
      returnPolicyUri: 'https://example-shop.pl/returns',
      processRefundDays: 14,
    });
  }

  private destinationStatusFor(issues: ItemLevelIssue[], feedLabel: string) {
    const disapproved = issues.some((i) => i.severity === 'DISAPPROVED');
    const pending = issues.some((i) => i.resolution === 'PENDING_PROCESSING');
    return {
      reportingContext: 'SHOPPING_ADS',
      approvedCountries: disapproved || pending ? [] : [feedLabel],
      pendingCountries: pending && !disapproved ? [feedLabel] : [],
      disapprovedCountries: disapproved ? [feedLabel] : [],
    };
  }

  /**
   * Simulates Google re-processing: resolves some issues, adds new ones.
   * Exposed through a dev-only route so the "since last login" views can be demoed.
   */
  simulateChanges(): { added: string[]; resolved: string[] } {
    const added: string[] = [];
    const resolved: string[] = [];
    for (const [id, entry] of this.products) {
      const status = entry.product.productStatus!;
      const issues = status.itemLevelIssues ?? [];
      if (issues.length > 0 && this.rng.chance(0.2)) {
        issues.pop();
        resolved.push(id);
      } else if (this.rng.chance(0.08)) {
        const candidate = this.rng.pick(ISSUE_CATALOG);
        if (!issues.some((x) => x.code === candidate.code)) {
          issues.push({ ...candidate });
          added.push(id);
        }
      }
      status.itemLevelIssues = issues;
      status.destinationStatuses = [this.destinationStatusFor(issues, entry.product.feedLabel!)];
      status.lastUpdateDate = new Date().toISOString();
    }
    return { added, resolved };
  }

  private notFound(what: string): never {
    throw new MerchantApiError(`${what} not found`, 404, 'NOT_FOUND');
  }

  private resolveProduct(productId: string): MockProduct {
    const plain = productId.includes('~') ? productId : decodeProductId(productId);
    return this.products.get(plain) ?? this.notFound(`Product ${plain}`);
  }

  // ------------------------------------------------------------- accounts
  async getAccount(): Promise<Account> {
    return {
      name: this.accountName,
      accountId: this.accountId,
      accountName: 'Example Shop (mock)',
      adultContent: false,
      testAccount: true,
      timeZone: { id: 'Europe/Warsaw' },
      languageCode: 'pl',
    };
  }

  async listAccountIssues(): Promise<AccountIssue[]> {
    return structuredClone(this.accountIssues);
  }

  async getHomepage(): Promise<Homepage> {
    return { name: `${this.accountName}/homepage`, uri: 'https://example-shop.pl', claimed: false };
  }

  async getShippingSettings(): Promise<ShippingSettings> {
    return {
      name: `${this.accountName}/shippingSettings`,
      etag: 'mock-etag',
      services: [
        {
          serviceName: 'Courier PL',
          active: true,
          deliveryCountries: ['PL'],
          currencyCode: 'PLN',
          shipmentType: 'DELIVERY',
          deliveryTime: { minTransitDays: 1, maxTransitDays: 3, minHandlingDays: 0, maxHandlingDays: 1 },
          rateGroups: [{ applicableShippingLabels: [], singleValue: { flatRate: { amountMicros: '14990000', currencyCode: 'PLN' } } }],
        },
        {
          serviceName: 'DHL DE',
          active: true,
          deliveryCountries: ['DE'],
          currencyCode: 'EUR',
          shipmentType: 'DELIVERY',
          deliveryTime: { minTransitDays: 2, maxTransitDays: 5, minHandlingDays: 0, maxHandlingDays: 1 },
          rateGroups: [{ applicableShippingLabels: [], singleValue: { flatRate: { amountMicros: '5990000', currencyCode: 'EUR' } } }],
        },
      ],
    };
  }

  async listReturnPolicies(): Promise<OnlineReturnPolicy[]> {
    return [...this.returnPolicies.values()].map((p) => structuredClone(p));
  }

  async createReturnPolicy(policy: OnlineReturnPolicy): Promise<OnlineReturnPolicy> {
    const id = `rp-${this.nextId++}`;
    const created = { ...policy, returnPolicyId: id, name: `${this.accountName}/onlineReturnPolicies/${id}` };
    this.returnPolicies.set(id, created);
    return structuredClone(created);
  }

  async updateReturnPolicy(returnPolicyId: string, policy: OnlineReturnPolicy): Promise<OnlineReturnPolicy> {
    const existing = this.returnPolicies.get(returnPolicyId) ?? this.notFound('Return policy');
    const updated = { ...existing, ...policy, returnPolicyId, name: existing.name };
    this.returnPolicies.set(returnPolicyId, updated);
    return structuredClone(updated);
  }

  async deleteReturnPolicy(returnPolicyId: string): Promise<void> {
    if (!this.returnPolicies.delete(returnPolicyId)) this.notFound('Return policy');
  }

  // ------------------------------------------------------------- products
  async *listProductPages(pageSize = 1000): AsyncGenerator<Product[], void, undefined> {
    const all = [...this.products.values()].map((p) => this.materialize(p));
    for (let i = 0; i < all.length; i += pageSize) yield all.slice(i, i + pageSize);
  }

  async listAllProducts(): Promise<Product[]> {
    return [...this.products.values()].map((p) => this.materialize(p));
  }

  async getProduct(productId: string): Promise<Product> {
    this.count('getProduct');
    return this.materialize(this.resolveProduct(productId));
  }

  /** Applies supplemental inputs on top of the primary product, like Google does. */
  private materialize(entry: MockProduct): Product {
    const product = structuredClone(entry.product);
    let titleWasEnriched = false;
    for (const input of entry.supplemental.values()) {
      product.productAttributes = { ...product.productAttributes, ...input.productAttributes };
      if (typeof input.productAttributes?.title === 'string' && input.productAttributes.title.trim()) titleWasEnriched = true;
      if (input.customAttributes?.length) {
        const merged = new Map((product.customAttributes ?? []).map((c) => [c.name, c]));
        for (const c of input.customAttributes) merged.set(c.name, c);
        product.customAttributes = [...merged.values()];
      }
    }
    if (titleWasEnriched && product.productStatus?.itemLevelIssues) {
      const issues = product.productStatus.itemLevelIssues.filter((issue) => issue.code !== 'generic_title');
      product.productStatus = {
        ...product.productStatus,
        itemLevelIssues: issues,
        destinationStatuses: [this.destinationStatusFor(issues, product.feedLabel ?? '')],
      };
    }
    return product;
  }

  async insertProductInput(dataSourceName: string, input: ProductInput): Promise<ProductInput> {
    this.count('insertProductInput');
    const ds = this.dataSources.get(lastSegment(dataSourceName)) ?? this.notFound('Data source');
    if (!input.offerId || !input.contentLanguage || !input.feedLabel) {
      throw new MerchantApiError('offerId, contentLanguage and feedLabel are required', 400, 'INVALID_ARGUMENT');
    }
    const id = buildProductId(input.contentLanguage, input.feedLabel, input.offerId, input.legacyLocal);
    const stored: ProductInput = {
      ...structuredClone(input),
      name: `${this.accountName}/productInputs/${id}`,
      product: `${this.accountName}/products/${id}`,
    };
    if (ds.supplementalProductDataSource) {
      const entry = this.products.get(id) ?? this.notFound(`Product ${id} (supplemental inputs need an existing product)`);
      entry.supplemental.set(ds.name!, stored);
    } else {
      const existing = this.products.get(id);
      const product: Product = {
        name: `${this.accountName}/products/${id}`,
        base64EncodedName: `${this.accountName}/products/${encodeProductId(id)}`,
        offerId: input.offerId,
        contentLanguage: input.contentLanguage,
        feedLabel: input.feedLabel,
        dataSource: ds.name,
        productAttributes: structuredClone(input.productAttributes ?? {}),
        customAttributes: structuredClone(input.customAttributes ?? []),
        productStatus: existing?.product.productStatus ?? {
          creationDate: new Date().toISOString(),
          lastUpdateDate: new Date().toISOString(),
          itemLevelIssues: [ISSUE_CATALOG[5]!],
          destinationStatuses: [this.destinationStatusFor([ISSUE_CATALOG[5]!], input.feedLabel)],
        },
      };
      this.products.set(id, { product, supplemental: existing?.supplemental ?? new Map() });
    }
    return structuredClone(stored);
  }

  async patchProductInput(dataSourceName: string, productInputId: string, input: ProductInput, updateMask?: string): Promise<ProductInput> {
    const ds = this.dataSources.get(lastSegment(dataSourceName)) ?? this.notFound('Data source');
    const entry = this.resolveProduct(productInputId);
    const target = ds.supplementalProductDataSource
      ? (entry.supplemental.get(ds.name!) ?? this.notFound('Product input'))
      : { productAttributes: entry.product.productAttributes!, customAttributes: entry.product.customAttributes };
    const attrs = target.productAttributes ?? (target.productAttributes = {});
    const fields = updateMask ? updateMask.split(',').map((f) => f.trim()) : Object.keys(input.productAttributes ?? {});
    for (const field of fields) {
      const value = (input.productAttributes as Record<string, unknown> | undefined)?.[field];
      if (value === undefined || value === null) delete (attrs as Record<string, unknown>)[field];
      else (attrs as Record<string, unknown>)[field] = value;
    }
    if (input.customAttributes) target.customAttributes = structuredClone(input.customAttributes);
    return structuredClone({ ...target, name: `${this.accountName}/productInputs/${productInputId}` });
  }

  async deleteProductInput(dataSourceName: string, productInputId: string): Promise<void> {
    const ds = this.dataSources.get(lastSegment(dataSourceName)) ?? this.notFound('Data source');
    const plain = productInputId.includes('~') ? productInputId : decodeProductId(productInputId);
    const entry = this.products.get(plain) ?? this.notFound('Product input');
    if (ds.supplementalProductDataSource) entry.supplemental.delete(ds.name!);
    else this.products.delete(plain);
  }

  // ------------------------------------------------------------- data sources
  async listDataSources(): Promise<DataSource[]> {
    this.count('listDataSources');
    return [...this.dataSources.values()].map((d) => structuredClone(d));
  }

  async getDataSource(dataSourceId: string): Promise<DataSource> {
    return structuredClone(this.dataSources.get(dataSourceId) ?? this.notFound('Data source'));
  }

  async createDataSource(dataSource: DataSource): Promise<DataSource> {
    const id = String(this.nextId++);
    const created: DataSource = {
      ...structuredClone(dataSource),
      dataSourceId: id,
      name: `${this.accountName}/dataSources/${id}`,
      input: dataSource.input ?? (dataSource.fileInput ? 'FILE' : 'API'),
    };
    this.dataSources.set(id, created);
    return structuredClone(created);
  }

  async updateDataSource(dataSourceId: string, dataSource: DataSource, updateMask: string): Promise<DataSource> {
    const existing = this.dataSources.get(dataSourceId) ?? this.notFound('Data source');
    const fields = updateMask === '*' ? Object.keys(dataSource) : updateMask.split(',').map((f) => f.trim());
    const updated = structuredClone(existing) as Record<string, unknown>;
    for (const field of fields) {
      const top = field.split('.')[0]!;
      updated[top] = (dataSource as Record<string, unknown>)[top];
    }
    this.dataSources.set(dataSourceId, updated as DataSource);
    return structuredClone(updated as DataSource);
  }

  async deleteDataSource(dataSourceId: string): Promise<void> {
    if (!this.dataSources.delete(dataSourceId)) this.notFound('Data source');
  }

  async fetchDataSource(dataSourceId: string): Promise<void> {
    const ds = this.dataSources.get(dataSourceId) ?? this.notFound('Data source');
    if (ds.fileInput?.fileInputType !== 'FETCH') {
      throw new MerchantApiError('Only FETCH file data sources can be fetched', 400, 'FAILED_PRECONDITION');
    }
    this.fetchLog.push(`${new Date().toISOString()} ${dataSourceId}`);
  }

  async getLatestFileUpload(dataSourceId: string): Promise<FileUpload | undefined> {
    const ds = this.dataSources.get(dataSourceId) ?? this.notFound('Data source');
    if (ds.input !== 'FILE') return undefined;
    const isDe = dataSourceId === '102';
    return {
      name: `${ds.name}/fileUploads/latest`,
      dataSourceId,
      processingState: isDe ? 'SUCCEEDED' : 'SUCCEEDED',
      itemsTotal: isDe ? '15' : '45',
      itemsCreated: '0',
      itemsUpdated: isDe ? '15' : '44',
      uploadTime: new Date(Date.now() - 6 * 3600_000).toISOString(),
      issues: isDe
        ? []
        : [
            {
              code: 'validation_invalid_value',
              title: 'Invalid value',
              description: '1 item has an invalid value for the attribute "availability".',
              count: '1',
              severity: 'WARNING',
              documentationUri: 'https://support.google.com/merchants/answer/6324448',
            },
          ],
    };
  }

  // ------------------------------------------------------------- issue resolution
  async renderAccountIssues(): Promise<RenderedIssue[]> {
    return this.accountIssues.map((i) => ({
      title: i.title,
      impact: { severity: i.severity === 'SUGGESTION' ? 'INFO' : 'ERROR', message: 'Affects Shopping ads in PL' },
      prerenderedContent: `<p>${i.detail}</p>`,
      actions: [{ buttonLabel: 'Learn more', isAvailable: true, externalAction: { type: 'REVIEW_PRODUCT_ISSUE_IN_MERCHANT_CENTER', uri: i.documentationUri } }],
    }));
  }

  async renderProductIssues(productId: string): Promise<RenderedIssue[]> {
    const entry = this.resolveProduct(productId);
    return (entry.product.productStatus?.itemLevelIssues ?? []).map((i) => ({
      title: i.description,
      impact: {
        severity: i.severity === 'DISAPPROVED' ? 'ERROR' : i.severity === 'DEMOTED' ? 'WARNING' : 'INFO',
        message: `Affects ${i.reportingContext} in ${(i.applicableCountries ?? []).join(', ')}`,
        breakdowns: [{ regions: (i.applicableCountries ?? []).map((c) => ({ code: c, name: c })), details: [i.detail ?? ''] }],
      },
      prerenderedContent: `<p>${i.detail}</p>`,
      actions: [
        { buttonLabel: 'Learn more', isAvailable: true, externalAction: { type: 'LEGAL_APPEAL_IN_HELP_CENTER', uri: i.documentation } },
      ],
    }));
  }

  async listAggregateProductStatuses(): Promise<AggregateProductStatus[]> {
    const perCountry = new Map<string, AggregateProductStatus>();
    for (const { product } of this.products.values()) {
      const country = product.feedLabel!;
      const agg =
        perCountry.get(country) ??
        perCountry.set(country, {
          name: `${this.accountName}/aggregateProductStatuses/SHOPPING_ADS~${country}`,
          reportingContext: 'SHOPPING_ADS',
          country,
          stats: { activeCount: '0', pendingCount: '0', disapprovedCount: '0', expiringCount: '0' },
          itemLevelIssues: [],
        }).get(country)!;
      const issues = product.productStatus?.itemLevelIssues ?? [];
      const disapproved = issues.some((i) => i.severity === 'DISAPPROVED');
      const pending = issues.some((i) => i.resolution === 'PENDING_PROCESSING');
      const key = disapproved ? 'disapprovedCount' : pending ? 'pendingCount' : 'activeCount';
      agg.stats![key] = String(Number(agg.stats![key]) + 1);
      for (const issue of issues) {
        const existing = agg.itemLevelIssues!.find((i) => i.code === issue.code);
        if (existing) existing.productCount = String(Number(existing.productCount) + 1);
        else
          agg.itemLevelIssues!.push({
            code: issue.code,
            severity: issue.severity,
            resolution: issue.resolution,
            attribute: issue.attribute,
            description: issue.description,
            detail: issue.detail,
            documentationUri: issue.documentation,
            productCount: '1',
          });
      }
    }
    return [...perCountry.values()];
  }

  // ------------------------------------------------------------- notifications
  async listNotificationSubscriptions(): Promise<NotificationSubscription[]> {
    return [...this.subscriptions.values()].map((s) => structuredClone(s));
  }

  async createNotificationSubscription(subscription: NotificationSubscription): Promise<NotificationSubscription> {
    const id = `sub-${this.nextId++}`;
    const created = { ...subscription, name: `${this.accountName}/notificationsubscriptions/${id}` };
    this.subscriptions.set(id, created);
    return structuredClone(created);
  }

  async deleteNotificationSubscription(subscriptionId: string): Promise<void> {
    if (!this.subscriptions.delete(subscriptionId)) this.notFound('Notification subscription');
  }

  // ------------------------------------------------------------- reports
  /** Report views that behave as if Market Insights were disabled (tests / demo of the fallback). */
  readonly unavailableReportViews = new Set<string>();

  async searchReport(query: string): Promise<ReportRow[]> {
    this.count('searchReport');
    const products = [...this.products.values()].map((p) => p.product);
    return generateReport(query, products, { unavailableViews: this.unavailableReportViews });
  }

  // ------------------------------------------------------------- quota
  async listQuotas(): Promise<QuotaGroup[]> {
    return [
      { name: `${this.accountName}/quotas/products-insert`, quotaUsage: String(this.callCounts.get('insertProductInput') ?? 0), quotaLimit: '100000', quotaMinuteLimit: '2000', methodDetails: [{ method: 'insert', subapi: 'products', version: 'v1', path: 'productInputs:insert' }] },
      { name: `${this.accountName}/quotas/products-get`, quotaUsage: String(this.callCounts.get('getProduct') ?? 0), quotaLimit: '500000', quotaMinuteLimit: '6000', methodDetails: [{ method: 'get', subapi: 'products', version: 'v1', path: 'products/{product}' }] },
      { name: `${this.accountName}/quotas/products-list`, quotaUsage: '12', quotaLimit: '60000', quotaMinuteLimit: '600', methodDetails: [{ method: 'list', subapi: 'products', version: 'v1', path: 'products' }] },
    ];
  }

  // ------------------------------------------------------------- developer registration
  private registeredGcp: string[] = ['mock-project'];
  async getDeveloperRegistration(): Promise<DeveloperRegistration> {
    return { name: `${this.accountName}/developerRegistration`, gcpIds: [...this.registeredGcp] };
  }
  async registerGcp(developerEmail: string): Promise<DeveloperRegistration> {
    if (!/@/.test(developerEmail)) throw new MerchantApiError('developerEmail must be a valid e-mail', 400, 'INVALID_ARGUMENT');
    if (!this.registeredGcp.includes('mock-project')) this.registeredGcp.push('mock-project');
    return this.getDeveloperRegistration();
  }

  /** Number of calls per method (tests / diagnostics). */
  readonly callCounts = new Map<string, number>();
  private count(method: string): void {
    this.callCounts.set(method, (this.callCounts.get(method) ?? 0) + 1);
  }

  // ------------------------------------------------------------- test helpers
  /** Returns the supplemental input stored for a product (tests / debugging). */
  getSupplementalInput(productId: string, dataSourceName: string): ProductInput | undefined {
    return this.resolveProduct(productId).supplemental.get(dataSourceName);
  }

  /** Directly manipulate a product's issues (tests). */
  setProductIssues(productId: string, issues: ItemLevelIssue[]): void {
    const entry = this.resolveProduct(productId);
    entry.product.productStatus!.itemLevelIssues = issues;
    entry.product.productStatus!.destinationStatuses = [this.destinationStatusFor(issues, entry.product.feedLabel!)];
  }

  productIds(): string[] {
    return [...this.products.keys()];
  }

  /** Synchronous snapshot of every product (used by the other mock APIs). */
  allProducts(): Product[] {
    return [...this.products.values()].map((p) => p.product);
  }

  static plainId(name: string): string {
    return productIdFromName(name);
  }

  static attributesOf(product: Product): ProductAttributes {
    return product.productAttributes ?? {};
  }
}
