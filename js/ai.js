// Optional AI suggestions via Google Gemini, using the user's OWN API key.
// Off by default; requires explicit consent. The key stays on this device (never written to the Sheet).
// Photos go from the device straight to Google's Gemini API; Paran has no server in between.

const SETTINGS_KEY = `paran.ai`;
const USAGE_KEY = `paran.ai.usage`;
export const AI_MODELS = [`gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`]; // first available wins
const API = `https://generativelanguage.googleapis.com/v1beta`;
const MIN_GAP_MS = 4100; // stay under 15 requests/minute
let lastCallAt = 0;

export class AiError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; } // kind: key | daily | busy | network | blocked | other
}

// ---------------- settings
export function aiSettings() {
  try { return { enabled: false, key: ``, auto: true, model: AI_MODELS[0], ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || `{}`) }; }
  catch { return { enabled: false, key: ``, auto: true, model: AI_MODELS[0] }; }
}
export function saveAiSettings(patch) {
  const s = { ...aiSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  return s;
}
export function disableAi() { localStorage.removeItem(SETTINGS_KEY); }
export const aiReady = () => { const s = aiSettings(); return s.enabled && Boolean(s.key); };

// ---------------- usage counter (this device only; resets at midnight Pacific, like Google's daily quota)
const pacificDay = () => new Intl.DateTimeFormat(`en-CA`, { timeZone: `America/Los_Angeles` }).format(new Date());
export function aiUsageToday() {
  try { const u = JSON.parse(localStorage.getItem(USAGE_KEY) || `{}`); return u.day === pacificDay() ? u.count : 0; }
  catch { return 0; }
}
function bumpUsage() {
  localStorage.setItem(USAGE_KEY, JSON.stringify({ day: pacificDay(), count: aiUsageToday() + 1 }));
}

// ---------------- key check (does not use generation quota)
export async function verifyKey(key) {
  for (const model of AI_MODELS) {
    let res;
    try { res = await fetch(`${API}/models/${model}`, { headers: { 'x-goog-api-key': key } }); }
    catch { throw new AiError(`network`, `Couldn’t reach Google. Check your connection.`); }
    if (res.ok) return model;
    if (res.status === 404) continue; // model not offered to this key; try the next
    throw await toError(res);
  }
  throw new AiError(`other`, `None of the supported Gemini models are available to this key.`);
}

// ---------------- analysis
const SCHEMA = {
  type: `OBJECT`,
  properties: {
    items: {
      type: `ARRAY`,
      items: {
        type: `OBJECT`,
        properties: {
          name: { type: `STRING` },
          purpose: { type: `STRING` },
          category: { type: `STRING` },
          tags: { type: `ARRAY`, items: { type: `STRING` } },
          qty: { type: `INTEGER` },
          notes: { type: `STRING` },
          size: { type: `STRING` },
          box_2d: { type: `ARRAY`, items: { type: `INTEGER` } },
        },
        required: [`name`, `purpose`, `category`, `tags`, `qty`],
      },
    },
  },
  required: [`items`],
};

function prompt({ categories = [], location = `` }) {
  return [
    `You help catalog belongings for a home inventory app. People use it later to find things and to remember what they are for.`,
    `Identify the distinct physical items in this photo that someone would want to find later.`,
    `Ignore walls, floors, shelves, furniture and the container holding the items, unless the container is the only thing shown.`,
    `If one main item fills most of the photo, return only that item. Return at most 15 items, most useful first.`,
    `For each item:`,
    `- name: short and specific, 2 to 6 words. Include brand or model only if clearly readable.`,
    `- purpose: one short sentence on what a person would use it for (for example "Seal pipe threads when fixing leaks"). No marketing language.`,
    `- category: one short word or two.${categories.length ? ` Prefer one of these existing categories if it fits: ${categories.slice(0, 40).join(`, `)}.` : ``}`,
    `- tags: 3 to 6 lowercase search words, including common synonyms someone might type.`,
    `- qty: how many identical units are visible (1 if unsure).`,
    `- notes: visible model numbers, sizes, capacities or expiry dates; otherwise empty.`,
    `- size: how big the item is, one of: ${SIZES.join(`, `)}. Judge from surrounding objects; empty if you can't tell.`,
    `- box_2d: bounding box as [ymin, xmin, ymax, xmax] normalized to 0-1000.`,
    location ? `Context: the user says these items are stored in "${location}".` : ``,
    `Do not guess at things you cannot see. If you cannot identify anything, return an empty items list.`,
  ].filter(Boolean).join(`\n`);
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ``;
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const SIZES = [`Pocket`, `Hand-held`, `Shoebox`, `Carry-on`, `Large`, `Furniture`];

const DESCRIBE_SCHEMA = {
  type: `OBJECT`,
  properties: {
    name: { type: `STRING` }, purpose: { type: `STRING` }, category: { type: `STRING` },
    tags: { type: `ARRAY`, items: { type: `STRING` } }, size: { type: `STRING` },
    model: { type: `STRING` }, details: { type: `STRING` },
  },
  required: [`name`, `purpose`, `category`, `tags`, `size`, `model`, `details`],
};

/**
 * Several photos of ONE item (all sides, labels, next to other things). Combines what's visible across them.
 * `current` = details already known, so the answer builds on them instead of starting over.
 */
export async function describeItem(images, current = {}, { categories = [] } = {}) {
  const known = Object.entries({ name: current.name, purpose: current.purpose, category: current.category, size: current.size, notes: current.notes })
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(`; `);
  const text = [
    `These ${images.length} photo${images.length > 1 ? `s all show the same single item` : ` shows one item`} for a home inventory app: different sides, close-ups of labels, or the item next to other things.`,
    `Combine what you can see across all photos. Do not guess anything you cannot see.`,
    known ? `Details already recorded (keep their wording when they are right): ${known}.` : ``,
    `- name: short and specific, 2 to 6 words; include brand or model only if legible.`,
    `- purpose: one short sentence on what a person would use it for.`,
    `- category: one or two words.${categories.length ? ` Prefer one of: ${categories.slice(0, 40).join(`, `)}.` : ``}`,
    `- tags: 3 to 6 lowercase search words including common synonyms.`,
    `- size: one of ${SIZES.join(`, `)}, judged from hands, furniture, rulers or other familiar objects in any photo; empty if you can't tell.`,
    `- model: brand and model or part number exactly as printed on any label; empty if none is legible.`,
    `- details: up to 3 short specs as one line separated by " · " (capacity, voltage, dimensions, filter size, expiry); empty if none visible.`,
  ].filter(Boolean).join(`\n`);
  const o = await callGemini(images, text, DESCRIBE_SCHEMA);
  return {
    name: str(o.name, 80), purpose: str(o.purpose, 200), category: str(o.category, 40),
    tags: (Array.isArray(o.tags) ? o.tags : []).map((t) => str(t, 30).toLowerCase()).filter(Boolean).slice(0, 8).join(`, `),
    size: SIZES.find((z) => z.toLowerCase() === String(o.size || ``).trim().toLowerCase()) || ``,
    model: str(o.model, 80), details: str(o.details, 160),
  };
}

/** Returns a cleaned list of suggested items. `image` is a JPEG Blob (~1024px). */
export async function analyzePhoto(image, context = {}) {
  const parsed = await callGemini([image], prompt(context), SCHEMA);
  return clean(parsed.items || []);
}

const SCAN_SCHEMA = {
  type: `OBJECT`,
  properties: {
    items: {
      type: `ARRAY`,
      items: {
        type: `OBJECT`,
        properties: {
          name: { type: `STRING` }, purpose: { type: `STRING` }, category: { type: `STRING` },
          tags: { type: `ARRAY`, items: { type: `STRING` } }, qty: { type: `INTEGER` }, notes: { type: `STRING` },
          size: { type: `STRING` }, photo: { type: `INTEGER` },
          box_2d: { type: `ARRAY`, items: { type: `INTEGER` } },
        },
        required: [`name`, `purpose`, `category`, `tags`, `qty`, `photo`],
      },
    },
  },
  required: [`items`],
};

/**
 * Several overlapping photos taken while panning across a shelf or room. Returns one list of
 * physical items (each listed once) with the photo that shows it best: item.photo is a 0-based index.
 */
export async function scanPhotos(images, { categories = [], location = `` } = {}) {
  const n = images.length;
  const text = [
    `You help catalog belongings for a home inventory app. People use it later to find things and to remember what they are for.`,
    `These ${n} photos were taken one after another while panning a camera across ${location ? `"${location}"` : `a shelf, closet or room`}. Neighbouring photos overlap, so the same physical item often appears in more than one photo.`,
    `List every distinct physical item someone would want to find later, each physical item ONCE even if it appears in several photos.`,
    `Two similar items in the same spot of overlapping photos are the same item; identical items side by side are one entry with qty.`,
    `Ignore walls, floors, shelving, furniture, fixtures and the photographer. Include boxes or bins only as items themselves when their contents are not visible.`,
    `Return at most 40 items, most useful first.`,
    `For each item:`,
    `- photo: the number (1 to ${n}) of the photo where it is most clearly and completely visible.`,
    `- box_2d: its bounding box in THAT photo as [ymin, xmin, ymax, xmax] normalized to 0-1000.`,
    `- name: short and specific, 2 to 6 words. Include brand or model only if clearly readable.`,
    `- purpose: one short sentence on what a person would use it for. No marketing language.`,
    `- category: one short word or two.${categories.length ? ` Prefer one of these existing categories if it fits: ${categories.slice(0, 40).join(`, `)}.` : ``}`,
    `- tags: 3 to 6 lowercase search words, including common synonyms someone might type.`,
    `- qty: how many identical units are visible (1 if unsure).`,
    `- notes: visible model numbers, sizes or capacities; otherwise empty.`,
    `- size: one of: ${SIZES.join(`, `)}, judged from surrounding objects; empty if you can't tell.`,
    `Do not guess at things you cannot see. If you cannot identify anything, return an empty items list.`,
  ].join(`\n`);
  const parsed = await callGemini(images, text, SCAN_SCHEMA);
  const raw = parsed.items || [];
  return clean(raw, 40).map((it, i) => ({ ...it, photo: Math.max(0, Math.min(n - 1, (parseInt(it._photo, 10) || 1) - 1)) }));
}

// ---------------- how often suggestions are kept (for the accuracy card; nothing leaves the inventory's History)
const norm = (v) => String(v ?? ``).trim().toLowerCase().replace(/\s+/g, ` `);
/**
 * rows: [{ taken, sug: { field: suggested }, fin: { field: saved } }]. Returns { n: offered, t: taken,
 * f: { field: [kept, changed] } }, counting only fields the AI actually suggested, on rows the person kept.
 */
export function aiTally(rows, fields) {
  const f = {}; let t = 0;
  for (const r of rows) {
    if (!r.taken) continue; t++;
    for (const k of fields) {
      const s = r.sug?.[k]; if (s === undefined || s === null || s === ``) continue;
      f[k] ||= [0, 0]; f[k][norm(s) === norm(r.fin?.[k]) ? 0 : 1]++;
    }
  }
  return { n: rows.length, t, f };
}

// ---------------- event from words
const PLAN_SCHEMA = {
  type: `OBJECT`,
  properties: {
    name: { type: `STRING` },
    date: { type: `STRING` },
    notes: { type: `STRING` },
    lines: {
      type: `ARRAY`,
      items: {
        type: `OBJECT`,
        properties: {
          section: { type: `STRING` }, name: { type: `STRING` }, qty: { type: `INTEGER` }, guessed: { type: `BOOLEAN` },
          note: { type: `STRING` }, matches: { type: `ARRAY`, items: { type: `STRING` } },
        },
        required: [`name`, `qty`],
      },
    },
  },
  required: [`lines`],
};

/**
 * Words → an event's checklist. `inventory` is [{ name, qty }] (names only, no photos), so the model can point each
 * line at things the group already has. Returns { name, date, notes, lines: [{ section, name, qty, guessed, note, matches }] }.
 */
export async function planEvent(text, { inventory = [], sections = [], eventName = ``, today = `` } = {}) {
  const names = inventory.slice(0, 600).map((i) => `- ${i.name}${Number(i.qty) > 1 ? ` (×${i.qty})` : ``}`).join(`\n`);
  const promptText = [
    `You help a volunteer group or a family get ready for an event: what physical things to gather, and how many.`,
    `Below is what the organizer wrote. It may be a description ("graduation for 200 people in the gym"), a pasted list, a WhatsApp message or notes, in any format or language. Today is ${today || `unknown`}.`,
    `Make the checklist of PHYSICAL things to gather. Follow the text: every thing it mentions becomes a line. If it only describes the event, add what such an event typically needs, but keep it practical and to at most 40 lines. Never include tasks, people or money.`,
    `For each line:`,
    `- section: a short group like Stage, Decor, AV, Seating, Food, Registration, Kitchen. ${sections.length ? `Reuse these existing sections where they fit: ${sections.join(`, `)}.` : ``} Use the text's own headings if it has them.`,
    `- name: short and plain, 1 to 5 words, in the organizer's language.`,
    `- qty: the number written in the text. If none is written, a sensible estimate from the headcount or context, and set guessed to true.`,
    `- note: anything specific the text says about it (size, colour, who has it); otherwise empty.`,
    `- matches: up to 3 names copied EXACTLY, character for character, from the inventory list below that would serve this line (a "table cover" line can match "Tablecloth"). Best first. Empty if nothing fits. Never invent names.`,
    `Also: name = the event's name if the text gives or clearly implies one${eventName ? ` (it is already called "${eventName}")` : ``}; date = YYYY-MM-DD only if a date is written; notes = place, time or headcount if written.`,
    ``, `ORGANIZER'S TEXT:`, text.slice(0, 8000),
    ``, `INVENTORY (what the group already has):`, names || `(nothing yet)`,
  ].join(`\n`);
  const r = await callGemini([], promptText, PLAN_SCHEMA);
  const known = new Map(inventory.map((i) => [String(i.name).trim().toLowerCase(), i.name]));
  const lines = (Array.isArray(r.lines) ? r.lines : []).slice(0, 60).map((l) => ({
    section: str(l.section, 40), name: str(l.name, 80), qty: Math.max(1, Math.min(9999, parseInt(l.qty, 10) || 1)), guessed: Boolean(l.guessed),
    note: str(l.note, 200),
    matches: [...new Set((Array.isArray(l.matches) ? l.matches : []).map((m) => known.get(String(m).trim().toLowerCase())).filter(Boolean))].slice(0, 3),
  })).filter((l) => l.name);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || ``).trim()) ? String(r.date).trim() : ``;
  return { name: str(r.name, 80), date, notes: str(r.notes, 200), lines };
}

