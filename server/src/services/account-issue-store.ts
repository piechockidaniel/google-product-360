import { Database, fromJson, now, toJson, type Row } from '../db/database.js';
import type { AccountIssue } from '../google/types.js';
import { accountIssueFingerprint, severityToLevel, type IssueLevel } from './product-store.js';

export interface AccountIssueRecord {
  id: number;
  fingerprint: string;
  name: string | null;
  title: string | null;
  severity: string | null;
  level: IssueLevel;
  detail: string | null;
  documentationUri: string | null;
  impacted: AccountIssue['impactedDestinations'];
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

function rowToRecord(row: Row): AccountIssueRecord {
  const severity = (row.severity as string | null) ?? null;
  return {
    id: Number(row.id),
    fingerprint: row.fingerprint as string,
    name: (row.name as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    severity,
    level: severityToLevel(severity),
    detail: (row.detail as string | null) ?? null,
    documentationUri: (row.documentation_uri as string | null) ?? null,
    impacted: fromJson<AccountIssue['impactedDestinations']>(row.impacted, []),
    firstSeenAt: row.first_seen_at as string,
    lastSeenAt: row.last_seen_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? null,
  };
}

export class AccountIssueStore {
  constructor(private readonly db: Database) {}

  sync(issues: AccountIssue[], seenAt: string = now()): { newIssues: AccountIssueRecord[]; resolvedIssues: AccountIssueRecord[] } {
    const open = new Map(
      this.db.all<{ fingerprint: string; id: number }>('SELECT id, fingerprint FROM account_issues WHERE resolved_at IS NULL').map((r) => [r.fingerprint, r.id]),
    );
    const seen = new Set<string>();
    const newIssues: AccountIssueRecord[] = [];
    for (const issue of issues) {
      const fp = accountIssueFingerprint(issue.name, issue.title);
      if (seen.has(fp)) continue;
      seen.add(fp);
      const isNew = !open.has(fp);
      this.db.run(
        `INSERT INTO account_issues (fingerprint, name, title, severity, detail, documentation_uri, impacted, first_seen_at, last_seen_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(fingerprint) DO UPDATE SET title = excluded.title, severity = excluded.severity, detail = excluded.detail,
           documentation_uri = excluded.documentation_uri, impacted = excluded.impacted, last_seen_at = excluded.last_seen_at,
           first_seen_at = CASE WHEN account_issues.resolved_at IS NULL THEN account_issues.first_seen_at ELSE excluded.first_seen_at END,
           resolved_at = NULL`,
        [fp, issue.name ?? null, issue.title ?? null, issue.severity ?? null, issue.detail ?? null, issue.documentationUri ?? null, toJson(issue.impactedDestinations ?? []), seenAt, seenAt],
      );
      if (isNew) {
        const row = this.db.get('SELECT * FROM account_issues WHERE fingerprint = ?', [fp]);
        if (row) newIssues.push(rowToRecord(row));
      }
    }
    const resolvedIssues: AccountIssueRecord[] = [];
    for (const [fp, id] of open) {
      if (seen.has(fp)) continue;
      this.db.run('UPDATE account_issues SET resolved_at = ? WHERE id = ?', [seenAt, id]);
      const row = this.db.get('SELECT * FROM account_issues WHERE id = ?', [id]);
      if (row) resolvedIssues.push(rowToRecord(row));
    }
    return { newIssues, resolvedIssues };
  }

  list(options: { open?: boolean; since?: string } = {}): AccountIssueRecord[] {
    const where: string[] = [];
    const params: string[] = [];
    if (options.open) where.push('resolved_at IS NULL');
    if (options.since) {
      where.push('first_seen_at > ?');
      params.push(options.since);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.all(`SELECT * FROM account_issues ${whereSql} ORDER BY first_seen_at DESC`, params).map(rowToRecord);
  }
}
