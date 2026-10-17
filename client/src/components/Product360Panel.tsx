import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useAsync } from '../lib/hooks';
import type { Product360, SearchQueriesResponse } from '../lib/types';
import { Badge, Card, Empty, ErrorBox, Spinner, Stat } from './ui';
import { Delta, LineChart, ScoreBar, seriesColor } from './charts';
import { ReasonList, RecommendationBadge, formatPct } from './signals';

const RANGES = [30, 90, 180] as const;

export default function Product360Panel({ productId, onTitleIdea }: { productId: string; onTitleIdea?: (query: string) => void }) {
  const { t, tOr } = useI18n();
  const { formatDate, formatNumber, formatPrice } = useFormat();
  const [days, setDays] = useState<(typeof RANGES)[number]>(90);
  const [metric, setMetric] = useState<'clicks' | 'impressions' | 'conversions'>('clicks');
  const state = useAsync(() => api.get<Product360>(`/api/products/${productId}/360?days=${days}`), [productId, days]);

  if (state.loading && !state.data) return <Spinner />;
  if (state.error || !state.data) return <ErrorBox error={state.error ?? '?'} onRetry={state.reload} />;
  const d = state.data;
  const s = d.signal;
  const currency = d.product.price?.currencyCode ?? d.price.latest?.currency ?? 'PLN';
  const money = (micros: number | null | undefined) => (micros === null || micros === undefined ? '–' : formatPrice({ amountMicros: String(micros), currencyCode: currency }));

  if (!s && !d.performance.series.length) {
    return (
      <Card>
        <Empty>
          {t('p360.noData')}{' '}
          <Link to="/settings" className="btn btn-sm">
            {t('p360.openSettings')}
          </Link>
        </Empty>
      </Card>
    );
  }

  const perfSeries = d.performance.series.map((ser, i) => ({
    id: ser.method,
    label: tOr(`p360.method.${ser.method}`, ser.method),
    color: seriesColor(i),
    points: ser.points.map((p) => ({ x: p.date, y: p[metric] })),
  }));
  const priceSeries = d.price.series.length
    ? [
        { id: 'price', label: t('p360.yourPrice'), color: seriesColor(0), points: d.price.series.filter((r) => r.priceMicros).map((r) => ({ x: r.date, y: r.priceMicros! / 1_000_000 })) },
        { id: 'bench', label: t('p360.benchmark'), color: seriesColor(2), points: d.price.series.filter((r) => r.benchmarkPriceMicros).map((r) => ({ x: r.date, y: r.benchmarkPriceMicros! / 1_000_000 })) },
      ].filter((x) => x.points.length)
    : [];

  return (
    <div className="p360">
      {s && (
        <Card
          title={
            <>
              {t('p360.recommendation')} <RecommendationBadge value={s.recommendation} />
              {s.previousRecommendation && s.previousRecommendation !== s.recommendation && (
                <span className="muted small">
                  {' '}
                  ({t('p360.previously')} <RecommendationBadge value={s.previousRecommendation} />)
                </span>
              )}
            </>
          }
          actions={<span className="muted small">{t('p360.computedAt', { date: formatDate(s.computedAt), end: s.windows.end })}</span>}
        >
          <div className="grid-2 align-start">
            <div>
              <p className="muted small">{tOr(`reco.hint.${s.recommendation}`, '')}</p>
              <ReasonList reasons={s.reasons} />
              <div className="p360-actions">
                <Link className="btn btn-sm" to={`/workflows/new?template=p360-label-scale`}>
                  {t('p360.createWorkflow')}
                </Link>
                {s.recommendation === 'REPRICE' && (
                  <Link className="btn btn-sm" to="/workflows/new?template=p360-reprice-weekend">
                    {t('p360.planSale')}
                  </Link>
                )}
              </div>
            </div>
            <div className="scores">
              <ScoreBar value={s.scores.demand} label={t('p360.score.demand')} />
              <ScoreBar value={s.scores.visibility} label={t('p360.score.visibility')} />
              <ScoreBar value={s.scores.price} label={t('p360.score.price')} />
              <ScoreBar value={s.scores.health} label={t('p360.score.health')} />
              <ScoreBar value={s.scores.efficiency} label={t('p360.score.efficiency')} />
            </div>
          </div>
        </Card>
      )}

      <div className="stats-row">
        <Stat label={t('p360.impressions', { n: days })} value={<>{formatNumber(d.performance.totals.impressions)} <Delta current={d.performance.totals.impressions} previous={d.performance.previousTotals?.impressions} /></>} />
        <Stat label={t('p360.clicks', { n: days })} value={<>{formatNumber(d.performance.totals.clicks)} <Delta current={d.performance.totals.clicks} previous={d.performance.previousTotals?.clicks} /></>} />
        <Stat label={t('p360.ctr')} value={d.performance.totals.ctr === null ? '–' : `${(d.performance.totals.ctr * 100).toFixed(2)} %`} />
        <Stat label={t('p360.conversions', { n: days })} value={<>{formatNumber(Math.round(d.performance.totals.conversions * 10) / 10)} <Delta current={d.performance.totals.conversions} previous={d.performance.previousTotals?.conversions} /></>} />
        <Stat label={t('p360.conversionValue')} value={money(d.performance.totals.conversionValueMicros)} />
        {d.price.latest?.benchmarkPriceMicros ? (
          <Stat
            label={t('p360.vsBenchmark')}
            tone={s?.market.priceVsBenchmark !== null && s?.market.priceVsBenchmark !== undefined ? (s.market.priceVsBenchmark > 0.1 ? 'error' : s.market.priceVsBenchmark > 0 ? 'warning' : 'ok') : 'neutral'}
            value={formatPct(s?.market.priceVsBenchmark)}
          />
        ) : null}
      </div>

      <Card
        title={t('p360.performance')}
        actions={
          <div className="inline-form">
            <select value={metric} onChange={(e) => setMetric(e.target.value as 'clicks')}>
              <option value="clicks">{t('p360.metric.clicks')}</option>
              <option value="impressions">{t('p360.metric.impressions')}</option>
              <option value="conversions">{t('p360.metric.conversions')}</option>
            </select>
            <div className="segmented">
              {RANGES.map((r) => (
                <button key={r} className={`btn btn-sm ${days === r ? 'btn-primary' : ''}`} onClick={() => setDays(r)}>
                  {r}d
                </button>
              ))}
            </div>
          </div>
        }
      >
        {perfSeries.length ? <LineChart series={perfSeries} /> : <Empty>{t('p360.noPerformance')}</Empty>}
        <div className="muted small">{t('p360.dataThrough', { date: d.freshness.performanceThrough ?? '–' })}</div>
      </Card>

      <OrganicCard data={d} productId={productId} days={days} onTitleIdea={onTitleIdea} />

      <div className="grid-2 align-start">
        <Card title={t('p360.priceCard')}>
          {d.price.latest ? (
            <>
              <table className="table kv">
                <tbody>
                  <tr>
                    <th>{t('p360.yourPrice')}</th>
                    <td>{money(d.price.latest.priceMicros ?? (d.product.price ? Number(d.product.price.amountMicros) : null))}</td>
                  </tr>
                  <tr>
                    <th>{t('p360.benchmark')}</th>
                    <td>
                      {money(d.price.latest.benchmarkPriceMicros)} <span className="muted small">({d.price.latest.country})</span>
                    </td>
                  </tr>
                  {d.price.latest.suggestedPriceMicros ? (
                    <tr>
                      <th>{t('p360.suggestedPrice')}</th>
                      <td>
                        {money(d.price.latest.suggestedPriceMicros)}{' '}
                        {d.price.latest.effectiveness && <Badge tone={d.price.latest.effectiveness === 'HIGH' ? 'ok' : d.price.latest.effectiveness === 'MEDIUM' ? 'warning' : 'neutral'}>{tOr(`p360.effectiveness.${d.price.latest.effectiveness}`, d.price.latest.effectiveness)}</Badge>}
                        <div className="muted small">
                          {t('p360.predicted', {
                            clicks: formatPct(d.price.latest.predictedClicksChange),
                            conversions: formatPct(d.price.latest.predictedConversionsChange),
                          })}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              {priceSeries.length > 0 && <LineChart series={priceSeries} height={140} yFormat={(v) => v.toFixed(0)} fillZeros={false} />}
            </>
          ) : (
            <Empty>{t('p360.noBenchmark')}</Empty>
          )}
        </Card>

        <Card title={t('p360.marketCard')}>
          {d.bestSellers.length ? (
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>{t('market.country')}</th>
                  <th>{t('market.category')}</th>
                  <th className="num">{t('market.rank')}</th>
                  <th>{t('market.demand')}</th>
                  <th>{t('market.change')}</th>
                </tr>
              </thead>
              <tbody>
                {d.bestSellers.map((b) => (
                  <tr key={`${b.country}-${b.categoryId}`}>
                    <td>{b.country}</td>
                    <td>
                      <Link to={`/market?country=${b.country}&category=${b.categoryId}`}>{b.category ?? b.categoryId}</Link>
                    </td>
                    <td className="num">
                      {b.rank ?? '–'} {b.previousRank !== null && b.rank !== null && b.previousRank !== b.rank && <span className="muted small">({t('market.was', { n: b.previousRank })})</span>}
                    </td>
                    <td>{tOr(`market.demandLevel.${b.relativeDemand}`, b.relativeDemand ?? '–')}</td>
                    <td>
                      <DemandChange value={b.demandChange} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>{t('p360.noBestSeller')}</Empty>
          )}
          {d.competitors.length > 0 && (
            <>
              <h4>{t('p360.competitors')}</h4>
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t('market.domain')}</th>
                    <th className="num">{t('market.visibility')}</th>
                    <th className="num">{t('market.overlap')}</th>
                    <th className="num">{t('market.higherPosition')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.competitors.slice(0, 8).map((c) => (
                    <tr key={`${c.country}-${c.categoryId}-${c.domain}`} className={c.isYourDomain ? 'row-highlight' : ''}>
                      <td>
                        {c.domain} {c.isYourDomain && <Badge tone="info">{t('market.you')}</Badge>}
                      </td>
                      <td className="num">{c.relativeVisibility === null ? '–' : c.relativeVisibility.toFixed(2)}</td>
                      <td className="num">{formatPct(c.pageOverlapRate)}</td>
                      <td className="num">{formatPct(c.higherPositionRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

export function DemandChange({ value }: { value: string | null }) {
  const { tOr } = useI18n();
  if (!value) return <span className="muted">–</span>;
  const tone = value === 'RISER' ? 'ok' : value === 'SINKER' ? 'error' : 'neutral';
  return (
    <Badge tone={tone}>
      {value === 'RISER' ? '▲ ' : value === 'SINKER' ? '▼ ' : ''}
      {tOr(`market.demandChange.${value}`, value)}
    </Badge>
  );
}

function OrganicCard({ data, productId, days, onTitleIdea }: { data: Product360; productId: string; days: number; onTitleIdea?: (query: string) => void }) {
  const { t } = useI18n();
  const { formatNumber, timeAgo } = useFormat();
  const [metric, setMetric] = useState<'clicks' | 'impressions' | 'position'>('impressions');
  const [queries, setQueries] = useState<SearchQueriesResponse | null | 'loading' | 'error'>(null);
  const search = data.search;

  if (!search.enabled) {
    return (
      <Card title={t('p360.organicCard')}>
        <Empty>
          {t('p360.organicDisabled')}{' '}
          <Link to="/settings" className="btn btn-sm">
            {t('p360.openSettings')}
          </Link>
        </Empty>
      </Card>
    );
  }
  if (!search.mapping) {
    return (
      <Card title={t('p360.organicCard')}>
        <Empty>{t('p360.organicUnmapped', { link: data.product.link ?? '–' })}</Empty>
      </Card>
    );
  }

  const loadQueries = async (refresh = false) => {
    setQueries('loading');
    try {
      setQueries(await api.get<SearchQueriesResponse>(`/api/products/${productId}/search-queries${refresh ? '?refresh=true' : ''}`));
    } catch {
      setQueries('error');
    }
  };

  const series = search.series.map((ser, i) => ({
    id: ser.appearance,
    label: t(ser.appearance === 'MERCHANT_LISTINGS' ? 'p360.appearance.MERCHANT_LISTINGS' : 'p360.appearance.ALL'),
    color: seriesColor(i + 3),
    points: ser.points.filter((p) => metric !== 'position' || p.position !== null).map((p) => ({ x: p.date, y: metric === 'position' ? (p.position ?? 0) : p[metric] })),
  }));
  const totals = search.totals;
  const prev = search.previousTotals;

  return (
    <Card
      title={
        <>
          {t('p360.organicCard')} {search.mapping.shared && <Badge tone="info" title={t('p360.sharedUrlHint')}>{t('p360.sharedUrl')}</Badge>}
        </>
      }
      actions={
        <select value={metric} onChange={(e) => setMetric(e.target.value as 'clicks')}>
          <option value="impressions">{t('p360.metric.impressions')}</option>
          <option value="clicks">{t('p360.metric.clicks')}</option>
          <option value="position">{t('p360.metric.position')}</option>
        </select>
      }
    >
      <div className="stats-row">
        <Stat label={t('p360.impressions', { n: days })} value={<>{formatNumber(totals.impressions)} <Delta current={totals.impressions} previous={prev?.impressions} /></>} />
        <Stat label={t('p360.clicks', { n: days })} value={<>{formatNumber(totals.clicks)} <Delta current={totals.clicks} previous={prev?.clicks} /></>} />
        <Stat label={t('p360.ctr')} value={totals.ctr === null ? '–' : `${(totals.ctr * 100).toFixed(2)} %`} />
        <Stat
          label={t('p360.avgPosition')}
          tone={totals.position === null ? 'neutral' : totals.position <= 5 ? 'ok' : totals.position <= 20 ? 'warning' : 'error'}
          value={
            <>
              {totals.position ?? '–'} <Delta current={totals.position} previous={prev?.position} invert />
            </>
          }
        />
      </div>
      {series.length ? <LineChart series={series} height={150} yFormat={(v) => (metric === 'position' ? v.toFixed(1) : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)))} fillZeros={metric !== 'position'} /> : <Empty>{t('p360.noOrganic')}</Empty>}
      <div className="muted small">
        {t('p360.dataThrough', { date: data.freshness.searchThrough ?? '–' })} ·{' '}
        <a href={search.mapping.canonicalUrl} target="_blank" rel="noreferrer">
          {search.mapping.canonicalUrl}
        </a>
      </div>

      <h4>{t('p360.topQueries')}</h4>
      {queries === null && (
        <button className="btn btn-sm" onClick={() => loadQueries()}>
          {t('p360.loadQueries')}
        </button>
      )}
      {queries === 'loading' && <Spinner />}
      {queries === 'error' && <ErrorBox error={t('p360.queriesFailed')} onRetry={() => loadQueries(true)} />}
      {queries && typeof queries === 'object' && (
        <>
          {queries.rows.length === 0 ? (
            <Empty>{t('p360.noQueries')}</Empty>
          ) : (
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>{t('p360.query')}</th>
                  <th className="num">{t('p360.metric.impressions')}</th>
                  <th className="num">{t('p360.metric.clicks')}</th>
                  <th className="num">{t('p360.ctr')}</th>
                  <th className="num">{t('p360.metric.position')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {queries.rows.map((q) => {
                  const inTitle = (data.product.title ?? '').toLowerCase().includes(q.query.toLowerCase());
                  const easyWin = q.position !== null && q.position >= 6 && q.position <= 20;
                  return (
                    <tr key={q.query}>
                      <td>
                        {q.query} {easyWin && <Badge tone="warning" title={t('p360.easyWinHint')}>{t('p360.easyWin')}</Badge>}
                        {inTitle && <Badge tone="neutral">{t('p360.inTitle')}</Badge>}
                      </td>
                      <td className="num">{formatNumber(q.impressions)}</td>
                      <td className="num">{formatNumber(q.clicks)}</td>
                      <td className="num">{q.ctr === null ? '–' : `${(q.ctr * 100).toFixed(1)} %`}</td>
                      <td className="num">{q.position ?? '–'}</td>
                      <td>
                        {onTitleIdea && !inTitle && (
                          <button className="btn btn-sm btn-ghost" onClick={() => onTitleIdea(q.query)}>
                            {t('p360.useInTitle')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="muted small">
            {queries.window && `${queries.window.from} – ${queries.window.to}`} {queries.fetchedAt && `· ${t('p360.fetched', { ago: timeAgo(queries.fetchedAt) })}`} ·{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), loadQueries(true))}>
              {t('common.refresh')}
            </a>
          </div>
        </>
      )}
    </Card>
  );
}
