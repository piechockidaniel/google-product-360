# Product360 – plan

> Audience: developers and product. User-facing behaviour is documented in [user-guide.md](user-guide.md),
> internals in [development.md](development.md).
>
> Status: **Phases 0, 1 and 2 implemented** (see §10 for what exactly shipped and what was
> learned); Phases 3–5 are the roadmap.
> Product360 is positioned as a **new product** for existing and prospective customers, not a
> reaction to one customer's request. Consequences: every data source and every threshold is
> **end-user configurable** in the wizard / settings (no assumptions about a particular account),
> and the UI may be reorganised around the product rather than around Merchant Center.

### Decisions taken (2025)

| Topic | Decision |
|-------|----------|
| Google Ads | single account (no MCC yet), no developer token yet → apply early; standard Shopping **and** Performance Max must be supported |
| Search Console property type | **user's choice** in the wizard (the property list is fetched from the API; domain and URL-prefix both supported). URL-prefix when unsure |
| Product URLs | canonical and stable → URL join is reliable; diagnostics still shipped |
| Market Insights / conversion tracking | not assumed – detected per account ("Test connection" probes every report view); unavailable panels are hidden with a hint how to enable them |
| Levers (labels / budgets / pause / exclusions / price) | all offered; the user chooses per plan; GMC-side levers (labels, sale-price windows) ship first because they need no Ads write access |
| Approval & roles | **none** – operations run trusting the user; failures (incl. permission errors) are surfaced as notifications/events and dashboard flags. `plans.requires_approval`/`approved_*` columns are dropped from the design |
| Charts | dependency-free SVG components |
| Tests | mandatory for every phase; the suite runs offline against mock connectors |

## 1. What we want

Today GMC Manager answers *"is this product OK in Merchant Center?"* (status, issues, feeds,
enrichment, workflows). Product360 should additionally answer, **for every product and for
the catalogue as a whole**:

| Question | Source of truth |
|----------|-----------------|
| How are customers reacting? (impressions, clicks, CTR, conversions – paid and organic) | Merchant Center reports, Google Ads, Search Console |
| Where is the market going? (demand trend, best sellers, competitor prices, our visibility vs competitors) | Merchant Center *Market Insights* reports |
| What is it costing us and what does it bring back? (cost, ROAS, CPA) | Google Ads |
| Where should we focus and what should we (temporarily) drop? | a **signals / scoring layer** computed locally from all of the above |
| How do we *act* on that, and *when*? | workflows (existing) + a new **planner** for time-boxed changes (labels, promotions, budgets, campaign state) |

Two guiding principles, both inherited from the current code base:

1. **Everything lands in the local SQLite snapshot first, the UI and the workflow engine only
   read local data.** Google APIs are slow, lagged, rate-limited and down sometimes; the app must
   stay usable. This is exactly how products/issues work today.
2. **Every new source is optional and independently configurable.** An installation with only
   Merchant Center keeps working as it does now; Search Console and Google Ads are added
   connector by connector in the wizard.

Explicitly *out of scope* for the first iterations: ML forecasting, Google Trends (no official
API), GA4 (can be a later connector – see §9), multi-merchant tenancy (one account per
installation stays).

---

## 2. What we already have (reuse inventory)

| Existing piece | How Product360 reuses it |
|----------------|--------------------------|
| `MerchantApi.searchReport(query)` – Merchant API `reports:search`, already in the facade **and in the mock**, but unused | Phase 1 data source (performance, price competitiveness, price insights, best sellers, competitive visibility). **No new credentials or scopes needed.** |
| `ServiceAccountTokenProvider` (google-auth-library `JWT`, single scope) | Extend with per-connector scopes; the *same* service-account e-mail can be added as a user in Search Console and (to verify, §3.3) in Google Ads |
| `RestClient` (bearer token, retries, shared 429 cool-down, pagination helpers) | Instantiate one per connector with a different `baseUrl` and extra headers (Ads needs `developer-token`, `login-customer-id`) |
| `createSwitchableApi` / `createNotConfiguredApi` | Same pattern per connector so credentials can be changed at runtime |
| `SettingsService` (zod schema, encrypted secrets, env defaults, `onChange`) | Add connector settings; secrets (refresh tokens, dev token) go to `SECRET_KEYS` |
| `SyncService` + `SyncScheduler` + `sync_runs` | Add a `MetricsSyncService` with the same shape (run log, stats, events) on its own nightly schedule |
| `EventLog` (persistent + in-process bus) | New event types: `metrics.synced`, `signal.changed`, `plan.applied`, `plan.reverted` → usable as workflow triggers |
| `WorkflowEngine` / `ProductContext` / conditions / templates | Add `metrics.*`, `market.*`, `ads.*`, `search.*`, `signals.*` fields → existing operators work unchanged (`gt`, `lt`, `in`, …) |
| `STEP_CATALOG` + client `workflow-blocks.ts` + `StepForms.tsx` | New blocks: `select_by_signal`, `ads_set_campaign_status`, `ads_set_budget`, `schedule_revert`, … |
| `WorkflowScheduler` (croner) | Add one-off `at` trigger; planner uses it for apply/revert |
| `MockMerchantApi` + demo mode | Synthetic time series so the demo and the test suite cover Product360 offline |
| Setup wizard (steps, *Test connection*, error explanations) | Two new optional steps: *Search Console*, *Google Ads* |
| i18n (`en.ts`/`pl.ts`, server codes translated by client) | Signal reasons and recommendations are emitted as codes + params, not text |

---

## 3. Data sources in detail

### 3.1 Merchant Center reports (Merchant API `reports/v1 … reports:search`)

Already reachable with the current service account and scope. Query language: *Merchant
Center Query Language* (`SELECT … FROM <view> WHERE date BETWEEN …`).

