import type { MerchantApi } from '../google/merchant-api.js';
import { lastSegment } from '../google/merchant-api.js';
import type { CustomAttribute, DataSource, ProductInput } from '../google/types.js';
import type { Logger } from '../util/logger.js';
import { normalizeAttributes } from './attribute-catalog.js';
import type { EventLog } from './event-log.js';
import type { ProductMetadata, ProductStore } from './product-store.js';

export interface EnrichmentStatus {
  dataSource: DataSource | null;
  linkedPrimaries: string[];
  unlinkedPrimaries: { name: string; displayName: string }[];
}

export interface PushResult {
  productName: string;
  attributes: Record<string, unknown>;
  metadata: ProductMetadata;
}

/**
 * "Enhance products with metadata": pushes extra attributes to Google through
 * a dedicated supplemental data source (the only supported way to add data to
 * products that come from a feed). The supplemental source is created on
 * demand and linked to every primary product data source.
 */
/** How long a verified "linked to all primaries" state is trusted before re-checking. */
const LINK_CHECK_TTL_MS = 15 * 60_000;

export class EnrichmentService {
  private cachedDataSource: DataSource | null = null;
  private linksVerifiedAt = 0;
  /** De-duplicates concurrent ensureDataSource() calls (parallel workflow workers). */
  private ensuring: Promise<DataSource> | null = null;

  constructor(
    private readonly api: MerchantApi,
    private readonly products: ProductStore,
    private readonly events: EventLog,
    private readonly logger: Logger,
    private readonly getOptions: () => { displayName: string; priority: 'override' | 'fallback' },
  ) {}

  private get options(): { displayName: string; priority: 'override' | 'fallback' } {
    return this.getOptions();
  }

  /** Forget the cached data source (after settings / connection changes). */
  resetCache(): void {
    this.cachedDataSource = null;
    this.linksVerifiedAt = 0;
  }

  /** Finds the enrichment data source (by display name) without creating it. */
  async findDataSource(): Promise<DataSource | null> {
    if (this.cachedDataSource) return this.cachedDataSource;
    const all = await this.api.listDataSources();
    const found = all.find((d) => d.supplementalProductDataSource && d.displayName === this.options.displayName) ?? null;
    this.cachedDataSource = found;
    return found;
  }

  async status(): Promise<EnrichmentStatus> {
    const all = await this.api.listDataSources();
    const ds = all.find((d) => d.supplementalProductDataSource && d.displayName === this.options.displayName) ?? null;
    this.cachedDataSource = ds;
    const primaries = all.filter((d) => d.primaryProductDataSource);
    const linked: string[] = [];
    const unlinked: { name: string; displayName: string }[] = [];
    for (const p of primaries) {
      const refs = p.primaryProductDataSource?.defaultRule?.takeFromDataSources ?? [];
      if (ds && refs.some((r) => r.supplementalDataSourceName === ds.name)) linked.push(p.name!);
      else unlinked.push({ name: p.name!, displayName: p.displayName ?? p.name! });
    }
    return { dataSource: ds, linkedPrimaries: linked, unlinkedPrimaries: unlinked };
  }

  /**
   * Creates the supplemental data source if needed and links it to all primary
   * product sources. The (expensive) link verification is cached, so pushing
   * attributes to thousands of products costs one API call per product.
   */
  ensureDataSource(force = false): Promise<DataSource> {
    if (!force && this.cachedDataSource && Date.now() - this.linksVerifiedAt < LINK_CHECK_TTL_MS) {
      return Promise.resolve(this.cachedDataSource);
    }
    if (!this.ensuring) {
      this.ensuring = this.doEnsureDataSource().finally(() => {
        this.ensuring = null;
      });
    }
    return this.ensuring;
  }

  private async doEnsureDataSource(): Promise<DataSource> {
    let ds = await this.findDataSource();
    if (!ds) {
      ds = await this.api.createDataSource({
        displayName: this.options.displayName,
        supplementalProductDataSource: {},
      });
      this.cachedDataSource = ds;
      this.events.record('enrichment.datasource_created', `Created supplemental data source "${ds.displayName}" (${ds.name})`, { payload: ds });
      this.logger.info({ name: ds.name }, 'Created enrichment data source');
    }
    await this.linkToPrimaries(ds);
    this.linksVerifiedAt = Date.now();
    return ds;
  }

