/**
 * Subset of the Merchant API (v1) resource types used by the application.
 * Field names mirror the REST JSON representation exactly.
 * Reference: https://developers.google.com/merchant/api/reference/rest
 */

// ---------------------------------------------------------------- common
export interface Price {
  amountMicros?: string;
  currencyCode?: string;
}

export interface CustomAttribute {
  name?: string;
  value?: string;
  groupValues?: CustomAttribute[];
}

export type Severity = 'SEVERITY_UNSPECIFIED' | 'NOT_IMPACTED' | 'DEMOTED' | 'DISAPPROVED' | 'ERROR' | 'WARNING' | 'INFO' | string;

// ---------------------------------------------------------------- products (products/v1)
export interface ItemLevelIssue {
  code?: string;
  severity?: 'SEVERITY_UNSPECIFIED' | 'NOT_IMPACTED' | 'DEMOTED' | 'DISAPPROVED' | string;
  resolution?: 'RESOLUTION_UNSPECIFIED' | 'MERCHANT_ACTION' | 'PENDING_PROCESSING' | string;
  attribute?: string;
  reportingContext?: string;
  description?: string;
  detail?: string;
  documentation?: string;
  applicableCountries?: string[];
}

export interface DestinationStatus {
  reportingContext?: string;
  approvedCountries?: string[];
  pendingCountries?: string[];
  disapprovedCountries?: string[];
}

export interface ProductStatus {
  destinationStatuses?: DestinationStatus[];
  itemLevelIssues?: ItemLevelIssue[];
  creationDate?: string;
  lastUpdateDate?: string;
  googleExpirationDate?: string;
}

export interface ShippingAttribute {
  country?: string;
  region?: string;
  service?: string;
  price?: Price;
  minHandlingTime?: string;
  maxHandlingTime?: string;
  minTransitTime?: string;
  maxTransitTime?: string;
  postalCode?: string;
  locationId?: string;
  locationGroupName?: string;
}

/**
 * Strongly typed product attributes. Only the commonly used ones are declared
 * explicitly; anything else is still accepted via the index signature.
 */
export interface ProductAttributes {
  title?: string;
  description?: string;
  link?: string;
  mobileLink?: string;
  canonicalLink?: string;
  imageLink?: string;
  additionalImageLinks?: string[];
  lifestyleImageLinks?: string[];
  brand?: string;
  gtins?: string[];
  mpn?: string;
  identifierExists?: boolean;
  condition?: string;
  availability?: string;
  availabilityDate?: string;
  expirationDate?: string;
  price?: Price;
  salePrice?: Price;
  salePriceEffectiveDate?: { startTime?: string; endTime?: string };
  googleProductCategory?: string;
  productTypes?: string[];
  productHighlights?: string[];
  productDetails?: { sectionName?: string; attributeName?: string; attributeValue?: string }[];
  itemGroupId?: string;
  color?: string;
  size?: string;
  sizeSystem?: string;
  sizeTypes?: string[];
  gender?: string;
  ageGroup?: string;
  material?: string;
  pattern?: string;
  multipack?: string;
  isBundle?: boolean;
  adult?: boolean;
  customLabel0?: string;
  customLabel1?: string;
  customLabel2?: string;
  customLabel3?: string;
  customLabel4?: string;
  adsLabels?: string[];
  adsRedirect?: string;
  shipping?: ShippingAttribute[];
  shippingLabel?: string;
  returnPolicyLabel?: string;
  transitTimeLabel?: string;
  shippingWeight?: { value?: number; unit?: string };
  includedDestinations?: string[];
  excludedDestinations?: string[];
  shoppingAdsExcludedCountries?: string[];
  pause?: string;
  [key: string]: unknown;
}

export interface Product {
  name?: string;
  base64EncodedName?: string;
  offerId?: string;
  contentLanguage?: string;
  feedLabel?: string;
  dataSource?: string;
  versionNumber?: string;
  legacyLocal?: boolean;
  archived?: boolean;
  productAttributes?: ProductAttributes;
  customAttributes?: CustomAttribute[];
  productStatus?: ProductStatus;
}

