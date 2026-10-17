import { z } from 'zod';

// ------------------------------------------------------------------ triggers
export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({
    type: z.literal('schedule'),
    /** Standard 5/6-field cron expression, e.g. `0 6 * * *` */
    cron: z.string().min(5),
    timezone: z.string().optional(),
  }),
  z.object({
    type: z.literal('event'),
    event: z.enum(['sync.completed', 'issue.new', 'issue.resolved', 'product.status_changed', 'notification.received', 'metrics.synced', 'signal.changed']),
    /** Events are batched for this many seconds before the workflow runs once. */
    debounceSeconds: z.number().int().min(0).max(3600).default(30),
  }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

// ------------------------------------------------------------------ conditions
export const conditionOperators = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'exists',
  'not_exists',
  'regex',
  'gt',
  'gte',
  'lt',
  'lte',
  'starts_with',
  'ends_with',
  'is_empty',
  'is_not_empty',
] as const;
export type ConditionOperator = (typeof conditionOperators)[number];

export interface FieldCondition {
  field: string;
  op: ConditionOperator;
  value?: unknown;
}
export type Condition = FieldCondition | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ field: z.string().min(1), op: z.enum(conditionOperators), value: z.unknown().optional() }),
    z.object({ all: z.array(conditionSchema).min(1) }),
    z.object({ any: z.array(conditionSchema).min(1) }),
    z.object({ not: conditionSchema }),
  ]),
);

// ------------------------------------------------------------------ steps
export const recommendationSchema = z.enum(['SCALE', 'FIX', 'REPRICE', 'OPTIMISE_LISTING', 'WATCH', 'PAUSE', 'KEEP', 'NO_DATA']);

const productFilterSchema = z.object({
  q: z.string().optional(),
  status: z.array(z.enum(['APPROVED', 'PARTIALLY_APPROVED', 'DISAPPROVED', 'PENDING', 'NOT_ELIGIBLE', 'UNKNOWN'])).optional(),
  severity: z.array(z.enum(['error', 'warning', 'info'])).optional(),
  issueCode: z.string().optional(),
  tag: z.string().optional(),
  feedLabel: z.string().optional(),
  dataSource: z.string().optional(),
  brand: z.string().optional(),
  availability: z.string().optional(),
  hasIssues: z.boolean().optional(),
  category: z.string().optional(),
  recommendation: z.array(recommendationSchema).optional(),
  limit: z.number().int().positive().max(10000).optional(),
});
/** `"2025-11-28T00:00:00Z"`, or relative to the run time: `now`, `+3d`, `+12h`, `-1d`. */
export const relativeTimeSchema = z.string().regex(/^(now|[+-]\d+[hdw]|\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?)$/, 'Expected an ISO date/time or a relative value like now, +3d, +12h');

export const stepSchema = z.discriminatedUnion('type', [
  /** Load products from the local snapshot into the working set. */
  z.object({ type: z.literal('select_products'), filter: productFilterSchema.default({}) }),
  /** For event triggers: load the products referenced by the triggering events. */
  z.object({
    type: z.literal('select_event_products'),
    levels: z.array(z.enum(['error', 'warning', 'info'])).optional(),
    issueCodes: z.array(z.string()).optional(),
  }),
  /** Product360: load products by recommendation / score thresholds. */
  z.object({
    type: z.literal('select_by_signal'),
    recommendation: z.array(recommendationSchema).min(1),
    minDemand: z.number().min(0).max(100).optional(),
    minImpressions7d: z.number().int().min(0).optional(),
    category: z.string().optional(),
    limit: z.number().int().positive().max(10000).optional(),
  }),
  /** Keep only products matching the condition. */
  z.object({ type: z.literal('filter'), condition: conditionSchema }),
  /** Cap the working set. */
  z.object({ type: z.literal('limit'), max: z.number().int().positive() }),
  /** Abort the remaining steps when the working set is empty. */
  z.object({ type: z.literal('stop_if_empty') }),
  /** Push attributes to Google through the enrichment data source. Values support {{templates}}. */
  z.object({
    type: z.literal('set_attributes'),
    attributes: z.record(z.unknown()),
    customAttributes: z.array(z.object({ name: z.string().min(1), value: z.string() })).optional(),
    continueOnError: z.boolean().default(true),
  }),
  /**
   * Push a sale price with an effective window (Google applies and ends the promotion itself).
   * `price` may be a fixed amount ("89.99"), a percentage off the current price ("-15%") or a template.
   */
  z.object({
    type: z.literal('set_sale_price'),
    price: z.string().min(1),
    currency: z.string().length(3).optional(),
    from: relativeTimeSchema.default('now'),
    to: relativeTimeSchema,
    continueOnError: z.boolean().default(true),
  }),
  /** Remove all enrichment data from the selected products. */
  z.object({ type: z.literal('clear_attributes'), continueOnError: z.boolean().default(true) }),
  z.object({ type: z.literal('add_tags'), tags: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal('remove_tags'), tags: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal('set_note'), note: z.string(), mode: z.enum(['replace', 'append']).default('append') }),
  /** Re-read the selected products from Google (refreshes their status + issues). */
  z.object({ type: z.literal('refresh_products'), continueOnError: z.boolean().default(true) }),
  /** Trigger an immediate fetch of a FETCH-type data source. */
  z.object({ type: z.literal('fetch_feed'), dataSourceId: z.string().min(1) }),
  /** Run a full sync of products / issues. */
  z.object({ type: z.literal('sync') }),
  /** POST a JSON summary (optionally with the product list) to an external URL (Slack, n8n, custom…). */
  z.object({
    type: z.literal('webhook'),
    url: z.string().url(),
    method: z.enum(['POST', 'PUT']).default('POST'),
    headers: z.record(z.string()).optional(),
    message: z.string().optional(),
    includeProducts: z.boolean().default(true),
    /** Skip the call when the working set is empty. */
    skipIfEmpty: z.boolean().default(true),
  }),
  /** Write a line to the run log / activity trail. */
  z.object({ type: z.literal('log'), message: z.string().min(1), severity: z.enum(['info', 'warning', 'error']).default('info') }),
]);
export type Step = z.infer<typeof stepSchema>;
export type StepType = Step['type'];

