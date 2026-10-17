import { existsSync, rmSync } from 'node:fs';
import { E2E_DB } from './playwright.config.js';

/** Fresh demo database for every run – the synthetic data is deterministic, so assertions are stable. */
export default function globalSetup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${E2E_DB}${suffix}`;
    if (existsSync(file)) rmSync(file);
  }
}
