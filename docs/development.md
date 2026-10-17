# GMC Manager · Product360 – developer guide

Architecture, conventions and reference material for people changing the code. Running an
instance is described in [operations.md](operations.md), the screens in the
[user guide](user-guide.md), the Product360 design history and roadmap in
[product360-plan.md](product360-plan.md).

---

## 1. Stack & principles

* **Server**: Node 22, TypeScript (ESM, `NodeNext`), Fastify 5, zod, `node:sqlite` (built in –
  no native modules), croner for cron, google-auth-library for service-account tokens. One
  process, one SQLite database.
* **Client**: React 19, Vite, react-router, @dnd-kit (visual workflow builder). No UI framework,
  no chart library – small hand-written components and SVG charts. Built into `dist/client` and
  served by Fastify.
* **Principles**
  1. *Local snapshot first.* Everything Google-side is pulled into SQLite; UI and workflow engine
     read local tables only. Google is slow, lagged and rate-limited – the app must stay usable.
  2. *Typed facades over thin REST.* One `RestClient` (auth, retries, shared 429 cool-down,
     pagination) and one typed facade per Google API (`MerchantApi`, `SearchConsoleApi`). Every
     endpoint path lives in one file per API.
  3. *Mocks are first-class.* Each facade has an in-memory implementation with deterministic
     synthetic data; the whole test suite and the demo run against them.
  4. *Settings are runtime.* The wizard / Settings page write to the `settings` table; `.env` only
     provides defaults. Services receive `() => value` getters, so changes apply without restart.
  5. *Server emits codes, client translates.* Flags, hints, signal reasons, block names are
     codes + params; `client/src/lib/locales/{en,pl}.ts` carry the texts (TypeScript enforces that
     both have the same keys).

---

## 2. Project layout

```
server/src
  index.ts             process entry: config → buildApp → createServer → start (demo warm-up)
  app.ts               dependency wiring (AppContext) + reactions to settings changes
  config/              environment schema (zod)
  db/                  Database wrapper (statement cache, transactions) + migrations
  google/              auth (service account, per-API scopes), rest-client, merchant-api, search-console-api, types
  mock/                MockMerchantApi, synthetic reports (mock-reports), MockSearchConsoleApi
  connectors/          Product360 metric sources: Connector interface, merchant-reports, search-console
  services/            product-store, sync-service, enrichment-service, feed-service, account-service,
                       notification-service, auth-service, settings-service, event-log, attribute-catalog,
                       metrics-store, metrics-sync-service, signals-service, product360-service
  workflows/           schema (zod), conditions, engine, scheduler, templates, workflow-store
  jobs/                sync-scheduler (interval), metrics-scheduler (cron)
  http/                server.ts (Fastify, sessions, error mapping) + routes/*
  demo/                DEMO_MODE bootstrap + warm-up
  util/                dates, urls, pool (bounded parallelism), logger
server/test            vitest suite
e2e/                   Playwright smoke tests against the demo (playwright.config.ts, smoke.spec.ts)
client/src
  App.tsx              routes + sidebar
  pages/               Dashboard, Products, ProductDetail, Issues, Market, Feeds, Workflows, WorkflowEditor, Activity, Settings, SetupWizard, Login
  components/          ui (badges, cards, modal, toasts), charts (SVG), signals, Product360Panel, MetricsSettingsCard,
                       DemoTour, FlowCanvas + StepForms + AttributeForm (workflow builder)
  lib/                 api, auth, hooks, format, i18n + locales, types (mirror of server models), workflow-blocks
deploy/                deploy.sh, publish.sh, ecosystem.config.cjs (pm2), gmc-manager.service, Caddyfile, nginx.conf
scripts/               demo.mjs
docs/                  this documentation
```

---

## 3. Runtime architecture

```
                 ┌──────────── Google ────────────┐
                 │ Merchant API v1  Search Console │
                 └───────▲───────────────▲─────────┘
   ServiceAccountTokenProvider (scope per API)   RestClient (retry, 429 cool-down, paging)
                 MerchantApi facade        SearchConsoleApi facade
                         │                          │
  SyncService ───────────┤   MerchantReportsConnector │ SearchConsoleConnector
  (products, issues)     │            └──── MetricsSyncService ────┘  (windows, run log, pruning)
        │                │                        │
   ProductStore      EnrichmentService        MetricsStore ──► SignalsService (scores, recommendation)
   (snapshot,        (supplemental source,        │                     │
    issues, metadata) pushes)                     └──── Product360Service (read model) ◄──┘
        │                                                          │
   EventLog (persistent + in-process bus) ◄── everything records events; WorkflowScheduler listens
        │
   WorkflowEngine (steps over ProductContext) ──► EnrichmentService / ProductStore / webhooks
        │
   Fastify routes ──► React client
```

