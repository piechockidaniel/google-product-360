import type { Condition, FieldCondition } from './schema.js';

/** Resolves a dotted path (`attributes.brand`, `issues.0.code`) on an object. */
export function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && !/^\d+$/.test(segment)) {
      // map over arrays: issues.code -> ['a','b']
      current = current.map((item) => getPath(item, segment)).flat();
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function toComparable(value: unknown): number | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = Number(value);
  return Number.isNaN(n) ? String(value) : n;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

function loosePrimitiveEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

export function evaluateField(actual: unknown, cond: FieldCondition): boolean {
  const expected = cond.value;
  switch (cond.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'not_exists':
      return actual === undefined || actual === null;
    case 'is_empty':
      return isEmpty(actual);
    case 'is_not_empty':
      return !isEmpty(actual);
    case 'eq':
      return Array.isArray(actual) ? actual.some((a) => loosePrimitiveEquals(a, expected)) : loosePrimitiveEquals(actual, expected);
    case 'neq':
      return !evaluateField(actual, { ...cond, op: 'eq' });
    case 'contains':
      if (Array.isArray(actual)) return actual.some((a) => loosePrimitiveEquals(a, expected));
      if (typeof actual === 'string') return actual.toLowerCase().includes(String(expected).toLowerCase());
      return false;
    case 'not_contains':
      return !evaluateField(actual, { ...cond, op: 'contains' });
    case 'in': {
      const list = Array.isArray(expected) ? expected : [expected];
      return Array.isArray(actual) ? actual.some((a) => list.some((e) => loosePrimitiveEquals(a, e))) : list.some((e) => loosePrimitiveEquals(actual, e));
    }
    case 'not_in':
      return !evaluateField(actual, { ...cond, op: 'in' });
    case 'regex': {
      const re = new RegExp(String(expected), 'i');
      return Array.isArray(actual) ? actual.some((a) => re.test(String(a))) : re.test(String(actual ?? ''));
    }
    case 'starts_with':
      return typeof actual === 'string' && actual.toLowerCase().startsWith(String(expected).toLowerCase());
    case 'ends_with':
      return typeof actual === 'string' && actual.toLowerCase().endsWith(String(expected).toLowerCase());
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toComparable(Array.isArray(actual) ? actual.length : actual);
      const b = toComparable(expected);
      if (a === null || b === null) return false;
      if (typeof a !== typeof b) return false;
      if (cond.op === 'gt') return a > b;
      if (cond.op === 'gte') return a >= b;
      if (cond.op === 'lt') return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

export function evaluateCondition(subject: unknown, condition: Condition): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluateCondition(subject, c));
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(subject, c));
  if ('not' in condition) return !evaluateCondition(subject, condition.not);
  return evaluateField(getPath(subject, condition.field), condition);
}

/**
 * Very small mustache-like templating: `{{path.to.value}}`. Unknown paths
 * render as an empty string. Arrays are joined with ", ".
 */
export function renderTemplate(template: string, context: unknown): string {
  return template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_, path: string) => {
    const value = getPath(context, path);
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

/** Applies {@link renderTemplate} recursively to all string values. */
export function renderDeep<T>(value: T, context: unknown): T {
  if (typeof value === 'string') return renderTemplate(value, context) as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, context)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = renderDeep(v, context);
    return out as T;
  }
  return value;
}
