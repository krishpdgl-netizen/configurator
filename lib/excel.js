'use strict';
const XLSX = require('xlsx');
const { q } = require('./db');
const { safeJson } = require('./catalog');

/* ============================================================================
   EXCEL ROUND TRIP
   Export gives the exact sheet shape the importer expects, so the workflow is:
   download → edit in Excel → upload. Nothing is deleted on import; rows are
   created or updated by id. To retire a part set active = 0.

   Attribute columns are named  attr.<key>.  Add a column, add an attribute —
   no code change. Multi-value attributes use a pipe:  ATX|EATX
   ========================================================================== */

const FIXED_OPTION_COLS = ['id', 'category_id', 'name', 'specs', 'cost', 'stock_qty', 'lead_days', 'active'];

async function exportWorkbook() {
  const cats = await q.all('SELECT * FROM categories ORDER BY sort');
  const opts = await q.all('SELECT * FROM options ORDER BY category_id, name');
  const rules = await q.all('SELECT * FROM rules ORDER BY sort, id');

  const attrKeys = [...new Set(opts.flatMap(o => Object.keys(safeJson(o.attrs))))].sort();

  const optRows = opts.map(o => {
    const a = safeJson(o.attrs);
    const row = {
      id: o.id, category_id: o.category_id, name: o.name, specs: o.specs,
      cost: o.price, stock_qty: o.stock_qty, lead_days: o.lead_days, active: o.active
    };
    attrKeys.forEach(k => {
      const v = a[k];
      row['attr.' + k] = Array.isArray(v) ? v.join('|') : (v ?? '');
    });
    return row;
  });

  const catRows = cats.map(c => ({
    id: c.id, label: c.label, note: c.note, sort: c.sort,
    required: c.required, max_qty: c.max_qty, multi: c.multi,
    margin_pct: c.margin_pct, active: c.active
  }));

  const ruleRows = rules.map(r => ({
    id: r.id, name: r.name, enabled: r.enabled, severity: r.severity, sort: r.sort,
    left_kind: r.left_kind, left_cats: r.left_cats, left_attr: r.left_attr,
    left_scale: r.left_scale, left_offset: r.left_offset,
    op: r.op,
    right_kind: r.right_kind, right_cats: r.right_cats, right_attr: r.right_attr, right_const: r.right_const,
    message: r.message, expr: r.expr
  }));

  const help = [
    { field: 'Sheet: Categories', meaning: 'One row per parameter group shown to the customer.' },
    { field: 'required', meaning: '1 = the customer cannot submit without choosing one.' },
    { field: 'max_qty', meaning: 'Highest quantity of one option (RAM sticks, drives).' },
    { field: 'multi', meaning: '1 = several different options can be picked together (services).' },
    { field: 'margin_pct', meaning: 'Markup added to cost for the price the customer sees.' },
    { field: 'Sheet: Options', meaning: 'One row per SKU. cost = your landed cost, not the sale price.' },
    { field: 'stock_qty', meaning: 'On-hand units. Drives the availability check on tenders.' },
    { field: 'lead_days', meaning: 'Procurement time when stock runs short.' },
    { field: 'attr.* columns', meaning: 'Technical attributes. Add a column to add an attribute. Pipe-separate lists: ATX|EATX' },
    { field: 'Sheet: Rules', meaning: 'Compatibility logic. Reads as: LEFT (op) RIGHT must be true, else show message.' },
    { field: 'left_kind', meaning: 'attr = attribute of the chosen part · count = how many chosen · sum = Σ attr×qty · const = fixed value' },
    { field: 'left_attr', meaning: 'Attribute name without the attr. prefix. Pipe = fallbacks, e.g. tdp|watt' },
    { field: 'op', meaning: 'eq neq lte gte lt gt in not_in contains' },
    { field: 'message', meaning: 'Shown to the customer. {left} and {right} are replaced with the actual values.' },
    { field: 'Import behaviour', meaning: 'Rows are matched on id and updated; new ids are created. Nothing is deleted — set active = 0 to retire.' }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows), 'Categories');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(optRows), 'Options');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ruleRows), 'Rules');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(help), 'How to use');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function coerce(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s.includes('|')) return s.split('|').map(x => x.trim()).filter(Boolean);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

