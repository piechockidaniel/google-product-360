/** Types of API responses (mirror of the server side models). */

export interface User {
  id: number;
  username: string;
  email: string | null;
  googleSub: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  previousLoginAt: string | null;
}

export type AggregatedStatus = 'APPROVED' | 'PARTIALLY_APPROVED' | 'DISAPPROVED' | 'PENDING' | 'NOT_ELIGIBLE' | 'UNKNOWN';
export type IssueLevel = 'error' | 'warning' | 'info';

export interface ProductRecord {
  name: string;
  productId: string;
  offerId: string;
  contentLanguage: string | null;
  feedLabel: string | null;
  title: string | null;
  brand: string | null;
  link: string | null;
  imageLink: string | null;
  price: { amountMicros: string; currencyCode: string } | null;
  availability: string | null;
  dataSource: string | null;
  aggregatedStatus: AggregatedStatus;
  issueCount: number;
  maxSeverity: IssueLevel | null;
  category: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  deletedAt: string | null;
  /** Product360 summary; null until metrics have been synced. */
  signal: ProductSignalSummary | null;
}

// ---------------------------------------------------------------- Product360
export type Recommendation = 'SCALE' | 'FIX' | 'REPRICE' | 'OPTIMISE_LISTING' | 'WATCH' | 'PAUSE' | 'KEEP' | 'NO_DATA';
export const RECOMMENDATIONS: Recommendation[] = ['SCALE', 'FIX', 'REPRICE', 'OPTIMISE_LISTING', 'WATCH', 'PAUSE', 'KEEP', 'NO_DATA'];

export interface ProductSignalSummary {
  recommendation: Recommendation;
  clicks7d: number;
  impressions7d: number;
  clicksPrev7d: number;
  ctr28d: number | null;
  priceVsBenchmark: number | null;
  demand: string | null;
  scImpressions28d: number;
  scPosition28d: number | null;
  scores: Record<string, number | null>;
  computedAt: string;
}

export interface SignalReason {
  code: string;
  params?: Record<string, string | number | null>;
}

export interface ProductSignal {
  productName: string;
  computedAt: string;
  windows: { end: string; w7: [string, string]; p7: [string, string]; w28: [string, string] };
  metrics: {
    impressions7d: number;
    clicks7d: number;
    impressionsPrev7d: number;
    clicksPrev7d: number;
    impressions28d: number;
    clicks28d: number;
    conversions28d: number;
    conversionValueMicros28d: number;
    ctr28d: number | null;
    categoryMedianCtr: number | null;
    clicksChangePct: number | null;
    scImpressions28d: number;
    scClicks28d: number;
    scImpressionsPrev28d: number;
    scPosition28d: number | null;
    scImpressionsChangePct: number | null;
  };
  market: {
    priceVsBenchmark: number | null;
    benchmarkPriceMicros: number | null;
    suggestedPriceMicros: number | null;
    effectiveness: string | null;
    demand: string | null;
    demandChange: string | null;
    bestSellerRank: number | null;
  };
  scores: { demand: number; visibility: number; price: number | null; efficiency: number | null; health: number };
  recommendation: Recommendation;
  previousRecommendation: Recommendation | null;
  reasons: SignalReason[];
}

export interface DailyPoint {
  date: string;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValueMicros: number;
}

export interface PerformanceTotals {
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValueMicros: number;
  ctr: number | null;
}

export interface PriceBenchmark {
  productName: string;
  date: string;
  country: string;
  priceMicros: number | null;
  benchmarkPriceMicros: number | null;
  currency: string | null;
  suggestedPriceMicros: number | null;
  predictedImpressionsChange: number | null;
  predictedClicksChange: number | null;
  predictedConversionsChange: number | null;
  effectiveness: string | null;
}

export interface BestSeller {
  reportDate: string;
  granularity: string;
  country: string;
  categoryId: string;
  clusterKey: string;
  title: string | null;
  brand: string | null;
  category: string | null;
  gtins: string[];
  rank: number | null;
  previousRank: number | null;
  relativeDemand: string | null;
  previousRelativeDemand: string | null;
  demandChange: string | null;
  inventoryStatus: string | null;
  productName: string | null;
  productId?: string | null;
  offerId?: string | null;
}

export interface Competitor {
  country: string;
  categoryId: string;
  trafficSource: string;
  domain: string;
  isYourDomain: boolean;
  days: number;
  avgRank: number | null;
  relativeVisibility: number | null;
  pageOverlapRate: number | null;
  higherPositionRate: number | null;
  adsOrganicRatio: number | null;
}

