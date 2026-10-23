# GMC Manager · Product360 – user guide

This guide is for the people who work with the application every day: e-commerce, marketing
and merchandising teams. It explains every screen, the vocabulary used in the interface and how
the Product360 recommendations are derived. Installation and Google-side setup are covered in
[operations.md](operations.md); if you only want to see the product in action, use the
[demo](demo.md).

The interface is available in **Polish** (default) and **English** – switch in the sidebar
footer, on the login page or in the setup wizard; the choice is remembered per browser.

---

## 1. Concepts in two minutes

| Term | Meaning |
|------|---------|
| **Product** | One offer in Merchant Center, identified by *content language ~ feed label ~ offer id* (e.g. `pl~PL~SKU-0001`). The same SKU sold in two countries is two products. |
| **Status** | Google's verdict per destination and country, aggregated into *Approved · Partially approved · Disapproved · Pending · Not eligible*. |
| **Issue** | A problem Google reports for a product (e.g. *missing GTIN*, *price mismatch*) or for the whole account (e.g. *website not claimed*). The app keeps the history: *first seen*, *last seen*, *resolved*. |
| **Sync** | The periodic read of all products and issues from Google into the app's own database (default every 30 minutes, plus push notifications). Everything you see is this local snapshot; *Refresh from Google* re-reads one product on demand. |
| **Enrichment** | Attributes you add or override *on top of* the feed (title, custom labels, sale price, …). They are pushed to Google through a supplemental data source that the app creates and links for you. |
| **Local metadata** | Tags, notes and free key/value fields stored only in the app – for filtering, workflows and team communication. |
| **Workflow** | An automation: a trigger (manual / schedule / event) plus ordered steps that select products and act on them. |
| **Product360** | Performance, market and organic-search context per product, plus one recommendation with reasons. Data comes from Merchant Center reports and, optionally, Google Search Console. |
| **Since your last login** | The app remembers when you logged in before; dashboard and issue views can show only what changed since then. *Mark all as seen* moves the marker to now. |

---

## 2. Dashboard

The home page answers *"is everything OK and what needs attention?"*

1. **Needs attention** – flags from several sources: account issues (e.g. website not claimed),
   feeds whose last upload failed or had processing issues, a failed sync or metrics pull,
   and a high share of disapproved products. Each flag links to Google's help where available.
2. **Status tiles** – total products, approved / partially approved / disapproved / pending,
   products with errors and with warnings. Click-through to the filtered product list.
3. **Product360 block** (when metrics are loaded)
   * 7-day KPIs with week-over-week deltas: impressions, clicks, CTR, conversions (Shopping ads +
     free listings), products with traffic; a second row with organic impressions, clicks, CTR,
     average position and product pages in search when Search Console is connected.
   * *Clicks – last 28 days* chart, split into Shopping ads and free listings.
   * **Recommendation tiles** – how many products are in each bucket; each tile opens the
     product list filtered accordingly.
   * Lists: **Focus – scale these** (`Scale`), **Fix first** (`Fix`), **Price opportunities**
     (`Reprice`), **Optimise listing**, **Trending items you do not carry** (best-seller clusters
     rising in your categories that match none of your GTINs).
   * *Pull metrics now* triggers the nightly pull immediately.
4. **Since your last login** – new and resolved issues, new account issues, status changes,
   push notifications, **recommendation changes** and workflow runs. *Mark all as seen* resets
   the marker.
5. **Top issues (open)**, **Feeds**, **Product status per destination** (Google's own
   aggregates per destination/country) and **Account issues**.

---

## 3. Products

A filterable, sortable table of the local snapshot.

**Filters**: text (title / offer id / brand), status, severity, with/without issues, issue type,
tag, feed label, brand, availability, category and – once metrics exist – **recommendation**.
Filters live in the URL, so a filtered view can be bookmarked or shared.

**Columns**: offer id, title, brand, feed, price, availability, status, issues, and with
metrics: recommendation, *Clicks 7d* with the change vs the previous week, *Price vs market*
(percent above / below the benchmark) and, with Search Console, *Organic 28d @ position*. Click a
header to sort.

**Bulk edit**: tick products → *Bulk edit* → add/remove tags and push attributes to all of them
at once (each product is pushed individually; the result reports how many succeeded and how many failed).

### 3.1 Product page

Header: title, status, recommendation badge, brand, price, availability, feed, landing-page
link, data source, Google's last update and expiry dates, destinations per country, local tags,
enrichment state, *Refresh from Google*.

Tabs:

