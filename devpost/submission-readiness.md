---
doc: submission-readiness
status: technical-preparation
---

# Product360 Feed Rescue — Submission Readiness

This is a technical handoff for preparing the Build With AI Basics submission. It does not replace the learner-written Devpost answers.

## Public Access

- Repository: `https://github.com/piechockidaniel/google-product-360`
- Optional live demo: `https://gmc.connect-the-dots.biz/`
- The fresh live demo opens the administrator setup wizard; create a local demo account there.
- Demo mode is synthetic and clearly reports `mock: true`; it does not use a Google account or Merchant Center data.

## What To Record

Use the live demo for the required short video. Keep credentials, server terminals, and unrelated browser tabs out of the recording.

1. Open the demo URL and create an administrator account in the setup wizard.
2. Show the labelled Demo mode and the Product360 dashboard.
3. Open Products and show the agreed product grid, including status and issue summary.
4. Open a predictable product issue and read the evidence, proposed correction, and consequence.
5. Approve one Demo Quick Fix and show its running/completed state.
6. Open Activity and show the read-only operation trace.
7. Return to the product row and show the corrected status.

## Technical Evidence

- Production checks passed: `npm run check` — 113 tests passed; coverage thresholds passed.
- Production build passed: `npm run build`.
- Demo service: `gmc-manager-demo`, isolated database `data/demo.sqlite`, loopback port `8091`.
- Demo uses `DEMO_MODE=true` and `MERCHANT_MOCK=true`; production OAuth and service-account variables are not inherited by the demo service.
- Public demo health check returned `200 OK` with `mock: true` and `configured: true`.
- The reset public demo reports `needsAdmin: true`, so a new visitor can create the first account through the wizard.
- Public demo checks returned a successful session, four products, Settings, and shipping data.
- TLS is enabled for `gmc.connect-the-dots.biz` and renews through Certbot.

## Learner-Owned Submission Items

Complete these in the current Devpost form; do not copy generated prose without reviewing it in your own words.

- [ ] Choose/confirm the project name from `devpost/scope.md`.
- [ ] Write the project short description and remaining submission answers.
- [ ] Upload the short demo video and verify that reviewers can watch it without authentication.
- [ ] Confirm the public GitHub repository contains no credentials, private data, or personal profile notes.
- [ ] Complete the Devpost exit survey.
- [ ] Submit on Devpost only after the video, repository, and form fields are ready.

## Known Scope Boundary

The deployed live demo proves the synthetic Product360 journey. Live Merchant Center synchronization, Google-side remediation, and the remaining unchecked build slices are not represented as completed by this document.
