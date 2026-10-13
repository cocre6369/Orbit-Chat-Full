/* Orbit — IndexedDB persistence (offscreen document only).
 *
 * Stores:
 *   messages { id, roomId, ts, senderId, ... }   index room_ts [roomId, ts]
 *   images   { id, roomId, blob, mime, size, w, h, ts }  index ts, index room
 *   assets   { id, roomId, msgId, blob, mime, size, kind, ts } indexes ts, room
 *   meta     { key, value }
 *
 * Schema versioning: bump DB_VERSION and add a case to migrate() — cases fall through so an
 * old database walks every step. Never remove old cases.
 */
const DB_NAME = 'orbit-db';
const DB_VERSION = 2;

let dbPromise = null;

function migrate(db, oldVersion, tx) {
  switch (oldVersion) {
    case 0: {
      const m = db.createObjectStore('messages', { keyPath: 'id' });
      m.createIndex('room_ts', ['roomId', 'ts']);
      m.createIndex('room', 'roomId');
      const im = db.createObjectStore('images', { keyPath: 'id' });
      im.createIndex('ts', 'ts');
      im.createIndex('room', 'roomId');
      db.createObjectStore('meta', { keyPath: 'key' });
    }
    // falls through
    case 1: {
      const assets = db.createObjectStore('assets', { keyPath: 'id' });
      assets.createIndex('ts', 'ts');
      assets.createIndex('room', 'roomId');
    }
    default: break;
  }
  void tx;
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => migrate(req.result, e.oldVersion, req.transaction);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('[Orbit/db] open blocked');
  });
  return dbPromise;
}

function reqp(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
function txDone(tx) {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('aborted')); });
}

/* ---------------- messages ---------------- */
export async function putMessage(msg) {
  const db = await openDb();
  const tx = db.transaction('messages', 'readwrite');
  tx.objectStore('messages').put(msg);
  await txDone(tx);
}

export async function putMessages(list) {
  if (!list.length) return;
  const db = await openDb();
  const tx = db.transaction('messages', 'readwrite');
  const st = tx.objectStore('messages');
  for (const m of list) st.put(m);
  await txDone(tx);
}

export async function getMessage(id) {
  const db = await openDb();
  return reqp(db.transaction('messages').objectStore('messages').get(id));
}

/** Latest messages of a room, oldest→newest. `before` is a ts bound (exclusive). */
export async function getRoomMessages(roomId, { before = Infinity, limit = 100 } = {}) {
  const db = await openDb();
  const idx = db.transaction('messages').objectStore('messages').index('room_ts');
  const range = IDBKeyRange.bound([roomId, -Infinity], [roomId, before], false, true);
  const out = [];
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(range, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c || out.length >= limit) return resolve();
      out.push(c.value);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return out.reverse();
}

export async function countRoomMessages(roomId) {
  const db = await openDb();
  return reqp(db.transaction('messages').objectStore('messages').index('room').count(roomId));
}

