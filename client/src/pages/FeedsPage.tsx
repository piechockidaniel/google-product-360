import { useState } from 'react';
import { api } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useAsync } from '../lib/hooks';
import type { Feed } from '../lib/types';
import { Badge, Card, Confirm, Empty, ErrorBox, HealthDot, LevelBadge, Modal, Spinner, useToast } from '../components/ui';

interface EnrichmentStatus {
  dataSource: { name?: string; displayName?: string } | null;
  linkedPrimaries: string[];
  unlinkedPrimaries: { name: string; displayName: string }[];
}

/** Localised schedule text from the raw data source (the server's English text is only a fallback). */
function scheduleText(f: Feed, t: (k: 'feeds.schedule.daily' | 'feeds.schedule.weekly' | 'feeds.schedule.monthly', p?: Record<string, string | number>) => string): string | null {
  const fs = (f.raw as { fileInput?: { fetchSettings?: { frequency?: string; timeOfDay?: { hours?: number; minutes?: number }; timeZone?: string; dayOfWeek?: string; dayOfMonth?: number } } } | undefined)?.fileInput?.fetchSettings;
  if (!fs) return f.fetchSchedule;
  const time = `${String(fs.timeOfDay?.hours ?? 0).padStart(2, '0')}:${String(fs.timeOfDay?.minutes ?? 0).padStart(2, '0')}${fs.timeZone ? ` ${fs.timeZone}` : ''}`;
  if (fs.frequency === 'FREQUENCY_DAILY') return t('feeds.schedule.daily', { time });
  if (fs.frequency === 'FREQUENCY_WEEKLY') return t('feeds.schedule.weekly', { day: fs.dayOfWeek ?? '?', time });
  if (fs.frequency === 'FREQUENCY_MONTHLY') return t('feeds.schedule.monthly', { day: fs.dayOfMonth ?? '?', time });
  return f.fetchSchedule;
}

