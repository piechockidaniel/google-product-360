import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useAsync } from '../lib/hooks';
import type { BestSeller, Competitor, PerformanceTotals, DailyPoint } from '../lib/types';
import { Badge, Card, Empty, ErrorBox, Pagination, Spinner, Stat } from '../components/ui';
import { Delta, LineChart, seriesColor } from '../components/charts';
import { DemandChange } from '../components/Product360Panel';
import { RecommendationBadge, formatPct } from '../components/signals';

interface Overview {
  windowEnd: string;
  totals7d: PerformanceTotals & { products: number };
  totalsPrev7d: PerformanceTotals & { products: number };
  series: { method: string; points: DailyPoint[] }[];
  recommendationCounts: Record<string, number>;
  risers: BestSeller[];
  sinkers: BestSeller[];
  notCarried: BestSeller[];
}

interface BestSellersResponse {
  items: BestSeller[];
  total: number;
  reportDate: string | null;
  facets: { countries: string[]; categories: { id: string; name: string | null }[] };
}

interface CompetitorsResponse {
  rows: Competitor[];
  window: { from: string; to: string };
  facets: { countries: string[]; categories: string[] };
}

const LIMIT = 50;

/** Market view: best sellers (carried / not carried), demand trends and competitor visibility. */
export default function MarketPage() {
  const { t, tOr } = useI18n();
  const { formatNumber } = useFormat();
  const [params, setParams] = useSearchParams();
  const [metric, setMetric] = useState<'clicks' | 'impressions'>('clicks');
  const query = useMemo(
    () => ({
      country: params.get('country') ?? '',
      category: params.get('category') ?? '',
      carried: params.get('carried') ?? '',
      demandChange: params.get('demandChange') ?? '',
      offset: Number(params.get('offset') ?? 0),
    }),
    [params],
  );
  const overview = useAsync(() => api.get<Overview>('/api/market/overview'), []);
  const best = useAsync(() => api.get<BestSellersResponse>(`/api/market/best-sellers${qs({ ...query, limit: LIMIT })}`), [JSON.stringify(query)]);
  const competitors = useAsync(() => api.get<CompetitorsResponse>(`/api/market/competitors${qs({ country: query.country, categoryId: query.category })}`), [query.country, query.category]);

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('offset' in patch)) next.delete('offset');
    setParams(next);
  };

  if (overview.loading && !overview.data) return <Spinner />;
  if (overview.error && !overview.data) return <ErrorBox error={overview.error} onRetry={overview.reload} />;
  const o = overview.data!;
  const series = o.series.map((ser, i) => ({ id: ser.method, label: tOr(`p360.method.${ser.method}`, ser.method), color: seriesColor(i), points: ser.points.map((p) => ({ x: p.date, y: p[metric] })) }));
  const noData = !o.series.length && !best.data?.total;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{t('market.title')}</h1>
          <div className="muted">{t('market.subtitle')}</div>
        </div>
        <div className="page-actions">
          <span className="muted small">{t('p360.dataThrough', { date: o.windowEnd })}</span>
        </div>
      </header>

      {noData && (
        <Card>
          <Empty>
            {t('market.noData')}{' '}
            <Link to="/settings" className="btn btn-sm">
              {t('p360.openSettings')}
            </Link>
          </Empty>
        </Card>
      )}

      <div className="stats-row">
        <Stat label={t('p360.impressions', { n: 7 })} value={<>{formatNumber(o.totals7d.impressions)} <Delta current={o.totals7d.impressions} previous={o.totalsPrev7d.impressions} /></>} />
        <Stat label={t('p360.clicks', { n: 7 })} value={<>{formatNumber(o.totals7d.clicks)} <Delta current={o.totals7d.clicks} previous={o.totalsPrev7d.clicks} /></>} />
        <Stat label={t('p360.ctr')} value={o.totals7d.ctr === null ? '–' : `${(o.totals7d.ctr * 100).toFixed(2)} %`} />
        <Stat label={t('market.risers')} value={o.risers.length} tone="ok" />
        <Stat label={t('market.sinkers')} value={o.sinkers.length} tone={o.sinkers.length ? 'warning' : 'neutral'} />
        <Stat label={t('market.notCarried')} value={o.notCarried.length} />
      </div>

      <Card
        title={t('market.catalogueTrend')}
        actions={
          <select value={metric} onChange={(e) => setMetric(e.target.value as 'clicks')}>
            <option value="clicks">{t('p360.metric.clicks')}</option>
            <option value="impressions">{t('p360.metric.impressions')}</option>
          </select>
        }
      >
        {series.length ? <LineChart series={series} height={200} /> : <Empty>{t('p360.noPerformance')}</Empty>}
      </Card>

      <Card
        title={
          <>
            {t('market.bestSellers')} {best.data?.reportDate && <span className="muted small">({t('market.reportWeek', { date: best.data.reportDate })})</span>}
          </>
        }
      >
        <div className="filter-row">
          <select value={query.country} onChange={(e) => update({ country: e.target.value })}>
            <option value="">{t('market.anyCountry')}</option>
            {best.data?.facets.countries.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select value={query.category} onChange={(e) => update({ category: e.target.value })}>
            <option value="">{t('market.anyCategory')}</option>
            {best.data?.facets.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name ?? c.id}
              </option>
            ))}
          </select>
          <select value={query.carried} onChange={(e) => update({ carried: e.target.value })}>
            <option value="">{t('market.carriedAny')}</option>
            <option value="true">{t('market.carriedYes')}</option>
            <option value="false">{t('market.carriedNo')}</option>
          </select>
          <select value={query.demandChange} onChange={(e) => update({ demandChange: e.target.value })}>
            <option value="">{t('market.anyChange')}</option>
            <option value="RISER">{t('market.demandChange.RISER')}</option>
            <option value="FLAT">{t('market.demandChange.FLAT')}</option>
            <option value="SINKER">{t('market.demandChange.SINKER')}</option>
          </select>
          <button className="btn btn-ghost" onClick={() => setParams(new URLSearchParams())}>
            {t('products.reset')}
          </button>
        </div>
        <ErrorBox error={best.error} onRetry={best.reload} />
        {best.loading && !best.data ? (
          <Spinner />
        ) : !best.data?.items.length ? (
          <Empty>{t('market.noBestSellers')}</Empty>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th className="num">{t('market.rank')}</th>
                  <th>{t('common.product')}</th>
                  <th>{t('market.brand')}</th>
                  <th>{t('market.category')}</th>
                  <th>{t('market.country')}</th>
                  <th>{t('market.demand')}</th>
                  <th>{t('market.change')}</th>
                  <th>{t('market.inventory')}</th>
                </tr>
              </thead>
              <tbody>
                {best.data.items.map((b) => (
                  <tr key={`${b.country}-${b.categoryId}-${b.clusterKey}`} className={b.productName ? 'row-highlight' : ''}>
                    <td className="num">
                      {b.rank ?? '–'}
                      {b.previousRank !== null && b.rank !== null && b.previousRank !== b.rank && (
                        <span className={`small ${b.previousRank > b.rank ? 'text-ok' : 'text-error'}`}> {b.previousRank > b.rank ? '▲' : '▼'}{Math.abs(b.previousRank - b.rank)}</span>
                      )}
                    </td>
                    <td>
                      {b.productId ? <Link to={`/products/${b.productId}`}>{b.title}</Link> : b.title}
                      {b.offerId && <div className="muted small">{b.offerId}</div>}
                    </td>
                    <td className="muted">{b.brand ?? '–'}</td>
                    <td className="muted">{b.category ?? b.categoryId}</td>
                    <td>{b.country}</td>
                    <td>{tOr(`market.demandLevel.${b.relativeDemand}`, b.relativeDemand ?? '–')}</td>
                    <td>
                      <DemandChange value={b.demandChange} />
                    </td>
                    <td>
                      {b.productName ? (
                        <Badge tone={b.inventoryStatus === 'OUT_OF_STOCK' ? 'warning' : 'ok'}>{tOr(`market.inventory.${b.inventoryStatus}`, b.inventoryStatus ?? '')}</Badge>
                      ) : (
                        <Badge tone="neutral">{t('market.inventory.NOT_IN_INVENTORY')}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination total={best.data.total} limit={LIMIT} offset={query.offset} onChange={(offset) => update({ offset: String(offset) })} />
          </>
        )}
      </Card>

      <Card title={<>{t('market.competitors')} {competitors.data && <span className="muted small">({competitors.data.window.from} – {competitors.data.window.to})</span>}</>}>
        <p className="muted small">{t('market.competitorsHint')}</p>
        {competitors.loading && !competitors.data ? (
          <Spinner />
        ) : !competitors.data?.rows.length ? (
          <Empty>{t('market.noCompetitors')}</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('market.country')}</th>
                <th>{t('market.category')}</th>
                <th>{t('market.domain')}</th>
                <th className="num">{t('market.avgRank')}</th>
                <th className="num">{t('market.visibility')}</th>
                <th className="num">{t('market.overlap')}</th>
                <th className="num">{t('market.higherPosition')}</th>
                <th className="num">{t('market.adsOrganic')}</th>
              </tr>
            </thead>
            <tbody>
              {competitors.data.rows.slice(0, 60).map((c) => (
                <tr key={`${c.country}-${c.categoryId}-${c.domain}`} className={c.isYourDomain ? 'row-highlight' : ''}>
                  <td>{c.country}</td>
                  <td className="muted">{best.data?.facets.categories.find((x) => x.id === c.categoryId)?.name ?? c.categoryId}</td>
                  <td>
                    {c.domain} {c.isYourDomain && <Badge tone="info">{t('market.you')}</Badge>}
                  </td>
                  <td className="num">{c.avgRank ?? '–'}</td>
                  <td className="num">{c.relativeVisibility === null ? '–' : c.relativeVisibility.toFixed(2)}</td>
                  <td className="num">{formatPct(c.pageOverlapRate)}</td>
                  <td className="num">{formatPct(c.higherPositionRate)}</td>
                  <td className="num">{c.adsOrganicRatio === null ? '–' : c.adsOrganicRatio.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={t('p360.recommendations')}>
        <div className="reco-grid">
          {Object.entries(o.recommendationCounts).map(([r, n]) => (
            <Link key={r} to={`/products?recommendation=${r}&orderBy=impressions7d&orderDir=desc`} className="reco-tile">
              <span className="reco-count">{n}</span>
              <RecommendationBadge value={r} />
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}
