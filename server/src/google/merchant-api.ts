import type {
  Account,
  AccountIssue,
  AggregateProductStatus,
  DataSource,
  FileUpload,
  Homepage,
  ListAccountIssuesResponse,
  ListAggregateProductStatusesResponse,
  ListDataSourcesResponse,
  ListNotificationSubscriptionsResponse,
  ListOnlineReturnPoliciesResponse,
  ListProductsResponse,
  NotificationSubscription,
  OnlineReturnPolicy,
  Product,
  ProductInput,
  RenderIssuesResponse,
  RenderedIssue,
  ReportRow,
  SearchReportResponse,
  ShippingSettings,
  QuotaGroup,
  ListQuotaGroupsResponse,
  DeveloperRegistration,
} from './types.js';
import { RestClient, collectAll, paginate } from './rest-client.js';

/**
 * Encodes the `{product}` segment (content_language~feed_label~offer_id) as
 * unpadded base64url, which the API accepts for any product id (even those
 * containing `/`, `%` or `~`).
 */
export function encodeProductId(plainId: string): string {
  return Buffer.from(plainId, 'utf8').toString('base64url');
}

export function decodeProductId(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

/** `accounts/123/products/en~PL~sku1` -> `en~PL~sku1` */
export function productIdFromName(name: string): string {
  return name.split('/products/')[1] ?? name;
}

export function buildProductId(contentLanguage: string, feedLabel: string, offerId: string, legacyLocal = false): string {
  return `${legacyLocal ? 'local~' : ''}${contentLanguage}~${feedLabel}~${offerId}`;
}

/** Resource-id helpers: `accounts/1/dataSources/22` -> `22`. */
export function lastSegment(name: string): string {
  return name.split('/').pop() ?? name;
}

/**
 * Every Merchant API operation the application needs. Implemented by the real
 * REST client and by the in-memory mock, so services never depend on HTTP.
 */
export interface MerchantApi {
  readonly accountId: string;
  readonly accountName: string; // accounts/{id}

  // ---- accounts
  getAccount(): Promise<Account>;
  listAccountIssues(): Promise<AccountIssue[]>;
  getHomepage(): Promise<Homepage | undefined>;
  getShippingSettings(): Promise<ShippingSettings | undefined>;
  listReturnPolicies(): Promise<OnlineReturnPolicy[]>;
  createReturnPolicy(policy: OnlineReturnPolicy): Promise<OnlineReturnPolicy>;
  updateReturnPolicy(returnPolicyId: string, policy: OnlineReturnPolicy, updateMask?: string): Promise<OnlineReturnPolicy>;
  deleteReturnPolicy(returnPolicyId: string): Promise<void>;

  // ---- products
  listProductPages(pageSize?: number): AsyncGenerator<Product[], void, undefined>;
  listAllProducts(): Promise<Product[]>;
  getProduct(productId: string): Promise<Product>;
  insertProductInput(dataSourceName: string, input: ProductInput): Promise<ProductInput>;
  patchProductInput(dataSourceName: string, productInputId: string, input: ProductInput, updateMask?: string): Promise<ProductInput>;
  deleteProductInput(dataSourceName: string, productInputId: string): Promise<void>;

  // ---- data sources (feeds)
  listDataSources(): Promise<DataSource[]>;
  getDataSource(dataSourceId: string): Promise<DataSource>;
  createDataSource(dataSource: DataSource): Promise<DataSource>;
  updateDataSource(dataSourceId: string, dataSource: DataSource, updateMask: string): Promise<DataSource>;
  deleteDataSource(dataSourceId: string): Promise<void>;
  fetchDataSource(dataSourceId: string): Promise<void>;
  getLatestFileUpload(dataSourceId: string): Promise<FileUpload | undefined>;

  // ---- issue resolution
  renderAccountIssues(languageCode?: string, timeZone?: string): Promise<RenderedIssue[]>;
  renderProductIssues(productId: string, languageCode?: string, timeZone?: string): Promise<RenderedIssue[]>;
  listAggregateProductStatuses(filter?: string): Promise<AggregateProductStatus[]>;

  // ---- notifications
  listNotificationSubscriptions(): Promise<NotificationSubscription[]>;
  createNotificationSubscription(subscription: NotificationSubscription): Promise<NotificationSubscription>;
  deleteNotificationSubscription(subscriptionId: string): Promise<void>;

  // ---- reports
  /** Merchant Center Query Language search (`reports:search`); always resolves to an array. */
  searchReport(query: string, pageSize?: number): Promise<ReportRow[]>;

  // ---- quota
  listQuotas(): Promise<QuotaGroup[]>;

  // ---- developer registration (one-time: links the GCP project of the credentials to the account)
  getDeveloperRegistration(): Promise<DeveloperRegistration | undefined>;
  registerGcp(developerEmail: string): Promise<DeveloperRegistration>;
}

export interface MerchantApiClientOptions {
  accountId: string;
  /** e.g. `v1` */
  version?: string;
}

/** REST implementation of {@link MerchantApi} against the Merchant API (v1). */
export class MerchantApiClient implements MerchantApi {
  readonly accountId: string;
  readonly accountName: string;
  private readonly v: string;

  constructor(
    private readonly http: RestClient,
    options: MerchantApiClientOptions,
  ) {
    this.accountId = options.accountId;
    this.accountName = `accounts/${options.accountId}`;
    this.v = options.version ?? 'v1';
  }

  // ---- accounts -----------------------------------------------------------
  getAccount(): Promise<Account> {
    return this.http.get<Account>(`accounts/${this.v}/${this.accountName}`);
  }

  listAccountIssues(): Promise<AccountIssue[]> {
    return collectAll(
      (pageToken) =>
        this.http.get<ListAccountIssuesResponse>(`accounts/${this.v}/${this.accountName}/issues`, {
          query: { pageSize: 100, pageToken },
        }),
      (r) => r.accountIssues,
    );
  }

  async getHomepage(): Promise<Homepage | undefined> {
    return this.optional(this.http.get<Homepage>(`accounts/${this.v}/${this.accountName}/homepage`));
  }

  async getShippingSettings(): Promise<ShippingSettings | undefined> {
    return this.optional(this.http.get<ShippingSettings>(`accounts/${this.v}/${this.accountName}/shippingSettings`));
  }

  listReturnPolicies(): Promise<OnlineReturnPolicy[]> {
    return collectAll(
      (pageToken) =>
        this.http.get<ListOnlineReturnPoliciesResponse>(`accounts/${this.v}/${this.accountName}/onlineReturnPolicies`, {
          query: { pageSize: 100, pageToken },
        }),
      (r) => r.onlineReturnPolicies,
    );
  }

  createReturnPolicy(policy: OnlineReturnPolicy): Promise<OnlineReturnPolicy> {
    return this.http.post<OnlineReturnPolicy>(`accounts/${this.v}/${this.accountName}/onlineReturnPolicies`, { body: policy });
  }

  updateReturnPolicy(returnPolicyId: string, policy: OnlineReturnPolicy, updateMask = '*'): Promise<OnlineReturnPolicy> {
    return this.http.patch<OnlineReturnPolicy>(`accounts/${this.v}/${this.accountName}/onlineReturnPolicies/${returnPolicyId}`, {
      body: policy,
      query: { updateMask },
    });
  }

  async deleteReturnPolicy(returnPolicyId: string): Promise<void> {
    await this.http.delete(`accounts/${this.v}/${this.accountName}/onlineReturnPolicies/${returnPolicyId}`);
  }

  // ---- products -----------------------------------------------------------
  listProductPages(pageSize = 1000): AsyncGenerator<Product[], void, undefined> {
    return paginate(
      (pageToken) =>
        this.http.get<ListProductsResponse>(`products/${this.v}/${this.accountName}/products`, {
          query: { pageSize, pageToken },
        }),
      (r) => r.products,
    );
  }

  async listAllProducts(): Promise<Product[]> {
    const all: Product[] = [];
    for await (const page of this.listProductPages()) all.push(...page);
    return all;
  }

  getProduct(productId: string): Promise<Product> {
    return this.http.get<Product>(`products/${this.v}/${this.accountName}/products/${encodeURIComponent(productId)}`);
  }

  insertProductInput(dataSourceName: string, input: ProductInput): Promise<ProductInput> {
    return this.http.post<ProductInput>(`products/${this.v}/${this.accountName}/productInputs:insert`, {
      body: input,
      query: { dataSource: dataSourceName },
    });
  }

  patchProductInput(dataSourceName: string, productInputId: string, input: ProductInput, updateMask?: string): Promise<ProductInput> {
    return this.http.patch<ProductInput>(`products/${this.v}/${this.accountName}/productInputs/${encodeURIComponent(productInputId)}`, {
      body: input,
      query: { dataSource: dataSourceName, updateMask },
    });
  }

  async deleteProductInput(dataSourceName: string, productInputId: string): Promise<void> {
    await this.http.delete(`products/${this.v}/${this.accountName}/productInputs/${encodeURIComponent(productInputId)}`, {
      query: { dataSource: dataSourceName },
    });
  }

  // ---- data sources -------------------------------------------------------
  listDataSources(): Promise<DataSource[]> {
    return collectAll(
      (pageToken) =>
        this.http.get<ListDataSourcesResponse>(`datasources/${this.v}/${this.accountName}/dataSources`, {
          query: { pageSize: 100, pageToken },
        }),
      (r) => r.dataSources,
    );
  }

  getDataSource(dataSourceId: string): Promise<DataSource> {
    return this.http.get<DataSource>(`datasources/${this.v}/${this.accountName}/dataSources/${dataSourceId}`);
  }

  createDataSource(dataSource: DataSource): Promise<DataSource> {
    return this.http.post<DataSource>(`datasources/${this.v}/${this.accountName}/dataSources`, { body: dataSource });
  }

  updateDataSource(dataSourceId: string, dataSource: DataSource, updateMask: string): Promise<DataSource> {
    return this.http.patch<DataSource>(`datasources/${this.v}/${this.accountName}/dataSources/${dataSourceId}`, {
      body: dataSource,
      query: { updateMask },
    });
  }

  async deleteDataSource(dataSourceId: string): Promise<void> {
    await this.http.delete(`datasources/${this.v}/${this.accountName}/dataSources/${dataSourceId}`);
  }

  async fetchDataSource(dataSourceId: string): Promise<void> {
    await this.http.post(`datasources/${this.v}/${this.accountName}/dataSources/${dataSourceId}:fetch`, { body: {} });
  }

  getLatestFileUpload(dataSourceId: string): Promise<FileUpload | undefined> {
    return this.optional(
      this.http.get<FileUpload>(`datasources/${this.v}/${this.accountName}/dataSources/${dataSourceId}/fileUploads/latest`),
    );
  }

  // ---- issue resolution ---------------------------------------------------
  async renderAccountIssues(languageCode?: string, timeZone?: string): Promise<RenderedIssue[]> {
    const r = await this.http.post<RenderIssuesResponse>(`issueresolution/${this.v}/${this.accountName}:renderaccountissues`, {
      body: { contentOption: 'PRE_RENDERED_HTML', userInputActionOption: 'REDIRECT_TO_MERCHANT_CENTER' },
      query: { languageCode, timeZone },
    });
    return r.renderedIssues ?? [];
  }

  async renderProductIssues(productId: string, languageCode?: string, timeZone?: string): Promise<RenderedIssue[]> {
    const r = await this.http.post<RenderIssuesResponse>(
      `issueresolution/${this.v}/${this.accountName}/products/${encodeURIComponent(productId)}:renderproductissues`,
      {
        body: { contentOption: 'PRE_RENDERED_HTML', userInputActionOption: 'REDIRECT_TO_MERCHANT_CENTER' },
        query: { languageCode, timeZone },
      },
    );
    return r.renderedIssues ?? [];
  }

  listAggregateProductStatuses(filter?: string): Promise<AggregateProductStatus[]> {
    return collectAll(
      (pageToken) =>
        this.http.get<ListAggregateProductStatusesResponse>(
          `issueresolution/${this.v}/${this.accountName}/aggregateProductStatuses`,
          { query: { pageSize: 100, pageToken, filter } },
        ),
      (r) => r.aggregateProductStatuses,
    );
  }

  // ---- notifications ------------------------------------------------------
  listNotificationSubscriptions(): Promise<NotificationSubscription[]> {
    return collectAll(
      (pageToken) =>
        this.http.get<ListNotificationSubscriptionsResponse>(
          `notifications/${this.v}/${this.accountName}/notificationsubscriptions`,
          { query: { pageSize: 100, pageToken } },
        ),
      (r) => r.notificationSubscriptions,
    );
  }

  createNotificationSubscription(subscription: NotificationSubscription): Promise<NotificationSubscription> {
    return this.http.post<NotificationSubscription>(`notifications/${this.v}/${this.accountName}/notificationsubscriptions`, {
      body: subscription,
    });
  }

  async deleteNotificationSubscription(subscriptionId: string): Promise<void> {
    await this.http.delete(`notifications/${this.v}/${this.accountName}/notificationsubscriptions/${subscriptionId}`);
  }

  // ---- reports ------------------------------------------------------------
  async searchReport(query: string, pageSize = 1000): Promise<ReportRow[]> {
    return collectAll(
      (pageToken) =>
        this.http.post<SearchReportResponse>(`reports/${this.v}/${this.accountName}/reports:search`, {
          body: { query, pageSize, pageToken },
        }),
      (r) => r.results,
    );
  }

  // ---- quota --------------------------------------------------------------
  listQuotas(): Promise<QuotaGroup[]> {
    return collectAll(
      (pageToken) => this.http.get<ListQuotaGroupsResponse>(`quota/${this.v}/${this.accountName}/quotas`, { query: { pageSize: 100, pageToken } }),
      (r) => r.quotaGroups,
    );
  }

  // ---- developer registration ---------------------------------------------
  getDeveloperRegistration(): Promise<DeveloperRegistration | undefined> {
    return this.optional(this.http.get<DeveloperRegistration>(`accounts/${this.v}/${this.accountName}/developerRegistration`));
  }

  registerGcp(developerEmail: string): Promise<DeveloperRegistration> {
    return this.http.post<DeveloperRegistration>(`accounts/${this.v}/${this.accountName}/developerRegistration:registerGcp`, {
      body: { developerEmail },
    });
  }

  // ---- helpers ------------------------------------------------------------
  private async optional<T>(promise: Promise<T>): Promise<T | undefined> {
    try {
      return await promise;
    } catch (err) {
      if (err instanceof Error && 'status' in err && (err as { status: number }).status === 404) return undefined;
      throw err;
    }
  }
}