**Schedulers**: `SyncScheduler` (interval, products + issues), `MetricsScheduler` (cron, nightly
metrics; runs once on start when nothing has been loaded), `WorkflowScheduler` (cron jobs +
event listeners with debounce). Settings changes reconfigure them live (`settings.onChange` in
`app.ts`).

**Events** (`EventLog.record`) are both the activity trail and the bus: `sync.completed`,
`issue.new/resolved`, `product.status_changed/deleted`, `account_issue.new/resolved`,
`notification.received`, `workflow.*`, `metrics.synced/failed`, `signal.changed`, `demo.bootstrapped`,
`settings.connection_changed`. Workflow triggers subscribe to the subset listed in
`WORKFLOW_TRIGGER_EVENTS`.

---

## 4. Data model (SQLite)

Migrations are plain SQL in `server/src/db/migrations.ts`, applied in order on start
(`schema_migrations` table). They are additive only.

| Table | Purpose |
|-------|---------|
| `users`, `sessions`, `settings` | auth, cookie sessions, runtime settings (`merchant.*` keys; secrets encrypted `enc:v1:`), connector state (`connector.<id>.*`) |
| `products` | snapshot of every product: id fields, denormalised columns (title, brand, price, availability, status, category …) + `raw_json`, first/last seen, `deleted_at` |
| `product_issues` | one row per (product, issue fingerprint) with first/last seen and `resolved_at` |
| `account_issues` | same for account-level issues |
| `product_metadata` | local tags / notes / fields + pushed attributes and push status |
| `workflows`, `workflow_runs` | definitions (JSON trigger + steps) and step-by-step run logs |
| `sync_runs`, `events` | sync statistics, activity trail / event payloads |
| `mc_product_performance_daily` | Merchant Center performance per product / day / marketing method / country (sparse: non-zero rows only) |
| `mc_price_benchmark_daily` | price competitiveness + price insights snapshots |
| `mc_best_sellers` | weekly / monthly best-seller clusters, matched `product_name` when a GTIN matches |
| `mc_competitive_visibility_daily` | competitor visibility per category / country / traffic source / domain |
| `product_url_map` | product → canonical landing-page URL (Search Console join key), `shared_url` flag |
| `sc_page_daily` | Search Console page metrics per URL / day / appearance (`ALL`, `MERCHANT_LISTINGS`) |
| `sc_page_queries` | cached top queries per URL (28-day window) |
| `product_signals` | rolled-up inputs (7d / 28d, organic), scores JSON, recommendation, previous recommendation, reasons JSON |
| `metrics_sync_runs` | run log per connector with window and stats |

Identifiers: `products.name` = `accounts/{a}/products/{lang}~{label}~{offerId}`;
`product_id` = unpadded base64url of `{lang}~{label}~{offerId}` (used in URLs; the Merchant API
accepts it too).

---

## 5. HTTP API

All under `/api`, cookie session (`gmc_session`), JSON. Validation with zod → `400` with
`details[]`; `401` without session; `409` `not_configured` while no connection exists;
Google errors are passed through as `Merchant API: …` with Google's status.

