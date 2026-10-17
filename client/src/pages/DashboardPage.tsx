import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useAsync, useInterval } from '../lib/hooks';
import type { Dashboard, Flag } from '../lib/types';
import { Badge, Card, Empty, ErrorBox, HealthDot, LevelBadge, Spinner, Stat, StatusBadge, useToast } from '../components/ui';
import { Delta, LineChart, seriesColor } from '../components/charts';
import { RecommendationBadge, SignalProductList } from '../components/signals';
import { DemandChange } from '../components/Product360Panel';
import DemoTour from '../components/DemoTour';
import type { DashboardInsights } from '../lib/types';

export function flagText(flag: Flag, tOr: (key: string, fallback: string, params?: Record<string, string | number | null | undefined>) => string): string {
  if (!flag.code) return flag.message;
  const params = { ...(flag.params ?? {}) };
  if (flag.code === 'feed_health') {
    const issues = Number(params.issues ?? 0);
    params.issues = issues ? tOr('flag.feed_issues', `, ${issues} processing issue(s)`, { n: issues }) : '';
  }
  return tOr(`flag.${flag.code}`, flag.message, params);
}

export default function DashboardPage() {
  const { acknowledge, demo } = useAuth();
  const { t, tOr } = useI18n();
  const { formatDate, timeAgo } = useFormat();
  const notify = useToast();
  const state = useAsync(() => api.get<Dashboard>('/api/dashboard'), []);
  useInterval(() => void state.reload(), state.data?.syncRunning ? 3000 : 60000);

  if (state.loading && !state.data) return <Spinner />;
  if (state.error && !state.data) return <ErrorBox error={state.error} onRetry={state.reload} />;
  const d = state.data!;
  const s = d.sinceLastLogin;
  const sinceCount = s.newIssueCount + s.resolvedIssueCount + s.newAccountIssues.length + s.statusChanges.length + s.notifications.length + s.signalChangeCount;

  const runSync = async () => {
    try {
      await api.post('/api/sync');
      notify(t('dash.syncStarted'), 'ok');
      setTimeout(() => void state.reload(), 1500);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>
            <HealthDot health={d.health} /> {t('dash.title')}
          </h1>
          <div className="muted">
            {d.account?.accountName ?? t('dash.merchantAccount')} {d.account?.accountId ? `· ${d.account.accountId}` : ''}
            {d.account?.testAccount && <Badge tone="warning">{t('common.testAccount')}</Badge>}
            {d.homepage?.uri && (
              <>
                {' '}
                ·{' '}
                <a href={d.homepage.uri} target="_blank" rel="noreferrer">
                  {d.homepage.uri}
                </a>{' '}
                {d.homepage.claimed ? <Badge tone="ok">{t('dash.claimed')}</Badge> : <Badge tone="error">{t('dash.notClaimed')}</Badge>}
              </>
            )}
          </div>
        </div>
        <div className="page-actions">
          <span className="muted">
            {t('dash.lastSync', { value: d.lastSync ? `${timeAgo(d.lastSync.finishedAt ?? d.lastSync.startedAt)} (${t(`common.${d.lastSync.status}`)})` : t('common.never') })}
          </span>
          <button className="btn" onClick={runSync} disabled={d.syncRunning}>
            {d.syncRunning ? t('dash.syncing') : t('dash.syncNow')}
          </button>
        </div>
      </header>

      {d.flags.length > 0 && (
        <Card title={t('dash.attention')} className="card-flags">
          <ul className="flag-list">
            {d.flags.map((f, i) => (
              <li key={i} className={`flag flag-${f.level}`}>
                <LevelBadge level={f.level} />
                <span>{flagText(f, tOr)}</span>
                {f.documentationUri && (
                  <a href={f.documentationUri} target="_blank" rel="noreferrer">
                    {t('common.help')} ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="stats-row">
        <Stat label={t('dash.stat.products')} value={d.productStats.total} />
        <Stat label={t('dash.stat.approved')} value={d.productStats.byStatus.APPROVED ?? 0} tone="ok" />
        <Stat label={t('dash.stat.partial')} value={d.productStats.byStatus.PARTIALLY_APPROVED ?? 0} tone="warning" />
        <Stat label={t('dash.stat.disapproved')} value={d.productStats.byStatus.DISAPPROVED ?? 0} tone="error" />
        <Stat label={t('dash.stat.pending')} value={d.productStats.byStatus.PENDING ?? 0} tone="warning" />
        <Stat label={t('dash.stat.withErrors')} value={d.productStats.withErrors} tone="error" />
        <Stat label={t('dash.stat.withWarnings')} value={d.productStats.withWarnings} tone="warning" />
      </div>

      {demo && <DemoTour insights={d.insights} onChanged={() => void state.reload()} />}

      {d.insights.enabled && <InsightsBlock insights={d.insights} onSynced={() => void state.reload()} />}

      <Card
        title={
          <>
            {t('dash.since')} <span className="muted">({formatDate(d.since)})</span>
          </>
        }
        actions={
          sinceCount > 0 && (
            <button
              className="btn btn-sm"
              onClick={async () => {
                await acknowledge();
                await state.reload();
              }}
            >
              {t('dash.markSeen')}
            </button>
          )
        }
      >
        {sinceCount === 0 ? (
          <Empty>{t('dash.nothingNew')}</Empty>
        ) : (
          <div className="grid-2">
            <div>
              <h4>
                {t('dash.newIssues')} <Badge tone={s.newIssueCount ? 'error' : 'neutral'}>{s.newIssueCount}</Badge>{' '}
                <Link to="/issues?since=lastLogin" className="muted small">
                  {t('dash.viewAll')}
                </Link>
              </h4>
              <IssueMiniList issues={s.newIssues} />
              <h4>
                {t('dash.resolvedIssues')} <Badge tone="ok">{s.resolvedIssueCount}</Badge>
              </h4>
              <IssueMiniList issues={s.resolvedIssues} resolved />
            </div>
            <div>
              {s.newAccountIssues.length > 0 && (
                <>
                  <h4>{t('dash.newAccountIssues')}</h4>
                  <ul className="mini-list">
                    {s.newAccountIssues.map((i) => (
                      <li key={i.id}>
                        <LevelBadge level={i.level} /> {i.title}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h4>
                {t('dash.statusChanges')} <Badge>{s.statusChanges.length}</Badge>
              </h4>
              <EventMiniList events={s.statusChanges} />
              {s.notifications.length > 0 && (
                <>
                  <h4>
                    {t('dash.notifications')} <Badge>{s.notifications.length}</Badge>
                  </h4>
                  <EventMiniList events={s.notifications} />
                </>
              )}
              {s.signalChanges.length > 0 && (
                <>
                  <h4>
                    {t('dash.signalChanges')} <Badge>{s.signalChangeCount}</Badge>
                  </h4>
                  <ul className="mini-list">
                    {s.signalChanges.slice(0, 8).map((e) => {
                      const payload = e.payload as { previous?: string; recommendation?: string } | null;
                      return (
                        <li key={e.id}>
                          <RecommendationBadge value={payload?.recommendation} /> <span className="muted small">← {payload?.previous}</span>{' '}
                          {e.productId && <Link to={`/products/${e.productId}`}>{e.offerId}</Link>} <span className="muted small">{timeAgo(e.createdAt)}</span>
                        </li>
                      );
                    })}
                    {s.signalChanges.length > 8 && <li className="muted">{t('common.andMore', { n: s.signalChangeCount - 8 })}</li>}
                  </ul>
                </>
              )}
              {s.workflowRuns.length > 0 && (
                <>
                  <h4>{t('dash.workflowRuns')}</h4>
                  <ul className="mini-list">
                    {s.workflowRuns.slice(0, 8).map((r) => (
                      <li key={r.id}>
                        <Badge tone={r.status === 'success' ? 'ok' : r.status === 'failed' ? 'error' : 'neutral'}>{t(`common.${r.status}`)}</Badge>{' '}
                        <Link to={`/workflows/${r.workflowId}`}>{r.workflowName}</Link> <span className="muted">{timeAgo(r.startedAt)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title={t('dash.topIssues')}>
          {d.issueSummary.length === 0 ? (
            <Empty>{t('dash.noOpenIssues')}</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.issue')}</th>
                  <th>{t('common.attribute')}</th>
                  <th className="num">{t('common.products')}</th>
                  <th className="num">{t('common.new')}</th>
                </tr>
              </thead>
              <tbody>
                {d.issueSummary.slice(0, 10).map((row) => (
                  <tr key={row.code}>
                    <td>
                      <LevelBadge level={row.level} /> <Link to={`/products?issueCode=${encodeURIComponent(row.code)}`}>{row.description ?? row.code}</Link>
                    </td>
                    <td className="muted">{row.attribute ?? '–'}</td>
                    <td className="num">{row.count}</td>
                    <td className="num">{row.newCount > 0 ? <Badge tone="warning">+{row.newCount}</Badge> : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card
          title={t('dash.feeds')}
          actions={
            <Link to="/feeds" className="btn btn-sm">
              {t('common.manage')}
            </Link>
          }
        >
          {d.feeds.length === 0 ? (
            <Empty>{t('dash.noFeeds')}</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th></th>
                  <th>{t('common.name')}</th>
                  <th>{t('dash.type')}</th>
                  <th className="num">{t('common.products')}</th>
                  <th>{t('dash.lastUpload')}</th>
                </tr>
              </thead>
              <tbody>
                {d.feeds.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <HealthDot health={f.health} />
                    </td>
                    <td>{f.displayName}</td>
                    <td className="muted">
                      {tOr(`feeds.kind.${f.kind}`, f.kind)} / {f.input}
                    </td>
                    <td className="num">{f.productCount}</td>
                    <td className="muted">{f.lastUpload ? `${f.lastUpload.processingState} · ${timeAgo(f.lastUpload.uploadTime)}` : f.input === 'API' ? 'API' : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {d.aggregateStatuses.length > 0 && (
        <Card title={t('dash.perDestination')}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('dash.destination')}</th>
                <th>{t('dash.country')}</th>
                <th className="num">{t('dash.active')}</th>
                <th className="num">{t('dash.stat.pending')}</th>
                <th className="num">{t('dash.stat.disapproved')}</th>
                <th className="num">{t('dash.expiring')}</th>
              </tr>
            </thead>
            <tbody>
              {d.aggregateStatuses.map((a, i) => (
                <tr key={i}>
                  <td>{a.reportingContext}</td>
                  <td>{a.country}</td>
                  <td className="num">{a.stats?.activeCount ?? 0}</td>
                  <td className="num">{a.stats?.pendingCount ?? 0}</td>
                  <td className="num">{a.stats?.disapprovedCount ?? 0}</td>
                  <td className="num">{a.stats?.expiringCount ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {d.accountIssues.length > 0 && (
        <Card title={t('dash.accountIssues')}>
          <ul className="issue-list">
            {d.accountIssues.map((i) => (
              <li key={i.id}>
                <LevelBadge level={i.level} label={i.severity ?? i.level} />
                <div>
                  <strong>{i.title}</strong>
                  {i.detail && <div className="muted">{i.detail}</div>}
                  <div className="small muted">
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
        </Card>
      )}
    </div>
  );
}

function IssueMiniList({ issues, resolved }: { issues: Dashboard['sinceLastLogin']['newIssues']; resolved?: boolean }) {
  const { t } = useI18n();
  const { timeAgo } = useFormat();
  if (!issues.length) return <Empty>{t('common.none')}</Empty>;
  return (
    <ul className="mini-list">
      {issues.slice(0, 10).map((i) => (
        <li key={i.id}>
          <LevelBadge level={i.level} /> <Link to={`/products/${i.productId}`}>{i.offerId ?? i.productName}</Link> – {i.description ?? i.code}{' '}
          <span className="muted small">{timeAgo(resolved ? i.resolvedAt : i.firstSeenAt)}</span>
        </li>
      ))}
      {issues.length > 10 && <li className="muted">{t('common.andMore', { n: issues.length - 10 })}</li>}
    </ul>
  );
}

function EventMiniList({ events }: { events: Dashboard['sinceLastLogin']['statusChanges'] }) {
  const { t } = useI18n();
  const { timeAgo } = useFormat();
  if (!events.length) return <Empty>{t('common.none')}</Empty>;
  return (
    <ul className="mini-list">
      {events.slice(0, 10).map((e) => {
        const payload = e.payload as { status?: string } | null;
        return (
          <li key={e.id}>
            {payload?.status ? <StatusBadge status={payload.status} /> : <LevelBadge level={e.severity} />} {e.message}{' '}
            <span className="muted small">{timeAgo(e.createdAt)}</span>
          </li>
        );
      })}
      {events.length > 10 && <li className="muted">{t('common.andMore', { n: events.length - 10 })}</li>}
    </ul>
  );
}

function InsightsBlock({ insights, onSynced }: { insights: DashboardInsights; onSynced: () => void }) {
  const { t, tOr } = useI18n();
  const { formatNumber, timeAgo } = useFormat();
  const notify = useToast();
  const i = insights;
  const connector = i.connectors[0];
  const syncNow = async () => {
    try {
      await api.post('/api/metrics/sync');
      notify(t('p360.syncStarted'), 'ok');
      setTimeout(onSynced, 2500);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };
  if (!i.computed) {
    return (
      <Card title={t('p360.title')}>
        <Empty>
          {connector?.lastRun?.status === 'failed' ? t('p360.lastRunFailed', { error: connector.lastRun.error ?? '' }) : t('p360.notComputed')}{' '}
          <button className="btn btn-sm btn-primary" onClick={syncNow}>
            {t('p360.syncNow')}
          </button>
        </Empty>
      </Card>
    );
  }
  const series = i.series.map((ser, idx) => ({ id: ser.method, label: tOr(`p360.method.${ser.method}`, ser.method), color: seriesColor(idx), points: ser.points.map((p) => ({ x: p.date, y: p.clicks })) }));
  const counts = i.recommendationCounts;
  return (
    <>
      <Card
        title={t('p360.title')}
        actions={
          <>
            <span className="muted small">{t('p360.dataThrough', { date: i.windowEnd ?? '–' })}{connector?.lastSuccessfulRun ? ` · ${t('p360.lastPull', { ago: timeAgo(connector.lastSuccessfulRun.finishedAt) })}` : ''}</span>
            <Link to="/market" className="btn btn-sm">
              {t('nav.market')}
            </Link>
            <button className="btn btn-sm" onClick={syncNow}>
              {t('p360.syncNow')}
            </button>
          </>
        }
      >
        <div className="stats-row">
          <Stat label={t('p360.impressions', { n: 7 })} value={<>{formatNumber(i.totals.current.impressions)} <Delta current={i.totals.current.impressions} previous={i.totals.previous.impressions} /></>} />
          <Stat label={t('p360.clicks', { n: 7 })} value={<>{formatNumber(i.totals.current.clicks)} <Delta current={i.totals.current.clicks} previous={i.totals.previous.clicks} /></>} />
          <Stat label={t('p360.ctr')} value={i.totals.current.ctr === null ? '–' : `${(i.totals.current.ctr * 100).toFixed(2)} %`} />
          <Stat label={t('p360.conversions', { n: 7 })} value={<>{formatNumber(Math.round(i.totals.current.conversions))} <Delta current={i.totals.current.conversions} previous={i.totals.previous.conversions} /></>} />
          <Stat label={t('p360.productsWithTraffic')} value={i.totals.current.products} />
        </div>
        {i.organic && (
          <div className="stats-row">
            <Stat label={t('p360.organicImpressions')} value={<>{formatNumber(i.organic.current.impressions)} <Delta current={i.organic.current.impressions} previous={i.organic.previous.impressions} /></>} />
            <Stat label={t('p360.organicClicks')} value={<>{formatNumber(i.organic.current.clicks)} <Delta current={i.organic.current.clicks} previous={i.organic.previous.clicks} /></>} />
            <Stat label={t('p360.organicCtr')} value={i.organic.current.ctr === null ? '–' : `${(i.organic.current.ctr * 100).toFixed(2)} %`} />
            <Stat label={t('p360.organicPosition')} value={i.organic.current.position ?? '–'} />
            <Stat label={t('p360.organicPages')} value={i.organic.current.pages} />
          </div>
        )}
        <div className="grid-2 align-start">
          <div>
            <h4>{t('p360.clicks28')}</h4>
            <LineChart series={series} height={160} />
          </div>
          <div>
            <h4>{t('p360.recommendations')}</h4>
            <div className="reco-grid">
              {(['SCALE', 'FIX', 'REPRICE', 'OPTIMISE_LISTING', 'WATCH', 'PAUSE', 'KEEP', 'NO_DATA'] as const).map((r) => (
                <Link key={r} to={`/products?recommendation=${r}&orderBy=impressions7d&orderDir=desc`} className="reco-tile">
                  <span className="reco-count">{counts[r] ?? 0}</span>
                  <RecommendationBadge value={r} />
                </Link>
              ))}
            </div>
          </div>
        </div>
      </Card>
      <div className="grid-2 align-start">
        <Card title={<>{t('p360.focus')} <RecommendationBadge value="SCALE" /></>} actions={<Link to="/products?recommendation=SCALE&orderBy=impressions7d&orderDir=desc" className="muted small">{t('dash.viewAll')}</Link>}>
          <SignalProductList products={i.focus} emptyText={t('p360.noneInBucket')} />
        </Card>
        <Card title={<>{t('p360.fixFirst')} <RecommendationBadge value="FIX" /></>} actions={<Link to="/products?recommendation=FIX&orderBy=impressions7d&orderDir=desc" className="muted small">{t('dash.viewAll')}</Link>}>
          <SignalProductList products={i.fix} emptyText={t('p360.noneInBucket')} />
        </Card>
        <Card title={<>{t('p360.priceOpportunities')} <RecommendationBadge value="REPRICE" /></>} actions={<Link to="/products?recommendation=REPRICE&orderBy=impressions7d&orderDir=desc" className="muted small">{t('dash.viewAll')}</Link>}>
          <SignalProductList products={i.priceOpportunities} emptyText={t('p360.noneInBucket')} />
        </Card>
        <Card title={<>{t('p360.optimiseListing')} <RecommendationBadge value="OPTIMISE_LISTING" /></>} actions={<Link to="/products?recommendation=OPTIMISE_LISTING&orderBy=impressions7d&orderDir=desc" className="muted small">{t('dash.viewAll')}</Link>}>
          <SignalProductList products={i.optimise} emptyText={t('p360.noneInBucket')} />
        </Card>
        <Card title={t('p360.trendingNotCarried')} actions={<Link to="/market?carried=false" className="muted small">{t('dash.viewAll')}</Link>}>
          {i.trendingNotCarried.length === 0 ? (
            <Empty>{t('p360.noTrending')}</Empty>
          ) : (
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>{t('common.product')}</th>
                  <th>{t('market.category')}</th>
                  <th className="num">{t('market.rank')}</th>
                  <th>{t('market.change')}</th>
                </tr>
              </thead>
              <tbody>
                {i.trendingNotCarried.map((b) => (
                  <tr key={`${b.country}-${b.categoryId}-${b.clusterKey}`}>
                    <td>
                      {b.title} <div className="muted small">{b.brand} · {b.country}</div>
                    </td>
                    <td className="muted">{b.category ?? b.categoryId}</td>
                    <td className="num">{b.rank ?? '–'}</td>
                    <td>
                      <DemandChange value={b.demandChange} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
