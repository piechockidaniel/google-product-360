import { Database, fromJson, now, toJson, type Row } from '../db/database.js';
import type { MerchantApi } from '../google/merchant-api.js';
import { productIdFromName } from '../google/merchant-api.js';
import type { Logger } from '../util/logger.js';
import type { AccountIssueStore } from './account-issue-store.js';
import type { EventLog } from './event-log.js';
import type { ProductStore } from './product-store.js';

export interface SyncStats {
  products: number;
  newProducts: number;
  deletedProducts: number;
  newIssues: number;
  resolvedIssues: number;
  statusChanges: number;
  newAccountIssues: number;
  resolvedAccountIssues: number;
  durationMs: number;
}

export interface SyncRun {
  id: number;
  kind: 'full' | 'product' | 'account';
  status: 'running' | 'success' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  stats: Partial<SyncStats>;
  error: string | null;
}

function rowToRun(row: Row): SyncRun {
  return {
    id: Number(row.id),
    kind: row.kind as SyncRun['kind'],
    status: row.status as SyncRun['status'],
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    stats: fromJson<Partial<SyncStats>>(row.stats, {}),
    error: (row.error as string | null) ?? null,
  };
}

/**
 * Pulls products + issues from the Merchant API into the local store, tracks
 * what is new / resolved and emits events for the workflow engine.
 */
export class SyncService {
  private running: Promise<SyncRun> | null = null;

