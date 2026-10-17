import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { LanguageSwitcher, useI18n } from '../lib/i18n';
import type { ConnectionTestResult, PublicSettings } from '../lib/types';
import { Badge, Card, ErrorBox, Spinner, useToast } from '../components/ui';

type StepId = 'admin' | 'connection' | 'sync' | 'enrichment' | 'finish';
const ALL_STEPS: StepId[] = ['admin', 'connection', 'sync', 'enrichment', 'finish'];

type Save = (patch: Record<string, unknown>) => Promise<PublicSettings>;

/**
 * Guided, one-time configuration. Also reachable later from Settings to change
 * any value. Every step saves its values immediately, so the wizard can be
 * abandoned and resumed.
 */
export default function SetupWizardPage() {
  const { user, needsAdmin, login, refresh } = useAuth();
  const navigate = useNavigate();
  const notify = useToast();
  const { t } = useI18n();
  const steps = useMemo(() => (needsAdmin || !user ? ALL_STEPS : ALL_STEPS.filter((s) => s !== 'admin')), [needsAdmin, user]);
  const [stepIndex, setStepIndex] = useState(0);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const step = steps[Math.min(stepIndex, steps.length - 1)]!;

  const loadSettings = async () => {
    try {
      setSettings(await api.get<PublicSettings>('/api/setup/config'));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    if (user) void loadSettings();
  }, [user]);

  const save: Save = async (patch) => {
    const next = await api.put<PublicSettings>('/api/setup/config', patch);
    setSettings(next);
    await refresh();
    return next;
  };

  const goNext = () => setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  const goBack = () => setStepIndex((i) => Math.max(i - 1, 0));

  return (
    <div className="wizard-wrap">
      <div className="wizard">
        <header className="wizard-header">
          <div>
            <div className="brand-title">{t('wiz.title')}</div>
            <div className="muted small">{settings?.setupCompletedAt ? t('wiz.subtitleChange') : t('wiz.subtitleNew')}</div>
          </div>
          <div className="page-actions">
            <LanguageSwitcher />
            {user && settings?.setupCompletedAt && (
              <button className="btn btn-ghost" onClick={() => navigate('/')}>
                {t('common.close')}
              </button>
            )}
          </div>
        </header>
        <ol className="stepper">
          {steps.map((s, i) => (
            <li
              key={s}
              className={i === stepIndex ? 'active' : i < stepIndex ? 'done' : ''}
              onClick={() => {
                if (user && (i < stepIndex || settings?.setupCompletedAt)) setStepIndex(i);
              }}
            >
              <span className="step-num">{i < stepIndex ? '✓' : i + 1}</span> {t(`wiz.step.${s}`)}
            </li>
          ))}
        </ol>
        <ErrorBox error={error} />
        <Card title={t(`wiz.step.${step}.t`)}>
          {step === 'admin' && (
            <AdminStep
              onDone={async (username, password) => {
                await api.post('/api/setup/admin', { username, password });
                await login(username, password);
                notify(t('wiz.adminCreated'), 'ok');
                await loadSettings();
                goNext();
              }}
            />
          )}
          {step !== 'admin' && !settings && <Spinner />}
          {step === 'connection' && settings && <ConnectionStep settings={settings} onSave={save} onNext={goNext} />}
          {step === 'sync' && settings && <SyncStep settings={settings} onSave={save} onNext={goNext} onBack={goBack} />}
          {step === 'enrichment' && settings && <EnrichmentStep settings={settings} onSave={save} onNext={goNext} onBack={goBack} />}
          {step === 'finish' && settings && (
            <FinishStep
              settings={settings}
              onBack={goBack}
              onFinish={async () => {
                await api.post('/api/setup/complete');
                await refresh();
                notify(t('wiz.done'), 'ok');
                navigate('/');
              }}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- steps
function Actions({ children }: { children: ReactNode }) {
  return <div className="form-actions wizard-actions">{children}</div>;
}

function AdminStep({ onDone }: { onDone: (username: string, password: string) => Promise<void> }) {
  const { t } = useI18n();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = username.trim().length > 0 && password.length >= 8 && password === confirm;
  return (
    <div className="form">
      <p className="muted">{t('wiz.adminHelp')}</p>
      <label>
        {t('login.username')}
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
      </label>
      <div className="grid-2">
        <label>
          {t('login.password')} <span className="muted">{t('wiz.passwordMin')}</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          {t('wiz.repeatPassword')}
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
      </div>
      {confirm && password !== confirm && <div className="field-error">{t('wiz.passwordMismatch')}</div>}
      {error && <div className="field-error">{error}</div>}
      <Actions>
        <button
          className="btn btn-primary"
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onDone(username.trim(), password);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t('wiz.creating') : t('wiz.createAdmin')}
        </button>
      </Actions>
    </div>
  );
}

function Hint({ code, fallback }: { code?: string | null; fallback?: string }) {
  const { tOr } = useI18n();
  if (!code && !fallback) return null;
  return <div className="small muted">{code ? tOr(`hint.${code}`, fallback ?? code) : fallback}</div>;
}

function ConnectionStep({ settings, onSave, onNext }: { settings: PublicSettings; onSave: Save; onNext: () => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'google' | 'mock'>(settings.mock ? 'mock' : 'google');
  const [accountId, setAccountId] = useState(settings.merchantAccountId);
  const [keyJson, setKeyJson] = useState('');
  const [keyInfo, setKeyInfo] = useState<{ clientEmail: string; projectId: string | null } | null>(settings.serviceAccount);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [apiBaseUrl, setApiBaseUrl] = useState(settings.apiBaseUrl);
  const [apiVersion, setApiVersion] = useState(settings.apiVersion);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [developerEmail, setDeveloperEmail] = useState('');
  const [registering, setRegistering] = useState(false);
  const [registration, setRegistration] = useState<{ ok: boolean; message?: string; error?: string; hint?: string; hintCode?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasKey = !!keyJson || !!settings.serviceAccount;

  const inspectKey = async (raw: string) => {
    setKeyJson(raw);
    setTest(null);
    if (!raw.trim()) {
      setKeyInfo(settings.serviceAccount);
      setKeyError(null);
      return;
    }
    try {
      setKeyInfo(await api.post('/api/setup/inspect-key', { serviceAccountJson: raw }));
      setKeyError(null);
    } catch (err) {
      setKeyInfo(null);
      setKeyError((err as Error).message);
    }
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => void inspectKey(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const credentials = () => ({
    mock: mode === 'mock',
    merchantAccountId: accountId,
    ...(keyJson ? { serviceAccountJson: keyJson } : {}),
    apiBaseUrl,
    apiVersion,
  });

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.post<ConnectionTestResult>('/api/setup/test-connection', credentials()));
    } catch (err) {
      setTest({ ok: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const registerGcp = async () => {
    setRegistering(true);
    setRegistration(null);
    try {
      setRegistration(await api.post('/api/setup/register-gcp', { ...credentials(), mock: false, developerEmail }));
    } catch (err) {
      setRegistration({ ok: false, error: (err as Error).message });
    } finally {
      setRegistering(false);
    }
  };

  const canContinue = mode === 'mock' || (accountId.trim() !== '' && hasKey && !keyError);

  return (
    <div className="form">
      <div className="mode-switch">
        <label className={`mode ${mode === 'google' ? 'active' : ''}`}>
          <input type="radio" checked={mode === 'google'} onChange={() => setMode('google')} />
          <div>
            <strong>{t('wiz.modeGoogle')}</strong>
            <div className="muted small">{t('wiz.modeGoogleHelp')}</div>
          </div>
        </label>
        <label className={`mode ${mode === 'mock' ? 'active' : ''}`}>
          <input type="radio" checked={mode === 'mock'} onChange={() => setMode('mock')} />
          <div>
            <strong>{t('wiz.modeDemo')}</strong>
            <div className="muted small">{t('wiz.modeDemoHelp')}</div>
          </div>
        </label>
      </div>

      {mode === 'google' && (
        <>
          <details className="help" open={!settings.serviceAccount}>
            <summary>{t('wiz.howTo')}</summary>
            <ol>
              <li>
                {t('wiz.how1a')}{' '}
                <a href="https://console.cloud.google.com/apis/library/merchantapi.googleapis.com" target="_blank" rel="noreferrer">
                  Google Cloud
                </a>{' '}
                {t('wiz.how1b')} <strong>{t('wiz.how1c')}</strong>.
              </li>
              <li>{t('wiz.how2')}</li>
              <li>
                {t('wiz.how3a')}{' '}
                <a href="https://merchants.google.com" target="_blank" rel="noreferrer">
                  Merchant Center
                </a>{' '}
                {t('wiz.how3b')} (<code>…@….iam.gserviceaccount.com</code>) {t('wiz.how3c')}
              </li>
              <li>{t('wiz.how4')}</li>
            </ol>
            <div className="muted">{t('wiz.howNote')}</div>
          </details>
          <label>
            {t('wiz.accountId')}
            <input value={accountId} onChange={(e) => (setAccountId(e.target.value.replace(/\D/g, '')), setTest(null))} placeholder="1234567890" inputMode="numeric" />
          </label>
          <label>
            {t('wiz.key')}
            {settings.serviceAccount && !keyJson && (
              <div className="small">
                <Badge tone="ok">{t('wiz.stored')}</Badge> {settings.serviceAccount.clientEmail}
                {settings.serviceAccount.projectId && <span className="muted"> · {t('wiz.project', { id: settings.serviceAccount.projectId })}</span>}
                {settings.fromEnvironment.includes('serviceAccountJson') && <span className="muted"> · {t('wiz.fromEnv')}</span>}
                <span className="muted"> {t('wiz.replaceKey')}</span>
              </div>
            )}
            <div className="inline-form">
              <input type="file" accept="application/json,.json" onChange={(e) => onFile(e.target.files?.[0])} />
            </div>
            <textarea
              className="code"
              rows={5}
              value={keyJson}
              onChange={(e) => void inspectKey(e.target.value)}
              placeholder={settings.serviceAccount ? t('wiz.keepKey') : '{ "type": "service_account", "project_id": "...", "private_key": "...", "client_email": "..." }'}
              spellCheck={false}
            />
            {keyError && <div className="field-error">{keyError}</div>}
            {keyInfo && keyJson && (
              <div className="small">
                <Badge tone="ok">{t('wiz.validKey')}</Badge> {keyInfo.clientEmail}
                {keyInfo.projectId && <span className="muted"> · {t('wiz.project', { id: keyInfo.projectId })}</span>}
              </div>
            )}
          </label>
          <button className="btn btn-ghost btn-sm" onClick={() => setAdvanced(!advanced)}>
            {advanced ? '▾' : '▸'} {t('wiz.advanced')}
          </button>
          {advanced && (
            <div className="grid-2">
              <label>
                {t('wiz.apiBaseUrl')}
                <input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} />
              </label>
              <label>
                {t('wiz.apiVersion')}
                <input value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} />
              </label>
            </div>
          )}
        </>
      )}

      <div className="test-box">
        <button className="btn" disabled={testing || !canContinue} onClick={runTest}>
          {testing ? t('wiz.testing') : t('wiz.test')}
        </button>
        {test && (
          <div className={`test-result ${test.ok ? 'ok' : 'fail'}`}>
            {test.ok ? (
              <>
                <Badge tone="ok">{t('wiz.connected')}</Badge> <strong>{test.account?.accountName ?? t('wiz.accountFallback')}</strong>{' '}
                {t('wiz.accountIdShort', { id: test.account?.accountId })}
                {test.account?.testAccount && <Badge tone="warning">{t('common.testAccount')}</Badge>}
                <div className="small muted">{t('wiz.testDetails', { n: test.dataSources, products: test.hasProducts ? t('wiz.found') : t('wiz.noneYet'), ms: test.durationMs })}</div>
                {test.warnings?.map((w, i) => (
                  <div key={i} className="field-error small">
                    {w}
                  </div>
                ))}
              </>
            ) : (
              <>
                <Badge tone="error">{t('common.failed')}</Badge> {test.error}
                <Hint code={test.hintCode} fallback={test.hint} />
              </>
            )}
          </div>
        )}
      </div>

      {mode === 'google' && (test?.needsRegistration || registration) && (
        <div className="register-box">
          <h4>{t('wiz.register')}</h4>
          <p className="muted small">{t('wiz.registerHelp')}</p>
          <div className="inline-form">
            <input type="email" placeholder="admin@your-company.com" value={developerEmail} onChange={(e) => setDeveloperEmail(e.target.value)} />
            <button className="btn btn-primary" disabled={registering || !/@/.test(developerEmail)} onClick={registerGcp}>
              {registering ? t('wiz.registering') : t('wiz.registerBtn')}
            </button>
          </div>
          {registration && (
            <div className={`test-result ${registration.ok ? 'ok' : 'fail'}`}>
              {registration.ok ? (
                <>
                  <Badge tone="ok">{t('wiz.registered')}</Badge> {t('wiz.registeredMsg')}
                </>
              ) : (
                <>
                  <Badge tone="error">{t('common.failed')}</Badge> {registration.error}
                  <Hint code={registration.hintCode} fallback={registration.hint} />
                </>
              )}
            </div>
          )}
        </div>
      )}
      {error && <div className="field-error">{error}</div>}
      <Actions>
        <button
          className="btn btn-primary"
          disabled={!canContinue || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onSave({ ...credentials(), merchantAccountId: mode === 'mock' ? accountId || '1234567890' : accountId });
              onNext();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t('common.saving') : t('wiz.saveContinue')}
        </button>
        {mode === 'google' && !test?.ok && <span className="muted small">{t('wiz.testTip')}</span>}
      </Actions>
    </div>
  );
}

const INTERVALS = [0, 15, 30, 60, 180, 360, 720, 1440] as const;

function SyncStep({ settings, onSave, onNext, onBack }: { settings: PublicSettings; onSave: Save; onNext: () => void; onBack: () => void }) {
  const { t } = useI18n();
  const [interval, setInterval] = useState(settings.syncIntervalMinutes);
  const [onStartup, setOnStartup] = useState(settings.syncOnStartup);
  const [concurrency, setConcurrency] = useState(settings.apiConcurrency);
  const [publicUrl, setPublicUrl] = useState(settings.publicUrl ?? (typeof window !== 'undefined' && window.location.protocol === 'https:' ? window.location.origin : ''));
  const [secret, setSecret] = useState(settings.webhookSecret);
  const [languageCode, setLanguageCode] = useState(settings.languageCode);
  const [timeZone, setTimeZone] = useState(settings.timeZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const webhookUrl = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/api/webhooks/merchant/${secret}` : null;
  return (
    <div className="form">
      <h4>{t('wiz.bgSync')}</h4>
      <p className="muted small">{t('wiz.bgSyncHelp')}</p>
      <div className="grid-2">
        <label>
          {t('wiz.interval')}
          <select value={interval} onChange={(e) => setInterval(Number(e.target.value))}>
            {INTERVALS.map((n) => (
              <option key={n} value={n}>
                {t(`wiz.interval.${n}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={onStartup} onChange={(e) => setOnStartup(e.target.checked)} /> {t('wiz.syncOnStartup')}
        </label>
      </div>
      <label>
        {t('wiz.concurrency')} <span className="muted">{t('wiz.concurrencyHelp')}</span>
        <select value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
          {[1, 2, 4, 8, 12, 16, 24, 32].map((n) => (
            <option key={n} value={n}>
              {n}
              {n === 8 ? ` ${t('wiz.recommended')}` : ''}
            </option>
          ))}
        </select>
      </label>
      <h4>{t('wiz.pushTitle')}</h4>
      <p className="muted small">{t('wiz.pushHelp')}</p>
      <div className="grid-2">
        <label>
          {t('wiz.publicUrl')}
          <input value={publicUrl} onChange={(e) => setPublicUrl(e.target.value.trim())} placeholder="https://gmc.example.com" />
        </label>
        <label>
          {t('wiz.webhookSecret')}
          <span className="inline-form">
            <input value={secret} onChange={(e) => setSecret(e.target.value)} />
            <button className="btn btn-sm" onClick={async () => setSecret((await api.post<{ secret: string }>('/api/setup/generate-secret')).secret)}>
              {t('wiz.generate')}
            </button>
          </span>
        </label>
      </div>
      {webhookUrl && (
        <div className="small muted">
          {t('wiz.callbackUrl')} <code>{webhookUrl}</code>
        </div>
      )}
      <h4>{t('wiz.locale')}</h4>
      <div className="grid-2">
        <label>
          {t('wiz.language')}
          <input value={languageCode} onChange={(e) => setLanguageCode(e.target.value)} placeholder="pl-PL" list="lang-list" />
          <datalist id="lang-list">
            {['pl-PL', 'en-US', 'de-DE', 'cs-CZ'].map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </label>
        <label>
          {t('wiz.timeZone')}
          <input value={timeZone} onChange={(e) => setTimeZone(e.target.value)} placeholder="Europe/Warsaw" list="tz-list" />
          <datalist id="tz-list">
            {['Europe/Warsaw', 'Europe/Berlin', 'Europe/London', 'Europe/Paris', 'America/New_York', 'UTC'].map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </label>
      </div>
      {error && <div className="field-error">{error}</div>}
      <Actions>
        <button className="btn" onClick={onBack}>
          {t('common.back')}
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || secret.length < 8}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onSave({ syncIntervalMinutes: interval, syncOnStartup: onStartup, apiConcurrency: concurrency, publicUrl: publicUrl || null, webhookSecret: secret, languageCode, timeZone });
              onNext();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t('common.saving') : t('wiz.saveContinue')}
        </button>
      </Actions>
    </div>
  );
}

function EnrichmentStep({ settings, onSave, onNext, onBack }: { settings: PublicSettings; onSave: Save; onNext: () => void; onBack: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(settings.enrichmentDataSourceName);
  const [priority, setPriority] = useState(settings.enrichmentPriority);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="form">
      <p className="muted small">{t('wiz.enrichHelp')}</p>
      <label>
        {t('wiz.enrichName')}
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        {t('wiz.enrichPriority')}
        <select value={priority} onChange={(e) => setPriority(e.target.value as 'override')}>
          <option value="override">{t('wiz.priorityOverride')}</option>
          <option value="fallback">{t('wiz.priorityFallback')}</option>
        </select>
      </label>
      {error && <div className="field-error">{error}</div>}
      <Actions>
        <button className="btn" onClick={onBack}>
          {t('common.back')}
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onSave({ enrichmentDataSourceName: name.trim(), enrichmentPriority: priority });
              onNext();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t('common.saving') : t('wiz.saveContinue')}
        </button>
      </Actions>
    </div>
  );
}

function FinishStep({ settings, onBack, onFinish }: { settings: PublicSettings; onBack: () => void; onFinish: () => Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows: [string, ReactNode][] = [
    [t('wiz.mode'), settings.mock ? <Badge tone="warning">{t('wiz.demoMock')}</Badge> : t('wiz.modeGoogle')],
    [t('wiz.accountId'), settings.merchantAccountId || '–'],
    [t('wiz.serviceAccount'), settings.mock ? '–' : (settings.serviceAccount?.clientEmail ?? <Badge tone="error">{t('wiz.missing')}</Badge>)],
    [t('wiz.interval'), settings.syncIntervalMinutes ? t('set.minutes', { n: settings.syncIntervalMinutes }) : t('wiz.manualOnly')],
    [t('wiz.publicUrl'), settings.publicUrl ?? <span className="muted">{t('wiz.notSet')}</span>],
    [t('wiz.locale'), `${settings.languageCode} · ${settings.timeZone}`],
    [t('set.enrichmentSource'), `${settings.enrichmentDataSourceName} (${settings.enrichmentPriority})`],
  ];
  return (
    <div className="form">
      <table className="table kv">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{t('wiz.finishHelp')}</p>
      {error && <div className="field-error">{error}</div>}
      <Actions>
        <button className="btn" onClick={onBack}>
          {t('common.back')}
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !settings.configured}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onFinish();
            } catch (err) {
              setError((err as Error).message);
              setBusy(false);
            }
          }}
        >
          {busy ? t('wiz.starting') : settings.setupCompletedAt ? t('wiz.saveRunSync') : t('wiz.finish')}
        </button>
      </Actions>
    </div>
  );
}