| Area | Endpoints |
|------|-----------|
| Auth | `POST auth/login` (throttled), `POST auth/logout`, `GET auth/me`, `POST auth/acknowledge`, `POST auth/password` |
| Setup | `GET setup/status` (public), `POST setup/admin` (first user only), `GET/PUT setup/config`, `POST setup/inspect-key`, `POST setup/test-connection`, `POST setup/register-gcp`, `POST setup/generate-secret`, `POST setup/complete` |
| Dashboard | `GET dashboard` (flags, stats, feeds, since-last-login, `insights` = Product360 block) |
| Products | `GET products` (filters incl. `recommendation`, `category`; `orderBy` incl. `clicks7d`, `impressions7d`, `demand`, `priceVsBenchmark`, `organicImpressions28d`, `organicPosition`), `GET products/facets`, `GET products/:id`, `GET products/:id/360?days=`, `GET products/:id/search-queries?refresh=`, `POST products/:id/refresh`, `GET products/:id/rendered-issues`, `GET products/:id/history`, `PUT products/:id/metadata`, `POST/DELETE products/:id/attributes`, `POST products/bulk` |
| Issues | `GET issues?since=lastLogin&level=…`, `GET issues/summary`, `GET issues/account`, `GET issues/account/rendered` |
| Feeds | `GET/POST feeds`, `GET/PATCH/DELETE feeds/:id`, `POST feeds/:id/fetch`, `GET feeds/:id/latest-upload`, `GET feeds/enrichment/status`, `POST feeds/enrichment/ensure` |
| Workflows | `GET/POST workflows`, `GET workflows/catalog` (steps, operators, fields, events, recommendations, templates), `POST workflows/validate`, `POST workflows/preview`, `GET/PUT/DELETE workflows/:id`, `POST workflows/:id/run?wait=true`, `GET workflows/:id/runs`, `GET workflow-runs`, `GET workflow-runs/:id` |
| Product360 | `GET metrics/status`, `POST metrics/sync?wait=true&connector=&backfill=`, `POST metrics/recompute`, `POST metrics/connectors/:id/test`, `GET metrics/connectors/search_console/sites`, `GET metrics/connectors/search_console/mapping`, `GET market/best-sellers?country&category&carried&demandChange&granularity`, `GET market/competitors?country&categoryId&trafficSource&days`, `GET market/overview` |
| Account | `GET account`, `GET account/shipping-settings`, `GET/POST account/return-policies`, `PUT/DELETE account/return-policies/:id` |
| Notifications | `GET/POST notifications/subscriptions`, `DELETE notifications/subscriptions/:id`, `POST notifications/simulate`, public `POST webhooks/merchant/:secret` |
| System | `POST sync?wait=true`, `GET sync/status`, `GET events`, `GET settings`, `GET settings/quota`, `POST settings/users`, `DELETE settings/users/:id`, mock only: `POST dev/mock/simulate-changes`, `POST dev/mock/simulate-day` |
| Health | `GET /healthz` (no `/api` prefix, public) |

---

## 6. Workflow definition reference

```jsonc
{
  "name": "Label products with missing GTIN",
  "description": "",
  "enabled": true,
  "trigger": { "type": "schedule", "cron": "0 6 * * *", "timezone": "Europe/Warsaw" },
  "steps": [
    { "type": "select_products", "filter": { "hasIssues": true } },
    { "type": "filter", "condition": { "field": "issueCodes", "op": "contains", "value": "missing_gtin" } },
    { "type": "stop_if_empty" },
    { "type": "set_attributes", "attributes": { "customLabel4": "missing-gtin", "customLabel3": "{{brand}}" } },
    { "type": "webhook", "url": "https://hooks.example.com/...", "message": "{{count}} products labelled" }
  ]
}
```

Schema: `server/src/workflows/schema.ts` (zod, the single source of truth; the UI palette
`client/src/lib/workflow-blocks.ts` and forms `StepForms.tsx` mirror it).

**Triggers**

| type | fields |
|------|--------|
| `manual` | – |
| `schedule` | `cron` (5/6 fields), `timezone?` |
| `event` | `event` ∈ `sync.completed · issue.new · issue.resolved · product.status_changed · notification.received · metrics.synced · signal.changed`, `debounceSeconds` (0–3600, default 30) |

**Steps**

| type | fields |
|------|--------|
| `select_products` | `filter`: `q, status[], severity[], issueCode, tag, feedLabel, dataSource, brand, availability, hasIssues, category, recommendation[], limit` |
| `select_by_signal` | `recommendation[]` (required), `minDemand?` 0–100, `minImpressions7d?`, `category?`, `limit?` |
| `select_event_products` | `levels?[]`, `issueCodes?[]` |
| `filter` | `condition` (see below) |
| `limit` | `max` |
| `stop_if_empty` | – |
| `set_attributes` | `attributes` (record; `null` removes), `customAttributes?[]`, `continueOnError` (default true) |
| `set_sale_price` | `price` (`"89.99"`, `"-15%"`, template), `currency?` (3 letters, default product currency), `from` (default `now`), `to` – ISO date/time or relative `now`, `±Nh`, `±Nd`, `±Nw`; pushes `salePrice` + `salePriceEffectiveDate {startTime,endTime}` |
| `clear_attributes` | `continueOnError` |
| `add_tags`, `remove_tags` | `tags[]` |
| `set_note` | `note`, `mode` `append|replace` |
| `refresh_products` | `continueOnError` |
| `fetch_feed` | `dataSourceId` |
| `sync` | – |
| `webhook` | `url`, `method` `POST|PUT`, `headers?`, `message?`, `includeProducts` (true), `skipIfEmpty` (true) |
| `log` | `message`, `severity` |

