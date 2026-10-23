import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { MockMerchantApi } from '../src/mock/mock-merchant-api.js';
import { silentLogger } from '../src/util/logger.js';

export function testContext(overrides: Record<string, string> = {}): { ctx: AppContext; mock: MockMerchantApi } {
  const config = loadConfig({
    NODE_ENV: 'test',
    MERCHANT_MOCK: 'true',
    DATABASE_PATH: ':memory:',
    ADMIN_PASSWORD: 'admin12345',
    SESSION_SECRET: 'test-secret-test-secret-test',
    SYNC_INTERVAL_MINUTES: '0',
    SYNC_ON_STARTUP: 'false',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
  const mock = new MockMerchantApi({ productCount: 30, seed: 7 });
  const ctx = buildApp(config, silentLogger, { api: mock });
  return { ctx, mock };
}
