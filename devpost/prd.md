---
doc: prd
status: approved
---

# Product360 Feed Rescue — Product Requirements

One line: A self-hosted diagnostic and remediation workspace for a small ecommerce operator managing Google Merchant Center products.
Source: `scope.md > The Unique Kernel`, `scope.md > Who It's For`.

## The Core Journey

Source: `scope.md > The Core Loop`, `scope.md > What "Working" Looks Like`.

1. The operator opens Product360 and signs in with Google.
2. Product360 opens a setup wizard that requests Merchant API authorization through Google OAuth.
3. The wizard validates the granted access and checks the Google access and API prerequisites needed for synchronization. It shows progress as each check runs.
4. If any check fails, the wizard stops. It identifies the core cause, explains the consequence, and shows the next available remedy. No partial synchronization or remediation is started.
5. When every check succeeds, Product360 synchronizes the available product and account state, opens the product grid, and shows a success toast.
6. The operator reviews product rows and account-level diagnostics. Product issues remain attached to their products; account issues are shown separately as account-wide impact.
7. For a predictable product issue, the operator can use `Quick Fix`. For an uncertain or complex issue, the operator opens the detailed product pane and decides after reviewing the evidence and consequences.
8. Any triggered action continues in the background independently of the browser window. The operator sees `Processing` for up to 30 seconds, with other operations for the affected scope locked during that period.
9. If Google responds within 30 seconds, Product360 shows the result and unlocks the affected operations. If not, it shows that Google is still processing; a later notification or refresh updates the durable status.
10. The operator can close and reopen the app at any point. The product grid and audit history show the current durable state rather than assuming the previous browser session continued.

## Screens and Layout

Source: `scope.md > The Core Loop`, `scope.md > The POC Boundary`.

### Google sign-in

The entry surface lets the operator authenticate with Google. No product operations are available before authentication succeeds.

### Setup wizard

The wizard is the first post-login surface. It contains:

- Google OAuth consent for Merchant API access.
- Validation and prerequisite-check progress.
- A clear result for each check.
- A blocking error presentation when a check fails, including the core cause, impact, and available next step.
- A completion state that enables synchronization only after all required checks pass.

### Product grid

The grid is the primary working surface after successful setup and synchronization. From left to right, each product row contains:

1. Selection checkbox for batch operations.
2. Product thumbnail.
3. Product ID.
4. Name or title.
5. Supplier.
6. Feed.
7. Price.
8. Availability.
9. Product status.
10. Issues summary.
11. State-dependent actions.

Account-level diagnostics must be visually distinct from product-row issues. The exact placement of the account-level summary is a layout decision for `4-spec`; it must not imply that an account issue belongs to one product.

When filters are active and no rows are visible, the empty state suggests clearing the filters. When no filters are active and synchronization returns no products, the empty state explains that no products are available and offers in-app feed management, including feed upload.

### Detailed product pane

The pane opens for complex or uncertain product issues. It shows the issue source, all known issues, affected attributes or destinations where available, proposed remediation, supporting evidence, possible consequences, and the explicit action required from the operator.

## Look and Feel

Source: learner interview and `scope.md > Inspiration & Identity`.

Product360 should feel Vite-inspired: clean, fast, lightweight, technical, and appropriate for an operator console. The interface should be information-dense without becoming confusing, with clear status and severity treatment. The proof of concept uses one coherent theme; user-selectable themes are deferred.

## Features and Behavior

### Authentication and setup gate

Source: `scope.md > The Core Loop`, `scope.md > The POC Boundary`.

- The operator signs in with Google before accessing product data.
- The wizard starts Google OAuth consent for the Merchant API scope.
- The wizard validates the input and runs the required access checks with visible progress.
- A failed check blocks the rest of the workflow. The message identifies the root cause, consequence, and available remediation.
- The app does not start partial synchronization or remediation after a failed setup check.
- Google refresh credentials are retained only on the server in protected storage and are never placed in browser storage, audit history, or source control.

Acceptance criteria:

- [ ] An unauthenticated operator cannot reach the product grid.
- [ ] Missing, denied, or unusable OAuth access produces a specific, actionable setup error.
- [ ] A failed prerequisite leaves synchronization unavailable.
- [ ] A fully successful setup visibly enables the synchronization transition.

### Synchronization and initial state

Source: `scope.md > What "Working" Looks Like`.