| View | What it gives per product | Join key | Notes |
|------|---------------------------|----------|-------|
| `product_performance_view` | `clicks, impressions, click_through_rate, conversions, conversion_value, conversion_rate`; segments `date / week, offer_id, title, brand, category_l1..5, product_type_l1..5, custom_label_0..4, marketing_method (ADS / ORGANIC), customer_country_code` | `offer_id` (+ country) | Conversions require conversion tracking (Ads or MC conversion sources). `marketing_method` lets us split **paid vs free listings**. |
| `price_competitiveness_product_view` | `price_micros, benchmark_price_micros, benchmark_price_currency_code, report_country_code` | `offer_id`/`id` | Snapshot, not a time series (we snapshot it daily ourselves). Requires **Market Insights** enabled in Merchant Center (free opt-in). |
| `price_insights_product_view` | `suggested_price_micros, predicted_impressions_change_fraction, predicted_clicks_change_fraction, predicted_conversions_change_fraction, effectiveness (LOW/MEDIUM/HIGH)` | `offer_id` | Google's own "what if you priced at X" – great input for the *REPRICE* recommendation. Market Insights. |
| `best_sellers_product_cluster_view` | `rank, previous_rank, relative_demand, previous_relative_demand, relative_demand_change (RISER/FLAT/SINKER), inventory_status (IN_STOCK / OUT_OF_STOCK / NOT_IN_INVENTORY), variant_gtins, brand, category` per `report_country_code`, weekly/monthly | `variant_gtins` ↔ product `gtins`, fallback brand+title | This is the **market trend** signal ("what sells in my categories that I do or don't carry"). Market Insights. |
| `best_sellers_brand_view` | brand-level rank / demand | `brand` | Brand trend context. |
| `competitive_visibility_competitor_view`, `…_top_merchant_view`, `…_benchmark_view` | `domain, is_your_domain, page_overlap_rate, higher_position_rate, relative_visibility, ads_organic_ratio` per category/country/traffic source | category | Account/category level, not product level – shown as context on the dashboard and in the category drill-down. |
| `non_product_performance_view` | clicks/impressions of non-product pages | – | Skip. |

Freshness: ~1 day lag; rows for the last 2–3 days may still change → re-pull a rolling
window (default 7 days) each night. Time zone: Merchant Center account time zone.

Cost: one paginated query per view per night (`pageSize` 1000, `nextPageToken`) – negligible
against the quota; the existing `collectAll` helper does the paging.

### 3.2 Google Search Console (`searchconsole.googleapis.com/webmasters/v3`)

| Aspect | Detail |
|--------|--------|
| Endpoint | `POST /sites/{siteUrl}/searchAnalytics/query` – body `{ startDate, endDate, dimensions, type, dimensionFilterGroups, rowLimit ≤ 25000, startRow, dataState }`; `GET /sites` to list properties |
| Metrics | `clicks, impressions, ctr, position` |
| Dimensions | `date, page, query, country, device, searchAppearance` |
| Auth | scope `https://www.googleapis.com/auth/webmasters.readonly`; the service-account e-mail is added in Search Console → *Settings → Users and permissions* (works like adding any Google account). OAuth refresh token as alternative (§4.2). |
| Join key | **URL.** Search Console has no product ids. We map `product.link` → canonical page URL (strip tracking params, trailing slash, enforce scheme/host of the property). Domain properties (`sc-domain:example.com`) cover all hosts. |
| Freshness | 2–3 days lag for final data; `dataState=all` returns fresh but preliminary rows. Re-pull rolling 10 days. Dates are in **Pacific time**. |
| Volume | One query per day per dimension set: `dimensions=[page]` for all product pages (paged 25 000 rows) – 1 request per 25k rows. `query` per page is pulled **on demand** (product detail) and cached, not nightly for every product. |
| Quota | Roughly 1 200 queries/minute per site and per user – not a concern for a nightly pull. |
| Bonus | `searchAppearance` can be filtered to `MERCHANT_LISTINGS` / `PRODUCT_SNIPPETS` – organic performance of the product rich results specifically (to verify against the live API; the dimension cannot be combined with others in one query but can be used as a filter). |
| Also possible later | URL Inspection API (indexing status of product URLs, 2 000/day) – only for products flagged by signals, never in bulk. |

What it adds to the product: organic demand trend (impressions of the product page),
position, CTR, and **top queries** → ideas for title/description enrichment (queries where
the page is on position 5–20 are the textbook "easy wins", and the app can already push
improved titles through the supplemental source).

### 3.3 Google Ads (`googleads.googleapis.com/v{N}`; "AdWords" was shut down in 2022)

| Aspect | Detail |
|--------|--------|
| Endpoint | `POST /customers/{customerId}/googleAds:searchStream` with GAQL; mutations via `/customers/{id}/campaigns:mutate`, `campaignBudgets:mutate`, `assetGroups:mutate`, `assetGroupListingGroupFilters:mutate`, … Version segment configurable like `MERCHANT_API_VERSION` (Ads versions are sunset ~yearly). |
| Headers | `Authorization: Bearer`, `developer-token`, `login-customer-id` (the MCC id when the account is managed). |
| Auth | scope `https://www.googleapis.com/auth/adwords`. **Developer token** from the MCC *API Center*: *Test access* works only with test accounts; *Basic access* (≈15 000 operations/day, enough here) needs a short application review. Service accounts: documented path is domain-wide delegation (Workspace); adding the service-account e-mail directly as an Ads user is reported to work and **must be verified early** – otherwise we ship the OAuth refresh-token flow (§4.2) for Ads. |
| Product metrics | `shopping_performance_view` (covers Shopping **and Performance Max**): segments `segments.product_item_id` (offer id, **lower-cased** by Google), `segments.product_merchant_id`, `segments.product_channel`, `segments.product_country`, `segments.product_custom_attribute0..4`, `segments.date`, `campaign.id/name/advertising_channel_type/status`; metrics `clicks, impressions, cost_micros, conversions, conversions_value, ctr, average_cpc`. |
| Join key | `lower(offerId)` + merchant id (+ country ↔ feed label when relevant). |
| Campaign dimension | `campaign`, `campaign_budget`, `asset_group` (PMax), `ad_group` + `ad_group_criterion` listing groups (standard Shopping) – stored locally so the planner can offer them as targets. |
| Freshness | hours; dates in the Ads account time zone. Rolling re-pull 3 days. |
| Writes for the planner (order of increasing complexity) | (1) campaign / asset-group **status** (ENABLED/PAUSED), (2) **budget** amount, (3) PMax **listing-group filters** (include/exclude by custom label / item id), (4) Shopping listing-group partitions (tree edits – complex), (5) creating campaigns from a template (many required fields; later phase). |

