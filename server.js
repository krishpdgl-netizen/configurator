'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const { q, init, set, get, allSettings, clearSettingsCache } = require('./lib/db');
const cat = require('./lib/catalog');
const { evaluate } = require('./lib/rules');
const { exportWorkbook, importWorkbook } = require('./lib/excel');
const { extractText } = require('./lib/textract');
const tender = require('./lib/tender');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/* ---- serve the rule engine to the browser so the configurator validates
        instantly, using the exact same code the server trusts ---- */
const ruleSrc = fs.readFileSync(path.join(__dirname, 'lib', 'rules.js'), 'utf8');
app.get('/rules.browser.js', async (req, res) => {
  res.type('application/javascript').send(
    `(function(){const module={exports:{}};\n${ruleSrc}\nwindow.RuleEngine=module.exports;})();`
  );
});
/* ---- Keep the internal pages off the public internet.

   cloudflared runs on this machine and connects to localhost, so every
   tunnelled request arrives with a loopback address — an IP check alone
   would let the whole internet through. Cloudflare stamps its own
   headers on proxied traffic, so we treat the presence of those as
   proof the request came from outside.

   Set ALLOW_REMOTE_ADMIN=1 in .env to disable this (don't, unless you
   have put real authentication in front of it). ---- */
function isTunnelled(req) {
  return !!(req.get('cf-connecting-ip') || req.get('cf-ray') ||
            req.get('x-forwarded-for'));
}
function internalOnly(req, res, next) {
  if (process.env.ALLOW_REMOTE_ADMIN === '1') return next();
  if (isTunnelled(req)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  next();
}
app.use(['/admin.html', '/tender.html'], internalOnly);

app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 60 * 1024 * 1024 }
});

