# GMC Manager · Product360 – installation & operations

For the person who installs, configures and keeps an instance running (IT, agency, partner).
Using the application itself is described in the [user guide](user-guide.md); code-level
details are in [development.md](development.md).

---

## 1. Requirements

| | Minimum | Notes |
|-|---------|-------|
| Node.js | **22.13** or newer | the app uses Node's built-in SQLite (`node:sqlite`) – no native modules, no compiler needed |
| OS | any Linux VPS, macOS, Windows | scripts in `deploy/` are bash; Docker images are provided |
| CPU / RAM | 1 vCPU, 512 MB | one Node process; a 10 000-product catalogue with 90 days of metrics uses ≈ 150 MB RAM and < 1 GB disk |
| Disk | SSD recommended | SQLite database in `./data` (grows with metrics history; see retention) |
| Network | outbound HTTPS to `*.googleapis.com` | inbound HTTPS only if you want Google push notifications |
| Google | a Merchant Center account, a Google Cloud project, a service account | see §4 |

Exactly **one process per database** – SQLite is single-writer. Run several instances only with
separate `DATABASE_PATH`s (e.g. production + demo).

---

## 2. Installation

### 2.1 One command on the server (recommended)

```bash
git clone <repo> /opt/gmc-manager && cd /opt/gmc-manager
bash deploy/deploy.sh --pm2          # or --systemd
```

`deploy/deploy.sh` is idempotent – the same command performs the first installation and every
later update:

1. checks Node ≥ 22.13;
2. `git pull --ff-only` (skipped when the working tree has local changes or with `--no-pull`);
3. creates **`.env`** from `.env.example` with fresh random `SESSION_SECRET` and
   `WEBHOOK_SECRET` if none exists; creates `data/` and `data/logs/`;
4. `npm ci` (server + client) unless `--skip-install`;
5. `npm run build`;
6. (re)starts the service – **pm2** (`deploy/ecosystem.config.cjs`; pm2 is installed globally
   when missing) or **systemd** (`deploy/gmc-manager.service` is installed with the right user
   and path when `--systemd` is given the first time); default = pm2 if installed, else an
   existing systemd unit;
7. waits for `GET /healthz` to answer (20 s) and prints the last log lines if it does not.

Options: `--pm2`, `--systemd`, `--none` (build only), `--no-pull`, `--skip-install`,
`--with-demo` (second pm2 app with the synthetic demo on `$DEMO_PORT`, default 8090).
Environment: `APP_DIR`, `SERVICE_NAME` (default `gmc-manager`), `DEMO_PORT`.

With **pm2** run `pm2 startup` once and execute the printed `sudo` command so pm2 itself starts
at boot; pm2 logs are in `data/logs/`, `pm2 logs gmc-manager` tails them.

From your workstation: `bash deploy/publish.sh user@host [/opt/gmc-manager] [--rsync] [deploy
options…]` runs the same script over SSH. `--rsync` copies the working tree (without
`node_modules`, `dist`, `data`, `.env`, secrets) – for servers without git access to the repo.

### 2.2 Manual (plain Node + systemd)

```bash
sudo useradd -r -m -d /opt/gmc-manager gmc
sudo -u gmc git clone <repo> /opt/gmc-manager && cd /opt/gmc-manager
sudo -u gmc npm ci && sudo -u gmc npm run build
sudo -u gmc cp .env.example .env && sudo -u gmc nano .env     # at least SESSION_SECRET
sudo cp deploy/gmc-manager.service /etc/systemd/system/
sudo systemctl enable --now gmc-manager
```

### 2.3 Docker

```bash
cp .env.example .env && nano .env                  # SESSION_SECRET, PUBLIC_URL
docker compose up -d --build                       # production on 127.0.0.1:8080, data in ./data
docker compose --profile demo up -d --build demo   # optional synthetic demo on 127.0.0.1:8081
```

The compose file mounts `./data` (database) and `./service-account-key.json` (read-only; the key
can also be pasted in the wizard instead).

### 2.4 Reverse proxy and TLS

Put the app behind a TLS-terminating proxy; Google push notifications require a public HTTPS URL.