// ---------------- receipts
const RECEIPT_SCHEMA = {
  type: `OBJECT`,
  properties: {
    store: { type: `STRING` }, date: { type: `STRING` }, currency: { type: `STRING` }, total: { type: `NUMBER` }, returnBy: { type: `STRING` },
    subtotal: { type: `NUMBER` }, tax: { type: `NUMBER` }, other: { type: `NUMBER` },
    items: {
      type: `ARRAY`,
      items: {
        type: `OBJECT`,
        properties: {
          name: { type: `STRING` }, brand: { type: `STRING` }, model: { type: `STRING` }, qty: { type: `INTEGER` },
          price: { type: `NUMBER` }, category: { type: `STRING` }, purpose: { type: `STRING` }, tags: { type: `ARRAY`, items: { type: `STRING` } },
          warrantyMonths: { type: `INTEGER` }, consumable: { type: `BOOLEAN` }, match: { type: `STRING` }, line: { type: `STRING` },
        },
        required: [`name`],
      },
    },
  },
  required: [`items`],
};

/**
 * A photo of a receipt → what was bought. `inventory`: names already in this inventory; `lines`: [{ id, name, event }]
 * still needed for events. Payment and personal details are not asked for and not kept.
 */
export async function readReceipt(image, { inventory = [], lines = [], categories = [] } = {}) {
  const promptText = [
    `This is a photo of a shopping receipt (or an order confirmation). Read it for a home or community inventory app.`,
    `List each product bought ONCE (combine repeated lines into qty). Skip tax, totals, fees, deposits, bag charges, coupons and loyalty lines; if a discount clearly belongs to a product, take it off that product's price.`,
    `For each product:`,
    `- name: a clear everyday name, expanding receipt abbreviations ("KS PPR TWL 12PK" → "Paper towels, 12 pack"). 2 to 6 words.`,
    `- brand and model: only if printed; otherwise empty.`,
    `- qty: units bought (1 if unsure). price: the total paid for that line, as a number in the receipt's currency.`,
    `- category: one or two words.${categories.length ? ` Prefer one of: ${categories.slice(0, 40).join(`, `)}.` : ``} purpose: one short sentence on what it's used for. tags: 3 to 5 lowercase search words.`,
    `- warrantyMonths: only if the receipt prints a warranty or protection plan for it; otherwise 0.`,
    `- consumable: true for food, drinks, cleaning supplies and other things used up; false for things kept.`,
    `- match: if the same kind of thing is already in the INVENTORY list below, its name copied EXACTLY; otherwise empty.`,
    `- line: if it supplies one of the NEEDED lines below, that line's id exactly; otherwise empty.`,
    `Also: store name; date as YYYY-MM-DD; currency code (USD, INR…); total paid as a number; returnBy as YYYY-MM-DD only if a return-by date is printed.`,
    `Copy these exactly as printed (0 if not printed): subtotal; tax (all taxes added up); other (tips, fees, deposits, delivery, bag charges, added up; discounts not taken off a product count as negative).`,
    `Read every product line, even if the photo is long; never drop one to keep the answer short.`,
    `Do NOT return card numbers, names, addresses, phone numbers, membership or loyalty numbers. If the photo is not a receipt, return an empty items list.`,
    ``, `INVENTORY:`, inventory.slice(0, 400).map((i) => `- ${i.name}`).join(`\n`) || `(empty)`,
    ``, `NEEDED (id: name, event):`, lines.slice(0, 80).map((l) => `- ${l.id}: ${l.name} (${l.event})`).join(`\n`) || `(none)`,
  ].join(`\n`);
  const r = await callGemini([image], promptText, RECEIPT_SCHEMA);
  const known = new Map(inventory.map((i) => [String(i.name).trim().toLowerCase(), i.name]));
  const lineIds = new Set(lines.map((l) => l.id));
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || ``).trim()) ? String(v).trim() : ``);
  const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };
  const items = (Array.isArray(r.items) ? r.items : []).slice(0, 60).map((it) => ({
    name: str(it.name, 80), brand: str(it.brand, 40), model: str(it.model, 60),
    qty: Math.max(1, Math.min(999, parseInt(it.qty, 10) || 1)), price: money(it.price),
    category: str(it.category, 40), purpose: str(it.purpose, 200),
    tags: (Array.isArray(it.tags) ? it.tags : []).map((t) => str(t, 30).toLowerCase()).filter(Boolean).slice(0, 6).join(`, `),
    warrantyMonths: Math.max(0, Math.min(120, parseInt(it.warrantyMonths, 10) || 0)), consumable: Boolean(it.consumable),
    match: known.get(String(it.match || ``).trim().toLowerCase()) || ``, line: lineIds.has(String(it.line || ``).trim()) ? String(it.line).trim() : ``,
  })).filter((it) => it.name);
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
  return { store: str(r.store, 60), date: iso(r.date), currency: str(r.currency, 8).toUpperCase(), total: money(r.total), returnBy: iso(r.returnBy),
    subtotal: money(r.subtotal) || null, tax: num(r.tax), other: num(r.other), items };
}

