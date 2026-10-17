import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import type { ProductRecord, Recommendation, SignalReason } from '../lib/types';
import { Badge, Empty } from './ui';
import { Delta } from './charts';

export const RECOMMENDATION_TONE: Record<Recommendation, 'ok' | 'error' | 'warning' | 'info' | 'neutral'> = {
  SCALE: 'ok',
  FIX: 'error',
  REPRICE: 'warning',
  OPTIMISE_LISTING: 'warning',
  WATCH: 'info',
  PAUSE: 'error',
  KEEP: 'neutral',
  NO_DATA: 'neutral',
};

export function RecommendationBadge({ value, title }: { value: Recommendation | string | null | undefined; title?: string }) {
  const { tOr } = useI18n();
  if (!value) return <span className="muted">–</span>;
  const tone = RECOMMENDATION_TONE[value as Recommendation] ?? 'neutral';
  return (
    <Badge tone={tone} title={title ?? tOr(`reco.hint.${value}`, '')}>
      {tOr(`reco.${value}`, value.replace(/_/g, ' '))}
    </Badge>
  );
}

/** Translates reason codes + params into sentences. */
export function ReasonList({ reasons }: { reasons: SignalReason[] }) {
  const { tOr } = useI18n();
  if (!reasons.length) return null;
  return (
    <ul className="reason-list">
      {reasons.map((r, i) => {
        const params: Record<string, string | number | null | undefined> = { ...(r.params ?? {}) };
        for (const key of ['ctr', 'median']) if (typeof params[key] === 'number') params[key] = `${((params[key] as number) * 100).toFixed(2)} %`;
        if (typeof params.price === 'number') params.price = `${(params.price as number).toFixed(2)} ${params.currency ?? ''}`;
        return <li key={i}>{tOr(`reason.${r.code}`, r.code.replace(/_/g, ' '), params)}</li>;
      })}
    </ul>
  );
}

export function formatPct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return '–';
  const pct = value * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(digits)} %`;
}

/** Compact product table used by the dashboard "Focus / Fix / Price" lists. */
export function SignalProductList({ products, emptyText }: { products: ProductRecord[]; emptyText: string }) {
  const { t } = useI18n();
  if (!products.length) return <Empty>{emptyText}</Empty>;
  return (
    <table className="table table-compact">
      <thead>
        <tr>
          <th>{t('common.product')}</th>
          <th className="num">{t('p360.clicks7d')}</th>
          <th className="num">{t('p360.vsPrev')}</th>
          <th className="num">{t('p360.demand')}</th>
          <th className="num">{t('p360.price')}</th>
        </tr>
      </thead>
      <tbody>
        {products.map((p) => (
          <tr key={p.name}>
            <td>
              <Link to={`/products/${p.productId}`}>{p.title ?? p.offerId}</Link>
              <div className="muted small">{p.offerId}</div>
            </td>
            <td className="num">{p.signal?.clicks7d ?? 0}</td>
            <td className="num">{p.signal ? <Delta current={p.signal.clicks7d} previous={p.signal.clicksPrev7d} /> : '–'}</td>
            <td className="num">{p.signal?.scores.demand ?? '–'}</td>
            <td className="num">{formatPct(p.signal?.priceVsBenchmark)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