The important design bridge: **custom labels**. Most Shopping / PMax setups segment
products by `custom_label_0..4`. GMC Manager can already push custom labels through the
supplemental data source. So "move this product into the *push* campaign from Friday to
Monday" does **not** need Ads write access at all – it is a scheduled label change plus an
Ads campaign that targets that label. Ads write actions become an *optional* upgrade.

### 3.4 Identity resolution – the one hard problem

| Source | Key | Resolution |
|--------|-----|------------|
| Merchant reports | `offer_id` (+ country) | exact to `products.offer_id`; country → `feed_label` where feed labels are countries, otherwise aggregate over countries |
| Ads | `product_item_id` lower-cased, `product_merchant_id` | `lower(offer_id)`; keep a `product_key_lc` column; warn on collisions (two offers differing only in case) |
| Search Console | page URL | `product_url_map(product_name, canonical_url)` rebuilt on every product sync from `product.link` (and `mobile_link`, `canonical_link` if present). Unmapped URLs and unmapped products are both reported so the user can fix the feed. Variants sharing one landing page: metrics are attributed to **all** variants with a `shared_url = true` flag (never summed twice at catalogue level). |
| Best sellers | `variant_gtins`, brand, category | match on any product `gtins[]` → *"we carry it"*; otherwise → *"opportunity: trending item we do not carry"* list |

---

## 4. Architecture

### 4.1 Connector abstraction (server)

```
server/src/connectors/
  connector.ts              Connector interface + registry
  merchant-reports/         uses existing MerchantApi.searchReport
  search-console/           SearchConsoleClient (RestClient + webmasters scope) + sync
  google-ads/               GoogleAdsClient (RestClient + adwords scope + headers) + sync + mutations
  mock/                     synthetic data for all three (demo mode + tests)
server/src/services/
  metrics-sync-service.ts   orchestrates connectors, rolling windows, backfill, run log
  product-url-map.ts        URL canonicalisation + mapping
  signals-service.ts        computes product_signals after each metrics sync
  product360-service.ts     read model: everything about one product / catalogue views
  planner-service.ts        plans (apply/revert), snapshots, conflicts
server/src/http/routes/
  metrics.ts  product360.ts  connectors.ts  plans.ts
```

```ts
export interface Connector {
  readonly id: 'merchant_reports' | 'search_console' | 'google_ads';
  /** Which settings keys must be present for isConfigured() */
  isConfigured(): boolean;
  /** Used by the wizard's "Test connection" – returns a human readable diagnosis (codes, like today). */
  testConnection(): Promise<ConnectionTestResult>;
  /** Pulls [from, to] (inclusive dates) into local tables; idempotent (upsert). */
  sync(window: { from: string; to: string }, log: SyncLog): Promise<ConnectorSyncStats>;
  /** How far back an initial backfill may go (SC: 16 months, Ads: configurable, MC: ~2 years) */
  maxBackfillDays: number;
  /** How many trailing days must be re-pulled every night because Google revises them */
  revisionWindowDays: number;
}
```

Each connector gets its own `createSwitchableApi`-style wrapper so the wizard can change
credentials without restart, exactly like the Merchant API today.

### 4.2 Authentication

* **Service account (default, consistent with today).** `ServiceAccountTokenProvider`
  takes `scopes: string[]`; one provider per connector (tokens are scope-specific). The wizard
  tells the user which e-mail to add where (Search Console property user, Ads account user).
* **OAuth 2.0 refresh token (fallback).** Needed if direct service-account access to Ads
  turns out not to work for the user's setup, or for users who prefer "Sign in with Google".
  Requires an OAuth client id/secret (settings, encrypted), a `GET /api/oauth/google/start`
  → consent → `GET /api/oauth/google/callback` pair, and storing the refresh token encrypted.
  google-auth-library's `OAuth2Client` handles refresh. Scopes requested = union of enabled
  connectors. Implemented only if needed (decision point after the Ads spike, §7).

Settings additions (all optional, env defaults like today):

```ts
// search console
searchConsoleEnabled: boolean
searchConsoleSiteUrl: string              // 'sc-domain:example.com' or 'https://www.example.com/'
searchConsoleCountryFilter: string | null // e.g. 'pol' – when feed labels are countries
// google ads
googleAdsEnabled: boolean
googleAdsCustomerId: string               // '123-456-7890' normalised to digits
googleAdsLoginCustomerId: string | null   // MCC
googleAdsDeveloperToken: string | null    // SECRET
googleAdsApiVersion: string               // 'v19' – configurable like MERCHANT_API_VERSION
googleAdsWriteEnabled: boolean            // planner may mutate Ads (default false)
// metrics
metricsSyncCron: string                   // '0 4 * * *' (account time zone)
metricsRetentionDays: number              // 400 daily rows, older → weekly rollup
metricsBackfillDays: number               // initial load, default 90
// shared fallback auth
googleOAuthClientId / googleOAuthClientSecret (SECRET) / googleOAuthRefreshToken (SECRET)
```

### 4.3 Storage (migration 2)

Wide, per-source daily tables (shapes differ too much for one long table), all keyed by
`product_name` (the existing PK `accounts/{a}/products/{id}`) so joins to `products`,
`product_issues`, `product_metadata` are trivial. **Only non-zero rows are stored** – most
products have zero clicks most days, which keeps SQLite small (sparse storage).

