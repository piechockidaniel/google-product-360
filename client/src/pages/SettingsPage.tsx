import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useFormat } from '../lib/format';
import { LANGUAGES, useI18n } from '../lib/i18n';
import { useAsync } from '../lib/hooks';
import type { ReturnPolicy, Settings, ShippingSettings, Subscription } from '../lib/types';
import { Badge, Card, Confirm, Empty, ErrorBox, JsonEditor, Modal, Spinner, useToast } from '../components/ui';
import MetricsSettingsCard from '../components/MetricsSettingsCard';

interface QuotaResponse {
  groups: { name: string; usage: number; dailyLimit: number; minuteLimit: number; methods: string[] }[];
  apiConcurrency: number;
}

export default function SettingsPage() {
  const notify = useToast();
  const { user } = useAuth();
  const { t, lang, setLang } = useI18n();
  const { formatDate, formatNumber } = useFormat();
  const settings = useAsync(() => api.get<Settings>('/api/settings'), []);
  const subs = useAsync(() => api.get<{ callbackUrl: string | null; subscriptions: Subscription[] }>('/api/notifications/subscriptions'), []);
  const shipping = useAsync(() => api.get<{ shippingSettings: ShippingSettings | null }>('/api/account/shipping-settings'), []);
  const policies = useAsync(() => api.get<{ policies: ReturnPolicy[] }>('/api/account/return-policies'), []);
  const quota = useAsync(() => api.get<QuotaResponse>('/api/settings/quota'), []);
  const [policyEdit, setPolicyEdit] = useState<ReturnPolicy | null>(null);
  const [newUser, setNewUser] = useState({ username: '', password: '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });

  const act = async (label: string, fn: () => Promise<unknown>, after?: () => void) => {
    try {
      await fn();
      notify(label, 'ok');
      after?.();
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  if (settings.loading && !settings.data) return <Spinner />;
  if (!settings.data) return <ErrorBox error={settings.error} onRetry={settings.reload} />;
  const s = settings.data;

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('set.title')}</h1>
        <div className="page-actions">
          <label className="inline-form" style={{ margin: 0 }}>
            <span className="muted">{t('common.language')}</span>
            <select value={lang} onChange={(e) => setLang(e.target.value as 'pl')}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <div className="grid-2 align-start">
        <Card
          title={t('set.connection')}
          actions={
            <Link className="btn btn-sm btn-primary" to="/setup">
              {s.configured ? t('set.changeConfig') : t('set.openWizard')}
            </Link>
          }
        >
          {!s.configured && <div className="error-box">{t('set.notConfigured')}</div>}
          <table className="table kv">
            <tbody>
              <tr>
                <th>{t('dash.merchantAccount')}</th>
                <td>
                  {s.accountId} {s.mock && <Badge tone="warning">{t('common.mock')}</Badge>}
                </td>
              </tr>
              <tr>
                <th>{t('set.api')}</th>
                <td>
                  {s.apiBaseUrl} · {s.apiVersion}
                </td>
              </tr>
              <tr>
                <th>{t('set.syncInterval')}</th>
                <td>{s.syncIntervalMinutes ? t('set.minutes', { n: s.syncIntervalMinutes }) : t('common.disabled')}</td>
              </tr>
              <tr>
                <th>{t('set.enrichmentSource')}</th>
                <td>{s.enrichmentDataSourceName}</td>
              </tr>
              <tr>
                <th>{t('set.localeTz')}</th>
                <td>
                  {s.languageCode} / {s.timeZone}
                </td>
              </tr>
              <tr>
                <th>{t('set.publicUrl')}</th>
                <td>{s.publicUrl ?? <span className="muted">{t('set.publicUrlNotSet')}</span>}</td>
              </tr>
            </tbody>
          </table>
          <p className="muted small">{t('set.wizardNote')}</p>
        </Card>

        <Card
          title={t('set.push')}
          actions={
            <button
              className="btn btn-sm btn-primary"
              disabled={!subs.data?.callbackUrl}
              onClick={() => act(t('set.subscribed'), () => api.post('/api/notifications/subscriptions'), () => void subs.reload())}
            >
              {t('set.subscribe')}
            </button>
          }
        >
          <p className="muted small">{t('set.pushHelp')}</p>
          <div className="small">
            {t('set.callbackUrl')} {subs.data?.callbackUrl ? <code>{subs.data.callbackUrl}</code> : <Badge tone="warning">{t('set.setPublicUrl')}</Badge>}
          </div>
          <ErrorBox error={subs.error} onRetry={subs.reload} />
          {subs.data?.subscriptions.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('set.event')}</th>
                  <th>{t('set.callback')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {subs.data.subscriptions.map((x) => (
                  <tr key={x.id}>
                    <td>
                      {x.registeredEvent} {x.ownedByThisApp && <Badge tone="ok">{t('set.thisApp')}</Badge>}
                    </td>
                    <td className="small muted">{x.callBackUri}</td>
                    <td>
                      <Confirm message={t('set.deleteSub')} onConfirm={() => void act(t('set.subDeleted'), () => api.delete(`/api/notifications/subscriptions/${x.id}`), () => void subs.reload())}>
                        {t('common.delete')}
                      </Confirm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="muted small">{t('set.noSubs')}</div>
          )}
        </Card>
      </div>

      <MetricsSettingsCard />

      <Card
        title={t('set.quota')}
        actions={
          <button className="btn btn-sm" onClick={() => void quota.reload()}>
            {t('common.refresh')}
          </button>
        }
      >
        <p className="muted small">{t('set.quotaHelp', { n: quota.data?.apiConcurrency ?? '…' })}</p>
        <ErrorBox error={quota.error} onRetry={quota.reload} />
        {quota.data && quota.data.groups.length === 0 && <Empty>{t('set.noQuota')}</Empty>}
        {quota.data && quota.data.groups.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>{t('set.quotaGroup')}</th>
                <th>{t('set.methods')}</th>
                <th className="num">{t('set.usedToday')}</th>
                <th className="num">{t('set.dailyLimit')}</th>
                <th className="num">{t('set.perMinute')}</th>
                <th>{t('set.usage')}</th>
              </tr>
            </thead>
            <tbody>
              {quota.data.groups.map((g) => {
                const pct = g.dailyLimit ? Math.min(100, Math.round((g.usage / g.dailyLimit) * 100)) : 0;
                return (
                  <tr key={g.name}>
                    <td>{g.name}</td>
                    <td className="muted small">{g.methods.join(', ')}</td>
                    <td className="num">{formatNumber(g.usage)}</td>
                    <td className="num">{formatNumber(g.dailyLimit)}</td>
                    <td className="num">{formatNumber(g.minuteLimit)}</td>
                    <td>
                      <div className="meter" title={`${pct}%`}>
                        <div className={`meter-fill ${pct > 90 ? 'meter-error' : pct > 70 ? 'meter-warning' : ''}`} style={{ width: `${pct}%` }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid-2 align-start">
        <Card title={t('set.shipping')}>
          {!shipping.data?.shippingSettings?.services?.length ? (
            <Empty>{t('set.noShipping')}</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('set.service')}</th>
                  <th>{t('set.countries')}</th>
                  <th>{t('dash.type')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {shipping.data.shippingSettings.services.map((svc, i) => (
                  <tr key={i}>
                    <td>{svc.serviceName}</td>
                    <td className="muted">{svc.deliveryCountries?.join(', ')}</td>
                    <td className="muted">{svc.shipmentType}</td>
                    <td>{svc.active ? <Badge tone="ok">{t('set.active')}</Badge> : <Badge>{t('set.inactive')}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card
          title={t('set.returnPolicies')}
          actions={
            <button
              className="btn btn-sm"
              onClick={() =>
                setPolicyEdit({ label: '', countries: ['PL'], policy: { type: 'NUMBER_OF_DAYS_AFTER_DELIVERY', days: '30' }, returnMethods: ['BY_MAIL'], itemConditions: ['NEW'], returnPolicyUri: '' })
              }
            >
              + {t('common.new')}
            </button>
          }
        >
          {!policies.data?.policies.length ? (
            <Empty>{t('set.noPolicies')}</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('set.label')}</th>
                  <th>{t('set.countries')}</th>
                  <th>{t('set.policy')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {policies.data.policies.map((p) => (
                  <tr key={p.returnPolicyId}>
                    <td>{p.label}</td>
                    <td className="muted">{p.countries?.join(', ')}</td>
                    <td className="muted small">
                      {p.policy?.type} {p.policy?.days ? t('set.days', { n: p.policy.days }) : ''}
                    </td>
                    <td className="actions">
                      <button className="btn btn-sm" onClick={() => setPolicyEdit(p)}>
                        {t('common.edit')}
                      </button>
                      <Confirm
                        message={t('set.deletePolicy', { name: p.label ?? '' })}
                        onConfirm={() => void act(t('set.policyDeleted'), () => api.delete(`/api/account/return-policies/${p.returnPolicyId}`), () => void policies.reload())}
                      >
                        {t('common.delete')}
                      </Confirm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid-2 align-start">
        <Card title={t('set.users')}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('login.username')}</th>
                <th>{t('set.lastLogin')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {s.users.map((u) => (
                <tr key={u.id}>
                  <td>{u.username}</td>
                  <td className="muted small">{formatDate(u.lastLoginAt)}</td>
                  <td>
                    {u.id !== user?.id && (
                      <Confirm message={t('set.deleteUser', { name: u.username })} onConfirm={() => void act(t('set.userDeleted'), () => api.delete(`/api/settings/users/${u.id}`), () => void settings.reload())}>
                        {t('common.delete')}
                      </Confirm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="inline-form">
            <input placeholder={t('set.newUsername')} value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} />
            <input placeholder={t('set.passwordMin')} type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
            <button
              className="btn btn-sm"
              disabled={!newUser.username || newUser.password.length < 8}
              onClick={() =>
                act(t('set.userCreated'), () => api.post('/api/settings/users', newUser), () => {
                  setNewUser({ username: '', password: '' });
                  void settings.reload();
                })
              }
            >
              {t('set.addUser')}
            </button>
          </div>
        </Card>

        <Card title={t('set.changePassword')}>
          <div className="form">
            <label>
              {t('set.currentPassword')}
              <input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
            </label>
            <label>
              {t('set.newPassword')}
              <input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
            </label>
            <div className="form-actions">
              <button
                className="btn btn-primary"
                disabled={!pw.currentPassword || pw.newPassword.length < 8}
                onClick={() => act(t('set.passwordChanged'), () => api.post('/api/auth/password', pw), () => setPw({ currentPassword: '', newPassword: '' }))}
              >
                {t('set.changePassword')}
              </button>
            </div>
          </div>
        </Card>
      </div>

      {policyEdit && (
        <Modal title={policyEdit.returnPolicyId ? t('set.editPolicy', { name: policyEdit.label ?? '' }) : t('set.newPolicy')} onClose={() => setPolicyEdit(null)} wide>
          <p className="muted small">{t('set.policyHelp')}</p>
          <JsonEditor value={policyEdit} onChange={(v) => setPolicyEdit(v as ReturnPolicy)} rows={16} />
          <div className="form-actions">
            <button
              className="btn btn-primary"
              onClick={() =>
                act(
                  t('set.policySaved'),
                  () => (policyEdit.returnPolicyId ? api.put(`/api/account/return-policies/${policyEdit.returnPolicyId}`, policyEdit) : api.post('/api/account/return-policies', policyEdit)),
                  () => {
                    setPolicyEdit(null);
                    void policies.reload();
                  },
                )
              }
            >
              {t('common.save')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
