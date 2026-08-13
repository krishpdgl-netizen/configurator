'use strict';
/* ---------------------------------------------------------------
   Postgres data layer (Neon).

   Replaces the better-sqlite3 version. The important difference:
   every query is async now, so every caller awaits. The helper
   below keeps the old call shape — q.get / q.all / q.run — so the
   rest of the code reads almost the same as before.

   Placeholders: write ? as you always did. They are rewritten to
   Postgres $1, $2 ... before the query is sent. Named parameters
   (@name) work too — pass an object.
   --------------------------------------------------------------- */
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy the connection string from your Neon dashboard.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  /* Neon terminates TLS at the pooler with a certificate that the
     default Node trust store handles, but some hosts still need this. */
  ssl: process.env.PGSSL_DISABLE === '1' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 8),
  idleTimeoutMillis: 30000
});

pool.on('error', (e) => console.error('[db] idle client error:', e.message));

/* Rewrite ? placeholders to $1..$n, or @named to $1..$n. */
function prep(sql, params) {
  if (params && !Array.isArray(params) && typeof params === 'object') {
    const out = [];
    const text = sql.replace(/@(\w+)/g, (_, name) => {
      if (!(name in params)) throw new Error(`Missing named parameter @${name}`);
      out.push(params[name]);
      return '$' + out.length;
    });
    return { text, values: out };
  }
  const values = Array.isArray(params) ? params : (params === undefined ? [] : [params]);
  let i = 0;
  const text = sql.replace(/\?/g, () => '$' + (++i));
  if (i !== values.length) {
    throw new Error(`Placeholder count (${i}) does not match parameter count (${values.length}) in: ${sql.slice(0, 120)}`);
  }
  return { text, values };
}

const q = {
  async all(sql, params) {
    const { text, values } = prep(sql, params);
    return (await pool.query(text, values)).rows;
  },
  async get(sql, params) {
    const { text, values } = prep(sql, params);
    return (await pool.query(text, values)).rows[0] || undefined;
  },
  async run(sql, params) {
    const { text, values } = prep(sql, params);
    const r = await pool.query(text, values);
    return { changes: r.rowCount, rows: r.rows };
  },
  /* Run several statements inside one transaction. Pass a function
     that receives a client-scoped q. */
  async tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = {
        all: async (s, p) => { const { text, values } = prep(s, p); return (await client.query(text, values)).rows; },
        get: async (s, p) => { const { text, values } = prep(s, p); return (await client.query(text, values)).rows[0] || undefined; },
        run: async (s, p) => { const { text, values } = prep(s, p); const r = await client.query(text, values); return { changes: r.rowCount, rows: r.rows }; }
      };
      const result = await fn(scoped);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
};

