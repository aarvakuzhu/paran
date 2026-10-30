// Photos waiting for details: taken with "Fill in later" or Quick capture, often where there's no signal.
// They stay private to this phone (nothing goes to the Sheet) until someone reviews one and saves it; then it's an
// ordinary item that syncs to Google for everyone. Per inventory: the list in localStorage, photos and previews in
// IndexedDB (a preview is ~30 KB; a storage unit can mean hundreds of them).
//
// Draft = { id, at, by, locationId, state, items, err, tries }
//   state: waiting (for AI) · reading · ready (AI suggestions in `items`) · none (AI found nothing: fill in by hand)
//          · error (AI declined or failed; tries counts attempts) · manual (AI is off: fill in by hand)
//   items: AI's suggestions for this photo, as analyzePhoto returns them (one photo can show several things)
import { blobs } from './idb.js';

const KEY = (inv) => `paran.drafts.${inv}`;
const AUTO_KEY = `paran.drafts.auto`;
const uid = () => Math.random().toString(16).slice(2, 12);

export function listDrafts(inv) {
  try { const a = JSON.parse(localStorage.getItem(KEY(inv)) || `[]`); return Array.isArray(a) ? a : []; } catch { return []; }
}
function store(inv, list) {
  try { localStorage.setItem(KEY(inv), JSON.stringify(list)); } catch { /* full: the photos are in IndexedDB anyway */ }
  window.dispatchEvent(new CustomEvent(`paran:drafts`, { detail: { inv } }));
}
export const draftCount = (inv) => listDrafts(inv).length;
export const getDraft = (inv, id) => listDrafts(inv).find((d) => d.id === id) || null;

/** Keep a photo for later. photo: Blob (≤1600px), thumb: data URL. Resolves the new draft. */
export async function addDraft(inv, { photo, thumb, locationId = ``, by = `` }) {
  const d = { id: uid(), at: new Date().toISOString(), by, locationId, state: `waiting`, items: [], err: ``, tries: 0 };
  await blobs.put(`draft:${d.id}`, photo);       // the photo first: a draft never points at a missing photo
  await blobs.put(`draft-t:${d.id}`, thumb);
  store(inv, [...listDrafts(inv), d]);
  return d;
}
export function updateDraft(inv, id, patch) {
  const list = listDrafts(inv); const d = list.find((x) => x.id === id); if (!d) return null;
  Object.assign(d, patch); store(inv, list); return d;
}
export async function removeDraft(inv, id) {
  store(inv, listDrafts(inv).filter((d) => d.id !== id));
  await blobs.del(`draft:${id}`).catch(() => {}); await blobs.del(`draft-t:${id}`).catch(() => {});
}
export const draftPhoto = (id) => blobs.get(`draft:${id}`);
export const draftThumb = (id) => blobs.get(`draft-t:${id}`);

/** Fill in with AI automatically when online (on unless turned off). */
export const autoFill = () => { try { return localStorage.getItem(AUTO_KEY) !== `0`; } catch { return true; } };
export function setAutoFill(on) { try { if (on) localStorage.removeItem(AUTO_KEY); else localStorage.setItem(AUTO_KEY, `0`); } catch { /* ignore */ } }

/** Next one for AI: waiting ones in the order taken; failed ones get two more tries. `only`: ids picked by the person. */
export function nextForAi(inv, only = null) {
  const list = listDrafts(inv).filter((d) => !only || only.has(d.id));
  return list.find((d) => d.state === `waiting`) || list.find((d) => d.state === `error` && (d.tries || 0) < 3) || null;
}