  private async linkToPrimaries(ds: DataSource): Promise<void> {
    const all = await this.api.listDataSources();
    for (const primary of all.filter((d) => d.primaryProductDataSource)) {
      const refs = primary.primaryProductDataSource?.defaultRule?.takeFromDataSources ?? [{ self: true }];
      if (refs.some((r) => r.supplementalDataSourceName === ds.name)) continue;
      const next = this.options.priority === 'override' ? [{ supplementalDataSourceName: ds.name }, ...refs] : [...refs, { supplementalDataSourceName: ds.name }];
      if (!next.some((r) => r.self)) next.push({ self: true });
      try {
        await this.api.updateDataSource(
          lastSegment(primary.name!),
          { primaryProductDataSource: { ...primary.primaryProductDataSource, defaultRule: { takeFromDataSources: next } } },
          'primaryProductDataSource.defaultRule',
        );
        this.events.record('enrichment.datasource_linked', `Linked enrichment data source to "${primary.displayName}"`, { payload: { primary: primary.name, supplemental: ds.name } });
      } catch (err) {
        this.logger.warn({ err, primary: primary.name }, 'Could not link enrichment data source to primary data source');
        this.events.record('enrichment.link_failed', `Could not link enrichment source to "${primary.displayName}": ${(err as Error).message}`, {
          severity: 'warning',
          payload: { primary: primary.name },
        });
      }
    }
  }

  /**
   * Merges `attributes` into the attributes already pushed for the product and
   * sends the full set to Google. `null` removes an attribute.
   * `customAttributes` (name/value pairs) are stored under the `customAttributes` key.
   */
  async pushAttributes(productName: string, attributes: Record<string, unknown>, customAttributes?: CustomAttribute[]): Promise<PushResult> {
    const product = this.products.getProduct(productName);
    if (!product) throw new Error(`Product ${productName} is not in the local store; run a sync first`);
    const normalized = normalizeAttributes(attributes);
    const current = this.products.getMetadata(productName).pushedAttributes;
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(normalized)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    if (customAttributes !== undefined) {
      if (customAttributes.length) merged.customAttributes = customAttributes;
      else delete merged.customAttributes;
    }
    return this.pushMerged(productName, merged);
  }

  /** Removes all enrichment data for a product (deletes the supplemental input). */
  async clearAttributes(productName: string): Promise<PushResult> {
    const product = this.products.getProduct(productName);
    if (!product) throw new Error(`Product ${productName} is not in the local store`);
    const ds = await this.ensureDataSource();
    const id = `${product.contentLanguage}~${product.feedLabel}~${product.offerId}`;
    try {
      await this.api.deleteProductInput(ds.name!, id);
    } catch (err) {
      if (!(err instanceof Error && 'status' in err && (err as { status: number }).status === 404)) throw err;
    }
    const metadata = this.products.savePushedAttributes(productName, {}, 'pushed');
    this.events.record('enrichment.cleared', `Removed enrichment attributes from ${product.offerId}`, { productName });
    return { productName, attributes: {}, metadata };
  }

  private async pushMerged(productName: string, merged: Record<string, unknown>): Promise<PushResult> {
    const product = this.products.getProduct(productName)!;
    const ds = await this.ensureDataSource();
    const { customAttributes, ...productAttributes } = merged;
    const input: ProductInput = {
      offerId: product.offerId,
      contentLanguage: product.contentLanguage ?? undefined,
      feedLabel: product.feedLabel ?? undefined,
      productAttributes,
      customAttributes: (customAttributes as CustomAttribute[] | undefined) ?? undefined,
    };
    try {
      await this.api.insertProductInput(ds.name!, input);
      const metadata = this.products.savePushedAttributes(productName, merged, 'pushed');
      this.events.record('enrichment.pushed', `Pushed ${Object.keys(merged).length} attribute(s) to ${product.offerId}`, {
        productName,
        payload: { attributes: merged },
      });
      return { productName, attributes: merged, metadata };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.products.savePushedAttributes(productName, merged, 'error', message);
      this.events.record('enrichment.failed', `Failed to push attributes to ${product.offerId}: ${message}`, { productName, severity: 'error' });
      throw err;
    }
  }
}
