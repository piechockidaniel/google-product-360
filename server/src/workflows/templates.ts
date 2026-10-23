import type { workflowDefinitionSchema } from './schema.js';
import type { z } from 'zod';

/** Input form of a definition (defaults not yet applied). */
type WorkflowDefinitionInput = z.input<typeof workflowDefinitionSchema>;

/** Ready-made workflows the user can start from in the editor. */
export const WORKFLOW_TEMPLATES: { id: string; title: string; description: string; definition: WorkflowDefinitionInput }[] = [
  {
    id: 'tag-disapproved',
    title: 'Tag disapproved products after every sync',
    description: 'Keeps a local "disapproved" tag in sync with the Google status so the product list can be filtered quickly.',
    definition: {
      name: 'Tag disapproved products',
      description: 'Adds the tag "disapproved" to disapproved products and removes it from the others.',
      enabled: true,
      trigger: { type: 'event', event: 'sync.completed', debounceSeconds: 5 },
      steps: [
        { type: 'select_products', filter: { status: ['DISAPPROVED', 'PARTIALLY_APPROVED'] } },
        { type: 'add_tags', tags: ['disapproved'] },
        { type: 'select_products', filter: { status: ['APPROVED', 'PENDING'] } },
        { type: 'remove_tags', tags: ['disapproved'] },
      ],
    },
  },
  {
    id: 'label-missing-gtin',
    title: 'Set custom label for products with missing GTIN',
    description: 'Pushes customLabel4 = "missing-gtin" through the enrichment feed so campaigns can exclude them.',
    definition: {
      name: 'Label products with missing GTIN',
      description: '',
      enabled: true,
      trigger: { type: 'schedule', cron: '0 6 * * *' },
      steps: [
        { type: 'select_products', filter: { hasIssues: true } },
        { type: 'filter', condition: { field: 'issueCodes', op: 'contains', value: 'missing_gtin' } },
        { type: 'stop_if_empty' },
        { type: 'set_attributes', attributes: { customLabel4: 'missing-gtin' }, continueOnError: true },
        { type: 'log', message: 'Labelled {{count}} products with missing GTIN' },
      ],
    },
  },
  {
    id: 'notify-new-errors',
    title: 'Notify a webhook about new critical issues',
    description: 'Whenever a sync discovers new disapproval issues, POST a summary (Slack / Teams / n8n compatible JSON) to a webhook.',
    definition: {
      name: 'Notify about new critical issues',
      description: '',
      enabled: false,
      trigger: { type: 'event', event: 'issue.new', debounceSeconds: 60 },
      steps: [
        { type: 'select_event_products', levels: ['error'] },
        { type: 'stop_if_empty' },
        { type: 'add_tags', tags: ['needs-attention'] },
        { type: 'webhook', url: 'https://hooks.example.com/replace-me', method: 'POST', message: '{{count}} product(s) got new critical issues', includeProducts: true, skipIfEmpty: true },
      ],
    },
  },
  {
    id: 'pause-out-of-stock',
    title: 'Pause out-of-stock products with errors',
    description: 'Products that are both out of stock and disapproved are paused (pause=ALL) until fixed.',
    definition: {
      name: 'Pause out-of-stock disapproved products',
      description: '',
      enabled: false,
      trigger: { type: 'manual' },
      steps: [
        { type: 'select_products', filter: { status: ['DISAPPROVED'], availability: 'OUT_OF_STOCK' } },
        { type: 'set_attributes', attributes: { pause: 'ALL' }, continueOnError: true },
        { type: 'set_note', note: 'Paused by workflow on {{date}}', mode: 'append' },
      ],
    },
  },
  {
    id: 'refetch-feed-nightly',
    title: 'Re-fetch the main feed and sync',
    description: 'Requests a fetch of a FETCH-type data source, then (after Google processed it) a sync picks up the changes.',
    definition: {
      name: 'Nightly feed fetch + sync',
      description: 'Set dataSourceId to your primary feed id.',
      enabled: false,
      trigger: { type: 'schedule', cron: '30 3 * * *' },
      steps: [
        { type: 'fetch_feed', dataSourceId: 'REPLACE_WITH_DATA_SOURCE_ID' },
        { type: 'log', message: 'Feed fetch requested at {{now}}' },
      ],
    },
  },
  {
    id: 'p360-label-scale',
    title: 'Product360: label products to scale',
    description: 'After every metrics update, products recommended as SCALE get customLabel0 = "p360-scale" so a Shopping / Performance Max campaign can target them; the label is cleared when they leave the bucket.',
    definition: {
      name: 'Product360 – scale label',
      description: 'Moves high-demand, healthy products into the "p360-scale" label.',
      enabled: false,
      trigger: { type: 'event', event: 'metrics.synced', debounceSeconds: 10 },
      steps: [
        { type: 'select_by_signal', recommendation: ['SCALE'], minDemand: 60 },
        { type: 'set_attributes', attributes: { customLabel0: 'p360-scale' }, continueOnError: true },
        { type: 'add_tags', tags: ['p360-scale'] },
        { type: 'select_products', filter: { tag: 'p360-scale' } },
        { type: 'filter', condition: { field: 'signals.recommendation', op: 'neq', value: 'SCALE' } },
        { type: 'set_attributes', attributes: { customLabel0: null }, continueOnError: true },
        { type: 'remove_tags', tags: ['p360-scale'] },
      ],
    },
  },
  {
    id: 'p360-reprice-weekend',
    title: 'Product360: weekend promotion for over-priced products',
    description: 'Every Friday, products recommended as REPRICE with enough demand get a 10 % sale price valid until Sunday night. Google starts and ends the promotion itself.',
    definition: {
      name: 'Product360 – weekend sale on REPRICE products',
      description: '',
      enabled: false,
      trigger: { type: 'schedule', cron: '0 8 * * 5' },
      steps: [
        { type: 'select_by_signal', recommendation: ['REPRICE'], minDemand: 40, limit: 200 },
        { type: 'stop_if_empty' },
        { type: 'set_sale_price', price: '-10%', from: 'now', to: '+3d', continueOnError: true },
        { type: 'webhook', url: 'https://hooks.example.com/replace-me', message: 'Weekend sale applied to {{count}} products', includeProducts: true },
      ],
    },
  },
  {
    id: 'p360-watch-alert',
    title: 'Product360: alert when products start sinking',
    description: 'Notifies a webhook about products whose recommendation changed to WATCH or FIX (demand sinking, clicks dropping or newly disapproved).',
    definition: {
      name: 'Product360 – watch list alert',
      description: '',
      enabled: false,
      trigger: { type: 'event', event: 'metrics.synced', debounceSeconds: 10 },
      steps: [
        { type: 'select_by_signal', recommendation: ['WATCH', 'FIX'] },
        { type: 'filter', condition: { field: 'signals.previousRecommendation', op: 'not_in', value: ['WATCH', 'FIX'] } },
        { type: 'stop_if_empty' },
        { type: 'webhook', url: 'https://hooks.example.com/replace-me', message: '{{count}} products need attention (WATCH/FIX)', includeProducts: true },
      ],
    },
  },
  {
    id: 'p360-organic-easy-wins',
    title: 'Product360: tag organic "easy wins" (Search Console)',
    description: 'Products whose landing page already ranks on positions 6–20 with real search volume get the tag "seo-easy-win" and a note – a better title / description can move them to page 1. Requires the Search Console connector.',
    definition: {
      name: 'Product360 – organic easy wins',
      description: '',
      enabled: false,
      trigger: { type: 'event', event: 'metrics.synced', debounceSeconds: 10 },
      steps: [
        { type: 'select_by_signal', recommendation: ['OPTIMISE_LISTING'] },
        { type: 'filter', condition: { all: [{ field: 'metrics.scPosition28d', op: 'gte', value: 6 }, { field: 'metrics.scPosition28d', op: 'lte', value: 20 }] } },
        { type: 'stop_if_empty' },
        { type: 'add_tags', tags: ['seo-easy-win'] },
        { type: 'set_note', note: 'Organic position {{metrics.scPosition28d}} with {{metrics.scImpressions28d}} impressions (28d) – check the top queries on the 360° tab ({{date}})', mode: 'append' },
      ],
    },
  },
];
