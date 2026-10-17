import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import type { Facets, Workflow, WorkflowCatalog, WorkflowRun } from '../lib/types';
import { Card, Empty, ErrorBox, JsonEditor, Spinner, StatusBadge, useToast } from '../components/ui';
import { AddStep, StepEditor, TriggerEditor } from '../components/StepForms';
import FlowCanvas from '../components/FlowCanvas';
import { RunLogModal, RunStatus } from './WorkflowsPage';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

type Definition = Omit<Workflow, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'nextRunAt' | 'running'>;

const EMPTY: Definition = {
  name: '',
  description: '',
  enabled: true,
  trigger: { type: 'manual' },
  steps: [{ type: 'select_products', filter: {} }],
};

export default function WorkflowEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const notify = useToast();
  const { t, tOr } = useI18n();
  const { formatDate } = useFormat();
  const isNew = !id;
  const catalog = useAsync(() => api.get<WorkflowCatalog>('/api/workflows/catalog'), []);
  const facets = useAsync(() => api.get<Facets>('/api/products/facets'), []);
  const existing = useAsync(() => (id ? api.get<Workflow>(`/api/workflows/${id}`) : Promise.resolve(null)), [id]);
  const runs = useAsync(() => (id ? api.get<{ runs: WorkflowRun[] }>(`/api/workflows/${id}/runs`) : Promise.resolve({ runs: [] })), [id]);
  const [def, setDef] = useState<Definition | null>(null);
  const [mode, setMode] = useState<'canvas' | 'form' | 'json'>(() => (localStorage.getItem('gmc.workflowEditorMode') as 'canvas' | 'form' | 'json') || 'canvas');
  const [serverErrors, setServerErrors] = useState<Record<number, string>>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ count: number; skippedSteps: string[]; products: { productId: string; offerId: string; title: string | null; status: string; issueCodes: string[] }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<WorkflowRun | null>(null);

  useEffect(() => {
    if (def) return;
    let template = (location.state as { template?: Definition } | null)?.template;
    // Deep link from Product360 panels: /workflows/new?template=<id>
    const templateId = new URLSearchParams(location.search).get('template');
    if (!template && templateId) {
      if (!catalog.data) return; // wait for the catalog
      const found = catalog.data.templates.find((tpl) => tpl.id === templateId);
      if (found) template = found.definition as Definition;
    }
    if (isNew) setDef(template ? { ...template } : { ...EMPTY });
    else if (existing.data) {
      const { id: _i, createdAt: _c, updatedAt: _u, lastRunAt: _l, nextRunAt: _n, running: _r, ...rest } = existing.data;
      setDef(rest);
    }
  }, [isNew, existing.data, location.state, location.search, catalog.data, def]);

  if (!def || !catalog.data) return existing.error ? <ErrorBox error={existing.error} /> : <Spinner />;

  const applyServerError = (err: unknown) => {
    const errors: Record<number, string> = {};
    let top: string | null = null;
    if (err instanceof ApiError && Array.isArray(err.details)) {
      for (const d of err.details as { path?: string; message?: string }[]) {
        const m = /^steps\.(\d+)(?:\.(.*))?$/.exec(d.path ?? '');
        if (m) errors[Number(m[1])] = `${m[2] ? m[2] + ': ' : ''}${d.message ?? 'invalid'}`;
        else top = `${d.path ? d.path + ': ' : ''}${d.message ?? ''}`;
      }
    }
    if (!Object.keys(errors).length && !top) top = (err as Error).message;
    setServerErrors(errors);
    setTopError(top);
    notify(Object.keys(errors).length ? t('wf.stepProblems', { n: Object.keys(errors).length }) : (err as Error).message, 'error');
  };

  const save = async () => {
    setBusy(true);
    setServerErrors({});
    setTopError(null);
    try {
      const saved = isNew ? await api.post<Workflow>('/api/workflows', def) : await api.put<Workflow>(`/api/workflows/${id}`, def);
      notify(t('wf.saved'), 'ok');
      if (isNew) navigate(`/workflows/${saved.id}`, { replace: true });
      else void existing.reload();
    } catch (err) {
      applyServerError(err);
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (m: 'canvas' | 'form' | 'json') => {
    setMode(m);
    localStorage.setItem('gmc.workflowEditorMode', m);
  };

  const doPreview = async () => {
    setBusy(true);
    try {
      setPreview(await api.post(`/api/workflows/preview`, def));
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const result = await api.post<WorkflowRun>(`/api/workflows/${id}/run?wait=true`, {});
      setRun(result);
      void runs.reload();
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <div className="muted small">
            <Link to="/workflows">{t('wf.title')}</Link> / {isNew ? t('common.new') : def.name}
          </div>
          <h1>{isNew ? t('wf.newTitle') : def.name}</h1>
        </div>
        <div className="page-actions">
          <span className="segmented">
            <button className={`btn btn-sm ${mode === 'canvas' ? 'active' : ''}`} onClick={() => switchMode('canvas')}>
              {t('wf.mode.visual')}
            </button>
            <button className={`btn btn-sm ${mode === 'form' ? 'active' : ''}`} onClick={() => switchMode('form')}>
              {t('wf.mode.form')}
            </button>
            <button className={`btn btn-sm ${mode === 'json' ? 'active' : ''}`} onClick={() => switchMode('json')}>
              {t('wf.mode.json')}
            </button>
          </span>
          <button className="btn" disabled={busy} onClick={doPreview}>
            {t('wf.preview')}
          </button>
          {!isNew && (
            <button className="btn" disabled={busy} onClick={runNow}>
              {t('wf.runNow')}
            </button>
          )}
          <button className="btn btn-primary" disabled={busy || !def.name || !def.steps.length} onClick={save}>
            {t('common.save')}
          </button>
        </div>
      </header>

      {topError && <ErrorBox error={topError} />}
      {mode === 'canvas' && (
        <>
          <Card className="flow-meta">
            <div className="flow-meta-row">
              <label>
                {t('common.name')}
                <input value={def.name} onChange={(e) => setDef({ ...def, name: e.target.value })} placeholder={t('wf.namePlaceholder')} />
              </label>
              <label>
                {t('common.description')}
                <input value={def.description} onChange={(e) => setDef({ ...def, description: e.target.value })} />
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={def.enabled} onChange={(e) => setDef({ ...def, enabled: e.target.checked })} /> {t('common.enabled')}
              </label>
            </div>
          </Card>
          <FlowCanvas value={{ trigger: def.trigger, steps: def.steps }} onChange={(v) => setDef({ ...def, ...v })} catalog={catalog.data} facets={facets.data} serverErrors={serverErrors} />
        </>
      )}
      {mode === 'json' && (
        <Card>
          <JsonEditor value={def} onChange={(v) => setDef(v as Definition)} rows={30} />
        </Card>
      )}
      {mode === 'form' && (
        <>
          <Card title={t('wf.general')}>
            <div className="grid-2">
              <label>
                {t('common.name')}
                <input value={def.name} onChange={(e) => setDef({ ...def, name: e.target.value })} />
              </label>
              <label>
                {t('common.description')}
                <input value={def.description} onChange={(e) => setDef({ ...def, description: e.target.value })} />
              </label>
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={def.enabled} onChange={(e) => setDef({ ...def, enabled: e.target.checked })} /> {t('common.enabled')}
            </label>
          </Card>

          <Card title={t('common.trigger')}>
            <TriggerEditor trigger={def.trigger} events={catalog.data.events} onChange={(trigger) => setDef({ ...def, trigger })} />
          </Card>

          <Card title={t('wf.steps')}>
            <p className="muted small">
              {t('wf.stepsHelp')} <code>{'{{offerId}}'}</code>, <code>{'{{title}}'}</code>, <code>{'{{attributes.brand}}'}</code>, <code>{'{{count}}'}</code>,{' '}
              <code>{'{{date}}'}</code>.
            </p>
            {def.steps.map((step, i) => (
              <StepEditor
                key={i}
                index={i}
                step={step}
                catalog={catalog.data!}
                facets={facets.data}
                onChange={(s) => setDef({ ...def, steps: def.steps.map((x, j) => (j === i ? s : x)) })}
                onRemove={() => setDef({ ...def, steps: def.steps.filter((_, j) => j !== i) })}
                onMove={(dir) => {
                  const steps = [...def.steps];
                  const j = i + dir;
                  if (j < 0 || j >= steps.length) return;
                  [steps[i], steps[j]] = [steps[j]!, steps[i]!];
                  setDef({ ...def, steps });
                }}
              />
            ))}
            <AddStep catalog={catalog.data} onAdd={(s) => setDef({ ...def, steps: [...def.steps, s] })} />
          </Card>
        </>
      )}

      {preview && (
        <Card
          title={t('wf.previewTitle', { n: preview.count })}
          actions={
            <button className="btn btn-sm" onClick={() => setPreview(null)}>
              {t('common.close')}
            </button>
          }
        >
          {preview.skippedSteps.length > 0 && <div className="muted small">{t('wf.previewSkipped', { steps: preview.skippedSteps.map((s) => tOr(`step.${s}`, s)).join(', ') })}</div>}
          {preview.products.length === 0 ? (
            <Empty>{t('wf.previewEmpty')}</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('products.offerId')}</th>
                  <th>{t('products.titleCol')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('common.issues')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.products.map((p) => (
                  <tr key={p.productId}>
                    <td>
                      <Link to={`/products/${p.productId}`}>{p.offerId}</Link>
                    </td>
                    <td>{p.title}</td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="muted small">{p.issueCodes.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview.count > preview.products.length && <div className="muted small">{t('wf.previewShowing', { n: preview.products.length })}</div>}
        </Card>
      )}

      {!isNew && (
        <Card title={t('wf.runs')}>
          {!runs.data?.runs.length ? (
            <Empty>{t('wf.noRuns')}</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.started')}</th>
                  <th>{t('common.trigger')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('common.stats')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.data.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="muted small">{formatDate(r.startedAt)}</td>
                    <td className="muted">{r.trigger}</td>
                    <td>
                      <RunStatus status={r.status} />
                    </td>
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
      )}
      {run && <RunLogModal run={run} onClose={() => setRun(null)} />}
    </div>
  );
}

