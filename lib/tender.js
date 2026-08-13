'use strict';
const { q, get } = require('./db');
const { loadCategories, loadOptions, loadRules, optionsMap, priceBuild, marginMap, sellPrice } = require('./catalog');
const { evaluate } = require('./rules');

/* ============================================================================
   TENDER READING PIPELINE

   1  Split into pages and score them. A 300-page tender has maybe 15 pages you
      actually need: the technical specification, the BoQ, and the commercial
      conditions. Sending the whole document costs money and buys noise.
   2  Two focused extractions: commercial key points, then technical line items.
      Splitting them keeps each answer schema small, which is what keeps the
      model accurate.
   3  Every field carries the page it came from, so review is verification
      rather than re-reading.
   4  Match requirements against your live catalog, check stock, quote.

   The model never sees your cost or margin. It reads the tender and names
   parts from your catalog vocabulary; all pricing happens here in code.
   ========================================================================== */

const TECH_WORDS = [
  'technical specification', 'specifications', 'bill of quantity', 'bill of material', 'boq',
  'schedule of requirement', 'scope of supply', 'minimum specification', 'compliance',
  'processor', 'cpu', 'xeon', 'core i', 'motherboard', 'chipset', 'ram', 'memory', 'ddr',
  'dimm', 'hard disk', 'hdd', 'ssd', 'nvme', 'sata', 'raid', 'chassis', 'rack', 'rack unit',
  'form factor', 'power supply', 'psu', 'redundant', 'gpu', 'graphics', 'nic', 'ethernet',
  'gbe', 'operating system', 'server', 'workstation', 'desktop', 'node', 'quantity', 'qty', 'nos'
];
const COMM_WORDS = [
  'earnest money', 'emd', 'bid security', 'performance bank guarantee', 'pbg', 'security deposit',
  'last date', 'due date', 'submission', 'pre-bid', 'prebid', 'validity', 'delivery period',
  'delivery schedule', 'liquidated damages', 'penalty', 'payment terms', 'warranty', 'sla',
  'eligibility', 'qualification', 'turnover', 'oem', 'authorisation', 'authorization', 'maf',
  'make in india', 'local content', 'msme', 'gem', 'consignee', 'installation', 'commissioning',
  'training', 'evaluation', 'l1', 'qcbs', 'tender', 'nit', 'bid'
];

function splitPages(text) {
  const parts = String(text).split(/<<<PAGE (\d+)>>>/);
  const pages = [];
  if (parts.length === 1) return [{ page: 1, text }];
  for (let i = 1; i < parts.length; i += 2) {
    pages.push({ page: Number(parts[i]), text: parts[i + 1] || '' });
  }
  return pages;
}

function scorePages(pages, words) {
  return pages.map(p => {
    const low = p.text.toLowerCase();
    let score = 0;
    for (const w of words) {
      let idx = 0, hits = 0;
      while ((idx = low.indexOf(w, idx)) !== -1 && hits < 6) { hits++; idx += w.length; }
      score += hits * (w.length > 8 ? 2 : 1);
    }
    // tables of specs are dense in digits and units
    score += (low.match(/\b(gb|tb|ghz|watt|w\b|nos\.?|u\b)\b/g) || []).length * 0.4;
    return { ...p, score };
  });
}

function selectPages(pages, words, budgetChars) {
  const scored = scorePages(pages, words).filter(p => p.score > 2);
  scored.sort((a, b) => b.score - a.score);
  const keep = new Set();
  for (const p of scored) {
    if (keep.size && [...keep].reduce((s, n) => s + (pages[n - 1]?.text.length || 0), 0) > budgetChars) break;
    keep.add(p.page);
    keep.add(p.page + 1);           // specs routinely run onto the next page
  }
  const list = [...keep].filter(n => n >= 1).sort((a, b) => a - b);
  let out = '', used = [];
  for (const n of list) {
    const pg = pages.find(p => p.page === n);
    if (!pg) continue;
    if (out.length + pg.text.length > budgetChars) break;
    out += `\n<<<PAGE ${n}>>>\n${pg.text}`;
    used.push(n);
  }
  if (!out) { out = pages.slice(0, 30).map(p => `<<<PAGE ${p.page}>>>\n${p.text}`).join('\n').slice(0, budgetChars); used = [1]; }
  return { text: out, pages: used };
}

/* ---------------------------------------------------------------------------
   Catalog vocabulary handed to the model so it answers in your terms
   --------------------------------------------------------------------------- */
