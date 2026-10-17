import { Cron } from 'croner';
import type { Logger } from '../util/logger.js';
import type { AppEvent, EventLog } from '../services/event-log.js';
import type { WorkflowEngine } from './engine.js';
import type { Workflow } from './schema.js';
import type { WorkflowStore } from './workflow-store.js';

interface PendingBatch {
  events: AppEvent[];
  timer: NodeJS.Timeout;
}

/**
 * Keeps cron jobs and event listeners in sync with the stored workflows.
 * Call `reload()` whenever a workflow is created / updated / deleted.
 */
export class WorkflowScheduler {
  private readonly cronJobs = new Map<number, Cron>();
  private readonly pending = new Map<number, PendingBatch>();
  private unsubscribe: (() => void) | null = null;
  private workflows: Workflow[] = [];

  constructor(
    private readonly store: WorkflowStore,
    private readonly engine: WorkflowEngine,
    private readonly events: EventLog,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.unsubscribe = this.events.on('*', (event) => this.onEvent(event));
    this.reload();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const job of this.cronJobs.values()) job.stop();
    this.cronJobs.clear();
    for (const batch of this.pending.values()) clearTimeout(batch.timer);
    this.pending.clear();
  }

  reload(): void {
    this.workflows = this.store.list().filter((w) => w.enabled);
    for (const job of this.cronJobs.values()) job.stop();
    this.cronJobs.clear();
    for (const workflow of this.workflows) {
      if (workflow.trigger.type !== 'schedule') continue;
      try {
        const job = new Cron(workflow.trigger.cron, { timezone: workflow.trigger.timezone, protect: true }, () => {
          this.logger.info({ workflow: workflow.name }, 'Scheduled workflow triggered');
          void this.engine.run(workflow, 'schedule').catch((err) => this.logger.error({ err }, 'Scheduled workflow failed'));
        });
        this.cronJobs.set(workflow.id, job);
      } catch (err) {
        this.logger.error({ err, workflow: workflow.name, cron: workflow.trigger.cron }, 'Invalid cron expression; workflow not scheduled');
      }
    }
    this.logger.info({ scheduled: this.cronJobs.size, eventDriven: this.workflows.filter((w) => w.trigger.type === 'event').length }, 'Workflow scheduler reloaded');
  }

  /** Next run times for the UI. */
  nextRuns(): Record<number, string | null> {
    const out: Record<number, string | null> = {};
    for (const [id, job] of this.cronJobs) out[id] = job.nextRun()?.toISOString() ?? null;
    return out;
  }

  /** Validates a cron expression (throws when invalid). */
  static validateCron(expression: string, timezone?: string): Date | null {
    const job = new Cron(expression, { timezone, paused: true });
    const next = job.nextRun();
    job.stop();
    return next;
  }

  private onEvent(event: AppEvent): void {
    for (const workflow of this.workflows) {
      if (workflow.trigger.type !== 'event' || workflow.trigger.event !== event.type) continue;
      // Ignore events produced by this very workflow to avoid loops.
      const payload = event.payload as { workflowId?: number } | null;
      if (payload?.workflowId === workflow.id) continue;
      const debounceMs = workflow.trigger.debounceSeconds * 1000;
      const existing = this.pending.get(workflow.id);
      if (existing) {
        existing.events.push(event);
        continue;
      }
      const batch: PendingBatch = {
        events: [event],
        timer: setTimeout(() => {
          this.pending.delete(workflow.id);
          const current = this.store.get(workflow.id);
          if (!current?.enabled) return;
          this.logger.info({ workflow: current.name, events: batch.events.length }, 'Event-triggered workflow starting');
          void this.engine.run(current, `event:${event.type}`, batch.events).catch((err) => this.logger.error({ err }, 'Event workflow failed'));
        }, debounceMs),
      };
      batch.timer.unref?.();
      this.pending.set(workflow.id, batch);
    }
  }
}
