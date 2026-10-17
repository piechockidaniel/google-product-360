import { Cron } from 'croner';
import type { Logger } from '../util/logger.js';
import type { MetricsSyncService } from '../services/metrics-sync-service.js';

export interface MetricsScheduleSettings {
  enabled: boolean;
  cron: string;
  timezone: string;
}

/**
 * Nightly metrics pull. Unlike the product sync (interval based) this is cron
 * based because report data closes once a day; the default is 04:00 in the
 * account time zone. On start-up a run is kicked off when the connectors have
 * never succeeded (first install / demo).
 */
export class MetricsScheduler {
  private job: Cron | null = null;
  private startupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sync: MetricsSyncService,
    private settings: MetricsScheduleSettings,
    private readonly logger: Logger,
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  start(runInitial: boolean): void {
    this.schedule();
    if (runInitial) {
      this.startupTimer = setTimeout(() => void this.tick('startup'), 5000);
      this.startupTimer.unref();
    }
  }

  reconfigure(settings: MetricsScheduleSettings): void {
    if (settings.enabled === this.settings.enabled && settings.cron === this.settings.cron && settings.timezone === this.settings.timezone) return;
    this.settings = settings;
    this.stop();
    this.schedule();
  }

  nextRun(): string | null {
    return this.job?.nextRun()?.toISOString() ?? null;
  }

  stop(): void {
    this.job?.stop();
    this.job = null;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private schedule(): void {
    if (!this.settings.enabled) {
      this.logger.info('Metrics sync disabled');
      return;
    }
    try {
      this.job = new Cron(this.settings.cron, { timezone: this.settings.timezone, protect: true }, () => void this.tick('schedule'));
      this.logger.info({ cron: this.settings.cron, timezone: this.settings.timezone, next: this.nextRun() }, 'Metrics sync scheduled');
    } catch (err) {
      this.logger.error({ err, cron: this.settings.cron }, 'Invalid metrics cron expression – metrics sync not scheduled');
    }
  }

  private async tick(reason: string): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Metrics sync skipped – connection not configured');
      return;
    }
    if (reason === 'startup') {
      // Only pull on start-up when nothing has been loaded yet; otherwise wait for the nightly slot.
      const status = this.sync.status();
      if (status.connectors.some((c) => c.lastSuccessfulRun)) return;
    }
    try {
      await this.sync.run(reason);
    } catch (err) {
      this.logger.error({ err }, 'Scheduled metrics sync failed');
    }
  }
}
