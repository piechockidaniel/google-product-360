import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { IssueLevel } from '../lib/types';
import { useT } from '../lib/i18n';

// ------------------------------------------------------------------ badges
export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'ok' | 'warning' | 'error' | 'info'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_KEYS = ['APPROVED', 'PARTIALLY_APPROVED', 'DISAPPROVED', 'PENDING', 'NOT_ELIGIBLE', 'UNKNOWN'] as const;

export function StatusBadge({ status }: { status: string }) {
  const t = useT();
  const tone =
    status === 'APPROVED' ? 'ok' : status === 'DISAPPROVED' ? 'error' : status === 'PARTIALLY_APPROVED' || status === 'PENDING' ? 'warning' : 'neutral';
  const label = (STATUS_KEYS as readonly string[]).includes(status) ? t(`status.${status as (typeof STATUS_KEYS)[number]}`) : status.replace(/_/g, ' ');
  return <Badge tone={tone}>{label}</Badge>;
}

export function LevelBadge({ level, label }: { level: IssueLevel | string | null; label?: string }) {
  const t = useT();
  const tone = level === 'error' ? 'error' : level === 'warning' ? 'warning' : level === 'info' ? 'info' : 'neutral';
  const text = label ?? (level === 'error' || level === 'warning' || level === 'info' ? t(`level.${level}`) : (level ?? '–'));
  return <Badge tone={tone}>{text}</Badge>;
}

export function HealthDot({ health }: { health: 'ok' | 'warning' | 'error' | 'unknown' }) {
  return <span className={`dot dot-${health}`} title={health} />;
}

// ------------------------------------------------------------------ feedback
export function Spinner({ label }: { label?: string }) {
  const t = useT();
  return <div className="spinner">{label ?? t('common.loading')}</div>;
}

export function ErrorBox({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  const t = useT();
  if (!error) return null;
  return (
    <div className="error-box">
      <span>{error}</span>
      {onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

// ------------------------------------------------------------------ toasts
interface Toast {
  id: number;
  tone: 'ok' | 'error' | 'info';
  message: string;
}
const ToastContext = createContext<{ notify: (message: string, tone?: Toast['tone']) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx.notify;
}

// ------------------------------------------------------------------ modal
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ misc
export function Card({ title, children, actions, className }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-header">
          {title && <h3>{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'warning' | 'error' | 'neutral' }) {
  return (
    <div className={`stat stat-${tone ?? 'neutral'}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  const t = useT();
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return (
    <div className="pagination">
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))}>
        ‹ {t('common.prev')}
      </button>
      <span>{t('common.page', { page, pages, total })}</span>
      <button className="btn btn-sm" disabled={page >= pages} onClick={() => onChange(offset + limit)}>
        {t('common.next')} ›
      </button>
    </div>
  );
}

export function TagList({ tags, onRemove }: { tags: string[]; onRemove?: (tag: string) => void }) {
  const t = useT();
  if (!tags.length) return <span className="muted">{t('common.noTags')}</span>;
  return (
    <span className="tags">
      {tags.map((t) => (
        <span key={t} className="tag">
          {t}
          {onRemove && (
            <button className="tag-remove" onClick={() => onRemove(t)} aria-label={`remove ${t}`}>
              ×
            </button>
          )}
        </span>
      ))}
    </span>
  );
}

/** Textarea bound to a JSON value with validation feedback. */
export function JsonEditor({ value, onChange, rows = 12 }: { value: unknown; onChange: (value: unknown) => void; rows?: number }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText((current) => {
      try {
        if (JSON.stringify(JSON.parse(current)) === JSON.stringify(value)) return current;
      } catch {
        /* keep editing text */
      }
      return JSON.stringify(value, null, 2);
    });
  }, [value]);
  return (
    <div className="json-editor">
      <textarea
        className={`code ${error ? 'invalid' : ''}`}
        rows={rows}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setError(null);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

export function Confirm({ message, onConfirm, children, className }: { message: string; onConfirm: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      className={className ?? 'btn btn-danger btn-sm'}
      onClick={() => {
        if (window.confirm(message)) onConfirm();
      }}
    >
      {children}
    </button>
  );
}
