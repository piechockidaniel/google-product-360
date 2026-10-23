# GMC Manager · Product360

A self-hosted application for running a **Google Merchant Center** account – and for deciding
what to do with every product in it.

* **Merchant Center management** (Merchant API v1): product feeds, product & account status,
  automatic issue tracking with history, Google push notifications, product enrichment through
  a supplemental data source, "what changed since my last login".
* **Workflows**: visual builder, cron / event / manual triggers, steps that select, filter,
  tag, push attributes, schedule sale prices, call webhooks.
* **Product360**: nightly pull of Merchant Center performance and Market Insights reports
  (paid vs free listings, price benchmarks, best sellers, competitor visibility) and Google
  Search Console (organic impressions, position, top queries per product page). Every product
  gets five scores and one explainable recommendation – *Scale · Fix · Reprice · Optimise
  listing · Watch · Keep* – that the dashboard, the product list, the *Market* page and the
  workflows act on.

TypeScript end-to-end: Node 22 + Fastify + SQLite (built-in `node:sqlite`, no native modules)
on the server, React + Vite on the client. Runs on any VPS with Node ≥ 22.13, or in Docker.
UI in Polish and English.

## Documentation

| Audience | Document | What you find there |
|----------|----------|---------------------|
| Everyone | [docs/user-guide.md](docs/user-guide.md) | Every screen explained: dashboard, products & the 360° view, issues, market, feeds, workflows (builder, triggers, steps, templates), activity, settings; what the recommendations mean and how they are computed |
| Whoever installs / runs an instance | [docs/operations.md](docs/operations.md) | Requirements, installation (one-command deploy, pm2 / systemd, Docker), configuration reference, Google-side setup for Merchant Center and Search Console, reverse proxy, backups, updates, monitoring, troubleshooting |
| Whoever installs / runs an instance | [docs/google-setup.md](docs/google-setup.md) | Step-by-step walkthrough of the Google Cloud + Merchant Center side (service account, developer registration) with screenshots-level detail |
| Presenters / sales | [docs/demo.md](docs/demo.md) | The self-contained demo on synthetic data and a 5-minute tour script |
| Developers | [docs/development.md](docs/development.md) | Architecture, project layout, data model, HTTP API, workflow JSON reference, Product360 internals (connectors, signal rules), i18n, tests, how to extend |
| Developers / product | [docs/product360-plan.md](docs/product360-plan.md) | Product360 design, decisions, implementation log and roadmap (Google Ads, planner) |

## Quick start

```bash
npm install                   # also installs client/ dependencies
cp .env.example .env          # set SESSION_SECRET (openssl rand -hex 32); the rest can be done in the browser
npm start                     # builds server + client, serves http://localhost:8080
```

The setup wizard opens on first start: administrator → Merchant Center connection (service-account
key, *Test connection* with explanations) → sync & notifications → enrichment → done. Google-side
prerequisites are listed in [docs/operations.md](docs/operations.md#4-google-side-setup).

## Demo without a Google account

```bash
npm run demo                  # synthetic Merchant Center + Search Console, http://localhost:8080, login demo / demo1234
```

or `docker compose --profile demo up -d --build demo` (port 8081). Details and tour: [docs/demo.md](docs/demo.md).

## Deploying to a VPS

```bash
git clone <repo> /opt/gmc-manager && cd /opt/gmc-manager
bash deploy/deploy.sh --pm2   # first install and every update: checks Node, creates .env, builds, (re)starts, health-checks
```

Everything about running an instance – pm2 vs systemd, Docker, TLS proxy, backups, updating,
troubleshooting – is in [docs/operations.md](docs/operations.md).

## Development

```bash
npm run dev                   # API with auto-reload (use MERCHANT_MOCK=true for the fake Google)
npm --prefix client run dev   # UI on :5173 proxying /api
npm run check                 # typecheck server + client, tests with coverage
npm run test:e2e              # Playwright smoke tests against the demo
```

See [docs/development.md](docs/development.md).

## Licence

MIT – see [LICENSE](LICENSE).
