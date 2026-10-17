import type { ConnectionCheck, Connector, ConnectorId, ConnectorLog } from '../connectors/connector.js';
import { addDays, chunkRange, isoDay } from '../util/dates.js';
import type { Logger } from '../util/logger.js';
import type { EventLog } from './event-log.js';
import type { MetricsStore, MetricsSyncRun } from './metrics-store.js';
import type { RecomputeSummary, SignalsService } from './signals-service.js';

export interface MetricsSyncOptions {
  /** Only these connectors (default: every configured one). */
  connectors?: ConnectorId[];
  /** Force a full backfill instead of the revision window. */
  backfill?: boolean;
  /** Override "today" (tests). */
  today?: string;
}

export interface MetricsSyncSettings {
  enabled: boolean;
  backfillDays: number;
  retentionDays: number;
}

export interface MetricsSyncResult {
  runs: MetricsSyncRun[];
  signals: RecomputeSummary | null;
  pruned: number;
}

export interface ConnectorStatus {
  id: ConnectorId;
  configured: boolean;
  lastRun: MetricsSyncRun | null;
  lastSuccessfulRun: MetricsSyncRun | null;
  /** earliest / latest day with data after the last run (from run stats) */
  nextWindow: { from: string; to: string } | null;
}

/** Chunk size for backfills so that a failure does not lose the whole history. */
const CHUNK_DAYS = 31;

/**
 * Runs every configured connector over the right date window, logs runs,
 * prunes old rows and recomputes the signals afterwards. Concurrent calls
 * share the in-flight run (like SyncService).
 */
export class MetricsSyncService {
  private running: Promise<MetricsSyncResult> | null = null;
  private readonly connectors = new Map<ConnectorId, Connector>();

  constructor(
    private readonly metrics: MetricsStore,
    private readonly signals: SignalsService,
    private readonly events: EventLog,
    private readonly logger: Logger,
    private readonly settings: () => MetricsSyncSettings,
  ) {}

  register(connector: Connector): void {
    this.connectors.set(connector.id, connector);
  }

  connector(id: ConnectorId): Connector | undefined {
    return this.connectors.get(id);
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Window the next run will pull for a connector: full backfill when it never succeeded, otherwise the revision window. */
  nextWindow(connector: Connector, today = isoDay()): { from: string; to: string; backfill: boolean } {
    const last = this.metrics.lastSuccessfulRun(connector.id);
    const to = addDays(today, -connector.lagDays); // newest complete day
    if (!last?.windowTo) {
      const days = Math.min(this.settings().backfillDays, connector.maxBackfillDays);
      return { from: addDays(to, -(days - 1)), to, backfill: true };
    }
    // Continue from where we stopped, minus the revision window; never more than the backfill size in one go.
    const resume = addDays(last.windowTo, -(connector.revisionWindowDays - 1));
    const floor = addDays(to, -(Math.min(this.settings().backfillDays, connector.maxBackfillDays) - 1));
    return { from: resume < floor ? floor : resume, to, backfill: false };
  }

  status(): { enabled: boolean; running: boolean; connectors: ConnectorStatus[]; signals: { computed: boolean; windowEnd: string | null } } {
    const connectors: ConnectorStatus[] = [];
    for (const c of this.connectors.values()) {
      const configured = c.isConfigured();
      connectors.push({
        id: c.id,
        configured,
        lastRun: this.metrics.lastRun(c.id) ?? null,
        lastSuccessfulRun: this.metrics.lastSuccessfulRun(c.id) ?? null,
        nextWindow: configured ? (({ from, to }) => ({ from, to }))(this.nextWindow(c)) : null,
      });
    }
    const hasSignals = this.signals.hasSignals();
    return { enabled: this.settings().enabled, running: this.isRunning, connectors, signals: { computed: hasSignals, windowEnd: hasSignals ? this.signals.windowEnd() : null } };
  }

  async testConnection(id: ConnectorId): Promise<ConnectionCheck> {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`Unknown connector ${id}`);
    if (!connector.isConfigured()) return { ok: false, capabilities: [], error: 'Connector is not configured' };
    return connector.testConnection();
  }

