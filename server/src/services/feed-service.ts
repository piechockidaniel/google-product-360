import { z } from 'zod';
import type { MerchantApi } from '../google/merchant-api.js';
import { lastSegment } from '../google/merchant-api.js';
import type { DataSource, FileUpload } from '../google/types.js';
import type { EventLog } from './event-log.js';
import type { ProductStore } from './product-store.js';

export type FeedKind = 'primary' | 'supplemental' | 'local_inventory' | 'regional_inventory' | 'promotion' | 'product_review' | 'merchant_review' | 'unknown';

export interface FeedSummary {
  id: string;
  name: string;
  displayName: string;
  kind: FeedKind;
  input: string;
  fileInputType: string | null;
  fileName: string | null;
  fetchUri: string | null;
  fetchEnabled: boolean | null;
  fetchSchedule: string | null;
  feedLabel: string | null;
  contentLanguage: string | null;
  countries: string[];
  linkedSupplementalSources: string[];
  /** number of products in the local snapshot that originate from this source */
  productCount: number;
  lastUpload: FileUpload | null;
  health: 'ok' | 'warning' | 'error' | 'unknown';
  raw: DataSource;
}

export const createFeedSchema = z.object({
  displayName: z.string().min(1).max(200),
  kind: z.enum(['primary', 'supplemental']).default('primary'),
  feedLabel: z.string().regex(/^[A-Z0-9_-]{1,20}$/, 'Feed label: up to 20 uppercase letters, digits, dashes').optional(),
  contentLanguage: z.string().regex(/^[a-z]{2}$/, 'Two-letter ISO 639-1 code').optional(),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).optional(),
  /** File input; omit for API data sources */
  file: z
    .object({
      type: z.enum(['FETCH', 'UPLOAD', 'GOOGLE_SHEETS']).default('FETCH'),
      fileName: z.string().optional(),
      fetchUri: z.string().url().optional(),
      frequency: z.enum(['FREQUENCY_DAILY', 'FREQUENCY_WEEKLY', 'FREQUENCY_MONTHLY']).default('FREQUENCY_DAILY'),
      hour: z.number().int().min(0).max(23).default(4),
      minute: z.number().int().min(0).max(59).default(0),
      timeZone: z.string().default('Europe/Warsaw'),
      dayOfWeek: z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']).optional(),
      dayOfMonth: z.number().int().min(1).max(31).optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      enabled: z.boolean().default(true),
    })
    .optional(),
});
export type CreateFeedInput = z.infer<typeof createFeedSchema>;

export const updateFeedSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  fetch: z
    .object({
      fetchUri: z.string().url().optional(),
      frequency: z.enum(['FREQUENCY_DAILY', 'FREQUENCY_WEEKLY', 'FREQUENCY_MONTHLY']).optional(),
      hour: z.number().int().min(0).max(23).optional(),
      minute: z.number().int().min(0).max(59).optional(),
      timeZone: z.string().optional(),
      dayOfWeek: z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']).optional(),
      dayOfMonth: z.number().int().min(1).max(31).optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      enabled: z.boolean().optional(),
    })
    .optional(),
});
export type UpdateFeedInput = z.infer<typeof updateFeedSchema>;

export function feedKind(ds: DataSource): FeedKind {
  if (ds.primaryProductDataSource) return 'primary';
  if (ds.supplementalProductDataSource) return 'supplemental';
  if (ds.localInventoryDataSource) return 'local_inventory';
  if (ds.regionalInventoryDataSource) return 'regional_inventory';
  if (ds.promotionDataSource) return 'promotion';
  if (ds.productReviewDataSource) return 'product_review';
  if (ds.merchantReviewDataSource) return 'merchant_review';
  return 'unknown';
}