* **360°** – see §5.
* **Issues** – open issues with severity, attribute, destination, countries, resolution hint,
  first-seen date and Google's documentation link; below, Google's **rendered explanation**
  (Issue Resolution API) with the actions Google offers (e.g. *Request review*, opening in
  Merchant Center).
* **Attributes** – every attribute as Google currently sees the product (feed + supplemental
  sources merged), including custom attributes.
* **Metadata & enrichment** – left: tags (type and press Enter), notes, extra fields – saved
  only in the app. Right: attributes already pushed by the app, the form to set/change/remove
  attributes (typed: prices, lists, booleans, JSON for complex ones) and custom attributes.
  *Push to Google* sends the complete set; Google needs a few minutes to process it.
  Removing a pushed attribute (×) restores the feed value.
* **History** – every issue ever seen on the product with first/last/resolved dates, and the
  activity events that mention it (status changes, pushes, workflow actions).
* **Raw JSON** – the product exactly as returned by the Merchant API.

---

## 4. Issues

Three tabs:

* **Product issues** – every open (or resolved) product issue across the catalogue with filters:
  period (*any time / since last login / last 24 h / last 7 days*), level (*errors = disapproved*,
  *warnings = demoted*, info), issue type, destination. Each row links to the product.
* **By issue type** – one row per issue code with the number of affected products and how many
  are new since the reference point; links to the filtered product list.
* **Account issues** – Google's account-level issues with Google's rendered explanation and
  actions.

*Reference point* is your previous login; *Move the reference to now* is the same as *Mark all
as seen* on the dashboard.

---

## 5. Product360 – the 360° view

The 360° tab gathers everything the app knows about a product's commercial situation.

### 5.1 Recommendation card

