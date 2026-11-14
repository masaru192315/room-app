// IndexedDB の薄いラッパー（依存ライブラリなし）
const DB_NAME = 'devnote';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const db = {
  all: store => tx(store, 'readonly', s => reqP(s.getAll())),
  get: (store, id) => tx(store, 'readonly', s => reqP(s.get(id))),
  put: (store, obj) => tx(store, 'readwrite', s => { s.put(obj); return obj; }),
  del: (store, id) => tx(store, 'readwrite', s => { s.delete(id); }),
  clear: store => tx(store, 'readwrite', s => { s.clear(); }),
  bulkPut: (store, list) => tx(store, 'readwrite', s => { list.forEach(o => s.put(o)); }),
};

export async function requestPersist() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch {}
  return false;
}