async function callGemini(images, promptText, schema) {
  const s = aiSettings();
  if (!s.enabled || !s.key) throw new AiError(`key`, `AI suggestions are not set up.`);
  if (!navigator.onLine) throw new AiError(`network`, `You’re offline. Fill in the details yourself, or try again later.`);

  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();

  const body = {
    contents: [{ parts: [{ text: promptText }, ...await Promise.all(images.map(async (img) => ({ inline_data: { mime_type: `image/jpeg`, data: await blobToBase64(img) } })))] }],
    generationConfig: { response_mime_type: `application/json`, response_schema: schema, temperature: 0.2 },
  };

  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(`${API}/models/${s.model}:generateContent`, {
        method: `POST`,
        headers: { 'x-goog-api-key': s.key, 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      });
    } catch { throw new AiError(`network`, `Couldn’t reach Google. Check your connection.`); }
    if (res.status === 429 && attempt === 0) {
      const err = await toError(res.clone());
      if (err.kind === `busy`) { await sleep(err.retryMs || 15000); lastCallAt = Date.now(); continue; }
      throw err;
    }
    break;
  }
  if (!res.ok) throw await toError(res);
  bumpUsage();

  const data = await res.json();
  const cand = data.candidates?.[0];
  if (!cand) throw new AiError(`blocked`, `Gemini didn’t return a result${images.length ? ` for this photo` : ``}.`);
  if (cand.finishReason && ![`STOP`, `MAX_TOKENS`].includes(cand.finishReason)) {
    throw new AiError(`blocked`, images.length ? `Gemini declined to read this photo.` : `Gemini declined this request.`);
  }
  const text = (cand.content?.parts || []).map((p) => p.text || ``).join(``);
  try { return JSON.parse(text); } catch { throw new AiError(`other`, `Gemini’s answer couldn’t be read. Try again.`); }
}

