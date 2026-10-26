import type { AppConfig } from './config/index.js';
import { Database } from './db/database.js';
import { ServiceAccountTokenProvider } from './google/auth.js';
import { MerchantApiClient, type MerchantApi } from './google/merchant-api.js';
import { RestClient } from './google/rest-client.js';
import { createNotConfiguredApi, createSwitchableApi, type SwitchableApi } from './google/switchable-api.js';
import { ConnectorState } from './connectors/connector.js';
import { MerchantReportsConnector } from './connectors/merchant-reports.js';
import { SearchConsoleConnector } from './connectors/search-console.js';
import { SEARCH_CONSOLE_SCOPE } from './google/auth.js';
import { SEARCH_CONSOLE_BASE_URL, SearchConsoleClient, createNotConfiguredSearchConsoleApi, type SearchConsoleApi } from './google/search-console-api.js';
import { MockSearchConsoleApi } from './mock/mock-search-console.js';
import { MetricsScheduler } from './jobs/metrics-scheduler.js';
import { SyncScheduler } from './jobs/sync-scheduler.js';
import { MockMerchantApi } from './mock/mock-merchant-api.js';
import { AccountIssueStore } from './services/account-issue-store.js';
import { AccountService } from './services/account-service.js';
import { AuthService } from './services/auth-service.js';
import { GoogleOAuthService } from './services/google-oauth-service.js';
import { EnrichmentService } from './services/enrichment-service.js';
import { EventLog } from './services/event-log.js';
import { FeedService } from './services/feed-service.js';
import { MetricsStore } from './services/metrics-store.js';
import { MetricsSyncService } from './services/metrics-sync-service.js';
import { NotificationService } from './services/notification-service.js';
import { Product360Service } from './services/product360-service.js';
import { ProductStore } from './services/product-store.js';
import { RemediationService } from './services/remediation-service.js';
import { SignalsService } from './services/signals-service.js';
import { CONNECTION_KEYS, SettingsService, type MerchantSettings } from './services/settings-service.js';
import { SyncService } from './services/sync-service.js';
import type { Logger } from './util/logger.js';
import { WorkflowEngine } from './workflows/engine.js';
import { WorkflowScheduler } from './workflows/scheduler.js';
import { WorkflowStore } from './workflows/workflow-store.js';

