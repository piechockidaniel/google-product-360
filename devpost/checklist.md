---
doc: checklist
status: approved
---

# Build Checklist

Build mode: fast

## Slices

- [x] **1. A clearly labelled Demo mode shows the Product360 grid**
  Becomes usable: The app starts as a single full-stack service, opens in Demo mode, and shows synthetic products in the agreed grid with the core status and issue columns.
  Why now: Proves the project bootstrap and first visible end-to-end behavior before Google credentials or live API state add complexity.
  PRD ref: `prd.md > The Core Journey`, `prd.md > Product grid`, `prd.md > States and Boundaries`
  Spec ref: `spec.md > Stack`, `spec.md > Where It Runs and How Someone Tries It`, `spec.md > Client application shell`, `spec.md > Demo provider`, `spec.md > File Structure`
  Build: Scaffold the TypeScript workspace, Fastify server, React/Vite client, shared types, scripts, and one service boundary; add Demo mode fixtures and render checkbox, thumbnail, ID, title, supplier, feed, price, availability, status, issue summary, and actions; label synthetic data as Demo.
  Verify (mechanical): `npm run typecheck` and `npm run build` pass; the built service returns `200` for `/healthz`, `/api/products`, and `/`; the API returns four Demo products and the served HTML references the bundled client asset.
  Learner check: Fast-mode visual checkpoint is carried into the Slice 2 hands-on exploration.
  Commit: `Add runnable Product360 demo grid`

- [x] **2. A product issue can be understood and traced through a Demo Quick Fix**
  Becomes usable: A user can open a product issue, see its source, evidence, consequence, and remediation classification, approve one predictable Demo Quick Fix, watch its short-lived UI state, and inspect the completed read-only operation trace.
  Why now: Delivers the unique kernel early: explainable issue handling with explicit responsibility and an auditable operation path.
  PRD ref: `prd.md > Detailed product pane`, `prd.md > Product issues and predictable remediation`, `prd.md > Complex issues and user decisions`, `prd.md > Background operations and audit history`
  Spec ref: `spec.md > Issue normalizer and analyzer`, `spec.md > Operation worker`, `spec.md > Read-only trace viewer`, `spec.md > Data Model`
  Build: Add SQLite persistence for products, issues, operations, and operation events; implement account-level versus product-level issue display; classify deterministic predictable issues separately from review-required issues; add the explicit approval dialog, Demo Quick Fix execution, background status, 30-second monitoring window, pending state, and trace viewer.
  Verify (mechanical): `npm run typecheck` and `npm run build` pass; a real SQLite-backed Demo operation transitions queued → running → succeeded, clears the issue, records three trace events, and remains succeeded with its trace after a server restart.
  Learner check: Open both a predictable and a complex issue, approve only the predictable fix, and say whether the consequences and responsibility boundary are clear.
  Commit: `Add explainable demo remediation and audit trace`

- [ ] **3. Approved corrections become reusable patterns and feeds can be imported**
  Becomes usable: A user can save an approved correction as a persistent pattern, enable or disable it, apply it to matching rows, and import an uncompressed `.txt`, `.tsv`, or `.xml` feed without replacing the original source.
  Why now: Makes the demonstrated fix useful beyond one row while keeping source data and remediation decisions separate.
  PRD ref: `prd.md > Background operations and audit history`, `prd.md > Product Decisions`, `prd.md > Deferred From the POC`
  Spec ref: `spec.md > Pattern service`, `spec.md > Feed importer`, `spec.md > Data Model`, `spec.md > Important Failure Modes`
  Build: Add persistent pattern records and matching evidence; require approval before activation; expose pattern state in the read-only UI; preserve the original feed artifact; parse the supported first-pass formats and show clear validation errors; keep compressed formats deferred.
  Verify (mechanical): Test pattern enable/disable and matching determinism; import valid and invalid `.txt`, `.tsv`, and `.xml` fixtures; confirm original feed content remains unchanged and all imports are traced.
  Learner check: Approve one pattern, apply it to matching Demo rows, disable it, and confirm the next matching run no longer applies it automatically.
  Commit: `Add persistent remediation patterns and feed import`