* Caddy (`deploy/Caddyfile`, automatic certificates):
  ```
  gmc.example.com {
      reverse_proxy 127.0.0.1:8080
  }
  ```
* nginx: `deploy/nginx.conf` (combine with certbot). The app trusts `X-Forwarded-*` headers
  (`trustProxy: true`).

Set `PUBLIC_URL=https://gmc.example.com` in `.env` (or in the wizard) – it is the base of the
webhook URL Google calls.

---

## 3. Configuration

All settings are environment variables, loaded from `.env` by Node itself. Most of them can also
be set in the browser (setup wizard / Settings) – values stored there live in the database and
take precedence; `.env` acts as the default for a fresh database.

| Variable | Default | Purpose |
|----------|---------|---------|
| `NODE_ENV` | `development` | `production` enables production logging; warns when `SESSION_SECRET` is the default |
| `HOST`, `PORT` | `0.0.0.0`, `8080` | bind address |
| `LOG_LEVEL` | `info` | `fatal … trace`, `silent` |
| `PUBLIC_URL` | – | public HTTPS base URL (push notifications) |
| `DATABASE_PATH` | `./data/gmc-manager.sqlite` | SQLite file; migrations run automatically on start |
| `SESSION_SECRET` | *(must change)* | signs login cookies **and encrypts the stored service-account key**; ≥ 16 chars, use `openssl rand -hex 32`. Changing it logs everyone out and makes the stored key unreadable (the wizard asks for it again) |
| `SESSION_TTL_HOURS` | `168` | login validity |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` | – | Google OAuth web client and exact callback URI (`/api/auth/google/callback`) for operator login |
| `LOCAL_LOGIN_ENABLED` | `false` | local password login; keep disabled in production, demo/development may enable it |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | `admin`, – | optional local administrator for demo/development or an explicit local-login fallback |
| `ADMIN_BOOTSTRAP_ENABLED` | `true` | create the configured administrator automatically when no users exist; set `false` to require the setup wizard |
| `MERCHANT_ACCOUNT_ID` | – | Merchant Center account id (the number in Merchant Center's top-right corner) |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` / `GOOGLE_SERVICE_ACCOUNT_JSON` | `./service-account-key.json` | service-account key as file path or inline JSON (container secrets) |
| `MERCHANT_API_BASE_URL`, `MERCHANT_API_VERSION` | Google's, `v1` | only for testing against a proxy / new version |
| `MERCHANT_LANGUAGE_CODE`, `MERCHANT_TIME_ZONE` | `pl-PL`, `Europe/Warsaw` | language of Google's issue texts; time zone for schedules |
| `MERCHANT_MOCK` | `false` | in-process fake Merchant API (development) |
| `DEMO_MODE` | `false` | self-contained demo: forces the mock APIs, own database `./data/demo.sqlite`, login `demo / demo1234`, connectors and sample workflows pre-installed, metrics loaded on start – prefer `npm run demo` |
| `ENRICHMENT_DATA_SOURCE_NAME` | `GMC Manager enrichment` | name of the supplemental data source the app creates for pushed attributes |
| `SYNC_INTERVAL_MINUTES`, `SYNC_ON_STARTUP` | `30`, `true` | product/issue sync schedule (`0` = manual only) |
| `WEBHOOK_SECRET` | *(must change)* | secret path segment of the notification webhook `/api/webhooks/merchant/<secret>` |
| `METRICS_SYNC_CRON` | `0 4 * * *` | nightly Product360 pull (5-field cron, account time zone) |
| `METRICS_BACKFILL_DAYS` | `90` | history loaded on the first pull (7–730) |
| `SEARCH_CONSOLE_SITE_URL` | – | default Search Console property (`sc-domain:example.com` or `https://www.example.com/`); enables the connector when set |

Runtime settings without an environment variable (Settings → Product360): retention days (400),
signal thresholds (min. impressions 20, reprice above benchmark 10 %, watch on click drop 40 %),
Search Console country filter, data freshness, *Merchant listings* pass; enrichment priority;
API concurrency for bulk operations (8).

