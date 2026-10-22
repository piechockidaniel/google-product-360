import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { Operation, OperationEvent, OperationStatus, Product } from '../shared/types.js';
import { demoProducts } from './demo.js';

type OperationRow = {
  id: string;
  product_id: string;
  issue_code: string;
  status: OperationStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  result_message: string | null;
};

type EventRow = {
  id: number;
  operation_id: string;
  event_type: string;
  message: string;
  created_at: string;
};

export class DemoStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issues (
        product_id TEXT NOT NULL,
        code TEXT NOT NULL,
        title TEXT NOT NULL,
        severity TEXT NOT NULL,
        classification TEXT NOT NULL,
        source TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (product_id, code)
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        issue_code TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        result_message TEXT
      );
      CREATE TABLE IF NOT EXISTS operation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    this.seedProductsIfNeeded();
  }

  listProducts(): Product[] {
    const rows = this.database.prepare('SELECT payload FROM products ORDER BY id').all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as Product);
  }

  findProduct(productId: string): Product | undefined {
    const row = this.database.prepare('SELECT payload FROM products WHERE id = ?').get(productId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Product : undefined;
  }

  createOperation(productId: string, issueCode: string): Operation {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO operations (id, product_id, issue_code, status, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?)
    `).run(id, productId, issueCode, now, now);
    this.recordEvent(id, 'queued', 'Operation queued and waiting for the Demo worker.');
    return this.getOperation(id)!;
  }

  startOperation(operationId: string): void {
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE operations SET status = 'running', updated_at = ? WHERE id = ?`).run(now, operationId);
    this.recordEvent(operationId, 'running', 'Demo worker started the operation.');
  }

  completeOperation(operationId: string): void {
    const operation = this.getOperation(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} was not found.`);
    }

    const product = this.findProduct(operation.productId);
    if (!product) {
      throw new Error(`Product ${operation.productId} was not found.`);
    }

    const remainingIssues = product.issues.filter((issue) => issue.code !== operation.issueCode);
    const updatedProduct: Product = {
      ...product,
      issues: remainingIssues,
      issueSummary: remainingIssues.length === 0 ? 'No active issues' : remainingIssues.map((issue) => issue.title).join(' · '),
      status: remainingIssues.some((issue) => issue.severity === 'error')
        ? 'Disapproved'
        : remainingIssues.length > 0 ? 'Limited' : 'Approved',
    };
    const now = new Date().toISOString();
    this.database.prepare('UPDATE products SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(updatedProduct), now, product.id);
    this.database.prepare('DELETE FROM issues WHERE product_id = ? AND code = ?').run(product.id, operation.issueCode);
    this.database.prepare(`
      UPDATE operations
      SET status = 'succeeded', updated_at = ?, completed_at = ?, result_message = ?
      WHERE id = ?
    `).run(now, now, 'The Demo remediation completed and the issue is no longer active.', operationId);
    this.recordEvent(operationId, 'succeeded', 'Product snapshot updated; issue cleared in Demo mode.');
  }

  failOperation(operationId: string, message: string): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE operations
      SET status = 'failed', updated_at = ?, completed_at = ?, result_message = ?
      WHERE id = ?
    `).run(now, now, message, operationId);
    this.recordEvent(operationId, 'failed', message);
  }

  getOperation(operationId: string): Operation | undefined {
    const row = this.database.prepare('SELECT * FROM operations WHERE id = ?').get(operationId) as OperationRow | undefined;
    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      productId: row.product_id,
      issueCode: row.issue_code,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      resultMessage: row.result_message,
      events: this.getEvents(operationId),
    };
  }

  getPendingOperationIds(): string[] {
    const rows = this.database.prepare(`SELECT id FROM operations WHERE status IN ('queued', 'running')`).all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  hasActiveOperation(productId: string, issueCode: string): boolean {
    const row = this.database.prepare(`
      SELECT id FROM operations
      WHERE product_id = ? AND issue_code = ? AND status IN ('queued', 'running')
      LIMIT 1
    `).get(productId, issueCode) as { id: string } | undefined;
    return Boolean(row);
  }

  private getEvents(operationId: string): OperationEvent[] {
    const rows = this.database.prepare(`
      SELECT id, operation_id, event_type, message, created_at
      FROM operation_events WHERE operation_id = ? ORDER BY id
    `).all(operationId) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      operationId: row.operation_id,
      type: row.event_type,
      message: row.message,
      createdAt: row.created_at,
    }));
  }

  private recordEvent(operationId: string, eventType: string, message: string): void {
    this.database.prepare(`
      INSERT INTO operation_events (operation_id, event_type, message, created_at)
      VALUES (?, ?, ?, ?)
    `).run(operationId, eventType, message, new Date().toISOString());
  }

  private seedProductsIfNeeded(): void {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM products').get() as { count: number };
    if (row.count > 0) {
      return;
    }

    this.database.exec('BEGIN');
    try {
      const productStatement = this.database.prepare('INSERT INTO products (id, payload, updated_at) VALUES (?, ?, ?)');
      const issueStatement = this.database.prepare(`
        INSERT INTO issues (product_id, code, title, severity, classification, source, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const product of demoProducts) {
        productStatement.run(product.id, JSON.stringify(product), now);
        for (const issue of product.issues) {
          issueStatement.run(product.id, issue.code, issue.title, issue.severity, issue.classification, issue.source, JSON.stringify(issue));
        }
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
