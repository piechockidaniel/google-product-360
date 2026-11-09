# Product360: WooCommerce, Allegro and table interactions

Status: implementation in progress. This document preserves the requested end state and provides an implementation sequence. Features listed in the phases below are not complete unless explicitly marked in the current-state section.

## 1. Goal

Use WooCommerce as the primary source of product and inventory information for the app, connect Allegro as the first marketplace, and let the user manage selling through Allegro offers. Allegro prices are marketplace-specific. Support reusable offer templates that can be created from existing offers. Support WooCommerce and marketplace orders as part of the sales process. Keep Google Merchant Center and Search Console as connected channels for their respective data, diagnostics and insights.

The user will check whether another plugin currently integrates Allegro orders with WooCommerce. If one exists, the intended end state is for this solution to replace that integration. Its actual behavior and the migration path remain to be verified; do not disable or alter an existing plugin during discovery.

All data tables, including WooCommerce and Allegro tables, should support sorting by clicking column header labels and filtering using a filter row at the top of the table. The proposed layout is a header-label row followed immediately by the filter row, then data rows. Apply the same behavior consistently across the app and document any non-data presentation where the interaction is not meaningful.

## 2. Current state

- WooCommerce: encrypted credentials; read-only product, variation and minimized order snapshots; paginated sync with optional schedule (off by default), bounded transient retries, timeout reporting, progress, durable sync-run history and cancellation. Snapshots are committed only after the whole import succeeds. A live sync completed with 1,522 products/variations and 4,639 orders; ongoing large-store behavior still needs verification.
- WooCommerce matching: exact SKU/offer ID proposals and manual confirmed links are stored per store and Google product; one Woo product may map to multiple Google records. Conflicts require removing the existing mapping first. These links do not yet change product field ownership or the app's source of truth.
- Merchant Center: existing products, reports, issues, recommendations, workflows and supplemental-feed enrichment are centered on Google product records. The intended source-of-truth change is **not complete**.
- Allegro: OAuth, sandbox/production separation, rotating encrypted tokens, seller-scoped offer snapshots, local versioned templates from existing offers, and local drafts with independent Allegro prices have been implemented and tested with fakes. Optional sandbox-only operations can change the price, quantity or publication state of an existing offer, with stale-value checks and operation history. They still require real sandbox verification. Production writes, remote offer creation, order integration and inventory handoff are **not implemented**.
- Tables: Products, WooCommerce and Allegro offer tables have header sorting and filter rows; other tables remain to be migrated. Server-side filtering/sorting of WooCommerce and Allegro snapshots operates before pagination. Browser verification remains outstanding.

## 3. Data ownership and identity

The following is the proposed default ownership model; show source and freshness in the UI and allow channel-specific policy to be refined during implementation.

| Data | Authoritative owner | App responsibility |
| --- | --- | --- |
| Store products, variations, stock and base prices | WooCommerce | Read and retain source IDs, SKU, modification time and snapshot freshness. Avoid inventing a currency when one is not supplied. |
| WooCommerce orders | WooCommerce | Keep store order identity and lifecycle; link items to source products/variations. |
| Allegro offer ID, publication status, channel-specific price, stock allocation, category and listing details | Allegro for the published state; Product360 for locally configured desired values and templates | Maintain marketplace-specific prices independently from WooCommerce base prices. Compare desired and published values; do not automatically overwrite Allegro prices from WooCommerce. |
| Allegro order, payment and fulfillment status | Allegro | Read through the orders API and link to marketplace offers; preserve independent order identity. |
| Google offer ID, destination status, issues and performance | Google | Keep Google channel records, statuses and metrics distinct from store-owned product fields. |
| Local notes, tags, mappings, operation history and workflow state | Product360 | Keep a clear audit trail, permissions and source attribution. |

Create durable links among `(Woo store, Woo product or variation ID)`, `(Google account, Google product resource / feed / language)` and `(Allegro environment, seller account, offer ID)`. One Woo entity can correspond to multiple Google feed/language records and multiple channel offers. Preserve source-specific identifiers and avoid using SKU as the permanent primary key.