function describeSchedule(ds: DataSource): string | null {
  const fs = ds.fileInput?.fetchSettings;
  if (!fs) return null;
  const time = `${String(fs.timeOfDay?.hours ?? 0).padStart(2, '0')}:${String(fs.timeOfDay?.minutes ?? 0).padStart(2, '0')}`;
  const tz = fs.timeZone ? ` ${fs.timeZone}` : '';
  switch (fs.frequency) {
    case 'FREQUENCY_DAILY':
      return `daily at ${time}${tz}`;
    case 'FREQUENCY_WEEKLY':
      return `weekly on ${fs.dayOfWeek ?? '?'} at ${time}${tz}`;
    case 'FREQUENCY_MONTHLY':
      return `monthly on day ${fs.dayOfMonth ?? '?'} at ${time}${tz}`;
    default:
      return fs.frequency ?? null;
  }
}

/** Manages data sources (feeds) of the Merchant Center account. */
export class FeedService {
  constructor(
    private readonly api: MerchantApi,
    private readonly products: ProductStore,
    private readonly events: EventLog,
  ) {}

  async list(withUploads = true): Promise<FeedSummary[]> {
    const sources = await this.api.listDataSources();
    const counts = new Map<string, number>();
    for (const ds of sources) {
      counts.set(ds.name!, this.products.listProducts({ dataSource: ds.name!, limit: 1 }).total);
    }
    const summaries = await Promise.all(
      sources.map(async (ds) => {
        let upload: FileUpload | null = null;
        if (withUploads && ds.input === 'FILE') {
          try {
            upload = (await this.api.getLatestFileUpload(lastSegment(ds.name!))) ?? null;
          } catch {
            upload = null;
          }
        }
        return this.summarize(ds, upload, counts.get(ds.name!) ?? 0);
      }),
    );
    return summaries;
  }

  async get(id: string): Promise<FeedSummary> {
    const ds = await this.api.getDataSource(id);
    let upload: FileUpload | null = null;
    if (ds.input === 'FILE') {
      try {
        upload = (await this.api.getLatestFileUpload(id)) ?? null;
      } catch {
        upload = null;
      }
    }
    return this.summarize(ds, upload, this.products.listProducts({ dataSource: ds.name!, limit: 1 }).total);
  }

  async create(input: CreateFeedInput): Promise<FeedSummary> {
    const ds: DataSource = { displayName: input.displayName };
    if (input.kind === 'primary') {
      ds.primaryProductDataSource = {
        ...(input.feedLabel ? { feedLabel: input.feedLabel } : {}),
        ...(input.contentLanguage ? { contentLanguage: input.contentLanguage } : {}),
        ...(input.countries?.length ? { countries: input.countries } : {}),
      };
    } else {
      ds.supplementalProductDataSource = {
        ...(input.feedLabel ? { feedLabel: input.feedLabel } : {}),
        ...(input.contentLanguage ? { contentLanguage: input.contentLanguage } : {}),
      };
    }
    if (input.file) {
      if (!input.feedLabel || !input.contentLanguage) {
        throw new Error('feedLabel and contentLanguage are required for file data sources');
      }
      ds.fileInput = {
        fileInputType: input.file.type,
        ...(input.file.fileName ? { fileName: input.file.fileName } : {}),
        ...(input.file.type === 'FETCH' || input.file.type === 'GOOGLE_SHEETS'
          ? {
              fetchSettings: {
                enabled: input.file.enabled,
                frequency: input.file.frequency,
                timeOfDay: { hours: input.file.hour, minutes: input.file.minute },
                timeZone: input.file.timeZone,
                ...(input.file.fetchUri ? { fetchUri: input.file.fetchUri } : {}),
                ...(input.file.frequency === 'FREQUENCY_WEEKLY' ? { dayOfWeek: input.file.dayOfWeek ?? 'MONDAY' } : {}),
                ...(input.file.frequency === 'FREQUENCY_MONTHLY' ? { dayOfMonth: input.file.dayOfMonth ?? 1 } : {}),
                ...(input.file.username ? { username: input.file.username } : {}),
                ...(input.file.password ? { password: input.file.password } : {}),
              },
            }
          : {}),
      };
    }
    const created = await this.api.createDataSource(ds);
    this.events.record('feed.created', `Created data source "${created.displayName}" (${created.name})`, { payload: created });
    return this.summarize(created, null, 0);
  }