async function catalogVocabulary() {
  const cats = await loadCategories();
  const opts = await loadOptions();
  return cats.map(c => {
    const mine = opts.filter(o => o.category_id === c.id);
    const attrs = {};
    mine.forEach(o => Object.entries(o.attrs).forEach(([k, v]) => {
      attrs[k] = attrs[k] || new Set();
      if (attrs[k].size < 6) attrs[k].add(Array.isArray(v) ? v.join('/') : v);
    }));
    return {
      category_id: c.id,
      label: c.label,
      max_qty: c.max_qty,
      attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, [...v]]))
    };
  });
}

/* ---------------------------------------------------------------------------
   Anthropic call
   --------------------------------------------------------------------------- */
/* Which provider is in use. Set AI_PROVIDER=gemini or AI_PROVIDER=anthropic
   in .env. If unset, whichever key is present wins. */
function provider() {
  const p = String(process.env.AI_PROVIDER || '').toLowerCase();
  if (p === 'gemini' || p === 'anthropic') return p;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'anthropic';
}
function aiKey() {
  return provider() === 'gemini'
    ? process.env.GEMINI_API_KEY
    : process.env.ANTHROPIC_API_KEY;
}

async function callAnthropic(system, user, maxTokens) {
  const model = await get('anthropic_model', 'claude-sonnet-5');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
}

async function callGemini(system, user, maxTokens) {
  const model = await get('gemini_model', 'gemini-3.1-flash-lite');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0,
        responseMimeType: 'application/json'   // forces valid JSON back
      }
    })
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const cand = (data.candidates || [])[0];
  if (!cand) throw new Error('Gemini returned no candidates: ' + JSON.stringify(data).slice(0, 300));
  if (cand.finishReason === 'MAX_TOKENS') {
    throw new Error('Gemini hit the output token limit — the answer was cut off mid-JSON. Raise maxTokens or narrow the extraction.');
  }
  return (cand.content?.parts || []).map(p => p.text || '').join('\n');
}

async function askModel(system, user, maxTokens = 8000) {
  const who = provider();
  if (!aiKey()) {
    throw new Error(`${who === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} is not set on the server.`);
  }
  const call = (extra) => who === 'gemini'
    ? callGemini(system, user + (extra || ''), maxTokens)
    : callAnthropic(system, user + (extra || ''), maxTokens);

  let raw = await call('');
  try { return parseJson(raw); }
  catch {
    raw = await call('\n\nYour previous answer was not valid JSON. Return the JSON object only, no commentary, no code fences.');
    return parseJson(raw);
  }
}
function parseJson(raw) {
  let s = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a > 0 || b < s.length - 1) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

/* ---------------------------------------------------------------------------
   Extraction prompts
   --------------------------------------------------------------------------- */
async function keyPointFields() {
  return q.all('SELECT * FROM extraction_fields WHERE active=1 ORDER BY sort, id');
}

async function extractKeyPoints(text) {
  const fields = await keyPointFields();
  const schema = fields.map(f =>
    `  "${f.key}": { "value": ${f.type === 'list' ? '[string]' : f.type === 'number' ? 'number|null' : 'string|null'}, "page": number|null, "evidence": "short quote, under 15 words" }   // ${f.label}${f.hint ? ' — ' + f.hint : ''}`
  ).join('\n');

  const system = `You read Indian government and PSU tender documents for an IT hardware OEM. You extract facts exactly as written. You never guess: if a field is not stated in the supplied pages, its value is null and you say so. You always reply with a single JSON object and nothing else.`;

  const user = `Extract the key points from this tender extract. Reply with exactly this JSON shape:

{
${schema},
  "confidence": "high" | "medium" | "low",
  "notes": "anything a bid manager must not miss, in one or two sentences"
}

Rules:
- "page" is the number from the nearest <<<PAGE n>>> marker above the fact.
- "evidence" is a short verbatim fragment (under 15 words) proving the value.
- Amounts: return the number in rupees, digits only, no commas or symbols.
- Dates: ISO format YYYY-MM-DD where the date is unambiguous, otherwise the text as written.
- If a field is absent from these pages, use null. Do not infer it from typical practice.

TENDER EXTRACT:
${text}`;

  return await askModel(system, user, 6000);
}

