import type { Trigger, WorkflowStep } from './types';
import type { Params } from './i18n';

/** Translator signature used by the summaries (keys are plain strings here). */
export type Tr = (key: string, params?: Params) => string;

/** Presentation metadata for the visual builder (the engine only knows `type`). */
export interface BlockMeta {
  type: string;
  icon: string;
  group: 'Select' | 'Refine' | 'Product actions' | 'Account & sync' | 'Notify';
  /** colour family used by the canvas */
  tone: 'select' | 'refine' | 'action' | 'system' | 'notify';
}

export const BLOCKS: BlockMeta[] = [
  { type: 'select_products', icon: '🔍', group: 'Select', tone: 'select' },
  { type: 'select_by_signal', icon: '◔', group: 'Select', tone: 'select' },
  { type: 'select_event_products', icon: '⚡', group: 'Select', tone: 'select' },
  { type: 'filter', icon: '⏷', group: 'Refine', tone: 'refine' },
  { type: 'limit', icon: '#', group: 'Refine', tone: 'refine' },
  { type: 'stop_if_empty', icon: '⏹', group: 'Refine', tone: 'refine' },
  { type: 'set_attributes', icon: '✎', group: 'Product actions', tone: 'action' },
  { type: 'set_sale_price', icon: '%', group: 'Product actions', tone: 'action' },
  { type: 'clear_attributes', icon: '⌫', group: 'Product actions', tone: 'action' },
  { type: 'add_tags', icon: '🏷', group: 'Product actions', tone: 'action' },
  { type: 'remove_tags', icon: '✂', group: 'Product actions', tone: 'action' },
  { type: 'set_note', icon: '📝', group: 'Product actions', tone: 'action' },
  { type: 'refresh_products', icon: '⟳', group: 'Product actions', tone: 'action' },
  { type: 'fetch_feed', icon: '⇣', group: 'Account & sync', tone: 'system' },
  { type: 'sync', icon: '⇅', group: 'Account & sync', tone: 'system' },
  { type: 'webhook', icon: '🔔', group: 'Notify', tone: 'notify' },
  { type: 'log', icon: '≡', group: 'Notify', tone: 'notify' },
];

export const BLOCK_GROUPS = ['Select', 'Refine', 'Product actions', 'Account & sync', 'Notify'] as const;

export function blockMeta(type: string): BlockMeta {
  return BLOCKS.find((b) => b.type === type) ?? { type, icon: '▢', group: 'Notify', tone: 'system' };
}

function list(v: unknown): string {
  return Array.isArray(v) ? v.join(', ') : '';
}

/** One-line, human readable summary of a step's configuration. */
export function summarizeStep(step: WorkflowStep, t: Tr): string {
  switch (step.type) {
    case 'select_products': {
      const f = (step.filter as Record<string, unknown>) ?? {};
      const parts: string[] = [];
      if (Array.isArray(f.status) && f.status.length) parts.push(t('wf.s.status', { v: list(f.status) }));
      if (f.hasIssues === true) parts.push(t('wf.s.withIssues'));
      if (f.hasIssues === false) parts.push(t('wf.s.withoutIssues'));
      if (f.issueCode) parts.push(t('wf.s.issue', { v: String(f.issueCode) }));
      if (Array.isArray(f.severity) && f.severity.length) parts.push(t('wf.s.severity', { v: list(f.severity) }));
      if (f.tag) parts.push(t('wf.s.tag', { v: String(f.tag) }));
      if (f.feedLabel) parts.push(t('wf.s.feed', { v: String(f.feedLabel) }));
      if (f.brand) parts.push(t('wf.s.brand', { v: String(f.brand) }));
      if (f.availability) parts.push(String(f.availability));
      if (f.q) parts.push(`"${f.q}"`);
      if (f.limit) parts.push(t('wf.s.max', { v: String(f.limit) }));
      return parts.length ? parts.join(' · ') : t('wf.s.allProducts');
    }
    case 'select_by_signal': {
      const parts: string[] = [list(step.recommendation) || '?'];
      if (typeof step.minDemand === 'number') parts.push(t('wf.s.minDemand', { v: step.minDemand }));
      if (typeof step.minImpressions7d === 'number') parts.push(t('wf.s.minImpressions', { v: step.minImpressions7d }));
      if (step.category) parts.push(String(step.category));
      if (step.limit) parts.push(t('wf.s.max', { v: String(step.limit) }));
      return parts.join(' · ');
    }
    case 'set_sale_price':
      return t('wf.s.salePrice', { price: String(step.price ?? '?'), from: String(step.from ?? 'now'), to: String(step.to ?? '?') });
    case 'select_event_products': {
      const parts: string[] = [];
      if (Array.isArray(step.levels) && step.levels.length) parts.push(t('wf.s.levels', { v: list(step.levels) }));
      if (Array.isArray(step.issueCodes) && step.issueCodes.length) parts.push(t('wf.s.codes', { v: list(step.issueCodes) }));
      return parts.length ? parts.join(' · ') : t('wf.s.fromEvents');
    }
    case 'filter':
      return summarizeCondition(step.condition as Record<string, unknown>, t);
    case 'limit':
      return t('wf.s.keepAtMost', { v: String(step.max ?? '?') });
    case 'stop_if_empty':
      return t('wf.s.stopEmpty');
    case 'set_attributes': {
      const attrs = Object.keys((step.attributes as Record<string, unknown>) ?? {});
      const custom = Array.isArray(step.customAttributes) ? step.customAttributes.length : 0;
      return [attrs.length ? attrs.join(', ') : '', custom ? t('wf.s.custom', { n: custom }) : ''].filter(Boolean).join(' · ') || t('wf.s.noAttributes');
    }
    case 'clear_attributes':
      return t('wf.s.clear');
    case 'add_tags':
      return `+ ${list(step.tags) || '?'}`;
    case 'remove_tags':
      return `− ${list(step.tags) || '?'}`;
    case 'set_note':
      return `${step.mode === 'replace' ? t('wf.f.replace') : t('wf.f.append')}: "${String(step.note ?? '')}"`;
    case 'refresh_products':
      return t('wf.s.refresh');
    case 'fetch_feed':
      return t('wf.s.dataSource', { v: String(step.dataSourceId ?? '?') });
    case 'sync':
      return t('wf.s.sync');
    case 'webhook':
      return `${step.method ?? 'POST'} ${step.url ?? '?'}`;
    case 'log':
      return `"${String(step.message ?? '')}"`;
    default:
      return '';
  }
}

