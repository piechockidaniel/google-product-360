import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useAsync, useDebouncedValue } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { Badge, Card, Empty, ErrorBox, Modal, Pagination, Spinner, useToast } from '../components/ui';
import type { ProductRecord } from '../lib/types';
import SortableHeader from '../components/SortableHeader';

type MatchStatus = 'matched' | 'ambiguous' | 'unmatched' | 'no_sku';
type MatchColumn = 'wooId' | 'sku' | 'name' | 'price' | 'stockStatus' | 'status' | 'google';
type OrderColumn = 'number' | 'status' | 'date' | 'items' | 'total' | 'currency';
type Direction = 'asc' | 'desc';
interface Candidate { productId: string; offerId: string; title: string | null; mappedWooId: number | null }
interface Match { wooId: number; parentId: number | null; sku: string; name: string | null; type: string | null; price: string | null; stockStatus: string | null; status: MatchStatus; candidates: Candidate[] }
interface Matches { syncedAt: string | null; summary: Record<MatchStatus | 'merchantOnly', number>; items: Match[]; total: number }
interface Order { id: number; number?: string; status?: string; total?: string; currency?: string; date_created_gmt?: string; line_items?: { id: number; name?: string; quantity?: number }[] }
interface OrderPage { items: Order[]; total: number }
const LIMIT = 25;
const matchDefaults = { wooId: '', sku: '', name: '', price: '', stockStatus: '', google: '' };
const orderDefaults = { number: '', status: '', date: '', items: '', total: '', currency: '' };

