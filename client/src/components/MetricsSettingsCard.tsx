import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useAsync, useInterval } from '../lib/hooks';
import type { ConnectionCheck, MetricsStatus, PublicSettings, SearchConsoleSite, UrlMappingDiagnostics } from '../lib/types';
import { Badge, Card, Empty, ErrorBox, Spinner, useToast } from './ui';

type Thresholds = Pick<PublicSettings, 'metricsEnabled' | 'metricsSyncCron' | 'metricsBackfillDays' | 'metricsRetentionDays' | 'signalMinImpressions' | 'signalPriceAbovePct' | 'signalClickDropPct'>;
type SearchConsoleForm = Pick<PublicSettings, 'searchConsoleEnabled' | 'searchConsoleSiteUrl' | 'searchConsoleCountryFilter' | 'searchConsoleMerchantListings' | 'searchConsoleDataState'>;

/** Settings → Product360: connectors, capabilities, sync control and signal thresholds. */
export default function MetricsSettingsCard() {
  const { t, tOr } = useI18n();
  const { formatDate, timeAgo } = useFormat();
  const notify = useToast();
  const status = useAsync(() => api.get<MetricsStatus>('/api/metrics/status'), []);
  const config = useAsync(() => api.get<PublicSettings>('/api/setup/config'), []);
  const [form, setForm] = useState<Thresholds | null>(null);
  const [sc, setSc] = useState<SearchConsoleForm | null>(null);
  const [sites, setSites] = useState<SearchConsoleSite[] | 'loading' | 'error' | null>(null);
  const [mapping, setMapping] = useState<UrlMappingDiagnostics | 'loading' | null>(null);
  const [check, setCheck] = useState<Record<string, ConnectionCheck | 'loading'>>({});
  const [busy, setBusy] = useState(false);
  useInterval(() => void status.reload(), status.data?.running ? 2000 : null);

  useEffect(() => {
    if (config.data && !form) {
      const c = config.data;
      setForm({
        metricsEnabled: c.metricsEnabled,
        metricsSyncCron: c.metricsSyncCron,
        metricsBackfillDays: c.metricsBackfillDays,
        metricsRetentionDays: c.metricsRetentionDays,
        signalMinImpressions: c.signalMinImpressions,
        signalPriceAbovePct: c.signalPriceAbovePct,
        signalClickDropPct: c.signalClickDropPct,
      });
    }
    if (config.data && !sc) {
      const c = config.data;
      setSc({
        searchConsoleEnabled: c.searchConsoleEnabled,
        searchConsoleSiteUrl: c.searchConsoleSiteUrl,
        searchConsoleCountryFilter: c.searchConsoleCountryFilter,
        searchConsoleMerchantListings: c.searchConsoleMerchantListings,
        searchConsoleDataState: c.searchConsoleDataState,
      });
    }
  }, [config.data, form, sc]);

  const loadSites = async () => {
    setSites('loading');
    try {
      const r = await api.get<{ sites: SearchConsoleSite[] }>('/api/metrics/connectors/search_console/sites');
      setSites(r.sites);
    } catch {
      setSites('error');
    }
  };
  const loadMapping = async () => {
    setMapping('loading');
    try {
      setMapping(await api.get<UrlMappingDiagnostics>('/api/metrics/connectors/search_console/mapping'));
    } catch (err) {
      notify((err as Error).message, 'error');
      setMapping(null);
    }
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      notify(label, 'ok');
      await Promise.all([status.reload(), config.reload()]);
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string) => {
    setCheck((c) => ({ ...c, [id]: 'loading' }));
    try {
      const result = await api.post<ConnectionCheck>(`/api/metrics/connectors/${id}/test`);
      setCheck((c) => ({ ...c, [id]: result }));
      void status.reload();
    } catch (err) {
      setCheck((c) => ({ ...c, [id]: { ok: false, capabilities: [], error: (err as Error).message } }));
    }
  };

  if (status.loading && !status.data) return <Spinner />;
  if (!status.data) return <ErrorBox error={status.error} onRetry={status.reload} />;
  const s = status.data;

  return (
    <Card
      title={t('p360.settingsTitle')}
      actions={
        <>
          <button className="btn btn-sm" disabled={busy || s.running} onClick={() => run(t('p360.syncStarted'), () => api.post('/api/metrics/sync?wait=true'))}>
            {s.running ? t('dash.syncing') : t('p360.syncNow')}
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => run(t('p360.recomputed'), () => api.post('/api/metrics/recompute'))}>
            {t('p360.recompute')}
          </button>
        </>
      }
    >
      <p className="muted small">{t('p360.settingsHelp')}</p>
      <table className="table">
        <thead>
          <tr>
            <th>{t('p360.connector')}</th>
            <th>{t('common.status')}</th>
            <th>{t('p360.lastRun')}</th>
            <th>{t('p360.nextWindow')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {s.connectors.map((c) => {
            const result = check[c.id];
            return (
              <tr key={c.id}>
                <td>
                  <strong>{tOr(`p360.connectorName.${c.id}`, c.id)}</strong>
                  <div className="muted small">{tOr(`p360.connectorHelp.${c.id}`, '')}</div>
                  {result && result !== 'loading' && (
                    <ul className="capability-list">
                      {result.capabilities.map((cap) => (
                        <li key={cap.id}>
                          <Badge tone={cap.available ? 'ok' : 'warning'}>{cap.available ? '✓' : '✕'}</Badge> {tOr(`p360.view.${cap.id}`, cap.id)}
                          {!cap.available && cap.message && <span className="muted small"> – {cap.message}</span>}
                        </li>
                      ))}
                      {result.hint && <li className="muted small">{tOr(`p360.hint.${result.hint}`, result.hint)}</li>}
                      {result.error && <li className="text-error small">{result.error}</li>}
                    </ul>
                  )}
                </td>
                <td>
                  {!c.configured ? (
                    <Badge tone="neutral">{t('p360.notConfigured')}</Badge>
                  ) : c.lastRun?.status === 'failed' ? (
                    <Badge tone="error" title={c.lastRun.error ?? ''}>
                      {t('common.failed')}
                    </Badge>
                  ) : c.lastSuccessfulRun ? (
                    <Badge tone="ok">{t('common.success')}</Badge>
                  ) : (
                    <Badge tone="warning">{t('p360.neverRun')}</Badge>
                  )}
                </td>
                <td className="small muted">
                  {c.lastRun ? (
                    <>
                      {timeAgo(c.lastRun.finishedAt ?? c.lastRun.startedAt)}
                      {c.lastRun.windowFrom && (
                        <div>
                          {c.lastRun.windowFrom} – {c.lastRun.windowTo}
                        </div>
                      )}
                      {c.lastRun.error && <div className="text-error">{c.lastRun.error}</div>}
                    </>
                  ) : (
                    '–'
                  )}
                </td>
                <td className="small muted">{c.nextWindow ? `${c.nextWindow.from} – ${c.nextWindow.to}` : '–'}</td>
                <td>
                  <button className="btn btn-sm" disabled={!c.configured || result === 'loading'} onClick={() => test(c.id)} title={c.configured ? '' : t('p360.configureBelow')}>
                    {result === 'loading' ? t('common.loading') : t('p360.testConnection')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="muted small">
        {t('p360.schedule', { next: s.nextRunAt ? formatDate(s.nextRunAt) : t('common.disabled') })} · {t('p360.dataThrough', { date: s.freshness.performanceThrough ?? '–' })}
        {s.freshness.bestSellersThrough && <> · {t('p360.bestSellersThrough', { date: s.freshness.bestSellersThrough })}</>}
        {s.freshness.searchThrough && <> · {t('p360.searchThrough', { date: s.freshness.searchThrough })}</>}
      </div>

      {sc && (
        <>
          <h4>{t('p360.scTitle')}</h4>
          <p className="muted small">{t('p360.scHelp')}</p>
          <div className="grid-3">
            <label className="checkbox">
              <input type="checkbox" checked={sc.searchConsoleEnabled} onChange={(e) => setSc({ ...sc, searchConsoleEnabled: e.target.checked })} /> {t('p360.scEnabled')}
            </label>
            <label>
              {t('p360.scProperty')}
              <div className="inline-form">
                {Array.isArray(sites) ? (
                  <select value={sc.searchConsoleSiteUrl} onChange={(e) => setSc({ ...sc, searchConsoleSiteUrl: e.target.value })}>
                    <option value="">–</option>
                    {sites.map((x) => (
                      <option key={x.siteUrl} value={x.siteUrl}>
                        {x.siteUrl} ({x.permissionLevel})
                      </option>
                    ))}
                    {sc.searchConsoleSiteUrl && !sites.some((x) => x.siteUrl === sc.searchConsoleSiteUrl) && <option value={sc.searchConsoleSiteUrl}>{sc.searchConsoleSiteUrl}</option>}
                  </select>
                ) : (
                  <input value={sc.searchConsoleSiteUrl} onChange={(e) => setSc({ ...sc, searchConsoleSiteUrl: e.target.value })} placeholder="sc-domain:example.com" />
                )}
                <button className="btn btn-sm" disabled={sites === 'loading'} onClick={loadSites} title={t('p360.scLoadSitesHint')}>
                  {sites === 'loading' ? '…' : t('p360.scLoadSites')}
                </button>
              </div>
              {sites === 'error' && <div className="field-error">{t('p360.scSitesFailed')}</div>}
              {Array.isArray(sites) && sites.length === 0 && <div className="field-error">{t('p360.scNoSites')}</div>}
            </label>
            <label>
              {t('p360.scCountry')} <span className="muted">{t('p360.scCountryHint')}</span>
              <input value={sc.searchConsoleCountryFilter} maxLength={3} onChange={(e) => setSc({ ...sc, searchConsoleCountryFilter: e.target.value.toLowerCase() })} placeholder="pol" />
            </label>
            <label>
              {t('p360.scDataState')}
              <select value={sc.searchConsoleDataState} onChange={(e) => setSc({ ...sc, searchConsoleDataState: e.target.value as 'all' })}>
                <option value="all">{t('p360.scDataState.all')}</option>
                <option value="final">{t('p360.scDataState.final')}</option>
              </select>
            </label>
            <label className="checkbox small">
              <input type="checkbox" checked={sc.searchConsoleMerchantListings} onChange={(e) => setSc({ ...sc, searchConsoleMerchantListings: e.target.checked })} /> {t('p360.scMerchantListings')}
            </label>
          </div>
          <div className="form-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => run(t('common.saved'), () => api.put('/api/setup/config', sc))}>
              {t('common.save')}
            </button>
            <button className="btn" disabled={mapping === 'loading' || !s.searchConsole.enabled} onClick={loadMapping}>
              {t('p360.scMapping')}
            </button>
            {s.searchConsole.enabled && (
              <span className="muted small">
                {t('p360.scMappedSummary', { n: s.searchConsole.urlMap.mappedProducts, shared: s.searchConsole.urlMap.sharedProducts })}
              </span>
            )}
          </div>
          {mapping === 'loading' && <Spinner />}
          {mapping && typeof mapping === 'object' && (
            <div className="grid-2 align-start">
              <div>
                <h4>{t('p360.scUnmappedProducts', { n: mapping.total - mapping.mapped })}</h4>
                <p className="muted small">{t('p360.scMappingSummary', { mapped: mapping.mapped, total: mapping.total, outside: mapping.outsideSite, shared: mapping.shared })}</p>
                {mapping.unmappedProducts.length === 0 ? (
                  <Empty>{t('p360.scAllMapped')}</Empty>
                ) : (
                  <ul className="mini-list">
                    {mapping.unmappedProducts.map((u) => (
                      <li key={u.productId}>
                        <a href={`/products/${u.productId}`}>{u.offerId}</a> <span className="muted small">{u.link ?? t('p360.scNoLink')}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h4>{t('p360.scUnmappedPages')}</h4>
                <p className="muted small">{t('p360.scUnmappedPagesHint', { from: mapping.window.from, to: mapping.window.to })}</p>
                {mapping.unmappedPages.length === 0 ? (
                  <Empty>{t('common.none')}</Empty>
                ) : (
                  <ul className="mini-list">
                    {mapping.unmappedPages.slice(0, 15).map((u) => (
                      <li key={u.canonicalUrl}>
                        <a href={u.canonicalUrl} target="_blank" rel="noreferrer">
                          {u.canonicalUrl.replace(/^https?:\/\//, '')}
                        </a>{' '}
                        <span className="muted small">
                          {u.impressions} / {u.clicks}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {form && (
        <>
          <h4>{t('p360.thresholds')}</h4>
          <div className="grid-3">
            <label className="checkbox">
              <input type="checkbox" checked={form.metricsEnabled} onChange={(e) => setForm({ ...form, metricsEnabled: e.target.checked })} /> {t('p360.enabled')}
            </label>
            <label>
              {t('p360.cron')} <span className="muted">{t('wf.cronHint')}</span>
              <input value={form.metricsSyncCron} onChange={(e) => setForm({ ...form, metricsSyncCron: e.target.value })} />
            </label>
            <label>
              {t('p360.backfillDays')}
              <input type="number" min={7} max={730} value={form.metricsBackfillDays} onChange={(e) => setForm({ ...form, metricsBackfillDays: Number(e.target.value) })} />
            </label>
            <label>
              {t('p360.retentionDays')}
              <input type="number" min={30} max={1100} value={form.metricsRetentionDays} onChange={(e) => setForm({ ...form, metricsRetentionDays: Number(e.target.value) })} />
            </label>
            <label>
              {t('p360.minImpressions')}
              <input type="number" min={0} value={form.signalMinImpressions} onChange={(e) => setForm({ ...form, signalMinImpressions: Number(e.target.value) })} />
            </label>
            <label>
              {t('p360.priceAbovePct')}
              <input type="number" min={0} max={100} value={form.signalPriceAbovePct} onChange={(e) => setForm({ ...form, signalPriceAbovePct: Number(e.target.value) })} />
            </label>
            <label>
              {t('p360.clickDropPct')}
              <input type="number" min={1} max={100} value={form.signalClickDropPct} onChange={(e) => setForm({ ...form, signalClickDropPct: Number(e.target.value) })} />
            </label>
          </div>
          <div className="form-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => run(t('common.saved'), () => api.put('/api/setup/config', form))}>
              {t('common.save')}
            </button>
          </div>
        </>
      )}

      {s.runs.length > 0 && (
        <>
          <h4>{t('p360.recentRuns')}</h4>
          <table className="table table-compact">
            <thead>
              <tr>
                <th>{t('common.started')}</th>
                <th>{t('p360.connector')}</th>
                <th>{t('common.status')}</th>
                <th>{t('p360.window')}</th>
                <th>{t('common.stats')}</th>
              </tr>
            </thead>
            <tbody>
              {s.runs.slice(0, 8).map((r) => {
                const st = r.stats as Record<string, unknown>;
                const summary = ['performanceRows', 'priceBenchmarkRows', 'bestSellerRows', 'competitiveVisibilityRows', 'searchRowsStored', 'searchUnmatchedPages', 'mappedProducts']
                  .filter((k) => st[k] !== undefined)
                  .map((k) => `${tOr(`p360.stat.${k}`, k)}: ${String(st[k])}`)
                  .join(' · ');
                return (
                  <tr key={r.id}>
                    <td className="small">{formatDate(r.startedAt)}</td>
                    <td className="small">{tOr(`p360.connectorName.${r.connector}`, r.connector)}</td>
                    <td>
                      <Badge tone={r.status === 'success' ? 'ok' : r.status === 'failed' ? 'error' : 'neutral'}>{t(`common.${r.status}`)}</Badge>
                    </td>
                    <td className="small muted">
                      {r.windowFrom} – {r.windowTo}
                      {st.backfill === true && <Badge tone="info">{t('p360.backfill')}</Badge>}
                    </td>
                    <td className="small muted">
                      {r.error ?? summary}
                      {Array.isArray(st.warnings) && (st.warnings as string[]).length > 0 && <div className="text-warning">{(st.warnings as string[]).join('; ')}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}
