# WooCommerce connection

The WooCommerce integration currently provides a read-only snapshot of products, product variations and orders. The WooCommerce page lists orders and compares WooCommerce SKUs with Merchant Center offer IDs. It does **not** yet make WooCommerce the source of truth for the existing product views, workflows, reports or Google enrichment. Those continue to use Merchant Center records. The WooCommerce snapshot and existing product catalog are separate until product identities and field ownership are reconciled.

## Setup

1. In WooCommerce, create a REST API key with **read** access to products and orders. Use the store's HTTPS address and enable WordPress permalinks.
2. In Product360, open **Settings → WooCommerce**, enter the store address, consumer key and consumer secret, and save. The key and secret are encrypted using the application's session secret. Keep `SESSION_SECRET` stable across restarts and back up the database and secret together.
3. Select **Test** to check both product and order permissions. Select **Sync** to import a snapshot. Automatic synchronization is off by default; optionally set an interval and startup sync in the WooCommerce settings. Google sync does not trigger WooCommerce sync.

During synchronization, the settings card displays the current stage, page and
number of records received. The progress reflects an in-process run and resets
if the app restarts. **Cancel sync** aborts the current request and keeps the
previous successful snapshot; a sync in progress has not published partial data. Sync run history and progress heartbeats are recorded in the local database; old runs with no heartbeat for five minutes are marked interrupted on startup. GET requests retry transient failures up to three times with bounded backoff.

The connector uses WooCommerce REST API v3 over HTTPS and sends credentials in the Authorization header. Redirects are rejected. Changing the store URL requires new credentials. Saved credentials are never returned by the settings API. Connection tests request one item per endpoint; synchronization requests 25 items per page with a 60-second timeout. Timeout errors identify the endpoint and page. A sync fetches every page and variable-product variation before atomically replacing the previous snapshot. If any request fails, the previous snapshot remains available.

The order snapshot intentionally excludes billing and shipping addresses, customer contact details, payment details and arbitrary metadata. It includes order status, totals, currency and basic line items. Product prices are the strings returned by WooCommerce; the products endpoint does not include a currency, so the app does not infer one.

## API

All routes require an authenticated application session:

- `PUT /api/woocommerce/config`: `{ "storeUrl": "https://shop.example", "consumerKey": "...", "consumerSecret": "..." }`. Credentials may be omitted when retaining them for the same store.
- `GET /api/woocommerce/status`: configuration and last successful snapshot counts/time.
- `POST /api/woocommerce/test`: test product and order read access.
- `POST /api/woocommerce/sync`: fetch a complete snapshot.
- `GET /api/woocommerce/products?limit=50&offset=0`: products and variations, including `parent_id` for variations.
- `GET /api/woocommerce/orders?limit=50&offset=0`: minimized orders and line items.
- `GET /api/woocommerce/reconciliation?status=all&limit=50&offset=0`: exact SKU/offer-ID proposals, confirmed links and counts; `status` can be `matched`, `ambiguous`, `unmatched` or `no_sku`. A proposal is marked unique only when the exact SKU is unique in both catalogs. Merchant-only counts are at the Google product-record level, including separate feeds/languages.
- `PUT /api/woocommerce/mappings` and `POST /api/woocommerce/mappings/remove`: explicitly confirm or remove a store/product-to-Google-product link. A Google product cannot be linked to two Woo products; one Woo product can have several Google feed/language links. Links are stored per store and survive snapshot refreshes, but **do not yet merge fields or change the app's source of truth**.

## Work needed before switching authority

WooCommerce product and variation IDs, SKUs, and Google offer IDs are not interchangeable. A safe switch needs an explicit, persistent mapping between WooCommerce entities and Merchant Center records, with ambiguous or missing matches surfaced for review. It also needs field-level ownership, handling for store-only and Google-only products, deletions and lifecycle transitions, consistent behavior for refreshes and workflows, scheduled synchronization, and tests for conflicts. Google statuses and metrics should remain Google-owned; store fields and orders should come from WooCommerce only after that reconciliation is in place. Existing Google enrichment writes must be reviewed against those ownership rules before authority is switched.
