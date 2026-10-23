import { loadConfig } from './config/index.js';
import { buildApp } from './app.js';
import { createServer } from './http/server.js';
import { createLogger } from './util/create-logger.js';
import { DEMO_LOGIN, bootstrapDemo, warmUpDemo } from './demo/demo-bootstrap.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV !== 'production');
  if (config.NODE_ENV === 'production') {
    if (config.SESSION_SECRET.startsWith('change-me')) logger.warn('SESSION_SECRET is the default value – set a long random secret in .env');
  }
  const ctx = buildApp(config, logger);
  if (config.DEMO_MODE) {
    const demo = bootstrapDemo(ctx);
    logger.info({ workflowsInstalled: demo.workflowsInstalled, settingsApplied: demo.settingsApplied, database: config.DATABASE_PATH }, 'Demo mode – synthetic data only');
  }
  const server = await createServer(ctx);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    try {
      await server.close();
      await ctx.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.listen({ host: config.HOST, port: config.PORT });
  await ctx.start();
  const url = `http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`;
  logger.info({ url, account: ctx.api.accountName, mock: ctx.settings.current().mock, configured: ctx.settings.isConfigured() }, 'GMC Manager started');
  if (config.DEMO_MODE) {
    const summary = await warmUpDemo(ctx);
    logger.info(summary, 'Demo data loaded');
    // eslint-disable-next-line no-console
    console.log(`\n  Product360 demo is ready:  ${url}\n  Login: ${config.ADMIN_USERNAME} / ${config.ADMIN_USERNAME === DEMO_LOGIN.username ? DEMO_LOGIN.password : '(ADMIN_PASSWORD)'}\n  Everything you see is synthetic – no Google account involved. Tour: docs/demo.md\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