async function importWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const report = { categories: 0, options: 0, rules: 0, errors: [] };
  const sheet = n => wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '' }) : [];

  const CAT_SQL = `INSERT INTO categories(id,label,note,sort,required,max_qty,multi,margin_pct,active)
    VALUES(@id,@label,@note,@sort,@required,@max_qty,@multi,@margin_pct,@active)
    ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,note=EXCLUDED.note,sort=EXCLUDED.sort,
      required=EXCLUDED.required,max_qty=EXCLUDED.max_qty,multi=EXCLUDED.multi,
      margin_pct=EXCLUDED.margin_pct,active=EXCLUDED.active`;

  const OPT_SQL = `INSERT INTO options(id,category_id,name,specs,price,stock_qty,lead_days,active,attrs,updated_at)
    VALUES(@id,@category_id,@name,@specs,@price,@stock_qty,@lead_days,@active,@attrs,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
    ON CONFLICT(id) DO UPDATE SET category_id=EXCLUDED.category_id,name=EXCLUDED.name,specs=EXCLUDED.specs,
      price=EXCLUDED.price,stock_qty=EXCLUDED.stock_qty,lead_days=EXCLUDED.lead_days,
      active=EXCLUDED.active,attrs=EXCLUDED.attrs,updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')`;

  const RULE_INS = `INSERT INTO rules
    (name,severity,message,enabled,sort,left_kind,left_cats,left_attr,left_scale,left_offset,op,right_kind,right_cats,right_attr,right_const,expr)
    VALUES(@name,@severity,@message,@enabled,@sort,@left_kind,@left_cats,@left_attr,@left_scale,@left_offset,@op,@right_kind,@right_cats,@right_attr,@right_const,@expr)`;

  const RULE_UPD = `UPDATE rules SET name=@name,severity=@severity,message=@message,enabled=@enabled,sort=@sort,
      left_kind=@left_kind,left_cats=@left_cats,left_attr=@left_attr,left_scale=@left_scale,left_offset=@left_offset,
      op=@op,right_kind=@right_kind,right_cats=@right_cats,right_attr=@right_attr,right_const=@right_const,expr=@expr
    WHERE id=@id`;

  /* One transaction for the whole workbook: a half-applied price list is
     worse than a rejected one. Any error rolls the entire import back. */
  try {
    await q.tx(async (t) => {
      for (const r of sheet('Categories')) {
        if (!r.id) continue;
        await t.run(CAT_SQL, {
          id: String(r.id).trim(), label: String(r.label || r.id), note: String(r.note || ''),
          sort: Number(r.sort) || 0, required: Number(r.required) ? 1 : 0,
          max_qty: Number(r.max_qty) || 1, multi: Number(r.multi) ? 1 : 0,
          margin_pct: Number(r.margin_pct) || 0, active: r.active === '' ? 1 : (Number(r.active) ? 1 : 0)
        });
        report.categories++;
      }

      const known = new Set((await t.all('SELECT id FROM categories')).map(c => c.id));
      for (const r of sheet('Options')) {
        if (!r.id) continue;
        const cid = String(r.category_id || '').trim();
        if (!known.has(cid)) { report.errors.push(`Option ${r.id}: unknown category "${cid}" — row skipped.`); continue; }
        const attrs = {};
        for (const [k, v] of Object.entries(r)) {
          if (!k.startsWith('attr.')) continue;
          const val = coerce(v);
          if (val !== '') attrs[k.slice(5)] = val;
        }
        await t.run(OPT_SQL, {
          id: String(r.id).trim(), category_id: cid, name: String(r.name || r.id), specs: String(r.specs || ''),
          price: Number(r.cost) || 0, stock_qty: Number(r.stock_qty) || 0, lead_days: Number(r.lead_days) || 0,
          active: r.active === '' ? 1 : (Number(r.active) ? 1 : 0),
          attrs: JSON.stringify(attrs)
        });
        report.options++;
      }

      for (const r of sheet('Rules')) {
        if (!r.name) continue;
        const row = {
          id: r.id || null, name: String(r.name), severity: r.severity === 'warn' ? 'warn' : 'block',
          message: String(r.message || r.name), enabled: r.enabled === '' ? 1 : (Number(r.enabled) ? 1 : 0),
          sort: Number(r.sort) || 0,
          left_kind: String(r.left_kind || 'attr'), left_cats: String(r.left_cats || ''), left_attr: String(r.left_attr || ''),
          left_scale: Number(r.left_scale) || 1, left_offset: Number(r.left_offset) || 0,
          op: String(r.op || 'eq'),
          right_kind: String(r.right_kind || 'attr'), right_cats: String(r.right_cats || ''),
          right_attr: String(r.right_attr || ''), right_const: String(r.right_const ?? ''),
          expr: String(r.expr || '')
        };
        const exists = row.id && await t.get('SELECT 1 FROM rules WHERE id=?', [row.id]);
        if (exists) await t.run(RULE_UPD, row);
        else { const { id, ...ins } = row; await t.run(RULE_INS, ins); }
        report.rules++;
      }
    });
  } catch (e) {
    report.errors.push(e.message + ' — nothing was imported.');
  }
  return report;
}

module.exports = { exportWorkbook, importWorkbook };