export interface SearchPoint {
  date: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

export interface SearchTotals {
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface SearchQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface SearchQueriesResponse {
  enabled: boolean;
  canonicalUrl: string | null;
  rows: SearchQuery[];
  window: { from: string; to: string } | null;
  fetchedAt: string | null;
}

export interface Product360 {
  product: ProductDetails;
  signal: ProductSignal | null;
  performance: { from: string; to: string; series: { method: string; points: DailyPoint[] }[]; totals: PerformanceTotals; previousTotals: PerformanceTotals | null };
  price: { latest: PriceBenchmark | null; series: PriceBenchmark[] };
  bestSellers: BestSeller[];
  competitors: Competitor[];
  search: {
    enabled: boolean;
    mapping: { productName: string; canonicalUrl: string; shared: boolean } | null;
    series: { appearance: string; points: SearchPoint[] }[];
    totals: SearchTotals;
    previousTotals: SearchTotals | null;
  };
  freshness: { performanceThrough: string | null; bestSellersThrough: string | null; visibilityThrough: string | null; searchThrough: string | null };
}

export interface MetricsSyncRun {
  id: number;
  connector: string;
  status: 'running' | 'success' | 'failed';
  windowFrom: string | null;
  windowTo: string | null;
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, unknown>;
  error: string | null;
}

export interface ConnectorStatus {
  id: string;
  configured: boolean;
  lastRun: MetricsSyncRun | null;
  lastSuccessfulRun: MetricsSyncRun | null;
  nextWindow: { from: string; to: string } | null;
}

export interface MetricsStatus {
  enabled: boolean;
  running: boolean;
  connectors: ConnectorStatus[];
  signals: { computed: boolean; windowEnd: string | null };
  nextRunAt: string | null;
  settings: { cron: string; backfillDays: number; retentionDays: number; thresholds: { minImpressions: number; priceAboveBenchmarkPct: number; clickDropPct: number } };
  runs: MetricsSyncRun[];
  freshness: { performanceThrough: string | null; bestSellersThrough: string | null; visibilityThrough: string | null; searchThrough: string | null };
  searchConsole: {
    enabled: boolean;
    siteUrl: string;
    countryFilter: string;
    merchantListings: boolean;
    dataState: 'all' | 'final';
    urlMap: { mappedProducts: number; sharedProducts: number; distinctUrls: number };
  };
}

export interface SearchConsoleSite {
  siteUrl: string;
  permissionLevel: string;
}

export interface UrlMappingDiagnostics {
  mapped: number;
  shared: number;
  total: number;
  outsideSite: number;
  stats: { mappedProducts: number; sharedProducts: number; distinctUrls: number };
  unmappedProducts: { productId: string; offerId: string; title: string | null; link: string | null }[];
  unmappedPages: { canonicalUrl: string; clicks: number; impressions: number }[];
  window: { from: string; to: string };
}

export interface ConnectionCheck {
  ok: boolean;
  capabilities: { id: string; available: boolean; message?: string }[];
  hint?: string;
  error?: string;
}

export interface DashboardInsights {
  enabled: boolean;
  computed: boolean;
  windowEnd: string | null;
  totals: { current: PerformanceTotals & { products: number }; previous: PerformanceTotals & { products: number }; window: { from: string; to: string } };
  series: { method: string; points: DailyPoint[] }[];
  recommendationCounts: Record<string, number>;
  organic: { current: SearchTotals & { pages: number }; previous: SearchTotals & { pages: number }; through: string | null } | null;
  optimise: ProductRecord[];
  focus: ProductRecord[];
  fix: ProductRecord[];
  priceOpportunities: ProductRecord[];
  watch: ProductRecord[];
  trendingNotCarried: BestSeller[];
  connectors: ConnectorStatus[];
}

export interface ProductIssue {
  id: number;
  fingerprint: string;
  productName: string;
  productId: string;
  code: string;
  severity: string | null;
  level: IssueLevel;
  attribute: string | null;
  description: string | null;
  detail: string | null;
  documentation: string | null;
  reportingContext: string | null;
  resolution: string | null;
  applicableCountries: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  offerId?: string;
  title?: string | null;
}

export interface ProductMetadata {
  productName: string;
  tags: string[];
  notes: string;
  fields: Record<string, string>;
  pushedAttributes: Record<string, unknown>;
  pushStatus: 'pending' | 'pushed' | 'error' | null;
  pushError: string | null;
  pushedAt: string | null;
  updatedAt: string | null;
}

export interface CustomAttribute {
  name?: string;
  value?: string;
}

export interface RawProduct {
  name?: string;
  offerId?: string;
  contentLanguage?: string;
  feedLabel?: string;
  dataSource?: string;
  productAttributes?: Record<string, unknown>;
  customAttributes?: CustomAttribute[];
  productStatus?: {
    creationDate?: string;
    lastUpdateDate?: string;
    googleExpirationDate?: string;
    destinationStatuses?: { reportingContext?: string; approvedCountries?: string[]; pendingCountries?: string[]; disapprovedCountries?: string[] }[];
    itemLevelIssues?: unknown[];
  };
}

export interface ProductDetails extends ProductRecord {
  product: RawProduct;
  issues: ProductIssue[];
  metadata: ProductMetadata;
}

export interface RemediationProposal {
  issueCode: string;
  attribute: string;
  proposedValue: string;
  evidence: string;
  consequence: string;
  remediation: string;
}

export interface RemediationEvent {
  id: number;
  operationId: string;
  type: string;
  message: string;
  createdAt: string;
}

export interface RemediationOperation {
  id: string;
  productName: string;
  issueCode: string;
  attribute: string;
  proposedValue: string;
  status: 'queued' | 'running' | 'pending_google' | 'succeeded' | 'failed';
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deadlineAt: string;
  resultMessage: string | null;
  events: RemediationEvent[];
}

export interface AccountIssue {
  id: number;
  title: string | null;
  severity: string | null;
  level: IssueLevel;
  detail: string | null;
  documentationUri: string | null;
  impacted: { reportingContext?: string; impacts?: { regionCode?: string; severity?: string }[] }[];
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  isNew?: boolean;
}

export interface RenderedIssue {
  title?: string;
  impact?: { message?: string; severity?: string; breakdowns?: { regions?: { code?: string; name?: string }[]; details?: string[] }[] };
  prerenderedContent?: string;
  actions?: { buttonLabel?: string; isAvailable?: boolean; externalAction?: { type?: string; uri?: string }; reasons?: { message?: string }[] }[];
}

export interface AppEvent {
  id: number;
  type: string;
  severity: IssueLevel;
  message: string;
  payload: unknown;
  productName: string | null;
  createdAt: string;
}

export interface SyncRun {
  id: number;
  kind: string;
  status: 'running' | 'success' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, number>;
  error: string | null;
}

export interface FileUpload {
  processingState?: string;
  itemsTotal?: string;
  itemsCreated?: string;
  itemsUpdated?: string;
  uploadTime?: string;
  issues?: { title?: string; description?: string; code?: string; count?: string; severity?: string; documentationUri?: string }[];
}

export interface Feed {
  id: string;
  name: string;
  displayName: string;
  kind: string;
  input: string;
  fileInputType: string | null;
  fileName: string | null;
  fetchUri: string | null;
  fetchEnabled: boolean | null;
  fetchSchedule: string | null;
  feedLabel: string | null;
  contentLanguage: string | null;
  countries: string[];
  linkedSupplementalSources: string[];
  productCount: number;
  lastUpload: FileUpload | null;
  health: 'ok' | 'warning' | 'error' | 'unknown';
  raw?: unknown;
}

export interface AggregateProductStatus {
  reportingContext?: string;
  country?: string;
  stats?: { activeCount?: string; pendingCount?: string; disapprovedCount?: string; expiringCount?: string };
  itemLevelIssues?: { code?: string; severity?: string; description?: string; productCount?: string; documentationUri?: string; attribute?: string }[];
}

export interface Flag {
  level: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
  params?: Record<string, string | number>;
  documentationUri?: string;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  workflowName?: string;
  trigger: string;
  status: 'running' | 'success' | 'failed' | 'stopped';
  startedAt: string;
  finishedAt: string | null;
  log: { time: string; level: IssueLevel; step?: number; stepType?: string; message: string; data?: unknown }[];
  stats: Record<string, number>;
  error: string | null;
}

export interface Dashboard {
  since: string;
  user: User;
  health: 'ok' | 'warning' | 'error';
  flags: Flag[];
  account: { accountId?: string; accountName?: string; testAccount?: boolean; timeZone?: { id?: string }; languageCode?: string } | null;
  homepage: { uri?: string; claimed?: boolean } | null;
  accountIssues: AccountIssue[];
  aggregateStatuses: AggregateProductStatus[];
  productStats: { total: number; byStatus: Record<string, number>; withErrors: number; withWarnings: number; deleted: number };
  feeds: Feed[];
  lastSync: SyncRun | null;
  syncRunning: boolean;
  insights: DashboardInsights;
  sinceLastLogin: {
    newIssues: ProductIssue[];
    newIssueCount: number;
    resolvedIssues: ProductIssue[];
    resolvedIssueCount: number;
    newAccountIssues: AccountIssue[];
    statusChanges: AppEvent[];
    notifications: AppEvent[];
    warningsAndErrors: AppEvent[];
    workflowRuns: WorkflowRun[];
    signalChanges: (AppEvent & { productId: string | null; offerId: string | null })[];
    signalChangeCount: number;
  };
  issueSummary: IssueSummaryRow[];
}

export interface IssueSummaryRow {
  code: string;
  severity: string | null;
  level: IssueLevel;
  description: string | null;
  attribute: string | null;
  count: number;
  newCount: number;
}

export type Trigger =
  | { type: 'manual' }
  | { type: 'schedule'; cron: string; timezone?: string }
  | { type: 'event'; event: string; debounceSeconds?: number };

export interface WorkflowStep {
  type: string;
  [key: string]: unknown;
}

export interface Workflow {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  trigger: Trigger;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt?: string | null;
  running?: boolean;
}

export interface WorkflowCatalog {
  steps: { type: string; label: string; description: string; example: Record<string, unknown> }[];
  operators: string[];
  templates: { id: string; title: string; description: string; definition: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt'> }[];
  events: string[];
  fields: string[];
  recommendations: Recommendation[];
}

export interface AttributeDefinition {
  name: string;
  type: 'string' | 'string[]' | 'boolean' | 'number' | 'price' | 'json';
  label: string;
  group: string;
  enum?: string[];
  help?: string;
}

export interface Facets {
  brands: string[];
  feedLabels: string[];
  dataSources: string[];
  availability: string[];
  tags: { tag: string; count: number }[];
  issueCodes: IssueSummaryRow[];
  attributeCatalog: AttributeDefinition[];
  categories: string[];
  recommendations: Record<string, number>;
  signalsComputed: boolean;
  searchConsoleEnabled: boolean;
}

export interface Subscription {
  id: string;
  name: string;
  registeredEvent: string;
  callBackUri: string;
  targetAccount: string | null;
  allManagedAccounts: boolean;
  ownedByThisApp: boolean;
}

export interface Settings {
  accountId: string;
  mock: boolean;
  configured: boolean;
  apiBaseUrl: string;
  apiVersion: string;
  publicUrl: string | null;
  webhookUrl: string | null;
  syncIntervalMinutes: number;
  enrichmentDataSourceName: string;
  languageCode: string;
  timeZone: string;
  users: User[];
}

export interface ReturnPolicy {
  name?: string;
  returnPolicyId?: string;
  label?: string;
  countries?: string[];
  policy?: { type?: string; days?: string };
  returnMethods?: string[];
  itemConditions?: string[];
  returnPolicyUri?: string;
  processRefundDays?: number;
  acceptExchange?: boolean;
  acceptDefectiveOnly?: boolean;
  [key: string]: unknown;
}

export interface ShippingSettings {
  services?: { serviceName?: string; active?: boolean; deliveryCountries?: string[]; currencyCode?: string; shipmentType?: string; deliveryTime?: Record<string, unknown>; rateGroups?: unknown[] }[];
  warehouses?: unknown[];
}

export interface SetupStatus {
  needsAdmin: boolean;
  configured: boolean;
  setupCompleted: boolean;
  mock: boolean;
  googleOAuthConfigured?: boolean;
  localLoginEnabled?: boolean;
  /** Self-contained demo on synthetic data (DEMO_MODE). */
  demo?: boolean;
}

export interface PublicSettings {
  mock: boolean;
  merchantAccountId: string;
  apiBaseUrl: string;
  apiVersion: string;
  languageCode: string;
  timeZone: string;
  enrichmentDataSourceName: string;
  enrichmentPriority: 'override' | 'fallback';
  syncIntervalMinutes: number;
  syncOnStartup: boolean;
  apiConcurrency: number;
  publicUrl: string | null;
  webhookSecret: string;
  setupCompletedAt: string | null;
  metricsEnabled: boolean;
  metricsSyncCron: string;
  metricsBackfillDays: number;
  metricsRetentionDays: number;
  signalMinImpressions: number;
  signalPriceAbovePct: number;
  signalClickDropPct: number;
  searchConsoleEnabled: boolean;
  searchConsoleSiteUrl: string;
  searchConsoleCountryFilter: string;
  searchConsoleMerchantListings: boolean;
  searchConsoleDataState: 'all' | 'final';
  serviceAccount: { clientEmail: string; projectId: string | null; privateKeyId: string | null } | null;
  configured: boolean;
  fromEnvironment: string[];
}

export interface ConnectionTestResult {
  ok: boolean;
  account?: { accountId?: string; accountName?: string; testAccount?: boolean; timeZone?: { id?: string }; languageCode?: string };
  dataSources?: number;
  hasProducts?: boolean;
  warnings?: string[];
  durationMs?: number;
  error?: string;
  status?: number;
  hint?: string;
  hintCode?: string | null;
  needsRegistration?: boolean;
}
