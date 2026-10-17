/**
 * pm2 process file – `pm2 startOrReload deploy/ecosystem.config.cjs --update-env && pm2 save`
 *
 * Two apps: the production instance (reads .env) and an optional demo on another port
 * (`pm2 start deploy/ecosystem.config.cjs --only gmc-manager-demo`).
 */
const path = require('node:path');
const root = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'gmc-manager',
      cwd: root,
      script: 'dist/server/index.js',
      // .env is loaded by Node itself (same as `npm start`); pm2 adds nothing on top.
      node_args: '--disable-warning=ExperimentalWarning --env-file-if-exists=.env',
      instances: 1, // SQLite: exactly one process
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
      out_file: path.join(root, 'data', 'logs', 'gmc-manager.out.log'),
      error_file: path.join(root, 'data', 'logs', 'gmc-manager.err.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'gmc-manager-demo',
      cwd: root,
      script: 'dist/server/index.js',
      node_args: '--disable-warning=ExperimentalWarning',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        DEMO_MODE: 'true',
        PORT: process.env.DEMO_PORT || '8090',
        HOST: '127.0.0.1',
        DATABASE_PATH: path.join(root, 'data', 'demo.sqlite'),
        SESSION_SECRET: 'demo-only-session-secret-not-for-production',
      },
      out_file: path.join(root, 'data', 'logs', 'gmc-manager-demo.out.log'),
      error_file: path.join(root, 'data', 'logs', 'gmc-manager-demo.err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