export interface ProductInput {
  name?: string;
  base64EncodedName?: string;
  product?: string;
  offerId?: string;
  contentLanguage?: string;
  feedLabel?: string;
  versionNumber?: string;
  legacyLocal?: boolean;
  productAttributes?: ProductAttributes;
  customAttributes?: CustomAttribute[];
}

export interface ListProductsResponse {
  products?: Product[];
  nextPageToken?: string;
}

// ---------------------------------------------------------------- data sources (datasources/v1)
export interface DataSourceReference {
  self?: boolean;
  primaryDataSourceName?: string;
  supplementalDataSourceName?: string;
}

export interface PrimaryProductDataSource {
  feedLabel?: string;
  contentLanguage?: string;
  countries?: string[];
  legacyLocal?: boolean;
  defaultRule?: { takeFromDataSources?: DataSourceReference[] };
  destinations?: { destination?: string; state?: 'ENABLED' | 'DISABLED' | string }[];
}

export interface SupplementalProductDataSource {
  feedLabel?: string;
  contentLanguage?: string;
  referencingPrimaryDataSources?: DataSourceReference[];
}

export interface FetchSettings {
  enabled?: boolean;
  dayOfMonth?: number;
  timeOfDay?: { hours?: number; minutes?: number; seconds?: number; nanos?: number };
  dayOfWeek?: string;
  timeZone?: string;
  frequency?: 'FREQUENCY_UNSPECIFIED' | 'FREQUENCY_DAILY' | 'FREQUENCY_WEEKLY' | 'FREQUENCY_MONTHLY' | string;
  fetchUri?: string;
  username?: string;
  password?: string;
}

export interface FileInput {
  fetchSettings?: FetchSettings;
  fileName?: string;
  fileInputType?: 'FILE_INPUT_TYPE_UNSPECIFIED' | 'UPLOAD' | 'FETCH' | 'GOOGLE_SHEETS' | string;
}

export interface DataSource {
  name?: string;
  dataSourceId?: string;
  displayName?: string;
  input?: 'INPUT_UNSPECIFIED' | 'API' | 'FILE' | 'UI' | 'AUTOFEED' | string;
  fileInput?: FileInput;
  primaryProductDataSource?: PrimaryProductDataSource;
  supplementalProductDataSource?: SupplementalProductDataSource;
  localInventoryDataSource?: { feedLabel?: string; contentLanguage?: string };
  regionalInventoryDataSource?: { feedLabel?: string; contentLanguage?: string };
  promotionDataSource?: { targetCountry?: string; contentLanguage?: string };
  productReviewDataSource?: Record<string, never>;
  merchantReviewDataSource?: Record<string, never>;
}

export interface ListDataSourcesResponse {
  dataSources?: DataSource[];
  nextPageToken?: string;
}

export interface FileUploadIssue {
  title?: string;
  description?: string;
  code?: string;
  count?: string;
  severity?: 'SEVERITY_UNSPECIFIED' | 'WARNING' | 'ERROR' | string;
  documentationUri?: string;
}

export interface FileUpload {
  name?: string;
  dataSourceId?: string;
  processingState?: 'PROCESSING_STATE_UNSPECIFIED' | 'FAILED' | 'IN_PROGRESS' | 'SUCCEEDED' | string;
  issues?: FileUploadIssue[];
  itemsTotal?: string;
  itemsCreated?: string;
  itemsUpdated?: string;
  uploadTime?: string;
}

// ---------------------------------------------------------------- accounts (accounts/v1)
export interface Account {
  name?: string;
  accountId?: string;
  accountName?: string;
  adultContent?: boolean;
  testAccount?: boolean;
  timeZone?: { id?: string; version?: string };
  languageCode?: string;
}