  constructor(
    private readonly db: Database,
    private readonly api: MerchantApi,
    private readonly products: ProductStore,
    private readonly accountIssues: AccountIssueStore,
    private readonly events: EventLog,
    private readonly logger: Logger,
  ) {}

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Runs a full sync; concurrent calls share the in-flight run. */
  runFullSync(reason = 'manual'): Promise<SyncRun> {
    if (this.running) return this.running;
    this.running = this.doFullSync(reason).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doFullSync(reason: string): Promise<SyncRun> {
    const startedAt = now();
    const runId = Number(this.db.run("INSERT INTO sync_runs (kind, status, started_at) VALUES ('full', 'running', ?)", [startedAt]).lastInsertRowid);
    const t0 = Date.now();
    const stats: SyncStats = {
      products: 0,
      newProducts: 0,
      deletedProducts: 0,
      newIssues: 0,
      resolvedIssues: 0,
      statusChanges: 0,
      newAccountIssues: 0,
      resolvedAccountIssues: 0,
      durationMs: 0,
    };
    this.logger.info({ reason }, 'Full sync started');

    try {
      // ---- products
      for await (const page of this.api.listProductPages()) {
        this.db.transaction(() => {
          for (const product of page) {
            if (!product.name) continue;
            const seenAt = now();
            const result = this.products.upsertProduct(product, seenAt);
            stats.products += 1;
            if (result.isNewProduct) stats.newProducts += 1;
            for (const issue of result.newIssues) {
              stats.newIssues += 1;
              this.events.record('issue.new', `New issue "${issue.description ?? issue.code}" on ${product.offerId}`, {
                severity: issue.level === 'error' ? 'error' : issue.level === 'warning' ? 'warning' : 'info',
                payload: issue,
                productName: product.name,
              });
            }
            for (const issue of result.resolvedIssues) {
              stats.resolvedIssues += 1;
              this.events.record('issue.resolved', `Issue "${issue.description ?? issue.code}" resolved on ${product.offerId}`, {
                payload: issue,
                productName: product.name,
              });
            }
            if (result.statusChanged) {
              stats.statusChanges += 1;
              const status = this.products.getProduct(product.name)?.aggregatedStatus;
              this.events.record('product.status_changed', `${product.offerId}: ${result.previousStatus} → ${status}`, {
                severity: status === 'DISAPPROVED' ? 'error' : 'info',
                payload: { previousStatus: result.previousStatus, status, offerId: product.offerId },
                productName: product.name,
              });
            }
          }
        });
      }
      const deleted = this.products.markMissingAsDeleted(startedAt);
      stats.deletedProducts = deleted.length;
      for (const name of deleted) {
        this.events.record('product.deleted', `Product ${productIdFromName(name)} disappeared from the account`, { productName: name, severity: 'warning' });
      }

      // ---- account issues
      const accountIssues = await this.api.listAccountIssues();
      const accountDiff = this.accountIssues.sync(accountIssues);
      stats.newAccountIssues = accountDiff.newIssues.length;
      stats.resolvedAccountIssues = accountDiff.resolvedIssues.length;
      for (const issue of accountDiff.newIssues) {
        this.events.record('account_issue.new', `New account issue: ${issue.title}`, { severity: issue.level === 'error' ? 'error' : 'warning', payload: issue });
      }
      for (const issue of accountDiff.resolvedIssues) {
        this.events.record('account_issue.resolved', `Account issue resolved: ${issue.title}`, { payload: issue });
      }

      stats.durationMs = Date.now() - t0;
      this.db.run("UPDATE sync_runs SET status = 'success', finished_at = ?, stats = ? WHERE id = ?", [now(), toJson(stats), runId]);
      this.logger.info(stats, 'Full sync finished');
      this.events.record(
        'sync.completed',
        `Sync finished: ${stats.products} products, ${stats.newIssues} new / ${stats.resolvedIssues} resolved issues`,
        { payload: { ...stats, reason, runId } },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stats.durationMs = Date.now() - t0;
      this.db.run("UPDATE sync_runs SET status = 'failed', finished_at = ?, stats = ?, error = ? WHERE id = ?", [now(), toJson(stats), message, runId]);
      this.logger.error({ err }, 'Full sync failed');
      this.events.record('sync.failed', `Sync failed: ${message}`, { severity: 'error', payload: { reason, runId } });
    }
    return this.getRun(runId)!;
  }

  /** Refreshes a single product from the API (used after notifications and metadata pushes). */
  async refreshProduct(productId: string, reason = 'manual'): Promise<ReturnType<ProductStore['getProduct']>> {
    const product = await this.api.getProduct(productId);
    if (!product.name) return undefined;
    const result = this.products.upsertProduct(product);
    for (const issue of result.newIssues) {
      this.events.record('issue.new', `New issue "${issue.description ?? issue.code}" on ${product.offerId}`, {
        severity: issue.level === 'error' ? 'error' : issue.level === 'warning' ? 'warning' : 'info',
        payload: issue,
        productName: product.name,
      });
    }
    for (const issue of result.resolvedIssues) {
      this.events.record('issue.resolved', `Issue "${issue.description ?? issue.code}" resolved on ${product.offerId}`, { payload: issue, productName: product.name });
    }
    if (result.statusChanged) {
      const status = this.products.getProduct(product.name)?.aggregatedStatus;
      this.events.record('product.status_changed', `${product.offerId}: ${result.previousStatus} → ${status} (${reason})`, {
        severity: status === 'DISAPPROVED' ? 'error' : 'info',
        payload: { previousStatus: result.previousStatus, status, offerId: product.offerId, reason },
        productName: product.name,
      });
    }
    return this.products.getProduct(product.name);
  }

  getRun(id: number): SyncRun | undefined {
    const row = this.db.get('SELECT * FROM sync_runs WHERE id = ?', [id]);
    return row ? rowToRun(row) : undefined;
  }

  lastRun(): SyncRun | undefined {
    const row = this.db.get('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1');
    return row ? rowToRun(row) : undefined;
  }

  lastSuccessfulRun(): SyncRun | undefined {
    const row = this.db.get("SELECT * FROM sync_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1");
    return row ? rowToRun(row) : undefined;
  }

  listRuns(limit = 20): SyncRun[] {
    return this.db.all('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?', [limit]).map(rowToRun);
  }
}
