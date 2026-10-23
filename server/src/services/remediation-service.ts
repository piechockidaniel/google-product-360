import { randomUUID } from 'node:crypto';
import { Database, now, type Row } from '../db/database.js';
import { productIdFromName } from '../google/merchant-api.js';
import type { Logger } from '../util/logger.js';
import type { EnrichmentService } from './enrichment-service.js';
import type { EventLog } from './event-log.js';
import type { ProductIssueRecord, ProductStore } from './product-store.js';
import type { SyncService } from './sync-service.js';

export type RemediationStatus = 'queued' | 'running' | 'pending_google' | 'succeeded' | 'failed';

export interface RemediationProposal {
  issueCode: string;
  attribute: 'title';
  proposedValue: string;
  evidence: string;
  consequence: string;
  remediation: string;
}

export interface RemediationEvent {
  id: number;
  operationId: string;
  type: string;
  message: string;
  createdAt: string;
}

export interface RemediationOperation {
  id: string;
  productName: string;
  issueCode: string;
  attribute: string;
  proposedValue: string;
  status: RemediationStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deadlineAt: string;
  resultMessage: string | null;
  events: RemediationEvent[];
}

const ACTIVE: RemediationStatus[] = ['queued', 'running', 'pending_google'];
const MAX_WAIT_MS = 30_000;

function rowToOperation(row: Row, events: RemediationEvent[]): RemediationOperation {
  return {
    id: row.id as string,
    productName: row.product_name as string,
    issueCode: row.issue_code as string,
    attribute: row.attribute as string,
    proposedValue: row.proposed_value as string,
    status: row.status as RemediationStatus,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
    deadlineAt: row.deadline_at as string,
    resultMessage: (row.result_message as string | null) ?? null,
    events,
  };
}

