import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useAsync, useInterval } from '../lib/hooks';
import type { AppEvent, SyncRun } from '../lib/types';
import { Badge, Card, Empty, ErrorBox, LevelBadge, Pagination, Spinner, useToast } from '../components/ui';

const LIMIT = 100;
const TYPE_GROUPS: Record<string, string[]> = {
  'Issues': ['issue.new', 'issue.resolved', 'account_issue.new', 'account_issue.resolved'],
  'Products': ['product.status_changed', 'product.deleted'],
  'Notifications': ['notification.received', 'notification.subscribed', 'notification.unsubscribed'],
  'Sync': ['sync.completed', 'sync.failed'],
  'Workflows': ['workflow.completed', 'workflow.failed', 'workflow.log', 'workflow.created'],
  'Feeds': ['feed.created', 'feed.updated', 'feed.deleted', 'feed.fetch_requested'],
  'Enrichment': ['enrichment.pushed', 'enrichment.failed', 'enrichment.cleared', 'enrichment.datasource_created', 'enrichment.datasource_linked', 'enrichment.link_failed', 'metadata.updated'],
  'Account': ['return_policy.created', 'return_policy.updated', 'return_policy.deleted', 'auth.login'],
};

function encodeName(name: string): string {
  const id = name.split('/products/')[1] ?? name;
  return btoa(unescape(encodeURIComponent(id))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export default function ActivityPage() {
  const [params, setParams] = useSearchParams();
  const notify = useToast();
  const { t, tOr } = useI18n();
  const { formatDate } = useFormat();
  const query = useMemo(
    () => ({ group: params.get('group') ?? '', severity: params.get('severity') ?? '', since: params.get('since') ?? '', offset: Number(params.get('offset') ?? 0) }),
    [params],
  );
  const events = useAsync(
    () => api.get<{ items: AppEvent[]; total: number }>(`/api/events${qs({ types: query.group ? TYPE_GROUPS[query.group] : undefined, severity: query.severity, since: query.since, limit: LIMIT, offset: query.offset })}`),
    [JSON.stringify(query)],
  );
  const sync = useAsync(() => api.get<{ running: boolean; runs: SyncRun[]; intervalMinutes: number }>('/api/sync/status'), []);
  useInterval(() => {
    void sync.reload();
    if (sync.data?.running) void events.reload();
  }, sync.data?.running ? 2000 : 30000);

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (!('offset' in patch)) next.delete('offset');
    setParams(next);
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('act.title')}</h1>
        <div className="page-actions">
          <button
            className="btn"
            disabled={sync.data?.running}
            onClick={async () => {
              try {
                await api.post('/api/sync');
                notify(t('dash.syncStarted'), 'ok');
                setTimeout(() => void sync.reload(), 500);
              } catch (err) {
                notify((err as Error).message, 'error');
              }
            }}
          >
            {sync.data?.running ? t('dash.syncing') : t('dash.syncNow')}
          </button>
        </div>
      </header>

      <Card title={`${t('act.syncRuns')} ${sync.data?.intervalMinutes ? t('act.every', { n: sync.data.intervalMinutes }) : ''}`}>
        {!sync.data?.runs.length ? (
          <Empty>{t('act.noSyncRuns')}</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.started')}</th>
                <th>{t('common.status')}</th>
                <th className="num">{t('common.products')}</th>
                <th className="num">{t('act.newProducts')}</th>
                <th className="num">{t('act.deleted')}</th>
                <th className="num">{t('act.newIssues')}</th>
                <th className="num">{t('act.resolved')}</th>
                <th className="num">{t('act.statusChanges')}</th>
                <th className="num">{t('act.duration')}</th>
              </tr>
            </thead>
            <tbody>
              {sync.data.runs.slice(0, 10).map((r) => (
                <tr key={r.id}>
                  <td className="muted small">{formatDate(r.startedAt)}</td>
                  <td>
                    <Badge tone={r.status === 'success' ? 'ok' : r.status === 'failed' ? 'error' : 'info'}>{t(`common.${r.status}`)}</Badge>
                    {r.error && <div className="field-error small">{r.error}</div>}
                  </td>
                  <td className="num">{r.stats.products ?? '–'}</td>
                  <td className="num">{r.stats.newProducts ?? '–'}</td>
                  <td className="num">{r.stats.deletedProducts ?? '–'}</td>
                  <td className="num">{r.stats.newIssues ?? '–'}</td>
                  <td className="num">{r.stats.resolvedIssues ?? '–'}</td>
                  <td className="num">{r.stats.statusChanges ?? '–'}</td>
                  <td className="num muted small">{r.stats.durationMs !== undefined ? `${(r.stats.durationMs / 1000).toFixed(1)}s` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="filters">
        <div className="filter-row">
          <select value={query.group} onChange={(e) => update({ group: e.target.value })}>
            <option value="">{t('act.allTypes')}</option>
            {Object.keys(TYPE_GROUPS).map((g) => (
              <option key={g} value={g}>
                {tOr(`act.group.${g}`, g)}
              </option>
            ))}
          </select>
          <select value={query.severity} onChange={(e) => update({ severity: e.target.value })}>
            <option value="">{t('products.anySeverity')}</option>
            <option value="error">{t('level.errors')}</option>
            <option value="warning">{t('level.warnings')}</option>
            <option value="info">{t('level.info')}</option>
          </select>
          <select value={query.since} onChange={(e) => update({ since: e.target.value })}>
            <option value="">{t('issues.anyTime')}</option>
            <option value="lastLogin">{t('issues.sinceLogin')}</option>
            <option value={new Date(Date.now() - 86400_000).toISOString()}>{t('issues.last24h')}</option>
          </select>
        </div>
      </Card>

      <ErrorBox error={events.error} onRetry={events.reload} />
      {events.loading && !events.data ? (
        <Spinner />
      ) : !events.data?.items.length ? (
        <Empty>{t('act.noEvents')}</Empty>
      ) : (
        <Card>
          <table className="table">
            <thead>
              <tr>
                <th>{t('act.time')}</th>
                <th>{t('act.type')}</th>
                <th></th>
                <th>{t('act.message')}</th>
              </tr>
            </thead>
            <tbody>
              {events.data.items.map((e) => (
                <tr key={e.id}>
                  <td className="muted small nowrap">{formatDate(e.createdAt)}</td>
                  <td className="muted small">{e.type}</td>
                  <td>
                    <LevelBadge level={e.severity} />
                  </td>
                  <td>
                    {e.productName ? <Link to={`/products/${encodeName(e.productName)}`}>{e.message}</Link> : e.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination total={events.data.total} limit={LIMIT} offset={query.offset} onChange={(offset) => update({ offset: String(offset) })} />
        </Card>
      )}
    </div>
  );
}
