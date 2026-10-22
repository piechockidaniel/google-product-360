---
doc: spec
status: approved
---

# Product360 Feed Rescue — Technical Spec

## How This Works, In Plain Language

Product360 is one Node application with two visible parts: a React page in the browser and a Fastify server that does the protected work.

The browser never receives Google refresh credentials. It receives an ordinary application session cookie. The server sends the user through Google OAuth, stores the returned refresh credential encrypted in SQLite, and uses Google’s official libraries to obtain short-lived access tokens whenever a background operation needs them.

The server has two data providers. Live mode reads and writes Merchant API data. Demo mode reads clearly labeled synthetic data from local fixtures and follows the same product, issue, remediation, pattern, operation, and audit flow. Demo mode proves the experience without pretending that Google was contacted.

Products shown in the grid are processed Google products. When the operator approves a correction, Product360 writes a `ProductInput` to a dedicated supplemental API data source, then waits for Google to process the result and reads the product again. The original file feed is not overwritten.

Every operation has a durable record and an append-only event trace. The background worker continues after the browser closes. When the operator returns, the UI reads the current operation and product state from SQLite.

An approved user decision can become a persistent pattern. The pattern describes what to match, what change to propose, what evidence supported it, and whether it is enabled. Future synchronizations can evaluate enabled patterns and present matching rows for an explicit batch approval.

## The Core Journey Through the System

PRD ref: `prd.md > The Core Journey`.

1. The browser requests Google sign-in from the Fastify server.
2. Fastify redirects to Google OAuth with the Merchant API scope. Google returns an authorization code to the server callback.
3. The server exchanges the code, encrypts the refresh credential with `APP_ENCRYPTION_KEY`, stores it in `connections`, and creates an application session in an `HttpOnly`, `Secure`, `SameSite` cookie.
4. The setup wizard calls the server for prerequisite checks. The server uses the official Accounts, Data Sources, Products, and issue-related clients; demo mode uses the fixture provider instead.
5. A failed check creates a failed setup event and returns a blocking, root-cause-oriented result. No sync or write operation is started.
6. A successful check starts a synchronization operation. The worker lists processed products, account issues, data sources, and relevant product status data, normalizes them, and stores the current snapshot in SQLite.
7. The browser requests the grid view. Fastify reads the normalized snapshot, separates account-level issues from product-level issues, applies filters, and returns the grid model.
8. The analyzer evaluates a predictable missing or price-related attribute rule against comparable products. It returns evidence, a proposed value, and a confidence decision; it cannot write to Google.
9. A Quick Fix or user-confirmed pattern creates an operation. The worker ensures a dedicated supplemental API data source exists, records explicit approval, writes the `ProductInput`, and records every step.
10. The worker re-reads the processed product after Google’s processing delay. The UI shows success, failure, or Google-side pending state. A later poll or notification reconciliation updates the durable record.

## Stack

- **Runtime:** Node.js `>=22.13` with TypeScript. Node 22 provides the built-in `node:sqlite` API used by the server.
- **Server:** Fastify. It serves the production client build, exposes JSON routes, validates requests, and owns OAuth, Google calls, persistence, and workers.
- **Client:** React with Vite. Development uses the Vite dev server; production uses the built client served by Fastify.
- **Database:** SQLite through `node:sqlite`. JSON columns hold preserved Google payloads and evidence where a fully normalized field is not needed.
- **Google authentication:** `google-auth-library` with OAuth web-server flow and refresh-token support.
- **Google API access:** Official Node.js Merchant API clients for Accounts, Products, Data Sources, Reports, Notifications, and supported issue services. A small adapter hides generated client types from the rest of the app.
- **Encryption:** Node `node:crypto` using authenticated encryption for the stored refresh credential. No native encryption module is required.
- **Validation:** TypeScript types plus Fastify route schemas. No general-purpose state or UI framework is required for the POC.
- **Tests:** Node’s built-in test runner for server/domain behavior and a focused browser smoke path for the demo journey.

