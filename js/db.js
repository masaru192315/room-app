// 保存先の切り替え：
//  - claude.ai のアーティファクトとして開いた場合 → Claude アカウントの個人用ストア（db capability）
//  - それ以外（GitHub Pages / ローカル） → ブラウザの IndexedDB
// どちらも同じインターフェース（all / put / del / clear / bulkPut）で扱う。

// ---------- IndexedDB ----------
const DB_NAME = 'devnote';
const DB_VERSION = 1;
let idbPromise = null;

function idbOpen() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}

function idbTx(store, mode, fn) {
  return idbOpen().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const reqP = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

const idbBackend = {
  mode: 'local',
  all: store => idbTx(store, 'readonly', s => reqP(s.getAll())),
  put: (store, obj) => idbTx(store, 'readwrite', s => { s.put(obj); return obj; }),
  del: (store, id) => idbTx(store, 'readwrite', s => { s.delete(id); }),
  clear: store => idbTx(store, 'readwrite', s => { s.clear(); }),
  bulkPut: (store, list) => idbTx(store, 'readwrite', s => { list.forEach(o => s.put(o)); }),
};

// ---------- Claude（アーティファクトの db capability） ----------
// 本人だけが読める data/users/<id> コレクションに、kind: 'notes' | 'projects' 付きで保存する。
function claudeBackend(cdb, uid) {
  const col = cdb.collection(`data/users/${uid}`);
  const queues = new Map(); // 同じドキュメントへの書き込みは1つずつ順番に
  const serial = (id, fn) => {
    const prev = queues.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(id, next);
    next.finally(() => { if (queues.get(id) === next) queues.delete(id); });
    return next;
  };
  const retry = async fn => {
    try { return await fn(); }
    catch (e) {
      if (e?.code !== 'unavailable') throw e;
      await new Promise(r => setTimeout(r, 400 + Math.random() * 600));
      return fn();
    }
  };
  const strip = d => { const { kind, ...rest } = d.data(); return rest; };
  const backend = {
    mode: 'claude',
    all: async store => (await retry(() => col.where('kind', '==', store).get())).docs.map(strip),
    put: (store, obj) => serial(obj.id, () => retry(() => col.doc(obj.id).set({ ...JSON.parse(JSON.stringify(obj)), kind: store }))).then(() => obj),
    del: (store, id) => serial(id, () => retry(() => col.doc(id).delete())),
    clear: async store => { for (const o of await backend.all(store)) await backend.del(store, o.id); },
    bulkPut: async (store, list) => { for (const o of list) await backend.put(store, o); },
  };
  return backend;
}

// ---------- 初期化 ----------
let backend = idbBackend;
export const embedded = typeof window !== 'undefined' && typeof window.claude?.use === 'function';

// 戻り値: 'claude' | 'local' | 'local-fallback'（アーティファクト内だがClaudeに保存できない）
export async function initStore() {
  if (!embedded) return 'local';
  try {
    const [cdb, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
    const uid = await user?.id();
    if (cdb && uid) {
      backend = claudeBackend(cdb, uid);
      await backend.all('projects'); // 読めるか確認
      return 'claude';
    }
  } catch (e) { console.warn('Claude storage unavailable', e); backend = idbBackend; }
  return 'local-fallback';
}

export const db = {
  all: s => backend.all(s),
  put: (s, o) => backend.put(s, o),
  del: (s, id) => backend.del(s, id),
  clear: s => backend.clear(s),
  bulkPut: (s, l) => backend.bulkPut(s, l),
};

export async function requestPersist() {
  if (backend.mode === 'claude') return true;
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch {}
  return false;
}
