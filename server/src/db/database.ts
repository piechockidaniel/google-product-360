import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type Row = Record<string, unknown>;
export type Params = SQLInputValue[] | Record<string, SQLInputValue>;

/**
 * Thin synchronous wrapper around Node's built-in SQLite driver.
 * Everything the app does with SQL goes through this class, so swapping the
 * driver (e.g. for better-sqlite3 or Postgres) only touches this file.
 */
export class Database {
  private readonly db: DatabaseSync;
  /** Prepared statements keyed by SQL – bulk upserts run the same statement thousands of times. */
  private readonly statements = new Map<string, StatementSync>();

  constructor(filePath: string) {
    if (filePath !== ':memory:') {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  private prepare(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      if (this.statements.size >= 500) this.statements.clear();
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  run(sql: string, params: Params = []): { changes: number; lastInsertRowid: number | bigint } {
    const stmt = this.prepare(sql);
    const result = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  get<T extends Row = Row>(sql: string, params: Params = []): T | undefined {
    const stmt = this.prepare(sql);
    const row = Array.isArray(params) ? stmt.get(...params) : stmt.get(params);
    return row as T | undefined;
  }

  all<T extends Row = Row>(sql: string, params: Params = []): T[] {
    const stmt = this.prepare(sql);
    const rows = Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
    return rows as T[];
  }

  exec(sql: string): void {
    // Schema changes invalidate prepared statements.
    this.statements.clear();
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
    const applied = new Set(this.all<{ id: number }>('SELECT id FROM schema_migrations').map((r) => r.id));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.run('INSERT INTO schema_migrations (id, name) VALUES (?, ?)', [migration.id, migration.name]);
      });
    }
  }
}

/** ISO-8601 timestamp in UTC with millisecond precision. */
export function now(): string {
  return new Date().toISOString();
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
