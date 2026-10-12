// Optional AI suggestions via Google Gemini, using the user's OWN API key.
// Off by default; requires explicit consent. The key stays on this device (never written to the Sheet).
// Photos go from the device straight to Google's Gemini API; Stash has no server in between.

const SETTINGS_KEY = `stash.ai`;
const USAGE_KEY = `stash.ai.usage`;
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

const LABEL_SCHEMA = {
  type: `OBJECT`,
  properties: { model: { type: `STRING` }, details: { type: `STRING` }, name: { type: `STRING` } },
  required: [`model`, `details`],
};
/** Close-up of a label or nameplate: read brand/model and key specs. Returns { model, details, name }. */
export async function readLabel(image) {
  const text = [
    `This is a close-up photo of a product label, nameplate, tag or packaging for a home inventory app.`,
    `Read what is printed. Do not guess anything you cannot read.`,
    `- model: brand and model or part number exactly as printed (e.g. "DeWalt DCD771"); empty if none is legible.`,
    `- details: up to 3 short useful specs as one line separated by " · " (e.g. "20V · 1/2 in chuck · 2 speeds"): size, capacity, voltage, wattage, battery type, filter size, expiry. Empty if none.`,
    `- name: a short plain name for the product if it is clear from the label (e.g. "Cordless drill"); otherwise empty.`,
  ].join(`\n`);
  const out = await callGemini(image, text, LABEL_SCHEMA);
  return { model: str(out.model, 80), details: str(out.details, 160), name: str(out.name, 60) };
}

/** Returns a cleaned list of suggested items. `image` is a JPEG Blob (~1024px). */
export async function analyzePhoto(image, context = {}) {
  const parsed = await callGemini(image, prompt(context), SCHEMA);
  return clean(parsed.items || []);
}

async function callGemini(image, promptText, schema) {
  const s = aiSettings();
  if (!s.enabled || !s.key) throw new AiError(`key`, `AI suggestions are not set up.`);
  if (!navigator.onLine) throw new AiError(`network`, `You’re offline. Fill in the details yourself, or try again later.`);

  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();

  const body = {
    contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: `image/jpeg`, data: await blobToBase64(image) } }] }],
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
  if (!cand) throw new AiError(`blocked`, `Gemini didn’t return a result for this photo.`);
  if (cand.finishReason && ![`STOP`, `MAX_TOKENS`].includes(cand.finishReason)) {
    throw new AiError(`blocked`, `Gemini declined to describe this photo.`);
  }
  const text = (cand.content?.parts || []).map((p) => p.text || ``).join(``);
  try { return JSON.parse(text); } catch { throw new AiError(`other`, `Gemini’s answer couldn’t be read. Try again.`); }
}

const str = (v, max) => String(v ?? ``).replace(/\s+/g, ` `).trim().slice(0, max);
function clean(items) {
  return items.slice(0, 15).map((it) => {
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