function summarizeCondition(c: Record<string, unknown> | undefined, t: Tr): string {
  if (!c) return t('wf.s.noCondition');
  if ('all' in c) return (c.all as Record<string, unknown>[]).map((x) => summarizeCondition(x, t)).join(' AND ');
  if ('any' in c) return (c.any as Record<string, unknown>[]).map((x) => summarizeCondition(x, t)).join(' OR ');
  if ('not' in c) return `NOT (${summarizeCondition(c.not as Record<string, unknown>, t)})`;
  const value = Array.isArray(c.value) ? c.value.join(', ') : c.value === undefined ? '' : String(c.value);
  return `${c.field ?? '?'} ${String(c.op ?? '?').replace(/_/g, ' ')}${value ? ` ${value}` : ''}`;
}

export function summarizeTrigger(trigger: Trigger, t: Tr): string {
  if (trigger.type === 'manual') return t('wf.s.runManually');
  if (trigger.type === 'schedule') return `${t('wf.s.cron', { cron: trigger.cron })}${trigger.timezone ? ` · ${trigger.timezone}` : ''}`;
  return `${t('wf.s.on', { event: trigger.event })}${trigger.debounceSeconds ? ` · ${t('wf.s.batch', { n: trigger.debounceSeconds })}` : ''}`;
}

/** Client-side sanity checks; returns a translation key or null. The server performs the authoritative validation. */
export function validateStep(step: WorkflowStep, index: number, steps: WorkflowStep[], trigger: Trigger): string | null {
  const hasSelection = steps.slice(0, index).some((s) => s.type === 'select_products' || s.type === 'select_event_products' || s.type === 'select_by_signal');
  const needsSelection = !['select_products', 'select_event_products', 'select_by_signal', 'fetch_feed', 'sync', 'log', 'webhook'].includes(step.type);
  if (needsSelection && !hasSelection) return 'wf.v.noSelection';
  switch (step.type) {
    case 'select_event_products':
      return trigger.type === 'event' ? null : 'wf.v.eventOnly';
    case 'filter': {
      const c = step.condition as Record<string, unknown> | undefined;
      if (!c) return 'wf.v.emptyCondition';
      const leaf = (x: Record<string, unknown>): boolean =>
        'all' in x ? (x.all as Record<string, unknown>[]).every(leaf) : 'any' in x ? (x.any as Record<string, unknown>[]).every(leaf) : 'not' in x ? leaf(x.not as Record<string, unknown>) : !!x.field && !!x.op;
      return leaf(c) ? null : 'wf.v.conditionFields';
    }
    case 'limit':
      return typeof step.max === 'number' && step.max > 0 ? null : 'wf.v.maxPositive';
    case 'set_attributes': {
      const attrs = (step.attributes as Record<string, unknown>) ?? {};
      const custom = Array.isArray(step.customAttributes) ? step.customAttributes.length : 0;
      return Object.keys(attrs).length || custom ? null : 'wf.v.chooseAttribute';
    }
    case 'select_by_signal':
      return Array.isArray(step.recommendation) && step.recommendation.length ? null : 'wf.v.recommendation';
    case 'set_sale_price': {
      const rel = /^(now|[+-]\d+[hdw]|\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?)$/;
      if (typeof step.price !== 'string' || !step.price.trim()) return 'wf.v.salePrice';
      if (typeof step.to !== 'string' || !rel.test(step.to) || (step.from !== undefined && !rel.test(String(step.from)))) return 'wf.v.saleWindow';
      return null;
    }
    case 'add_tags':
    case 'remove_tags':
      return Array.isArray(step.tags) && step.tags.length ? null : 'wf.v.enterTag';
    case 'set_note':
      return typeof step.note === 'string' ? null : 'wf.v.noteRequired';
    case 'fetch_feed':
      return typeof step.dataSourceId === 'string' && step.dataSourceId && !step.dataSourceId.startsWith('REPLACE') ? null : 'wf.v.dataSourceId';
    case 'webhook':
      return typeof step.url === 'string' && /^https?:\/\//.test(step.url) && !step.url.includes('replace-me') ? null : 'wf.v.webhookUrl';
    case 'log':
      return typeof step.message === 'string' && step.message.trim() ? null : 'wf.v.message';
    default:
      return null;
  }
}
