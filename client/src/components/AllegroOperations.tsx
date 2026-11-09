import { useState } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { Card, Empty, ErrorBox, Modal, useToast } from './ui';

interface Offer { id: string; name?: string; publication?: { status?: string }; sellingMode?: { price?: { amount?: string; currency?: string } }; stock?: { available?: number } }
interface Operation { id: string; offerId: string; action: string; status: string; message: string | null; createdAt: string }

export default function AllegroOperations({ offer, close }: { offer: Offer | null; close: () => void }) {
  const { lang } = useI18n(); const pl = lang === 'pl'; const notify = useToast();
  const operations = useAsync(() => api.get<{ items: Operation[] }>('/api/allegro/operations?environment=sandbox'), []);
  const [busy, setBusy] = useState<string | null>(null);
  return <>
    <Card title={pl ? 'Operacje ofert sandbox' : 'Sandbox offer operations'}>
      <p className="muted small">{pl ? 'Po zmianie zsynchronizuj oferty, aby odświeżyć listę. Nieznany wynik należy sprawdzić przed ponowną próbą.' : 'Sync offers after a change to refresh the list. Check an uncertain outcome before trying again.'}</p>
      <ErrorBox error={operations.error} onRetry={operations.reload} />
      {!operations.data?.items.length ? <Empty>{pl ? 'Brak operacji.' : 'No operations yet.'}</Empty> : <ul>{operations.data.items.map((item) => <li key={item.id}>{item.createdAt} · {item.offerId} · {item.action} · <strong>{item.status}</strong> · {item.message} {['pending', 'uncertain', 'sending'].includes(item.status) && <button className="btn btn-sm" disabled={busy === item.id} onClick={async () => { setBusy(item.id); try { await api.post(`/api/allegro/operations/${item.id}/check`, { environment: 'sandbox' }); await operations.reload(); } catch (error) { notify((error as Error).message, 'error'); } finally { setBusy(null); } }}>{pl ? 'Sprawdź wynik' : 'Check result'}</button>}</li>)}</ul>}
    </Card>
    {offer && <ChangeOffer key={offer.id} offer={offer} close={close} saved={async () => { close(); await operations.reload(); }} />}
  </>;
}

function ChangeOffer({ offer, close, saved }: { offer: Offer; close: () => void; saved: () => Promise<void> }) {
  const { lang } = useI18n(); const pl = lang === 'pl'; const notify = useToast();
  const [id] = useState(() => crypto.randomUUID());
  const [type, setType] = useState<'price' | 'stock' | 'activate' | 'end'>('price');
  const [value, setValue] = useState(''); const [busy, setBusy] = useState(false);
  const price = offer.sellingMode?.price; const stock = offer.stock?.available; const status = offer.publication?.status;
  const available = type === 'price' ? !!price?.amount && !!price.currency : type === 'stock' ? typeof stock === 'number' : !!status;
  const valid = type === 'price' ? /^\d{1,12}(?:\.\d{1,2})?$/.test(value) && Number(value) > 0 : type === 'stock' ? /^\d+$/.test(value) && Number(value) <= 1_000_000 : true;
  const action = type === 'price' ? { type, amount: value, currency: price?.currency, expectedAmount: price?.amount, expectedCurrency: price?.currency } : type === 'stock' ? { type, quantity: Number(value), expectedQuantity: stock } : { type, expectedStatus: status };
  return <Modal title={`${pl ? 'Zmień ofertę' : 'Change offer'} ${offer.id} — SANDBOX`} onClose={close}>
    <p>{offer.name}</p><p className="muted small">{pl ? 'Zmiana dotyczy wyłącznie oferty sandbox. Bieżąca wartość zostanie sprawdzona przed wysłaniem.' : 'This changes the sandbox offer. Its current value will be checked before submission.'}</p>
    <label>{pl ? 'Operacja' : 'Action'}<select value={type} onChange={(e) => { setType(e.target.value as typeof type); setValue(''); }}><option value="price">{pl ? 'Cena' : 'Price'}</option><option value="stock">{pl ? 'Ilość' : 'Stock'}</option><option value="activate">{pl ? 'Aktywuj' : 'Activate'}</option><option value="end">{pl ? 'Zakończ' : 'End'}</option></select></label>
    <p>{pl ? 'Wartość na liście' : 'Displayed value'}: {type === 'price' ? `${price?.amount ?? '–'} ${price?.currency ?? ''}` : type === 'stock' ? stock ?? '–' : status ?? '–'}</p>
    {(type === 'price' || type === 'stock') && <label>{pl ? 'Nowa wartość' : 'New value'}<input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" /></label>}
    {!available && <p className="error-box">{pl ? 'Brak bieżącej wartości; zsynchronizuj oferty.' : 'Current value is missing; synchronize offers.'}</p>}
    <div className="form-actions"><button className="btn btn-primary" disabled={busy || !available || !valid} onClick={async () => { setBusy(true); try { await api.post(`/api/allegro/offers/${encodeURIComponent(offer.id)}/operations`, { environment: 'sandbox', operationId: id, action }); await saved(); } catch (error) { notify((error as Error).message, 'error'); } finally { setBusy(false); } }}>{pl ? 'Wyślij zmianę do sandboxa' : 'Send change to sandbox'}</button></div>
  </Modal>;
}
