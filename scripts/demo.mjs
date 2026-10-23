#!/usr/bin/env node
/**
 * Starts the self-contained Product360 demo (synthetic data, no Google account).
 *
 *   npm run demo            # build (if needed) and start on http://localhost:8080
 *   npm run demo -- --reset # start from an empty demo database
 *   npm run demo -- --no-build # skip the build, reuse dist/
 *   PORT=9000 npm run demo  # any env var still applies
 *
 * The demo uses its own database (./data/demo.sqlite) and the login demo / demo1234.
 */
import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const args = process.argv.slice(2);

if (args.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = path.join(root, 'data', `demo.sqlite${suffix}`);
    if (existsSync(file)) rmSync(file);
  }
  console.log('Demo database removed – starting fresh.');
}

// Always build (≈10 s) so the demo reflects the current sources; `--no-build` reuses dist/.
if (!args.includes('--no-build') || !existsSync(path.join(root, 'dist', 'server', 'index.js')) || !existsSync(path.join(root, 'dist', 'client', 'index.html'))) {
  console.log('Building server + client …');
  const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

process.env.DEMO_MODE = 'true';
process.env.NODE_ENV ??= 'development';
process.env.LOG_LEVEL ??= 'info';
process.env.SESSION_SECRET ??= 'demo-only-session-secret-not-for-production';
process.env.PORT ??= '8080';
process.env.HOST ??= '127.0.0.1';

await import(pathToFileURL(path.join(root, 'dist', 'server', 'index.js')).href);
