import Fastify from 'fastify';
import type { Logger } from './logger.js';

/**
 * Creates a pino logger through fastify so the server and the services share
 * the same configuration. `pretty` enables human friendly output in development
 * (requires the optional `pino-pretty` package; falls back to JSON if missing).
 */
export function createLogger(level: string, pretty: boolean): Logger {
  let transport: { target: string; options?: Record<string, unknown> } | undefined;
  if (pretty) {
    try {
      import.meta.resolve('pino-pretty');
      transport = { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } };
    } catch {
      transport = undefined;
    }
  }
  const tmp = Fastify({ logger: { level, ...(transport ? { transport } : {}) } });
  return tmp.log;
}
