import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import { Database, now } from '../db/database.js';
import type { Logger } from '../util/logger.js';

/**
 * Settings that can be changed at runtime (setup wizard / settings page).
 * They are stored in the `settings` table; environment variables act as
 * defaults when nothing has been stored yet.
 */
export const merchantSettingsSchema = z.object({
  mock: z.boolean().default(false),
  merchantAccountId: z.string().trim().regex(/^\d*$/, 'Merchant account id must be numeric').default(''),
  /** Full JSON of the service account key (stored encrypted). */
  serviceAccountJson: z.string().nullable().default(null),
  apiBaseUrl: z.string().url().default('https://merchantapi.googleapis.com'),
  apiVersion: z.string().trim().min(1).default('v1'),
  languageCode: z.string().trim().min(2).default('pl-PL'),
  timeZone: z.string().trim().min(1).default('Europe/Warsaw'),
  enrichmentDataSourceName: z.string().trim().min(1).max(100).default('GMC Manager enrichment'),
  enrichmentPriority: z.enum(['override', 'fallback']).default('override'),
  syncIntervalMinutes: z.number().int().min(0).max(24 * 60).default(30),
  /** Parallel Merchant API requests for bulk operations (workflow actions, bulk edit). */
  apiConcurrency: z.number().int().min(1).max(32).default(8),
  syncOnStartup: z.boolean().default(true),
  publicUrl: z.string().url().nullable().default(null),
  webhookSecret: z.string().min(8).default('change-me-webhook-secret'),
  setupCompletedAt: z.string().nullable().default(null),

  // ---- Product360 metrics & signals
  /** Pull performance / market reports and compute recommendations. */
  metricsEnabled: z.boolean().default(true),
  /** Cron (5 fields) for the nightly metrics pull – runs in the account time zone. */
  metricsSyncCron: z.string().trim().min(5).default('0 4 * * *'),
  /** Days loaded on the first run. */
  metricsBackfillDays: z.number().int().min(7).max(730).default(90),
  /** Daily rows older than this are deleted. */
  metricsRetentionDays: z.number().int().min(30).max(1100).default(400),
  /** Impressions (28 days) below which a product has "no data". */
  signalMinImpressions: z.number().int().min(0).max(100000).default(20),
  /** Price above the benchmark (percent) that triggers a REPRICE recommendation. */
  signalPriceAbovePct: z.number().min(0).max(100).default(10),
  /** Week-over-week click drop (percent) that triggers a WATCH recommendation. */
  signalClickDropPct: z.number().min(1).max(100).default(40),

  // ---- Product360: Google Search Console connector (same service account, scope webmasters.readonly)
  searchConsoleEnabled: z.boolean().default(false),
  /** Property as listed by the API: `sc-domain:example.com` or `https://www.example.com/`. */
  searchConsoleSiteUrl: z.string().trim().default(''),
  /** ISO-3166-1 alpha-3 country (e.g. `pol`); empty = all countries. */
  searchConsoleCountryFilter: z.string().trim().toLowerCase().regex(/^[a-z]{0,3}$/, 'Use a 3-letter country code (e.g. pol)').default(''),
  /** Additionally pull the MERCHANT_LISTINGS search appearance (product rich results). */
  searchConsoleMerchantListings: z.boolean().default(false),
  searchConsoleDataState: z.enum(['all', 'final']).default('all'),
});
export type MerchantSettings = z.infer<typeof merchantSettingsSchema>;
export type MerchantSettingsPatch = Partial<MerchantSettings>;

const SECRET_KEYS: (keyof MerchantSettings)[] = ['serviceAccountJson'];
/** Keys that require the Merchant API client to be rebuilt. */
export const CONNECTION_KEYS: (keyof MerchantSettings)[] = ['mock', 'merchantAccountId', 'serviceAccountJson', 'apiBaseUrl', 'apiVersion'];

export interface ServiceAccountSummary {
  clientEmail: string;
  projectId: string | null;
  privateKeyId: string | null;
}

/** What the API exposes: secrets are replaced by a summary. */
export interface PublicSettings extends Omit<MerchantSettings, 'serviceAccountJson'> {
  serviceAccount: ServiceAccountSummary | null;
  configured: boolean;
  /** which keys currently come from the environment instead of the database */
  fromEnvironment: (keyof MerchantSettings)[];
}

export function parseServiceAccount(raw: string): ServiceAccountSummary {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('Service account key is not valid JSON');
  }
  if (parsed.type !== 'service_account') throw new Error('JSON is not a service account key ("type" must be "service_account")');
  if (typeof parsed.client_email !== 'string' || !parsed.client_email) throw new Error('Service account key is missing "client_email"');
  if (typeof parsed.private_key !== 'string' || !parsed.private_key.includes('PRIVATE KEY')) throw new Error('Service account key is missing "private_key"');
  return {
    clientEmail: parsed.client_email,
    projectId: typeof parsed.project_id === 'string' ? parsed.project_id : null,
    privateKeyId: typeof parsed.private_key_id === 'string' ? parsed.private_key_id : null,
  };
}

type Listener = (next: MerchantSettings, previous: MerchantSettings, changedKeys: (keyof MerchantSettings)[]) => void;

export class SettingsService {
  private cache: MerchantSettings;
  private readonly stored = new Set<keyof MerchantSettings>();
  private readonly listeners = new Set<Listener>();
  private readonly key: Buffer;

  constructor(
    private readonly db: Database,
    private readonly env: AppConfig,
    private readonly logger: Logger,
  ) {
    this.key = scryptSync(env.SESSION_SECRET, 'gmc-manager-settings', 32);
    this.cache = this.load();
  }

  // ------------------------------------------------------------ read
  current(): MerchantSettings {
    return this.cache;
  }