- A successful setup initiates product and account-state synchronization.
- The completed synchronization opens the product grid and shows a success toast.
- The grid reflects the current synchronized state, including product status, product issues, and account-level issues.
- A synchronization result with no products follows the filter-aware empty-state rules.

Acceptance criteria:

- [ ] The success toast appears only after the required synchronization completes successfully.
- [ ] Product rows contain all eleven agreed columns.
- [ ] Account-level issues are not represented as ordinary product-row issues.
- [ ] The empty state gives a useful next action instead of showing a blank grid.

### Product issues and predictable remediation

Source: `scope.md > The Unique Kernel`, `scope.md > The POC Boundary`.

- Product issues are classified as predictable/simple or uncertain/complex.
- A missing required or price-related attribute is a candidate for predictable remediation when comparable products in the same category provide consistent evidence.
- The analysis may use static rules or AI assistance, but the result must be explainable before any automatic change is applied.
- `Quick Fix` is available only when the proposed value and outcome are sufficiently clear and safe.
- Product360 writes approved corrections to a dedicated supplemental API data source, leaving the original file feed unchanged.
- An approved correction can be saved as a persistent pattern with matching conditions, proposed change, evidence, approval, and version.
- Batch operations may apply a qualifying rule to selected products or an eligible dataset, but every affected product must remain identifiable in the audit history.
- When evidence conflicts or confidence is insufficient, `Quick Fix` is unavailable and the detailed product pane is used instead.

Acceptance criteria:

- [ ] A candidate Quick Fix shows the missing or incorrect attribute and the proposed replacement.
- [ ] The user can see why comparable products support the proposal.
- [ ] Conflicting evidence prevents silent automatic application.
- [ ] A batch operation does not hide which products were included or excluded.
- [ ] A saved pattern can be reviewed, enabled, disabled, and applied to future matching products.

### Complex issues and user decisions

Source: `scope.md > The Core Loop`, `scope.md > Explicitly Cut`.

- The detailed pane explains where the issue comes from, what it affects, the possible remediation paths, and the consequences of each path.
- The operator remains responsible for approving uncertain or complex actions.
- Product360 does not promise in-app resolution for Google-controlled actions that the relevant API does not expose to the application.
- Account-level issues are displayed with their severity, impact, details, and available documentation or supported action information.

Acceptance criteria:

- [ ] The operator can distinguish product data problems from account-level blockers.
- [ ] An uncertain action cannot be submitted without an explicit user confirmation.
- [ ] Unsupported or externally controlled actions are explained rather than represented as available Quick Fixes.

### Background operations and audit history

Source: `scope.md > What "Working" Looks Like`.

- Triggered operations continue independently of the browser session.
- The affected row or dataset shows a processing state and loader for up to 30 seconds.
- Conflicting operations for the affected scope are locked while the operation is actively being monitored.
- A confirmed result unlocks the affected operations and updates the visible state.
- A timeout changes the visible state to Google-side processing rather than treating the operation as failed.
- Later notifications or refreshes reconcile the durable state.
- Audit history records the actor, time, affected scope, issue, evidence or reason, proposed action, submitted action, processing state, and final result. It must not record OAuth refresh credentials.
- The operation trace is visible in a read-only UI view and links every event to its parent operation.

Acceptance criteria:

- [ ] Closing the browser does not cancel a submitted operation.
- [ ] Reopening the app shows the current durable operation state.
- [ ] The UI distinguishes success, failure, and still-processing outcomes.
- [ ] Every automatic, batch, and user-confirmed action has a traceable audit entry.

## States and Boundaries

- **First use** — The operator sees Google sign-in and cannot access product data until authentication succeeds.
- **Setup in progress** — The wizard shows the current validation or API-check progress.
- **Setup blocked** — A failed check stops the workflow and shows root cause, impact, and next step.
- **Setup complete** — All required checks pass and synchronization becomes available.
- **Normal grid** — Synchronized product rows show current state and state-dependent actions.
- **Account issue present** — Account-wide issues are shown separately with severity, impact, details, and available supported guidance.
- **Product issue present** — The row shows an issue summary and either `Quick Fix` or a path to the detailed pane.
- **No products with filters** — The empty state suggests clearing filters.
- **No products without filters** — The empty state explains the absence and offers in-app feed management or feed upload.
- **Processing** — The affected scope shows a loader, locks conflicting operations, and continues independently in the background.
- **Google-side processing** — After the 30-second UI window, the operation remains visible as pending and waits for later reconciliation.
- **Completed or failed** — The result is shown, the affected scope is unlocked, and the audit entry is finalized.
- **Reopened session** — The UI is reconstructed from durable current state, not browser-session assumptions.
- **Permission boundary** — Product360 shows or invokes only Google actions available to its authenticated account and API access; it does not claim to resolve every Google issue in-app.