  run(reason = 'manual', options: MetricsSyncOptions = {}): Promise<MetricsSyncResult> {
    if (this.running) return this.running;
    this.running = this.execute(reason, options).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Recomputes signals without pulling anything (after thresholds change, after a product sync). */
  recomputeSignals(): RecomputeSummary {
    return this.signals.recompute();
  }

  private async execute(reason: string, options: MetricsSyncOptions): Promise<MetricsSyncResult> {
    const today = options.today ?? isoDay();
    const runs: MetricsSyncRun[] = [];
    const wanted = options.connectors ? options.connectors.map((id) => this.connectors.get(id)).filter((c): c is Connector => !!c) : [...this.connectors.values()];
    let anySuccess = false;
    for (const connector of wanted) {
      if (!connector.isConfigured()) {
        this.logger.debug({ connector: connector.id }, 'Metrics connector not configured – skipped');
        continue;
      }
      const to = addDays(today, -connector.lagDays);
      const window = options.backfill
        ? { from: addDays(to, -(Math.min(this.settings().backfillDays, connector.maxBackfillDays) - 1)), to, backfill: true }
        : this.nextWindow(connector, today);
      const run = this.metrics.startRun(connector.id, window);
      const messages: { level: 'info' | 'warn'; message: string; data?: unknown }[] = [];
      const log: ConnectorLog = {
        info: (message, data) => {
          messages.push({ level: 'info', message, data });
          this.logger.info({ connector: connector.id, data }, message);
        },
        warn: (message, data) => {
          messages.push({ level: 'warn', message, data });
          this.logger.warn({ connector: connector.id, data }, message);
        },
      };
      const t0 = Date.now();
      const stats: Record<string, unknown> = { reason, backfill: window.backfill, chunks: 0 };
      const warnings: string[] = [];
      try {
        this.logger.info({ connector: connector.id, window, reason }, 'Metrics sync started');
        for (const chunk of chunkRange(window.from, window.to, CHUNK_DAYS)) {
          const result = await connector.sync(chunk, log);
          stats.chunks = Number(stats.chunks) + 1;
          for (const [k, v] of Object.entries(result.stats)) {
            stats[k] = typeof v === 'number' && typeof stats[k] === 'number' ? (stats[k] as number) + v : v;
          }
          Object.assign(stats, result.gauges ?? {});
          warnings.push(...result.warnings);
        }
        stats.durationMs = Date.now() - t0;
        stats.warnings = warnings;
        stats.log = messages.slice(-50);
        runs.push(this.metrics.finishRun(run.id, 'success', stats));
        anySuccess = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stats.durationMs = Date.now() - t0;
        stats.log = messages.slice(-50);
        runs.push(this.metrics.finishRun(run.id, 'failed', stats, message));
        this.logger.error({ err, connector: connector.id }, 'Metrics sync failed');
        this.events.record('metrics.failed', `Metrics sync (${connector.id}) failed: ${message}`, { severity: 'error', payload: { connector: connector.id, runId: run.id, reason } });
      }
    }

    const pruned = anySuccess ? this.metrics.prune(this.settings().retentionDays, today) : 0;
    let signals: RecomputeSummary | null = null;
    if (anySuccess) {
      try {
        signals = this.signals.recompute();
      } catch (err) {
        this.logger.error({ err }, 'Signal recomputation failed');
        this.events.record('metrics.failed', `Signal recomputation failed: ${(err as Error).message}`, { severity: 'error' });
      }
      this.events.record(
        'metrics.synced',
        `Metrics updated (${runs.filter((r) => r.status === 'success').map((r) => r.connector).join(', ')}); ${signals?.changed ?? 0} recommendation change(s)`,
        { payload: { reason, runs: runs.map((r) => ({ id: r.id, connector: r.connector, status: r.status })), signals, pruned } },
      );
    }
    return { runs, signals, pruned };
  }
}