Documentation: [Node.js](https://nodejs.org/docs/latest-v22.x/api/), [`node:sqlite`](https://nodejs.org/api/sqlite.html), [Fastify](https://fastify.dev/docs/latest/), [React](https://react.dev/), [Vite](https://vite.dev/guide/), [Google OAuth for Node](https://github.com/googleapis/google-auth-library-nodejs), [Merchant API Node.js clients](https://developers.google.com/merchant/api/client-libraries/nodejs).

## Where It Runs and How Someone Tries It

Product360 runs locally or in one Docker container on a VPS. The production process is the Fastify server; it serves the React build and runs the background worker in the same process.

Required runtime:

- Node.js `22.13` or newer for local development.
- A writable SQLite database path.
- `APP_ENCRYPTION_KEY` for encrypting OAuth refresh credentials.
- Live mode: Google OAuth client ID, client secret, registered callback URL, and the Merchant API enabled in the Google Cloud project.
- Demo mode: no Google credentials; synthetic data is loaded from `server/demo/fixtures/` and every relevant screen carries a `DEMO DATA` label.

Development commands:

```text
npm install
npm run dev
```

Open the Vite development URL shown by the command. For the live demo, configure the OAuth callback and use a Google account authorized for the Merchant Center account. For the reliable hackathon recording, demo mode must be available as a clearly labeled fallback.

Production commands:

```text
npm run build
npm start
```

The required submission proof remains a short demo video and public GitHub repository. Deployment is optional.

## Look and Feel

PRD ref: `prd.md > Look and Feel`.

Use one clean, technical, Vite-inspired theme. The grid should be information-dense but readable, with strong status/severity signals, compact controls, and calm operational copy. The setup wizard should feel like a guided readiness check, not a generic account form. Processing, blocked, and Google-side pending states must be visually distinct.

Use a single theme in the POC. Do not add a theme switch or a general design-system abstraction before the core journey works.

## Components

### Client application shell

Owns routing between sign-in, setup, grid, detail pane, operation trace, and feed-import views. It displays the current connection mode and the `DEMO DATA` label when applicable.
PRD ref: `prd.md > Screens and Layout`, `prd.md > Look and Feel`.

### OAuth and session routes

Starts the Google OAuth flow, handles the callback, creates or refreshes the application session, and exposes only non-secret connection status to the browser.
PRD ref: `prd.md > Authentication and setup gate`.

### Setup readiness service

Runs prerequisite checks in a deterministic order, records progress events, and returns blocking causes and next steps. It never starts synchronization when a required check fails.
PRD ref: `prd.md > Authentication and setup gate`, `prd.md > States and Boundaries`.

### Google Merchant adapter

Wraps official Node clients behind Product360 methods such as `listProcessedProducts`, `listAccountIssues`, `listDataSources`, `createSupplementalSource`, `insertProductInput`, `getProcessedProduct`, and supported notification operations. It translates Google errors into safe domain errors without logging tokens.
PRD ref: `prd.md > Synchronization and initial state`, `prd.md > Complex issues and user decisions`.

### Demo provider

Implements the same adapter interface with synthetic products, account issues, product issues, processing delays, and deterministic success/failure outcomes. It labels all data and never reports a live Google call.
PRD ref: `prd.md > Synchronization and initial state`, `prd.md > What We're Building`.

### Synchronization worker

Runs durable sync operations after setup succeeds. It fetches products and account issues, normalizes them, stores snapshots, and emits progress and completion events.
PRD ref: `prd.md > Synchronization and initial state`, `prd.md > Background operations and audit history`.

### Issue normalizer and analyzer

Maps account-level and product-level Google responses into one internal issue shape while preserving raw payloads. The analyzer applies deterministic peer-consistency rules for the first Quick Fix. An optional AI advisor may explain or suggest patterns later, but it cannot directly write to Google.
PRD ref: `prd.md > Product issues and predictable remediation`, `prd.md > Complex issues and user decisions`.

### Pattern service

Stores approved remediation patterns, evaluates enabled patterns against synchronized products, previews matches, and creates a batch operation only after explicit user approval.
PRD ref: `prd.md > Product issues and predictable remediation`, `prd.md > Product Decisions`.

### Operation worker

Runs Quick Fix, batch pattern, feed-import, and refresh operations independently of the browser. It creates a correlation ID, appends events, locks conflicting scopes, performs supported Google writes, and reconciles results after processing.
PRD ref: `prd.md > Background operations and audit history`, `prd.md > States and Boundaries`.

### Read-only trace viewer

Shows the ordered event chain for setup, synchronization, data-source creation, approvals, writes, Google responses, retries, and final state. It redacts credentials and does not permit event editing.
PRD ref: `prd.md > Background operations and audit history`.

### Feed importer

Accepts uncompressed `.txt`, `.tsv`, and `.xml` product files. It validates basic encoding and structure, maps supported fields into normalized product inputs, preserves the original file metadata, and reports unsupported or malformed rows. It does not claim to implement Google’s complete product attribute specification.
PRD ref: `prd.md > States and Boundaries`, `prd.md > What We're Building`.

## Data Model

The database is local SQLite. Every durable record includes timestamps and a mode (`demo` or `live`) where relevant.

### `connections`

Stores the Google subject identifier, Merchant Center account identifier, mode, encrypted refresh credential, encryption version, connection status, and last verification time. The access token is never stored. The server decrypts the refresh credential only while creating a Google client.

### `sessions`

Stores a hashed application session verifier, expiry, Google subject reference, and timestamps. The browser cookie contains only a random opaque session value.

### `products`

Stores the Merchant resource name, offer ID, language, feed label, supplier, data-source name, normalized display fields, current status, serialized raw product payload, and last synchronization time. The processed product is read state; write operations target `ProductInput` separately through the adapter.

### `issues`

Stores account-level or product-level scope, scope reference, code, title, severity, attribute, destination/region impact, detail, documentation URI, raw payload, observed time, and resolution state.

### `patterns`

Stores a versioned matching condition, proposed attribute change, evidence summary, originating approval, enabled state, creator, and timestamps. Raw credentials never appear in pattern data.

### `operations`

Stores the operation type, mode, affected scope, parent pattern, status, correlation ID, start/end times, and final result summary.

### `operation_events`

Append-only trace rows with operation ID, sequence, event type, redacted payload, severity, timestamp, and optional external resource reference. Events are read-only in the UI.

When the browser closes, all product, pattern, operation, and event state remains in SQLite. A server restart preserves everything except in-memory access tokens; the encrypted refresh credential obtains a new access token when the worker resumes.

## File Structure

```text
product-360-with-extras/
├── client/
│   ├── src/
│   │   ├── app/
│   │   ├── components/
│   │   ├── features/
│   │   │   ├── auth/
│   │   │   ├── setup/
│   │   │   ├── products/
│   │   │   ├── issues/
│   │   │   ├── patterns/
│   │   │   ├── operations/
│   │   │   └── feed-import/
│   │   ├── api/
│   │   └── styles/
│   └── vite.config.ts
├── server/
│   ├── src/
│   │   ├── app.ts
│   │   ├── config.ts
│   │   ├── http/
│   │   ├── auth/
│   │   ├── db/
│   │   ├── google/
│   │   │   ├── clients.ts
│   │   │   ├── merchant-adapter.ts
│   │   │   └── error-mapping.ts
│   │   ├── demo/
│   │   │   ├── provider.ts
│   │   │   └── fixtures/
│   │   ├── sync/
│   │   ├── issues/
│   │   ├── patterns/
│   │   ├── operations/
│   │   ├── audit/
│   │   └── feeds/
│   └── test/
├── devpost/
├── package.json
├── tsconfig.json
├── Dockerfile
├── .env.example
└── README.md
```

`devpost/` remains the planning workspace. Secrets, local SQLite files, and OAuth callback material are ignored and never committed.

## External Services and Dependencies

### Google OAuth 2.0

The server uses the web-server OAuth flow and requests the Merchant API scope `https://www.googleapis.com/auth/content`. Access tokens are short-lived; the encrypted refresh credential is used to obtain new ones. The OAuth client ID, client secret, and callback URL are deployment inputs, not user-entered product settings.

Docs: [Merchant API authentication](https://developers.google.com/merchant/api/guides/quickstart/authentication?hl=en), [third-party authorization](https://developers.google.com/merchant/api/guides/authorization/access-client-accounts?hl=en), [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2/).

### Merchant API Accounts

- List accessible accounts during setup when account selection is needed.
- List account issues with the Accounts issue service.
- Use account issue severity, detail, destination impact, and documentation URI in the normalized issue model.

Docs: [Accounts reference](https://developers.google.com/merchant/api/reference/rest/accounts_v1), [account issues](https://developers.google.com/merchant/api/guides/accounts/view-issues?hl=pl).

### Merchant API Products

- `products.list` reads final processed products and their `productStatus`.
- `products.get` re-reads an affected processed product after a write.
- `productInputs.insert` writes a correction to a selected API data source.
- Required input identity includes `offerId`, `contentLanguage`, and `feedLabel`; the adapter also carries the selected data-source resource name.

Docs: [Products data and issues](https://developers.google.com/merchant/api/guides/products/list-products-data-issues), [ProductInput insert](https://developers.google.com/merchant/api/reference/rest/products_v1/accounts.productInputs/insert), [product management](https://developers.google.com/merchant/api/guides/products/overview).

### Merchant API Data Sources

- `dataSources.list` checks available sources.
- `dataSources.create` creates the dedicated supplemental API source after explicit user approval.
- The created source name is stored and reused for later Product360 corrections.

Docs: [Data Sources](https://developers.google.com/merchant/api/guides/data-sources/overview), [data source types](https://developers.google.com/merchant/api/guides/data-sources/manage-various-data-sources).

### Notifications and reconciliation

Notifications or polling may reconcile long-running operations. The first implementation must support durable polling fallback; notification setup is optional until the exact supported event and hosting requirements are verified.

Docs: [Notifications overview](https://developers.google.com/merchant/api/guides/notifications/overview).

### Demo fixtures

Demo mode has no external service. Fixtures must include at least one predictable missing-attribute issue, one conflicting-evidence issue, one account-level issue, one successful operation, and one Google-side pending operation. All screens must identify demo data.

## Important Failure Modes

- **OAuth denied or refresh credential invalid** → keep the user in setup, show the cause and reauthorization action, and do not start sync.
- **Google API access or data source unavailable** → block the dependent operation, record the trace, show the exact supported next step, and do not silently fall back to a write.
- **Google processing exceeds 30 seconds** → persist `GOOGLE_PROCESSING`, unlock only non-conflicting scopes, and reconcile later without requiring the browser to remain open.
- **Feed file malformed or unsupported** → preserve import metadata, identify the first actionable parsing problem, and do not send partial live writes.
- **Peer evidence conflicts** → show the detailed pane and require explicit user confirmation; no automatic pattern is created.

## What Was Simplified and Why

- **One Fastify production service** instead of separate deployable frontend and backend services — fewer deployment variables for a VPS/Docker POC.
- **SQLite** instead of a hosted database — local durability is enough for the single-operator proof and avoids external infrastructure.
- **Deterministic analysis** instead of an AI model on the write path — it keeps automatic remediation explainable and avoids a paid or unreliable critical dependency.
- **AI advisor as an optional future layer** instead of a required service — the learner’s AI goal remains available without allowing opaque model output to write to Google.
- **One supplemental API data source** instead of editing the original feed — it follows Merchant API’s ProductInput model and preserves source ownership.
- **Three uncompressed input formats** instead of every Google-supported archive and delivery method — `.txt`, `.tsv`, and `.xml` demonstrate feed ingestion without archive or transport complexity.
- **Durable polling fallback** instead of requiring notifications for the first build — the app remains demonstrable on a local machine while preserving the later notification boundary.

## Decisions and Open Issues

- **OAuth is primary** — it fits a generic product that may manage multiple businesses and avoids service-account key upload.
- **Refresh credentials are encrypted server-side** — browser storage is not trusted for credentials; the encryption key is a deployment secret.
- **Official Google clients are primary** — they reduce auth and pagination mistakes; the adapter keeps the rest of the app stable.
- **Demo and live providers share one interface** — the synthetic path is clearly labeled and never presented as live evidence.
- **Supplemental API data source is the write target** — the original file feed is preserved.
- **Approved patterns persist** — a user decision can be reused across future synchronizations, with explicit enable/disable control.
- **Trace is read-only but visible** — operators can inspect the full path without editing evidence.

The learner’s useful uncertainty was whether browser local storage or cookies could safely retain the Google credential. That was clarified by separating browser session cookies from server-held encrypted refresh credentials; browser storage will not contain Google credentials.

Open issues before implementation:

- Verify the exact Node package names and methods for each required Merchant API v1 sub-API during the first build step.
- Verify the Google Cloud OAuth consent/verification requirements for the selected live test account.
- Define the first deterministic peer-matching rule and its evidence threshold in code-facing terms.
- Confirm the live feed-import mapping from `.txt`, `.tsv`, and `.xml` rows to ProductInput fields; unsupported attributes must be reported, not silently dropped.
- Verify whether the selected issue-resolution actions are available to the OAuth application; unsupported actions remain read-only or diagnostic.
