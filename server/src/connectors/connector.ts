import { Database, fromJson, now, toJson } from '../db/database.js';

export type ConnectorId = 'merchant_reports' | 'search_console' | 'google_ads';

export interface SyncWindow {
  /** inclusive, YYYY-MM-DD */
  from: string;
  to: string;
}

export interface ConnectorLog {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface ConnectorSyncResult {
  /** counters – summed when a window is pulled in several chunks */
  stats: Record<string, number | string | string[]>;
  /** gauges – the last chunk wins (mapped products, unavailable views, …) */
  gauges?: Record<string, number | string | string[]>;
  /** non-fatal problems (e.g. a report view that is not available) */
  warnings: string[];
}

export interface ConnectionCheck {
  ok: boolean;
  /** Per capability (report view, API, property…): available or the reason it is not. */
  capabilities: { id: string; available: boolean; message?: string }[];
  /** Translatable hint code for the UI (e.g. `market_insights_disabled`). */
  hint?: string;
  error?: string;
}

/**
 * A source of product / market metrics. Implementations pull a date window
 * into the local tables; everything else (scheduling, run log, signals) is
 * shared by the MetricsSyncService.
 */
export interface Connector {
  readonly id: ConnectorId;
  /** How far back an initial backfill may reach. */
  readonly maxBackfillDays: number;
  /** Trailing days re-pulled on every run because Google revises recent data. */
  readonly revisionWindowDays: number;
  /** Newest complete day is `today - lagDays` (Search Console closes a day 2–3 days late). */
  readonly lagDays: number;
  isConfigured(): boolean;
  testConnection(): Promise<ConnectionCheck>;
  sync(window: SyncWindow, log: ConnectorLog): Promise<ConnectorSyncResult>;
}

/**
 * Small key/value state per connector (detected capabilities, cursors). Kept
 * in the `settings` table under `connector.<id>.<key>`.
 */
export class ConnectorState {
  constructor(private readonly db: Database) {}

  get<T>(connector: ConnectorId, key: string, fallback: T): T {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [`connector.${connector}.${key}`]);
    return row ? fromJson<T>(row.value, fallback) : fallback;
  }

  set(connector: ConnectorId, key: string, value: unknown): void {
    this.db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [
      `connector.${connector}.${key}`,
      toJson(value),
      now(),
    ]);
  }
}