One recommendation with the **reasons** that produced it (plain sentences, e.g. *"Price is 12 %
above the market benchmark"*, *"CTR 1.63 % is below the category median 2.46 %"*) and five
**scores** 0–100:

| Score | What it measures |
|-------|------------------|
| **Demand** | Impressions of the last 28 days compared with similar products (same category), blended with organic impressions when Search Console is connected; boosted when the best-seller list shows rising demand, lowered when sinking. |
| **Visibility** | Impressions of the last 7 days and CTR compared with similar products; with Search Console also the average organic position. |
| **Price position** | Your price vs the market benchmark: 100 at 5 % below, 0 at 15 % above. Empty when Google has no benchmark for the product. |
| **Listing health** | Status and issues: approved & clean = 100, warnings ≤ 70, partially approved ≤ 40, disapproved 0; out of stock caps at 50. |
| **Ad efficiency** | Reserved for the Google Ads connector (cost, ROAS) – shown as "–" until then. |

"Similar products" = products with the same category (Google product category or first product
type) when there are at least five of them, otherwise the whole catalogue.

| Recommendation | When (first matching rule wins) | Typical action |
|----------------|---------------------------------|----------------|
| **No data** | fewer than *N* impressions in 28 days and no market or organic data | wait |
| **Fix** | disapproved or error-level issues while the product has demand | fix the feed – this traffic is lost today |
| **Reprice** | price more than *X %* above the benchmark **and** customers react (CTR below the category median, or Google predicts an effect from its suggested price) | lower the price or run a time-boxed sale (workflow step *Set sale price*) |
| **Optimise listing** | many impressions but CTR below half of the category median with a fine price; or (checked after *Scale*) the page already ranks on organic positions 6–20 with real volume | better title / images / attributes; use the top queries as title ideas |
| **Watch** | best-seller demand sinking, or clicks dropped more than *Y %* week over week, or organic impressions dropped more than *Y %* vs the previous 28 days | observe; investigate before acting |
| **Scale** | demand ≥ 60, healthy listing, not over-priced | more budget / move into a push campaign (e.g. through a custom label) |
| **Keep** | nothing stands out | – |

*N*, *X* and *Y* are thresholds in *Settings → Product360* (defaults 20 impressions, 10 %,
40 %). Recommendations are recomputed after every metrics pull, after every product sync and
whenever a threshold changes. A change of recommendation appears in *since your last login*
and can trigger workflows (event `signal.changed`).

Buttons: *Automate with a workflow* opens the workflow editor with the *scale label* template;
*Plan a sale window* (on `Reprice`) opens the *weekend sale* template.

### 5.2 Performance (Merchant Center)

Impressions / clicks / conversions per day, split into **Shopping ads** and **free listings**,
for 30 / 90 / 180 days; totals with the change vs the previous period of the same length (shown
only when the previous period is fully covered by loaded data). *Data through* tells you the
last day Google has closed – reports lag about a day.

### 5.3 Price position (Market Insights)

Your price, the market **benchmark** (what other merchants charge for the same product in the
country), Google's **suggested price** with its predicted effect on clicks and conversions, and
the history of both prices. Requires *Market Insights* to be enabled in Merchant Center (free) –
otherwise the card explains what is missing.

### 5.4 Market position (best sellers) & competitors

The product's rank in Google's weekly best-seller list of its category and country, the rank
change, relative demand (*very low … very high*) and trend (*rising / flat / sinking*). Products
are matched to best-seller clusters by GTIN. Below it, the merchants that appear next to you in
those categories: relative visibility (1.0 = the most visible), overlap (share of your
impressions where they also appeared) and how often they ranked above you.

### 5.5 Organic search (Search Console)

Shown when the Search Console connector is on and the product's landing page lies inside the
configured property. Impressions, clicks, CTR and average position of the landing page (optionally
also for the *Merchant listings* result type), a daily chart, and **top queries** loaded on
demand: each query with impressions, clicks, CTR, position, an **easy win** badge when the page
ranks 6–20 for it, and **→ title** which carries the query into the enrichment form (tab
*Metadata & enrichment*) as a title idea – *Append to title*, edit, *Push to Google*.

---

## 6. Market

Catalogue-level view of the Market Insights data.

* 7-day KPIs and the 90-day catalogue trend (clicks or impressions, ads vs free listings).
* **Best sellers**: Google's weekly list per category and country with rank and rank change,
  demand level and trend, inventory status; filters for country, category, *in my catalogue /
  not in my catalogue* and trend. Rows that match one of your products link to it.
* **Competitor visibility** per category: average rank, relative visibility, overlap, higher
  position rate, ads/organic ratio.
* Recommendation counts as tiles.

---

## 7. Feeds

All data sources of the account: primary product feeds (file fetch, upload, Google Sheets, API),
supplemental sources, inventory / promotion / review feeds. Per feed: input type, fetch URL and
schedule, feed label and countries, linked supplemental sources, product count, **last upload**
(state, items, processing issues) and a health dot. Actions: create, edit (name, fetch settings),
delete, **Fetch now** (for fetch-type feeds).

The **enrichment source** card shows the supplemental source the app uses for pushed attributes
and whether it is linked to every primary feed (*Ensure* fixes missing links).

---

## 8. Workflows

Automations that run on the local snapshot and act through the Merchant API.

### 8.1 Building a workflow

Three editors on the same definition – switch freely:

* **Visual builder** – drag blocks from the palette into the flow (or click them), reorder by
  dragging, click a block to edit it in the inspector. Blocks with incomplete settings show a
  warning; server-side validation errors are highlighted on the offending block.
* **Form** – the same blocks as a vertical form.
* **JSON** – the raw definition (useful to copy workflows between installations).

*Preview selection* runs only the selection / filter blocks and lists the products that would
be affected. *Save*, then *Run* on the list page or let the trigger fire. Every run is logged
step by step (*Log* button on the list page).

### 8.2 Triggers

| Trigger | Description |
|---------|-------------|
| **Manual** | only when you press *Run*. |
| **Schedule** | 5-field cron (minute hour day month weekday) in a time zone, e.g. `0 6 * * *` = daily 06:00. |
| **Event** | when something happens: `sync.completed`, `issue.new`, `issue.resolved`, `product.status_changed`, `notification.received` (Google push), `metrics.synced` (after a metrics pull), `signal.changed` (a product's recommendation changed). Events are batched for *debounce* seconds and passed to the run. |

### 8.3 Steps

Steps run in order and share a **working set** of products: selection steps load it, refining
steps narrow it down, action steps apply to every product in it.

| Group | Step | What it does |
|-------|------|--------------|
| Select | **Select products** | loads products by status, severity, issue type, tag, feed label, brand, availability, text, limit |
| Select | **Select by recommendation** | Product360: products with given recommendation(s), optionally minimum demand score / impressions, category, limit |
| Select | **Select products from event** | for event triggers: the products the events refer to (optionally only certain levels / issue codes) |
| Refine | **Filter** | keep products matching a condition (`field operator value`, combinable with *all of / any of*) |
| Refine | **Limit** | keep at most N |
| Refine | **Stop if empty** | end the run when nothing is selected |
| Product actions | **Set attributes** | push attributes (custom labels, title, …) through the enrichment source; values may use templates such as `{{brand}}` |
| Product actions | **Set sale price (time window)** | push a sale price valid from/to a time – fixed amount (`89.99`) or percentage off (`-10%`); times absolute or relative (`now`, `+3d`, `+12h`, `+1w`). Google starts and ends the promotion itself. |
| Product actions | **Clear attributes** | remove everything the app pushed for the products |
| Product actions | **Add tags / Remove tags / Set note** | local metadata |
| Product actions | **Refresh products** | re-read the selected products from Google |
| Account & sync | **Fetch feed** | request an immediate fetch of a fetch-type feed |
| Account & sync | **Sync** | full product + issue sync |
| Notify | **Webhook** | POST a JSON summary (optionally with the product list) to Slack / Teams / n8n / Make / your system |
| Notify | **Log** | write a line to the run log and the activity trail |

Condition fields include product basics (`status`, `brand`, `price.amount`, `availability`, …),
issues (`issueCodes`, `issues.level`), attributes (`attributes.<name>`, `customAttributes.<name>`),
local metadata (`tags`, `notes`, `fields.<name>`), pushed attributes (`pushed.<name>`) and
Product360 data (`signals.recommendation`, `signals.scores.demand`, `metrics.clicks7d`,
`metrics.clicksChangePct`, `metrics.ctr28d`, `metrics.scPosition28d`, `market.priceVsBenchmark`,
`market.demandChange`, …). Operators: equals, not equals, contains, in, exists, regex, greater /
less than, starts / ends with, is empty, …

### 8.4 Templates

*From template…* on the workflows page:

| Template | Purpose |
|----------|---------|
| Tag disapproved products after every sync | keeps a local `disapproved` tag in sync |
| Set custom label for products with missing GTIN | `customLabel4 = missing-gtin` so campaigns can exclude them |
| Notify a webhook about new critical issues | Slack / Teams / n8n compatible summary of new disapprovals |
| Pause out-of-stock products with errors | `pause = ALL` until fixed |
| Re-fetch the main feed and sync | nightly feed fetch |
| Product360: label products to scale | `customLabel0 = p360-scale` for `Scale` products after every metrics update (and removed when they leave the bucket) – the label your Shopping / Performance Max campaign targets |
| Product360: weekend promotion for over-priced products | every Friday `Reprice` products get a 10 % sale price until Sunday night |
| Product360: alert when products start sinking | webhook about products that changed to `Watch` / `Fix` |
| Product360: tag organic "easy wins" | tags pages ranking 6–20 in organic search (needs Search Console) |

---

## 9. Activity

The audit trail: sync runs with their statistics, and every event the app recorded – new /
resolved issues, status changes, notifications from Google, pushes, workflow runs, metrics pulls,
settings changes. Filter by type and severity.

---

## 10. Settings

* **Connection** – account, API, sync interval, enrichment source, locale / time zone, public URL;
  *Change configuration* re-opens the wizard (changes apply immediately, no restart).
* **Google push notifications** – the callback URL and *Subscribe* (needs a public HTTPS URL);
  existing subscriptions with delete.
* **Product360 – metrics & signals** –
  * connectors (*Merchant Center reports*, *Google Search Console*) with status, last window,
    next window and **Test connection**, which lists exactly which capabilities work (e.g. which
    Market Insights reports are available, whether the Search Console property is shared and how
    many products map to a page);
  * **Google Search Console** section: enable, *Load properties* and pick one, optional country
    filter, data freshness, *Merchant listings* pass, **URL mapping diagnostics** (products without
    a page inside the property, pages with traffic that belong to no product);
  * *Pull metrics now*, *Recompute signals*, schedule (cron), backfill and retention days, the
    three thresholds behind the rules, recent runs with statistics and warnings.
* **Merchant API quota** – today's usage per quota group as reported by Google.
* **Shipping settings** (read-only) and **Return policies** (create / edit / delete).
* **Users** – add or remove logins; **Change my password**.

---

## 11. Frequently asked questions

**How fresh is the data?** Products and issues: every sync (default 30 min) plus Google push
notifications within seconds. Performance reports: Google closes a day about one day later;
Search Console two to three days later – the app shows *Data through …* everywhere.

**Why does a product show "No data"?** Fewer than the minimum impressions in 28 days and no
market or organic data. Lower *Min. impressions* in Settings if your catalogue is small.

**Why is the price card empty?** Google has no benchmark for that product (no comparable offers)
or Market Insights is not enabled – *Test connection* tells which.

**A product is not on the best-seller list although it sells well.** Matching is by GTIN; products
without GTIN cannot be matched.

**The organic card says the page is not inside the property.** The feed's `link` points to a
host or path the configured Search Console property does not cover – choose a domain property
(`sc-domain:`) or fix the link. *URL mapping diagnostics* lists such products.

**Can workflows spend money?** Not today: they change feed data (labels, sale prices, pauses) and
local metadata, and call webhooks. Campaign budgets are steered indirectly through custom labels.