Use exact SKU/offer ID, GTIN and other supported identifiers as **matching evidence**, not unquestioned identity. Surface duplicates, missing values and conflicts for review; persist confirmed mappings and their provenance. Re-evaluate mappings when identifiers or source records change. Never merge ambiguous records silently.

WooCommerce is the default owner of core product data, but source records and channel representations must remain separately inspectable. For each field distinguish source value, channel value, desired value, last update and synchronization state. Policies must handle Woo-only, Google-only and Allegro-only products, deleted/unpublished products, variation inheritance, multiple markets and missing prices/currencies without accidental deletion or publication.

## 4. Work phases

### Phase 0 — Establish a reliable WooCommerce baseline

- Verify the current connection and first complete live sync, including products, variants and orders, against the actual store. Investigate slow pages and large catalogs; show stage, counts, failure and cancellation clearly.
- Define and implement a durable sync run record, restart/recovery behavior, bounded backoff, concurrency limits and safe retry for reads. For large datasets investigate incremental reads with a reliable cursor and overlap; retain periodic reconciliation and handle deletions explicitly. Do not publish incomplete snapshots as complete.
- Add a clear stale-data indicator, counts, last success and manual refresh. Support a configurable schedule only after a live baseline is measured. Keep secrets out of logs and URLs.
- Inspect the store's real identifier conventions and currency configuration before defining matching and price conversion. Do not assume every Google offer ID equals Woo SKU.

Acceptance: a representative initial import completes or produces an actionable endpoint/page error; cancellation and failed pages preserve the previous successful snapshot; repeated syncs do not duplicate records; product/variation/order counts and freshness are visible.

### Phase 1 — Shared table behavior

- Inventory the data tables on WooCommerce, Products, Issues, Market, Activity, Feeds, Workflows, settings lists and product details. Implement a reusable accessible table pattern: clickable header label with ascending/descending indicator and keyboard operation; one filter row immediately under the labels; clear/reset filters; empty/loading/error states; sensible date, number, money, enum and text filters.
- Sort and filter the **full result set before pagination**. Where tables are backed by server pagination, add validated, allowlisted server-side filtering/sorting and deterministic tie-breaking. Never imply the current page is the complete result.
- Preserve existing deep-linked filters, selections, pagination, actions and English/Polish translations. Define null and case handling, reset page on filter changes, debounce text entry, expose sort state with `aria-sort`, and support keyboard navigation.
- Keep wide tables usable at desktop and smaller widths: dedicated horizontal scrolling, visible or reachable actions, no clipped cells, and filters aligned with their columns. Tables that are genuinely key/value layouts or static explanatory content should be reviewed individually and any exception made explicit.

Acceptance: WooCommerce product/matching and order tables plus the existing app's applicable data tables conform to the shared behavior. Tests cover sorting and filtering across multiple pages, combined filters, reset, selection, accessibility and wide/narrow layouts.

### Phase 2 — Canonical product model and source-of-truth migration

- Add a canonical product/variation identity and persistent channel mappings with provenance, confidence, manual correction and audit history. Model multi-feed/multi-language Google records and multiple Allegro offers per product.
- Add field-level source policy and materialized/read models used consistently by product lists, detail, filters, dashboard, signals, exports and workflow contexts. Google remains authoritative for Google diagnostics/metrics, not for Woo-owned product fields.
- Build review flows for unmatched or ambiguous records, conflicts, changed/deleted source records, and store-only / channel-only products. Never overwrite a known value with an unknown field or infer currency.
- Audit all Google supplemental-feed and workflow writes: explicitly distinguish Google-specific enrichment from Woo-owned source edits. Define conflict handling and source ownership before enabling automatic writes.
- Provide a migration/backfill and a reversible staged rollout. Existing Google product IDs, metadata, issues, metrics and links must remain traceable. Compare old/new totals and surface discrepancies before switching views.

Acceptance: the same Woo-owned product values appear consistently in all relevant app views and workflow inputs for mapped products; channel statuses remain source-specific; ambiguous mappings cannot trigger automatic changes; Woo-only and channel-only records have an explicit lifecycle; a Google refresh cannot overwrite store-owned fields.

