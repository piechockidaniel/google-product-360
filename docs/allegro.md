# Allegro connector: current implementation

The Allegro page provides seller authorization and offer snapshots. An optional sandbox-only permission enables individual price, stock, activation and ending changes to existing offers. Production is read-only. The seller can create versioned local templates from selected fields of an existing offer and use those templates with a WooCommerce product and a separately entered marketplace price to prepare local drafts. These drafts are not sent to Allegro, and editing a template does not modify existing offers or older drafts.

Remote offer creation, production changes, order/fulfillment handling, automatic stock synchronization and replacement of an existing Allegro plugin are not implemented. WooCommerce has not yet replaced Merchant Center as the application-wide product source of truth. See [the project plan](woocommerce-allegro-plan.md) for remaining work.

## Setup and authorization

1. Register a web application with Allegro for the chosen environment. Sandbox and production use separate registered applications and seller accounts. Start with sandbox.
2. Enable the required scopes `allegro:api:sale:offers:read` and `allegro:api:profile:read` for that registered application. For sandbox changes also enable `allegro:api:sale:offers:write`.
3. Add the exact callback URI shown in the app, for example `http://localhost:8080/api/allegro/callback`, to the registered Allegro application. For a deployed instance use the correct HTTPS origin. Sign in to Product360 at that same origin.
4. On **Allegro**, select the environment, enter Client ID, Client Secret and callback URI, then save. Click **Connect Allegro** and complete the seller authorization. Credentials and access/refresh tokens are encrypted in the local database using `SESSION_SECRET` and never returned by the API.
5. Click **Sync offers**. A complete snapshot replaces the previous snapshot atomically; a failed import leaves the previous snapshot available. Offers and templates are scoped by environment and seller ID.

The connector uses authorization code with PKCE and binds the one-time state to the active Product360 session. Write access is requested only when explicitly enabled for sandbox; changing permissions requires reconnecting. It refreshes expired tokens using a database lease to avoid simultaneous rotations by local instances. Request logging strips query strings to keep authorization codes out of logs. The registration, token refresh and offer APIs have been tested with fakes; they have not yet been validated against a real Allegro sandbox account.

## Sandbox offer changes

Enable test offer changes in the sandbox connection settings, save, and reconnect with the expanded scope. In the offer list choose **Change offer**, select one action, review the displayed value and submit. The app rereads the offer first and refuses an outdated value; it keeps an operation history and does not automatically retry an uncertain request. Use **Check result** for pending or uncertain operations and sync the offer list again after a verified change. A timeout may leave the result uncertain; inspect Allegro before retrying. This is a test workflow and requires real sandbox validation before production support.

## Template behavior

From an offer, choose **Create template**, select reusable fields and inspect their values before saving. Offer/product identity, publication state, stock and price are excluded from templates; only the selling format is copied from `sellingMode`. Category, descriptions, images, delivery and policy settings may be specific to the original item or seller and must be reviewed. Template updates create new versions; local drafts preserve the version and values captured at creation.

**Prepare draft** selects a product from the last WooCommerce snapshot and requires a marketplace-specific price and currency. It stores a local review record; it does not validate category requirements or create a remote offer.

References: [Allegro authentication](https://developer.allegro.pl/tutorials/uwierzytelnianie-i-autoryzacja-zlq9e75GdIR), [offer management](https://developer.allegro.pl/tutorials/jak-zarzadzac-ofertami-7GzB2L37ase), [creating product offers](https://developer.allegro.pl/tutorials/jak-jednym-requestem-wystawic-oferte-powiazana-z-produktem-D7Kj9gw4xFA).
