import { useEffect, useMemo, useState } from 'react';

import type { Operation, OperationStatus, Product, ProductsResponse } from '../../shared/types';

const statusLabels: Record<Product['status'], string> = {
  Approved: 'Approved',
  Limited: 'Limited',
  Disapproved: 'Disapproved',
};

const activeStatuses: OperationStatus[] = ['queued', 'running'];

async function loadProducts(): Promise<ProductsResponse> {
  const response = await fetch('/api/products');
  if (!response.ok) {
    throw new Error(`Products request failed with ${response.status}`);
  }
  return response.json() as Promise<ProductsResponse>;
}

export function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [activeOperation, setActiveOperation] = useState<Operation | null>(null);
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [isLoading, setIsLoading] = useState(true);
  const [isStartingOperation, setIsStartingOperation] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshProducts = async () => {
    const data = await loadProducts();
    setProducts(data.products);
    setMode(data.mode);
  };

  useEffect(() => {
    refreshProducts()
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'Unable to load products');
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    if (!activeOperation || !activeStatuses.includes(activeOperation.status)) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      fetch(`/api/operations/${activeOperation.id}`)
        .then((response) => response.json() as Promise<Operation>)
        .then((operation) => {
          setActiveOperation(operation);
          if (!activeStatuses.includes(operation.status)) {
            return refreshProducts();
          }
          return undefined;
        })
        .catch((error: unknown) => {
          setActionError(error instanceof Error ? error.message : 'Unable to read operation state');
        });
    }, 700);

    return () => window.clearInterval(timer);
  }, [activeOperation]);

  const activeProduct = products.find((product) => product.id === activeProductId) ?? null;
  const selectedCount = selectedIds.length;
  const issueCount = useMemo(() => products.filter((product) => product.issues.length > 0).length, [products]);
  const approvedCount = useMemo(() => products.filter((product) => product.status === 'Approved').length, [products]);
  const operationIsActive = activeOperation !== null && activeStatuses.includes(activeOperation.status);

  const toggleSelection = (productId: string) => {
    setSelectedIds((current) => current.includes(productId)
      ? current.filter((id) => id !== productId)
      : [...current, productId]);
  };

  const toggleAll = () => {
    setSelectedIds((current) => current.length === products.length ? [] : products.map((product) => product.id));
  };

  const openProduct = (productId: string) => {
    setActionError(null);
    setActiveProductId(productId);
  };

  const startQuickFix = async (product: Product, issueCode: string) => {
    setActionError(null);
    setActiveProductId(product.id);
    setIsStartingOperation(true);
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ productId: product.id, issueCode }),
      });
      const operation = await response.json() as Operation | { error?: string };
      if (!response.ok || !('id' in operation)) {
        throw new Error('error' in operation && operation.error ? operation.error : 'Unable to start Quick Fix');
      }
      setActiveOperation(operation);
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : 'Unable to start Quick Fix');
    } finally {
      setIsStartingOperation(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark">P360</span>
          <div>
            <p className="eyebrow">Merchant Center workspace</p>
            <h1>Product360</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="mode-badge"><span className="mode-dot" />{mode === 'demo' ? 'Demo mode · synthetic data' : 'Live mode'}</span>
          <button className="avatar-button" type="button" aria-label="Account menu">JD</button>
        </div>
      </header>

      <section className="page-heading">
        <div>
          <p className="eyebrow">Feed rescue</p>
          <h2>Products</h2>
          <p className="lede">See what needs attention before it costs you visibility.</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" type="button">Import feed</button>
          <button className="primary-button" type="button">Sync now</button>
        </div>
      </section>

      <section className="summary-grid" aria-label="Product summary">
        <article className="summary-card"><span className="summary-label">Total products</span><strong>{products.length}</strong><span className="summary-note">in current snapshot</span></article>
        <article className="summary-card summary-card-warning"><span className="summary-label">Need attention</span><strong>{issueCount}</strong><span className="summary-note">with active issues</span></article>
        <article className="summary-card summary-card-good"><span className="summary-label">Approved</span><strong>{approvedCount}</strong><span className="summary-note">ready to show</span></article>
      </section>

      <section className="workspace-card">
        <div className="toolbar">
          <div className="toolbar-title"><h3>All products</h3><span>{products.length} items</span></div>
          <div className="toolbar-controls"><button className="filter-button" type="button">Filter <span>⌄</span></button><button className="filter-button" type="button">Columns <span>⌄</span></button><button className="icon-button" type="button" aria-label="More options">•••</button></div>
        </div>

        {selectedCount > 0 && <div className="selection-bar"><span>{selectedCount} selected</span><button type="button">Batch actions</button></div>}
        {actionError && <div className="action-error" role="alert">{actionError}</div>}

        {isLoading && <div className="empty-state">Loading Demo products…</div>}
        {loadError && <div className="empty-state error-state">{loadError}</div>}
        {!isLoading && !loadError && <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="checkbox-cell"><input type="checkbox" aria-label="Select all products" checked={products.length > 0 && selectedCount === products.length} onChange={toggleAll} /></th>
                <th>Product</th>
                <th>Supplier</th>
                <th>Feed</th>
                <th>Price</th>
                <th>Availability</th>
                <th>Status</th>
                <th>Issues summary</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => <tr key={product.id}>
                <td className="checkbox-cell"><input type="checkbox" aria-label={`Select ${product.title}`} checked={selectedIds.includes(product.id)} onChange={() => toggleSelection(product.id)} /></td>
                <td><div className="product-cell"><span className="thumbnail" style={{ backgroundColor: product.thumbnailColor }}>{product.thumbnailLabel}</span><div><button className="product-title-button" type="button" onClick={() => openProduct(product.id)}>{product.title}</button><span className="product-id">{product.id}</span></div></div></td>
                <td>{product.supplier}</td>
                <td><span className="feed-name">{product.feed}</span></td>
                <td className="numeric-cell">{product.price}</td>
                <td><span className={`availability availability-${product.availability === 'In stock' ? 'in' : 'out'}`}><span />{product.availability}</span></td>
                <td><span className={`status-pill status-${product.status.toLowerCase()}`}>{statusLabels[product.status]}</span></td>
                <td><span className={`issue-summary ${product.issues.length === 0 ? 'issue-none' : ''}`}>{product.issueSummary}</span></td>
                <td><button className="row-action" type="button" disabled={operationIsActive || isStartingOperation} onClick={() => product.issues.some((issue) => issue.predictable) ? startQuickFix(product, product.issues.find((issue) => issue.predictable)!.code) : openProduct(product.id)}>{product.issues.some((issue) => issue.predictable) ? 'Quick Fix' : 'Review'}</button></td>
              </tr>)}
            </tbody>
          </table>
        </div>}
        <footer className="table-footer"><span>Showing {products.length} of {products.length} products</span><span>Last sync · Demo snapshot</span></footer>
      </section>

      {activeProduct && <>
        <div className="drawer-backdrop" onClick={() => setActiveProductId(null)} />
        <aside className="detail-pane" aria-label={`Product details for ${activeProduct.title}`}>
          <div className="detail-header"><div><p className="eyebrow">Product details</p><h3>{activeProduct.title}</h3></div><button className="close-button" type="button" aria-label="Close product details" onClick={() => setActiveProductId(null)}>×</button></div>
          <div className="detail-meta"><span className="thumbnail" style={{ backgroundColor: activeProduct.thumbnailColor }}>{activeProduct.thumbnailLabel}</span><div><span className="product-id">{activeProduct.id}</span><span>{activeProduct.supplier} · {activeProduct.feed}</span></div></div>
          <div className="detail-section"><div className="detail-section-heading"><h4>Issues</h4><span>{activeProduct.issues.length} active</span></div>
            {activeProduct.issues.length === 0 && <div className="resolved-card">No active issues in the current Demo snapshot.</div>}
            {activeProduct.issues.map((issue) => <article className="issue-card" key={issue.code}>
              <div className="issue-card-top"><span className={`issue-kind issue-kind-${issue.classification}`}>{issue.classification === 'quick-fix' ? 'Quick Fix available' : 'Review required'}</span><span className={`severity severity-${issue.severity}`}>{issue.severity}</span></div>
              <h4>{issue.title}</h4>
              <dl><div><dt>Source</dt><dd>{issue.source === 'product' ? 'Product data' : 'Merchant Center account'}</dd></div><div><dt>Evidence</dt><dd>{issue.evidence}</dd></div><div><dt>Consequence</dt><dd>{issue.consequence}</dd></div><div><dt>Remediation</dt><dd>{issue.remediation}</dd></div></dl>
              {issue.classification === 'quick-fix' && <button className="primary-button detail-action" type="button" disabled={operationIsActive || isStartingOperation} onClick={() => startQuickFix(activeProduct, issue.code)}>{isStartingOperation ? 'Starting…' : 'Approve and run Quick Fix'}</button>}
            </article>)}
          </div>
          {activeOperation && activeOperation.productId === activeProduct.id && <section className="operation-panel"><div className="operation-heading"><div><p className="eyebrow">Operation trace</p><h4>{activeOperation.status === 'succeeded' ? 'Completed' : activeOperation.status === 'failed' ? 'Failed' : 'Running in background'}</h4></div><span className={`operation-status operation-${activeOperation.status}`}>{activeOperation.status}</span></div><p className="operation-message">{activeOperation.resultMessage ?? 'The app will keep monitoring this operation even if this window closes.'}</p><div className="trace-list">{activeOperation.events.map((event) => <div className="trace-event" key={event.id}><span className="trace-marker" /><div><strong>{event.type}</strong><span>{event.message}</span><time>{new Date(event.createdAt).toLocaleTimeString()}</time></div></div>)}</div></section>}
        </aside>
      </>}
    </main>
  );
}