## Product Decisions

- The setup wizard is a hard gate — partial synchronization and partial remediation would make the initial state ambiguous.
- OAuth authorization is the primary connection path — it avoids service-account key handling and better supports a generic product for multiple businesses.
- Product360 writes fixes through a supplemental API data source — the original feed remains the source being diagnosed and is not overwritten.
- A user-approved correction can become a persistent pattern — the product can reuse a validated decision without requiring the user to repeat it.
- The POC accepts uncompressed `.txt`, `.tsv`, and `.xml` product files — these are the supported first input formats; compressed files are deferred.
- Predictable missing-attribute and price-attribute cases may receive Quick Fix treatment — peer consistency can provide useful evidence.
- Uncertain cases require a transparent user decision — the operator must see evidence and consequences before acting.
- Background operations outlive the UI session — closing a browser must not cancel work.
- The first response window is 30 seconds — the user receives immediate feedback without pretending that Google processing is synchronous.
- Account issues and product issues are separate concepts — account-level problems can affect many products and must not be misrepresented as row-local failures.
- One visual theme is used in the POC — theme switching does not prove the core kernel.
- Operators should not need to visit Merchant Center for normal actions — developer-only provisioning and Google-controlled exceptions are outside that promise.

## What We're Building

- Google sign-in.
- A Google OAuth setup wizard with prerequisite checks and blocking errors.
- Initial product and account-issue synchronization.
- The agreed product grid and filter-aware empty states.
- Separate account-level and product-level diagnostics.
- One explainable Quick Fix path for a predictable missing or price-related attribute case.
- A detailed product pane for uncertain issues and explicit user decisions.
- Persistent remediation patterns with enable/disable and future matching.
- Durable background operation state with a 30-second active monitoring window.
- In-app feed management entry point and `.txt`, `.tsv`, or `.xml` upload for the no-products state.
- Audit history for automatic, batch, and user-confirmed operations.
- One Vite-inspired visual theme.

## Deferred From the POC

- General visual workflow builder — it is broader than proving the first diagnostic/remediation loop.
- Cron, event, and webhook orchestration — background processing is needed now, but general workflow triggers are not.
- Full Market Insights, performance, competitor, price-benchmark, best-seller, and Search Console collection — analytics comes after reliable product state and remediation.
- Five scores and the full recommendation taxonomy — one explainable remediation path is enough for the first proof.
- Broad supplemental-data enrichment and sale-price scheduling — not required to prove feed issue rescue.
- Multiple remediation types — they add write-side risk before the first path is understood.
- Full multilingual Polish and English experience — localization can follow the core interaction.
- Theme switching — deferred by learner decision.

## Possible Later Enhancements

- Add more deterministic remediation rules after audit results show which issues recur.
- Add AI-assisted pattern discovery across product, account, and performance data with visible evidence.
- Add workflow composition around approved actions and durable events.
- Add notifications and richer reconciliation views for long-running Google operations.
- Add generic account onboarding, credential rotation, multi-tenant separation, and monetization capabilities.

## Non-Goals

- Product360 is not a replacement for every Merchant Center screen.
- Product360 does not bypass Google policy decisions or guarantee resolution of account-level issues.
- Product360 does not silently invent product values when peer evidence is inconsistent.
- Product360 does not treat a browser timeout as proof that a Google-side operation failed.
- Product360 does not expose OAuth refresh credentials or private keys in browser storage, audit records, source control, or ordinary product views.

## Open Questions

- **Must resolve before `4-spec`:** What peer-matching and evidence rule makes a proposal sufficiently clear and safe for automatic application?
- **Must resolve before `4-spec`:** Which feed upload path maps an imported `.txt`, `.tsv`, or `.xml` file to the live or demo data model?
- **Must resolve before `4-spec`:** Which account and product issue surfaces are available to the authenticated integration, including any allowlist requirement for issue-resolution actions?
- **Can be investigated in `4-spec`:** Whether completion is reconciled by polling, push notification, or both, and how the 30-second window transitions into durable pending state.
- **Can be investigated in `4-spec`:** The exact placement of account diagnostics relative to the product grid.
