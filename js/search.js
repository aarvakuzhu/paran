// Client-side search: matches name, purpose ("what it's for"), tags, category, notes and location,
// with prefix matching, light typo tolerance and a few everyday synonyms.
const SYNONYMS = {
  leak: [`plumbing`, `drip`, `faucet`, `pipe`],
  faucet: [`tap`, `sink`, `plumbing`],
  tap: [`faucet`],
  fix: [`repair`, `tool`],
  repair: [`fix`, `tool`],
  car: [`auto`, `vehicle`],
  christmas: [`xmas`, `holiday`],
  xmas: [`christmas`, `holiday`],
  battery: [`batteries`, `charger`, `power`],
  cable: [`cord`, `wire`, `charger`],
  cord: [`cable`, `extension`],
  hang: [`mount`, `hook`, `nail`],
  mount: [`hang`, `bracket`],
  medicine: [`meds`, `first aid`, `pills`],
  paper: [`document`, `documents`, `papers`],
  document: [`papers`, `certificate`, `paper`],
  kid: [`kids`, `children`, `child`],
  camping: [`tent`, `outdoor`],
  small: [`pocket`, `hand-held`, `tiny`],
  tiny: [`pocket`],
  big: [`large`, `furniture`, `carry-on`],
  large: [`furniture`, `carry-on`],
  model: [`notes`],
};

const norm = (s) => String(s || ``).toLowerCase().normalize(`NFKD`).replace(/[̀-ͯ]/g, ``).replace(/[’']/g, ``);
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
const stem = (w) => w.length > 4 ? w.replace(/(ies|es|s)$/, (m) => (m === `ies` ? `y` : ``)) : w;

function editDistanceAtMost1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function termScore(term, fieldWords) {
  let best = 0;
  for (const w of fieldWords) {
    if (w === term || stem(w) === stem(term)) return 1;
    if (w.startsWith(term) && term.length >= 2) best = Math.max(best, 0.8);
    else if (term.length >= 4 && editDistanceAtMost1(stem(term), stem(w))) best = Math.max(best, 0.6);
  }
  return best;
}

const FIELDS = [[`name`, 3], [`tags`, 2], [`purpose`, 2], [`category`, 1.5], [`location`, 1.2], [`notes`, 1], [`size`, 1], [`lentTo`, 1]];

/** Returns items sorted by relevance. Every query word (or a synonym) must match somewhere. */
export function search(items, query, pathText) {
  const terms = words(query);
  if (!terms.length) return [];
  const results = [];
  for (const item of items) {
    const fw = FIELDS.map(([f, w]) => [words(f === `location` ? pathText(item.locationId) : item[f]), w]);
    let total = 0, ok = true;
    for (const t of terms) {
      let best = 0;
      for (const [ws, weight] of fw) best = Math.max(best, termScore(t, ws) * weight);
      if (!best) for (const syn of SYNONYMS[t] || SYNONYMS[stem(t)] || []) {
        for (const [ws, weight] of fw) best = Math.max(best, termScore(syn, ws) * weight * 0.7);
      }
      if (!best) { ok = false; break; }
      total += best;
    }
    if (ok) results.push({ item, score: total });
  }
  return results.sort((a, b) => b.score - a.score).map((r) => r.item);
}

// ---------------------------------------------------------------- duplicate detection (local, no AI)
const STOP = new Set([`a`, `an`, `the`, `of`, `for`, `and`, `with`, `my`, `old`, `new`, `set`]);
const nameWords = (s) => [...new Set(words(s).filter((w) => !STOP.has(w)).map(stem))];
const sameWord = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && editDistanceAtMost1(a, b));

/** 0..1 similarity between two item names. 1 = same words (ignoring order, plurals, small typos). */
export function nameSimilarity(a, b) {
  const A = nameWords(a), B = nameWords(b);
  if (!A.length || !B.length) return 0;
  if (A.join(``) === B.join(``)) return 1; // "Screwdriver" vs "Screw driver"
  const hits = A.filter((x) => B.some((y) => sameWord(x, y))).length;
  const union = A.length + B.length - hits;
  const jaccard = hits / union;
  // "Stud finder" vs "Zircon stud finder": all words of the shorter name appear in the longer one
  const contained = hits === Math.min(A.length, B.length) && Math.min(A.length, B.length) >= 2;
  return contained ? Math.max(jaccard, 0.8) : jaccard;
}

/**
 * Existing items that look like the same thing as `name`.
 * Returns [{ item, score, samePlace }] best first (same place ranked above elsewhere), max 3.
 */
export function findDuplicates(items, name, { locationId = ``, excludeId = `` } = {}) {
  if (!String(name || ``).trim()) return [];
  return items
    .filter((i) => i.id !== excludeId)
    .map((item) => ({ item, score: nameSimilarity(name, item.name), samePlace: Boolean(locationId) && item.locationId === locationId }))
    .filter((d) => d.score >= (d.samePlace ? 0.5 : 0.67))
    .sort((a, b) => (b.samePlace - a.samePlace) || (b.score - a.score))
    .slice(0, 3);
}
