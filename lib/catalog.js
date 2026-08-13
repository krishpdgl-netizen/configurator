'use strict';
const { q, get, settingsCached } = require('./db');

/* `options.price` is your LANDED COST. What the customer sees is
   cost × (1 + category.margin_pct/100). Cost never leaves the server on a
   public endpoint, so margin policy stays internal and there is exactly one
   number for purchase to maintain. */

async function loadCategories() {
  return q.all('SELECT * FROM categories WHERE active=1 ORDER BY sort, label');
}
async function loadOptions() {
  const rows = await q.all('SELECT * FROM options WHERE active=1');
  return rows.map(o => ({ ...o, attrs: safeJson(o.attrs) }));
}
async function loadRules() {
  return q.all('SELECT * FROM rules ORDER BY sort, id');
}
function safeJson(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

async function marginMap() {
  const [defRaw, rows] = await Promise.all([
    get('default_margin_pct', '12'),
    q.all('SELECT id, margin_pct FROM categories')
  ]);
  const def = Number(defRaw);
  const m = {};
  rows.forEach(c => {
    m[c.id] = (c.margin_pct === null || c.margin_pct === undefined) ? def : Number(c.margin_pct);
  });
  return m;
}

function sellPrice(option, margins) {
  const pct = margins[option.category_id] ?? 0;
  return Math.round(Number(option.price) * (1 + pct / 100));
}

/** Full catalog for the customer-facing configurator: sell prices, no costs. */
async function publicCatalog() {
  const [margins, cats, opts, rules, s] = await Promise.all([
    marginMap(), loadCategories(), loadOptions(), loadRules(), settingsCached()
  ]);
  return {
    settings: {
      company: s.company || 'Our Company',
      currency: s.currency || '₹',
      locale: s.locale || 'en-IN',
      tax_label: s.tax_label || 'GST 18%',
      tax_rate: Number(s.tax_rate ?? 0.18)
    },
    categories: cats.map(c => ({
      id: c.id, label: c.label, note: c.note,
      required: !!c.required, max_qty: c.max_qty, multi: !!c.multi,
      options: opts.filter(o => o.category_id === c.id).map(o => ({
        id: o.id, name: o.name, specs: o.specs,
        price: sellPrice(o, margins),
        stock_qty: o.stock_qty, lead_days: o.lead_days,
        attrs: o.attrs
      }))
    })),
    rules: rules.map(r => ({ ...r, enabled: !!r.enabled }))
  };
}

/** Map of option_id -> option, used by the rule engine. */
async function optionsMap(list) {
  const src = list || await loadOptions();
  return Object.fromEntries(src.map(o => [o.id, o]));
}

/**
 * Price a build.
 * build: [{category_id, option_id, qty}]   units: how many identical systems
 */
async function priceBuild(build, units = 1) {
  const margins = await marginMap();
  const map = await optionsMap();
  const taxRate = Number(await get('tax_rate', '0.18'));
  const lines = build.map(b => {
    const o = map[b.option_id];
    if (!o) return null;
    const unit = sellPrice(o, margins);
    return {
      category_id: b.category_id, option_id: o.id, name: o.name,
      qty_per_unit: b.qty, qty_total: b.qty * units,
      unit_price: unit,
      cost: Number(o.price) * b.qty * units,
      amount: unit * b.qty * units,
      stock_qty: o.stock_qty, lead_days: o.lead_days,
      short_by: Math.max(0, b.qty * units - o.stock_qty)
    };
  }).filter(Boolean);

  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const cost = lines.reduce((s, l) => s + l.cost, 0);
  const tax = Math.round(subtotal * taxRate);
  return {
    lines, units, subtotal, tax, total: subtotal + tax,
    cost, gross_margin: subtotal - cost,
    gross_margin_pct: subtotal ? Math.round(((subtotal - cost) / subtotal) * 1000) / 10 : 0,
    lead_days: lines.reduce((m, l) => Math.max(m, l.short_by > 0 ? l.lead_days : 0), 0),
    shortfalls: lines.filter(l => l.short_by > 0)
  };
}

module.exports = {
  loadCategories, loadOptions, loadRules, publicCatalog,
  optionsMap, priceBuild, marginMap, sellPrice, safeJson
};