/* ---------- schema ----------
   SQLite -> Postgres changes worth knowing:
     INTEGER PRIMARY KEY AUTOINCREMENT  ->  SERIAL PRIMARY KEY
     REAL                               ->  DOUBLE PRECISION
     datetime('now')                    ->  now()
     0/1 integer booleans are kept as INTEGER on purpose, so the
     admin UI and rules engine keep working unchanged.
------------------------------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  note        TEXT DEFAULT '',
  sort        INTEGER DEFAULT 0,
  required    INTEGER DEFAULT 0,
  max_qty     INTEGER DEFAULT 1,
  multi       INTEGER DEFAULT 0,
  margin_pct  DOUBLE PRECISION DEFAULT 0,
  active      INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS options (
  id          TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  specs       TEXT DEFAULT '',
  price       DOUBLE PRECISION DEFAULT 0,
  stock_qty   INTEGER DEFAULT 0,
  lead_days   INTEGER DEFAULT 0,
  active      INTEGER DEFAULT 1,
  attrs       TEXT DEFAULT '{}',
  updated_at  TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS rules (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  severity    TEXT DEFAULT 'block',
  message     TEXT NOT NULL,
  enabled     INTEGER DEFAULT 1,
  sort        INTEGER DEFAULT 0,
  left_kind   TEXT DEFAULT 'attr',
  left_cats   TEXT DEFAULT '',
  left_attr   TEXT DEFAULT '',
  left_scale  DOUBLE PRECISION DEFAULT 1,
  left_offset DOUBLE PRECISION DEFAULT 0,
  op          TEXT DEFAULT 'eq',
  right_kind  TEXT DEFAULT 'attr',
  right_cats  TEXT DEFAULT '',
  right_attr  TEXT DEFAULT '',
  right_const TEXT DEFAULT '',
  expr        TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS extraction_fields (
  id         SERIAL PRIMARY KEY,
  key        TEXT UNIQUE NOT NULL,
  label      TEXT NOT NULL,
  hint       TEXT DEFAULT '',
  type       TEXT DEFAULT 'text',
  group_name TEXT DEFAULT 'Commercial',
  sort       INTEGER DEFAULT 0,
  active     INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS leads (
  id          SERIAL PRIMARY KEY,
  ref         TEXT,
  name        TEXT, company TEXT, mobile TEXT, email TEXT, city TEXT,
  units       INTEGER DEFAULT 1,
  notes       TEXT,
  config_json TEXT,
  subtotal    DOUBLE PRECISION, tax DOUBLE PRECISION, total DOUBLE PRECISION,
  source      TEXT DEFAULT 'configurator',
  created_at  TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS tenders (
  id          SERIAL PRIMARY KEY,
  ref         TEXT,
  filename    TEXT,
  pages       INTEGER DEFAULT 0,
  chars       INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'uploaded',
  error       TEXT DEFAULT '',
  raw_text    TEXT,
  meta_json   TEXT DEFAULT '{}',
  items_json  TEXT DEFAULT '[]',
  match_json  TEXT DEFAULT '{}',
  created_at  TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_options_category ON options(category_id);
CREATE INDEX IF NOT EXISTS idx_tenders_created ON tenders(id DESC);
CREATE INDEX IF NOT EXISTS idx_leads_created   ON leads(id DESC);
`;

/* ---------- settings helpers ---------- */
async function set(k, v) {
  await q.run(
    `INSERT INTO settings(key,value) VALUES(?,?)
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    [k, String(v)]
  );
}
async function get(k, fallback = null) {
  const r = await q.get('SELECT value FROM settings WHERE key=?', [k]);
  return r ? r.value : fallback;
}
async function allSettings() {
  const rows = await q.all('SELECT key,value FROM settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

/* ---------- settings cache ----------
   The rules engine and pricing read settings on nearly every request.
   Going to Postgres each time would add a network round trip per read,
   which matters now that the database is not a local file. Cached for
   a few seconds and cleared on write. */
let cache = null, cacheAt = 0;
const CACHE_MS = Number(process.env.SETTINGS_CACHE_MS || 5000);
async function settingsCached() {
  const now = Date.now();
  if (!cache || now - cacheAt > CACHE_MS) {
    cache = await allSettings();
    cacheAt = now;
  }
  return cache;
}
function clearSettingsCache() { cache = null; }

/* ---------- migration / seed ---------- */
async function init() {
  /* Run each statement separately: some drivers and poolers refuse
     multi-statement queries, and a single failure is easier to read. */
  const statements = SCHEMA.split(';').map(x => x.trim()).filter(Boolean);
  for (const stmt of statements) {
    await pool.query(stmt);
  }
  await seed();
}

async function seed() {
  const c = await q.get('SELECT COUNT(*)::int AS c FROM settings');
  if (c && c.c > 0) return;   // already initialised — never overwrite live data

  const defaults = {
    company: 'Northbay Systems',
    currency: '₹',
    locale: 'en-IN',
    tax_label: 'GST 18%',
    tax_rate: '0.18',
    default_margin_pct: '12',
    google_form_action: ''
  };
  for (const [k, v] of Object.entries(defaults)) await set(k, v);

  const F = [
    ['tender_no', 'Tender / NIT number', 'Reference the buyer uses', 'text', 'Identification'],
    ['issuing_authority', 'Issuing authority', 'Department or PSU floating the tender', 'text', 'Identification'],
    ['title', 'Title / scope', 'One line on what is being procured', 'text', 'Identification'],
    ['bid_due_date', 'Bid submission deadline', 'Last date and time for submission', 'date', 'Dates'],
    ['prebid_date', 'Pre-bid meeting date', '', 'date', 'Dates'],
    ['delivery_period_days', 'Delivery period (days)', 'Days from PO to delivery', 'number', 'Dates'],
    ['emd_amount', 'EMD amount', 'Earnest money deposit', 'money', 'Commercial'],
    ['emd_exemption', 'EMD exemption allowed', 'MSME / NSIC / startup exemption terms', 'text', 'Commercial'],
    ['tender_value', 'Estimated tender value', '', 'money', 'Commercial'],
    ['pbg_percent', 'Performance bank guarantee %', '', 'number', 'Commercial'],
    ['payment_terms', 'Payment terms', 'Milestones, retention, credit period', 'text', 'Commercial'],
    ['ld_penalty', 'Liquidated damages / penalty', 'Rate and ceiling for late delivery', 'text', 'Commercial'],
    ['warranty_years', 'Warranty required (years)', 'Comprehensive on-site warranty period', 'number', 'Technical'],
    ['sla_terms', 'SLA / uptime obligation', 'Response and resolution times', 'text', 'Technical'],
    ['oem_criteria', 'OEM eligibility criteria', 'Turnover, years in business, MAF, certifications', 'list', 'Eligibility'],
    ['certifications', 'Certifications demanded', 'BIS, ISO, EPEAT, Energy Star, TEC, MII', 'list', 'Eligibility'],
    ['make_in_india', 'Make in India / local content', 'Class-I / Class-II local supplier clause', 'text', 'Eligibility'],
    ['consignee_locations', 'Delivery locations', 'Sites and quantity per site', 'list', 'Logistics'],
    ['installation_scope', 'Installation & commissioning scope', '', 'text', 'Logistics'],
    ['training_scope', 'Training / manpower scope', '', 'text', 'Logistics'],
    ['evaluation_method', 'Evaluation method', 'L1, QCBS, technical qualification criteria', 'text', 'Commercial'],
    ['risk_flags', 'Unusual or risky clauses', 'Anything punitive, ambiguous or OEM-specific', 'list', 'Risk']
  ];
  for (let i = 0; i < F.length; i++) {
    const f = F[i];
    await q.run(
      `INSERT INTO extraction_fields(key,label,hint,type,group_name,sort)
       VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO NOTHING`,
      [f[0], f[1], f[2], f[3], f[4], i]
    );
  }
}

module.exports = { q, pool, init, set, get, allSettings, settingsCached, clearSettingsCache };