async function extractLineItems(text) {
  const vocab = await catalogVocabulary();
  const system = `You read the technical specification and bill of quantity sections of tender documents for an IT hardware OEM, and translate them into structured requirements using the OEM's own catalog vocabulary. You never invent quantities or specifications. You reply with a single JSON object and nothing else.`;

  const user = `The OEM's catalog is organised into these categories and attributes. Use these exact category_id and attribute names in your answer:

${JSON.stringify(vocab, null, 1)}

Read the tender extract below and return:

{
  "items": [
    {
      "name": "as named in the tender, e.g. Rack Server Type-A",
      "quantity": number,                  // how many complete units the tender asks for
      "unit": "nos",
      "page": number|null,
      "requirements": [
        {
          "category_id": "one of the ids above",
          "text": "the requirement as written in the tender",
          "page": number|null,
          "qty": number|null,              // units of THIS part per system, if stated
          "constraints": [
            { "attr": "attribute name from the list", "op": ">=", "value": 32, "total": true }
          ]
        }
      ],
      "unmapped": ["any requirement you could not express with the categories above"]
    }
  ],
  "confidence": "high" | "medium" | "low",
  "notes": "string"
}

Rules for constraints:
- op is one of  >=  <=  =  !=  like  in
- "like" means the attribute text contains the value, e.g. attr "mem", op "like", value "DDR4".
- Set "total": true when the tender states a system total rather than a per-part figure — for example "64 GB RAM" is a total that may be met with several modules, while "16 GB per DIMM" is not.
- "Minimum", "or higher", "or better" become >=. A bare figure in a spec table is also >= unless the tender says exactly.
- Only use attribute names that appear in the catalog above. Anything you cannot express goes in "unmapped" as plain text — that is expected and useful, not a failure.
- If the tender lists several distinct system types, return one item per type with its own quantity.

TENDER EXTRACT:
${text}`;

  return await askModel(system, user, 12000);
}

/* ---------------------------------------------------------------------------
   Offline fallback: crude but honest, so the tool still runs without a key
   --------------------------------------------------------------------------- */
