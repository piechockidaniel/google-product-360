import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useAsync, useDebouncedValue, useInterval } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { Badge, Card, Empty, ErrorBox, Pagination, Spinner, useToast } from '../components/ui';
import SortableHeader from '../components/SortableHeader';
import AllegroTemplates from '../components/AllegroTemplates';
import AllegroOperations from '../components/AllegroOperations';

type Environment = 'sandbox' | 'production';
interface Status { environment: Environment; configured: boolean; connected: boolean; clientId: string; redirectUri: string; sellerId: string | null; sellerLogin: string | null; offerWriteEnabled: boolean; syncedAt: string | null; offerCount: number; running: boolean; progress: { loaded: number; total: number | null } | null }
interface Offer { id: string; name?: string; publication?: { status?: string }; sellingMode?: { price?: { amount?: string; currency?: string } }; stock?: { available?: number } }
interface OfferPage { offers: Offer[]; total: number }
const LIMIT = 25;
type Column = 'id' | 'name' | 'status' | 'price' | 'stock';
const defaults = { id: '', name: '', status: '', price: '', stock: '' };

export default function AllegroPage() {
  const { lang } = useI18n(); const pl = lang === 'pl'; const notify = useToast();
  const [params] = useSearchParams();
  const [environment, setEnvironment] = useState<Environment>(params.get('environment') === 'production' ? 'production' : 'sandbox');
  const [clientId, setClientId] = useState(''); const [secret, setSecret] = useState('');
  const [offerWrites, setOfferWrites] = useState(false);
  const [redirectUri, setRedirectUri] = useState(`${window.location.origin}/api/allegro/callback`);
  const [offset, setOffset] = useState(0); const [busy, setBusy] = useState(false);
  const [sourceOffer, setSourceOffer] = useState<string | null>(null);
  const [editedOffer, setEditedOffer] = useState<Offer | null>(null);
  const [filters, setFilters] = useState(defaults);
  const delayed = useDebouncedValue(filters, 300);
  const [sort, setSort] = useState<{ column: Column; direction: 'asc' | 'desc' }>({ column: 'id', direction: 'asc' });
  const status = useAsync(() => api.get<Status>(`/api/allegro/status${qs({ environment })}`), [environment]);
  const connected = status.data?.environment === environment && status.data.connected;
  const query = { environment, limit: LIMIT, offset, orderBy: sort.column, orderDir: sort.direction, ...delayed };
  const offers = useAsync(() => connected ? api.get<OfferPage>(`/api/allegro/offers${qs(query)}`) : Promise.resolve({ offers: [], total: 0 }), [JSON.stringify(query), connected]);
  useInterval(() => void status.reload(), busy || status.data?.running ? 2000 : null);
  useEffect(() => {
    if (status.data?.environment !== environment) return;
    setClientId(status.data.clientId);
    setSecret('');
    setOfferWrites(status.data.offerWriteEnabled);
    setRedirectUri(status.data.redirectUri || `${window.location.origin}/api/allegro/callback`);
  }, [status.data?.environment, status.data?.clientId, status.data?.redirectUri, status.data?.offerWriteEnabled, environment]);
  const save = async () => {
    setBusy(true);
    try { await api.put('/api/allegro/config', { environment, clientId, redirectUri, enableOfferWrites: environment === 'sandbox' && offerWrites, ...(secret ? { clientSecret: secret } : {}) }); setSecret(''); await status.reload(); notify(pl ? 'Zapisano ustawienia' : 'Settings saved', 'ok'); }
    catch (error) { notify((error as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const authorize = async () => {
    setBusy(true);
    try { const result = await api.post<{ url: string }>('/api/allegro/authorize', { environment }); window.location.assign(result.url); }
    catch (error) { notify((error as Error).message, 'error'); setBusy(false); }
  };
  const synchronize = async () => {
    setBusy(true);
    try { await api.post('/api/allegro/sync', { environment }); await status.reload(); await offers.reload(); notify(pl ? 'Oferty zsynchronizowane' : 'Offers synchronized', 'ok'); }
    catch (error) { notify((error as Error).message, 'error'); }
    finally { await status.reload(); setBusy(false); }
  };
  const names: Record<Column, string> = { id: 'ID', name: pl ? 'Nazwa' : 'Name', status: 'Status', price: pl ? 'Cena' : 'Price', stock: pl ? 'Dostępne' : 'Available' };
  return <div className="page">
    <header className="page-header"><h1>Allegro</h1><label>{pl ? 'Środowisko' : 'Environment'}{' '}<select disabled={busy || status.data?.running} value={environment} onChange={(e) => { setEnvironment(e.target.value as Environment); setOffset(0); setSourceOffer(null); }}><option value="sandbox">Sandbox</option><option value="production">{pl ? 'Produkcja' : 'Production'}</option></select></label></header>
    {params.get('connection') === 'failed' && <div className="error-box">{pl ? 'Autoryzacja nie powiodła się lub wygasła. Sprawdź adres przekierowania i spróbuj ponownie.' : 'Authorization failed or expired. Check the redirect URI and try again.'}</div>}
    {params.get('connection') === 'success' && <p>{pl ? 'Połączono konto Allegro.' : 'Allegro account connected.'}</p>}
    <Card title={pl ? 'Połączenie sprzedawcy' : 'Seller connection'}>
      <p className="muted small">{pl ? 'Sandbox i produkcja mają osobne aplikacje, dane dostępowe i konta. Zmiany ofert są dostępne tylko w sandboxie.' : 'Sandbox and production use separate applications, credentials and accounts. Offer changes are available only in sandbox.'}</p>
      <ErrorBox error={status.error} onRetry={status.reload} />
      <div className="form-grid">
        <label>Client ID<input value={clientId} onChange={(e) => setClientId(e.target.value)} /></label>
        <label>Client secret<input type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={status.data?.configured ? (pl ? 'Pozostaw puste, aby zachować' : 'Leave blank to keep') : ''} /></label>
        <label>Redirect URI<input value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} /></label>
      </div>
      {environment === 'sandbox' && <label><input type="checkbox" checked={offerWrites} onChange={(e) => setOfferWrites(e.target.checked)} /> {pl ? 'Włącz testowe zmiany ofert w sandboxie' : 'Enable test offer changes in sandbox'}</label>}
      <p className="muted small">{pl ? 'Zmiana uprawnień wymaga ponownego połączenia konta.' : 'Changing permissions requires reconnecting the account.'}</p>
      <p className="muted small">{pl ? 'Zarejestruj dokładnie ten adres w aplikacji Allegro. Połączenie wymaga zgody sprzedawcy na odczyt ofert i danych profilu.' : 'Register this exact URI in the Allegro application. Connecting requires the seller to approve offer and profile read access.'}</p>
      <div className="page-actions"><button className="btn btn-primary" disabled={busy || !clientId || !redirectUri} onClick={() => void save()}>{pl ? 'Zapisz' : 'Save'}</button><button className="btn" disabled={busy || status.data?.environment !== environment || !status.data?.configured} onClick={() => void authorize()}>{pl ? 'Połącz z Allegro' : 'Connect Allegro'}</button>{connected && <Badge tone="ok">{status.data?.sellerLogin || status.data?.sellerId}</Badge>}</div>
    </Card>
    {connected && <Card className="products-results" title={pl ? 'Oferty Allegro' : 'Allegro offers'} actions={<><button className="btn btn-sm" disabled={busy || status.data?.running} onClick={() => void synchronize()}>{pl ? 'Synchronizuj' : 'Sync offers'}</button><button className="btn btn-sm" onClick={() => { setFilters(defaults); setOffset(0); }}>{pl ? 'Wyczyść filtry' : 'Clear filters'}</button></>}>
      <p className="muted small">{status.data?.syncedAt ? `${pl ? 'Ostatnia synchronizacja' : 'Last sync'}: ${status.data.syncedAt} · ${status.data.offerCount}` : (pl ? 'Brak synchronizacji ofert.' : 'No offer snapshot yet.')}</p>
      {status.data?.running && status.data.progress && <p aria-live="polite">{pl ? 'Pobrano' : 'Loaded'}: {status.data.progress.loaded}{status.data.progress.total !== null ? ` / ${status.data.progress.total}` : ''}</p>}
      <ErrorBox error={offers.error} onRetry={offers.reload} />
      <div className="products-table-scroll" role="region" aria-label={pl ? 'Oferty Allegro' : 'Allegro offers'} tabIndex={0}><table className="table"><thead><tr>{(Object.keys(names) as Column[]).map((column) => <SortableHeader key={column} label={names[column]} active={sort.column === column} direction={sort.direction} onSort={() => { setSort((prev) => ({ column, direction: prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc' })); setOffset(0); }} />)}<th>{pl ? 'Akcje' : 'Actions'}</th></tr><tr className="table-filter-row">{(Object.keys(names) as Column[]).map((column) => <th key={column}><input aria-label={`${pl ? 'Filtruj' : 'Filter'}: ${names[column]}`} value={filters[column]} onChange={(e) => { setFilters((prev) => ({ ...prev, [column]: e.target.value })); setOffset(0); }} /></th>)}<th /></tr></thead><tbody>{offers.data?.offers.map((offer) => <tr key={offer.id}><td>{offer.id}</td><td>{offer.name || '–'}</td><td>{offer.publication?.status || '–'}</td><td>{offer.sellingMode?.price?.amount} {offer.sellingMode?.price?.currency}</td><td>{offer.stock?.available ?? '–'}</td><td><button className="btn btn-sm" onClick={() => setSourceOffer(offer.id)}>{pl ? 'Utwórz szablon' : 'Create template'}</button>{environment === 'sandbox' && status.data?.offerWriteEnabled && <button className="btn btn-sm" onClick={() => setEditedOffer(offer)}>{pl ? 'Zmień ofertę' : 'Change offer'}</button>}</td></tr>)}</tbody></table></div>
      {offers.loading && !offers.data ? <Spinner /> : !offers.data?.offers.length && <Empty>{pl ? 'Brak ofert dla wybranego filtra.' : 'No offers for this filter.'}</Empty>}
      {offers.data && <Pagination total={offers.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
    </Card>}
    {connected && <AllegroTemplates environment={environment} sourceOffer={sourceOffer} closeSource={() => setSourceOffer(null)} />}
    {connected && environment === 'sandbox' && <AllegroOperations offer={editedOffer} close={() => setEditedOffer(null)} />}
  </div>;
}
