import type { Logger } from '../util/logger.js';
import type { SyncService } from '../services/sync-service.js';

/** Periodically runs the full product/issue sync. */
export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sync: SyncService,
    private intervalMinutes: number,
    private readonly logger: Logger,
    /** Sync is skipped while this returns false (no credentials yet). */
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  start(runImmediately: boolean): void {
    if (runImmediately) {
      setTimeout(() => void this.tick('startup'), 1000).unref();
    }
    this.schedule();
  }

  /** Applies a new interval (called when settings change). */
  reconfigure(intervalMinutes: number): void {
    if (intervalMinutes === this.intervalMinutes) return;
    this.intervalMinutes = intervalMinutes;
    this.stop();
    this.schedule();
  }

  private schedule(): void {
    if (this.intervalMinutes <= 0) {
      this.logger.info('Periodic sync disabled (SYNC_INTERVAL_MINUTES=0)');
      return;
    }
    this.timer = setInterval(() => void this.tick('schedule'), this.intervalMinutes * 60_000);
    this.timer.unref();
    this.logger.info({ intervalMinutes: this.intervalMinutes }, 'Periodic sync scheduled');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(reason: string): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Sync skipped – Merchant Center connection not configured');
      return;
    }
    try {
      await this.sync.runFullSync(reason);
    } catch (err) {
      this.logger.error({ err }, 'Scheduled sync failed');
    }
  }
}
