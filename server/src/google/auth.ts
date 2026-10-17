import fs from 'node:fs';
import { JWT } from 'google-auth-library';
import type { AppConfig } from '../config/index.js';

export const MERCHANT_SCOPE = 'https://www.googleapis.com/auth/content';
export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

/**
 * Service-account based token provider. The service account e-mail has to be
 * added as a user (Admin or Standard) to the Merchant Center account.
 */
export class ServiceAccountTokenProvider implements TokenProvider {
  private readonly client: JWT;

  /** Access tokens are scope-specific, so every Google API gets its own provider (same key). */
  constructor(key: ServiceAccountKey, scopes: string[] = [MERCHANT_SCOPE]) {
    this.client = new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes,
    });
  }

  static fromJson(raw: string, scopes: string[] = [MERCHANT_SCOPE]): ServiceAccountTokenProvider {
    const key = JSON.parse(raw) as Partial<ServiceAccountKey>;
    if (!key.client_email || !key.private_key) {
      throw new Error('Service account key is missing client_email / private_key');
    }
    return new ServiceAccountTokenProvider(key as ServiceAccountKey, scopes);
  }

  static fromConfig(config: AppConfig): ServiceAccountTokenProvider {
    let raw: string;
    if (config.GOOGLE_SERVICE_ACCOUNT_JSON) {
      raw = config.GOOGLE_SERVICE_ACCOUNT_JSON;
    } else {
      if (!fs.existsSync(config.GOOGLE_SERVICE_ACCOUNT_KEY_PATH)) {
        throw new Error(
          `Service account key not found at ${config.GOOGLE_SERVICE_ACCOUNT_KEY_PATH}. ` +
            'Set GOOGLE_SERVICE_ACCOUNT_KEY_PATH / GOOGLE_SERVICE_ACCOUNT_JSON or enable MERCHANT_MOCK.',
        );
      }
      raw = fs.readFileSync(config.GOOGLE_SERVICE_ACCOUNT_KEY_PATH, 'utf8');
    }
    const key = JSON.parse(raw) as Partial<ServiceAccountKey>;
    if (!key.client_email || !key.private_key) {
      throw new Error('Service account key is missing client_email / private_key');
    }
    return new ServiceAccountTokenProvider(key as ServiceAccountKey);
  }

  async getAccessToken(): Promise<string> {
    // google-auth-library caches the token and refreshes it shortly before expiry.
    const { token } = await this.client.getAccessToken();
    if (!token) throw new Error('Failed to obtain Google access token');
    return token;
  }
}
