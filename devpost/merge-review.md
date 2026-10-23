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

The small POC's `Quick Fix` worker removed a synthetic issue from a local demo
payload. It was not carried over as a live-looking action because that would
claim a Google-side result without calling the official remediation path. The
canonical app instead exposes:

- user-reviewed attribute pushes through a supplemental data source;
- bulk enrichment for selected products;
- workflow-triggered enrichment and feed actions; and
- durable events for successful and failed operations.

This is the safer foundation for a future predictable-remediation worker. That
worker should submit a supported `ProductInput` change, persist its operation
trace, reconcile the authoritative Merchant API snapshot, and only then mark a
product issue as resolved.

## Known specification gap

The approved POC documents define Google OAuth as the primary operator login
and protected server-side authorization for background work. The merged
runtime currently uses a local administrator session plus a server-side Google
service-account credential configured by the setup wizard. This is deliberate
for the current hackathon/demo slice and is clearly described in the runtime
documentation; OAuth-first authorization remains a follow-up implementation,
not a silently completed feature.

## Verification

- `npm run typecheck` passes.
- `npm test` passes: 15 files and 112 tests.
- `npm run build` passes; Vite reports only the existing bundle-size warning.
- `npm run test:e2e` starts the isolated demo server, but browser assertions
  require the local Playwright Chromium binary, which is not installed in this
  environment.
