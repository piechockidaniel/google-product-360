import { useEffect, useMemo, useState } from 'react';

import type { Product, ProductsResponse } from '../../shared/types';

const statusLabels: Record<Product['status'], string> = {
  Approved: 'Approved',
  Limited: 'Limited',
  Disapproved: 'Disapproved',
};

export function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/products')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Products request failed with ${response.status}`);
        }
        return response.json() as Promise<ProductsResponse>;
      })
      .then((data) => {
        setProducts(data.products);
        setMode(data.mode);
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'Unable to load products');
      })
      .finally(() => setIsLoading(false));
  }, []);

  const selectedCount = selectedIds.length;
  const issueCount = useMemo(() => products.filter((product) => product.issues.length > 0).length, [products]);
  const approvedCount = useMemo(() => products.filter((product) => product.status === 'Approved').length, [products]);

  const toggleSelection = (productId: string) => {
    setSelectedIds((current) => current.includes(productId)
      ? current.filter((id) => id !== productId)
      : [...current, productId]);
  };

  const toggleAll = () => {
    setSelectedIds((current) => current.length === products.length ? [] : products.map((product) => product.id));
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
                <td><div className="product-cell"><span className="thumbnail" style={{ backgroundColor: product.thumbnailColor }}>{product.thumbnailLabel}</span><div><strong>{product.title}</strong><span className="product-id">{product.id}</span></div></div></td>
                <td>{product.supplier}</td>
                <td><span className="feed-name">{product.feed}</span></td>
                <td className="numeric-cell">{product.price}</td>
                <td><span className={`availability availability-${product.availability === 'In stock' ? 'in' : 'out'}`}><span />{product.availability}</span></td>
                <td><span className={`status-pill status-${product.status.toLowerCase()}`}>{statusLabels[product.status]}</span></td>
                <td><span className={`issue-summary ${product.issues.length === 0 ? 'issue-none' : ''}`}>{product.issueSummary}</span></td>
                <td><button className="row-action" type="button">{product.issues.some((issue) => issue.predictable) ? 'Quick Fix' : 'Review'}</button></td>
              </tr>)}
            </tbody>
          </table>
        </div>}
        <footer className="table-footer"><span>Showing {products.length} of {products.length} products</span><span>Last sync · Demo snapshot</span></footer>
      </section>
    </main>
  );
}
