import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useAsync, useInterval } from '../lib/hooks';
import type { Workflow, WorkflowCatalog, WorkflowRun } from '../lib/types';
import { Badge, Card, Confirm, Empty, ErrorBox, LevelBadge, Modal, Spinner, useToast } from '../components/ui';
import { blockMeta } from '../lib/workflow-blocks';

export function describeTrigger(trigger: Workflow['trigger'], t: (key: 'wf.trigger.manual' | 'wf.trigger.schedule' | 'wf.trigger.event', p?: Record<string, string>) => string): string {
  if (trigger.type === 'manual') return t('wf.trigger.manual');
  if (trigger.type === 'schedule') return `${t('wf.trigger.schedule', { cron: trigger.cron })}${trigger.timezone ? ` (${trigger.timezone})` : ''}`;
  return t('wf.trigger.event', { event: trigger.event });
}

/** Compact icon chain of a workflow's steps. */
export function StepChips({ steps, catalog }: { steps: Workflow['steps']; catalog: WorkflowCatalog | null }) {
  const { tOr } = useI18n();
  return (
    <span className="step-chips">
      {steps.map((s, i) => {
        const meta = blockMeta(s.type);
        const label = tOr(`step.${s.type}`, catalog?.steps.find((c) => c.type === s.type)?.label ?? s.type);
        return (
          <span key={i} className={`step-chip tone-${meta.tone}`} title={label}>
            <span className="node-icon">{meta.icon}</span>
          </span>
        );
      })}
    </span>
  );
}

export function RunStatus({ status }: { status: WorkflowRun['status'] }) {
  const { t } = useI18n();
  return <Badge tone={status === 'success' ? 'ok' : status === 'failed' ? 'error' : status === 'running' ? 'info' : 'neutral'}>{t(`common.${status}`)}</Badge>;
}