### Phase 3 — Allegro connection and read-only offers

- Introduce a marketplace connector contract and account-scoped configuration so Allegro is the first implementation, not a hard-coded assumption throughout the app. Separate sandbox and production endpoints, credentials, tokens, data and operations.
- Implement Allegro seller authorization using a supported user OAuth flow and encrypted token storage, automatic refresh with rotation, concurrent refresh protection, reconnect/revocation handling, least privilege and no token logging. Match the actual registered app and documented flow; do not assume the existing Google service-account method applies.
- Add sandbox/live connection status and diagnostics, account identity, read-only offer synchronization, pagination, rate-limit handling, freshness, cancellation, safe retry and audit. Keep offer event checkpoints and a recovery strategy if events are missed; the seller offer event feed has a limited retention window and is not a substitute for periodic reconciliation.
- Create offer list and detail views, common table controls, product-to-offer mapping and reconciliation, status/issues and source-vs-channel comparisons. Support unlinked offers and mapping review.

Acceptance: a seller can connect a sandbox account, see their own offers with correct status and map them to Woo products without any marketplace changes. Reconnect, expiry, duplicate events, missed event windows and failed pages are tested.

### Phase 4 — Allegro offer management

- Define an offer editor and mapping from Woo products and variations to Allegro offer fields. Cover existing catalog product lookup, category and parameter requirements, images, description, price, stock, delivery settings, return/complaint policies and listing validation. Show missing data and the proposed differences before submission.
- Support marketplace-specific Allegro prices per offer, with their own currency and clear distinction between the desired local value and the value currently published on Allegro. WooCommerce's price may be displayed as a reference but must not overwrite the Allegro price simply because a Woo sync ran. Whether price rules or automatic price updates are needed remains open.
- Add offer templates that can be created from existing Allegro offers as well as configured directly. The user can review and choose reusable fields, name and edit a template, and apply it to a selected Woo product/variation to prepare a new offer. Store template provenance (seller, environment, source offer and version) and separate reusable defaults from offer-specific identifiers, publication state, stock, product identity and other fields that must be reviewed for the new offer.
- Provide a preview and validation of the resulting offer, including category-specific requirements, images, delivery and policies. Handle missing or no-longer-valid source values. Applying or editing a local template does not itself publish or change an existing Allegro offer; creating a remote draft or publishing remains a separate, explicit action. Template updates should not silently modify offers already created from earlier versions.
- Implement the relevant current `/sale/product-offers` creation, detail and patch operations; handle asynchronous validation/processing and retrieve operation status where required. Add activate/end, price and quantity changes and appropriately tracked bulk commands where supported.
- Separate a local draft from an Allegro-created draft: explain when a request creates or modifies a remote record. Make production versus sandbox unmistakable. User-initiated writes are the initial default; any automated or bulk actions require explicit configuration, guardrails and an audit of actor, target, requested changes, outcome and external operation ID.
- Handle partial successes, optimistic conflicts, uncertain outcomes, idempotency where supported and verification by rereading the offer. Avoid blind retries of non-idempotent requests. Explicitly handle the Allegro documented edge case where ending an offer can succeed even if other edited fields fail.

Acceptance: in sandbox, create a reusable template from an existing offer, prepare a new offer for a different Woo product, review its marketplace-specific price and required fields, then create/validate, publish and end it. Confirm no source offer was changed and no old offer changed when the template was edited. Also test missing/stale category settings, duplicate IDs, invalid fields, price differences and partial/uncertain operations; report success only after Allegro confirms the outcome.

### Phase 5 — Sales, orders and inventory reconciliation

