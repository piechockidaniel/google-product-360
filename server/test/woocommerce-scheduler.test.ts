import { afterEach, describe, expect, it, vi } from 'vitest';
import { WooCommerceScheduler } from '../src/jobs/woocommerce-scheduler.js';
import type { WooCommerceService } from '../src/services/woocommerce-service.js';
import { silentLogger } from '../src/util/logger.js';

afterEach(() => vi.useRealTimers());

describe('WooCommerce scheduler', () => {
  it('runs only when configured and enabled, and stops cleanly', async () => {
    vi.useFakeTimers();
    let configured = false;
    const sync = vi.fn().mockResolvedValue({});
    const woo = { status: () => ({ configured }), sync } as unknown as WooCommerceService;
    const scheduler = new WooCommerceScheduler(woo, 0, silentLogger);
    scheduler.start(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sync).not.toHaveBeenCalled();
    scheduler.reconfigure(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).not.toHaveBeenCalled();
    configured = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(1);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not start a timer when reconfigured before application startup', async () => {
    vi.useFakeTimers();
    const sync = vi.fn().mockResolvedValue({});
    const woo = { status: () => ({ configured: true }), sync } as unknown as WooCommerceService;
    const scheduler = new WooCommerceScheduler(woo, 0, silentLogger);
    scheduler.reconfigure(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sync).not.toHaveBeenCalled();
    scheduler.start(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});