```sql
-- Merchant Center performance (paid + free listings split)
CREATE TABLE mc_product_performance_daily (
  product_name TEXT NOT NULL, date TEXT NOT NULL,
  marketing_method TEXT NOT NULL,          -- ADS | ORGANIC | ALL
  country TEXT NOT NULL DEFAULT 'ALL',
  impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0, conversion_value_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_name, date, marketing_method, country)
);

-- Market Insights snapshots (one row per product per day we looked)
CREATE TABLE mc_price_benchmark_daily (
  product_name TEXT NOT NULL, date TEXT NOT NULL, country TEXT NOT NULL,
  price_micros INTEGER, benchmark_price_micros INTEGER, currency TEXT,
  suggested_price_micros INTEGER, predicted_clicks_change REAL, predicted_conversions_change REAL, effectiveness TEXT,
  PRIMARY KEY (product_name, date, country)
);

CREATE TABLE mc_best_sellers (
  report_date TEXT NOT NULL, granularity TEXT NOT NULL, country TEXT NOT NULL, category_id TEXT NOT NULL,
  cluster_key TEXT NOT NULL,               -- hash of title+brand+gtins
  title TEXT, brand TEXT, gtins TEXT,       -- JSON
  rank INTEGER, previous_rank INTEGER, relative_demand TEXT, previous_relative_demand TEXT, demand_change TEXT,
  inventory_status TEXT, product_name TEXT, -- NULL when we do not carry it
  PRIMARY KEY (report_date, granularity, country, category_id, cluster_key)
);

CREATE TABLE mc_competitive_visibility_daily (
  date TEXT NOT NULL, country TEXT NOT NULL, category_id TEXT NOT NULL, traffic_source TEXT NOT NULL,
  domain TEXT NOT NULL, is_your_domain INTEGER NOT NULL,
  relative_visibility REAL, page_overlap_rate REAL, higher_position_rate REAL, ads_organic_ratio REAL,
  PRIMARY KEY (date, country, category_id, traffic_source, domain)
);

-- Search Console
CREATE TABLE product_url_map (
  product_name TEXT PRIMARY KEY, canonical_url TEXT NOT NULL, shared_url INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE INDEX idx_url_map_url ON product_url_map(canonical_url);

CREATE TABLE sc_page_daily (
  canonical_url TEXT NOT NULL, date TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'ALL', device TEXT NOT NULL DEFAULT 'ALL',
  clicks INTEGER NOT NULL, impressions INTEGER NOT NULL, ctr REAL NOT NULL, position REAL NOT NULL,
  PRIMARY KEY (canonical_url, date, country, device)
);

CREATE TABLE sc_page_queries (                -- on-demand cache (product detail), 28-day window
  canonical_url TEXT NOT NULL, query TEXT NOT NULL, window_end TEXT NOT NULL,
  clicks INTEGER, impressions INTEGER, ctr REAL, position REAL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (canonical_url, query, window_end)
);

-- Google Ads
CREATE TABLE ads_campaigns (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,        -- SHOPPING | PERFORMANCE_MAX | ...
  status TEXT NOT NULL, budget_id TEXT, budget_micros INTEGER, bidding_strategy TEXT, merchant_id TEXT,
  raw_json TEXT NOT NULL, synced_at TEXT NOT NULL
);
CREATE TABLE ads_product_daily (
  product_key_lc TEXT NOT NULL, product_name TEXT,                    -- resolved; NULL if unknown offer
  date TEXT NOT NULL, campaign_id TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'ALL',
  impressions INTEGER, clicks INTEGER, cost_micros INTEGER, conversions REAL, conversions_value_micros INTEGER,
  PRIMARY KEY (product_key_lc, date, campaign_id, country)
);
CREATE TABLE ads_campaign_daily (
  campaign_id TEXT NOT NULL, date TEXT NOT NULL,
  impressions INTEGER, clicks INTEGER, cost_micros INTEGER, conversions REAL, conversions_value_micros INTEGER,
  search_impression_share REAL, search_budget_lost_is REAL,
  PRIMARY KEY (campaign_id, date)
);

-- Computed layer
CREATE TABLE product_signals (
  product_name TEXT PRIMARY KEY,
  computed_at TEXT NOT NULL, window_days INTEGER NOT NULL,
  -- rolled-up inputs (for sorting/filtering without touching daily tables)
  mc_impressions_7d INTEGER, mc_clicks_7d INTEGER, mc_ctr_7d REAL, mc_clicks_prev_7d INTEGER,
  sc_impressions_28d INTEGER, sc_clicks_28d INTEGER, sc_position_28d REAL, sc_impressions_prev_28d INTEGER,
  ads_cost_micros_28d INTEGER, ads_conversions_28d REAL, ads_value_micros_28d INTEGER, ads_roas_28d REAL,
  price_vs_benchmark REAL,                       -- price / benchmark - 1
  demand TEXT, demand_change TEXT,               -- from best sellers, when matched
  -- outputs
  scores TEXT NOT NULL,                          -- JSON { demand, visibility, price, efficiency, health } 0..100
  recommendation TEXT NOT NULL,                  -- SCALE | FIX | REPRICE | OPTIMISE_LISTING | WATCH | PAUSE | NO_DATA
  reasons TEXT NOT NULL                          -- JSON [{ code, params }] – translated in the client
);
CREATE INDEX idx_signals_reco ON product_signals(recommendation);

CREATE TABLE metrics_sync_runs (                 -- same shape as sync_runs, per connector
  id INTEGER PRIMARY KEY AUTOINCREMENT, connector TEXT NOT NULL, status TEXT NOT NULL,
  window_from TEXT, window_to TEXT, started_at TEXT NOT NULL, finished_at TEXT, stats TEXT NOT NULL DEFAULT '{}', error TEXT
);

-- Planner (§4.6)
CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,                          -- draft | scheduled | active | reverting | completed | cancelled | failed
  start_at TEXT NOT NULL, end_at TEXT,           -- end NULL = permanent change
  timezone TEXT NOT NULL,
  selection TEXT NOT NULL,                       -- JSON: product filter / condition / explicit ids (same schema as workflow select+filter)
  apply_steps TEXT NOT NULL, revert_steps TEXT NOT NULL DEFAULT '[]',   -- JSON arrays of workflow steps
  apply_run_id INTEGER REFERENCES workflow_runs(id), revert_run_id INTEGER REFERENCES workflow_runs(id),
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE plan_snapshots (                    -- what was there before apply, so revert restores reality
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,                     -- product_attributes | ads_campaign | ads_budget | ads_listing_group
  target_key TEXT NOT NULL, before_json TEXT NOT NULL, taken_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, target_type, target_key)
);
```

