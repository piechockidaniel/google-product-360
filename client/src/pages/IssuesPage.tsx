import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useAsync } from '../lib/hooks';
import type { AccountIssue, IssueSummaryRow, ProductIssue, RenderedIssue } from '../lib/types';
import { Badge, Card, Empty, ErrorBox, LevelBadge, Pagination, Spinner, useToast } from '../components/ui';

const LIMIT = 100;

export default function IssuesPage() {
  const [params, setParams] = useSearchParams();
  const { user, acknowledge } = useAuth();
  const notify = useToast();
  const { t } = useI18n();
  const { formatDate, timeAgo } = useFormat();
  const view = params.get('view') ?? 'products';
  const query = useMemo(
    () => ({
      since: params.get('since') ?? '',
      level: params.get('level') ?? '',
      code: params.get('code') ?? '',
      mode: params.get('mode') ?? 'open', // open | resolved
      offset: Number(params.get('offset') ?? 0),
    }),
    [params],
  );

  const issues = useAsync(
    () =>
      api.get<{ items: ProductIssue[]; total: number; since: string | null }>(
        `/api/issues${qs({
          since: query.mode === 'open' ? query.since : undefined,
          resolvedSince: query.mode === 'resolved' ? query.since || '1970-01-01T00:00:00.000Z' : undefined,
          open: query.mode === 'open',
          level: query.level,
          code: query.code,
          limit: LIMIT,
          offset: query.offset,
        })}`,
      ),
    [JSON.stringify(query)],
  );
  const summary = useAsync(() => api.get<{ since: string | null; codes: IssueSummaryRow[] }>('/api/issues/summary'), []);
  const account = useAsync(() => api.get<{ since: string | null; issues: AccountIssue[] }>('/api/issues/account'), []);
  const rendered = useAsync(() => (view === 'account' ? api.get<{ issues: RenderedIssue[] }>('/api/issues/account/rendered') : Promise.resolve({ issues: [] })), [view]);

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('offset' in patch)) next.delete('offset');
    setParams(next);
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('issues.title')}</h1>
        <div className="page-actions">
          <span className="muted small">{t('issues.reference', { date: formatDate(user?.previousLoginAt) })}</span>
          <button
            className="btn btn-sm"
            onClick={async () => {
              await acknowledge();
              notify(t('issues.referenceMoved'), 'ok');
              void issues.reload();
              void summary.reload();
              void account.reload();
            }}
          >
            {t('dash.markSeen')}
          </button>
        </div>
      </header>

      <div className="tabs">
        <button className={`tab ${view === 'products' ? 'active' : ''}`} onClick={() => update({ view: '' })}>
          {t('issues.tab.products')}
        </button>
        <button className={`tab ${view === 'summary' ? 'active' : ''}`} onClick={() => update({ view: 'summary' })}>
          {t('issues.tab.summary')}
        </button>
        <button className={`tab ${view === 'account' ? 'active' : ''}`} onClick={() => update({ view: 'account' })}>
          {t('issues.tab.account')} {account.data?.issues.length ? <Badge tone="error">{account.data.issues.length}</Badge> : null}
        </button>
      </div>

      {view === 'products' && (
        <>
          <Card className="filters">
            <div className="filter-row">
              <select value={query.mode} onChange={(e) => update({ mode: e.target.value })}>
                <option value="open">{t('issues.open')}</option>
                <option value="resolved">{t('issues.resolved')}</option>
              </select>
              <select value={query.since} onChange={(e) => update({ since: e.target.value })}>
                <option value="">{t('issues.anyTime')}</option>
                <option value="lastLogin">{t('issues.sinceLogin')}</option>
                <option value={new Date(Date.now() - 86400_000).toISOString()}>{t('issues.last24h')}</option>
                <option value={new Date(Date.now() - 7 * 86400_000).toISOString()}>{t('issues.last7d')}</option>
              </select>
              <select value={query.level} onChange={(e) => update({ level: e.target.value })}>
                <option value="">{t('products.anySeverity')}</option>
                <option value="error">{t('issues.errorsDisapproved')}</option>
                <option value="warning">{t('issues.warningsDemoted')}</option>
                <option value="info">{t('level.info')}</option>
              </select>
              <select value={query.code} onChange={(e) => update({ code: e.target.value })}>
                <option value="">{t('issues.anyType')}</option>
                {summary.data?.codes.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.description ?? c.code} ({c.count})
                  </option>
                ))}
              </select>
            </div>
          </Card>
          <ErrorBox error={issues.error} onRetry={issues.reload} />
          {issues.loading && !issues.data ? (
            <Spinner />
          ) : !issues.data?.items.length ? (
            <Empty>{t('issues.empty')}</Empty>
          ) : (
            <Card>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.severity')}</th>
                    <th>{t('common.product')}</th>
                    <th>{t('common.issue')}</th>
                    <th>{t('common.attribute')}</th>
                    <th>{t('issues.context')}</th>
                    <th>{query.mode === 'resolved' ? t('issues.resolvedAt') : t('issues.firstSeen')}</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.data.items.map((i) => {
                    const isNew = !!issues.data?.since && i.firstSeenAt > issues.data.since;
                    return (
                      <tr key={i.id}>
                        <td>
                          <LevelBadge level={i.level} label={i.severity ?? i.level} />
                        </td>
                        <td>
                          <Link to={`/products/${i.productId}`}>{i.offerId ?? i.productName.split('/').pop()}</Link>
                          <div className="muted small">{i.title}</div>
                        </td>
                        <td>
                          {i.description ?? i.code}
                          {isNew && query.mode === 'open' && !query.since && <Badge tone="warning">{t('common.new')}</Badge>}
                          {i.documentation && (
                            <>
                              {' '}
                              <a href={i.documentation} target="_blank" rel="noreferrer" className="small">
                                {t('issues.help')} ↗
                              </a>
                            </>
                          )}
                          {i.detail && <div className="muted small">{i.detail}</div>}
                        </td>
                        <td className="muted">{i.attribute ?? '–'}</td>
                        <td className="muted small">
                          {i.reportingContext} {i.applicableCountries.join(', ')}
                        </td>
                        <td className="muted small" title={formatDate(query.mode === 'resolved' ? i.resolvedAt : i.firstSeenAt)}>
                          {timeAgo(query.mode === 'resolved' ? i.resolvedAt : i.firstSeenAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Pagination total={issues.data.total} limit={LIMIT} offset={query.offset} onChange={(offset) => update({ offset: String(offset) })} />
            </Card>
          )}
        </>
      )}

      {view === 'summary' && (
        <Card>
          {!summary.data?.codes.length ? (
            <Empty>{t('issues.noOpen')}</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.severity')}</th>
                  <th>{t('common.issue')}</th>
                  <th>{t('common.code')}</th>
                  <th>{t('common.attribute')}</th>
                  <th className="num">{t('common.products')}</th>
                  <th className="num">{t('issues.newSinceLogin')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {summary.data.codes.map((c) => (
                  <tr key={c.code}>
                    <td>
                      <LevelBadge level={c.level} label={c.severity ?? c.level} />
                    </td>
                    <td>{c.description ?? c.code}</td>
                    <td className="muted small">{c.code}</td>
                    <td className="muted">{c.attribute ?? '–'}</td>
                    <td className="num">{c.count}</td>
                    <td className="num">{c.newCount ? <Badge tone="warning">+{c.newCount}</Badge> : '–'}</td>
                    <td>
                      <Link className="btn btn-sm" to={`/products?issueCode=${encodeURIComponent(c.code)}`}>
                        {t('common.products')}
                      </Link>{' '}
                      <button className="btn btn-sm" onClick={() => update({ view: '', code: c.code })}>
                        {t('common.issues')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {view === 'account' && (
        <>
          <Card title={t('issues.openAccount')}>
            {!account.data?.issues.length ? (
              <Empty>{t('issues.noAccount')}</Empty>
            ) : (
              <ul className="issue-list">
                {account.data.issues.map((i) => (
                  <li key={i.id}>
                    <LevelBadge level={i.level} label={i.severity ?? i.level} />
                    <div>
                      <strong>{i.title}</strong> {i.isNew && <Badge tone="warning">{t('common.new')}</Badge>}
                      {i.detail && <div>{i.detail}</div>}
                      <div className="small muted">
                        {i.impacted.map((d, k) => (
                          <span key={k}>
                            {d.reportingContext}: {(d.impacts ?? []).map((x) => `${x.regionCode} (${x.severity})`).join(', ')} ·{' '}
                          </span>
                        ))}
                        {t('common.firstSeen', { date: formatDate(i.firstSeenAt) })}
                        {i.documentationUri && (
                          <>
                            {' '}
                            ·{' '}
                            <a href={i.documentationUri} target="_blank" rel="noreferrer">
                              {t('common.documentation')} ↗
                            </a>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {rendered.data && rendered.data.issues.length > 0 && (
            <Card title={t('detail.rendered')}>
              <ul className="issue-list">
                {rendered.data.issues.map((r, idx) => (
                  <li key={idx}>
                    <LevelBadge level={r.impact?.severity?.toLowerCase() ?? 'info'} label={r.impact?.severity ?? ''} />
                    <div>
                      <strong>{r.title}</strong>
                      {r.impact?.message && <div className="muted">{r.impact.message}</div>}
                      {r.prerenderedContent && <div className="rendered" dangerouslySetInnerHTML={{ __html: r.prerenderedContent }} />}
                      <div className="small">
                        {(r.actions ?? []).map((a, ai) =>
                          a.externalAction?.uri ? (
                            <a key={ai} className="btn btn-sm" href={a.externalAction.uri} target="_blank" rel="noreferrer">
                              {a.buttonLabel ?? t('detail.open')} ↗
                            </a>
                          ) : null,
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