export const workflowDefinitionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  enabled: z.boolean().default(true),
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1).max(50),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export interface Workflow extends WorkflowDefinition {
  id: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

/** Human readable catalog, served to the UI so the editor can stay in sync with the engine. */
export const STEP_CATALOG: { type: StepType; label: string; description: string; example: Record<string, unknown> }[] = [
  { type: 'select_products', label: 'Select products', description: 'Loads products from the local snapshot using filters.', example: { type: 'select_products', filter: { status: ['DISAPPROVED'] } } },
  { type: 'select_event_products', label: 'Select products from event', description: 'For event triggers: loads the products the events refer to.', example: { type: 'select_event_products', levels: ['error'] } },
  { type: 'select_by_signal', label: 'Select by recommendation', description: 'Product360: loads products with the given recommendation (SCALE, FIX, REPRICE, …), optionally above a demand score.', example: { type: 'select_by_signal', recommendation: ['REPRICE'], minDemand: 40 } },
  { type: 'filter', label: 'Filter', description: 'Keeps only products matching a condition tree.', example: { type: 'filter', condition: { field: 'issueCodes', op: 'contains', value: 'missing_gtin' } } },
  { type: 'limit', label: 'Limit', description: 'Keeps at most N products.', example: { type: 'limit', max: 100 } },
  { type: 'stop_if_empty', label: 'Stop if empty', description: 'Stops the workflow when no products are selected.', example: { type: 'stop_if_empty' } },
  { type: 'set_attributes', label: 'Set attributes', description: 'Pushes attributes to Google via the enrichment data source. Values can use {{offerId}}, {{title}}, {{attributes.brand}}…', example: { type: 'set_attributes', attributes: { customLabel0: 'needs-review' } } },
  { type: 'set_sale_price', label: 'Set sale price (time window)', description: 'Pushes salePrice + salePriceEffectiveDate; Google starts and ends the promotion itself. Price: amount, "-15%" or a template.', example: { type: 'set_sale_price', price: '-10%', from: 'now', to: '+7d' } },
  { type: 'clear_attributes', label: 'Clear attributes', description: 'Removes all attributes pushed by this app for the products.', example: { type: 'clear_attributes' } },
  { type: 'add_tags', label: 'Add tags', description: 'Adds local tags to the products.', example: { type: 'add_tags', tags: ['disapproved'] } },
  { type: 'remove_tags', label: 'Remove tags', description: 'Removes local tags from the products.', example: { type: 'remove_tags', tags: ['disapproved'] } },
  { type: 'set_note', label: 'Set note', description: 'Appends or replaces the local note.', example: { type: 'set_note', note: 'Flagged by workflow on {{now}}', mode: 'append' } },
  { type: 'refresh_products', label: 'Refresh products', description: 'Re-reads the selected products from Google.', example: { type: 'refresh_products' } },
  { type: 'fetch_feed', label: 'Fetch feed', description: 'Requests an immediate fetch of a FETCH data source.', example: { type: 'fetch_feed', dataSourceId: '101' } },
  { type: 'sync', label: 'Sync', description: 'Runs a full product + issue sync.', example: { type: 'sync' } },
  { type: 'webhook', label: 'Webhook', description: 'POSTs a JSON summary to an external URL.', example: { type: 'webhook', url: 'https://hooks.example.com/abc', message: '{{count}} products need attention' } },
  { type: 'log', label: 'Log', description: 'Writes a message to the run log and activity trail.', example: { type: 'log', message: 'Selected {{count}} products' } },
];