**Conditions** – `{ field, op, value? }` or `{ all: [...] }`, `{ any: [...] }`, `{ not: ... }`.
Operators: `eq neq contains not_contains in not_in exists not_exists regex gt gte lt lte
starts_with ends_with is_empty is_not_empty`. Fields resolve dotted paths on the
`ProductContext` (arrays map: `issues.level` → list of levels):

```
offerId title brand link feedLabel contentLanguage availability dataSource price.amount price.currency
status issueCount maxSeverity issueCodes issues.{code,level,severity,attribute,reportingContext,countries}
attributes.<apiName> customAttributes.<name> tags notes fields.<key> pushed.<attribute>
signals.{recommendation,previousRecommendation,scores.{demand,visibility,price,health,efficiency},reasons}
metrics.{impressions7d,clicks7d,clicksPrev7d,clicksChangePct,impressions28d,clicks28d,ctr28d,conversions28d,
         scImpressions28d,scClicks28d,scPosition28d,scImpressionsChangePct}
market.{priceVsBenchmark,effectiveness,demand,demandChange,bestSellerRank}
```

**Templates** in string values: `{{offerId}}`, `{{title}}`, `{{attributes.brand}}`,
`{{signals.recommendation}}`, `{{metrics.scPosition28d}}`, `{{count}}`, `{{date}}`, `{{now}}`,
`{{workflow.name}}`.

**Engine semantics**: per-product API actions run with bounded parallelism (`apiConcurrency`,
default 8) – there is no batch endpoint for products in Merchant API v1; `continueOnError=false`
aborts on the first failure; runs of the same workflow are coalesced; event-triggered runs skip
events produced by the workflow itself; the preview executes only selection/filter steps.

---

## 7. Product360 internals

### 7.1 Connectors

```ts
interface Connector {
  id: 'merchant_reports' | 'search_console' | 'google_ads';
  maxBackfillDays: number;      // first pull
  revisionWindowDays: number;   // trailing days re-pulled every night (Google revises recent data)
  lagDays: number;              // newest complete day = today − lagDays
  isConfigured(): boolean;
  testConnection(): Promise<ConnectionCheck>;                // capabilities[] + hint code
  sync(window, log): Promise<{ stats, gauges?, warnings }>;  // idempotent upserts
}
```

`MetricsSyncService` computes the window per connector (full backfill when it never succeeded,
otherwise `lastWindowTo − revisionWindow … today − lag`), pulls it in 31-day chunks, sums
`stats` and overwrites `gauges` across chunks, writes `metrics_sync_runs`, prunes by retention,
recomputes signals and emits `metrics.synced` / `metrics.failed`. A connector failure never
affects the others.

* **merchant-reports** – Merchant Center Query Language over `MerchantApi.searchReport`. Builders
  in `MCQL`; views: `product_performance_view` (always), `price_competitiveness_product_view`,
  `price_insights_product_view`, `best_sellers_product_cluster_view` (one query per ISO week),
  `competitive_visibility_competitor_view` (one query per (country, category) derived from the
  carried best sellers, max 20). Market Insights views that return 400/403/404 are remembered as
  unavailable in `connector.merchant_reports.unavailableViews` and skipped until *Test connection*
  finds them working again. Offer ids resolve to products via `ProductStore.offerIndex()`
  (prefers the product whose feed label equals the report country); best sellers match via
  `gtinIndex()`.
* **search-console** – `SearchConsoleApi` (`sites`, `searchAnalytics/query` with `startRow`
  paging, site URL percent-encoded as one segment). One `dimensions:[page]` query per day (plus one
  with a `searchAppearance=MERCHANT_LISTINGS` filter when enabled), optional `country` filter.
  Pages are canonicalised (`util/urls.ts`) and stored per URL; `product_url_map` (rebuilt each run
  from `product.link`) joins them to products, shared URLs attribute to every variant. Top queries
  per page are fetched live (`queriesForProduct`) and cached 24 h.

