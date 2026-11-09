import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useAsync } from '../lib/hooks';
import type { Facets, ProductRecord } from '../lib/types';
import { Badge, Card, Empty, ErrorBox, LevelBadge, Modal, Pagination, Spinner, StatusBadge, useToast } from '../components/ui';
import AttributeForm from '../components/AttributeForm';
import { Delta } from '../components/charts';
import { RecommendationBadge, formatPct } from '../components/signals';
import { RECOMMENDATIONS } from '../lib/types';
import ProductDetailPage from './ProductDetailPage';
import SortableHeader from '../components/SortableHeader';

const STATUSES = ['APPROVED', 'PARTIALLY_APPROVED', 'DISAPPROVED', 'PENDING', 'NOT_ELIGIBLE', 'UNKNOWN'];
const LIMIT = 50;

export default function ProductsPage() {
  const [params, setParams] = useSearchParams();
  const notify = useToast();
  const { t, lang } = useI18n();
  const { formatPrice, timeAgo } = useFormat();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'p360' | 'issues'>('p360');

  const query = useMemo(
    () => ({
      q: params.get('q') ?? '',
      offerIdContains: params.get('offerIdContains') ?? '',
      titleContains: params.get('titleContains') ?? '',
      priceMin: params.get('priceMin') ?? '',
      issueCount: params.get('issueCount') ?? '',
      clicksMin: params.get('clicksMin') ?? '',
      priceVsMinPct: params.get('priceVsMinPct') ?? '',
      organicMin: params.get('organicMin') ?? '',
      seenSince: params.get('seenSince') ?? '',
      status: params.get('status') ?? '',
      severity: params.get('severity') ?? '',
      issueCode: params.get('issueCode') ?? '',
      tag: params.get('tag') ?? '',
      feedLabel: params.get('feedLabel') ?? '',
      brand: params.get('brand') ?? '',
      availability: params.get('availability') ?? '',
      hasIssues: params.get('hasIssues') ?? '',
      category: params.get('category') ?? '',
      recommendation: params.get('recommendation') ?? '',
      orderBy: params.get('orderBy') ?? 'offerId',
      orderDir: params.get('orderDir') ?? 'asc',
      offset: Number(params.get('offset') ?? 0),
    }),
    [params],
  );

  const facets = useAsync(() => api.get<Facets>('/api/products/facets'), []);
  const products = useAsync(
    () => api.get<{ items: ProductRecord[]; total: number }>(`/api/products${qs({ ...query, limit: LIMIT })}`),
    [JSON.stringify(query)],
  );

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('offset' in patch)) next.delete('offset');
    setParams(next);
  };

  const toggleAll = () => {
    const items = products.data?.items ?? [];
    if (items.every((p) => selected.has(p.productId))) setSelected(new Set());
    else setSelected(new Set(items.map((p) => p.productId)));
  };

  const sortBy = (column: string) => {
    if (query.orderBy === column) update({ orderDir: query.orderDir === 'asc' ? 'desc' : 'asc' });
    else update({ orderBy: column, orderDir: 'asc' });
  };
  const heading = (column: string, label: string) => <SortableHeader label={label} active={query.orderBy === column} direction={query.orderDir === 'desc' ? 'desc' : 'asc'} onSort={() => sortBy(column)} />;
  const filterLabel = (label: string) => `${lang === 'pl' ? 'Filtruj' : 'Filter'}: ${label}`;
  const signals = facets.data?.signalsComputed ?? false;

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('products.title')}</h1>
        <div className="page-actions">
          {selected.size > 0 && (
            <>
              <span className="muted">{t('products.selected', { n: selected.size })}</span>
              <button className="btn btn-primary" onClick={() => setBulkOpen(true)}>
                {t('products.bulkEdit')}
              </button>
              <button className="btn btn-ghost" onClick={() => setSelected(new Set())}>
                {t('products.clear')}
              </button>
            </>
          )}
        </div>
      </header>

      <Card className="filters">
        <div className="filter-row">
          <input placeholder={t('products.search')} value={query.q} onChange={(e) => update({ q: e.target.value })} />
          <select value={query.status} onChange={(e) => update({ status: e.target.value })}>
            <option value="">{t('products.anyStatus')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}` as 'status.APPROVED')}
              </option>
            ))}
          </select>
          <select value={query.severity} onChange={(e) => update({ severity: e.target.value })}>
            <option value="">{t('products.anySeverity')}</option>
            <option value="error">{t('level.errors')}</option>
            <option value="warning">{t('level.warnings')}</option>
            <option value="info">{t('level.info')}</option>
          </select>
          <select value={query.hasIssues} onChange={(e) => update({ hasIssues: e.target.value })}>
            <option value="">{t('products.withOrWithout')}</option>
            <option value="true">{t('products.withIssues')}</option>
            <option value="false">{t('products.withoutIssues')}</option>
          </select>
          <select value={query.issueCode} onChange={(e) => update({ issueCode: e.target.value })}>
            <option value="">{t('products.anyIssue')}</option>
            {facets.data?.issueCodes.map((c) => (
              <option key={c.code} value={c.code}>
                {c.description ?? c.code} ({c.count})
              </option>
            ))}
          </select>
          <select value={query.tag} onChange={(e) => update({ tag: e.target.value })}>
            <option value="">{t('products.anyTag')}</option>
            {facets.data?.tags.map((t) => (
              <option key={t.tag} value={t.tag}>
                {t.tag} ({t.count})
              </option>
            ))}
          </select>
          <select value={query.feedLabel} onChange={(e) => update({ feedLabel: e.target.value })}>
            <option value="">{t('products.anyFeedLabel')}</option>
            {facets.data?.feedLabels.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <select value={query.brand} onChange={(e) => update({ brand: e.target.value })}>
            <option value="">{t('products.anyBrand')}</option>
            {facets.data?.brands.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <select value={query.availability} onChange={(e) => update({ availability: e.target.value })}>
            <option value="">{t('products.anyAvailability')}</option>
            {facets.data?.availability.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          {facets.data?.categories.length ? (
            <select value={query.category} onChange={(e) => update({ category: e.target.value })}>
              <option value="">{t('products.anyCategory')}</option>
              {facets.data.categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          ) : null}
          {facets.data?.signalsComputed && (
            <select value={query.recommendation} onChange={(e) => update({ recommendation: e.target.value })}>
              <option value="">{t('products.anyRecommendation')}</option>
              {RECOMMENDATIONS.map((r) => (
                <option key={r} value={r}>
                  {t(`reco.${r}` as 'reco.SCALE')} ({facets.data?.recommendations[r] ?? 0})
                </option>
              ))}
            </select>
          )}
          <button className="btn btn-ghost" onClick={() => setParams(new URLSearchParams())}>
            {t('products.reset')}
          </button>
        </div>
      </Card>

      <ErrorBox error={products.error} onRetry={products.reload} />
      {products.loading && !products.data ? (
        <Spinner />
      ) : !products.data ? (
        <Empty>{t('products.empty')}</Empty>
      ) : (
        <Card className="products-results">
          <div className="products-table-scroll" role="region" aria-label={t('nav.products')} tabIndex={0}>
          <table className="table table-products">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={products.data.items.length > 0 && products.data.items.every((p) => selected.has(p.productId))} onChange={toggleAll} />
                </th>
                <th></th>
                {heading('offerId', t('products.offerId'))}
                {heading('title', t('products.titleCol'))}
                {heading('brand', t('products.brand'))}
                {heading('feedLabel', t('products.feed'))}
                {heading('price', t('products.price'))}
                {heading('availability', t('products.availability'))}
                {heading('status', t('common.status'))}
                {heading('issues', t('common.issues'))}
                {signals && (
                  <>
                    {heading('recommendation', t('p360.recommendation'))}
                    {heading('clicks7d', t('p360.clicks7d'))}
                    {heading('priceVsBenchmark', t('p360.price'))}
                    {facets.data?.searchConsoleEnabled && (
                      heading('organicImpressions28d', t('p360.organicCol'))
                    )}
                  </>
                )}
                {heading('lastSeen', t('products.seen'))}
                <th className="actions">{t('products.actions')}</th>
              </tr>
              <tr className="table-filter-row">
                <th /><th />
                <th><input aria-label={filterLabel(t('products.offerId'))} value={query.offerIdContains} onChange={(e) => update({ offerIdContains: e.target.value })} /></th>
                <th><input aria-label={filterLabel(t('products.titleCol'))} value={query.titleContains} onChange={(e) => update({ titleContains: e.target.value })} /></th>
                <th><select aria-label={filterLabel(t('products.brand'))} value={query.brand} onChange={(e) => update({ brand: e.target.value })}><option value="">{t('products.anyBrand')}</option>{facets.data?.brands.map((brand) => <option key={brand} value={brand}>{brand}</option>)}</select></th>
                <th><select aria-label={filterLabel(t('products.feed'))} value={query.feedLabel} onChange={(e) => update({ feedLabel: e.target.value })}><option value="">{t('products.anyFeedLabel')}</option>{facets.data?.feedLabels.map((feed) => <option key={feed} value={feed}>{feed}</option>)}</select></th>
                <th><input type="number" min="0" step="0.01" aria-label={filterLabel(t('products.price'))} placeholder="≥" value={query.priceMin} onChange={(e) => update({ priceMin: e.target.value })} /></th>
                <th><select aria-label={filterLabel(t('products.availability'))} value={query.availability} onChange={(e) => update({ availability: e.target.value })}><option value="">{t('products.anyAvailability')}</option>{facets.data?.availability.map((value) => <option key={value} value={value}>{value}</option>)}</select></th>
                <th><select aria-label={filterLabel(t('common.status'))} value={query.status} onChange={(e) => update({ status: e.target.value })}><option value="">{t('products.anyStatus')}</option>{STATUSES.map((value) => <option key={value} value={value}>{t(`status.${value}` as 'status.APPROVED')}</option>)}</select></th>
                <th><input type="number" min="0" step="1" aria-label={filterLabel(t('common.issues'))} value={query.issueCount} onChange={(e) => update({ issueCount: e.target.value })} /></th>
                {signals && <>
                  <th><select aria-label={filterLabel(t('p360.recommendation'))} value={query.recommendation} onChange={(e) => update({ recommendation: e.target.value })}><option value="">{t('products.anyRecommendation')}</option>{RECOMMENDATIONS.map((value) => <option key={value} value={value}>{t(`reco.${value}` as 'reco.SCALE')}</option>)}</select></th>
                  <th><input type="number" min="0" step="1" aria-label={filterLabel(t('p360.clicks7d'))} placeholder="≥" value={query.clicksMin} onChange={(e) => update({ clicksMin: e.target.value })} /></th>
                  <th><input type="number" step="1" aria-label={filterLabel(t('p360.price'))} placeholder="≥ %" value={query.priceVsMinPct} onChange={(e) => update({ priceVsMinPct: e.target.value })} /></th>
                  {facets.data?.searchConsoleEnabled && <th><input type="number" min="0" step="1" aria-label={filterLabel(t('p360.organicCol'))} placeholder="≥" value={query.organicMin} onChange={(e) => update({ organicMin: e.target.value })} /></th>}
                </>}
                <th><input type="date" aria-label={filterLabel(t('products.seen'))} value={query.seenSince} onChange={(e) => update({ seenSince: e.target.value })} /></th>
                <th className="actions" />
              </tr>
            </thead>
            <tbody>
              {products.data.items.map((p) => (
                <tr key={p.name} className={selected.has(p.productId) ? 'selected' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(p.productId)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(p.productId);
                        else next.delete(p.productId);
                        setSelected(next);
                      }}
                    />
                  </td>
                  <td>{p.imageLink ? <img className="thumb" src={p.imageLink} alt="" loading="lazy" onError={(e) => e.currentTarget.classList.add('thumb-hidden')} /> : <span className="thumb thumb-empty" />}</td>
                  <td>
                    <Link to={`/products/${p.productId}`} onClick={(e) => { if (!e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); setDetailTab('p360'); setDetailId(p.productId); } }}>{p.offerId}</Link>
                  </td>
                  <td>
                    <Link to={`/products/${p.productId}`} onClick={(e) => { if (!e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); setDetailTab('p360'); setDetailId(p.productId); } }}>{p.title ?? <span className="muted">{t('products.noTitle')}</span>}</Link>
                  </td>
                  <td className="muted">{p.brand ?? '–'}</td>
                  <td className="muted">
                    {p.feedLabel}/{p.contentLanguage}
                  </td>
                  <td>{formatPrice(p.price)}</td>
                  <td className="muted">{p.availability ?? '–'}</td>
                  <td>
                    <StatusBadge status={p.aggregatedStatus} />
                  </td>
                  <td className="num">{p.issueCount > 0 ? <LevelBadge level={p.maxSeverity} label={String(p.issueCount)} /> : <Badge tone="ok">0</Badge>}</td>
                  {signals && (
                    <>
                      <td>
                        <RecommendationBadge value={p.signal?.recommendation} />
                      </td>
                      <td className="num">
                        {p.signal?.clicks7d ?? 0} {p.signal && <Delta current={p.signal.clicks7d} previous={p.signal.clicksPrev7d} />}
                      </td>
                      <td className="num">{formatPct(p.signal?.priceVsBenchmark)}</td>
                      {facets.data?.searchConsoleEnabled && (
                        <td className="num" title={t('p360.organicColHint')}>
                          {p.signal?.scImpressions28d ?? 0}
                          {p.signal?.scPosition28d !== null && p.signal?.scPosition28d !== undefined && <span className="muted small"> @{p.signal.scPosition28d}</span>}
                        </td>
                      )}
                    </>
                  )}
                  <td className="muted small">{timeAgo(p.lastSeenAt)}</td>
                  <td className="actions">
                    {p.issueCount > 0 ? (
                      <button
                        className={`btn btn-sm ${p.signal?.recommendation === 'FIX' ? 'btn-primary' : ''}`}
                        title={t('products.fixHint')}
                        onClick={() => {
                          setDetailTab('issues');
                          setDetailId(p.productId);
                        }}
                      >
                        {p.signal?.recommendation === 'FIX' ? t('products.fix') : t('products.viewIssues')}
                      </button>
                    ) : (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setDetailTab('p360');
                          setDetailId(p.productId);
                        }}
                      >
                        {t('products.view')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {!products.data.items.length && <Empty>{t('products.empty')}</Empty>}
          <Pagination total={products.data.total} limit={LIMIT} offset={query.offset} onChange={(offset) => update({ offset: String(offset) })} />
        </Card>
      )}

      {bulkOpen && facets.data && (
        <Modal title={t('products.bulkTitle', { n: selected.size })} onClose={() => setBulkOpen(false)} wide>
          <BulkEditor
            catalog={facets.data.attributeCatalog}
            count={selected.size}
            onSubmit={async (payload) => {
              try {
                const r = await api.post<{ ok: number; failed: number; results: { productId: string; error?: string }[] }>('/api/products/bulk', {
                  productIds: [...selected],
                  ...payload,
                });
                notify(t('products.bulkDone', { ok: r.ok, failed: r.failed ? t('products.bulkFailed', { n: r.failed }) : '' }), r.failed ? 'error' : 'ok');
                setBulkOpen(false);
                setSelected(new Set());
                void products.reload();
                void facets.reload();
              } catch (err) {
                notify((err as Error).message, 'error');
              }
            }}
          />
        </Modal>
      )}
      {detailId && (
        <div className="detail-drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setDetailId(null); }}>
          <aside className="detail-drawer" aria-label={t('detail.close')}>
            <ProductDetailPage key={`${detailId}-${detailTab}`} embedded productId={detailId} initialTab={detailTab} onClose={() => setDetailId(null)} />
          </aside>
        </div>
      )}
    </div>
  );
}

function BulkEditor({
  catalog,
  count,
  onSubmit,
}: {
  catalog: Facets['attributeCatalog'];
  count: number;
  onSubmit: (payload: { attributes?: Record<string, unknown>; addTags?: string[]; removeTags?: string[] }) => Promise<void>;
}) {
  const [attributes, setAttributes] = useState<Record<string, unknown>>({});
  const [addTags, setAddTags] = useState('');
  const [removeTags, setRemoveTags] = useState('');
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  return (
    <div className="form">
      <h4>{t('products.localTags')}</h4>
      <div className="grid-2">
        <label>
          {t('products.addTags')}
          <input value={addTags} onChange={(e) => setAddTags(e.target.value)} placeholder="promo, review" />
        </label>
        <label>
          {t('products.removeTags')}
          <input value={removeTags} onChange={(e) => setRemoveTags(e.target.value)} />
        </label>
      </div>
      <h4>{t('products.pushedAttributes')}</h4>
      <AttributeForm catalog={catalog} value={attributes} onChange={setAttributes} />
      <div className="form-actions">
        <button
          className="btn btn-primary"
          disabled={busy || (!Object.keys(attributes).length && !addTags && !removeTags)}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit({
                ...(Object.keys(attributes).length ? { attributes } : {}),
                ...(addTags ? { addTags: split(addTags) } : {}),
                ...(removeTags ? { removeTags: split(removeTags) } : {}),
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t('products.applying') : t('products.applyTo', { n: count })}
        </button>
      </div>
    </div>
  );
}