`GET/PUT /api/setup/config` exposes every runtime setting for scripting (cookie session).

### 3.1 Users

Production users authenticate with Google OAuth and are shadowed in the database by their verified
Google subject and e-mail. Google OAuth tokens are not stored. Local users have scrypt-hashed
passwords and are available only when `LOCAL_LOGIN_ENABLED=true` (or in the demo/development
environment). There are no roles – every login can do everything (decision recorded in the
Product360 plan).

---

## 4. Google-side setup

### 4.1 Merchant Center (required)

Four things must be in place – any one missing looks like a credentials problem:

1. A Google Cloud project with the **Merchant API** enabled (`merchantapi.googleapis.com`).
2. A **service account** in that project and its JSON key.
3. The service-account e-mail added as a user with **Admin** access **directly on the Merchant
   Center account** (*Settings → People and access*).
4. The Cloud project **registered as a developer** with the account – a one-time Merchant-API
   step; the wizard detects the *"GCP project … is not registered"* error and offers a
   **Register Google Cloud project** button (Google accepts calls ~5 minutes later).

Step-by-step with all the pitfalls (test accounts, unclaimed website, advanced accounts, error
messages): [google-setup.md](google-setup.md).

**Market Insights** (price benchmarks, price suggestions, best sellers, competitor visibility) is a
free opt-in in Merchant Center (*Growth → Market Insights*). Without it the app still works; the
related reports are detected as unavailable by *Test connection* and the panels hide themselves.

**Push notifications** (optional): with `PUBLIC_URL` set and reachable over HTTPS, press
*Subscribe* on the Settings page; Google then calls
`POST /api/webhooks/merchant/<WEBHOOK_SECRET>` on product status changes and the affected
product is refreshed immediately. Without it the periodic sync keeps everything up to date.

### 4.2 Google Search Console (optional, Product360)

Same service account, no new key:

1. Google Cloud → APIs & Services → enable the **Google Search Console API** in the project of
   the service account.
2. Search Console → open the property → **Settings → Users and permissions → Add user** → the
   service-account e-mail, permission *Full* or *Restricted* (read is enough).
3. In the app: *Settings → Product360 → Google Search Console*: tick *enabled*, **Load
   properties**, pick the property, optionally a 3-letter country filter (`pol`), save, **Test
   connection**. The test checks the share, runs a real query and reports how many products have
   a landing page inside the property.

Which property? A **domain property** (`sc-domain:example.com`) covers every host and protocol
and is the safe choice. A **URL-prefix property** (`https://www.example.com/`) only matches
product links that start with exactly that prefix. *URL mapping diagnostics* shows products whose
link falls outside the property.

Data lag: Search Console closes a day two to three days later; the connector pulls up to
`today − 2` and re-pulls the last 10 days every night. The first pull loads
`METRICS_BACKFILL_DAYS` (Search Console keeps 16 months). Quota is generous (~1 200 queries per
minute per property); the connector sends one query per day and property (two with the
*Merchant listings* pass).

### 4.3 Google Ads

Planned (Phase 3 of the Product360 plan) – requires a Google Ads developer token. Not part of
this release.

---

## 5. Day-2 operations

### 5.1 Updating

```bash
cd /opt/gmc-manager && bash deploy/deploy.sh        # git pull, npm ci, build, restart, health check
```

or manually `git pull && npm ci && npm run build && systemctl restart gmc-manager` (or
`pm2 reload gmc-manager`). Database migrations run automatically on start; they are additive
(new tables / columns) and do not touch existing data.

### 5.2 Backup & restore

Everything is in the SQLite file (`DATABASE_PATH`) plus `.env`. Back up the database while the
app runs with SQLite's online backup (consistent even under load):

```bash
sqlite3 data/gmc-manager.sqlite ".backup 'backup/gmc-manager-$(date +%F).sqlite'"
```

or stop the service and copy the three files (`*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`).
Restore = stop, replace the file(s), start. Keep `.env` with the backup – without the same
`SESSION_SECRET` the stored service-account key cannot be decrypted (the wizard would ask for it
again; nothing else is lost).

