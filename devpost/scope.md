---
doc: scope
status: approved
---

# Product360 Feed Rescue

One line: A self-hosted Merchant Center product view that finds feed-delivered product failures, explains them, and records safe remediation.

## The Unique Kernel

Product360 brings together product information and issues that are spread across Google's product-related APIs and interfaces, then closes the loop with a suggested or automated action and an audit record. The first proof of concept makes one failed feed product understandable and actionable instead of requiring the operator to visit several Google UIs.

## Who It's For

The first user is the learner's wife, who runs a small ecommerce business. She needs to understand why products delivered by a feed are failing and what should happen next; today that information is distributed across Merchant Center and related Google services.

## The Core Loop

The operator authenticates with Google OAuth, grants Product360 Merchant API access, and Product360 verifies the required access before synchronizing product and account state. The server keeps the authorized connection available for background work without requiring the operator to upload a service-account key. The operator opens the product grid, finds failed products, reads their issues and suggested remedy, applies an available action when appropriate, and returns later to see what changed and why it was recorded.

## Inspiration & Identity

No external reference was volunteered. The product should feel like a practical operations console: consolidated, explainable, security-conscious, and auditable.

## Why This Matters to the Learner

The learner wants a better understanding of Google's API solutions and a practical way to work with product-scoped information. They also want to improve their skills in hackathon challenges and specification-driven development. The tool has immediate value for a family ecommerce business, could later become a generic monetizable product, and will be the hackathon submission.

## What "Working" Looks Like

In a short on-screen demo, the operator logs in, initializes product state, opens the grid, selects a product that failed through the feed, sees its current status and issues, reads a suggested solution, performs one supported remediation or records the action as a dry run, and sees the resulting audit entry. The compelling moment is that one product's failure becomes an explainable, traceable next action without switching between separate Google interfaces.

## The POC Boundary

- Google OAuth login for the operator.
- A setup wizard that completes Google OAuth consent, validates required access, and stores only a protected server-side refresh credential for background work.
- Initial product synchronization from the relevant Merchant Center product/feed API surface.
- A product grid showing current status and issues for synchronized products.
- One clearly defined issue-to-remediation path, with a safe dry-run fallback if a live write is not appropriate for the first build.
- A persistent approved remediation pattern that can match and apply the same decision to future products.
- In-app import of uncompressed Google-compatible `.txt`, `.tsv`, and `.xml` product files.
- An audit trail for synchronization, recommendations, attempted actions, and outcomes.

## Later

- A general visual workflow builder with cron, event, and manual triggers.
- Broad product enrichment, supplemental data sources, webhooks, and scheduled sale-price workflows.
- Nightly Market Insights, performance, competitor, price-benchmark, best-seller, and Search Console collection.
- Five product scores, explainable recommendations across all product categories, and a dedicated Market page.
- Polish and English UI, broader API coverage, reusable multi-tenant productization, and monetization.

## Explicitly Cut

- A complete Merchant Center replacement: it would obscure the small experiment and exceed the hackathon time budget.
- Multiple automated remediation types: one path is enough to prove the kernel and keeps write-side risk manageable.
- Full analytics and AI pattern discovery: valuable later, but the first proof must establish reliable product state, issues, action, and audit history first.
- Service-account credential setup as the primary operator flow: OAuth is the POC path; service accounts remain a later in-house/deployment mode.
- Automatic in-app resolution of every Google account issue: Google controls which issue-resolution actions are available to third-party applications.
