import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useAsync } from '../lib/hooks';
import type { AppEvent, Facets, ProductDetails, ProductIssue, RemediationOperation, RemediationProposal, RenderedIssue } from '../lib/types';
import { Badge, Card, Confirm, Empty, ErrorBox, LevelBadge, Spinner, StatusBadge, TagList, useToast } from '../components/ui';
import AttributeForm from '../components/AttributeForm';
import Product360Panel from '../components/Product360Panel';
import { RecommendationBadge } from '../components/signals';

export default function ProductDetailPage({ embedded = false, productId, onClose }: { embedded?: boolean; productId?: string; onClose?: () => void }) {
  const route = useParams();
  const id = productId ?? route.id ?? '';
  const notify = useToast();
  const { t } = useI18n();
  const { formatDate, formatPrice, timeAgo } = useFormat();
  const product = useAsync(() => api.get<ProductDetails>(`/api/products/${id}`), [id]);
  const facets = useAsync(() => api.get<Facets>('/api/products/facets'), []);
  const rendered = useAsync(() => api.get<{ issues: RenderedIssue[] }>(`/api/products/${id}/rendered-issues`).catch(() => ({ issues: [] as RenderedIssue[] })), [id]);
  const history = useAsync(() => api.get<{ issues: ProductIssue[]; events: AppEvent[] }>(`/api/products/${id}/history`), [id, product.data?.lastSeenAt]);
  const remediations = useAsync(() => api.get<{ proposals: RemediationProposal[]; operations: RemediationOperation[] }>(`/api/products/${id}/remediations`), [id, product.data?.lastSeenAt]);
  const [tab, setTab] = useState<'p360' | 'issues' | 'attributes' | 'enrich' | 'history' | 'raw'>('p360');
  /** Search query picked on the 360° tab – pre-fills the title in the enrichment form. */
  const [titleIdea, setTitleIdea] = useState<string | null>(null);
  const [remediationBusy, setRemediationBusy] = useState<string | null>(null);
  const latestOperation = remediations.data?.operations[0];

  useEffect(() => {
    if (!latestOperation || !['queued', 'running', 'pending_google'].includes(latestOperation.status)) return;
    const timer = window.setInterval(() => void remediations.reload(), 1000);
    return () => window.clearInterval(timer);
  }, [latestOperation?.id, latestOperation?.status]);

  useEffect(() => {
    if (latestOperation?.status === 'succeeded') {
      void product.reload();
      void history.reload();
    }
  }, [latestOperation?.id, latestOperation?.status]);

  if (product.loading && !product.data) return <Spinner />;
  if (product.error || !product.data) return <ErrorBox error={product.error ?? '404'} onRetry={product.reload} />;
  const p = product.data;
  const attrs = p.product.productAttributes ?? {};

  const refresh = async () => {
    try {
      const fresh = await api.post<ProductDetails>(`/api/products/${id}/refresh`);
      product.setData(fresh);
      void rendered.reload();
      notify(t('detail.refreshed'), 'ok');
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  return (
    <div className={`page ${embedded ? 'detail-pane-page' : ''}`}>
      <header className="page-header">
        <div className="product-head">
          {p.imageLink && <img className="thumb-lg" src={p.imageLink} alt="" onError={(e) => e.currentTarget.classList.add('thumb-hidden')} />}
          <div>
            <div className="muted small">
              <Link to="/products">{t('products.title')}</Link> / {p.offerId}
            </div>
            <h1>{p.title ?? p.offerId}</h1>
            <div className="muted">
              <StatusBadge status={p.aggregatedStatus} /> {p.signal && <RecommendationBadge value={p.signal.recommendation} />} {p.brand && <span>{p.brand} · </span>}
              {formatPrice(p.price)} · {p.availability ?? '–'} · {p.feedLabel}/{p.contentLanguage}
              {p.link && (
                <>
                  {' '}
                  ·{' '}
                  <a href={p.link} target="_blank" rel="noreferrer">
                    {t('detail.landingPage')} ↗
                  </a>
                </>
              )}
              {p.deletedAt && <Badge tone="error">{t('detail.deleted', { ago: timeAgo(p.deletedAt) })}</Badge>}
            </div>
          </div>
        </div>
        <div className="page-actions">
          {embedded && onClose && <button className="btn btn-ghost" onClick={onClose} aria-label={t('detail.close')}>×</button>}
          <button className="btn" onClick={refresh}>
            {t('detail.refresh')}
          </button>
        </div>
      </header>

      <div className="grid-3 info-grid">
        <div>
          <div className="muted small">{t('detail.dataSource')}</div>
          <div>{p.dataSource?.split('/').pop() ?? '–'}</div>
        </div>
        <div>
          <div className="muted small">{t('detail.googleUpdate')}</div>
          <div>{formatDate(p.product.productStatus?.lastUpdateDate)}</div>
        </div>
        <div>
          <div className="muted small">{t('detail.expires')}</div>
          <div>{formatDate(p.product.productStatus?.googleExpirationDate)}</div>
        </div>
        <div>
          <div className="muted small">{t('detail.destinations')}</div>
          <div>
            {(p.product.productStatus?.destinationStatuses ?? []).map((d, i) => (
              <div key={i} className="small">
                {d.reportingContext}: {d.approvedCountries?.length ? <Badge tone="ok">✓ {d.approvedCountries.join(', ')}</Badge> : null}{' '}
                {d.pendingCountries?.length ? <Badge tone="warning">⏳ {d.pendingCountries.join(', ')}</Badge> : null}{' '}
                {d.disapprovedCountries?.length ? <Badge tone="error">✕ {d.disapprovedCountries.join(', ')}</Badge> : null}
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="muted small">{t('detail.localTags')}</div>
          <TagList tags={p.metadata.tags} />
        </div>
        <div>
          <div className="muted small">{t('detail.enrichment')}</div>
          <div>
            {p.metadata.pushStatus ? (
              <Badge tone={p.metadata.pushStatus === 'pushed' ? 'ok' : p.metadata.pushStatus === 'error' ? 'error' : 'warning'}>
                {t('detail.enrichmentStatus', { n: Object.keys(p.metadata.pushedAttributes).length, status: p.metadata.pushStatus })}
              </Badge>
            ) : (
              <span className="muted">{t('common.none').toLowerCase()}</span>
            )}
          </div>
        </div>
      </div>

      <div className="tabs">
        {(
          [
            ['p360', t('detail.tab.p360')],
            ['issues', t('detail.tab.issues', { n: p.issues.length })],
            ['attributes', t('detail.tab.attributes')],
            ['enrich', t('detail.tab.enrich')],
            ['history', t('detail.tab.history')],
            ['raw', t('detail.tab.raw')],
          ] as const
        ).map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'p360' && (
        <Product360Panel
          productId={id}
          onTitleIdea={(query) => {
            setTitleIdea(query);
            setTab('enrich');
            notify(t('p360.titleIdeaApplied', { query }), 'ok');
          }}
        />
      )}

      {tab === 'issues' && (
        <Card>
          {p.issues.length === 0 ? (
            <Empty>{t('detail.noIssues')}</Empty>
          ) : (
            <ul className="issue-list">
              {p.issues.map((i) => (
                <li key={i.id}>
                  <LevelBadge level={i.level} label={i.severity ?? i.level} />
                  <div>
                    <strong>{i.description ?? i.code}</strong> <span className="muted small">({i.code})</span>
                    {i.detail && <div>{i.detail}</div>}
                    <div className="small muted">
                      {i.attribute && <span>attribute: {i.attribute} · </span>}
                      {i.reportingContext && <span>{i.reportingContext} · </span>}
                      {i.applicableCountries.length > 0 && <span>{i.applicableCountries.join(', ')} · </span>}
                      {i.resolution && <span>{i.resolution} · </span>}
                      {t('common.firstSeen', { date: formatDate(i.firstSeenAt) })}
                      {i.documentation && (
                        <>
                          {' '}
                          ·{' '}
                          <a href={i.documentation} target="_blank" rel="noreferrer">
                            {t('common.documentation')} ↗
                          </a>
                        </>
                      )}
                    </div>
                    {(() => {
                      const proposal = remediations.data?.proposals.find((candidate) => candidate.issueCode === i.code);
                      if (!proposal) return null;
                      return (
                        <QuickFixAction
                          proposal={proposal}
                          busy={remediationBusy === i.code}
                          onApply={async () => {
                            if (!window.confirm(t('detail.quickFixConfirm', { value: proposal.proposedValue }))) return;
                            setRemediationBusy(i.code);
                            try {
                              await api.post(`/api/products/${p.productId}/remediations`, { issueCode: i.code });
                              notify(t('detail.quickFixQueued'), 'info');
                              await remediations.reload();
                            } catch (err) {
                              notify((err as Error).message, 'error');
                            } finally {
                              setRemediationBusy(null);
                            }
                          }}
                        />
                      );
                    })()}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {rendered.data && rendered.data.issues.length > 0 && (
            <>
              <h4>{t('detail.rendered')}</h4>
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
                          ) : (
                            <span key={ai} className="muted">
                              {a.buttonLabel} {a.isAvailable === false ? t('detail.notAvailable') : ''}
                            </span>
                          ),
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {latestOperation && (
            <section className="operation-panel">
              <h4>{t('detail.operationTrace')}</h4>
              <div className="operation-status-line">
                <Badge tone={latestOperation.status === 'succeeded' ? 'ok' : latestOperation.status === 'failed' ? 'error' : 'warning'}>{latestOperation.status}</Badge>{' '}
                <span>{latestOperation.resultMessage ?? t('detail.operationRunning')}</span>
              </div>
              <div className="trace-list">
                {latestOperation.events.map((event) => (
                  <div className="trace-event" key={event.id}>
                    <strong>{event.type}</strong> <span>{event.message}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </Card>
      )}

      {tab === 'attributes' && (
        <Card>
          <table className="table">
            <tbody>
              {Object.entries(attrs).map(([k, v]) => (
                <tr key={k}>
                  <th className="attr-key">{k}</th>
                  <td>{typeof v === 'object' ? <code>{JSON.stringify(v)}</code> : String(v)}</td>
                </tr>
              ))}
              {(p.product.customAttributes ?? []).map((c, i) => (
                <tr key={`c${i}`}>
                  <th className="attr-key">
                    <Badge>{t('detail.custom')}</Badge> {c.name}
                  </th>
                  <td>{c.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === 'enrich' && facets.data && (
        <EnrichTab
          product={p}
          catalog={facets.data.attributeCatalog}
          titleIdea={titleIdea}
          onChanged={async () => {
            setTitleIdea(null);
            await product.reload();
          }}
        />
      )}

      {tab === 'history' && (
        <Card>
          <h4>{t('detail.issueHistory')}</h4>
          {!history.data?.issues.length ? (
            <Empty>{t('detail.noIssueHistory')}</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.issue')}</th>
                  <th>{t('common.severity')}</th>
                  <th>{t('issues.firstSeen')}</th>
                  <th>{t('detail.lastSeen')}</th>
                  <th>{t('detail.resolved')}</th>
                </tr>
              </thead>
              <tbody>
                {history.data.issues.map((i) => (
                  <tr key={i.id}>
                    <td>{i.description ?? i.code}</td>
                    <td>
                      <LevelBadge level={i.level} label={i.severity ?? i.level} />
                    </td>
                    <td>{formatDate(i.firstSeenAt)}</td>
                    <td>{formatDate(i.lastSeenAt)}</td>
                    <td>{i.resolvedAt ? <Badge tone="ok">{formatDate(i.resolvedAt)}</Badge> : <Badge tone="warning">{t('common.open')}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h4>{t('detail.events')}</h4>
          {!history.data?.events.length ? (
            <Empty>{t('detail.noEvents')}</Empty>
          ) : (
            <ul className="mini-list">
              {history.data.events.map((e) => (
                <li key={e.id}>
                  <LevelBadge level={e.severity} /> <span className="muted small">{formatDate(e.createdAt)}</span> {e.message}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'raw' && (
        <Card>
          <pre className="code-block">{JSON.stringify(p.product, null, 2)}</pre>
        </Card>
      )}
      {embedded && onClose && (
        <div className="form-actions detail-pane-footer">
          <button className="btn btn-primary" onClick={onClose}>{t('common.ok')}</button>
        </div>
      )}
    </div>
  );
}

function QuickFixAction({ proposal, busy, onApply }: { proposal: RemediationProposal; busy: boolean; onApply: () => Promise<void> }) {
  const { t } = useI18n();
  return (
    <div className="quick-fix-card">
      <div><Badge tone="ok">{t('detail.quickFixAvailable')}</Badge> <span className="muted small">{proposal.attribute}: {proposal.proposedValue}</span></div>
      <div className="small muted">{proposal.evidence}</div>
      <div className="small">{proposal.remediation}</div>
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void onApply()}>{busy ? t('detail.quickFixRunning') : t('detail.quickFix')}</button>
    </div>
  );
}

function EnrichTab({ product, catalog, titleIdea, onChanged }: { product: ProductDetails; catalog: Facets['attributeCatalog']; titleIdea?: string | null; onChanged: () => Promise<void> }) {
  const notify = useToast();
  const { t } = useI18n();
  const [tags, setTags] = useState(product.metadata.tags);
  const [tagInput, setTagInput] = useState('');
  const [notes, setNotes] = useState(product.metadata.notes);
  const [fields, setFields] = useState<{ key: string; value: string }[]>(Object.entries(product.metadata.fields).map(([key, value]) => ({ key, value })));
  const currentTitle = String((product.metadata.pushedAttributes.title as string | undefined) ?? product.product.productAttributes?.title ?? '');
  const [attributes, setAttributes] = useState<Record<string, unknown>>(() => (titleIdea ? { title: currentTitle } : {}));
  const [customAttrs, setCustomAttrs] = useState<{ name: string; value: string }[]>(
    ((product.metadata.pushedAttributes.customAttributes as { name: string; value: string }[] | undefined) ?? []).map((c) => ({ ...c })),
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTags(product.metadata.tags);
    setNotes(product.metadata.notes);
  }, [product.metadata.tags, product.metadata.notes]);

  const saveMetadata = async () => {
    setBusy(true);
    try {
      const f: Record<string, string> = {};
      for (const { key, value } of fields) if (key.trim()) f[key.trim()] = value;
      await api.put(`/api/products/${product.productId}/metadata`, { tags, notes, fields: f });
      notify(t('detail.metaSaved'), 'ok');
      await onChanged();
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const push = async () => {
    setBusy(true);
    try {
      await api.post(`/api/products/${product.productId}/attributes`, {
        attributes,
        customAttributes: customAttrs.filter((c) => c.name.trim()),
      });
      notify(t('detail.pushed'), 'ok');
      setAttributes({});
      await onChanged();
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const pushed = product.metadata.pushedAttributes;
  const { customAttributes: _c, ...pushedPlain } = pushed as Record<string, unknown>;

  return (
    <div className="grid-2 align-start">
      <Card title={t('detail.localMeta')}>
        <label>
          {t('detail.tags')}
          <div className="inline-form">
            <input
              value={tagInput}
              placeholder={t('detail.addTag')}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tagInput.trim()) {
                  e.preventDefault();
                  setTags([...new Set([...tags, tagInput.trim()])]);
                  setTagInput('');
                }
              }}
            />
          </div>
          <TagList tags={tags} onRemove={(t) => setTags(tags.filter((x) => x !== t))} />
        </label>
        <label>
          {t('detail.notes')}
          <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <label>{t('detail.extraFields')}</label>
        {fields.map((f, i) => (
          <div key={i} className="inline-form">
            <input placeholder={t('detail.key')} value={f.key} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
            <input placeholder={t('detail.value')} value={f.value} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <button className="btn btn-ghost btn-sm" onClick={() => setFields(fields.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button className="btn btn-sm" onClick={() => setFields([...fields, { key: '', value: '' }])}>
          {t('detail.addField')}
        </button>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy} onClick={saveMetadata}>
            {t('detail.saveMeta')}
          </button>
        </div>
      </Card>

      <Card title={t('detail.enrichTitle')}>
        <p className="muted small">{t('detail.enrichHelp')}</p>
        {Object.keys(pushedPlain).length > 0 || customAttrs.length > 0 ? (
          <table className="table">
            <tbody>
              {Object.entries(pushedPlain).map(([k, v]) => (
                <tr key={k}>
                  <th className="attr-key">{k}</th>
                  <td>{typeof v === 'object' ? <code>{JSON.stringify(v)}</code> : String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted small">{t('detail.nothingPushed')}</div>
        )}
        {product.metadata.pushStatus === 'error' && <div className="field-error">{t('detail.pushFailed', { error: product.metadata.pushError })}</div>}
        <h4>{t('detail.setAttributes')}</h4>
        {titleIdea && (
          <div className="hint-box">
            {t('p360.titleIdeaHint', { query: titleIdea })}{' '}
            <button className="btn btn-sm" onClick={() => setAttributes({ ...attributes, title: `${String(attributes.title ?? currentTitle)} ${titleIdea}`.trim() })}>
              {t('p360.appendToTitle')}
            </button>
          </div>
        )}
        <AttributeForm catalog={catalog} value={attributes} onChange={setAttributes} current={pushedPlain} />
        <h4>{t('detail.customAttributes')}</h4>
        {customAttrs.map((c, i) => (
          <div key={i} className="inline-form">
            <input placeholder={t('common.name').toLowerCase()} value={c.name} onChange={(e) => setCustomAttrs(customAttrs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <input placeholder={t('detail.value')} value={c.value} onChange={(e) => setCustomAttrs(customAttrs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <button className="btn btn-ghost btn-sm" onClick={() => setCustomAttrs(customAttrs.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button className="btn btn-sm" onClick={() => setCustomAttrs([...customAttrs, { name: '', value: '' }])}>
          {t('detail.addCustom')}
        </button>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy} onClick={push}>
            {t('detail.push')}
          </button>
          {Object.keys(pushed).length > 0 && (
            <Confirm
              message={t('detail.removeAllConfirm')}
              onConfirm={async () => {
                try {
                  await api.delete(`/api/products/${product.productId}/attributes`);
                  notify(t('detail.removed'), 'ok');
                  setCustomAttrs([]);
                  await onChanged();
                } catch (err) {
                  notify((err as Error).message, 'error');
                }
              }}
            >
              {t('detail.removeAll')}
            </Confirm>
          )}
        </div>
      </Card>
    </div>
  );
}