  async update(id: string, input: UpdateFeedInput): Promise<FeedSummary> {
    const existing = await this.api.getDataSource(id);
    const patch: DataSource = {};
    const masks: string[] = [];
    if (input.displayName !== undefined) {
      patch.displayName = input.displayName;
      masks.push('displayName');
    }
    if (input.fetch) {
      const fs = { ...(existing.fileInput?.fetchSettings ?? {}) };
      if (input.fetch.fetchUri !== undefined) fs.fetchUri = input.fetch.fetchUri;
      if (input.fetch.frequency !== undefined) fs.frequency = input.fetch.frequency;
      if (input.fetch.hour !== undefined || input.fetch.minute !== undefined) {
        fs.timeOfDay = { hours: input.fetch.hour ?? fs.timeOfDay?.hours ?? 0, minutes: input.fetch.minute ?? fs.timeOfDay?.minutes ?? 0 };
      }
      if (input.fetch.timeZone !== undefined) fs.timeZone = input.fetch.timeZone;
      if (input.fetch.dayOfWeek !== undefined) fs.dayOfWeek = input.fetch.dayOfWeek;
      if (input.fetch.dayOfMonth !== undefined) fs.dayOfMonth = input.fetch.dayOfMonth;
      if (input.fetch.username !== undefined) fs.username = input.fetch.username;
      if (input.fetch.password !== undefined) fs.password = input.fetch.password;
      if (input.fetch.enabled !== undefined) fs.enabled = input.fetch.enabled;
      patch.fileInput = { ...existing.fileInput, fetchSettings: fs };
      masks.push('fileInput.fetchSettings');
    }
    if (!masks.length) return this.get(id);
    const updated = await this.api.updateDataSource(id, patch, masks.join(','));
    this.events.record('feed.updated', `Updated data source "${updated.displayName}"`, { payload: { id, input } });
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    await this.api.deleteDataSource(id);
    this.events.record('feed.deleted', `Deleted data source ${id}`, { severity: 'warning' });
  }

  async fetchNow(id: string): Promise<void> {
    await this.api.fetchDataSource(id);
    this.events.record('feed.fetch_requested', `Requested immediate fetch of data source ${id}`);
  }

  private summarize(ds: DataSource, upload: FileUpload | null, productCount: number): FeedSummary {
    const kind = feedKind(ds);
    const product = ds.primaryProductDataSource ?? ds.supplementalProductDataSource;
    const fetch = ds.fileInput?.fetchSettings;
    let health: FeedSummary['health'] = 'unknown';
    if (upload) {
      if (upload.processingState === 'FAILED') health = 'error';
      else if (upload.issues?.some((i) => i.severity === 'ERROR')) health = 'error';
      else if (upload.issues?.length) health = 'warning';
      else if (upload.processingState === 'SUCCEEDED') health = 'ok';
    } else if (ds.input === 'API') {
      health = 'ok';
    }
    return {
      id: lastSegment(ds.name!),
      name: ds.name!,
      displayName: ds.displayName ?? ds.name!,
      kind,
      input: ds.input ?? 'INPUT_UNSPECIFIED',
      fileInputType: ds.fileInput?.fileInputType ?? null,
      fileName: ds.fileInput?.fileName ?? null,
      fetchUri: fetch?.fetchUri ?? null,
      fetchEnabled: fetch ? (fetch.enabled ?? true) : null,
      fetchSchedule: describeSchedule(ds),
      feedLabel: product?.feedLabel ?? ds.localInventoryDataSource?.feedLabel ?? ds.regionalInventoryDataSource?.feedLabel ?? null,
      contentLanguage: product?.contentLanguage ?? null,
      countries: ds.primaryProductDataSource?.countries ?? [],
      linkedSupplementalSources: (ds.primaryProductDataSource?.defaultRule?.takeFromDataSources ?? [])
        .map((r) => r.supplementalDataSourceName)
        .filter((n): n is string => !!n),
      productCount,
      lastUpload: upload,
      health,
      raw: ds,
    };
  }
}