export interface AccountIssue {
  name?: string;
  title?: string;
  severity?: 'SEVERITY_UNSPECIFIED' | 'CRITICAL' | 'ERROR' | 'SUGGESTION' | string;
  impactedDestinations?: { reportingContext?: string; impacts?: { regionCode?: string; severity?: string }[] }[];
  detail?: string;
  documentationUri?: string;
}

export interface ListAccountIssuesResponse {
  accountIssues?: AccountIssue[];
  nextPageToken?: string;
}

export interface Homepage {
  name?: string;
  uri?: string;
  claimed?: boolean;
}

export interface ShippingService {
  serviceName?: string;
  active?: boolean;
  deliveryCountries?: string[];
  currencyCode?: string;
  deliveryTime?: Record<string, unknown>;
  rateGroups?: Record<string, unknown>[];
  shipmentType?: string;
  minimumOrderValue?: Price;
  [key: string]: unknown;
}

export interface ShippingSettings {
  name?: string;
  services?: ShippingService[];
  warehouses?: Record<string, unknown>[];
  etag?: string;
}

export interface OnlineReturnPolicy {
  name?: string;
  returnPolicyId?: string;
  label?: string;
  countries?: string[];
  policy?: { type?: string; days?: string };
  seasonalOverrides?: Record<string, unknown>[];
  restockingFee?: Record<string, unknown>;
  returnMethods?: string[];
  itemConditions?: string[];
  returnShippingFee?: Record<string, unknown>;
  returnPolicyUri?: string;
  acceptDefectiveOnly?: boolean;
  processRefundDays?: number;
  acceptExchange?: boolean;
  returnLabelSource?: string;
}

export interface ListOnlineReturnPoliciesResponse {
  onlineReturnPolicies?: OnlineReturnPolicy[];
  nextPageToken?: string;
}

// ---------------------------------------------------------------- issue resolution (issueresolution/v1)
export interface RenderedIssue {
  title?: string;
  impact?: {
    message?: string;
    severity?: 'SEVERITY_UNSPECIFIED' | 'ERROR' | 'WARNING' | 'INFO' | string;
    breakdowns?: { regions?: { code?: string; name?: string }[]; details?: string[] }[];
  };
  prerenderedContent?: string;
  prerenderedOutOfCourtDisputeSettlement?: string;
  actions?: {
    buttonLabel?: string;
    isAvailable?: boolean;
    reasons?: { message?: string; detail?: string }[];
    externalAction?: { type?: string; uri?: string };
    builtinSimpleAction?: { type?: string; attributeCode?: string };
    builtinUserInputAction?: Record<string, unknown>;
  }[];
}

export interface RenderIssuesResponse {
  renderedIssues?: RenderedIssue[];
}

export interface AggregateProductStatus {
  name?: string;
  reportingContext?: string;
  country?: string;
  stats?: { activeCount?: string; pendingCount?: string; disapprovedCount?: string; expiringCount?: string };
  itemLevelIssues?: {
    code?: string;
    severity?: string;
    resolution?: string;
    attribute?: string;
    description?: string;
    detail?: string;
    documentationUri?: string;
    productCount?: string;
  }[];
}

export interface ListAggregateProductStatusesResponse {
  aggregateProductStatuses?: AggregateProductStatus[];
  nextPageToken?: string;
}

// ---------------------------------------------------------------- notifications (notifications/v1)
export interface NotificationSubscription {
  name?: string;
  allManagedAccounts?: boolean;
  targetAccount?: string;
  registeredEvent?: 'REGISTERED_EVENT_UNSPECIFIED' | 'PRODUCT_STATUS_CHANGE' | string;
  callBackUri?: string;
}

export interface ListNotificationSubscriptionsResponse {
  notificationSubscriptions?: NotificationSubscription[];
  nextPageToken?: string;
}

/** Payload Google POSTs to the callback URI for PRODUCT_STATUS_CHANGE. */
export interface ProductStatusChangeMessage {
  account?: string;
  managingAccount?: string;
  resourceType?: string;
  attribute?: string;
  changes?: { oldValue?: string; newValue?: string; regionCode?: string; reportingContext?: string }[];
  resourceId?: string;
  resource?: string;
  eventTime?: string;
  expirationTime?: string;
}

