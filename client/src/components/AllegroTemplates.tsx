import { useEffect, useState } from 'react';
import { api, qs } from '../lib/api';
import { useAsync, useDebouncedValue } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { Card, Empty, ErrorBox, Modal, Spinner, useToast } from './ui';

type Environment = 'sandbox' | 'production';
interface Template { id: string; name: string; sourceOfferId: string; version: number; data: Record<string, unknown>; updatedAt: string }
interface Preview { offerId: string; fields: Record<string, unknown> }
interface Draft { id: string; templateVersion: number; wooId: number; createdAt: string; data: { product?: { name?: string; sku?: string }; price?: { amount?: string; currency?: string } } }
interface WooProduct { wooId: number; sku: string; name: string | null }

export default function AllegroTemplates({ environment, sourceOffer, closeSource }: { environment: Environment; sourceOffer: string | null; closeSource: () => void }) {
  const { lang } = useI18n(); const pl = lang === 'pl'; const notify = useToast();
  const templates = useAsync(() => api.get<{ items: Template[] }>(`/api/allegro/templates${qs({ environment })}`), [environment]);
  const drafts = useAsync(() => api.get<{ items: Draft[] }>(`/api/allegro/drafts${qs({ environment })}`), [environment]);
  const [editing, setEditing] = useState<Template | null>(null);
  const [using, setUsing] = useState<Template | null>(null);
  useEffect(() => { setEditing(null); setUsing(null); }, [environment]);
  return <>
    <Card title={pl ? 'Szablony ofert' : 'Offer templates'}>
      <p className="muted small">{pl ? 'Szablony są lokalne i dotyczą tego konta oraz środowiska. Utwórz je z wybranej oferty; ich zapis nie zmienia ofert w Allegro.' : 'Templates are local to this seller and environment. Create one from an offer; saving it does not change Allegro offers.'}</p>
      <ErrorBox error={templates.error} onRetry={templates.reload} />
      {templates.loading && !templates.data ? <Spinner /> : !templates.data?.items.length ? <Empty>{pl ? 'Brak szablonów.' : 'No templates yet.'}</Empty> : <ul>{templates.data.items.map((item) => <li key={item.id}><strong>{item.name}</strong> · {pl ? 'wersja' : 'version'} {item.version} · {pl ? 'oferta źródłowa' : 'source offer'} {item.sourceOfferId} <button className="btn btn-sm" onClick={() => setEditing(item)}>{pl ? 'Edytuj' : 'Edit'}</button>{' '}<button className="btn btn-sm" onClick={() => setUsing(item)}>{pl ? 'Przygotuj szkic' : 'Prepare draft'}</button></li>)}</ul>}
    </Card>
    <Card title={pl ? 'Lokalne szkice ofert' : 'Local offer drafts'}>
      <p className="muted small">{pl ? 'Szkice są zapisane tylko w aplikacji; nie utworzono ofert w Allegro.' : 'Drafts are stored only in this app; no Allegro offer has been created.'}</p>
      <ErrorBox error={drafts.error} onRetry={drafts.reload} />
      {drafts.loading && !drafts.data ? <Spinner /> : !drafts.data?.items.length ? <Empty>{pl ? 'Brak szkiców.' : 'No drafts yet.'}</Empty> : <ul>{drafts.data.items.map((draft) => <li key={draft.id}>{draft.data.product?.name || draft.data.product?.sku || `Woo ${draft.wooId}`} · {draft.data.price?.amount} {draft.data.price?.currency} · {pl ? 'wersja szablonu' : 'template version'} {draft.templateVersion}</li>)}</ul>}
    </Card>
    {sourceOffer && <CreateTemplate key={`${environment}-${sourceOffer}`} environment={environment} offerId={sourceOffer} close={closeSource} saved={async () => { closeSource(); await templates.reload(); notify(pl ? 'Szablon zapisany' : 'Template saved', 'ok'); }} />}
    {editing && <EditTemplate key={editing.id} environment={environment} template={editing} close={() => setEditing(null)} saved={async () => { setEditing(null); await templates.reload(); notify(pl ? 'Szablon zaktualizowany' : 'Template updated', 'ok'); }} />}
    {using && <PrepareDraft key={using.id} environment={environment} template={using} close={() => setUsing(null)} saved={async () => { setUsing(null); await drafts.reload(); notify(pl ? 'Zapisano lokalny szkic' : 'Local draft saved', 'ok'); }} />}
  </>;
}

