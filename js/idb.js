// Tiny IndexedDB key/value store for photo blobs (pending uploads and demo mode).
const DB_NAME = `paran`;
const OLD_DB = `stash`; // the Stash pilot at /stash/ on the same site; copied once, then left alone
const STORE = `blobs`;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      let fresh = false;
      req.onupgradeneeded = () => { fresh = true; req.result.createObjectStore(STORE); };
      req.onsuccess = () => (fresh ? copyFromOld(req.result).catch(() => {}) : Promise.resolve()).then(() => resolve(req.result));
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/** First run of Paran on a phone that had the Stash pilot: bring over unsent photos and cached ones. */
function copyFromOld(db) {
  return new Promise((resolve) => {
    if (!indexedDB.databases) return resolve(); // can't check cheaply; skip
    indexedDB.databases().then((list) => {
      if (!list.some((d) => d.name === OLD_DB)) return resolve();
      const r = indexedDB.open(OLD_DB);
      r.onupgradeneeded = () => { r.transaction.abort(); resolve(); }; // it didn't exist after all
      r.onerror = () => resolve();
      r.onsuccess = () => {
        const old = r.result;
        if (!old.objectStoreNames.contains(STORE)) { old.close(); return resolve(); }
        const src = old.transaction(STORE, `readonly`).objectStore(STORE);
        const keysReq = src.getAllKeys(); const valsReq = src.getAll();
        valsReq.onsuccess = () => {
          const t = db.transaction(STORE, `readwrite`); const dst = t.objectStore(STORE);
          keysReq.result.forEach((k, i) => dst.put(valsReq.result[i], k));
          t.oncomplete = () => { old.close(); resolve(); };
          t.onerror = () => { old.close(); resolve(); };
        };
        valsReq.onerror = () => { old.close(); resolve(); };
      };
    }).catch(() => resolve());
  });
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && `result` in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

export const blobs = {
  put: (key, blob) => tx(`readwrite`, (s) => s.put(blob, key)),
  get: (key) => tx(`readonly`, (s) => s.get(key)),
  del: (key) => tx(`readwrite`, (s) => s.delete(key)),
  keys: () => tx(`readonly`, (s) => s.getAllKeys()),
};