- Add Allegro order ingestion via order events and checkout forms; the offers API alone does not cover order fulfillment. Model payment, cancellation, readiness, shipment and fulfillment status separately, and use Allegro order revisions where relevant.
- Link order lines to marketplace offers and Woo products/variations. Design a cross-channel inventory policy that prevents overselling and duplicate stock decrements. The user will check whether an existing plugin imports Allegro orders or updates Woo stock before enabling any automatic write.
- If an existing integration is present, inventory its order import, stock and offer responsibilities, mappings, historical orders and any other affected behavior. Replace it only after the new implementation has the agreed functional coverage, tested migration/cutover and rollback plan. Avoid concurrent stock or order writers during cutover, and preserve traceability and deduplication for historical orders. The specifics depend on what is actually installed and must be verified.
- Choose and implement the order handoff to WooCommerce only after agreeing the desired behavior: read-only consolidated view, import/create Woo order, or another fulfillment system. Use durable external IDs and deduplication; handle repeated/out-of-order events and merged or cancelled orders. Do not silently create Woo orders or move stock.
- Add customer data only where needed for agreed fulfillment features, with restricted access, retention and redaction. Shipping, refunds, returns and invoicing are distinct capabilities that should be planned and prioritized after the initial offer/order flow.

Acceptance: sandbox scenarios cover an offer sale, duplicate and out-of-order events, cancellation, order change, inventory updates and reconnection. Each order is handled once, the app identifies conflicts, and stock ownership is explicit.

## 5. Cross-cutting requirements

- Authentication and secrets: encrypt credentials/tokens at rest, protect backup/session-secret handling, avoid credential leakage in logs, and scope connections by account and environment.
- Audit and observability: record actor, source, entity IDs, old/new values when appropriate, request/operation correlation, timestamps, status, errors and results. Show sync progress and freshness; support recovery after crashes and uncertain remote writes.
- Safety and concurrency: validate API data; detect stale edits; limit retries and request concurrency; use idempotency/command IDs where supported. Do not merge duplicate product identities or apply partial imports as successful snapshots.
- Tests: deterministic connector fakes and fixtures; database migration and rollback scenarios; API contract tests; browser tests for tables, progress and mapping; sandbox end-to-end tests before production usage. Never use real customer/order data as test fixtures.
- Reuse current services where practical: `SettingsService`, `EventLog`, scheduler and workflow patterns, while avoiding assumptions that every channel uses Google product names or Google authorization.

## 6. Decisions to confirm as work progresses

1. Which WooCommerce store and Allegro seller account(s), and whether multiple stores/accounts are needed in the first release?
2. Is a Woo variation always the unit of stock and sale, and how are products without SKU/GTIN handled?
3. Confirm the Allegro price workflow: manual per-offer values, optional pricing rules, and whether/when price updates are automatic. Prices are marketplace-specific; stock allocation policy is still undecided.
4. The user will check whether an existing plugin imports Allegro orders; if one exists, this solution is intended to replace it. Confirm its actual responsibilities, fulfillment system and whether this app should create Woo orders.
5. Which offer actions are required first: create drafts, edit, publish/end, price/stock changes, or bulk operations?
6. What should happen when a Woo product is deleted, unpublished or out of stock while an Allegro offer is active?
7. Which tables, if any, are explicitly exempt from sorting/filter controls because they are static key/value presentations?
8. Which offer fields should be reusable template defaults versus filled from each selected product? Should templates be shared across seller accounts or scoped to one account/marketplace?

The header/filter layout above is a proposed interpretation of “first row is a filter row”: filters are the first row **below the column labels**. Confirm if filters should instead appear before the labels.

## 7. References

- [Allegro: authentication and authorization](https://developer.allegro.pl/tutorials/uwierzytelnianie-i-autoryzacja-zlq9e75GdIR)
- [Allegro: offer management and offer events](https://developer.allegro.pl/tutorials/jak-zarzadzac-ofertami-7GzB2L37ase)
- [Allegro: creating offers linked to products](https://developer.allegro.pl/tutorials/jak-jednym-requestem-wystawic-oferte-powiazana-z-produktem-D7Kj9gw4xFA)
- [Allegro: orders and order events](https://developer.allegro.pl/tutorials/jak-obslugiwac-zamowienia-GRaj0qyvwtR)
- [Allegro REST API reference](https://developer.allegro.pl/documentation)
- [WooCommerce REST API](https://developer.woocommerce.com/docs/apis/rest-api/)
- [Current WooCommerce integration notes](woocommerce.md)