Retention: daily rows older than `metricsRetentionDays` are rolled up into weekly rows
(`date` = ISO week Monday, flagged by a `granularity` column – added to the three daily tables
when implemented) and deleted. Estimate for 10 000 products: sparse daily rows ≈ 1–3 M per
year across all sources → a few hundred MB in SQLite, acceptable; rollups keep it bounded.

### 4.4 Metrics sync

`MetricsSyncService` runs on its own cron (`metricsSyncCron`, default 04:00 account time –
after Google has closed the previous day) and:

1. For each enabled connector: window = `[today − revisionWindowDays, today]`; on first run
   (no `metrics_sync_runs` for the connector) window = `[today − metricsBackfillDays, today]`
   pulled in 30-day chunks so a failure does not lose everything.
2. Rebuilds `product_url_map` (cheap, local).
3. Upserts rows, resolves `product_name`, records unmatched counts in stats.
4. Runs `SignalsService.recompute()` (pure SQL + TS over the rolled-up windows).
5. Emits `metrics.synced` (payload: connector stats) and `signal.changed` per product whose
   `recommendation` changed (→ workflow trigger, dashboard "since last login" list).

Manual "Sync now" per connector on the Settings page; `POST /api/metrics/sync?connector=…`.

### 4.5 Signals & recommendations (explainable, rule-based)

Every product gets five 0–100 scores and one recommendation with *reasons*. Rules are
deliberately simple and every threshold is a setting (defaults below), so a merchant can tune
them and always understands *why* a product is on a list.

| Score | Inputs | Default rule |
|-------|--------|--------------|
| `demand` | best-seller relative demand & change; SC impressions trend (28d vs previous 28d); MC impressions trend (7d vs previous 7d) | percentile within the product's `category_l1`/`product_type_l1` |
| `visibility` | MC impressions and CTR vs category median; SC position; competitive visibility of the category | percentile within category |
| `price` | `price_vs_benchmark`; price insights `effectiveness` | 100 at ≤ benchmark −5 %, 0 at ≥ benchmark +15 % |
| `efficiency` | Ads ROAS / CPA 28d vs account target (`targetRoas` setting) | only when Ads connected and cost > `minSpend` |
| `health` | aggregated status, issue severity, availability | existing data |

| Recommendation | Rule (first match wins) | Typical action |
|----------------|-------------------------|----------------|
| `FIX` | disapproved / error issues **and** demand ≥ 50 | fix the feed – high-demand item not showing |
| `PAUSE` | Ads cost 28d > `minSpend`, conversions = 0 or ROAS < `pauseRoas`, demand < 40 | exclude via label / pause, at least temporarily |
| `REPRICE` | price_vs_benchmark > +10 % **and** CTR below category median, or price insights `effectiveness = HIGH` | sale price window via planner |
| `OPTIMISE_LISTING` | SC impressions high but CTR low / position 5–20, or MC impressions high + CTR low with competitive price | title/description enrichment from top queries |
| `SCALE` | demand ≥ 60, ROAS ≥ `scaleRoas` (or no Ads: CTR ≥ median and approved) | move to "push" label / raise budget |
| `WATCH` | demand change = SINKER or clicks 7d dropped > 40 % vs previous 7d | watch list, no action yet |
| `NO_DATA` | no metrics in window | – |

Outputs are exposed (a) on the product page, (b) as dashboard lists *Focus (SCALE/FIX)* and
*Drop candidates (PAUSE)* and *Price opportunities*, (c) as catalogue facets/sorting on the
Products page, (d) in the workflow `ProductContext` (`signals.recommendation`,
`signals.scores.demand`, `metrics.mc.clicks7d`, …) and (e) as `signal.changed` events.

### 4.6 Planner – "apply at time X, revert at time Y"

A **plan** is a time-boxed pair of workflow step lists operating on a selection:

```jsonc
{
  "name": "Black Friday push – premium headphones",
  "startAt": "2025-11-28T00:00", "endAt": "2025-12-01T23:59", "timezone": "Europe/Warsaw",
  "selection": { "filter": { "tag": "bf-2025" } },          // or a condition tree / explicit ids
  "applySteps": [
    { "type": "set_attributes", "attributes": { "customLabel0": "bf-push" } },
    { "type": "ads_set_budget", "campaignId": "123", "amount": 500, "currency": "PLN" },
    { "type": "webhook", "url": "…", "message": "BF plan applied to {{count}} products" }
  ],
  "revertSteps": "auto"                                      // restore from plan_snapshots
}
```

Design decisions:

* **Reuses the workflow engine.** A plan is compiled into two internal workflows with the new
  one-off `at` trigger (`{ type: 'at', runAt, timezone }`); runs appear in the existing run log.
  Nothing new to learn for the step catalogue, templates or preview.
* **Snapshots before apply.** `plan_snapshots` stores the previous pushed attributes /
  campaign status / budget so `revertSteps: "auto"` restores what was *actually* there, not what
  we assume. Manual revert steps remain possible.
* **Native time windows where Google offers them.** For price promotions the planner pushes
  `salePrice` + `salePriceEffectiveDate` once – Google applies the window itself, no revert
  needed. Same for `availabilityDate`. The UI shows these as "handled by Google".
* **Conflict detection.** Before scheduling, the planner checks overlapping plans that touch
  the same attribute on the same products or the same campaign/budget and warns (block is a
  setting).
* **No approval step.** Operations are executed as scheduled; a failed apply/revert (e.g.
  missing Ads permission) marks the plan `failed`, records an `error` event, raises a dashboard
  flag and – when configured – fires the notification webhook.
* **Calendar view** (month/week) of plans, plus the existing activity trail.
* **Missed start** (server down): on boot, plans whose `startAt` has passed and `endAt` has not
  are applied immediately (logged as late); plans whose `endAt` has passed are reverted.
  Mirrors `failStaleRuns()`.

New workflow steps (server `schema.ts` + `STEP_CATALOG`, client `workflow-blocks.ts` + forms):