/** Safe, explainable remediation queue. Unknown issue types never receive a Quick Fix. */
export class RemediationService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly db: Database,
    private readonly products: ProductStore,
    private readonly enrichment: EnrichmentService,
    private readonly sync: SyncService,
    private readonly events: EventLog,
    private readonly logger: Logger,
  ) {}

  start(): void {
    const rows = this.db.all<{ id: string }>(`SELECT id FROM remediation_operations WHERE status IN ('queued', 'running', 'pending_google')`);
    for (const row of rows) this.schedule(row.id, 0);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  proposal(productName: string, issueCode: string): RemediationProposal | null {
    const product = this.products.getProduct(productName);
    const issue = product?.issues.find((candidate) => candidate.code === issueCode);
    if (!product || !issue || issue.resolvedAt) return null;
    return this.proposalFor(product.product.productAttributes ?? {}, issue);
  }

  proposals(productName: string): RemediationProposal[] {
    const product = this.products.getProduct(productName);
    if (!product) return [];
    return product.issues.map((issue) => this.proposalFor(product.product.productAttributes ?? {}, issue)).filter((proposal): proposal is RemediationProposal => !!proposal);
  }

  list(productName: string): RemediationOperation[] {
    return this.db
      .all(`SELECT * FROM remediation_operations WHERE product_name = ? ORDER BY created_at DESC LIMIT 20`, [productName])
      .map((row) => rowToOperation(row, this.listEvents(row.id as string)));
  }

  get(id: string): RemediationOperation | undefined {
    const row = this.db.get(`SELECT * FROM remediation_operations WHERE id = ?`, [id]);
    return row ? rowToOperation(row, this.listEvents(id)) : undefined;
  }

  create(productName: string, issueCode: string): RemediationOperation {
    const product = this.products.getProduct(productName);
    if (!product) throw new Error('Product not found in local snapshot.');
    const proposal = this.proposal(productName, issueCode);
    if (!proposal) throw new Error('This issue has no safe, deterministic Quick Fix. Review it manually.');
    const active = this.db.get<{ id: string }>(
      `SELECT id FROM remediation_operations WHERE product_name = ? AND issue_code = ? AND status IN ('queued', 'running', 'pending_google') LIMIT 1`,
      [productName, issueCode],
    );
    if (active) return this.get(active.id)!;
    const id = randomUUID();
    const createdAt = now();
    const deadlineAt = new Date(Date.now() + MAX_WAIT_MS).toISOString();
    this.db.run(
      `INSERT INTO remediation_operations (id, product_name, issue_code, attribute, proposed_value, status, created_at, updated_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      [id, productName, issueCode, proposal.attribute, proposal.proposedValue, createdAt, createdAt, deadlineAt],
    );
    this.addEvent(id, 'queued', 'Quick Fix approved and queued for background processing.');
    this.events.record('remediation.queued', `Quick Fix queued for ${product.offerId}`, { productName, payload: { id, issueCode, attribute: proposal.attribute } });
    this.schedule(id, 100);
    return this.get(id)!;
  }

  private proposalFor(attributes: Record<string, unknown>, issue: ProductIssueRecord): RemediationProposal | null {
    if (issue.code !== 'generic_title') return null;
    const brand = typeof attributes.brand === 'string' ? attributes.brand.trim() : '';
    const type = Array.isArray(attributes.productTypes) ? String(attributes.productTypes[0] ?? '').trim() : '';
    const color = typeof attributes.color === 'string' ? attributes.color.trim() : '';
    const proposedValue = [brand, type, color].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const currentTitle = typeof attributes.title === 'string' ? attributes.title.trim() : '';
    if (!brand || !type || !proposedValue || proposedValue === currentTitle) return null;
    return {
      issueCode: issue.code,
      attribute: 'title',
      proposedValue,
      evidence: 'Brand, product type and colour are already present as structured product attributes, so the replacement is deterministic and reviewable.',
      consequence: 'A clearer title can improve eligibility and listing relevance; Google may still keep the issue while it reprocesses the product.',
      remediation: `Push the generated title "${proposedValue}" through the linked supplemental data source and verify the refreshed product status.`,
    };
  }

  private schedule(id: string, delayMs: number): void {
    if (this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.run(id);
    }, delayMs);
    this.timers.set(id, timer);
  }

  private async run(id: string): Promise<void> {
    const operation = this.get(id);
    if (!operation || !ACTIVE.includes(operation.status)) return;
    const proposal = this.proposal(operation.productName, operation.issueCode);
    if (!proposal && operation.status !== 'pending_google') {
      this.finish(id, 'failed', 'The issue changed before the Quick Fix was submitted. Review the current product state.');
      return;
    }
    try {
      if (operation.status === 'queued' || operation.status === 'running') {
        this.update(id, 'running', null, null);
        this.addEvent(id, 'running', 'Background worker started the Quick Fix.');
        await this.enrichment.pushAttributes(operation.productName, { [operation.attribute]: operation.proposedValue });
        this.addEvent(id, 'submitted', 'Supplemental ProductInput accepted by the configured Merchant API client.');
        this.update(id, 'pending_google', null, 'Google is reprocessing the product; Product360 will continue checking independently.');
      }
      await this.reconcile(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, id }, 'Quick Fix failed');
      this.finish(id, 'failed', message);
    }
  }

  private async reconcile(id: string): Promise<void> {
    const operation = this.get(id);
    if (!operation || operation.status !== 'pending_google') return;
    if (new Date(operation.deadlineAt).getTime() <= Date.now()) {
      this.update(id, 'pending_google', null, 'Google is still processing this change. The operation remains visible for later refresh or notification reconciliation.');
      this.addEvent(id, 'processing', 'The 30-second monitoring window elapsed; the operation remains pending on Google.');
      return;
    }
    const product = await this.products.getProduct(operation.productName);
    if (!product) return this.finish(id, 'failed', 'The product is no longer present in the local snapshot.');
    await this.sync.refreshProduct(productIdFromName(operation.productName), 'remediation');
    const fresh = this.products.getProduct(operation.productName);
    if (fresh && !fresh.issues.some((issue) => issue.code === operation.issueCode)) {
      this.finish(id, 'succeeded', 'Google returned a refreshed product without the remediated issue.');
      this.events.record('remediation.succeeded', `Quick Fix succeeded for ${fresh.offerId}`, { productName: operation.productName, payload: { id } });
      return;
    }
    this.addEvent(id, 'processing', 'The issue is still present in the refreshed snapshot; waiting before checking again.');
    this.schedule(id, 5_000);
  }

  private update(id: string, status: RemediationStatus, completedAt: string | null, resultMessage: string | null): void {
    this.db.run('UPDATE remediation_operations SET status = ?, updated_at = ?, completed_at = ?, result_message = ? WHERE id = ?', [status, now(), completedAt, resultMessage, id]);
  }

  private finish(id: string, status: 'succeeded' | 'failed', message: string): void {
    this.update(id, status, now(), message);
    this.addEvent(id, status, message);
    const operation = this.get(id);
    if (operation) this.events.record(`remediation.${status}`, `Quick Fix ${status} for ${operation.productName}`, { productName: operation.productName, payload: { id, issueCode: operation.issueCode } });
  }

  private addEvent(operationId: string, type: string, message: string): void {
    this.db.run('INSERT INTO remediation_events (operation_id, event_type, message, created_at) VALUES (?, ?, ?, ?)', [operationId, type, message, now()]);
  }

  private listEvents(operationId: string): RemediationEvent[] {
    return this.db.all(`SELECT * FROM remediation_events WHERE operation_id = ? ORDER BY id`, [operationId]).map((row) => ({
      id: Number(row.id),
      operationId: row.operation_id as string,
      type: row.event_type as string,
      message: row.message as string,
      createdAt: row.created_at as string,
    }));
  }
}
