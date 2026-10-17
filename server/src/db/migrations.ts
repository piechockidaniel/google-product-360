export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        /* timestamp of the current session's login */
        last_login_at TEXT,
        /* timestamp of the login before the current one – used for "since last login" views */
        previous_login_at TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      /* Snapshot of processed products as returned by the Merchant API. */
      CREATE TABLE products (
        name TEXT PRIMARY KEY,                 -- accounts/{a}/products/{id}
        product_id TEXT NOT NULL,              -- base64url id usable in URLs
        offer_id TEXT NOT NULL,
        content_language TEXT,
        feed_label TEXT,
        title TEXT,
        brand TEXT,
        link TEXT,
        image_link TEXT,
        price_micros INTEGER,
        currency_code TEXT,
        availability TEXT,
        data_source TEXT,
        aggregated_status TEXT NOT NULL DEFAULT 'UNKNOWN',  -- APPROVED | PARTIALLY_APPROVED | DISAPPROVED | PENDING | NOT_ELIGIBLE | UNKNOWN
        issue_count INTEGER NOT NULL DEFAULT 0,
        max_severity TEXT,                     -- ERROR | WARNING | INFO
        raw_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX idx_products_status ON products(aggregated_status);
      CREATE INDEX idx_products_offer ON products(offer_id);
      CREATE INDEX idx_products_deleted ON products(deleted_at);

      /* One row per (product, issue) with first/last seen tracking. */
      CREATE TABLE product_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL UNIQUE,
        product_name TEXT NOT NULL,
        code TEXT NOT NULL,
        severity TEXT,
        attribute TEXT,
        description TEXT,
        detail TEXT,
        documentation TEXT,
        reporting_context TEXT,
        resolution TEXT,
        applicable_countries TEXT,             -- JSON array
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX idx_product_issues_product ON product_issues(product_name);
      CREATE INDEX idx_product_issues_open ON product_issues(resolved_at, first_seen_at);
      CREATE INDEX idx_product_issues_code ON product_issues(code);

      CREATE TABLE account_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL UNIQUE,
        name TEXT,
        title TEXT,
        severity TEXT,
        detail TEXT,
        documentation_uri TEXT,
        impacted TEXT,                         -- JSON
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resolved_at TEXT
      );

      /* Local metadata (tags / notes / extra fields) + attributes pushed to Google. */
      CREATE TABLE product_metadata (
        product_name TEXT PRIMARY KEY,
        tags TEXT NOT NULL DEFAULT '[]',       -- JSON array of strings
        notes TEXT NOT NULL DEFAULT '',
        fields TEXT NOT NULL DEFAULT '{}',     -- JSON object: arbitrary local key/values
        pushed_attributes TEXT NOT NULL DEFAULT '{}',  -- JSON: attributes pushed via supplemental data source
        push_status TEXT,                      -- pending | pushed | error
        push_error TEXT,
        pushed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        trigger TEXT NOT NULL,                 -- JSON
        steps TEXT NOT NULL,                   -- JSON array
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT
      );

      CREATE TABLE workflow_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL,                 -- manual | schedule | event:<name>
        status TEXT NOT NULL,                  -- running | success | failed
        started_at TEXT NOT NULL,
        finished_at TEXT,
        log TEXT NOT NULL DEFAULT '[]',        -- JSON array of log entries
        stats TEXT NOT NULL DEFAULT '{}',      -- JSON
        error TEXT
      );
      CREATE INDEX idx_workflow_runs_wf ON workflow_runs(workflow_id, started_at);

      CREATE TABLE sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,                    -- full | product | account
        status TEXT NOT NULL,                  -- running | success | failed
        started_at TEXT NOT NULL,
        finished_at TEXT,
        stats TEXT NOT NULL DEFAULT '{}',
        error TEXT
      );

      /* Audit / activity trail: sync results, Google notifications, workflow actions, issue changes. */
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info', -- info | warning | error
        message TEXT NOT NULL,
        payload TEXT,                          -- JSON
        product_name TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_events_created ON events(created_at);
      CREATE INDEX idx_events_type ON events(type);
    `,
  },
  {
    id: 2,
    name: 'product360-metrics',
    sql: `
      /* Category used to compare products against their peers (google product category or first product type). */
      ALTER TABLE products ADD COLUMN category TEXT;
      CREATE INDEX idx_products_category ON products(category);

      /* Merchant Center performance report (product_performance_view), one row per product/day/marketing method/country.
         Only non-zero rows are stored (sparse). */
      CREATE TABLE mc_product_performance_daily (
        product_name TEXT NOT NULL,
        date TEXT NOT NULL,
        marketing_method TEXT NOT NULL,        -- ADS | ORGANIC | ALL
        country TEXT NOT NULL DEFAULT 'ALL',
        impressions INTEGER NOT NULL DEFAULT 0,
        clicks INTEGER NOT NULL DEFAULT 0,
        conversions REAL NOT NULL DEFAULT 0,
        conversion_value_micros INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (product_name, date, marketing_method, country)
      );
      CREATE INDEX idx_mc_perf_date ON mc_product_performance_daily(date);

      /* Market Insights: price competitiveness + price insights, snapshot per day we looked. */
      CREATE TABLE mc_price_benchmark_daily (
        product_name TEXT NOT NULL,
        date TEXT NOT NULL,
        country TEXT NOT NULL DEFAULT 'ALL',
        price_micros INTEGER,
        benchmark_price_micros INTEGER,
        currency TEXT,
        suggested_price_micros INTEGER,
        predicted_impressions_change REAL,
        predicted_clicks_change REAL,
        predicted_conversions_change REAL,
        effectiveness TEXT,                    -- LOW | MEDIUM | HIGH
        PRIMARY KEY (product_name, date, country)
      );

      /* Market Insights: best sellers (product clusters), weekly / monthly. */
      CREATE TABLE mc_best_sellers (
        report_date TEXT NOT NULL,
        granularity TEXT NOT NULL,             -- WEEKLY | MONTHLY
        country TEXT NOT NULL,
        category_id TEXT NOT NULL,
        cluster_key TEXT NOT NULL,
        title TEXT,
        brand TEXT,
        category TEXT,
        gtins TEXT NOT NULL DEFAULT '[]',      -- JSON array
        rank INTEGER,
        previous_rank INTEGER,
        relative_demand TEXT,
        previous_relative_demand TEXT,
        demand_change TEXT,                    -- RISER | FLAT | SINKER
        inventory_status TEXT,                 -- IN_STOCK | OUT_OF_STOCK | NOT_IN_INVENTORY
        product_name TEXT,                     -- matched local product (NULL = we do not carry it)
        PRIMARY KEY (report_date, granularity, country, category_id, cluster_key)
      );
      CREATE INDEX idx_best_sellers_product ON mc_best_sellers(product_name);
      CREATE INDEX idx_best_sellers_date ON mc_best_sellers(report_date);

      /* Market Insights: competitive visibility per category / country / traffic source. */
      CREATE TABLE mc_competitive_visibility_daily (
        date TEXT NOT NULL,
        country TEXT NOT NULL,
        category_id TEXT NOT NULL,
        traffic_source TEXT NOT NULL,          -- ADS | ORGANIC | ALL
        domain TEXT NOT NULL,
        is_your_domain INTEGER NOT NULL DEFAULT 0,
        rank INTEGER,
        relative_visibility REAL,
        page_overlap_rate REAL,
        higher_position_rate REAL,
        ads_organic_ratio REAL,
        PRIMARY KEY (date, country, category_id, traffic_source, domain)
      );

      /* Computed layer: rolled-up inputs + scores + recommendation per product. */
      CREATE TABLE product_signals (
        product_name TEXT PRIMARY KEY,
        computed_at TEXT NOT NULL,
        mc_impressions_7d INTEGER NOT NULL DEFAULT 0,
        mc_clicks_7d INTEGER NOT NULL DEFAULT 0,
        mc_impressions_prev_7d INTEGER NOT NULL DEFAULT 0,
        mc_clicks_prev_7d INTEGER NOT NULL DEFAULT 0,
        mc_impressions_28d INTEGER NOT NULL DEFAULT 0,
        mc_clicks_28d INTEGER NOT NULL DEFAULT 0,
        mc_conversions_28d REAL NOT NULL DEFAULT 0,
        mc_conversion_value_micros_28d INTEGER NOT NULL DEFAULT 0,
        mc_ctr_28d REAL,
        price_vs_benchmark REAL,               -- price / benchmark - 1
        effectiveness TEXT,
        demand TEXT,
        demand_change TEXT,
        best_seller_rank INTEGER,
        scores TEXT NOT NULL DEFAULT '{}',     -- JSON { demand, visibility, price, efficiency, health }
        recommendation TEXT NOT NULL,          -- SCALE | FIX | REPRICE | OPTIMISE_LISTING | WATCH | PAUSE | KEEP | NO_DATA
        previous_recommendation TEXT,
        reasons TEXT NOT NULL DEFAULT '[]'     -- JSON [{ code, params }]
      );
      CREATE INDEX idx_signals_recommendation ON product_signals(recommendation);

      /* Run log of the metrics connectors (like sync_runs). */
      CREATE TABLE metrics_sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connector TEXT NOT NULL,
        status TEXT NOT NULL,                  -- running | success | failed
        window_from TEXT,
        window_to TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        stats TEXT NOT NULL DEFAULT '{}',
        error TEXT
      );
      CREATE INDEX idx_metrics_runs_connector ON metrics_sync_runs(connector, id);
    `,
  },
  {
    id: 3,
    name: 'product360-search-console',
    sql: `
      /* product link -> canonical page URL (the Search Console join key). Rebuilt on every metrics run. */
      CREATE TABLE product_url_map (
        product_name TEXT PRIMARY KEY,
        canonical_url TEXT NOT NULL,
        shared_url INTEGER NOT NULL DEFAULT 0,    -- several products (variants) share the landing page
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_url_map_url ON product_url_map(canonical_url);

      /* Search Console search analytics per page/day (stored by URL so re-mapping never loses data). */
      CREATE TABLE sc_page_daily (
        canonical_url TEXT NOT NULL,
        date TEXT NOT NULL,
        appearance TEXT NOT NULL DEFAULT 'ALL',   -- ALL | MERCHANT_LISTINGS
        clicks INTEGER NOT NULL DEFAULT 0,
        impressions INTEGER NOT NULL DEFAULT 0,
        position REAL,
        PRIMARY KEY (canonical_url, date, appearance)
      );
      CREATE INDEX idx_sc_page_date ON sc_page_daily(date);

      /* On-demand cache of the top queries of a page (28-day window). */
      CREATE TABLE sc_page_queries (
        canonical_url TEXT NOT NULL,
        query TEXT NOT NULL,
        window_from TEXT NOT NULL,
        window_to TEXT NOT NULL,
        clicks INTEGER NOT NULL DEFAULT 0,
        impressions INTEGER NOT NULL DEFAULT 0,
        ctr REAL,
        position REAL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (canonical_url, query)
      );

      ALTER TABLE product_signals ADD COLUMN sc_impressions_28d INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE product_signals ADD COLUMN sc_clicks_28d INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE product_signals ADD COLUMN sc_impressions_prev_28d INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE product_signals ADD COLUMN sc_position_28d REAL;
    `,
  },
];