| Step | Purpose | Phase |
|------|---------|-------|
| `select_by_signal` | `recommendation in [...]`, `minScore`, `category` – sugar over `select_products` + filter | 1 |
| `set_sale_price` | push `salePrice` + `salePriceEffectiveDate` (absolute or relative to run time) via enrichment | 1 |
| `ads_set_campaign_status` | ENABLED / PAUSED for campaign or asset group | 4 |
| `ads_set_budget` | absolute or ±% with floor/ceiling | 4 |
| `ads_listing_group_exclude` / `…_include` | PMax listing group filter by custom label / item id | 4 |
| `ads_create_campaign` | from a stored template (PMax with Merchant Center feed, budget, tROAS, label filter) | 5 |

New triggers: `at` (one-off) and `event: metrics.synced | signal.changed`.

### 4.7 Read model & HTTP API

| Endpoint | Returns |
|----------|---------|
| `GET /api/products/:id/360` | everything for one product: status/issues (existing), `signals`, MC performance series (paid/organic), price vs benchmark series, best-seller cluster, SC series + top queries (lazy), Ads series per campaign, active/planned plans touching it |
| `GET /api/products?recommendation=SCALE&orderBy=demand` | existing list route gains signal filters/sorting (join on `product_signals`) |
| `GET /api/products/facets` | + recommendation counts |
| `GET /api/dashboard` | + `focus`, `dropCandidates`, `priceOpportunities`, `trendingNotCarried`, `competitiveVisibility`, `metricsFreshness` |
| `GET /api/market/best-sellers?country=PL&category=…` | trending clusters, flag "carried / not carried" |
| `GET /api/market/competitors` | competitive visibility tables |
| `GET /api/ads/campaigns` | local campaign dimension + 28d metrics |
| `GET/POST /api/plans`, `GET/PUT/DELETE /api/plans/:id`, `POST /api/plans/:id/apply-now`, `POST /api/plans/:id/revert-now`, `GET /api/plans/calendar?from&to` | planner |
| `GET /api/connectors`, `POST /api/connectors/:id/test`, `POST /api/metrics/sync?connector=`, `GET /api/metrics/status` | connector management |

### 4.8 UI

* **Product detail → new first tab "360"**: header KPIs (clicks 7d ▲/▼, CTR, cost, ROAS,
  price vs benchmark, organic position), recommendation badge with reasons, three small charts
  (MC paid/organic, SC, Ads) on one time axis, price-vs-benchmark chart, best-seller cluster
  card, top organic queries with "use as title idea" → opens the enrichment form pre-filled,
  "Plan an action" button → planner pre-filled with this product.
* **Dashboard**: *Focus*, *Drop candidates*, *Price opportunities*, *Trending items you don't
  carry*, market visibility vs competitors, freshness per connector.
* **Products list**: recommendation facet + columns (clicks 7d, ROAS, price Δ), sortable.
* **Market page** (new nav item): best sellers by category/country with carried/not-carried,
  competitor visibility, brand trends.
* **Plans page** (new nav item): list + calendar, editor (selection preview reuses workflow
  preview), apply/revert status.
* **Settings / wizard**: two new optional steps with *Test connection* diagnostics (codes →
  translated, like Merchant API errors today), signal thresholds, retention.
* Charts: a tiny dependency-free SVG sparkline/line component (the client currently has no
  chart lib; keeping it that way is in the spirit of the project) – or `recharts` if richer
  charts are wanted. Decision at Phase 1.

---

## 5. Phases, deliverables, rough effort

Effort assumes one developer familiar with the code base; "week" ≈ 5 focused days.
Each phase ends with: migration, tests against the mock connectors, i18n (EN+PL), docs
section.

| Phase | Scope | Value | Effort |
|-------|-------|-------|--------|
| **0 – Foundation** | connector interface + registry, per-scope token providers, settings namespace, `metrics_sync_runs`, `MetricsSyncService` with cron/backfill/revision windows, mock data generators, `product_url_map`, empty `product_signals` | none visible, everything else depends on it | 1 week |
| **1 – Merchant reports + signals v1** | all MC views from §3.1, signals (demand/visibility/price/health, no efficiency), Product360 tab v1, dashboard lists, product list facets, `select_by_signal` + `set_sale_price` steps, `metrics.synced`/`signal.changed` triggers, Market page (best sellers, competitors) | **big** – trend, price and performance context with zero new credentials | 2 weeks |
| **2 – Search Console** | wizard step, property list/selection, URL mapping + diagnostics, nightly page pull, on-demand queries, SC panel in Product360, `OPTIMISE_LISTING` rule, "title ideas" → enrichment form | organic demand + content optimisation loop | 1.5 weeks |
| **3 – Google Ads (read)** | dev-token/customer wizard step, auth spike (SA vs OAuth), `shopping_performance_view` + campaign dimension pull, Ads panel in Product360, `efficiency` score, `PAUSE`/`SCALE` rules complete, campaigns page | cost/ROAS → real "drop / scale" decisions | 2 weeks (+1 if OAuth flow is required) |
| **4 – Planner** | `at` trigger, plans CRUD + compile to workflows, snapshots + auto revert, conflict check, calendar UI, missed-start recovery, Ads write steps (status, budget, PMax listing-group filter) behind `googleAdsWriteEnabled` | scheduled promotions & campaign steering | 2 weeks |
| **5 – Later** | `ads_create_campaign` from templates, GA4 connector (product revenue / add-to-cart), anomaly alerts (sudden CTR/cost change → event), weekly e-mail digest, CSV export of signals | – | as needed |

Suggested order: 0 → 1 → (2 and 3 can be swapped depending on what the user has access to
first; Ads token approval can run in parallel with Phase 1/2) → 4.

---

## 6. Test strategy (matches the existing suite)

* Mock connectors generate deterministic synthetic series (seeded PRNG) so `npm test` covers
  sync, identity resolution (case-insensitive offer ids, shared URLs, unmatched rows), rollups,
  signal rules (table-driven tests per recommendation), planner state machine (apply → active →
  revert, missed start, conflicts), and every new HTTP route – all offline.
* Query builders (MCQL, GAQL, SC request bodies) get unit tests asserting the exact strings,
  like `merchant-api-client.test.ts` asserts every URL today.
* Demo mode (`MERCHANT_MOCK=true`) shows Product360 with synthetic data, so the UI can be
  exercised without any Google account.

---

## 7. Risks, unknowns and decisions needed