/* =========================== ADMIN AUTH =========================== */
function admin(req, res, next) {
  if (process.env.ALLOW_REMOTE_ADMIN !== '1' && isTunnelled(req)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const token = req.get('x-admin-token') || req.query.token ||
    (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('admtok='))?.slice(7);
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Not authorised' });
  next();
}

/* =========================== PUBLIC =========================== */
app.get('/api/catalog', async (req, res) => res.json(await cat.publicCatalog()));

app.post('/api/leads', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const company = String(b.company || '').trim();
  const mobile = String(b.mobile || '').trim();
  if (!name || !company || !mobile) return res.status(400).json({ error: 'Name, company and mobile are required.' });
  if (!/^[0-9+\-\s()]{8,18}$/.test(mobile)) return res.status(400).json({ error: 'That mobile number does not look right.' });

  const build = Array.isArray(b.build) ? b.build : [];
  const options = await cat.optionsMap();
  const violations = evaluate(build, options, await cat.loadRules());
  if (violations.some(v => v.severity === 'block')) {
    return res.status(400).json({ error: 'This configuration is not buildable.', violations });
  }
  const units = Math.max(1, Number(b.units) || 1);
  const priced = await cat.priceBuild(build, units);
  const ref = 'ENQ-' + Date.now().toString(36).toUpperCase().slice(-5) + '-' +
    Math.random().toString(36).slice(2, 5).toUpperCase();

  const summary = priced.lines.map(l => `${l.name} × ${l.qty_per_unit}`).join('; ');
  await q.run(`INSERT INTO leads(ref,name,company,mobile,email,city,units,notes,config_json,subtotal,tax,total)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [ref, name, company, mobile, String(b.email || ''), String(b.city || ''), units,
    String(b.notes || ''), JSON.stringify({ build, lines: priced.lines }),
    priced.subtotal, priced.tax, priced.total]);

  /* optional mirror into a Google Form, if one is configured */
  const action = await get('google_form_action', '');
  if (action) {
    try {
      const f = JSON.parse(await get('google_form_fields', '{}'));
      const body = new URLSearchParams();
      const values = { ref, name, company, mobile, email: b.email || '', config: summary, total: String(priced.total) };
      for (const [k, entry] of Object.entries(f)) if (values[k] !== undefined) body.append(entry, values[k]);
      fetch(action, { method: 'POST', body }).catch(() => {});
    } catch { /* never let the mirror break the enquiry */ }
  }
  res.json({ ok: true, ref, total: priced.total });
});

/* =========================== ADMIN: CATALOG =========================== */
app.get('/api/admin/bootstrap', admin, async (req, res) => {
  res.json({
    settings: await allSettings(),
    categories: await q.all('SELECT * FROM categories ORDER BY sort'),
    options: (await q.all('SELECT * FROM options ORDER BY category_id, name'))
      .map(o => ({ ...o, attrs: cat.safeJson(o.attrs) })),
    rules: await q.all('SELECT * FROM rules ORDER BY sort, id'),
    fields: await q.all('SELECT * FROM extraction_fields ORDER BY sort, id'),
    attr_keys: [...new Set((await q.all('SELECT attrs FROM options'))
      .flatMap(o => Object.keys(cat.safeJson(o.attrs))))].sort()
  });
});

app.post('/api/admin/category', admin, async (req, res) => {
  const b = req.body;
  if (!b.id || !b.label) return res.status(400).json({ error: 'id and label are required' });
  await q.run(`INSERT INTO categories(id,label,note,sort,required,max_qty,multi,margin_pct,active)
    VALUES(@id,@label,@note,@sort,@required,@max_qty,@multi,@margin_pct,@active)
    ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,note=EXCLUDED.note,sort=EXCLUDED.sort,
      required=EXCLUDED.required,max_qty=EXCLUDED.max_qty,multi=EXCLUDED.multi,
      margin_pct=EXCLUDED.margin_pct,active=EXCLUDED.active`, {
    id: String(b.id).trim(), label: b.label, note: b.note || '', sort: Number(b.sort) || 0,
    required: b.required ? 1 : 0, max_qty: Number(b.max_qty) || 1, multi: b.multi ? 1 : 0,
    margin_pct: (b.margin_pct === undefined || b.margin_pct === null || b.margin_pct === '')
      ? null                       /* NULL = fall back to default_margin_pct */
      : Number(b.margin_pct) || 0,
    active: b.active === false ? 0 : 1
  });
  res.json({ ok: true });
});

app.post('/api/admin/option', admin, async (req, res) => {
  const b = req.body;
  if (!b.id || !b.category_id) return res.status(400).json({ error: 'id and category_id are required' });
  await q.run(`INSERT INTO options(id,category_id,name,specs,price,stock_qty,lead_days,active,attrs,updated_at)
    VALUES(@id,@category_id,@name,@specs,@price,@stock_qty,@lead_days,@active,@attrs,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
    ON CONFLICT(id) DO UPDATE SET category_id=EXCLUDED.category_id,name=EXCLUDED.name,specs=EXCLUDED.specs,
      price=EXCLUDED.price,stock_qty=EXCLUDED.stock_qty,lead_days=EXCLUDED.lead_days,active=EXCLUDED.active,
      attrs=EXCLUDED.attrs,updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')`, {
    id: String(b.id).trim(), category_id: b.category_id, name: b.name || b.id, specs: b.specs || '',
    price: Number(b.price) || 0, stock_qty: Number(b.stock_qty) || 0, lead_days: Number(b.lead_days) || 0,
    active: b.active === false ? 0 : 1, attrs: JSON.stringify(b.attrs || {})
  });
  res.json({ ok: true });
});