Adding a connector: implement the interface, register it in `app.ts`
(`metricsSync.register(...)`), add settings keys to `settings-service.ts`, a mock in `mock/`, a
row in the settings card (`MetricsSettingsCard.tsx`, translations `p360.connectorName.<id>`) and
tests. Signals can read new columns through `MetricsStore`.

### 7.2 Signals

`SignalsService.recompute()` (after every metrics pull, product sync and threshold change):

1. window end = last day with performance data (not "today" – a lagging report must not look
   like a collapse); windows `w7`, `p7` (previous 7), `w28`; organic `w28` / `p28`;
2. peer group = same `products.category` when ≥ 5 products, otherwise the whole catalogue;
   percentiles of impressions and CTR inside the group;
3. scores (0–100): demand (impressions percentile, blended with organic percentile, ± best-seller
   trend/demand), visibility (7-day impressions percentile, CTR percentile, organic position),
   price (`100 − (priceVsBenchmark + 0.05) / 0.20 × 100`), health (status, severity, stock),
   efficiency (reserved for Ads);
4. recommendation – first matching rule, each pushing reason codes with params (translated in
   the client as `reason.<code>`):

| Order | Recommendation | Condition |
|-------|----------------|-----------|
| 1 | `NO_DATA` | impressions28 < min ∧ no benchmark ∧ no best seller ∧ organic impressions < min |
| 2 | `FIX` | health ≤ 40 ∧ (demand ≥ 50 ∨ impressions28 ≥ min) |
| 3 | `REPRICE` | price > benchmark + X % ∧ (CTR < category median ∨ effectiveness ∈ {HIGH, MEDIUM}) |
| 4 | `OPTIMISE_LISTING` | CTR < ½ median ∧ ¬over-priced |
| 5 | `WATCH` | demand change SINKER ∨ clicks w7 vs p7 < −Y % (p7 ≥ 5 clicks) ∨ organic impressions w28 vs p28 < −Y % (p28 ≥ 100) |
| 6 | `SCALE` | demand ≥ 60 ∧ health ≥ 70 ∧ ¬over-priced |
| 7 | `OPTIMISE_LISTING` | organic position 6–20 ∧ organic impressions28 ≥ max(300, 10 × min) ∧ ¬over-priced |
| 8 | `KEEP` | otherwise |

Thresholds: `signalMinImpressions` (min), `signalPriceAbovePct` (X), `signalClickDropPct` (Y).
Changed recommendations emit `signal.changed` (max 500 per run; none on the first computation).

### 7.3 Mocks

`MockMerchantApi` seeds 60 (tests: 30) products with issues and two feeds; `mock-reports.ts`
parses MCQL and generates rows as a pure function of (product, day) – stable across restarts, so
upserts are idempotent and tests can assert numbers; `unavailableReportViews` simulates a
disabled Market Insights. `MockSearchConsoleApi` generates page rows per product link plus a few
non-product pages and ten queries per product from its title; `sites`, `failWith`,
`failQueriesWith` simulate sharing / API problems.

---

## 8. Client notes

* `lib/types.ts` mirrors the server models; keep it in sync when changing routes.
* `lib/api.ts` – fetch wrapper; 401 triggers a global logout.
* `lib/i18n.tsx` – `t(key)` (typed keys), `tOr(key, fallback)` for server codes. `en.ts` is the
  reference; `pl.ts` must have the same keys (compile error otherwise). Adding a language = one
  file + one entry in `LANGUAGES`.
* `components/charts.tsx` – `LineChart` (multi-series, hover, ResizeObserver for crisp 1:1
  rendering), `ScoreBar`, `Delta` (null-safe; `invert` for "lower is better").
* Workflow builder: `FlowCanvas.tsx` (dnd-kit), `StepForms.tsx` (per-step forms + condition
  editor), `lib/workflow-blocks.ts` (palette metadata, one-line summaries, client-side validation).
  New step = schema + `STEP_CATALOG` entry (server), `BLOCKS` + `summarizeStep` + `validateStep` +
  form case (client), `step.<type>` / `step.<type>.d` translations.

---

## 9. Tests

```bash
npm test                 # vitest, all files
npm run test:coverage    # + coverage (thresholds in vitest.config.ts: 80 % lines/functions/statements, 70 % branches)
npm run check            # typecheck server + client + e2e (noUnusedLocals/Parameters on), then tests with coverage
npx vitest run server/test/product360.test.ts
```

Everything runs offline against the mocks (`testContext()` in `server/test/helpers.ts` builds an
app with an in-memory database and an injected `MockMerchantApi`; the Search Console mock is
created by `app.ts` in mock mode).