| # | Risk / question | Mitigation / decision |
|---|-----------------|-----------------------|
| 1 | **Google Ads developer token**: needs an MCC and a *Basic access* review (days). Test tokens only work against test accounts. | Apply for the token at the start of Phase 0 so it is ready for Phase 3. Confirm: does the merchant have an MCC? |
| 2 | **Service-account access to Ads** without Workspace domain-wide delegation – widely used but should be verified against the user's account. | 1-day spike at the start of Phase 3; fallback = OAuth refresh-token flow (§4.2, +1 week). |
| 3 | **Market Insights** must be enabled in Merchant Center for price/best-seller/visibility views. | Wizard "Test connection" for the reports connector runs one query per view and reports which are unavailable; the UI hides those panels. |
| 4 | **Conversions** are only present if conversion tracking exists (Ads or MC conversion sources). | `efficiency` and ROAS rules switch off automatically; UI shows "no conversion data" with a link to the setup doc. |
| 5 | **Join quality**: Search Console URLs vs `product.link` (redirects, parameters, variants on one page); Ads lower-cased ids. | Mapping diagnostics page (unmapped URLs / products / ads ids), `shared_url` flag, collision warnings. |
| 6 | **Time zones**: SC (Pacific), Ads (account TZ), MC (account TZ). Daily joins are approximate by design. | Document; never mix sources inside one daily metric, only side-by-side. |
| 7 | Planner writes to Ads budgets without approval (decision). | Every apply/revert is logged with before/after snapshots; failures become notifications. |
| 8 | **SQLite growth** | sparse storage, weekly rollups, retention setting, `VACUUM` hint in operations.md. |
| 9 | **Scope creep in "campaign definition"** (Ads campaign creation has dozens of required fields and keeps changing). | Phase 5, template-based only, after the label-based steering has proven enough or not. |
| 10 | **API version churn** (Ads yearly sunsets) | version segment configurable, all GAQL in one file like `merchant-api.ts`. |


---

## 8. Appendix – query sketches

Merchant Center Query Language (Phase 1):

```sql
SELECT segments.date, segments.offer_id, segments.marketing_method, segments.customer_country_code,
       metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversion_value
FROM product_performance_view
WHERE segments.date BETWEEN '2025-01-01' AND '2025-01-07'

SELECT offer_id, report_country_code, price_micros, benchmark_price_micros, benchmark_price_currency_code
FROM price_competitiveness_product_view

SELECT offer_id, suggested_price_micros, predicted_clicks_change_fraction, predicted_conversions_change_fraction, effectiveness
FROM price_insights_product_view

SELECT report_date, report_granularity, report_country_code, report_category_id, title, brand, variant_gtins,
       rank, previous_rank, relative_demand, previous_relative_demand, relative_demand_change, inventory_status
FROM best_sellers_product_cluster_view
WHERE report_date = '2025-01-06' AND report_granularity = 'WEEKLY' AND report_country_code = 'PL'

SELECT date, report_country_code, report_category_id, traffic_source, domain, is_your_domain,
       relative_visibility, page_overlap_rate, higher_position_rate
FROM competitive_visibility_competitor_view
WHERE date BETWEEN '2025-01-01' AND '2025-01-07' AND traffic_source = 'ALL'
```

Search Console (Phase 2):

```json
POST /webmasters/v3/sites/sc-domain:example.com/searchAnalytics/query
{ "startDate": "2025-01-01", "endDate": "2025-01-01", "dimensions": ["page"],
  "type": "web", "dataState": "all", "rowLimit": 25000, "startRow": 0 }

{ "startDate": "2024-12-05", "endDate": "2025-01-01", "dimensions": ["query"],
  "dimensionFilterGroups": [{ "filters": [{ "dimension": "page", "operator": "equals", "expression": "https://example.com/p/sku-1" }] }],
  "rowLimit": 50 }
```

GAQL (Phase 3):

```sql
SELECT segments.date, segments.product_item_id, segments.product_merchant_id, segments.product_country,
       campaign.id, campaign.name, campaign.advertising_channel_type,
       metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
FROM shopping_performance_view
WHERE segments.date BETWEEN '2025-01-01' AND '2025-01-03'

SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
       campaign_budget.id, campaign_budget.amount_micros, campaign.bidding_strategy_type,
       campaign.shopping_setting.merchant_id
FROM campaign
WHERE campaign.advertising_channel_type IN ('SHOPPING', 'PERFORMANCE_MAX')
```

Example workflow using the new context (Phase 1):

```jsonc
{
  "name": "Weekly: label drop candidates for the PMax exclusion filter",
  "trigger": { "type": "event", "event": "metrics.synced", "debounceSeconds": 60 },
  "steps": [
    { "type": "select_by_signal", "recommendation": ["PAUSE"] },
    { "type": "filter", "condition": { "all": [
        { "field": "metrics.ads.cost28d", "op": "gt", "value": 200 },
        { "field": "signals.scores.demand", "op": "lt", "value": 40 } ] } },
    { "type": "stop_if_empty" },
    { "type": "set_attributes", "attributes": { "customLabel4": "paused-by-signal" } },
    { "type": "add_tags", "tags": ["drop-candidate"] },
    { "type": "webhook", "url": "https://hooks…", "message": "{{count}} products moved to the excluded label" }
  ]
}
```

---

## 10. Implementation log

### Phase 0 + 1 – shipped

Server (`server/src`):