export async function deleteRoomMessages(roomId) {
  const db = await openDb();
  const tx = db.transaction('messages', 'readwrite');
  const idx = tx.objectStore('messages').index('room');
  await new Promise((resolve, reject) => {
    const req = idx.openKeyCursor(IDBKeyRange.only(roomId));
    req.onsuccess = () => { const c = req.result; if (!c) return resolve(); tx.objectStore('messages').delete(c.primaryKey); c.continue(); };
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
}

/** Keep only the newest `keep` messages of a room. */
export async function pruneRoomMessages(roomId, keep) {
  const total = await countRoomMessages(roomId);
  if (total <= keep) return 0;
  let toDelete = total - keep;
  const db = await openDb();
  const tx = db.transaction(['messages', 'assets'], 'readwrite');
  const msgStore = tx.objectStore('messages'); const assetsStore = tx.objectStore('assets');
  const idx = msgStore.index('room_ts');
  const range = IDBKeyRange.bound([roomId, -Infinity], [roomId, Infinity]);
  let n = 0;
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(range, 'next');
    req.onsuccess = () => { const c = req.result; if (!c || toDelete <= 0) return resolve(); for (const a of c.value.attachments || []) assetsStore.delete(a.id); c.delete(); toDelete--; n++; c.continue(); };
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  return n;
}

export async function searchRoomMessages(roomId, query, limit = 50) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  const db = await openDb();
  const idx = db.transaction('messages').objectStore('messages').index('room_ts');
  const range = IDBKeyRange.bound([roomId, -Infinity], [roomId, Infinity]);
  const out = [];
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(range, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c || out.length >= limit) return resolve();
      const m = c.value;
      if (!m.deleted && ((m.text || '').toLowerCase().includes(q) || (m.senderName || '').toLowerCase().includes(q))) out.push(m);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return out;
}

/* ---------------- images ---------------- */
export async function putImage(rec) {
  const db = await openDb();
  const tx = db.transaction('images', 'readwrite');
  tx.objectStore('images').put(rec);
  await txDone(tx);
}
export async function getImage(id) {
  const db = await openDb();
  return reqp(db.transaction('images').objectStore('images').get(id));
}
export async function deleteImage(id) {
  const db = await openDb();
  const tx = db.transaction('images', 'readwrite');
  tx.objectStore('images').delete(id);
  await txDone(tx);
}
export async function deleteRoomImages(roomId) {
  const db = await openDb();
  const tx = db.transaction('images', 'readwrite');
  const idx = tx.objectStore('images').index('room');
  await new Promise((resolve, reject) => {
    const req = idx.openKeyCursor(IDBKeyRange.only(roomId));
    req.onsuccess = () => { const c = req.result; if (!c) return resolve(); tx.objectStore('images').delete(c.primaryKey); c.continue(); };
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
}
export async function totalImageBytes() {
  const db = await openDb();
  let total = 0;
  const st = db.transaction('images').objectStore('images');
  await new Promise((resolve, reject) => {
    const req = st.openCursor();
    req.onsuccess = () => { const c = req.result; if (!c) return resolve(); total += c.value.size || 0; c.continue(); };
    req.onerror = () => reject(req.error);
  });
  return total;
}
/** Evict oldest images until the cache is below maxBytes. Returns removed ids. */
export async function pruneImages(maxBytes) {
  let total = await totalImageBytes();
  if (total <= maxBytes) return [];
  const db = await openDb();
  const tx = db.transaction('images', 'readwrite');
  const idx = tx.objectStore('images').index('ts');
  const removed = [];
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(null, 'next');
    req.onsuccess = () => {
      const c = req.result;
      if (!c || total <= maxBytes) return resolve();
      total -= c.value.size || 0; removed.push(c.value.id); c.delete(); c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  return removed;
}

/* ---------------- meta ---------------- */
export async function getMeta(key) {
  const db = await openDb();
  const r = await reqp(db.transaction('meta').objectStore('meta').get(key));
  return r ? r.value : undefined;
}
export async function setMeta(key, value) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await txDone(tx);
}

export async function clearAll() {
  const db = await openDb();
  const tx = db.transaction(['messages', 'images', 'assets', 'meta'], 'readwrite');
  tx.objectStore('messages').clear(); tx.objectStore('images').clear(); tx.objectStore('assets').clear(); tx.objectStore('meta').clear();
  await txDone(tx);
}

/* Resumable image chunks are kept separately from finished blobs. These are local-only
 * partials and remain encrypted at rest only insofar as Orbit's existing image cache does. */
export async function putPartialImage(record) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key: `partial:${record.roomId}:${record.imageId}`, value: record });
  await txDone(tx);
}
export async function getPartialImages(roomId) {
  const db = await openDb();
  const all = await reqp(db.transaction('meta').objectStore('meta').getAll());
  const prefix = `partial:${roomId}:`;
  return all.filter((x) => x.key.startsWith(prefix)).map((x) => x.value);
}
export async function deletePartialImage(roomId, imageId) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').delete(`partial:${roomId}:${imageId}`);
  await txDone(tx);
}

export async function deleteMessage(id) {
  const db = await openDb();
  const tx = db.transaction('messages', 'readwrite');
  tx.objectStore('messages').delete(id);
  await txDone(tx);
}

export async function deleteMeta(key) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').delete(key);
  await txDone(tx);
}
export async function deleteRoomPartials(roomId) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  const st = tx.objectStore('meta');
  const prefix = `partial:${roomId}:`;
  await new Promise((resolve, reject) => {
    const req = st.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      if (typeof c.key === 'string' && c.key.startsWith(prefix)) c.delete();
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
}


/* ---------------- transferable audio/files ---------------- */
export async function putAsset(asset) {
  const db = await openDb();
  const tx = db.transaction('assets', 'readwrite');
  tx.objectStore('assets').put(asset);
  await txDone(tx);
}
export async function getAsset(id) {
  const db = await openDb();
  return reqp(db.transaction('assets').objectStore('assets').get(id));
}
export async function deleteAsset(id) {
  const db = await openDb();
  const tx = db.transaction('assets', 'readwrite');
  tx.objectStore('assets').delete(id);
  await txDone(tx);
}
export async function deleteRoomAssets(roomId) {
  const db = await openDb();
  const tx = db.transaction('assets', 'readwrite');
  const idx = tx.objectStore('assets').index('room');
  await new Promise((resolve, reject) => {
    const req = idx.openKeyCursor(IDBKeyRange.only(roomId));
    req.onsuccess = () => { const c = req.result; if (!c) return resolve(); tx.objectStore('assets').delete(c.primaryKey); c.continue(); };
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
}
export async function putPartialAsset(record) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key: `partialAsset:${record.roomId}:${record.assetId}`, value: record });
  await txDone(tx);
}
export async function getPartialAssets(roomId) {
  const db = await openDb();
  const all = await reqp(db.transaction('meta').objectStore('meta').getAll());
  const prefix = `partialAsset:${roomId}:`;
  return all.filter((x) => x.key.startsWith(prefix)).map((x) => x.value);
}
export async function deletePartialAsset(roomId, assetId) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').delete(`partialAsset:${roomId}:${assetId}`);
  await txDone(tx);
}
export async function deleteRoomPartialAssets(roomId) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  const st = tx.objectStore('meta'); const prefix = `partialAsset:${roomId}:`;
  await new Promise((resolve, reject) => {
    const req = st.openCursor();
    req.onsuccess = () => { const c = req.result; if (!c) return resolve(); if (typeof c.key === 'string' && c.key.startsWith(prefix)) c.delete(); c.continue(); };
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
}
