import type { TokenProvider } from './auth.js';
import type { Logger } from '../util/logger.js';

export class MerchantApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly googleStatus?: string,
    public readonly details?: unknown,
    public readonly method?: string,
    public readonly url?: string,
  ) {
    super(message);
    this.name = 'MerchantApiError';
  }

  /** Parsed `Retry-After` header (ms), when Google sent one. */
  retryAfterMs?: number;

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Per-request override of the retry count. */
  retries?: number;
}

export interface RestClientOptions {
  baseUrl: string;
  tokenProvider: TokenProvider;
  logger: Logger;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. */
  retryDelayMs?: number;
}

/**
 * Minimal authenticated JSON client for https://merchantapi.googleapis.com.
 *
 * - Adds the bearer token
 * - Retries on 429 / 5xx / network errors with exponential backoff
 * - Converts Google error envelopes into MerchantApiError
 */
export class RestClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  /** Shared "do not send before" timestamp set by 429 responses (rate limiting applies to the whole account). */
  private cooldownUntil = 0;
  /** Number of 429s received, for diagnostics. */
  rateLimitHits = 0;

  constructor(private readonly options: RestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  patch<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PATCH', path, options);
  }

  put<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PUT', path, options);
  }

  delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const retries = options.retries ?? this.maxRetries;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      await this.waitForCooldown();
      try {
        return await this.send<T>(method, url, options.body);
      } catch (err) {
        const rateLimited = err instanceof MerchantApiError && err.status === 429;
        const retryable = err instanceof MerchantApiError ? rateLimited || err.status >= 500 : err instanceof TypeError; // network
        // Rate limits get a few extra attempts: with parallel workers every in-flight request hits the same limit.
        const maxAttempts = rateLimited ? Math.max(retries, 5) : retries;
        if (!retryable || attempt > maxAttempts) throw err;
        let delay = this.retryDelayMs * 2 ** (attempt - 1) + Math.random() * 100;
        if (rateLimited) {
          this.rateLimitHits += 1;
          delay = Math.max(delay, (err as MerchantApiError).retryAfterMs ?? 0, 1000);
          // Pause *all* workers, not just this request.
          this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay);
        }
        this.options.logger.warn({ method, url, attempt, delay, err: (err as Error).message }, 'Merchant API request failed, retrying');
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async waitForCooldown(): Promise<void> {
    const wait = this.cooldownUntil - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}/${path.replace(/^\/+/, '')}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async send<T>(method: string, url: string, body: unknown): Promise<T> {
    const token = await this.options.tokenProvider.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    this.options.logger.debug({ method, url }, 'Merchant API request');
    const response = await this.fetchImpl(url, { method, headers, body: payload });
    const text = await response.text();

    if (!response.ok) {
      let googleStatus: string | undefined;
      let message = `${method} ${url} failed with HTTP ${response.status}`;
      let details: unknown;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; status?: string; details?: unknown } };
        if (parsed.error) {
          message = parsed.error.message ?? message;
          googleStatus = parsed.error.status;
          details = parsed.error.details;
        }
      } catch {
        details = text;
      }
      const error = new MerchantApiError(message, response.status, googleStatus, details, method, url);
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        error.retryAfterMs = Number.isNaN(seconds) ? Math.max(0, new Date(retryAfter).getTime() - Date.now()) : seconds * 1000;
      }
      throw error;
    }

    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }
}

/**
 * Iterates over all pages of a Google list API. `fetchPage` receives the page
 * token and must return the raw response; `pick` extracts the items.
 */
export async function* paginate<TResponse extends { nextPageToken?: string }, TItem>(
  fetchPage: (pageToken?: string) => Promise<TResponse>,
  pick: (response: TResponse) => TItem[] | undefined,
): AsyncGenerator<TItem[], void, undefined> {
  let pageToken: string | undefined;
  do {
    const response = await fetchPage(pageToken);
    yield pick(response) ?? [];
    pageToken = response.nextPageToken || undefined;
  } while (pageToken);
}

export async function collectAll<TResponse extends { nextPageToken?: string }, TItem>(
  fetchPage: (pageToken?: string) => Promise<TResponse>,
  pick: (response: TResponse) => TItem[] | undefined,
): Promise<TItem[]> {
  const items: TItem[] = [];
  for await (const page of paginate(fetchPage, pick)) items.push(...page);
  return items;
}
