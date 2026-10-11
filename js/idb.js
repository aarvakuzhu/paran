// Tiny IndexedDB key/value store for photo blobs (pending uploads and demo mode).
const DB_NAME = `stash`;
const STORE = `blobs`;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
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
