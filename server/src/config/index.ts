import { z } from 'zod';
import path from 'node:path';

/**
 * Application configuration, read from environment variables.
 * See `.env.example` for documentation of every setting.
 */
const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Base URL under which the app is reachable from the internet (needed for Google push notifications). */
  PUBLIC_URL: z.string().url().optional(),

  DATABASE_PATH: z.string().default('./data/gmc-manager.sqlite'),

  /** Secret used to sign session cookies. MUST be changed in production. */
  SESSION_SECRET: z.string().min(16).default('change-me-change-me-change-me'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(24 * 7),
  /** Bootstrap admin user; created on first start if the users table is empty. */
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_BOOTSTRAP_ENABLED: boolish.default(true),
  /** Google OIDC web client used only to authenticate operators. */
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  /** Keep local password login opt-in; DEMO_MODE enables it automatically. */
  LOCAL_LOGIN_ENABLED: boolish.default(false),

  /** Google Merchant Center */
  MERCHANT_ACCOUNT_ID: z.string().default(''),
  MERCHANT_API_BASE_URL: z.string().url().default('https://merchantapi.googleapis.com'),
  /** API version segment. All Merchant API sub-APIs are GA under `v1`. */
  MERCHANT_API_VERSION: z.string().default('v1'),
  GOOGLE_SERVICE_ACCOUNT_KEY_PATH: z.string().default('./service-account-key.json'),
  /** Alternatively the full JSON of the service-account key (useful for container secrets). */
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  /** Use an in-process fake Merchant API instead of Google (for development / demos). */
  MERCHANT_MOCK: boolish.default(false),
  /**
   * Self-contained demo on synthetic data: forces the mock APIs, completes the setup, enables every
   * Product360 connector, installs sample workflows and loads metrics on start (`npm run demo`).
   */
  DEMO_MODE: boolish.default(false),
  MERCHANT_LANGUAGE_CODE: z.string().default('pl-PL'),
  MERCHANT_TIME_ZONE: z.string().default('Europe/Warsaw'),

  /** Display name of the supplemental (API) data source the app uses to push enrichment attributes. */
  ENRICHMENT_DATA_SOURCE_NAME: z.string().default('GMC Manager enrichment'),

  /** Background sync (products + issues) interval; 0 disables the scheduler. */
  SYNC_INTERVAL_MINUTES: z.coerce.number().min(0).default(30),
  SYNC_ON_STARTUP: boolish.default(true),

  /** Secret path segment for the Google notification webhook. */
  WEBHOOK_SECRET: z.string().min(8).default('change-me-webhook-secret'),

  /** Product360: nightly metrics pull (cron, account time zone) and initial backfill window. */
  METRICS_SYNC_CRON: z.string().default('0 4 * * *'),
  METRICS_BACKFILL_DAYS: z.coerce.number().int().min(7).max(730).default(90),
  /** Optional default for the Search Console property (`sc-domain:example.com` or `https://www.example.com/`). */
  SEARCH_CONSOLE_SITE_URL: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema> & {
  rootDir: string;
  clientDistDir: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  const rootDir = process.cwd();
  if (cfg.DEMO_MODE) {
    // The demo never talks to Google and lives in its own database next to the real one.
    cfg.MERCHANT_MOCK = true;
    if (!env.DATABASE_PATH) cfg.DATABASE_PATH = './data/demo.sqlite';
    if (!env.ADMIN_USERNAME) cfg.ADMIN_USERNAME = 'demo';
    if (!env.ADMIN_PASSWORD) cfg.ADMIN_PASSWORD = 'demo1234';
    cfg.LOCAL_LOGIN_ENABLED = true;
  }
  if (cfg.ADMIN_PASSWORD || cfg.NODE_ENV !== 'production') cfg.LOCAL_LOGIN_ENABLED = true;
  return {
    ...cfg,
    rootDir,
    clientDistDir: path.join(rootDir, 'dist', 'client'),
  };
}
