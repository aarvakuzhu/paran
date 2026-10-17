// Usage stats, collected on this phone only. Nothing is sent until CONFIG.STATS_URL is set (and the app's privacy
// wording changed to say so). Counts only: no names, emails, item names, places, photos or text, ever.
//
// Kept in localStorage under paran.stats:
//   { id: random install id, days: { 'YYYY-MM-DD': Day }, sentUpTo: 'YYYY-MM-DD' | '' }
// Day = { v: app version, mode: demo|google, standalone, inventories, inGroup, aiOn,
//         c: { open, add, move, lend, return, edit, remove, search, event, plan, dayof, after, receipt, photoAi, scan },
//         ai: { kind: { uses, n, t, fields: { field: [unchanged, total, score] } } },
//         groups: { hashed group id: { members, editors, viewers, inventories, items, events } } }
// Days older than KEEP_DAYS are dropped.
import { CONFIG } from './config.js';

const KEY = `paran.stats`;
const OFF_KEY = `paran.stats.off`;
const KEEP_DAYS = 120;

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, `0`)}-${String(d.getDate()).padStart(2, `0`)}`; };
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, `0`)).join(``);

let paused = 0;
/** Run fn without counting anything (the demo's sample data, for one). */
export async function uncounted(fn) { paused++; try { return await fn(); } finally { paused--; } }

export const statsOn = () => { try { return localStorage.getItem(OFF_KEY) !== `1`; } catch { return false; } };
export function setStatsOn(on) {
  try {
    if (on) localStorage.removeItem(OFF_KEY);
    else { localStorage.setItem(OFF_KEY, `1`); localStorage.removeItem(KEY); } // off = nothing kept
  } catch { /* ignore */ }
}

function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || `null`); if (s?.id && s.days) return s; } catch { /* ignore */ }
  return { id: rid(), days: {}, sentUpTo: `` };
}
function save(s) {
  const cut = new Date(); cut.setDate(cut.getDate() - KEEP_DAYS);
  const min = cut.toISOString().slice(0, 10);
  for (const d of Object.keys(s.days)) if (d < min) delete s.days[d];
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage full: skip */ }
}
function day(s) {
  const d = today();
  s.days[d] ||= { c: {}, ai: {}, groups: {} };
  return s.days[d];
}

/** Count something that happened (add, move, lend, search, event, dayof, after…). */
export function count(what, n = 1) {
  if (paused || !statsOn()) return;
  const s = load(); const d = day(s);
  d.c[what] = (d.c[what] || 0) + n;
  save(s);
}

/** One use of AI, with the same tally that goes into History: { n, t, f: { field: [unchanged, changed, score] } }. */
export function countAi(kind, tally) {
  if (paused || !statsOn() || !tally) return;
  const s = load(); const d = day(s);
  const a = d.ai[kind] ||= { uses: 0, n: 0, t: 0, fields: {} };
  a.uses++; a.n += tally.n || 0; a.t += tally.t || 0;
  for (const [k, [kept, changed, score]] of Object.entries(tally.f || {})) {
    const x = a.fields[k] ||= [0, 0, 0];
    x[0] += kept; x[1] += kept + changed; x[2] = Math.round((x[2] + (score ?? kept)) * 1000) / 1000;
  }
  save(s);
}

/** A group id that's the same on every member's phone but isn't the Drive id (first 16 hex of its SHA-256). */
async function groupKey(id) {
  const h = await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(`paran:${id}`));
  return Array.from(new Uint8Array(h).slice(0, 8), (b) => b.toString(16).padStart(2, `0`)).join(``);
}

/**
 * Once a day (and again if anything changes): what this phone looks like. snap = { version, mode, inventories,
 * aiOn, groups: [{ id, members: [{ role }], inventories, items, events }] }.
 */
export async function snapshot(snap) {
  if (!statsOn()) return;
  const groups = {};
  for (const g of snap.groups || []) {
    const people = (g.members || []).filter((m) => m.role !== `removed`);
    groups[await groupKey(g.id)] = {
      members: people.length, viewers: people.filter((m) => m.role === `viewer`).length,
      editors: people.filter((m) => m.role !== `viewer`).length, inventories: g.inventories || 0, items: g.items || 0, events: g.events || 0,
    };
  }
  const s = load(); const d = day(s);
  const first = !d.v;
  Object.assign(d, {
    v: snap.version || d.v || ``, mode: snap.mode, inventories: snap.inventories || 0, inGroup: (snap.groups || []).length > 0,
    aiOn: Boolean(snap.aiOn), standalone: matchMedia?.(`(display-mode: standalone)`).matches || navigator.standalone === true, groups,
  });
  if (first) d.c.open = (d.c.open || 0) + 1;
  save(s);
}

/** What's kept, for the page that shows it. */
export function statsData() { return statsOn() ? load() : null; }

/**
 * Send the days not sent yet. Off until CONFIG.STATS_URL is set; today is only sent tomorrow (once it's complete).
 * The endpoint gets { id, days: { date: Day } }; an Apps Script web app can append one row per day.
 */
export async function sendStats() {
  const url = CONFIG.STATS_URL;
  if (!url || !statsOn() || !navigator.onLine) return false;
  const s = load(); const t = today();
  const days = Object.fromEntries(Object.entries(s.days).filter(([d]) => d < t && d > (s.sentUpTo || ``)));
  if (!Object.keys(days).length) return false;
  try {
    // text/plain keeps it a "simple" request (no preflight), which Apps Script web apps need
    const r = await fetch(url, { method: `POST`, headers: { 'Content-Type': `text/plain;charset=utf-8` }, body: JSON.stringify({ id: s.id, days }) });
    if (!r.ok) return false;
    s.sentUpTo = Object.keys(days).sort().pop(); save(s);
    return true;
  } catch { return false; }
}