| File | Covers |
|------|--------|
| `conditions.test.ts` | operators, path resolution, templates |
| `attribute-catalog.test.ts` | attribute coercion / validation |
| `product-store.test.ts` | issue diffing, status aggregation, filters |
| `rest-client.test.ts`, `merchant-api-client.test.ts` | HTTP client, retries, pagination, every v1 endpoint URL |
| `auth-provider.test.ts` | service-account key loading, config |
| `settings.test.ts` | runtime settings, encryption, wizard API, developer registration |
| `sync-and-workflows.test.ts`, `gaps.test.ts` | sync, enrichment, workflow engine & scheduler, error paths |
| `performance.test.ts` | worker pool, shared 429 cool-down, call counts of bulk operations |
| `http.test.ts`, `routes.test.ts` | every API route incl. auth throttling, webhook |
| `product360.test.ts` | date helpers, MCQL parser & synthetic reports, connector helpers, metrics sync (backfill, revision window, unavailable views, pruning, unmatched rows), signal rules & events (incl. `NO_DATA`), `select_by_signal` / `set_sale_price`, Product360 routes, metrics scheduler, dashboard flag |
| `search-console.test.ts` | URL canonicalisation & property matching, Search Console client (encoding, paging, errors), request builders, connector (configuration, connection-test hints, per-day pull, country / merchant-listings passes, query cache, partial failure, URL-prefix mapping), organic signals, routes |
| `demo.test.ts` | `DEMO_MODE` config, idempotent bootstrap, warm-up, demo flag and *simulate a day* |

**Browser smoke tests** (`e2e/`, Playwright):

```bash
npm run test:e2e                                   # builds, starts the demo on :8123 with its own database (data/e2e.sqlite), runs the suite
npx playwright test -c e2e/playwright.config.ts --ui   # interactive; --headed to watch
```

`e2e/smoke.spec.ts` walks the demo tour in English: login → dashboard (tour card, recommendation
tiles add up to the catalogue size, organic KPIs) → products filtered by recommendation → a
product's 360° view (reasons, charts, price card, organic card, *Load queries* → *→ title* →
*Append to title*) → Market (not-carried best sellers, competitors) → Workflows (*Run now* on a
pre-installed workflow → success) → Settings (*Test connection* capabilities) → *Simulate a day*.
Playwright starts the server itself (`webServer` in `e2e/playwright.config.ts`) and
`global-setup.ts` recreates the database, so the synthetic data – and therefore the assertions –
are deterministic. Requires a Chromium download once: `npx playwright install chromium`.
The React client has no unit tests; the smoke suite plus strict type-checking cover it.

---

## 10. Conventions

* Strict TypeScript with `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`.
* Services get dependencies through constructors; settings through getters; no globals.
* SQL lives in the store classes (`ProductStore`, `MetricsStore`, `WorkflowStore`, …); routes
  only validate and call services.
* New persistent state = new migration (append to `MIGRATIONS`, never edit an applied one).
* New server→client text = code + translations in both locales; never English literals in
  responses that the UI shows (Google's own texts excepted).
* Every feature ships with tests in `server/test` (and, for UI flows, a step in `e2e/smoke.spec.ts`)
  and a note in the relevant doc.

## 11. Merchant API notes

* All calls go to the GA `v1` sub-APIs (`products`, `datasources`, `accounts`, `issueresolution`,
  `notifications`, `reports`, `quota`) through `google/merchant-api.ts`; the version segment is
  configurable (`MERCHANT_API_VERSION`).
* Feed products cannot be edited directly; attributes are added/overridden through a
  **supplemental data source** that the app creates (`ENRICHMENT_DATA_SOURCE_NAME`) and links
  to the *default rule* of every primary source. Pushed attributes are also stored locally so
  every push sends the complete set (`productInputs.insert`, one call per product).
* Retries with exponential back-off on `429` / `5xx`; a `429` puts the whole client into a
  cool-down (honouring `Retry-After`) so parallel workers back off together.
* No batch endpoint for products in v1 – bulk work uses bounded parallelism (`apiConcurrency`).
  Products are listed in pages of 1 000. The Settings page shows the account's quota groups.
* Reports: `reports:search` with Merchant Center Query Language; `date`/`report_date` come back as
  `{year, month, day}`; prices as `{amountMicros, currencyCode}`. Market Insights views require
  the programme to be enabled in Merchant Center.