- [ ] **4. Google OAuth setup verifies readiness without storing secrets in the browser**
  Becomes usable: A user can sign in with Google, complete the in-app setup gate, and see precise readiness results for the required Google services before any live sync begins.
  Why now: Resolves the highest-risk live integration boundary while the Demo journey remains available as a fallback.
  PRD ref: `prd.md > Google sign-in`, `prd.md > Setup wizard`, `prd.md > Authentication and setup gate`, `prd.md > Product Decisions`
  Spec ref: `spec.md > OAuth and session routes`, `spec.md > Setup readiness service`, `spec.md > External Services and Dependencies`, `spec.md > Important Failure Modes`
  Build: Add server-side OAuth authorization-code flow with PKCE as applicable, encrypted refresh-token storage using `APP_ENCRYPTION_KEY`, opaque HttpOnly Secure SameSite session cookies, setup progress checks, exact failure explanations, and a Demo/live mode boundary; do not accept or persist service-account JSON in the app.
  Verify (mechanical): Run security-oriented tests for cookie flags, token encryption/decryption, missing-key failure, and setup-state transitions; confirm no token or key appears in client responses, logs, or tracked files.
  Learner check: Walk through the setup wizard with Demo mode and inspect each readiness explanation; if live credentials are unavailable, review the explicit blocked state rather than bypassing it.
  Commit: `Add secure Google OAuth setup gate`

- [ ] **5. Live sync loads Merchant Center products and account/product issues atomically**
  Becomes usable: After readiness succeeds, the app can synchronize the selected Merchant Center account through the official Node client adapter and show live products, account issues, product status, and item-level issues in the same grid and detail experience.
  Why now: Connects the proven issue workflow to the real Merchant Center read APIs while preserving the no-partial-sync boundary.
  PRD ref: `prd.md > Synchronization and initial state`, `prd.md > Product grid`, `prd.md > States and Boundaries`, `prd.md > Non-Goals`
  Spec ref: `spec.md > Google Merchant adapter`, `spec.md > Synchronization worker`, `spec.md > External Services and Dependencies`, `spec.md > Data Model`
  Build: Implement the official Merchant API adapter for account discovery/readiness, product reads, account-level issues, and item-level product issues; normalize pagination and errors; stage a sync and publish it only after all required steps succeed; retain the last successful snapshot and record sync events.
  Verify (mechanical): Run adapter contract tests with fixtures, pagination/error tests, and an atomicity test that proves a failed sync does not publish partial state; when authorized live credentials are available, run a read-only smoke sync and compare the displayed IDs with the API response.
  Learner check: Compare a live or fixture-backed product detail pane with the source issue fields and confirm the app distinguishes account blockers from product-specific issues.
  Commit: `Add atomic live Merchant Center synchronization`

- [ ] **6. A reviewed Quick Fix can update the supplemental data source in live mode**
  Becomes usable: For a supported predictable issue, the user can approve a correction, the app writes through the dedicated supplemental API data source, tracks the background operation independently of the browser, reconciles the result, and reports success, processing, or failure with a complete trace.
  Why now: Completes the safe live remediation loop without mutating the original file-based feed and keeps Google-side limitations visible.
  PRD ref: `prd.md > Product issues and predictable remediation`, `prd.md > Complex issues and user decisions`, `prd.md > Background operations and audit history`, `prd.md > Product Decisions`
  Spec ref: `spec.md > Operation worker`, `spec.md > Pattern service`, `spec.md > External Services and Dependencies`, `spec.md > Important Failure Modes`
  Build: Add supplemental data source discovery and user-approved creation when absent; map only supported corrections to ProductInput updates; run them as durable background operations; poll or reconcile according to the official API behavior; unlock the UI on terminal result while preserving pending state after disconnect; never claim success before a confirmed API result.
  Verify (mechanical): Run write-mapping, approval-gate, retry/idempotency, timeout, reconnect, and trace tests; with authorized live access, perform one narrow correction and verify the resulting API state and audit record.
  Learner check: Approve one supported fix, close and reopen the app while it is pending, then inspect the final trace and confirm the original feed remains untouched.
  Commit: `Add audited supplemental-source remediation`

## Hands-on Checkpoints

- [ ] Early usable behavior explored — after Slice 2, including the grid, issue pane, Demo Quick Fix, and trace
- [ ] Final kick-the-tires exploration and feedback completed

## Final Review

- [ ] Final review complete — feedback resolved and learner confirms ready to ship

## Code Tour and App Map

- [ ] Learning activity complete — guided route, focused alternative, prior practice connected, or brief recap
- [ ] Optional edit and transfer reflection addressed — offered/declined/already covered/not applicable as appropriate
- [ ] `devpost/app-map.html` generated from finished code, checked, and shown, including a project-grounded practice to reuse

Activity and evidence: [record actual tests, app behavior, code references, and unfinished work]
Route and stops: [record actual paths and symbols; guided stops completed, or reference-only route]
Edit outcome: [tried/kept/reverted/declined/not applicable; verification if changed]
Reflection: [offered/answered/declined/already covered — personal answer belongs only in the ignored profile]
Activity mode: [live app and editor, explicit static fallback, focused alternative, prior practice, or recap]

## Revisions

