// Other inventories, read-only: this phone's copy of each (from when it was last opened or fetched), refreshed in the background.
// Used by search across inventories and by group events.
import { fetchInventory } from './store.js';
import { blobs } from './idb.js';

export const XFRESH_MS = 10 * 60_000;
/** Removing an item stores when it was removed in `deleted`; older rows may hold TRUE. Empty or FALSE = still there. */
export const isRemoved = (v) => v === true || (typeof v === `string` && v !== `` && v.toUpperCase() !== `FALSE`);
export const xmem = {}; // sheetId -> { items, locations, thumbs, at, loading, failed }

export function xlocal(id) {
  if (xmem[id]?.items) return xmem[id];
  try {
    const c = JSON.parse(localStorage.getItem(`paran.cache.${id}`) || `null`);
    if (c) {
      xmem[id] = { ...(xmem[id] || {}), items: (c.items || []).filter((i) => !isRemoved(i.deleted)), locations: c.locations || [], members: c.members || [], tasks: c.tasks || [], at: Number(localStorage.getItem(`paran.xat.${id}`) || 0) };
      blobs.get(`thumbs:${id}`).then((t) => { if (t) xmem[id].thumbs = t; }).catch(() => {});
      return xmem[id];
    }
  } catch { /* ignore */ }
  return null;
}

export async function xfetch(id) {
  const m = (xmem[id] ||= {});
  if (m.loading) return m.loading;
  m.loading = (async () => {
    try {
      const d = await fetchInventory(id);
      const live = d.items.filter((i) => !isRemoved(i.deleted));
      Object.assign(m, { items: live, locations: d.locations, members: d.members || m.members || [], tasks: d.tasks || m.tasks || [], at: Date.now(), failed: false });
      // keep it on the phone; never touch changes still waiting to be saved there
      let old = null; try { old = JSON.parse(localStorage.getItem(`paran.cache.${id}`) || `null`); } catch { /* ignore */ }
      if (!old?.outbox?.length) {
        try {
          localStorage.setItem(`paran.cache.${id}`, JSON.stringify({ ...(old || {}), items: d.items, locations: d.locations, members: d.members || old?.members || [], tasks: d.tasks || old?.tasks || [], log: old?.log || [], outbox: [] }));
          localStorage.setItem(`paran.xat.${id}`, String(m.at));
        } catch { /* storage full: still searchable this session */ }
      }
    } catch { m.failed = true; }
    finally { m.loading = null; }
  })();
  return m.loading;
}

export function xpath(locations, locId) {
  const byId = new Map(locations.map((l) => [l.id, l])); const parts = [];
  let l = byId.get(locId); let guard = 0;
  while (l && guard++ < 20) { parts.unshift(l.name); l = byId.get(l.parentId); }
  return parts;
}
