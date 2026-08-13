'use strict';
/* ============================================================================
   RULE ENGINE
   ----------------------------------------------------------------------------
   A rule reads as one sentence:

       <LEFT> must <OP> <RIGHT>          … otherwise show <message>

   LEFT / RIGHT are each one of:
     attr  — an attribute of the option chosen in a category   (cpu.socket)
     count — how many units are chosen in a category           (count of memory)
     sum   — Σ attribute × quantity across one or more cats    (Σ tdp of cpu,gpu)
     const — a fixed number, word, or comma list

   LEFT also supports  × scale  and  + offset  so things like
   "draw × 1.25 + 110 W  must be ≤  psu.watt"  are expressible without code.

   An attribute name may list fallbacks with a pipe: "tdp|watt" means
   "use tdp, or watt if the part has no tdp". That lets one power rule cover
   CPUs, GPUs, NICs and drives even though their datasheets name the field
   differently.

   Rules that genuinely cannot be expressed this way can use `expr`, a small
   JavaScript escape hatch for a developer. Everything else stays editable by
   whoever knows the hardware.
   ========================================================================== */

const num = v => (typeof v === 'number' ? v : (v === '' || v == null || isNaN(Number(v)) ? null : Number(v)));

function asList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (v == null) return [];
  return String(v).split(/[,|]/).map(s => s.trim()).filter(Boolean);
}

function pickAttr(attrs, spec) {
  for (const key of String(spec || '').split('|').map(s => s.trim())) {
    if (key && attrs && attrs[key] !== undefined && attrs[key] !== null && attrs[key] !== '') return attrs[key];
  }
  return undefined;
}

/* ---------------------------------------------------------------------------
   A "build" is: [{ category_id, option_id, qty }]
   `options` is a map of option_id -> option row (attrs already parsed)
   --------------------------------------------------------------------------- */
function makeCtx(build, options) {
  const rows = build
    .map(b => ({ ...b, opt: options[b.option_id] }))
    .filter(r => r.opt);

  const inCats = cats => {
    const list = asList(cats);
    return rows.filter(r => list.includes(r.category_id));
  };

  return {
    rows,
    inCats,
    optionsOf: cat => rows.filter(r => r.category_id === cat),
    count: cats => inCats(cats).reduce((s, r) => s + r.qty, 0),
    sum: (cats, attrSpec) => inCats(cats).reduce((s, r) => {
      const v = num(pickAttr(r.opt.attrs, attrSpec));
      return s + (v == null ? 0 : v * r.qty);
    }, 0),
    attr: (cat, attrSpec) => {
      const r = rows.find(x => x.category_id === cat);
      return r ? pickAttr(r.opt.attrs, attrSpec) : undefined;
    },
    has: (cat) => rows.some(r => r.category_id === cat)
  };
}

/* resolve one side of a rule. `overrideOpt` lets us evaluate an 'attr' side
   against a specific option when several are selected in that category. */
function side(kind, cats, attrSpec, constVal, ctx, overrideOpt) {
  switch (kind) {
    case 'const': {
      const n = num(constVal);
      return n == null ? (constVal === '' ? undefined : constVal) : n;
    }
    case 'count':
      return ctx.count(cats);
    case 'sum':
      return ctx.sum(cats, attrSpec);
    case 'attr':
    default: {
      if (overrideOpt) return pickAttr(overrideOpt.attrs, attrSpec);
      const cat = asList(cats)[0];
      return ctx.attr(cat, attrSpec);
    }
  }
}

function compare(left, op, right) {
  const ln = num(left), rn = num(right);
  switch (op) {
    case 'eq':  return String(left).toLowerCase() === String(right).toLowerCase();
    case 'neq': return String(left).toLowerCase() !== String(right).toLowerCase();
    case 'lte': return ln != null && rn != null && ln <= rn;
    case 'gte': return ln != null && rn != null && ln >= rn;
    case 'lt':  return ln != null && rn != null && ln <  rn;
    case 'gt':  return ln != null && rn != null && ln >  rn;
    case 'in':      return asList(right).map(s => s.toLowerCase()).includes(String(left).toLowerCase());
    case 'not_in':  return !asList(right).map(s => s.toLowerCase()).includes(String(left).toLowerCase());
    case 'contains':return asList(left).map(s => s.toLowerCase()).includes(String(right).toLowerCase());
    default: return true;
  }
}

const fmt = v => Array.isArray(v) ? v.join(', ') : (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

function evaluate(build, options, rules) {
  const ctx = makeCtx(build, options);
  const out = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;

    /* developer escape hatch */
    if (rule.expr && rule.expr.trim()) {
      try {
        const fn = new Function('attr', 'count', 'sum', 'has', `"use strict"; return (${rule.expr});`);
        const ok = fn(ctx.attr, ctx.count, ctx.sum, ctx.has);
        if (ok === false) out.push({ rule_id: rule.id, name: rule.name, severity: rule.severity, message: rule.message });
        else if (typeof ok === 'string') out.push({ rule_id: rule.id, name: rule.name, severity: rule.severity, message: ok });
      } catch (e) {
        out.push({ rule_id: rule.id, name: rule.name, severity: 'warn', message: `Rule "${rule.name}" could not run: ${e.message}` });
      }
      continue;
    }

    const scale = rule.left_scale ?? 1, offset = rule.left_offset ?? 0;
    const right = side(rule.right_kind, rule.right_cats, rule.right_attr, rule.right_const, ctx);
    if (right === undefined) continue;                       // right side not chosen yet

    /* when the left side is an attribute and several options are selected in
       that category, every one of them has to satisfy the rule */
    const leftCat = asList(rule.left_cats)[0];
    const targets = (rule.left_kind === 'attr') ? ctx.optionsOf(leftCat) : [null];
    if (rule.left_kind === 'attr' && targets.length === 0) continue;

    for (const t of targets) {
      let left = side(rule.left_kind, rule.left_cats, rule.left_attr, null, ctx, t && t.opt);
      if (left === undefined) continue;
      if (typeof left === 'number' || num(left) != null) {
        if (rule.left_kind === 'sum' || scale !== 1 || offset !== 0) left = num(left) * scale + offset;
      }
      /* an empty aggregate means nothing relevant is selected — not a violation */
      if ((rule.left_kind === 'sum' || rule.left_kind === 'count') && ctx.count(rule.left_cats) === 0) continue;

      if (!compare(left, rule.op, right)) {
        out.push({
          rule_id: rule.id,
          name: rule.name,
          severity: rule.severity === 'warn' ? 'warn' : 'block',
          message: String(rule.message)
            .replace(/\{left\}/g, fmt(left))
            .replace(/\{right\}/g, fmt(right))
            .replace(/\{part\}/g, t && t.opt ? t.opt.name : '')
        });
        break;
      }
    }
  }
  return out;
}

/* Why can't the customer pick this option right now?
   We compare the violations before and after a hypothetical pick, so an
   unrelated pre-existing problem never gets blamed on the wrong part. */
function blockReason(build, options, rules, category, option) {
  const before = new Set(evaluate(build, options, rules).filter(v => v.severity === 'block').map(v => v.rule_id));
  const trial = category.multi
    ? [...build.filter(b => b.option_id !== option.id), { category_id: category.id, option_id: option.id, qty: 1 }]
    : [...build.filter(b => b.category_id !== category.id), { category_id: category.id, option_id: option.id, qty: 1 }];
  const after = evaluate(trial, options, rules).filter(v => v.severity === 'block' && !before.has(v.rule_id));
  return after.length ? after[0].message : null;
}

module.exports = { evaluate, blockReason, makeCtx, asList, pickAttr, num };
