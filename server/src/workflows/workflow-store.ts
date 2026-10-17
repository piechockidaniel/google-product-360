import { Database, fromJson, now, toJson, type Row } from '../db/database.js';
import { workflowDefinitionSchema, type Step, type Trigger, type Workflow, type WorkflowDefinition } from './schema.js';

export interface RunLogEntry {
  time: string;
  level: 'info' | 'warning' | 'error';
  step?: number;
  stepType?: string;
  message: string;
  data?: unknown;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  workflowName?: string;
  trigger: string;
  status: 'running' | 'success' | 'failed' | 'stopped';
  startedAt: string;
  finishedAt: string | null;
  log: RunLogEntry[];
  stats: Record<string, number>;
  error: string | null;
}

function rowToWorkflow(row: Row): Workflow {
  return {
    id: Number(row.id),
    name: row.name as string,
    description: (row.description as string) ?? '',
    enabled: Number(row.enabled) === 1,
    trigger: fromJson<Trigger>(row.trigger, { type: 'manual' }),
    steps: fromJson<Step[]>(row.steps, []),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastRunAt: (row.last_run_at as string | null) ?? null,
  };
}

function rowToRun(row: Row): WorkflowRun {
  return {
    id: Number(row.id),
    workflowId: Number(row.workflow_id),
    workflowName: (row.workflow_name as string | undefined) ?? undefined,
    trigger: row.trigger as string,
    status: row.status as WorkflowRun['status'],
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    log: fromJson<RunLogEntry[]>(row.log, []),
    stats: fromJson<Record<string, number>>(row.stats, {}),
    error: (row.error as string | null) ?? null,
  };
}

export class WorkflowStore {
  constructor(private readonly db: Database) {}

  list(): Workflow[] {
    return this.db.all('SELECT * FROM workflows ORDER BY name').map(rowToWorkflow);
  }

  get(id: number): Workflow | undefined {
    const row = this.db.get('SELECT * FROM workflows WHERE id = ?', [id]);
    return row ? rowToWorkflow(row) : undefined;
  }

  create(input: unknown): Workflow {
    const def: WorkflowDefinition = workflowDefinitionSchema.parse(input);
    const ts = now();
    const result = this.db.run('INSERT INTO workflows (name, description, enabled, trigger, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      def.name,
      def.description,
      def.enabled ? 1 : 0,
      toJson(def.trigger),
      toJson(def.steps),
      ts,
      ts,
    ]);
    return this.get(Number(result.lastInsertRowid))!;
  }

  update(id: number, input: unknown): Workflow | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const def = workflowDefinitionSchema.parse({ ...existing, ...(input as object) });
    this.db.run('UPDATE workflows SET name = ?, description = ?, enabled = ?, trigger = ?, steps = ?, updated_at = ? WHERE id = ?', [
      def.name,
      def.description,
      def.enabled ? 1 : 0,
      toJson(def.trigger),
      toJson(def.steps),
      now(),
      id,
    ]);
    return this.get(id);
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM workflows WHERE id = ?', [id]).changes > 0;
  }

  // ---------------------------------------------------------------- runs
  startRun(workflowId: number, trigger: string): WorkflowRun {
    const ts = now();
    const result = this.db.run("INSERT INTO workflow_runs (workflow_id, trigger, status, started_at) VALUES (?, ?, 'running', ?)", [workflowId, trigger, ts]);
    this.db.run('UPDATE workflows SET last_run_at = ? WHERE id = ?', [ts, workflowId]);
    return this.getRun(Number(result.lastInsertRowid))!;
  }

  finishRun(id: number, status: WorkflowRun['status'], log: RunLogEntry[], stats: Record<string, number>, error: string | null): WorkflowRun {
    this.db.run('UPDATE workflow_runs SET status = ?, finished_at = ?, log = ?, stats = ?, error = ? WHERE id = ?', [status, now(), toJson(log), toJson(stats), error, id]);
    return this.getRun(id)!;
  }

  /** Persists intermediate progress so long runs can be watched. */
  progressRun(id: number, log: RunLogEntry[], stats: Record<string, number>): void {
    this.db.run('UPDATE workflow_runs SET log = ?, stats = ? WHERE id = ?', [toJson(log), toJson(stats), id]);
  }

  getRun(id: number): WorkflowRun | undefined {
    const row = this.db.get('SELECT r.*, w.name AS workflow_name FROM workflow_runs r LEFT JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?', [id]);
    return row ? rowToRun(row) : undefined;
  }

  listRuns(options: { workflowId?: number; limit?: number; since?: string } = {}): WorkflowRun[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.workflowId) {
      where.push('r.workflow_id = ?');
      params.push(options.workflowId);
    }
    if (options.since) {
      where.push('r.started_at > ?');
      params.push(options.since);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .all(`SELECT r.*, w.name AS workflow_name FROM workflow_runs r LEFT JOIN workflows w ON w.id = r.workflow_id ${whereSql} ORDER BY r.id DESC LIMIT ?`, [
        ...params,
        options.limit ?? 50,
      ])
      .map(rowToRun);
  }

  /** Marks runs left in `running` state (e.g. after a crash) as failed. */
  failStaleRuns(): number {
    return this.db.run("UPDATE workflow_runs SET status = 'failed', finished_at = ?, error = 'Interrupted (server restart)' WHERE status = 'running'", [now()]).changes;
  }
}
