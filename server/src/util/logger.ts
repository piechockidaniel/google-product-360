import type { FastifyBaseLogger } from 'fastify';

/** The subset of pino's API we use; fastify's logger satisfies it. */
export type Logger = Pick<FastifyBaseLogger, 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'child'>;

/** A logger that prints nothing; handy for tests. */
export const silentLogger: Logger = {
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLogger as FastifyBaseLogger,
};