app.delete('/api/admin/option/:id', admin, async (req, res) => {
  await q.run('UPDATE options SET active=0 WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/rule', admin, async (req, res) => {
  const b = req.body;
  const row = {
    id: b.id || null, name: b.name || 'Untitled rule', severity: b.severity === 'warn' ? 'warn' : 'block',
    message: b.message || b.name || '', enabled: b.enabled === false ? 0 : 1, sort: Number(b.sort) || 0,
    left_kind: b.left_kind || 'attr', left_cats: b.left_cats || '', left_attr: b.left_attr || '',
    left_scale: Number(b.left_scale) || 1, left_offset: Number(b.left_offset) || 0,
    op: b.op || 'eq', right_kind: b.right_kind || 'attr', right_cats: b.right_cats || '',
    right_attr: b.right_attr || '', right_const: String(b.right_const ?? ''), expr: b.expr || ''
  };
  if (row.id) {
    await q.run(`UPDATE rules SET name=@name,severity=@severity,message=@message,enabled=@enabled,sort=@sort,
      left_kind=@left_kind,left_cats=@left_cats,left_attr=@left_attr,left_scale=@left_scale,left_offset=@left_offset,
      op=@op,right_kind=@right_kind,right_cats=@right_cats,right_attr=@right_attr,right_const=@right_const,expr=@expr
      WHERE id=@id`, row);
  } else {
    const r = await q.run(`INSERT INTO rules
      (name,severity,message,enabled,sort,left_kind,left_cats,left_attr,left_scale,left_offset,op,right_kind,right_cats,right_attr,right_const,expr)
      VALUES(@name,@severity,@message,@enabled,@sort,@left_kind,@left_cats,@left_attr,@left_scale,@left_offset,@op,@right_kind,@right_cats,@right_attr,@right_const,@expr)
      RETURNING id`, row);
    row.id = r.rows[0].id;
  }
  res.json({ ok: true, id: row.id });
});

app.delete('/api/admin/rule/:id', admin, async (req, res) => {
  await q.run('DELETE FROM rules WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

/* Try a rule set against a sample build before it goes live */
app.post('/api/admin/rule-test', admin, async (req, res) => {
  const build = req.body.build || [];
  res.json({ violations: evaluate(build, await cat.optionsMap(), await cat.loadRules()) });
});

app.post('/api/admin/settings', admin, async (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) await set(k, typeof v === 'object' ? JSON.stringify(v) : v);
  res.json({ ok: true });
});

app.post('/api/admin/field', admin, async (req, res) => {
  const b = req.body;
  if (!b.key) return res.status(400).json({ error: 'key is required' });
  await q.run(`INSERT INTO extraction_fields(key,label,hint,type,group_name,sort,active)
    VALUES(@key,@label,@hint,@type,@group_name,@sort,@active)
    ON CONFLICT(key) DO UPDATE SET label=EXCLUDED.label,hint=EXCLUDED.hint,type=EXCLUDED.type,
      group_name=EXCLUDED.group_name,sort=EXCLUDED.sort,active=EXCLUDED.active`, {
    key: String(b.key).trim().replace(/\s+/g, '_').toLowerCase(),
    label: b.label || b.key, hint: b.hint || '', type: b.type || 'text',
    group_name: b.group_name || 'Other', sort: Number(b.sort) || 0, active: b.active === false ? 0 : 1
  });
  res.json({ ok: true });
});

app.delete('/api/admin/field/:key', admin, async (req, res) => {
  await q.run('DELETE FROM extraction_fields WHERE key=?', [req.params.key]);
  res.json({ ok: true });
});

app.get('/api/admin/leads', admin, async (req, res) => {
  res.json(await q.all('SELECT * FROM leads ORDER BY id DESC LIMIT 500'));
});

/* ---- Excel round trip ---- */
app.get('/api/admin/export.xlsx', admin, async (req, res) => {
  const buf = await exportWorkbook();
  res.setHeader('Content-Disposition', `attachment; filename="catalog-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
});

app.post('/api/admin/import', admin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const report = await importWorkbook(fs.readFileSync(req.file.path));
    res.json(report);
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

/* =========================== TENDERS =========================== */
app.get('/api/tenders', admin, async (req, res) => {
  res.json(await q.all(`SELECT id,ref,filename,pages,chars,status,error,created_at FROM tenders
    ORDER BY id DESC LIMIT 100`));
});

app.post('/api/tender/upload', admin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const r = await extractText(req.file.path, req.file.originalname);
    const ref = 'TND-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' +
      Math.random().toString(36).slice(2, 5).toUpperCase();
    const info = await q.run(`INSERT INTO tenders(ref,filename,pages,chars,status,raw_text,error)
      VALUES(?,?,?,?,?,?,?) RETURNING id`, [ref, req.file.originalname, r.pages, r.chars,
      r.needsOcr ? 'failed' : 'uploaded', r.text,
      r.needsOcr ? 'This looks like a scanned document — almost no selectable text. Run OCR first (ocrmypdf in.pdf out.pdf) and upload again.' : '']);
    res.json({ id: info.rows[0].id, ref, pages: r.pages, chars: r.chars, needsOcr: r.needsOcr });
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

app.post('/api/tender/:id/analyse', admin, async (req, res) => {
  const row = await q.get('SELECT * FROM tenders WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Tender not found' });
  await q.run("UPDATE tenders SET status='reading', error='' WHERE id=?", [row.id]);
  try {
    const result = await tender.analyse(row.raw_text, { useAi: req.body?.useAi !== false });
    await q.run(`UPDATE tenders SET status='ready', meta_json=?, items_json=?, match_json=? WHERE id=?`, [JSON.stringify(result.meta), JSON.stringify(result.items), JSON.stringify({
        mode: result.mode, pages_read: result.pages_read, risks: result.risks, totals: result.totals
      }), row.id]);
    res.json({ ok: true, ...result });
  } catch (e) {
    await q.run("UPDATE tenders SET status='failed', error=? WHERE id=?", [e.message, row.id]);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tender/:id', admin, async (req, res) => {
  const row = await q.get('SELECT * FROM tenders WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Tender not found' });
  res.json({
    id: row.id, ref: row.ref, filename: row.filename, pages: row.pages, status: row.status, error: row.error,
    meta: cat.safeJson(row.meta_json), items: JSON.parse(row.items_json || '[]'),
    match: cat.safeJson(row.match_json),
    fields: await q.all('SELECT * FROM extraction_fields WHERE active=1 ORDER BY sort')
  });
});

/* Human override: swap a part on one tender line and re-price everything. */
app.post('/api/tender/:id/override', admin, async (req, res) => {
  const row = await q.get('SELECT * FROM tenders WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Tender not found' });
  const items = JSON.parse(row.items_json || '[]');
  const { itemIndex, category_id, option_id, qty } = req.body;
  const item = items[itemIndex];
  if (!item) return res.status(400).json({ error: 'No such line item' });

  item.build = (item.build || []).filter(b => b.category_id !== category_id);
  if (option_id) item.build.push({ category_id, option_id, qty: Math.max(1, Number(qty) || 1) });

  const opts = await cat.loadOptions();
  (item.requirements || []).forEach(r => {
    if (r.category_id !== category_id) return;
    const b = item.build.find(x => x.category_id === category_id);
    r.option_id = b ? b.option_id : null;
    r.option_name = b ? (opts.find(o => o.id === b.option_id) || {}).name : null;
    r.qty_per_unit = b ? b.qty : 0;
  });
  item.violations = evaluate(item.build, await cat.optionsMap(opts), await cat.loadRules());
  item.quote = await cat.priceBuild(item.build, item.quantity || 1);
  item.overridden = true;
  items[itemIndex] = item;

  const match = cat.safeJson(row.match_json);
  const sub = items.reduce((s, i) => s + i.quote.subtotal, 0);
  const taxRate = Number(await get('tax_rate', '0.18'));
  match.totals = { subtotal: sub, tax: Math.round(sub * taxRate), total: sub + Math.round(sub * taxRate), cost: items.reduce((s, i) => s + i.quote.cost, 0) };
  await q.run('UPDATE tenders SET items_json=?, match_json=? WHERE id=?', [JSON.stringify(items), JSON.stringify(match), row.id]);
  res.json({ ok: true, item, totals: match.totals });
});

/* Rough quotation as a spreadsheet your team can finish in Excel */
app.get('/api/tender/:id/quote.xlsx', admin, async (req, res) => {
  const row = await q.get('SELECT * FROM tenders WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).send('Not found');
  const items = JSON.parse(row.items_json || '[]');
  const meta = cat.safeJson(row.meta_json);
  const cur = await get('currency', '₹');

  const head = [
    { Field: 'Quotation reference', Value: row.ref },
    { Field: 'Tender', Value: meta?.tender_id?.value || row.filename },
    { Field: 'Authority', Value: meta?.issuing_authority?.value || '' },
    { Field: 'Bid due', Value: meta?.bid_due_date?.value || '' },
    { Field: 'Prepared', Value: new Date().toISOString().slice(0, 10) },
    { Field: 'Status', Value: 'BUDGETARY ESTIMATE — subject to confirmation' }
  ];

  const lines = [];
  items.forEach((it, i) => {
    (it.quote?.lines || []).forEach(l => lines.push({
      'Line': `${i + 1}`,
      'System': it.name,
      'Systems qty': it.quantity,
      'Component': l.name,
      'SKU': l.option_id,
      'Qty / system': l.qty_per_unit,
      'Total qty': l.qty_total,
      [`Unit rate (${cur})`]: l.unit_price,
      [`Amount (${cur})`]: l.amount,
      'In stock': l.stock_qty,
      'Short by': l.short_by,
      'Lead days': l.lead_days
    }));
  });

  const sub = items.reduce((s, i) => s + (i.quote?.subtotal || 0), 0);
  const taxRate = Number(await get('tax_rate', '0.18'));
  lines.push({}, { Component: 'Subtotal', [`Amount (${cur})`]: sub });
  lines.push({ Component: await get('tax_label', 'GST'), [`Amount (${cur})`]: Math.round(sub * taxRate) });
  lines.push({ Component: 'Total', [`Amount (${cur})`]: sub + Math.round(sub * taxRate) });

  const keyPoints = Object.entries(meta || {})
    .filter(([k]) => !k.startsWith('_') && k !== 'confidence' && k !== 'notes')
    .map(([k, v]) => ({
      'Key point': k, Value: Array.isArray(v?.value) ? v.value.join('; ') : (v?.value ?? ''),
      Page: v?.page ?? '', Evidence: v?.evidence ?? ''
    }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(head), 'Header');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lines), 'Quotation');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(keyPoints), 'Tender key points');
  res.setHeader('Content-Disposition', `attachment; filename="${row.ref}-estimate.xlsx"`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

/* =========================== START =========================== */
const AI_KEY_SET = () => !!(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
const AI_NAME = () => {
  const p = String(process.env.AI_PROVIDER || '').toLowerCase();
  if (p) return p;
  return process.env.GEMINI_API_KEY ? 'gemini' : 'anthropic';
};
app.get('/health', async (req, res) => res.json({ ok: true, ai: AI_KEY_SET(), provider: AI_NAME() }));
/* Connect and create the schema before accepting traffic. If the database
   is unreachable we fail loudly at boot rather than 500ing on first request. */
init()
  .then(async () => {
    const company = await get('company', 'Configurator');
    app.listen(PORT, () => {
      console.log(`\n  ${company} running on port ${PORT}`);
      console.log(`  Customer   /`);
      console.log(`  Admin      /admin.html`);
      console.log(`  Tenders    /tender.html`);
      console.log(`  Database   connected`);
      console.log(`  AI         ${AI_KEY_SET() ? AI_NAME() + ' key set' : 'NO key — tender reading falls back to pattern matching'}\n`);
    });
  })
  .catch((e) => {
    console.error('\n  Could not start: ' + e.message);
    console.error('  Check DATABASE_URL is set and the Neon database is reachable.\n');
    process.exit(1);
  });