  isConfigured(settings: MerchantSettings = this.cache): boolean {
    return settings.mock || (!!settings.merchantAccountId && !!settings.serviceAccountJson);
  }

  publicView(): PublicSettings {
    const { serviceAccountJson, ...rest } = this.cache;
    let serviceAccount: ServiceAccountSummary | null = null;
    if (serviceAccountJson) {
      try {
        serviceAccount = parseServiceAccount(serviceAccountJson);
      } catch {
        serviceAccount = { clientEmail: '(invalid key)', projectId: null, privateKeyId: null };
      }
    }
    return {
      ...rest,
      serviceAccount,
      configured: this.isConfigured(),
      fromEnvironment: (Object.keys(this.cache) as (keyof MerchantSettings)[]).filter((k) => !this.stored.has(k) && this.envValue(k) !== undefined),
    };
  }

  // ------------------------------------------------------------ write
  /** Validates and persists a partial update; notifies listeners about changed keys. */
  update(patch: MerchantSettingsPatch): MerchantSettings {
    const candidate = merchantSettingsSchema.parse({ ...this.cache, ...patch });
    if (candidate.serviceAccountJson) parseServiceAccount(candidate.serviceAccountJson); // throws on invalid key
    const previous = this.cache;
    const changed = (Object.keys(patch) as (keyof MerchantSettings)[]).filter((k) => JSON.stringify(candidate[k]) !== JSON.stringify(previous[k]));
    this.db.transaction(() => {
      for (const k of Object.keys(patch) as (keyof MerchantSettings)[]) this.store(k, candidate[k]);
    });
    this.cache = candidate;
    if (changed.length) {
      this.logger.info({ changed }, 'Settings updated');
      for (const l of this.listeners) l(candidate, previous, changed);
    }
    return candidate;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------ internals
  private envValue(key: keyof MerchantSettings): unknown {
    const e = this.env;
    switch (key) {
      case 'mock':
        return e.MERCHANT_MOCK;
      case 'merchantAccountId':
        return e.MERCHANT_ACCOUNT_ID || undefined;
      case 'serviceAccountJson':
        if (e.GOOGLE_SERVICE_ACCOUNT_JSON) return e.GOOGLE_SERVICE_ACCOUNT_JSON;
        if (e.GOOGLE_SERVICE_ACCOUNT_KEY_PATH && fs.existsSync(e.GOOGLE_SERVICE_ACCOUNT_KEY_PATH)) {
          const raw = fs.readFileSync(e.GOOGLE_SERVICE_ACCOUNT_KEY_PATH, 'utf8');
          try {
            parseServiceAccount(raw);
            return raw;
          } catch {
            return undefined; // e.g. the empty template file
          }
        }
        return undefined;
      case 'apiBaseUrl':
        return e.MERCHANT_API_BASE_URL;
      case 'apiVersion':
        return e.MERCHANT_API_VERSION;
      case 'languageCode':
        return e.MERCHANT_LANGUAGE_CODE;
      case 'timeZone':
        return e.MERCHANT_TIME_ZONE;
      case 'enrichmentDataSourceName':
        return e.ENRICHMENT_DATA_SOURCE_NAME;
      case 'syncIntervalMinutes':
        return e.SYNC_INTERVAL_MINUTES;
      case 'syncOnStartup':
        return e.SYNC_ON_STARTUP;
      case 'publicUrl':
        return e.PUBLIC_URL;
      case 'webhookSecret':
        return e.WEBHOOK_SECRET;
      case 'metricsSyncCron':
        return e.METRICS_SYNC_CRON;
      case 'metricsBackfillDays':
        return e.METRICS_BACKFILL_DAYS;
      case 'searchConsoleSiteUrl':
        return e.SEARCH_CONSOLE_SITE_URL || undefined;
      case 'searchConsoleEnabled':
        return e.SEARCH_CONSOLE_SITE_URL ? true : undefined;
      default:
        return undefined;
    }
  }

  private load(): MerchantSettings {
    const rows = this.db.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'merchant.%'");
    const fromDb: Record<string, unknown> = {};
    for (const row of rows) {
      const key = row.key.slice('merchant.'.length) as keyof MerchantSettings;
      try {
        fromDb[key] = this.decode(key, row.value);
        this.stored.add(key);
      } catch (err) {
        this.logger.warn({ key, err }, 'Could not read stored setting (SESSION_SECRET changed?) – falling back to environment');
      }
    }
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(merchantSettingsSchema.shape) as (keyof MerchantSettings)[]) {
      const envValue = this.envValue(key);
      if (key in fromDb) merged[key] = fromDb[key];
      else if (envValue !== undefined) merged[key] = envValue;
    }
    const parsed = merchantSettingsSchema.safeParse(merged);
    if (parsed.success) return parsed.data;
    this.logger.warn({ issues: parsed.error.issues }, 'Stored settings are invalid – using defaults for the invalid keys');
    for (const issue of parsed.error.issues) delete merged[issue.path[0] as string];
    return merchantSettingsSchema.parse(merged);
  }

  private store(key: keyof MerchantSettings, value: unknown): void {
    const encoded = this.encode(key, value);
    this.db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [
      `merchant.${key}`,
      encoded,
      now(),
    ]);
    this.stored.add(key);
  }

  private encode(key: keyof MerchantSettings, value: unknown): string {
    const json = JSON.stringify(value ?? null);
    if (!SECRET_KEYS.includes(key)) return json;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
  }

  private decode(key: keyof MerchantSettings, stored: string): unknown {
    if (!stored.startsWith('enc:v1:')) return JSON.parse(stored);
    const [, , iv, tag, data] = stored.split(':');
    if (!iv || !tag || !data) throw new Error(`Corrupt encrypted setting ${key}`);
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const json = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(json);
  }
}
