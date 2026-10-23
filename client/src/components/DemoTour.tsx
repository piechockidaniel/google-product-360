import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { DashboardInsights } from '../lib/types';
import { Badge, Card, useToast } from './ui';

const STORAGE_KEY = 'gmc.demoTourDismissed';

/**
 * Guided tour shown on the dashboard in DEMO_MODE: what to click, in which
 * order, plus a "simulate a day" button that makes the "since last login"
 * views and recommendation changes visible without waiting for tomorrow.
 */
export default function DemoTour({ insights, onChanged }: { insights: DashboardInsights; onChanged: () => void }) {
  const { t } = useI18n();
  const notify = useToast();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(STORAGE_KEY) === '1');
  const [busy, setBusy] = useState(false);
  if (dismissed) {
    return (
      <div className="demo-tour-collapsed muted small">
        <Badge tone="warning">{t('common.mock')}</Badge> {t('demo.collapsed')}{' '}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            localStorage.removeItem(STORAGE_KEY);
            setDismissed(false);
          }}
        >
          {t('demo.show')}
        </a>
      </div>
    );
  }
  const showcase = insights.focus[0] ?? insights.priceOpportunities[0] ?? insights.fix[0] ?? null;
  const simulate = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ sync: { newIssues?: number; resolvedIssues?: number; statusChanges?: number }; signals: { changed: number } | null }>('/api/dev/mock/simulate-day');
      notify(t('demo.simulated', { issues: r.sync.newIssues ?? 0, resolved: r.sync.resolvedIssues ?? 0, changed: r.signals?.changed ?? 0 }), 'ok');
      onChanged();
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const steps: { title: string; text: string; to?: string; external?: boolean }[] = [
    { title: t('demo.step1.title'), text: t('demo.step1.text') },
    { title: t('demo.step2.title'), text: t('demo.step2.text'), to: '/products?recommendation=SCALE&orderBy=impressions7d&orderDir=desc' },
    { title: t('demo.step3.title'), text: t('demo.step3.text'), to: showcase ? `/products/${showcase.productId}` : '/products' },
    { title: t('demo.step4.title'), text: t('demo.step4.text'), to: '/market' },
    { title: t('demo.step5.title'), text: t('demo.step5.text'), to: '/workflows' },
    { title: t('demo.step6.title'), text: t('demo.step6.text'), to: '/settings' },
  ];
  return (
    <Card
      className="demo-tour"
      title={
        <>
          <Badge tone="warning">{t('common.mock')}</Badge> {t('demo.title')}
        </>
      }
      actions={
        <>
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={simulate} title={t('demo.simulateHint')}>
            {busy ? t('common.loading') : t('demo.simulate')}
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              localStorage.setItem(STORAGE_KEY, '1');
              setDismissed(true);
            }}
          >
            {t('demo.dismiss')}
          </button>
        </>
      }
    >
      <p className="muted small">{t('demo.intro')}</p>
      <ol className="demo-steps">
        {steps.map((s, i) => (
          <li key={i}>
            <strong>{s.to ? <Link to={s.to}>{s.title}</Link> : s.title}</strong>
            <div className="muted small">{s.text}</div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