The metrics tables are the largest part. Retention (*Settings → Product360 → Keep daily rows*,
default 400 days) deletes older daily rows every night; `VACUUM` reclaims the space:
`sqlite3 data/gmc-manager.sqlite 'VACUUM;'` (with the service stopped).

### 5.3 Monitoring

* `GET /healthz` → `{"ok":true,"mock":false,"configured":true,"time":…}` – no login needed.
* Logs: JSON lines on stdout (`LOG_LEVEL`); pm2 → `data/logs/`, systemd → `journalctl -u gmc-manager`.
* In the app: dashboard flags (*Needs attention*) include failed syncs, failed metrics pulls,
  feed processing failures; *Activity* lists every sync run; *Settings → Product360* shows the
  connector runs with statistics and warnings; *Settings → Merchant API quota* shows Google's
  quota usage.
* Webhook notifications: a workflow with the *Webhook* step (template *Notify a webhook about new
  critical issues*) posts to Slack / Teams / n8n / Make.

### 5.4 Running the demo next to production

`bash deploy/deploy.sh --pm2 --with-demo` starts a second pm2 app `gmc-manager-demo` on
`$DEMO_PORT` (8090) with its own database `data/demo.sqlite` – expose it through the proxy on a
separate host name if prospects should reach it. See [demo.md](demo.md).

---

## 6. Security notes

* Cookie sessions signed with `SESSION_SECRET`; login attempts are throttled.
* The service-account key is stored AES-256-GCM encrypted (key derived from `SESSION_SECRET`);
  `.env`, `service-account-key.json` and `data/` are excluded from git and from Docker build
  context.
* The webhook endpoint is public but unguessable (`WEBHOOK_SECRET` in the path) and only
  triggers a re-read of the referenced product – it never writes data from the payload.
* All Google calls are outbound over HTTPS with short-lived OAuth tokens; the service account has
  the scopes `content` (Merchant API) and `webmasters.readonly` (Search Console) only.
* Bind the app to `127.0.0.1` behind the proxy (`HOST=127.0.0.1`) or firewall the port.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `npm audit fix --force` makes the build fail | Do not use the force option on a deployed checkout: it can replace major versions outside the tested lockfiles. Restore the checkout, pull the current revision, then run `npm ci && npm run build`; use `npm audit fix --package-lock-only` only for non-breaking fixes and commit the resulting lockfile. |
| Wizard: *GCP project … is not registered* | Merchant-API developer registration missing → *Register Google Cloud project* button, wait 5 min. Details in [google-setup.md](google-setup.md#troubleshooting-the-test-connection-messages). |
| Wizard: *The caller does not have permission* | service account not a user of the account, or Merchant API not enabled in its project. |
| Sync works, but prices / best sellers / competitors are empty | Market Insights not enabled in Merchant Center (or no comparable offers). *Settings → Product360 → Test connection* lists the unavailable reports. |
| Search Console: *Property not accessible* | property not shared with the service-account e-mail; *User does not have sufficient permission* → share it; *API has not been used in project* → enable the Search Console API. |
| Search Console connected, organic card says the page is outside the property | product `link` host/path not covered by the chosen property → use a domain property or fix the feed; check *URL mapping diagnostics*. |
| Dashboard flag *Metrics sync failed* | see *Settings → Product360 → Recent runs* for the error; transient Google errors resolve at the next nightly run (`Pull metrics now` retries immediately). |
| Push notifications never arrive | `PUBLIC_URL` not reachable over HTTPS from the internet, or not subscribed (*Settings → Subscribe*); test with *Simulate* next to the subscription list. |
| `SESSION_SECRET` changed, users logged out, wizard asks for the key | expected – re-enter the key. |
| *database is locked* in logs | two processes on the same database (e.g. pm2 + systemd both running). Keep one runner. |
| High memory on first metrics pull | backfill of a very large catalogue; lower `METRICS_BACKFILL_DAYS` or run it off-hours. The pull is chunked (31 days) and resumable. |
| Port 8080 in use | set `PORT` in `.env` and the proxy target accordingly. |
