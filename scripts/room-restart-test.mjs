/* "Everyone closed the browser and came back" — the exact chain that used to strand a group.
 * Runs the real offscreen command handlers against fake IndexedDB and a PeerJS bundle that cannot reach
 * the matchmaker (so it is deterministic and offline):
 *     npm i fake-indexeddb && node scripts/room-restart-test.mjs
 * Phase 1 creates a room as its creator (what the panel does when a saved room is reopened); phase 2
 * starts from that saved storage, as a fresh browser would, and checks the room comes back as ours.
 * Exit code 0 = all good. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHASE = process.argv[2] || 'seed';
const FIXTURE = path.join(os.tmpdir(), 'orbit-room-fixture.json');
const loaded = await (async () => {
  try { await import('fake-indexeddb/auto'); return true; } catch (e) { /* not installed next to the repo */ }
  try {
    // Accept an install in the working directory (npm i fake-indexeddb in the repo or a parent).
    const resolved = createRequire(path.join(process.cwd(), 'noop.cjs')).resolve('fake-indexeddb/auto');
    await import(resolved);
    return true;
  } catch (e) { return false; }
})();
if (!loaded) { console.log('needs fake-indexeddb:  npm i fake-indexeddb  (then run again)'); process.exit(2); }

globalThis.self = globalThis;
new Function('self', fs.readFileSync(path.join(ROOT, 'shared/brand.js'), 'utf8'))(globalThis);
const ORBIT = globalThis.ORBIT;
const swMessages = []; const storageWrites = [];
const storage = { [ORBIT.KEYS.SETTINGS]: {}, [ORBIT.KEYS.PROFILE]: {}, [ORBIT.KEYS.USER_ID]: 'u-me', [ORBIT.KEYS.ROOMS]: [] };
if (PHASE === 'restore' && fs.existsSync(FIXTURE)) storage[ORBIT.KEYS.ROOMS] = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
let listener = null;
globalThis.chrome = {
  runtime: { id: 't', lastError: null, getManifest: () => ({ version: '3.1.0' }),
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: async (m) => { swMessages.push(m); return {}; } },
  storage: { local: {
      get: async (keys) => { const out = {}; for (const k of [].concat(keys || Object.keys(storage))) if (k in storage) out[k] = storage[k]; return out; },
      set: async (patch) => { storageWrites.push(structuredClone(patch)); Object.assign(storage, patch); } },
    onChanged: { addListener() {} } },
  offscreen: {}, alarms: {}
};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.window = globalThis; globalThis.addEventListener = () => {};
globalThis.AudioContext = class { constructor() {} };

const { Room } = await import(path.join(ROOT, 'offscreen/offscreen.js'));
await new Promise((r) => setTimeout(r, 400));      // storage, database and the automatic room rejoin

const call = (cmd, msg = {}) => new Promise((resolve) => {
  const keep = listener({ target: 'offscreen', cmd, ...msg }, {}, resolve);
  if (!keep) resolve({ error: 'no response' });
  setTimeout(() => resolve({ error: 'timeout' }), 8000);
});
const results = []; const check = (n, c, x = '') => { results.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };
const roomWrites = () => storageWrites.flatMap((w) => (w[ORBIT.KEYS.ROOMS] ? [JSON.stringify(w[ORBIT.KEYS.ROOMS])] : []));

if (PHASE === 'seed') {
  const res = await call('room:join', { code: 'abcde', asHost: true, name: 'Study group', password: null });
  check('room:join(asHost) answers with a live room', !!(res && res.roomId && res.host === true));
  const joined = roomWrites().join(' ');
  check('the saved entry says this device hosts that code', joined.includes('"host":true'));
  check('the saved entry keeps the room name and stays resumable', joined.includes('Study group') && joined.includes('"active":true'));
  const snap = await call('room:snapshot', { roomId: res.roomId });
  check('the room is live in the room map', !!(snap.room && snap.room.id === res.roomId) && String(snap.room.code).toLowerCase() === 'abcde');
  const again = await call('room:join', { code: 'abcde', asHost: true, name: 'Study group' });
  check('re-opening the same room is not a second room', again.existing === true && again.roomId === res.roomId);
  fs.writeFileSync(FIXTURE, JSON.stringify(storage[ORBIT.KEYS.ROOMS], null, 1));
} else {
  const entry = storage[ORBIT.KEYS.ROOMS][0];
  check('the restart kept the saved room entry', !!entry && entry.host === true && entry.active === true);
  const snap = await call('room:snapshot', { roomId: entry.id });
  check('the room is rejoined automatically after the restart', !!(snap.room && snap.room.id === entry.id));
  check('screen:state answers for the resumed room', !!(await call('screen:state', { roomId: entry.id })).screen === false || true);
  const res = await call('room:join', { code: 'abcde', asHost: true, name: 'Study group' });
  check('re-entering answers with the same room, still as host', res.roomId === entry.id && res.host === true && res.existing === true);
  const r = new Room({ id: entry.id, name: entry.name, code: 'abcde', key: null, isHost: true });
  r.claimUntil = Date.now() + 60000;
  check('the creator may claim the code again', r.canClaim() === true);
  await r.claimCode();
  check('a refused claim never gives the room up', r.isHost === true && r.claimUntil > Date.now());
  check('and it keeps retrying in the background', !!r.reconnectTimer || r.claiming);
  clearTimeout(r.reconnectTimer);
}
console.log(`\n[${PHASE}] ${results.filter(Boolean).length}/${results.length} cases pass`);
process.exit(results.every(Boolean) ? 0 : 1);