/** All services of the application, wired together. */
export interface AppContext {
  config: AppConfig;
  logger: Logger;
  db: Database;
  settings: SettingsService;
  /** Stable Merchant API facade; the implementation follows the settings. */
  api: MerchantApi;
  /** The mock implementation when one is active (MERCHANT_MOCK / mock setting). */
  readonly mock: MockMerchantApi | null;
  auth: AuthService;
  oauth: GoogleOAuthService;
  events: EventLog;
  products: ProductStore;
  accountIssues: AccountIssueStore;
  sync: SyncService;
  syncScheduler: SyncScheduler;
  enrichment: EnrichmentService;
  feeds: FeedService;
  account: AccountService;
  notifications: NotificationService;
  workflows: WorkflowStore;
  engine: WorkflowEngine;
  scheduler: WorkflowScheduler;
  /** Product360: metric tables, connectors, signals and the read model. */
  metrics: MetricsStore;
  metricsSync: MetricsSyncService;
  metricsScheduler: MetricsScheduler;
  signals: SignalsService;
  product360: Product360Service;
  remediations: RemediationService;
  searchConsole: SearchConsoleConnector;
  /** Current Search Console API implementation (follows the settings). */
  searchConsoleApi(): SearchConsoleApi;
  /** Builds a throw-away client for the given settings (used by "test connection"). */
  buildApi(settings: MerchantSettings): MerchantApi;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface BuildOptions {
  /** Inject a Merchant API implementation (tests). */
  api?: MerchantApi;
  /** Inject a Search Console API implementation (tests). */
  searchConsoleApi?: SearchConsoleApi;
  fetchImpl?: typeof fetch;
}

export function buildApp(config: AppConfig, logger: Logger, options: BuildOptions = {}): AppContext {
  const db = new Database(config.DATABASE_PATH);
  const settings = new SettingsService(db, config, logger);

  const buildApi = (s: MerchantSettings): MerchantApi => {
    if (s.mock) {
      logger.warn('Mock mode is enabled – using in-memory fake Merchant API');
      return new MockMerchantApi({ accountId: s.merchantAccountId || '1234567890' });
    }
    if (!s.merchantAccountId || !s.serviceAccountJson) return createNotConfiguredApi();
    const tokenProvider = ServiceAccountTokenProvider.fromJson(s.serviceAccountJson);
    const http = new RestClient({ baseUrl: s.apiBaseUrl, tokenProvider, logger, fetchImpl: options.fetchImpl });
    return new MerchantApiClient(http, { accountId: s.merchantAccountId, version: s.apiVersion });
  };

  const switchable: SwitchableApi = createSwitchableApi(options.api ?? buildApi(settings.current()));
  const api = switchable.api;
  if (!settings.isConfigured() && !options.api) {
    logger.warn('Merchant Center connection is not configured yet – log in and complete the setup wizard');
  }

  const auth = new AuthService(db, config.SESSION_TTL_HOURS);
  const oauth = new GoogleOAuthService(config.GOOGLE_OAUTH_CLIENT_ID, config.GOOGLE_OAUTH_CLIENT_SECRET, config.GOOGLE_OAUTH_REDIRECT_URI);
  const events = new EventLog(db);
  const products = new ProductStore(db);
  const accountIssues = new AccountIssueStore(db);
  const sync = new SyncService(db, api, products, accountIssues, events, logger);
  const syncScheduler = new SyncScheduler(sync, settings.current().syncIntervalMinutes, logger, () => settings.isConfigured());
  const enrichment = new EnrichmentService(api, products, events, logger, () => ({
    displayName: settings.current().enrichmentDataSourceName,
    priority: settings.current().enrichmentPriority,
  }));
  const feeds = new FeedService(api, products, events);
  const account = new AccountService(api, accountIssues, events, logger, () => ({
    languageCode: settings.current().languageCode,
    timeZone: settings.current().timeZone,
  }));
  const notifications = new NotificationService(api, sync, events, logger, () => ({
    publicUrl: settings.current().publicUrl,
    webhookSecret: settings.current().webhookSecret,
  }));
  // ---- Product360
  const metrics = new MetricsStore(db);
  const signals = new SignalsService(db, products, metrics, events, logger, () => ({
    minImpressions: settings.current().signalMinImpressions,
    priceAboveBenchmarkPct: settings.current().signalPriceAbovePct,
    clickDropPct: settings.current().signalClickDropPct,
  }));
  const metricsSync = new MetricsSyncService(metrics, signals, events, logger, () => ({
    enabled: settings.current().metricsEnabled,
    backfillDays: settings.current().metricsBackfillDays,
    retentionDays: settings.current().metricsRetentionDays,
  }));
  metricsSync.register(new MerchantReportsConnector(api, products, metrics, new ConnectorState(db), () => settings.isConfigured()));

  // Search Console shares the service-account key but needs its own OAuth scope → its own token provider / client.
  const buildSearchConsoleApi = (s: MerchantSettings): SearchConsoleApi => {
    if (options.searchConsoleApi) return options.searchConsoleApi;
    const current = switchable.current();
    if (s.mock && current instanceof MockMerchantApi) return new MockSearchConsoleApi(() => current.allProducts());
    if (!s.serviceAccountJson) return createNotConfiguredSearchConsoleApi();
    const tokenProvider = ServiceAccountTokenProvider.fromJson(s.serviceAccountJson, [SEARCH_CONSOLE_SCOPE]);
    return new SearchConsoleClient(new RestClient({ baseUrl: SEARCH_CONSOLE_BASE_URL, tokenProvider, logger, fetchImpl: options.fetchImpl }));
  };
  let searchConsoleApi = buildSearchConsoleApi(settings.current());
  const searchConsole = new SearchConsoleConnector(
    () => searchConsoleApi,
    products,
    metrics,
    () => ({
      enabled: settings.current().searchConsoleEnabled,
      siteUrl: settings.current().searchConsoleSiteUrl,
      countryFilter: settings.current().searchConsoleCountryFilter,
      merchantListings: settings.current().searchConsoleMerchantListings,
      dataState: settings.current().searchConsoleDataState,
    }),
    () => settings.current().mock || !!settings.current().serviceAccountJson,
  );
  metricsSync.register(searchConsole);
  const product360 = new Product360Service(products, metrics, signals, metricsSync, () => searchConsole.isConfigured());
  const remediations = new RemediationService(db, products, enrichment, sync, events, logger);
  const metricsScheduler = new MetricsScheduler(
    metricsSync,
    { enabled: settings.current().metricsEnabled, cron: settings.current().metricsSyncCron, timezone: settings.current().timeZone },
    logger,
    () => settings.isConfigured() && settings.current().metricsEnabled,
  );
  const workflows = new WorkflowStore(db);
  const engine = new WorkflowEngine({ store: workflows, products, enrichment, sync, api, events, logger, fetchImpl: options.fetchImpl, concurrency: () => settings.current().apiConcurrency, signals });
  const scheduler = new WorkflowScheduler(workflows, engine, events, logger);

  // React to settings changes made through the wizard / settings page.
  settings.onChange((next, _previous, changed) => {
    if (changed.some((k) => CONNECTION_KEYS.includes(k)) && !options.api) {
      switchable.swap(buildApi(next));
      searchConsoleApi = buildSearchConsoleApi(next);
      enrichment.resetCache();
      events.record('settings.connection_changed', `Merchant Center connection updated (${next.mock ? 'mock' : `account ${next.merchantAccountId}`})`, {
        severity: 'warning',
      });
    }
    if (changed.includes('enrichmentDataSourceName') || changed.includes('enrichmentPriority')) enrichment.resetCache();
    if (changed.includes('syncIntervalMinutes')) syncScheduler.reconfigure(next.syncIntervalMinutes);
    if (changed.includes('metricsEnabled') || changed.includes('metricsSyncCron') || changed.includes('timeZone')) {
      metricsScheduler.reconfigure({ enabled: next.metricsEnabled, cron: next.metricsSyncCron, timezone: next.timeZone });
    }
    if (changed.some((k) => k.startsWith('signal')) && signals.hasSignals()) {
      try {
        metricsSync.recomputeSignals();
      } catch (err) {
        logger.error({ err }, 'Could not recompute signals after settings change');
      }
    }
  });

  // Product changes (status, issues) feed into the recommendations – recompute after every product sync.
  events.on('sync.completed', () => {
    if (!signals.hasSignals()) return;
    try {
      metricsSync.recomputeSignals();
    } catch (err) {
      logger.error({ err }, 'Could not recompute signals after sync');
    }
  });

  // Bootstrap admin user from the environment (optional – the wizard can do it too).
  if (config.ADMIN_BOOTSTRAP_ENABLED && auth.userCount() === 0 && config.ADMIN_PASSWORD) {
    auth.createUser(config.ADMIN_USERNAME, config.ADMIN_PASSWORD);
    logger.info({ username: config.ADMIN_USERNAME }, 'Created initial admin user');
  }

  return {
    config,
    logger,
    db,
    settings,
    api,
    get mock() {
      const current = switchable.current();
      return current instanceof MockMerchantApi ? current : null;
    },
    auth,
    oauth,
    events,
    products,
    accountIssues,
    sync,
    syncScheduler,
    enrichment,
    feeds,
    account,
    notifications,
    workflows,
    engine,
    scheduler,
    metrics,
    metricsSync,
    metricsScheduler,
    signals,
    product360,
    remediations,
    searchConsole,
    searchConsoleApi: () => searchConsoleApi,
    buildApi,
    async start() {
      workflows.failStaleRuns();
      metrics.failStaleRuns();
      auth.pruneExpiredSessions();
      auth.pruneOAuthStates();
      scheduler.start();
      remediations.start();
      syncScheduler.start(settings.current().syncOnStartup);
      metricsScheduler.start(settings.current().syncOnStartup);
    },
    async stop() {
      scheduler.stop();
      remediations.stop();
      syncScheduler.stop();
      metricsScheduler.stop();
      db.close();
    },
  };
}