function PrepareDraft({ environment, template, close, saved }: { environment: Environment; template: Template; close: () => void; saved: () => Promise<void> }) {
  const { lang } = useI18n(); const pl = lang === 'pl'; const notify = useToast();
  const [sku, setSku] = useState(''); const delayedSku = useDebouncedValue(sku, 300);
  const [selected, setSelected] = useState<WooProduct | null>(null);
  const [amount, setAmount] = useState(''); const [currency, setCurrency] = useState('PLN'); const [busy, setBusy] = useState(false);
  const products = useAsync(() => api.get<{ items: WooProduct[]; total: number; syncedAt: string | null }>(`/api/woocommerce/reconciliation${qs({ sku: delayedSku, limit: 25, offset: 0 })}`), [delayedSku]);
  return <Modal title={pl ? `Szkic z szablonu: ${template.name}` : `Draft from template: ${template.name}`} onClose={close} wide>
    <p className="muted small">{pl ? 'Wybierz produkt WooCommerce i podaj cenę Allegro. To lokalny szkic, bez tworzenia ani publikowania oferty.' : 'Choose a WooCommerce product and enter the Allegro price. This creates a local draft without creating or publishing an offer.'}</p>
    <label>{pl ? 'Szukaj SKU' : 'Search SKU'}<input value={sku} onChange={(e) => setSku(e.target.value)} /></label>
    <ErrorBox error={products.error} onRetry={products.reload} />
    {!products.data?.syncedAt ? <p className="muted small">{pl ? 'Najpierw zsynchronizuj WooCommerce.' : 'Synchronize WooCommerce first.'}</p> : <><p className="muted small">{pl ? 'Pierwsze 25 wyników; zawęź wyszukiwanie SKU.' : 'First 25 results; narrow your SKU search.'}</p><ul>{products.data.items.map((product) => <li key={product.wooId}><button className="btn btn-sm" onClick={() => setSelected(product)}>{selected?.wooId === product.wooId ? '✓ ' : ''}{product.sku || `Woo ${product.wooId}`} · {product.name || '–'}</button></li>)}</ul></>}
    <div className="form-grid"><label>{pl ? 'Cena Allegro' : 'Allegro price'}<input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></label><label>{pl ? 'Waluta' : 'Currency'}<input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} /></label></div>
    <div className="form-actions"><button className="btn btn-primary" disabled={busy || !selected || !amount || currency.length !== 3} onClick={async () => { if (!selected) return; setBusy(true); try { await api.post('/api/allegro/drafts', { environment, templateId: template.id, wooId: selected.wooId, amount, currency }); await saved(); } catch (error) { notify((error as Error).message, 'error'); } finally { setBusy(false); } }}>{pl ? 'Zapisz szkic' : 'Save draft'}</button></div>
  </Modal>;
}

function CreateTemplate({ environment, offerId, close, saved }: { environment: Environment; offerId: string; close: () => void; saved: () => Promise<void> }) {
  const { lang } = useI18n(); const pl = lang === 'pl'; const notify = useToast();
  const preview = useAsync(() => api.get<Preview>(`/api/allegro/offers/${encodeURIComponent(offerId)}/template-preview${qs({ environment })}`), [environment, offerId]);
  const [selected, setSelected] = useState<string[]>([]); const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  return <Modal title={pl ? `Szablon z oferty ${offerId}` : `Template from offer ${offerId}`} onClose={close} wide>
    <p className="muted small">{pl ? 'Wybierz pola do ponownego użycia. Sprawdź dane i zdjęcia, ponieważ mogą dotyczyć tylko produktu źródłowego. ID oferty, stan, cena i produkt nie są kopiowane.' : 'Select reusable fields. Review descriptions and images: they may be specific to the source product. Offer ID, publication status, price, stock and product identity are not copied.'}</p>
    <label>{pl ? 'Nazwa szablonu' : 'Template name'}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
    <ErrorBox error={preview.error} onRetry={preview.reload} />
    {preview.loading && !preview.data ? <Spinner /> : Object.entries(preview.data?.fields ?? {}).map(([field, value]) => <div key={field}><label><input type="checkbox" checked={selected.includes(field)} onChange={(e) => setSelected((previous) => e.target.checked ? [...previous, field] : previous.filter((item) => item !== field))} /> {field}</label>{selected.includes(field) && <pre className="code-block">{JSON.stringify(value, null, 2)}</pre>}</div>)}
    <div className="form-actions"><button className="btn btn-primary" disabled={busy || !name.trim() || !selected.length} onClick={async () => { setBusy(true); try { await api.post('/api/allegro/templates/from-offer', { environment, offerId, name, fields: selected }); await saved(); } catch (error) { notify((error as Error).message, 'error'); } finally { setBusy(false); } }}>{pl ? 'Zapisz szablon' : 'Save template'}</button></div>
  </Modal>;
}

function EditTemplate({ environment, template, close, saved }: { environment: Environment; template: Template; close: () => void; saved: () => Promise<void> }) {
  const { lang } = useI18n(); const pl = lang === 'pl'; const notify = useToast();
  const [name, setName] = useState(template.name); const [text, setText] = useState(JSON.stringify(template.data, null, 2)); const [busy, setBusy] = useState(false);
  return <Modal title={pl ? `Edytuj szablon: ${template.name}` : `Edit template: ${template.name}`} onClose={close} wide>
    <p className="muted small">{pl ? 'Zmiany tworzą nową wersję lokalnego szablonu. Nie zmieniają istniejących ofert.' : 'Changes create a new local template version. Existing offers are not changed.'}</p>
    <label>{pl ? 'Nazwa' : 'Name'}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
    <label>{pl ? 'Pola szablonu (JSON)' : 'Template fields (JSON)'}<textarea className="code" rows={18} value={text} onChange={(e) => setText(e.target.value)} /></label>
    <div className="form-actions"><button className="btn btn-primary" disabled={busy || !name.trim()} onClick={async () => { setBusy(true); try { const data: unknown = JSON.parse(text); await api.put(`/api/allegro/templates/${template.id}`, { environment, name, version: template.version, data }); await saved(); } catch (error) { notify((error as Error).message, 'error'); } finally { setBusy(false); } }}>{pl ? 'Zapisz nową wersję' : 'Save new version'}</button></div>
  </Modal>;
}