export interface DeveloperRegistration {
  name?: string;
  gcpIds?: string[];
}

// ---------------------------------------------------------------- quota (quota/v1)
export interface QuotaGroup {
  name?: string;
  quotaUsage?: string;
  quotaLimit?: string;
  quotaMinuteLimit?: string;
  methodDetails?: { method?: string; version?: string; subapi?: string; path?: string }[];
}

export interface ListQuotaGroupsResponse {
  quotaGroups?: QuotaGroup[];
  nextPageToken?: string;
}

// ---------------------------------------------------------------- reports (reports/v1)
/** `google.type.Date` as returned by the reports API (the Content API used plain strings). */
export type ReportDate = string | { year?: number; month?: number; day?: number };

/** `product_performance_view` */
export interface ProductPerformanceView {
  date?: ReportDate;
  week?: ReportDate;
  offerId?: string;
  title?: string;
  brand?: string;
  categoryL1?: string;
  productTypeL1?: string;
  customLabel0?: string;
  marketingMethod?: 'ADS' | 'ORGANIC' | string;
  customerCountryCode?: string;
  impressions?: string | number;
  clicks?: string | number;
  clickThroughRate?: number;
  conversions?: number;
  conversionValue?: Price;
  conversionRate?: number;
}

/** `price_competitiveness_product_view` (Market Insights) */
export interface PriceCompetitivenessProductView {
  id?: string;
  offerId?: string;
  title?: string;
  brand?: string;
  categoryL1?: string;
  productTypeL1?: string;
  price?: Price;
  benchmarkPrice?: Price;
  reportCountryCode?: string;
}

/** `price_insights_product_view` (Market Insights) */
export interface PriceInsightsProductView {
  id?: string;
  offerId?: string;
  title?: string;
  brand?: string;
  price?: Price;
  suggestedPrice?: Price;
  predictedImpressionsChangeFraction?: number;
  predictedClicksChangeFraction?: number;
  predictedConversionsChangeFraction?: number;
  effectiveness?: 'LOW' | 'MEDIUM' | 'HIGH' | string;
}

/** `best_sellers_product_cluster_view` (Market Insights) */
export interface BestSellersProductClusterView {
  reportDate?: ReportDate;
  reportGranularity?: 'WEEKLY' | 'MONTHLY' | string;
  reportCountryCode?: string;
  reportCategoryId?: string | number;
  title?: string;
  brand?: string;
  categoryL1?: string;
  categoryL2?: string;
  variantGtins?: string[];
  inventoryStatus?: 'IN_STOCK' | 'OUT_OF_STOCK' | 'NOT_IN_INVENTORY' | string;
  brandInventoryStatus?: string;
  rank?: string | number;
  previousRank?: string | number;
  relativeDemand?: string;
  previousRelativeDemand?: string;
  relativeDemandChange?: 'RISER' | 'FLAT' | 'SINKER' | string;
}

/** `competitive_visibility_competitor_view` (Market Insights) */
export interface CompetitiveVisibilityCompetitorView {
  date?: ReportDate;
  domain?: string;
  isYourDomain?: boolean;
  reportCountryCode?: string;
  reportCategoryId?: string | number;
  trafficSource?: 'ADS' | 'ORGANIC' | 'ALL' | string;
  rank?: string | number;
  adsOrganicRatio?: number;
  pageOverlapRate?: number;
  higherPositionRate?: number;
  relativeVisibility?: number;
}

export interface ReportRow {
  productPerformanceView?: ProductPerformanceView;
  priceCompetitivenessProductView?: PriceCompetitivenessProductView;
  priceInsightsProductView?: PriceInsightsProductView;
  bestSellersProductClusterView?: BestSellersProductClusterView;
  competitiveVisibilityCompetitorView?: CompetitiveVisibilityCompetitorView;
  [key: string]: unknown;
}

export interface SearchReportResponse {
  results?: ReportRow[];
  nextPageToken?: string;
}
