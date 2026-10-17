import type { MerchantApi } from './merchant-api.js';

/** Thrown by every call while the Merchant Center connection has not been set up. */
export class NotConfiguredError extends Error {
  constructor() {
    super('Merchant Center connection is not configured – open the setup wizard');
    this.name = 'NotConfiguredError';
  }
}

/**
 * A MerchantApi implementation that rejects every call. Used until the setup
 * wizard has stored credentials.
 */
export function createNotConfiguredApi(): MerchantApi {
  return new Proxy({} as MerchantApi, {
    get(_target, prop) {
      if (prop === 'accountId') return '';
      if (prop === 'accountName') return 'accounts/unconfigured';
      if (prop === 'listProductPages') {
        return async function* () {
          throw new NotConfiguredError();
        };
      }
      if (prop === 'then') return undefined;
      return () => Promise.reject(new NotConfiguredError());
    },
  });
}

export interface SwitchableApi {
  /** Stable reference that services hold on to. */
  readonly api: MerchantApi;
  /** The implementation currently in use. */
  current(): MerchantApi;
  swap(next: MerchantApi): void;
}

/**
 * Wraps a MerchantApi so the underlying implementation can be replaced at
 * runtime (after the setup wizard stores new credentials) without re-creating
 * every service that depends on it.
 */
export function createSwitchableApi(initial: MerchantApi): SwitchableApi {
  let impl = initial;
  const api = new Proxy({} as MerchantApi, {
    get(_target, prop) {
      const value = Reflect.get(impl, prop) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(impl) : value;
    },
  });
  return {
    api,
    current: () => impl,
    swap: (next) => {
      impl = next;
    },
  };
}
