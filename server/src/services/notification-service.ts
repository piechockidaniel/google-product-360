import type { MerchantApi } from '../google/merchant-api.js';
import { lastSegment, productIdFromName } from '../google/merchant-api.js';
import type { NotificationSubscription, ProductStatusChangeMessage } from '../google/types.js';
import type { Logger } from '../util/logger.js';
import type { EventLog } from './event-log.js';
import type { SyncService } from './sync-service.js';

export interface SubscriptionSummary {
  id: string;
  name: string;
  registeredEvent: string;
  callBackUri: string;
  targetAccount: string | null;
  allManagedAccounts: boolean;
  /** true when the callback points at this installation */
  ownedByThisApp: boolean;
}

/**
 * Google push notifications (Merchant API notifications sub-API). Google POSTs
 * a ProductStatusChangeMessage to the callback URL whenever a product's status
 * changes; we record it and refresh the product immediately instead of waiting
 * for the next periodic sync.
 */
export class NotificationService {
  constructor(
    private readonly api: MerchantApi,
    private readonly sync: SyncService,
    private readonly events: EventLog,
    private readonly logger: Logger,
    private readonly getOptions: () => { publicUrl?: string | null; webhookSecret: string },
  ) {}

  private get options(): { publicUrl?: string | null; webhookSecret: string } {
    return this.getOptions();
  }

  get callbackUrl(): string | null {
    if (!this.options.publicUrl) return null;
    return `${this.options.publicUrl.replace(/\/+$/, '')}/api/webhooks/merchant/${this.options.webhookSecret}`;
  }

  async list(): Promise<SubscriptionSummary[]> {
    const subs = await this.api.listNotificationSubscriptions();
    return subs.map((s) => this.summarize(s));
  }

  /** Subscribes this installation to PRODUCT_STATUS_CHANGE events. */
  async subscribe(): Promise<SubscriptionSummary> {
    const callBackUri = this.callbackUrl;
    if (!callBackUri) throw new Error('PUBLIC_URL must be configured (https) before subscribing to notifications');
    const existing = (await this.api.listNotificationSubscriptions()).find((s) => s.callBackUri === callBackUri && s.registeredEvent === 'PRODUCT_STATUS_CHANGE');
    if (existing) return this.summarize(existing);
    const created = await this.api.createNotificationSubscription({
      registeredEvent: 'PRODUCT_STATUS_CHANGE',
      callBackUri,
      targetAccount: this.api.accountName,
    });
    this.events.record('notification.subscribed', `Subscribed to PRODUCT_STATUS_CHANGE notifications (${created.name})`, { payload: created });
    return this.summarize(created);
  }

  async unsubscribe(id: string): Promise<void> {
    await this.api.deleteNotificationSubscription(id);
    this.events.record('notification.unsubscribed', `Deleted notification subscription ${id}`);
  }

  /** Handles an incoming push message. Returns quickly; product refresh happens in the background. */
  handleIncoming(message: ProductStatusChangeMessage): void {
    const productName = message.resource ?? null;
    const changes = (message.changes ?? []).map((c) => `${c.reportingContext ?? '?'}/${c.regionCode ?? '?'}: ${c.oldValue ?? '?'} → ${c.newValue ?? '?'}`).join('; ');
    this.events.record('notification.received', `Google notification for ${message.resourceId ?? productName ?? 'unknown product'}: ${changes || 'status change'}`, {
      payload: message,
      productName,
      severity: (message.changes ?? []).some((c) => c.newValue === 'DISAPPROVED') ? 'error' : 'info',
    });
    if (productName) {
      void this.sync.refreshProduct(productIdFromName(productName), 'notification').catch((err) => {
        this.logger.warn({ err, productName }, 'Could not refresh product after notification');
      });
    }
  }

  private summarize(s: NotificationSubscription): SubscriptionSummary {
    return {
      id: lastSegment(s.name ?? ''),
      name: s.name ?? '',
      registeredEvent: s.registeredEvent ?? 'REGISTERED_EVENT_UNSPECIFIED',
      callBackUri: s.callBackUri ?? '',
      targetAccount: s.targetAccount ?? null,
      allManagedAccounts: s.allManagedAccounts ?? false,
      ownedByThisApp: !!this.callbackUrl && s.callBackUri === this.callbackUrl,
    };
  }
}
