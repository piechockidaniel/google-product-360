# Product360 merge review

Date: 2026-10-23

## Decision

`gmc-manager` is the canonical runtime and implementation. The skill-driven
Product360 workspace remains the destination because it contains the approved
scope, PRD, technical specification, and build checklist.

The merge keeps the broader implementation from `gmc-manager` and removes the
small duplicate demo server. The result is one TypeScript/Fastify/React/Vite
application with SQLite persistence, a synthetic demo mode, and the following
operator areas:

- Dashboard and Product360 recommendations
- Products, filters, issue history, product detail, and raw Google data
- Merchant Center issues and account issues
- Feeds and supplemental-data-source enrichment
- Market Insights and Search Console
- Visual workflows with manual, cron, and event triggers
- Activity and append-only event history
- Settings, setup checks, notifications, and bilingual UI

## What was preserved from the small POC

- The approved `devpost/` product documents and checklist
- A self-contained synthetic demo with no Google credentials
- SQLite-backed state rather than browser-only state
- Explicit issue detail, history, audit events, and background schedulers
- A Windows-safe demo runner
- Isolated per-run E2E database naming

## Intentional merge choices

The canonical runtime keeps the broader `gmc-manager` implementation and adds
the approved Product360 behavior without retaining a second demo server. The
current application exposes:

- Google OAuth-first operator login with a local/demo fallback only where explicitly enabled;
- user-reviewed attribute pushes through a supplemental data source;
- a deterministic `generic_title` Quick Fix that submits a `ProductInput`, persists its operation trace, and reconciles the product snapshot;
- bulk enrichment and workflow-triggered enrichment/feed actions; and
- durable events for successful, failed, and still-processing operations.

Demo mode exercises the same flow with synthetic data and labels that mode
clearly; it does not claim that Google was contacted.

## Cleanup audit

The post-merge cleanup checked all client and server source files from the
application and its supported entrypoints. Every source file is reachable from
the server, client, CLI, demo, or E2E entrypoint. Deployment alternatives,
documentation, tests, and `server/src/cli/add-user.ts` are retained because
they are referenced by scripts or provide supported operational paths. No
unreferenced application file was removed.

## Verification

- `npm run typecheck` passes.
- `npm test` passes: 16 files and 113 tests.
- `npm run build` passes; Vite reports only the existing bundle-size warning.
- `npm run test:e2e` starts the isolated demo server, but browser assertions
  require the local Playwright Chromium binary, which is not installed in this
  environment.