export default function FeedsPage() {
  const notify = useToast();
  const { t, tOr } = useI18n();
  const { formatDate, timeAgo } = useFormat();
  const feeds = useAsync(() => api.get<{ feeds: Feed[] }>('/api/feeds'), []);
  const enrichment = useAsync(() => api.get<EnrichmentStatus>('/api/feeds/enrichment/status'), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Feed | null>(null);
  const [details, setDetails] = useState<Feed | null>(null);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      notify(label, 'ok');
      await feeds.reload();
      await enrichment.reload();
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('feeds.title')}</h1>
        <div className="page-actions">
          <button className="btn" onClick={() => void feeds.reload()}>
            {t('common.refresh')}
          </button>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            {t('feeds.new')}
          </button>
        </div>
      </header>

      <ErrorBox error={feeds.error} onRetry={feeds.reload} />
      {feeds.loading && !feeds.data ? (
        <Spinner />
      ) : !feeds.data?.feeds.length ? (
        <Empty>{t('feeds.empty')}</Empty>
      ) : (
        <Card>
          <table className="table">
            <thead>
              <tr>
                <th></th>
                <th>{t('common.name')}</th>
                <th>{t('feeds.kind')}</th>
                <th>{t('feeds.input')}</th>
                <th>{t('feeds.labelLang')}</th>
                <th>{t('feeds.schedule')}</th>
                <th className="num">{t('common.products')}</th>
                <th>{t('feeds.lastUpload')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {feeds.data.feeds.map((f) => (
                <tr key={f.id}>
                  <td>
                    <HealthDot health={f.health} />
                  </td>
                  <td>
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setDetails(f);
                      }}
                    >
                      {f.displayName}
                    </a>
                    <div className="muted small">{t('feeds.id', { id: f.id })}</div>
                  </td>
                  <td>
                    <Badge tone={f.kind === 'primary' ? 'info' : 'neutral'}>{tOr(`feeds.kind.${f.kind}`, f.kind.replace(/_/g, ' '))}</Badge>
                  </td>
                  <td className="muted">
                    {f.input}
                    {f.fileInputType ? ` / ${f.fileInputType}` : ''}
                  </td>
                  <td className="muted">{f.feedLabel || f.contentLanguage ? `${f.feedLabel ?? '*'} / ${f.contentLanguage ?? '*'}` : t('common.any')}</td>
                  <td className="muted small">
                    {scheduleText(f, t) ?? '–'} {f.fetchEnabled === false && <Badge tone="warning">{t('common.disabled')}</Badge>}
                  </td>
                  <td className="num">{f.productCount}</td>
                  <td className="muted small">
                    {f.lastUpload ? (
                      <>
                        <Badge tone={f.lastUpload.processingState === 'SUCCEEDED' ? 'ok' : f.lastUpload.processingState === 'FAILED' ? 'error' : 'warning'}>
                          {f.lastUpload.processingState}
                        </Badge>{' '}
                        {timeAgo(f.lastUpload.uploadTime)} · {t('feeds.items', { n: f.lastUpload.itemsTotal ?? '?' })}
                        {f.lastUpload.issues?.length ? ` · ${t('feeds.issues', { n: f.lastUpload.issues.length })}` : ''}
                      </>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td className="actions">
                    {f.fileInputType === 'FETCH' && (
                      <button className="btn btn-sm" onClick={() => act(t('feeds.fetchRequested'), () => api.post(`/api/feeds/${f.id}/fetch`))}>
                        {t('feeds.fetchNow')}
                      </button>
                    )}
                    <button className="btn btn-sm" onClick={() => setEditing(f)}>
                      {t('common.edit')}
                    </button>
                    <Confirm message={t('feeds.deleteConfirm', { name: f.displayName })} onConfirm={() => void act(t('feeds.deleted'), () => api.delete(`/api/feeds/${f.id}`))}>
                      {t('common.delete')}
                    </Confirm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card
        title={t('feeds.enrichment')}
        actions={
          <button className="btn btn-sm" onClick={() => act(t('feeds.enrichmentReady'), () => api.post('/api/feeds/enrichment/ensure'))}>
            {enrichment.data?.dataSource ? t('feeds.relink') : t('feeds.createLink')}
          </button>
        }
      >
        <p className="muted small">{t('feeds.enrichmentHelp')}</p>
        {enrichment.data?.dataSource ? (
          <div>
            <Badge tone="ok">{t('feeds.exists')}</Badge> {enrichment.data.dataSource.displayName} <span className="muted small">({enrichment.data.dataSource.name})</span>
            <div className="small">
              {t('feeds.linkedTo', { n: enrichment.data.linkedPrimaries.length })}
              {enrichment.data.unlinkedPrimaries.length > 0 && (
                <span className="muted"> · {t('feeds.notLinked', { names: enrichment.data.unlinkedPrimaries.map((p) => p.displayName).join(', ') })}</span>
              )}
            </div>
          </div>
        ) : (
          <Badge tone="warning">{t('feeds.notCreated')}</Badge>
        )}
      </Card>

      {creating && (
        <Modal title={t('feeds.newTitle')} onClose={() => setCreating(false)}>
          <FeedForm
            onSubmit={async (body) => {
              await act(t('feeds.created'), () => api.post('/api/feeds', body));
              setCreating(false);
            }}
          />
        </Modal>
      )}
      {editing && (
        <Modal title={t('feeds.editTitle', { name: editing.displayName })} onClose={() => setEditing(null)}>
          <FeedEditForm
            feed={editing}
            onSubmit={async (body) => {
              await act(t('feeds.updated'), () => api.patch(`/api/feeds/${editing.id}`, body));
              setEditing(null);
            }}
          />
        </Modal>
      )}
      {details && (
        <Modal title={details.displayName} onClose={() => setDetails(null)} wide>
          {details.lastUpload && (
            <>
              <h4>{t('feeds.lastUpload')}</h4>
              <div className="small">
                {details.lastUpload.processingState} ·{' '}
                {t('feeds.uploadDetails', {
                  date: formatDate(details.lastUpload.uploadTime),
                  total: details.lastUpload.itemsTotal ?? '?',
                  created: details.lastUpload.itemsCreated ?? '?',
                  updated: details.lastUpload.itemsUpdated ?? '?',
                })}
              </div>
              {details.lastUpload.issues?.length ? (
                <ul className="issue-list">
                  {details.lastUpload.issues.map((i, k) => (
                    <li key={k}>
                      <LevelBadge level={i.severity?.toLowerCase() ?? 'info'} label={i.severity ?? ''} />
                      <div>
                        <strong>{i.title}</strong> <span className="muted small">{i.count ? `× ${i.count}` : ''}</span>
                        <div className="muted small">{i.description}</div>
                        {i.documentationUri && (
                          <a className="small" href={i.documentationUri} target="_blank" rel="noreferrer">
                            {t('common.documentation')} ↗
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="muted small">{t('feeds.noProcessingIssues')}</div>
              )}
            </>
          )}
          <h4>{t('feeds.rawSource')}</h4>
          <pre className="code-block">{JSON.stringify(details.raw, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}

function FeedForm({ onSubmit }: { onSubmit: (body: unknown) => Promise<void> }) {
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState('');
  const [kind, setKind] = useState<'primary' | 'supplemental'>('primary');
  const [feedLabel, setFeedLabel] = useState('');
  const [contentLanguage, setContentLanguage] = useState('');
  const [countries, setCountries] = useState('');
  const [inputType, setInputType] = useState<'API' | 'FETCH' | 'UPLOAD' | 'GOOGLE_SHEETS'>('FETCH');
  const [fetchUri, setFetchUri] = useState('');
  const [fileName, setFileName] = useState('');
  const [frequency, setFrequency] = useState<'FREQUENCY_DAILY' | 'FREQUENCY_WEEKLY' | 'FREQUENCY_MONTHLY'>('FREQUENCY_DAILY');
  const [hour, setHour] = useState(4);
  const [minute, setMinute] = useState(0);
  const [timeZone, setTimeZone] = useState('Europe/Warsaw');
  const [dayOfWeek, setDayOfWeek] = useState('MONDAY');
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit({
        displayName,
        kind,
        ...(feedLabel ? { feedLabel } : {}),
        ...(contentLanguage ? { contentLanguage } : {}),
        ...(countries.trim() ? { countries: countries.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean) } : {}),
        ...(inputType !== 'API'
          ? {
              file: {
                type: inputType,
                ...(fileName ? { fileName } : {}),
                ...(fetchUri ? { fetchUri } : {}),
                frequency,
                hour,
                minute,
                timeZone,
                ...(frequency === 'FREQUENCY_WEEKLY' ? { dayOfWeek } : {}),
                ...(frequency === 'FREQUENCY_MONTHLY' ? { dayOfMonth } : {}),
                ...(username ? { username } : {}),
                ...(password ? { password } : {}),
              },
            }
          : {}),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form">
      <label>
        {t('feeds.displayName')}
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <div className="grid-2">
        <label>
          {t('feeds.kind')}
          <select value={kind} onChange={(e) => setKind(e.target.value as 'primary')}>
            <option value="primary">{t('feeds.kindPrimary')}</option>
            <option value="supplemental">{t('feeds.kindSupplemental')}</option>
          </select>
        </label>
        <label>
          {t('feeds.input')}
          <select value={inputType} onChange={(e) => setInputType(e.target.value as 'API')}>
            <option value="FETCH">{t('feeds.inputFetch')}</option>
            <option value="UPLOAD">{t('feeds.inputUpload')}</option>
            <option value="GOOGLE_SHEETS">{t('feeds.inputSheets')}</option>
            <option value="API">{t('feeds.inputApi')}</option>
          </select>
        </label>
      </div>
      <div className="grid-3">
        <label>
          {t('feeds.feedLabel')} {inputType !== 'API' && <span className="muted">{t('feeds.required')}</span>}
          <input value={feedLabel} onChange={(e) => setFeedLabel(e.target.value.toUpperCase())} placeholder="PL" />
        </label>
        <label>
          {t('feeds.contentLanguage')} {inputType !== 'API' && <span className="muted">{t('feeds.required')}</span>}
          <input value={contentLanguage} onChange={(e) => setContentLanguage(e.target.value.toLowerCase())} placeholder="pl" />
        </label>
        {kind === 'primary' && (
          <label>
            {t('feeds.countries')}
            <input value={countries} onChange={(e) => setCountries(e.target.value)} placeholder="PL, DE" />
          </label>
        )}
      </div>
      {inputType !== 'API' && (
        <>
          <div className="grid-2">
            <label>
              {t('feeds.fileName')} <span className="muted">{t('feeds.forUploads')}</span>
              <input value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="products.xml" />
            </label>
            {(inputType === 'FETCH' || inputType === 'GOOGLE_SHEETS') && (
              <label>
                {t('feeds.fetchUrl')}
                <input value={fetchUri} onChange={(e) => setFetchUri(e.target.value)} placeholder="https://shop.example/feed.xml" />
              </label>
            )}
          </div>
          {(inputType === 'FETCH' || inputType === 'GOOGLE_SHEETS') && (
            <>
              <div className="grid-3">
                <label>
                  {t('feeds.frequency')}
                  <select value={frequency} onChange={(e) => setFrequency(e.target.value as 'FREQUENCY_DAILY')}>
                    <option value="FREQUENCY_DAILY">{t('feeds.daily')}</option>
                    <option value="FREQUENCY_WEEKLY">{t('feeds.weekly')}</option>
                    <option value="FREQUENCY_MONTHLY">{t('feeds.monthly')}</option>
                  </select>
                </label>
                <label>
                  {t('feeds.time')}
                  <span className="inline-form">
                    <input type="number" min={0} max={23} value={hour} onChange={(e) => setHour(Number(e.target.value))} /> :{' '}
                    <input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(Number(e.target.value))} />
                  </span>
                </label>
                <label>
                  {t('feeds.timeZone')}
                  <input value={timeZone} onChange={(e) => setTimeZone(e.target.value)} />
                </label>
              </div>
              {frequency === 'FREQUENCY_WEEKLY' && (
                <label>
                  {t('feeds.dayOfWeek')}
                  <select value={dayOfWeek} onChange={(e) => setDayOfWeek(e.target.value)}>
                    {['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </label>
              )}
              {frequency === 'FREQUENCY_MONTHLY' && (
                <label>
                  {t('feeds.dayOfMonth')}
                  <input type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} />
                </label>
              )}
              <div className="grid-2">
                <label>
                  {t('feeds.username')} <span className="muted">{t('feeds.optionalAuth')}</span>
                  <input value={username} onChange={(e) => setUsername(e.target.value)} />
                </label>
                <label>
                  {t('feeds.password')}
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </label>
              </div>
            </>
          )}
        </>
      )}
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy || !displayName} onClick={submit}>
          {busy ? t('feeds.creating') : t('feeds.create')}
        </button>
      </div>
    </div>
  );
}

function FeedEditForm({ feed, onSubmit }: { feed: Feed; onSubmit: (body: unknown) => Promise<void> }) {
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState(feed.displayName);
  const [fetchUri, setFetchUri] = useState(feed.fetchUri ?? '');
  const [enabled, setEnabled] = useState(feed.fetchEnabled ?? true);
  const [busy, setBusy] = useState(false);
  const hasFetch = feed.fetchSchedule !== null;
  return (
    <div className="form">
      <label>
        {t('feeds.displayName')}
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      {hasFetch && (
        <>
          <label>
            {t('feeds.fetchUrl')}
            <input value={fetchUri} onChange={(e) => setFetchUri(e.target.value)} />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {t('feeds.fetchEnabled', { schedule: scheduleText(feed, t) ?? '' })}
          </label>
        </>
      )}
      <div className="form-actions">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit({
                displayName,
                ...(hasFetch ? { fetch: { ...(fetchUri ? { fetchUri } : {}), enabled } } : {}),
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}
