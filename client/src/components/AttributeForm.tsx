import { useMemo, useState } from 'react';
import type { AttributeDefinition } from '../lib/types';
import { useI18n } from '../lib/i18n';

/**
 * Lets the user pick attributes from the catalog and enter values. The value
 * object maps attribute name -> raw value (string / boolean / JSON); the
 * server normalizes it (see attribute-catalog.ts).
 */
export default function AttributeForm({
  catalog,
  value,
  onChange,
  current,
}: {
  catalog: AttributeDefinition[];
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  /** Currently pushed attributes (for hints). */
  current?: Record<string, unknown>;
}) {
  const [picker, setPicker] = useState('');
  const { t, tOr } = useI18n();
  const groups = useMemo(() => {
    const map = new Map<string, AttributeDefinition[]>();
    for (const def of catalog) map.set(def.group, [...(map.get(def.group) ?? []), def]);
    return [...map.entries()];
  }, [catalog]);
  const byName = useMemo(() => new Map(catalog.map((d) => [d.name, d])), [catalog]);

  const set = (name: string, v: unknown) => onChange({ ...value, [name]: v });
  const remove = (name: string) => {
    const next = { ...value };
    delete next[name];
    onChange(next);
  };

  return (
    <div className="attribute-form">
      <div className="attribute-picker">
        <select
          value={picker}
          onChange={(e) => {
            const name = e.target.value;
            if (!name) return;
            const def = byName.get(name);
            set(name, def?.type === 'boolean' ? true : def?.type === 'json' ? '' : '');
            setPicker('');
          }}
        >
          <option value="">{t('attr.add')}</option>
          {groups.map(([group, defs]) => (
            <optgroup key={group} label={tOr(`attr.group.${group}`, group)}>
              {defs
                .filter((d) => !(d.name in value))
                .map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.label}
                  </option>
                ))}
            </optgroup>
          ))}
          <option value="__custom">{t('attr.other')}</option>
        </select>
        {picker === '__custom' && null}
        <CustomNameInput
          onAdd={(name) => {
            if (name && !(name in value)) set(name, '');
          }}
        />
      </div>
      {Object.keys(value).length === 0 && <div className="muted small">{t('attr.none')}</div>}
      {Object.entries(value).map(([name, v]) => {
        const def = byName.get(name);
        const currentValue = current?.[name];
        return (
          <div key={name} className="attribute-row">
            <div className="attribute-name">
              <strong>{def?.label ?? name}</strong>
              <div className="small muted">
                {name}
                {def?.help ? ` · ${def.help}` : ''}
                {currentValue !== undefined && ` · ${t('attr.currently', { value: typeof currentValue === 'object' ? JSON.stringify(currentValue) : String(currentValue) })}`}
              </div>
            </div>
            <div className="attribute-value">
              {v === null ? (
                <span className="muted">{t('attr.willRemove')}</span>
              ) : def?.enum ? (
                <select value={String(v)} onChange={(e) => set(name, e.target.value)}>
                  <option value="">{t('attr.select')}</option>
                  {def.enum.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : def?.type === 'boolean' ? (
                <select value={String(v)} onChange={(e) => set(name, e.target.value === 'true')}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : def?.type === 'string[]' ? (
                <textarea rows={3} value={Array.isArray(v) ? v.join('\n') : String(v)} onChange={(e) => set(name, e.target.value)} placeholder={t('attr.onePerLine')} />
              ) : def?.type === 'json' ? (
                <textarea className="code" rows={4} value={typeof v === 'string' ? v : JSON.stringify(v, null, 2)} onChange={(e) => set(name, e.target.value)} placeholder={def.help} />
              ) : def?.type === 'price' ? (
                <input value={typeof v === 'string' ? v : JSON.stringify(v)} onChange={(e) => set(name, e.target.value)} placeholder="19.99 PLN" />
              ) : name === 'description' ? (
                <textarea rows={4} value={String(v)} onChange={(e) => set(name, e.target.value)} />
              ) : (
                <input value={typeof v === 'string' ? v : JSON.stringify(v)} onChange={(e) => set(name, e.target.value)} />
              )}
            </div>
            <div className="attribute-actions">
              {currentValue !== undefined && v !== null && (
                <button className="btn btn-ghost btn-sm" title={t('attr.unsetTitle')} onClick={() => set(name, null)}>
                  {t('attr.unset')}
                </button>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => remove(name)} aria-label="remove row">
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CustomNameInput({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = useState('');
  const { t } = useI18n();
  return (
    <span className="inline-form">
      <input placeholder={t('attr.customName')} value={name} onChange={(e) => setName(e.target.value)} />
      <button
        className="btn btn-sm"
        disabled={!name.trim()}
        onClick={() => {
          onAdd(name.trim());
          setName('');
        }}
      >
        {t('common.add')}
      </button>
    </span>
  );
}
