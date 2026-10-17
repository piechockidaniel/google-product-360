import { useState } from 'react';
import type { Facets, Trigger, WorkflowCatalog, WorkflowStep } from '../lib/types';
import { Badge, JsonEditor, Spinner } from './ui';
import AttributeForm from './AttributeForm';
import { useI18n } from '../lib/i18n';

/**
 * Parameter forms for workflow triggers and steps. Shared by the form editor
 * and the visual (canvas) editor's inspector panel.
 */
// ---------------------------------------------------------------- trigger
export function TriggerEditor({ trigger, events, onChange }: { trigger: Trigger; events: string[]; onChange: (t: Trigger) => void }) {
  const { t } = useI18n();
  return (
    <div className="grid-3">
      <label>
        {t('wf.triggerType')}
        <select
          value={trigger.type}
          onChange={(e) => {
            const type = e.target.value as Trigger['type'];
            if (type === 'manual') onChange({ type });
            else if (type === 'schedule') onChange({ type, cron: '0 6 * * *' });
            else onChange({ type, event: 'sync.completed', debounceSeconds: 30 });
          }}
        >
          <option value="manual">{t('wf.triggerManual')}</option>
          <option value="schedule">{t('wf.triggerSchedule')}</option>
          <option value="event">{t('wf.triggerEvent')}</option>
        </select>
      </label>
      {trigger.type === 'schedule' && (
        <>
          <label>
            {t('wf.cron')} <span className="muted">{t('wf.cronHint')}</span>
            <input value={trigger.cron} onChange={(e) => onChange({ ...trigger, cron: e.target.value })} placeholder="0 6 * * *" />
          </label>
          <label>
            {t('wf.timezone')}
            <input value={trigger.timezone ?? ''} onChange={(e) => onChange({ ...trigger, timezone: e.target.value || undefined })} placeholder="Europe/Warsaw" />
          </label>
        </>
      )}
      {trigger.type === 'event' && (
        <>
          <label>
            {t('wf.event')}
            <select value={trigger.event} onChange={(e) => onChange({ ...trigger, event: e.target.value })}>
              {events.map((ev) => (
                <option key={ev} value={ev}>
                  {ev}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('wf.debounce')} <span className="muted">{t('wf.debounceHint')}</span>
            <input type="number" min={0} value={trigger.debounceSeconds ?? 30} onChange={(e) => onChange({ ...trigger, debounceSeconds: Number(e.target.value) })} />
          </label>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- steps
export function AddStep({ catalog, onAdd }: { catalog: WorkflowCatalog; onAdd: (s: WorkflowStep) => void }) {
  const { t, tOr } = useI18n();
  return (
    <div className="inline-form">
      <select
        value=""
        onChange={(e) => {
          const def = catalog.steps.find((s) => s.type === e.target.value);
          if (def) onAdd({ ...(def.example as WorkflowStep) });
        }}
      >
        <option value="">{t('wf.addStep')}</option>
        {catalog.steps.map((s) => (
          <option key={s.type} value={s.type}>
            {tOr(`step.${s.type}`, s.label)} – {tOr(`step.${s.type}.d`, s.description)}
          </option>
        ))}
      </select>
    </div>
  );
}

export const STATUSES = ['APPROVED', 'PARTIALLY_APPROVED', 'DISAPPROVED', 'PENDING', 'NOT_ELIGIBLE', 'UNKNOWN'];

export function StepEditor({
  index,
  step,
  catalog,
  facets,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  step: WorkflowStep;
  catalog: WorkflowCatalog;
  facets: Facets | null;
  onChange: (s: WorkflowStep) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const def = catalog.steps.find((s) => s.type === step.type);
  const { t, tOr } = useI18n();
  const [json, setJson] = useState(false);
  const set = (patch: Record<string, unknown>) => onChange({ ...step, ...patch });
  const { type: _t, ...params } = step;

  return (
    <div className="step">
      <div className="step-header">
        <span className="step-index">{index + 1}</span>
        <select
          value={step.type}
          onChange={(e) => {
            const next = catalog.steps.find((s) => s.type === e.target.value);
            if (next) onChange({ ...(next.example as WorkflowStep) });
          }}
        >
          {catalog.steps.map((s) => (
            <option key={s.type} value={s.type}>
              {tOr(`step.${s.type}`, s.label)}
            </option>
          ))}
        </select>
        <span className="muted small step-desc">{tOr(`step.${step.type}.d`, def?.description ?? '')}</span>
        <span className="step-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => setJson(!json)}>
            {json ? t('wf.form') : t('wf.json')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => onMove(-1)}>
            ↑
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => onMove(1)}>
            ↓
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onRemove}>
            ✕
          </button>
        </span>
      </div>
      <div className="step-body">
        {json ? (
          <JsonEditor value={params} onChange={(v) => onChange({ type: step.type, ...(v as Record<string, unknown>) })} rows={8} />
        ) : (
          <StepForm step={step} set={set} facets={facets} catalog={catalog} onJson={() => setJson(true)} />
        )}
      </div>
    </div>
  );
}

export function StepForm({ step, set, facets, catalog, onJson }: { step: WorkflowStep; set: (patch: Record<string, unknown>) => void; facets: Facets | null; catalog: WorkflowCatalog; onJson: () => void }) {
  const { t } = useI18n();
  switch (step.type) {
    case 'select_products': {
      const filter = (step.filter as Record<string, unknown>) ?? {};
      const setFilter = (patch: Record<string, unknown>) => {
        const next = { ...filter, ...patch };
        for (const k of Object.keys(next)) if (next[k] === '' || next[k] === undefined || (Array.isArray(next[k]) && !(next[k] as unknown[]).length)) delete next[k];
        set({ filter: next });
      };
      const statuses = (filter.status as string[]) ?? [];
      return (
        <div className="grid-3">
          <label>
            {t('wf.f.statusAny')}
            <div className="checkbox-group">
              {STATUSES.map((s) => (
                <label key={s} className="checkbox small">
                  <input
                    type="checkbox"
                    checked={statuses.includes(s)}
                    onChange={(e) => setFilter({ status: e.target.checked ? [...statuses, s] : statuses.filter((x) => x !== s) })}
                  />{' '}
                  {t(`status.${s}` as 'status.APPROVED')}
                </label>
              ))}
            </div>
          </label>
          <label>
            {t('wf.f.hasIssues')}
            <select value={filter.hasIssues === undefined ? '' : String(filter.hasIssues)} onChange={(e) => setFilter({ hasIssues: e.target.value === '' ? undefined : e.target.value === 'true' })}>
              <option value="">{t('common.any')}</option>
              <option value="true">{t('wf.s.withIssues')}</option>
              <option value="false">{t('wf.s.withoutIssues')}</option>
            </select>
          </label>
          <label>
            {t('wf.f.issueCode')}
            <select value={(filter.issueCode as string) ?? ''} onChange={(e) => setFilter({ issueCode: e.target.value })}>
              <option value="">{t('common.any')}</option>
              {facets?.issueCodes.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('wf.f.tag')}
            <input value={(filter.tag as string) ?? ''} onChange={(e) => setFilter({ tag: e.target.value })} list="tags-list" />
            <datalist id="tags-list">{facets?.tags.map((t) => <option key={t.tag} value={t.tag} />)}</datalist>
          </label>
          <label>
            {t('wf.f.feedLabel')}
            <input value={(filter.feedLabel as string) ?? ''} onChange={(e) => setFilter({ feedLabel: e.target.value })} />
          </label>
          <label>
            {t('wf.f.brand')}
            <input value={(filter.brand as string) ?? ''} onChange={(e) => setFilter({ brand: e.target.value })} />
          </label>
          <label>
            {t('wf.f.availability')}
            <input value={(filter.availability as string) ?? ''} onChange={(e) => setFilter({ availability: e.target.value })} placeholder="IN_STOCK" />
          </label>
          <label>
            {t('wf.f.textSearch')}
            <input value={(filter.q as string) ?? ''} onChange={(e) => setFilter({ q: e.target.value })} />
          </label>
          <label>
            {t('wf.f.limit')}
            <input type="number" min={1} value={(filter.limit as number) ?? ''} onChange={(e) => setFilter({ limit: e.target.value ? Number(e.target.value) : undefined })} />
          </label>
        </div>
      );
    }
    case 'select_by_signal': {
      const chosen = (step.recommendation as string[]) ?? [];
      return (
        <div className="grid-3">
          <label>
            {t('wf.f.recommendation')}
            <div className="checkbox-group">
              {(catalog.recommendations ?? []).map((r) => (
                <label key={r} className="checkbox small">
                  <input type="checkbox" checked={chosen.includes(r)} onChange={(e) => set({ recommendation: e.target.checked ? [...chosen, r] : chosen.filter((x) => x !== r) })} />{' '}
                  {t(`reco.${r}` as 'reco.SCALE')}
                </label>
              ))}
            </div>
          </label>
          <label>
            {t('wf.f.minDemand')} <span className="muted">0–100</span>
            <input type="number" min={0} max={100} value={(step.minDemand as number) ?? ''} onChange={(e) => set({ minDemand: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </label>
          <label>
            {t('wf.f.minImpressions')}
            <input type="number" min={0} value={(step.minImpressions7d as number) ?? ''} onChange={(e) => set({ minImpressions7d: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </label>
          <label>
            {t('wf.f.category')}
            <input value={(step.category as string) ?? ''} onChange={(e) => set({ category: e.target.value || undefined })} list="category-list" />
            <datalist id="category-list">{facets?.categories.map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label>
            {t('wf.f.limit')}
            <input type="number" min={1} value={(step.limit as number) ?? ''} onChange={(e) => set({ limit: e.target.value ? Number(e.target.value) : undefined })} />
          </label>
        </div>
      );
    }
    case 'set_sale_price':
      return (
        <div className="grid-3">
          <label>
            {t('wf.f.salePrice')} <span className="muted">{t('wf.f.salePriceHint')}</span>
            <input value={(step.price as string) ?? ''} onChange={(e) => set({ price: e.target.value })} placeholder="-10%" />
          </label>
          <label>
            {t('wf.f.saleFrom')} <span className="muted">{t('wf.f.relativeHint')}</span>
            <input value={(step.from as string) ?? 'now'} onChange={(e) => set({ from: e.target.value })} placeholder="now" />
          </label>
          <label>
            {t('wf.f.saleTo')}
            <input value={(step.to as string) ?? ''} onChange={(e) => set({ to: e.target.value })} placeholder="+3d" />
          </label>
          <label>
            {t('wf.f.currency')} <span className="muted">{t('wf.f.currencyHint')}</span>
            <input value={(step.currency as string) ?? ''} onChange={(e) => set({ currency: e.target.value.toUpperCase() || undefined })} placeholder="PLN" maxLength={3} />
          </label>
          <label className="checkbox small">
            <input type="checkbox" checked={step.continueOnError !== false} onChange={(e) => set({ continueOnError: e.target.checked })} /> {t('wf.f.continueOnError')}
          </label>
        </div>
      );
    case 'select_event_products': {
      const levels = (step.levels as string[]) ?? [];
      return (
        <div className="grid-2">
          <label>
            {t('wf.f.onlyLevels')}
            <div className="checkbox-group">
              {['error', 'warning', 'info'].map((l) => (
                <label key={l} className="checkbox small">
                  <input type="checkbox" checked={levels.includes(l)} onChange={(e) => set({ levels: e.target.checked ? [...levels, l] : levels.filter((x) => x !== l) })} /> {l}
                </label>
              ))}
            </div>
          </label>
          <label>
            {t('wf.f.onlyCodes')}
            <input value={((step.issueCodes as string[]) ?? []).join(', ')} onChange={(e) => set({ issueCodes: e.target.value ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : undefined })} />
          </label>
        </div>
      );
    }
    case 'filter':
      return <ConditionEditor condition={step.condition as Record<string, unknown>} onChange={(condition) => set({ condition })} catalog={catalog} />;
    case 'limit':
      return (
        <label>
          {t('wf.f.maxProducts')}
          <input type="number" min={1} value={(step.max as number) ?? 100} onChange={(e) => set({ max: Number(e.target.value) })} />
        </label>
      );
    case 'stop_if_empty':
    case 'sync':
    case 'refresh_products':
    case 'clear_attributes':
      return <div className="muted small">{t('wf.f.noParams')}</div>;
    case 'set_attributes':
      return (
        <div>
          {facets ? (
            <AttributeForm catalog={facets.attributeCatalog} value={(step.attributes as Record<string, unknown>) ?? {}} onChange={(attributes) => set({ attributes })} />
          ) : (
            <Spinner />
          )}
          <label className="checkbox small">
            <input type="checkbox" checked={step.continueOnError !== false} onChange={(e) => set({ continueOnError: e.target.checked })} /> {t('wf.f.continueOnError')}
          </label>
          <div className="muted small">
            {t('wf.f.customInJson')}{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), onJson())}>
              {t('wf.f.jsonView')}
            </a>{' '}
            (<code>customAttributes: [{'{name, value}'}]</code>).
          </div>
        </div>
      );
    case 'add_tags':
    case 'remove_tags':
      return (
        <label>
          {t('wf.f.tags')}
          <input value={((step.tags as string[]) ?? []).join(', ')} onChange={(e) => set({ tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
        </label>
      );
    case 'set_note':
      return (
        <div className="grid-2">
          <label>
            {t('wf.f.note')}
            <input value={(step.note as string) ?? ''} onChange={(e) => set({ note: e.target.value })} />
          </label>
          <label>
            {t('wf.f.mode')}
            <select value={(step.mode as string) ?? 'append'} onChange={(e) => set({ mode: e.target.value })}>
              <option value="append">{t('wf.f.append')}</option>
              <option value="replace">{t('wf.f.replace')}</option>
            </select>
          </label>
        </div>
      );
    case 'fetch_feed':
      return (
        <label>
          {t('wf.f.dataSourceId')}
          <input value={(step.dataSourceId as string) ?? ''} onChange={(e) => set({ dataSourceId: e.target.value })} />
        </label>
      );
    case 'webhook':
      return (
        <div className="grid-2">
          <label>
            {t('wf.f.url')}
            <input value={(step.url as string) ?? ''} onChange={(e) => set({ url: e.target.value })} />
          </label>
          <label>
            {t('wf.f.method')}
            <select value={(step.method as string) ?? 'POST'} onChange={(e) => set({ method: e.target.value })}>
              <option>POST</option>
              <option>PUT</option>
            </select>
          </label>
          <label>
            {t('wf.f.message')}
            <input value={(step.message as string) ?? ''} onChange={(e) => set({ message: e.target.value })} placeholder="{{count}} products need attention" />
          </label>
          <div>
            <label className="checkbox small">
              <input type="checkbox" checked={step.includeProducts !== false} onChange={(e) => set({ includeProducts: e.target.checked })} /> {t('wf.f.includeProducts')}
            </label>
            <label className="checkbox small">
              <input type="checkbox" checked={step.skipIfEmpty !== false} onChange={(e) => set({ skipIfEmpty: e.target.checked })} /> {t('wf.f.skipIfEmpty')}
            </label>
          </div>
        </div>
      );
    case 'log':
      return (
        <div className="grid-2">
          <label>
            {t('wf.f.message')}
            <input value={(step.message as string) ?? ''} onChange={(e) => set({ message: e.target.value })} />
          </label>
          <label>
            {t('wf.f.severity')}
            <select value={(step.severity as string) ?? 'info'} onChange={(e) => set({ severity: e.target.value })}>
              <option>info</option>
              <option>warning</option>
              <option>error</option>
            </select>
          </label>
        </div>
      );
    default:
      return (
        <div className="muted small">
          {t('wf.f.editInJson')}{' '}
          <a href="#" onClick={(e) => (e.preventDefault(), onJson())}>
            {t('wf.f.jsonView')}
          </a>
          .
        </div>
      );
  }
}

// ---------------------------------------------------------------- conditions
type Cond = Record<string, unknown>;

export function ConditionEditor({ condition, onChange, catalog }: { condition: Cond; onChange: (c: Cond) => void; catalog: WorkflowCatalog }) {
  const { t } = useI18n();
  // Supports a single field condition or a flat all/any group of field conditions. Nested trees fall back to JSON.
  const group = 'all' in condition ? 'all' : 'any' in condition ? 'any' : null;
  const items: Cond[] = group ? (condition[group] as Cond[]) : [condition];
  const nested = items.some((c) => !('field' in c));
  if (nested) {
    return <JsonEditor value={condition} onChange={(v) => onChange(v as Cond)} rows={8} />;
  }
  const setItems = (next: Cond[], g = group) => onChange(g ? { [g]: next } : (next[0] ?? { field: '', op: 'exists' }));
  return (
    <div className="condition-editor">
      {items.length > 1 || group ? (
        <label className="inline-form small">
          {t('wf.f.match')}
          <select value={group ?? 'all'} onChange={(e) => setItems(items, e.target.value as 'all')}>
            <option value="all">{t('wf.f.allOf')}</option>
            <option value="any">{t('wf.f.anyOf')}</option>
          </select>
        </label>
      ) : null}
      {items.map((c, i) => (
        <div key={i} className="inline-form">
          <input list="field-list" placeholder={t('wf.f.field')} value={(c.field as string) ?? ''} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} />
          <select value={(c.op as string) ?? 'eq'} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}>
            {catalog.operators.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {!['exists', 'not_exists', 'is_empty', 'is_not_empty'].includes(c.op as string) && (
            <input
              placeholder={t('wf.f.value')}
              value={Array.isArray(c.value) ? (c.value as unknown[]).join(', ') : ((c.value as string) ?? '')}
              onChange={(e) => {
                const raw = e.target.value;
                const value = ['in', 'not_in'].includes(c.op as string) ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw;
                setItems(items.map((x, j) => (j === i ? { ...x, value } : x)));
              }}
            />
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => setItems(items.filter((_, j) => j !== i), items.length - 1 > 1 ? group : null)} disabled={items.length === 1}>
            ✕
          </button>
        </div>
      ))}
      <datalist id="field-list">
        {catalog.fields.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <button className="btn btn-sm" onClick={() => setItems([...items, { field: 'status', op: 'eq', value: 'DISAPPROVED' }], group ?? 'all')}>
        {t('wf.f.addCondition')}
      </button>{' '}
      <Badge>{t('wf.f.fields')}</Badge>
    </div>
  );
}