| Piece | File(s) |
|-------|---------|
| Connector interface + per-connector state (detected capabilities) | `connectors/connector.ts` |
| Merchant reports connector: MCQL builders, performance / price / best sellers / competitive visibility, offer-id → product resolution (country-aware), GTIN matching, graceful handling of missing Market Insights | `connectors/merchant-reports.ts` |
| Metric tables (migration 2), sparse storage, pruning, run log | `db/migrations.ts`, `services/metrics-store.ts` |
| Orchestration: backfill → revision window, 31-day chunks, run log, `metrics.synced` / `metrics.failed` events | `services/metrics-sync-service.ts`, `jobs/metrics-scheduler.ts` (cron, account TZ) |
| Signals: peer-group percentiles (category ≥ 5 products, else catalogue), scores, rules, reasons, `signal.changed` events; recomputed after every product sync and on threshold changes | `services/signals-service.ts` |
| Read model for product page + dashboard | `services/product360-service.ts` |
| Settings (`metrics*`, `signal*`), env defaults `METRICS_SYNC_CRON`, `METRICS_BACKFILL_DAYS` | `services/settings-service.ts`, `config/index.ts` |
| Workflow integration: `ProductContext.metrics / market / signals`, `select_by_signal`, `set_sale_price`, triggers, 3 templates | `workflows/*` |
| Routes: `/metrics/*`, `/market/*`, `/products/:id/360`, product filters/sorting, dashboard `insights` | `http/routes/metrics.ts`, `products.ts`, `dashboard.ts` |
| Synthetic reports for demo mode & tests (deterministic per product/day, respects filters, can simulate disabled Market Insights) | `mock/mock-reports.ts` |
| Prepared-statement cache (bulk upserts 7× faster) | `db/database.ts` |

Client: `components/charts.tsx` (SVG line chart / sparkline / score bar / delta), `components/signals.tsx`,
`components/Product360Panel.tsx` (product → *360°* tab), `components/MetricsSettingsCard.tsx`,
`pages/MarketPage.tsx`, dashboard insights block, product list filter/columns, workflow blocks + forms,
EN/PL dictionaries.

Tests: `server/test/product360.test.ts` (23 tests) – whole suite 91 tests, coverage above thresholds.

### Learned while implementing

* **`competitive_visibility_competitor_view` must be queried per (country, category).** The
  connector derives the categories from the best-seller rows that match carried products (capped
  at 20 pairs per run). Without Market Insights there is no category list → the view is skipped.
* **Window end = last day with data, not "today".** Signals anchor their 7/28-day windows on the
  latest performance date so a lagging report does not look like a traffic collapse.
* **Offer ids are not unique** across feed labels / languages → resolution prefers the product
  whose feed label equals the report country; Ads (Phase 3) will additionally need the
  lower-cased variant (already indexed).
* **Peer comparison needs a category column.** `products.category` (Google product category leaf,
  else first product type) was added; categories with fewer than 5 products fall back to the whole
  catalogue.
* **SCALE was initially too strict** (required CTR ≥ median, which excludes half the catalogue by
  definition). Now: demand ≥ 60, health ≥ 70, not over-priced; a CTR far below the median is
  routed to OPTIMISE_LISTING first.
* **Daily upsert volume matters**: 10k products × 90 days × 2 methods ≈ 1.8 M rows on first
  backfill. Sparse storage plus the statement cache keep this at roughly 1–2 minutes in SQLite;
  chunking by 31 days makes a failure resumable.

### Phase 2 – Search Console – shipped

| Piece | File(s) |
|-------|---------|
| Per-API OAuth scopes on the service-account provider | `google/auth.ts` |
| Search Console client (sites, search analytics, `startRow` paging, percent-encoded site segment) + not-configured stub | `google/search-console-api.ts` |
| URL canonicalisation (tracking params, fragments, ports, trailing slash) and property matching (domain vs URL-prefix) | `util/urls.ts` |
| `product_url_map`, `sc_page_daily` (per URL, `ALL` / `MERCHANT_LISTINGS`), `sc_page_queries` cache, organic columns on `product_signals` (migration 3) | `db/migrations.ts`, `services/metrics-store.ts` |
| Connector: per-day page pull (25 k rows/page), optional country filter and merchant-listings pass, 2-day lag, 10-day revision window, 16-month max backfill, connection test with hints (`sc_property_missing`, `sc_property_unverified`, `sc_forbidden`, `sc_no_mapping`), top queries per product (24 h cache) | `connectors/search-console.ts` |
| `lagDays` per connector; gauges vs counters in run stats | `connectors/connector.ts`, `services/metrics-sync-service.ts` |
| Signals: demand blends organic impressions, visibility includes position, organic "easy win" rule (position 6–20, ≥ 300 impressions) **after** SCALE, organic-drop WATCH reason | `services/signals-service.ts` |
| Settings (`searchConsole*`), env default `SEARCH_CONSOLE_SITE_URL`, runtime rebuild of the client | `services/settings-service.ts`, `app.ts` |
| Routes: property list, mapping diagnostics, per-product queries; `search` block in `/products/:id/360`; organic KPIs in dashboard insights; `organicImpressions28d` / `organicPosition` sorting | `http/routes/*` |
| Mock Search Console (deterministic pages, non-product pages, queries from titles; can simulate missing share / API errors) | `mock/mock-search-console.ts` |
| UI: organic card on the 360° tab (series, KPIs, top queries with *easy win* badges and "→ title" into the enrichment form), Search Console section in the settings card (property picker, options, URL-mapping diagnostics), dashboard organic row + *Optimise listing* list, organic column on the product list | `client/src/components/*`, `pages/*` |
| Template `p360-organic-easy-wins` | `workflows/templates.ts` |

Tests: `server/test/search-console.test.ts` (11 tests); suite 102 tests.

Learned: (1) comparison windows must be *fully covered* by loaded data, otherwise a 90-day backfill
produces "+9000 %" deltas – the read model now returns `null` for uncovered previous windows;
(2) the organic opportunity rule would have swallowed the SCALE bucket when evaluated before it –
rule order matters more than thresholds; (3) gauges (mapped products) must not be summed over
backfill chunks.

### Demo & publishing – shipped

`DEMO_MODE` (`npm run demo`, Docker profile `demo`, pm2 app `gmc-manager-demo`): synthetic
Merchant Center + Search Console, setup completed, sample workflows installed, metrics warmed up
before "ready", guided tour with *Simulate a day* on the dashboard (`docs/demo.md`).
`deploy/deploy.sh` (server) + `deploy/publish.sh` (SSH/rsync) + `deploy/ecosystem.config.cjs` (pm2)
make an update a single command with a health check.

### Next

Phase 3 (Google Ads read) as described in §3.3/§5 – needs the developer token (Basic access) and
the service-account vs OAuth spike; the *efficiency* score, `PAUSE` rule and settings-card slot are
already reserved for it. Then Phase 4 (planner).
