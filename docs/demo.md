# Product360 demo – synthetic data, end to end

> Audience: presenters and prospects. Screens are explained in depth in the [user guide](user-guide.md).

A self-contained installation that shows the whole product without a Google account:
a fake Merchant Center (60 products, two feeds, issues), 120 days of synthetic performance
and Market Insights reports, and a fake Search Console property. Everything in the UI works
– sync, enrichment pushes, workflows, metrics, recommendations – against in-memory fakes.

## Start it

```bash
npm install
npm run demo              # builds once, then serves http://localhost:8080
# npm run demo:reset      # start from an empty demo database
```

or with Docker: `docker compose --profile demo up -d --build demo` → <http://localhost:8081>.

Login: **demo / demo1234**. The demo keeps its own database (`data/demo.sqlite`); the real
installation's `data/gmc-manager.sqlite` and `.env` are untouched. On a VPS you can run the demo
next to production on another port (`PORT=8090 npm run demo`, or a second pm2 app – see
`deploy/ecosystem.config.cjs`).

What `DEMO_MODE=true` does on start: forces the mock APIs, marks the setup as completed, enables the
Search Console connector for `sc-domain:example-shop.pl` (incl. the *Merchant listings* pass), sets
a 120-day backfill, installs six sample workflows (three enabled), then runs a product sync and a
metrics pull **before** printing "demo is ready" – the first page is already populated.

## The 5-minute tour (also shown on the dashboard)

| # | Where | What to show |
|---|-------|--------------|
| 1 | **Dashboard** | Health flags and product status as before; below them the Product360 block: 7-day KPIs with week-over-week deltas (paid + free listings, organic), the recommendation tiles (*Scale / Fix / Reprice / Optimise listing / Watch / Keep*) and the lists *Focus*, *Fix first*, *Price opportunities*, *Optimise listing*, *Trending items you do not carry*. |
| 2 | **Products** | Filter by recommendation (e.g. *Reprice*), sort by *Clicks 7d* or *Organic 28d*. The same selection is what a workflow's `select_by_signal` step sees. |
| 3 | **Product → 360°** | Recommendation with reasons and the five scores; performance chart (Shopping ads vs free listings, 30/90/180 days); price vs market benchmark and Google's suggested price with predicted effect; best-seller rank and competitors; organic search card: impressions / clicks / position, *Load queries* → top queries with *easy win* badges → **"→ title"** puts the query into the enrichment form (*Metadata & enrichment* tab) → *Push to Google*. |
| 4 | **Market** | Best sellers per category and country with rank deltas, *Not in my catalogue* filter, competitor visibility table. |
| 5 | **Workflows** | Pre-installed: *Product360 – scale label* (event `metrics.synced` → `select_by_signal SCALE` → `set_attributes customLabel0=p360-scale`), *organic easy wins* (tags pages ranking 6–20), *tag disapproved*; disabled examples: weekend sale (`set_sale_price -10% now → +3d`), watch-list webhook. Open a run to show the step log; open the editor to show the blocks `Select by recommendation` and `Set sale price`; *Preview selection* shows the affected products. |
| 6 | **Settings → Product360** | Two connectors with status, last window and *Test connection* (capabilities incl. Market Insights views); Search Console section with property picker and *URL mapping diagnostics* (products without a page, pages without a product); schedule and thresholds (change *Reprice when price > benchmark by* and press *Recompute signals* – the tiles on the dashboard move). |
| 7 | **Simulate a day** (button on the dashboard tour card) | Google "re-processes" the catalogue: some issues resolve, new ones appear; products and metrics are refreshed; the *since your last login* block fills with new / resolved issues, status changes and **recommendation changes**; the enabled workflows fire (*Activity* page). Press *Mark all as seen* to reset the marker. |

## Story lines that work well

* *"Fix first"*: a product with high demand but disapproved – the demand score proves the lost
  traffic; fixing the feed is worth more than any campaign change.
* *"Reprice"*: price 12 % above benchmark, CTR below the category median, Google suggests a lower
  price with predicted +15 % clicks → the weekend-sale workflow template applies a time-boxed
  sale price that Google starts and ends itself.
* *"Optimise listing"*: organic position 8 with hundreds of impressions – the top-query list shows
  what people type; one click puts the phrase into the title.
* *"Trending items you do not carry"*: best-seller clusters marked *not carried* rising in rank
  – assortment input, not just campaign input.

## Limits of the synthetic data

Numbers are deterministic functions of (product, day) – stable between restarts, plausible
seasonality and trends, but no real market. Conversions are generated, so ROAS-style reasoning
(Phase 3, Google Ads) is not part of the demo yet. The fake Search Console returns ten queries per
product derived from its title.

## Automated check

`npm run test:e2e` runs a Playwright smoke suite that walks exactly this tour against a fresh demo
database – useful before a presentation or after an update.
