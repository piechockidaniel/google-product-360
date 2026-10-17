import { EventEmitter } from 'node:events';
import { Database, fromJson, now, toJson, type Row } from '../db/database.js';

export type EventSeverity = 'info' | 'warning' | 'error';

export interface AppEvent {
  id: number;
  type: string;
  severity: EventSeverity;
  message: string;
  payload: unknown;
  productName: string | null;
  createdAt: string;
}

/** Names of in-process events that workflows can subscribe to. */
export type WorkflowTriggerEvent = 'sync.completed' | 'issue.new' | 'issue.resolved' | 'product.status_changed' | 'notification.received' | 'metrics.synced' | 'signal.changed';
export const WORKFLOW_TRIGGER_EVENTS: WorkflowTriggerEvent[] = ['sync.completed', 'issue.new', 'issue.resolved', 'product.status_changed', 'notification.received', 'metrics.synced', 'signal.changed'];

export interface EventQuery {
  since?: string;
  type?: string;
  types?: string[];
  severity?: EventSeverity[];
  limit?: number;
  offset?: number;
}

function rowToEvent(row: Row): AppEvent {
  return {
    id: Number(row.id),
    type: row.type as string,
    severity: row.severity as EventSeverity,
    message: row.message as string,
    payload: fromJson<unknown>(row.payload, null),
    productName: (row.product_name as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

/**
 * Persistent activity trail + in-process event bus. Everything noteworthy
 * (sync results, new/resolved issues, notifications from Google, workflow
 * actions) is recorded here, and listeners (workflow engine) can react.
 */
export class EventLog {
  private readonly emitter = new EventEmitter();

  constructor(private readonly db: Database) {
    this.emitter.setMaxListeners(100);
  }

  record(type: string, message: string, options: { severity?: EventSeverity; payload?: unknown; productName?: string | null } = {}): AppEvent {
    const createdAt = now();
    const result = this.db.run('INSERT INTO events (type, severity, message, payload, product_name, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      type,
      options.severity ?? 'info',
      message,
      options.payload === undefined ? null : toJson(options.payload),
      options.productName ?? null,
      createdAt,
    ]);
    const event: AppEvent = {
      id: Number(result.lastInsertRowid),
      type,
      severity: options.severity ?? 'info',
      message,
      payload: options.payload ?? null,
      productName: options.productName ?? null,
      createdAt,
    };
    this.emitter.emit(type, event);
    this.emitter.emit('*', event);
    return event;
  }

  on(type: WorkflowTriggerEvent | '*' | string, listener: (event: AppEvent) => void): () => void {
    this.emitter.on(type, listener);
    return () => this.emitter.off(type, listener);
  }

  list(query: EventQuery = {}): { items: AppEvent[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.since) {
      where.push('created_at > ?');
      params.push(query.since);
    }
    if (query.type) {
      where.push('type = ?');
      params.push(query.type);
    }
    if (query.types?.length) {
      where.push(`type IN (${query.types.map(() => '?').join(',')})`);
      params.push(...query.types);
    }
    if (query.severity?.length) {
      where.push(`severity IN (${query.severity.map(() => '?').join(',')})`);
      params.push(...query.severity);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    const offset = Math.max(query.offset ?? 0, 0);
    const total = Number(this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM events ${whereSql}`, params)?.c ?? 0);
    const rows = this.db.all(`SELECT * FROM events ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { items: rows.map(rowToEvent), total };
  }

  /** Removes events older than the given number of days. */
  prune(days: number): number {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    return this.db.run('DELETE FROM events WHERE created_at < ?', [cutoff]).changes;
  }
}