export default function WorkflowsPage() {
  const notify = useToast();
  const navigate = useNavigate();
  const { t, tOr } = useI18n();
  const { formatDate, timeAgo } = useFormat();
  const workflows = useAsync(() => api.get<{ workflows: Workflow[] }>('/api/workflows'), []);
  const runs = useAsync(() => api.get<{ runs: WorkflowRun[] }>('/api/workflow-runs'), []);
  const catalog = useAsync(() => api.get<WorkflowCatalog>('/api/workflows/catalog'), []);
  const [templates, setTemplates] = useState(false);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const anyRunning = workflows.data?.workflows.some((w) => w.running) || runs.data?.runs.some((r) => r.status === 'running');
  useInterval(() => {
    void workflows.reload();
    void runs.reload();
  }, anyRunning ? 2000 : 30000);

  const runNow = async (w: Workflow) => {
    try {
      await api.post(`/api/workflows/${w.id}/run`);
      notify(t('wf.started', { name: w.name }), 'ok');
      setTimeout(() => {
        void workflows.reload();
        void runs.reload();
      }, 800);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  const toggle = async (w: Workflow) => {
    try {
      await api.put(`/api/workflows/${w.id}`, { enabled: !w.enabled });
      await workflows.reload();
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('wf.title')}</h1>
        <div className="page-actions">
          <button className="btn" onClick={() => setTemplates(true)}>
            {t('wf.fromTemplate')}
          </button>
          <Link className="btn btn-primary" to="/workflows/new">
            {t('wf.new')}
          </Link>
        </div>
      </header>

      <ErrorBox error={workflows.error} onRetry={workflows.reload} />
      {workflows.loading && !workflows.data ? (
        <Spinner />
      ) : !workflows.data?.workflows.length ? (
        <Empty>
          {t('wf.empty')}{' '}
          <a href="#" onClick={(e) => (e.preventDefault(), setTemplates(true))}>
            {t('wf.emptyLink')}
          </a>
          .
        </Empty>
      ) : (
        <Card>
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('common.trigger')}</th>
                <th>{t('wf.steps')}</th>
                <th>{t('wf.lastRun')}</th>
                <th>{t('wf.nextRun')}</th>
                <th>{t('common.enabled')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {workflows.data.workflows.map((w) => (
                <tr key={w.id}>
                  <td>
                    <Link to={`/workflows/${w.id}`}>{w.name}</Link>
                    {w.running && <Badge tone="info">{t('common.running')}</Badge>}
                    {w.description && <div className="muted small">{w.description}</div>}
                  </td>
                  <td className="muted">{describeTrigger(w.trigger, t)}</td>
                  <td>
                    <StepChips steps={w.steps} catalog={catalog.data} />
                  </td>
                  <td className="muted small">{w.lastRunAt ? timeAgo(w.lastRunAt) : t('common.never')}</td>
                  <td className="muted small">{w.nextRunAt ? formatDate(w.nextRunAt) : '–'}</td>
                  <td>
                    <label className="switch">
                      <input type="checkbox" checked={w.enabled} onChange={() => toggle(w)} />
                    </label>
                  </td>
                  <td className="actions">
                    <button className="btn btn-sm" onClick={() => runNow(w)} disabled={w.running}>
                      {t('wf.runNow')}
                    </button>
                    <Link className="btn btn-sm" to={`/workflows/${w.id}`}>
                      {t('common.edit')}
                    </Link>
                    <Confirm
                      message={t('common.confirmDelete', { name: w.name })}
                      onConfirm={async () => {
                        await api.delete(`/api/workflows/${w.id}`);
                        await workflows.reload();
                      }}
                    >
                      {t('common.delete')}
                    </Confirm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title={t('wf.recentRuns')}>
        {!runs.data?.runs.length ? (
          <Empty>{t('wf.noRuns')}</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('nav.workflows')}</th>
                <th>{t('common.trigger')}</th>
                <th>{t('common.status')}</th>
                <th>{t('common.started')}</th>
                <th>{t('common.stats')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.data.runs.slice(0, 30).map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/workflows/${r.workflowId}`}>{r.workflowName ?? r.workflowId}</Link>
                  </td>
                  <td className="muted">{r.trigger}</td>
                  <td>
                    <RunStatus status={r.status} />
                  </td>
                  <td className="muted small">{formatDate(r.startedAt)}</td>
                  <td className="muted small">
                    {Object.entries(r.stats)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(', ')}
                    {r.error && <div className="field-error">{r.error}</div>}
                  </td>
                  <td>
                    <button className="btn btn-sm" onClick={() => setRun(r)}>
                      {t('common.log')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {run && <RunLogModal run={run} onClose={() => setRun(null)} />}

      {templates && catalog.data && (
        <Modal title={t('wf.templates')} onClose={() => setTemplates(false)} wide>
          <ul className="template-list">
            {catalog.data.templates.map((tpl) => (
              <li key={tpl.id}>
                <div>
                  <strong>{tOr(`tpl.${tpl.id}`, tpl.title)}</strong>
                  <div className="muted small">{tOr(`tpl.${tpl.id}.d`, tpl.description)}</div>
                  <div className="muted small">
                    {describeTrigger(tpl.definition.trigger, t)} · <StepChips steps={tpl.definition.steps} catalog={catalog.data} />
                  </div>
                </div>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    setTemplates(false);
                    navigate('/workflows/new', { state: { template: { ...tpl.definition, name: tOr(`tpl.${tpl.id}`, tpl.definition.name) } } });
                  }}
                >
                  {t('wf.use')}
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}

export function RunLogModal({ run, onClose }: { run: WorkflowRun; onClose: () => void }) {
  const { t } = useI18n();
  const { formatDate } = useFormat();
  return (
    <Modal title={t('wf.run', { id: run.id, name: run.workflowName ?? '' })} onClose={onClose} wide>
      <div className="small muted">
        <RunStatus status={run.status} /> {t('wf.runMeta', { trigger: run.trigger, started: formatDate(run.startedAt), finished: formatDate(run.finishedAt) })}
      </div>
      {run.error && <div className="field-error">{run.error}</div>}
      <table className="table log-table">
        <tbody>
          {run.log.map((l, i) => (
            <tr key={i}>
              <td className="muted small nowrap">{new Date(l.time).toLocaleTimeString()}</td>
              <td>
                <LevelBadge level={l.level} />
              </td>
              <td className="muted small nowrap">{l.step ? `${l.step}. ${l.stepType}` : ''}</td>
              <td>
                {l.message}
                {l.data !== undefined && <pre className="code-block small">{JSON.stringify(l.data, null, 2)}</pre>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
