import type { WooCommerceService } from '../services/woocommerce-service.js';
import type { Logger } from '../util/logger.js';

/** Optional automatic WooCommerce sync; disabled by default. */
export class WooCommerceScheduler {
  private timer: NodeJS.Timeout | null = null;
  private startup: NodeJS.Timeout | null = null;
  private started = false;
  constructor(private readonly woo: WooCommerceService, private interval: number, private readonly logger: Logger) {}
  start(runImmediately: boolean): void {
    if (this.started) return;
    this.started = true;
    if (runImmediately) { this.startup = setTimeout(() => void this.tick(), 1000); this.startup.unref(); }
    this.schedule();
  }
  reconfigure(interval: number): void { if (interval === this.interval) return; const active = this.started; this.stop(); this.interval = interval; if (active) { this.started = true; this.schedule(); } }
  stop(): void { if (this.timer) clearInterval(this.timer); if (this.startup) clearTimeout(this.startup); this.timer = null; this.startup = null; this.started = false; }
  private schedule(): void { if (this.interval > 0) { this.timer = setInterval(() => void this.tick(), this.interval * 60_000); this.timer.unref(); } }
  private async tick(): Promise<void> {
    if (!this.woo.status().configured) return;
    try { await this.woo.sync(); } catch { this.logger.warn('Scheduled WooCommerce synchronization failed'); }
  }
}