const str = (v, max) => String(v ?? ``).replace(/\s+/g, ` `).trim().slice(0, max);
function clean(items, max = 15) {
  return items.slice(0, max).map((it) => {
    const box = Array.isArray(it.box_2d) && it.box_2d.length === 4 && it.box_2d.every((n) => Number.isFinite(n))
      ? it.box_2d.map((n) => Math.max(0, Math.min(1000, n))) : null;
    return {
      name: str(it.name, 80),
      purpose: str(it.purpose, 200),
      category: str(it.category, 40),
      tags: (Array.isArray(it.tags) ? it.tags : []).map((t) => str(t, 30).toLowerCase()).filter(Boolean).slice(0, 8).join(`, `),
      qty: Math.max(1, Math.min(999, parseInt(it.qty, 10) || 1)),
      notes: str(it.notes, 200),
      size: SIZES.find((z) => z.toLowerCase() === String(it.size || ``).trim().toLowerCase()) || ``,
      box: box && box[2] > box[0] && box[3] > box[1] ? box : null,
      _photo: it.photo,
    };
  }).filter((it) => it.name);
}

async function toError(res) {
  let j = {};
  try { j = await res.json(); } catch { /* ignore */ }
  const msg = j.error?.message || `${res.status}`;
  const details = JSON.stringify(j.error?.details || []);
  if (res.status === 400 && /api key|API_KEY/i.test(msg + details)) return new AiError(`key`, `Google says this API key isn’t valid. Check it in More → AI suggestions.`);
  if (res.status === 401 || res.status === 403) return new AiError(`key`, `This API key isn’t allowed to use Gemini. Create a key at aistudio.google.com and try again.`);
  if (res.status === 429) {
    if (/PerDay|per day|daily/i.test(msg + details)) {
      return new AiError(`daily`, `You’ve used today’s free AI allowance. It resets at 3 AM Eastern (midnight Pacific). You can still add items yourself.`);
    }
    const m = /"retryDelay":"(\d+)s"/.exec(details);
    const e = new AiError(`busy`, `Too many AI requests in a minute. Wait a moment and try again.`);
    e.retryMs = m ? Number(m[1]) * 1000 + 500 : 15000;
    return e;
  }
  if (res.status >= 500) return new AiError(`other`, `Gemini is having trouble right now. Try again shortly.`);
  return new AiError(`other`, `Gemini error: ${msg}`);
}