function heuristicKeyPoints(text) {
  const find = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const money = (re) => { const v = find(re); return v ? Number(v.replace(/[,\s]/g, '')) : null; };
  const wrap = (value, note) => ({ value, page: null, evidence: note || '', low_confidence: true });
  return {
    tender_id: wrap(find(/(?:tender|nit|bid)\s*(?:no|number|id)[.:\s]+([A-Za-z0-9\/\-_]{4,40})/i)),
    emd_amount: wrap(money(/(?:emd|earnest money)[^0-9]{0,40}(?:rs\.?|inr|₹)?\s*([\d,]{4,15})/i)),
    tender_value: wrap(money(/(?:estimated (?:cost|value)|tender value)[^0-9]{0,40}(?:rs\.?|inr|₹)?\s*([\d,]{4,15})/i)),
    delivery_period_days: wrap(Number(find(/delivery[^.]{0,60}?(\d{1,3})\s*(?:days|weeks)/i)) || null),
    warranty_years: wrap(Number(find(/(\d)\s*(?:year|yr)s?\s*(?:comprehensive\s*)?(?:on-?site\s*)?warranty/i)) || null),
    bid_due_date: wrap(find(/(?:last date|due date|submission)[^0-9]{0,40}(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i)),
    confidence: 'low',
    notes: 'Pattern matching only — no AI key configured on the server. Treat every field as unverified.'
  };
}

/* ---------------------------------------------------------------------------
   Matching requirements to your catalog
   --------------------------------------------------------------------------- */
const numOf = v => (typeof v === 'number' ? v : (v == null || v === '' || isNaN(Number(v)) ? null : Number(v)));

function satisfies(attrVal, op, want) {
  if (attrVal === undefined || attrVal === null) return false;
  const a = numOf(attrVal), w = numOf(want);
  const as = Array.isArray(attrVal) ? attrVal.join(' ') : String(attrVal);
  switch (op) {
    case '>=': return a != null && w != null && a >= w;
    case '<=': return a != null && w != null && a <= w;
    case '=':  return String(as).toLowerCase() === String(want).toLowerCase();
    case '!=': return String(as).toLowerCase() !== String(want).toLowerCase();
    case 'like': return as.toLowerCase().includes(String(want).toLowerCase());
    case 'in': return String(want).toLowerCase().split(/[,|]/).map(s => s.trim()).includes(as.toLowerCase());
    default: return true;
  }
}

/** Every part in a category that satisfies one requirement, with the quantity
    that requirement implies. Returned cheapest-first. */
function candidatesFor(req, opts) {
  const pool = opts.filter(o => o.category_id === req.category_id);
  if (!pool.length) return { list: [], reason: `No parts exist in "${req.category_id}".` };

  const hard = (req.constraints || []).filter(c => !c.total);
  const totals = (req.constraints || []).filter(c => c.total);
  const pass = pool.filter(o => hard.every(c => satisfies(o.attrs[c.attr], c.op, c.value)));

  if (!pass.length) return {
    list: [],
    reason: `Nothing in ${req.category_id} meets ${hard.map(c => `${c.attr} ${c.op} ${c.value}`).join(' and ')}.`
  };

  const list = pass.map(o => {
    let qty = req.qty || 1;
    for (const c of totals) {
      const per = numOf(o.attrs[c.attr]), want = numOf(c.value);
      if (per && want && (c.op === '>=' || c.op === '=')) qty = Math.max(qty, Math.ceil(want / per));
    }
    return { opt: o, qty, spend: o.price * qty };
  }).sort((a, b) => a.spend - b.spend);

  return { list, reason: null };
}

/* Two requirements can land on the same category ("32 GB RAM" and "DDR4 ECC").
   Merge them so the category is chosen once, against all of its constraints. */
function mergeRequirements(reqs) {
  const byCat = new Map();
  for (const r of reqs) {
    const cur = byCat.get(r.category_id);
    if (!cur) byCat.set(r.category_id, { ...r, _sources: [r] });
    else {
      cur.constraints = [...(cur.constraints || []), ...(r.constraints || [])];
      cur.qty = Math.max(cur.qty || 1, r.qty || 1);
      cur.text = cur.text + ' + ' + r.text;
      cur._sources.push(r);
    }
  }
  return [...byCat.values()];
}

/* Categories that appear in many rules are the hubs of the build — chassis and
   motherboard, typically. Deciding those first makes the search converge fast
   instead of thrashing on memory modules. */
function categoryOrder(cats, rules) {
  const refs = {};
  for (const r of rules) {
    for (const c of [...asListSafe(r.left_cats), ...asListSafe(r.right_cats)]) refs[c] = (refs[c] || 0) + 1;
  }
  return [...cats].sort((a, b) => (refs[b.id] || 0) - (refs[a.id] || 0) || a.sort - b.sort);
}
const asListSafe = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

/**
 * Choose one option per category so that every extracted requirement is met AND
 * no blocking compatibility rule is broken, at the lowest cost we can find.
 *
 * Requirements alone are not enough: a tender asking for "10 cores minimum"
 * and "128 GB DDR4 ECC" is satisfied on paper by a cheap desktop CPU and
 * unbuffered memory that will never boot on the same board. So this searches
 * combinations and validates each partial build against the same rule engine
 * the customer configurator uses.
 */
async function solveBuild(reqs, opts, rules, cats, budget = 40000) {
  const map = await optionsMap(opts);
  const byCat = new Map(reqs.map(r => [r.category_id, r]));
  const ordered = categoryOrder(cats, rules);

  const levels = [];
  for (const c of ordered) {
    const req = byCat.get(c.id);
    if (req) {
      const { list } = candidatesFor(req, opts);
      if (list.length) levels.push({ cat: c, list, required: true, fromTender: true });
    } else if (c.required) {
      levels.push({
        cat: c, required: true, fromTender: false,
        list: opts.filter(o => o.category_id === c.id).sort((a, b) => a.price - b.price).map(o => ({ opt: o, qty: 1, spend: o.price }))
      });
    }
  }

  let nodes = 0, best = null;
  const legal = (build) => !evaluate(build, map, rules).some(v => v.severity === 'block');

  (function dfs(i, build) {
    if (best || nodes > budget) return;
    if (i === levels.length) { best = [...build]; return; }
    for (const cand of levels[i].list) {
      if (best || nodes++ > budget) return;
      const next = [...build, { category_id: levels[i].cat.id, option_id: cand.opt.id, qty: cand.qty }];
      if (!legal(next)) continue;        // prune the whole subtree
      dfs(i + 1, next);
      if (best) return;
    }
  })(0, []);

  return {
    build: best,
    exhausted: nodes > budget,
    levels: levels.map(l => ({ category_id: l.cat.id, fromTender: l.fromTender, count: l.list.length }))
  };
}

async function buildQuoteForItem(item, opts, rules, cats) {
  const merged = mergeRequirements(item.requirements || []);

  /* record what each requirement could match, for the review screen */
  const reqs = merged.map(r => {
    const { list, reason } = candidatesFor(r, opts);
    return {
      ...r,
      status: list.length ? 'matched' : 'no_match',
      reason,
      candidates: list.slice(0, 6).map(c => ({ option_id: c.opt.id, name: c.opt.name, qty: c.qty }))
    };
  });

  const solvable = reqs.filter(r => r.status === 'matched');
  const solved = await solveBuild(solvable, opts, rules, cats);

  let build = solved.build;
  let unsolvable = false;
  if (!build) {
    /* No legal combination exists. Fall back to the cheapest compliant part per
       requirement so the estimate is still visible, and say plainly that the
       set does not go together — that conflict is itself the finding. */
    unsolvable = true;
    build = [];
    for (const r of reqs) {
      if (r.status !== 'matched') continue;
      const c = r.candidates[0];
      build.push({ category_id: r.category_id, option_id: c.option_id, qty: c.qty });
    }
  }

  /* mark what the solver chose against each requirement */
  for (const r of reqs) {
    const chosen = build.find(b => b.category_id === r.category_id);
    if (chosen) {
      r.option_id = chosen.option_id;
      r.option_name = (opts.find(o => o.id === chosen.option_id) || {}).name;
      r.qty_per_unit = chosen.qty;
    }
  }

  const tenderCats = new Set(reqs.map(r => r.category_id));
  const assumed = build
    .filter(b => !tenderCats.has(b.category_id))
    .map(b => ({
      category_id: b.category_id, option_id: b.option_id,
      name: (opts.find(o => o.id === b.option_id) || {}).name
    }));

  const violations = evaluate(build, await optionsMap(opts), rules);
  const units = Math.max(1, Number(item.quantity) || 1);
  const quote = await priceBuild(build, units);

  return {
    name: item.name,
    quantity: units,
    page: item.page ?? null,
    requirements: reqs,
    unmapped: item.unmapped || [],
    assumed,
    unsolvable,
    violations,
    build,
    quote,
    gaps: reqs.filter(r => r.status !== 'matched')
  };
}

function assessDelivery(items, meta) {
  const days = numOf(meta?.delivery_period_days?.value ?? meta?.delivery_period_days);
  const risks = [];
  for (const it of items) {
    for (const s of it.quote.shortfalls) {
      const line = `${it.name}: ${s.name} — need ${s.qty_total}, ${s.stock_qty} on hand, short by ${s.short_by}`;
      if (!s.lead_days) {
        risks.push({ level: 'medium', text: `${line}. No lead time on record — get one from purchase before committing.` });
      } else if (days && s.lead_days > days) {
        risks.push({ level: 'high', text: `${line}, ${s.lead_days} day lead time — longer than the ${days} day delivery period in the tender.` });
      } else {
        risks.push({ level: 'medium', text: `${line}, ${s.lead_days} day lead time.` });
      }
    }
  }
  return risks.sort((a, b) => (a.level === 'high' ? 0 : 1) - (b.level === 'high' ? 0 : 1));
}

async function analyse(text, { useAi = true } = {}) {
  const pages = splitPages(text);

  /* Page budgets. Gemini's context is large enough to take most of a tender
     whole, so we send far more of it and let the model do the judging rather
     than trusting a keyword score to decide what matters. Scoring still runs —
     it orders the pages — but the cut is much less aggressive. */
  const big = provider() === 'gemini';
  const tech = selectPages(pages, TECH_WORDS, big ? 600000 : 90000);
  const comm = selectPages(pages, COMM_WORDS, big ? 400000 : 70000);

  let meta, items, mode = 'ai';
  if (useAi && aiKey()) {
    const [m, i] = await Promise.all([
      extractKeyPoints(comm.text),
      extractLineItems(tech.text)
    ]);
    meta = m;
    items = Array.isArray(i.items) ? i.items : [];
    meta._items_confidence = i.confidence;
    meta._items_notes = i.notes;
  } else {
    mode = 'heuristic';
    meta = heuristicKeyPoints(text);
    items = [];
  }

  const [opts, rules, cats] = await Promise.all([
    loadOptions(), loadRules(), loadCategories()
  ]);
  /* Each line item is solved independently, so they run concurrently rather
     than one after another — a 12-item tender is one wait, not twelve. */
  const priced = await Promise.all(
    items.map(it => buildQuoteForItem(it, opts, rules, cats))
  );

  const grand = priced.reduce((s, p) => s + p.quote.subtotal, 0);
  const taxRate = Number(await get('tax_rate', '0.18'));

  return {
    mode,
    pages_read: { technical: tech.pages, commercial: comm.pages, total: pages.length },
    meta,
    items: priced,
    risks: assessDelivery(priced, meta),
    totals: {
      subtotal: grand,
      tax: Math.round(grand * taxRate),
      total: grand + Math.round(grand * taxRate),
      cost: priced.reduce((s, p) => s + p.quote.cost, 0)
    }
  };
}

module.exports = { analyse, splitPages, selectPages, catalogVocabulary, buildQuoteForItem, solveBuild, candidatesFor };