export default function WooCommercePage() {
  const { lang } = useI18n();
  const pl = lang === 'pl';
  const notify = useToast();
  const [mappingBusy, setMappingBusy] = useState<string | null>(null);
  const [mappingProduct, setMappingProduct] = useState<Match | null>(null);
  const [status, setStatus] = useState<MatchStatus | 'all'>('all');
  const [matchFilters, setMatchFilters] = useState(matchDefaults);
  const [orderFilters, setOrderFilters] = useState(orderDefaults);
  const delayedMatch = useDebouncedValue(matchFilters, 300);
  const delayedOrder = useDebouncedValue(orderFilters, 300);
  const [matchSort, setMatchSort] = useState<{ column: MatchColumn; direction: Direction }>({ column: 'wooId', direction: 'asc' });
  const [orderSort, setOrderSort] = useState<{ column: OrderColumn; direction: Direction }>({ column: 'date', direction: 'desc' });
  const [offset, setOffset] = useState(0);
  const [orderOffset, setOrderOffset] = useState(0);
  const matchQuery = { status, limit: LIMIT, offset, ...delayedMatch, orderBy: matchSort.column, orderDir: matchSort.direction };
  const orderQuery = { limit: LIMIT, offset: orderOffset, ...delayedOrder, orderBy: orderSort.column, orderDir: orderSort.direction };
  const matches = useAsync(() => api.get<Matches>(`/api/woocommerce/reconciliation${qs(matchQuery)}`), [JSON.stringify(matchQuery)]);
  const orders = useAsync(() => api.get<OrderPage>(`/api/woocommerce/orders${qs(orderQuery)}`), [JSON.stringify(orderQuery)]);
  const labels: Record<MatchStatus, string> = pl
    ? { matched: 'Jedno dopasowanie SKU', ambiguous: 'Niejednoznaczne', unmatched: 'Brak dopasowania SKU', no_sku: 'Brak SKU' }
    : { matched: 'One SKU match', ambiguous: 'Ambiguous', unmatched: 'No SKU match', no_sku: 'No SKU' };
  const names = { wooId: 'Woo ID', sku: 'SKU', name: pl ? 'Nazwa' : 'Name', price: pl ? 'Cena' : 'Price', stockStatus: pl ? 'Stan' : 'Stock', status: pl ? 'Dopasowanie' : 'Match', google: pl ? 'Oferty Google' : 'Google offers' };
  const orderNames = { number: pl ? 'Numer' : 'Number', status: 'Status', date: pl ? 'Data' : 'Date', items: pl ? 'Pozycje' : 'Items', total: pl ? 'Suma' : 'Total', currency: pl ? 'Waluta' : 'Currency' };
  const sortMatch = (column: MatchColumn) => { setMatchSort((prev) => ({ column, direction: prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc' })); setOffset(0); };
  const sortOrder = (column: OrderColumn) => { setOrderSort((prev) => ({ column, direction: prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc' })); setOrderOffset(0); };
  const filterMatch = (column: keyof typeof matchDefaults, value: string) => { setMatchFilters((prev) => ({ ...prev, [column]: value })); setOffset(0); };
  const filterOrder = (column: keyof typeof orderDefaults, value: string) => { setOrderFilters((prev) => ({ ...prev, [column]: value })); setOrderOffset(0); };
  const filterLabel = (label: string) => `${pl ? 'Filtruj' : 'Filter'}: ${label}`;
  const changeMapping = async (wooId: number, candidate: Candidate) => {
    setMappingBusy(candidate.productId);
    try {
      if (candidate.mappedWooId === wooId) await api.post('/api/woocommerce/mappings/remove', { wooId, productId: candidate.productId });
      else await api.put('/api/woocommerce/mappings', { wooId, productId: candidate.productId });
      await matches.reload();
      notify(pl ? 'Zapisano powiązanie' : 'Mapping updated', 'ok');
    } catch (error) { notify((error as Error).message, 'error'); }
    finally { setMappingBusy(null); }
  };

  return <div className="page">
    <header className="page-header"><h1>WooCommerce</h1><Link className="btn btn-sm" to="/settings">{pl ? 'Połączenie i synchronizacja' : 'Connection and sync'}</Link></header>
    <p className="muted">{pl ? 'Dane sklepu z ostatniej synchronizacji. Potwierdź proponowane powiązania SKU i ofert Google. Powiązania nie zmieniają jeszcze danych produktów ani automatyzacji.' : 'Store data from the last sync. Confirm proposed links between SKU and Google offers. Mappings do not yet change product records or workflows.'}</p>
    <ErrorBox error={matches.error} onRetry={matches.reload} />
    {matches.loading && !matches.data ? <Spinner /> : !matches.data?.syncedAt ? <Empty>{pl ? 'Brak danych WooCommerce. Skonfiguruj połączenie i uruchom synchronizację w Ustawieniach.' : 'No WooCommerce data yet. Configure the connection and run a sync in Settings.'}</Empty> : <>
      <Card className="products-results" title={pl ? 'Dopasowanie produktów' : 'Product matching'} actions={<button className="btn btn-sm" onClick={() => { setMatchFilters(matchDefaults); setStatus('all'); setOffset(0); }}>{pl ? 'Wyczyść filtry' : 'Clear filters'}</button>}>
        <p className="muted small">{pl ? 'Dokładne porównanie SKU z ID oferty. Duplikaty i brakujące SKU wymagają weryfikacji. Ceny nie zawierają waluty, ponieważ WooCommerce nie zwraca jej w produkcie.' : 'Exact comparison of SKU with offer ID. Duplicate or missing SKUs need review. Prices have no currency because WooCommerce does not return it with products.'}</p>
        <p className="small">{Object.entries(labels).map(([key, label]) => <span key={key} style={{ marginRight: 16 }}>{label}: <strong>{matches.data!.summary[key as MatchStatus]}</strong></span>)}<span>{pl ? 'Tylko w Google' : 'Only in Google'}: <strong>{matches.data.summary.merchantOnly}</strong></span></p>
        <div className="products-table-scroll" role="region" aria-label={pl ? 'Produkty WooCommerce' : 'WooCommerce products'} tabIndex={0}>
          <table className="table"><thead><tr>{(Object.keys(names) as MatchColumn[]).map((column) => <SortableHeader key={column} label={names[column]} active={matchSort.column === column} direction={matchSort.direction} onSort={() => sortMatch(column)} />)}</tr>
          <tr className="table-filter-row">{(Object.keys(names) as MatchColumn[]).map((column) => <th key={column}>{column === 'status' ? <select aria-label={filterLabel(names[column])} value={status} onChange={(e) => { setStatus(e.target.value as MatchStatus | 'all'); setOffset(0); }}><option value="all">{pl ? 'Wszystkie' : 'All'}</option>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select> : <input aria-label={filterLabel(names[column])} value={matchFilters[column]} onChange={(e) => filterMatch(column, e.target.value)} />}</th>)}</tr></thead>
          <tbody>{matches.data.items.map((item) => <tr key={item.wooId}><td>{item.wooId}{item.parentId ? ` (↳ ${item.parentId})` : ''}</td><td>{item.sku || '–'}</td><td>{item.name || (item.type === 'variation' ? (pl ? 'Wariant' : 'Variation') : '–')}</td><td>{item.price || '–'}</td><td>{item.stockStatus || '–'}</td><td><Badge tone={item.status === 'matched' ? 'ok' : item.status === 'ambiguous' ? 'warning' : 'neutral'}>{labels[item.status]}</Badge></td><td>{item.candidates.map((c) => <div key={c.productId}><Link to={`/products/${c.productId}`}>{c.offerId}</Link>{c.title ? ` · ${c.title}` : ''}{' '}{c.mappedWooId !== null && c.mappedWooId !== item.wooId ? <span className="muted small">{pl ? `Powiązano z Woo ${c.mappedWooId}` : `Linked to Woo ${c.mappedWooId}`}</span> : <button className="btn btn-sm" disabled={mappingBusy !== null} onClick={() => void changeMapping(item.wooId, c)}>{c.mappedWooId === item.wooId ? (pl ? 'Usuń powiązanie' : 'Unlink') : (pl ? 'Potwierdź' : 'Confirm')}</button>}</div>)}<button className="btn btn-ghost btn-sm" onClick={() => setMappingProduct(item)}>{pl ? 'Znajdź produkt Google' : 'Find Google product'}</button></td></tr>)}</tbody></table>
        </div>
        {!matches.data.items.length && <Empty>{pl ? 'Brak produktów dla wybranego filtra.' : 'No products for this filter.'}</Empty>}
        <Pagination total={matches.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />
      </Card>
      <Card className="products-results" title={pl ? 'Zamówienia' : 'Orders'} actions={<button className="btn btn-sm" onClick={() => { setOrderFilters(orderDefaults); setOrderOffset(0); }}>{pl ? 'Wyczyść filtry' : 'Clear filters'}</button>}>
        <ErrorBox error={orders.error} onRetry={orders.reload} />
        <div className="products-table-scroll" role="region" aria-label={pl ? 'Zamówienia WooCommerce' : 'WooCommerce orders'} tabIndex={0}><table className="table"><thead><tr>{(Object.keys(orderNames) as OrderColumn[]).map((column) => <SortableHeader key={column} label={orderNames[column]} active={orderSort.column === column} direction={orderSort.direction} onSort={() => sortOrder(column)} />)}</tr>
        <tr className="table-filter-row">{(Object.keys(orderNames) as OrderColumn[]).map((column) => <th key={column}><input aria-label={filterLabel(orderNames[column])} value={orderFilters[column]} onChange={(e) => filterOrder(column, e.target.value)} /></th>)}</tr></thead>
        <tbody>{orders.data?.items.map((o) => <tr key={o.id}><td>{o.number || o.id}</td><td>{o.status || '–'}</td><td>{o.date_created_gmt || '–'}</td><td>{o.line_items?.map((item) => `${item.quantity ?? 0} × ${item.name ?? '–'}`).join(', ') || '–'}</td><td>{o.total}</td><td>{o.currency}</td></tr>)}</tbody></table></div>
        {orders.loading && !orders.data ? <Spinner /> : !orders.data?.items.length && <Empty>{pl ? 'Brak zamówień dla wybranego filtra.' : 'No orders for this filter.'}</Empty>}
        {orders.data && <Pagination total={orders.data.total} limit={LIMIT} offset={orderOffset} onChange={setOrderOffset} />}
      </Card>
    </>}
    {mappingProduct && <ManualMap key={mappingProduct.wooId} item={mappingProduct} close={() => setMappingProduct(null)} saved={async () => { setMappingProduct(null); await matches.reload(); notify(pl ? 'Zapisano powiązanie' : 'Mapping saved', 'ok'); }} />}
  </div>;
}

function ManualMap({ item, close, saved }: { item: Match; close: () => void; saved: () => Promise<void> }) {
  const { lang } = useI18n(); const pl = lang === 'pl'; const notify = useToast();
  const [search, setSearch] = useState(item.sku); const delayed = useDebouncedValue(search, 300); const [busy, setBusy] = useState(false);
  const products = useAsync(() => api.get<{ items: ProductRecord[]; total: number }>(`/api/products${qs({ q: delayed, limit: 25, offset: 0 })}`), [delayed]);
  return <Modal title={pl ? `Powiąż Woo ${item.wooId}` : `Link Woo ${item.wooId}`} onClose={close} wide>
    <p className="muted small">{pl ? 'Wyszukaj ofertę Google po ID, tytule lub marce. Potwierdzone powiązanie nie zmienia danych produktów.' : 'Search Google products by offer ID, title or brand. Confirming a link does not change product data.'}</p>
    <label>{pl ? 'Szukaj' : 'Search'}<input value={search} onChange={(e) => setSearch(e.target.value)} /></label>
    <ErrorBox error={products.error} onRetry={products.reload} />
    {products.loading && !products.data ? <Spinner /> : !products.data?.items.length ? <Empty>{pl ? 'Brak wyników.' : 'No results.'}</Empty> : <><p className="muted small">{pl ? 'Pierwsze 25 wyników; w razie potrzeby zawęź wyszukiwanie.' : 'First 25 results; narrow your search if needed.'}</p><ul>{products.data.items.map((product) => <li key={product.productId}>{product.offerId} · {product.title} · {product.feedLabel}/{product.contentLanguage} <button className="btn btn-sm" disabled={busy} onClick={async () => { setBusy(true); try { await api.put('/api/woocommerce/mappings', { wooId: item.wooId, productId: product.productId }); await saved(); } catch (error) { notify((error as Error).message, 'error'); } finally { setBusy(false); } }}>{pl ? 'Powiąż' : 'Link'}</button></li>)}</ul></>}
  </Modal>;
}
