import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAsync, useInterval } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { Card, ErrorBox, useToast } from './ui';

interface Progress { stage: 'products' | 'variations' | 'orders' | 'saving'; page: number; totalPages: number | null; products: number; variations: number; variationProductsDone: number; variationProductsTotal: number; orders: number; attempt: number; startedAt: string }
interface Status { configured: boolean; storeUrl: string; syncIntervalMinutes: number; syncOnStartup: boolean; running: boolean; progress: Progress | null; lastError: string | null; lastRun: { status: string; started_at: string; finished_at: string | null; error: string | null } | null; syncedAt: string | null; products: number; orders: number }
interface Order { id: number; number?: string; status?: string; total?: string; currency?: string; date_created_gmt?: string }

export default function WooCommerceSettingsCard() {
  const { lang } = useI18n();
  const pl = lang === 'pl';
  const notify = useToast();
  const status = useAsync(() => api.get<Status>('/api/woocommerce/status'), []);
  const orders = useAsync(() => api.get<{ items: Order[]; total: number }>('/api/woocommerce/orders?limit=10'), []);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [interval, setInterval] = useState(0);
  const [onStartup, setOnStartup] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (status.data) setUrl(status.data.storeUrl); }, [status.data?.storeUrl]);
  useEffect(() => { if (status.data) { setInterval(status.data.syncIntervalMinutes); setOnStartup(status.data.syncOnStartup); } }, [status.data?.syncIntervalMinutes, status.data?.syncOnStartup]);
  useInterval(() => void status.reload(), busy || status.data?.running ? 2000 : null);

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await action(); notify(message, 'ok'); await status.reload(); await orders.reload(); }
    catch (error) { notify((error as Error).message, 'error'); }
    finally { await status.reload(); setBusy(false); }
  };
  const progress = status.data?.progress;
  const stages = pl ? { products: 'Produkty', variations: 'Warianty', orders: 'Zamówienia', saving: 'Zapisywanie' } : { products: 'Products', variations: 'Variations', orders: 'Orders', saving: 'Saving' };

  return <Card title="WooCommerce">
    <p className="muted small">{pl ? 'Połączenie tylko do odczytu. Produkty, warianty i zamówienia są zapisywane osobno; widoki produktów i automatyzacje nadal korzystają z Merchant Center.' : 'Read-only connection. Products, variations and orders are stored separately; product views and workflows still use Merchant Center.'}</p>
    <div className="form-grid">
      <label>{pl ? 'Adres sklepu (HTTPS)' : 'Store URL (HTTPS)'}<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://store.example.com" /></label>
      <label>Consumer key<input type="password" autoComplete="new-password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={status.data?.configured ? (pl ? 'Pozostaw puste, aby zachować' : 'Leave blank to keep') : ''} /></label>
      <label>Consumer secret<input type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={status.data?.configured ? (pl ? 'Pozostaw puste, aby zachować' : 'Leave blank to keep') : ''} /></label>
      <label>{pl ? 'Automatyczna synchronizacja co (minuty, 0 = wyłączona)' : 'Automatic sync interval (minutes, 0 = off)'}<input type="number" min="0" max="1440" step="1" value={interval} onChange={(e) => setInterval(Number(e.target.value))} /></label>
      <label><input type="checkbox" checked={onStartup} onChange={(e) => setOnStartup(e.target.checked)} /> {pl ? 'Synchronizuj po uruchomieniu' : 'Sync on startup'}</label>
    </div>
    <div className="page-actions">
      <button className="btn btn-primary" disabled={busy || !url || !Number.isInteger(interval) || interval < 0 || interval > 1440} onClick={() => void run(async () => { await api.put('/api/woocommerce/config', { storeUrl: url, syncIntervalMinutes: interval, syncOnStartup: onStartup, ...(key ? { consumerKey: key } : {}), ...(secret ? { consumerSecret: secret } : {}) }); setKey(''); setSecret(''); }, pl ? 'Zapisano połączenie' : 'Connection saved')}>{pl ? 'Zapisz' : 'Save'}</button>
      <button className="btn" disabled={busy || !status.data?.configured} onClick={() => void run(() => api.post('/api/woocommerce/test'), pl ? 'Połączenie działa' : 'Connection works')}>{pl ? 'Testuj' : 'Test'}</button>
      <button className="btn" disabled={busy || status.data?.running || !status.data?.configured} onClick={() => void run(() => api.post('/api/woocommerce/sync'), pl ? 'Synchronizacja zakończona' : 'Synchronization complete')}>{pl ? 'Synchronizuj' : 'Sync'}</button>
      {status.data?.running && <button className="btn" onClick={() => void api.post<{ cancelled: boolean }>('/api/woocommerce/cancel').then(() => status.reload()).catch((error: Error) => notify(error.message, 'error'))}>{pl ? 'Anuluj synchronizację' : 'Cancel sync'}</button>}
    </div>
    <ErrorBox error={status.error} onRetry={status.reload} />
    <div aria-live="polite">
      {status.data?.running && progress && <p className="small">{pl ? 'Synchronizacja:' : 'Synchronizing:'} <strong>{stages[progress.stage]}</strong>{progress.stage === 'variations' && ` · ${pl ? 'produkty' : 'products'} ${progress.variationProductsDone} / ${progress.variationProductsTotal}`}{progress.stage !== 'saving' && ` · ${pl ? 'strona' : 'page'} ${progress.page}${progress.totalPages === null ? '' : ` / ${progress.totalPages}`}`}{progress.attempt > 1 && ` · ${pl ? 'próba' : 'attempt'} ${progress.attempt} / 3`} · {pl ? 'pobrano' : 'loaded'}: {progress.products} {pl ? 'produktów' : 'products'}, {progress.variations} {pl ? 'wariantów' : 'variations'}, {progress.orders} {pl ? 'zamówień' : 'orders'}</p>}
      {!status.data?.running && (status.data?.lastError || status.data?.lastRun?.error) && <p className="small" role="alert">{status.data.lastError ?? status.data.lastRun?.error}</p>}
    </div>
    <p className="muted small">{status.data?.syncedAt ? `${status.data.products} ${pl ? 'produktów i wariantów' : 'products and variations'} · ${status.data.orders} ${pl ? 'zamówień' : 'orders'} · ${status.data.syncedAt}` : (pl ? 'Brak synchronizacji' : 'Not synchronized yet')}</p>
    {!!orders.data?.items.length && <table className="table"><thead><tr><th>{pl ? 'Zamówienie' : 'Order'}</th><th>Status</th><th>{pl ? 'Suma' : 'Total'}</th></tr></thead><tbody>{orders.data.items.map((o) => <tr key={o.id}><td>{o.number ?? o.id}</td><td>{o.status}</td><td>{o.total} {o.currency}</td></tr>)}</tbody></table>}
  </Card>;
}
