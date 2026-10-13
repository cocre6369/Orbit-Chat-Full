/* Room-level checks for the recovery and screen-share state machines. They import the real
 * offscreen/offscreen.js with stubbed browser APIs and never touch the network:
 *   node scripts/room-state-test.mjs
 * Covers: who may claim a room code, the retry window after a browser restart, the probe that turns a
 * stale claim into guest membership, the late-joiner keyframe restart, the share capability rules,
 * segment fan-out/flow control and the "host:false is only saved for a verified hello" rule.
 * Exit code 0 = all good. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.self = globalThis;
new Function('self', fs.readFileSync(ROOT + '/shared/brand.js', 'utf8'))(globalThis);

const swMessages = []; const storageWrites = [];
globalThis.chrome = {
  runtime: { id: 't', lastError: null, getManifest: () => ({ version: '3.1.0' }), onMessage: { addListener() {} },
    sendMessage: async (m) => { swMessages.push(m); return {}; } },
  storage: { local: { get: async () => ({}), set: async (patch) => { storageWrites.push(patch); } }, onChanged: { addListener() {} } },
  offscreen: {}, alarms: {}
};
globalThis.indexedDB = { open() { return { addEventListener() {}, onsuccess: null, onerror: null, onupgradeneeded: null }; } };
globalThis.AudioContext = class { constructor() {} };

const { Room } = await import(ROOT + '/offscreen/offscreen.js');
const results = [];
const check = (name, cond, extra = '') => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const newRoom = (opts = {}) => new Room({ id: 'room1', name: 'Study', code: 'abcde', key: null, isHost: true, ...opts });
const panelEvents = (type) => swMessages.filter((m) => m.type === 'event' && m.event && m.event.type === type).map((m) => m.event);
const clearTimers = (r) => { clearTimeout(r.reconnectTimer); r.reconnectTimer = null; clearTimeout(r.handoffTimer); clearTimeout(r.statusTimer); };

/* ---------- 1. who may claim the code ---------- */
{
  const r = newRoom();
  r.isHost = false; r.claimUntil = Date.now() + 60000;
  check('canClaim: a guest never claims', r.canClaim() === false);
  r.isHost = true; r.claimUntil = 0;
  check('canClaim: expired window + no saved entry → no claim', r.canClaim() === false);
  r.claimUntil = Date.now() + 60000;
  check('canClaim: a live claim window always allows it', r.canClaim() === true);
  r.code = ''; r.claimUntil = Date.now() + 60000;
  check('canClaim: no code → no claim', r.canClaim() === false);
  clearTimers(r);
}

/* ---------- 2. a refused claim retries instead of giving up ---------- */
{
  const r = newRoom();
  swMessages.length = 0;
  await r.claimCode();
  check('claimCode: opens a retry window', r.claimUntil > Date.now() + 4 * 60000);
  check('claimCode: status is “claiming”', r.claiming === true && r.status === 'claiming');
  check('claimCode: a retry is scheduled', !!r.reconnectTimer);
  check('claimCode: tells nobody it gave up', r.lastError.includes('reclaiming'));
  clearTimers(r);
}

/* ---------- 3. after ~90 s it checks for a live host and joins it ---------- */
{
  const r = newRoom();
  r.claimUntil = Date.now() + 300000; r.claimStartedAt = Date.now() - 100000;
  let probed = 0;
  r.probeForHost = async () => { probed++; return true; };     // somebody took the room over
  await r.claimCode();
  check('claimCode: probes once after the delay', probed === 1);
  check('claimCode: found a host → stops claiming', r.claiming === false && r.claimUntil === 0);
  const r2 = newRoom();
  r2.claimUntil = Date.now() + 300000; r2.claimStartedAt = Date.now() - 100000;
  let probed2 = 0; r2.probeForHost = async () => { probed2++; return false; };   // stale reservation
  await r2.claimCode();
  check('claimCode: nobody there → keeps retrying as host', probed2 === 1 && r2.isHost === true && !!r2.reconnectTimer);
  clearTimers(r); clearTimers(r2);
}

/* ---------- 4. window expiry renews instead of giving the room up ---------- */
{
  const r = newRoom();
  r.claimUntil = Date.now() - 1000; r.claimStartedAt = Date.now() - 400000; r.probedForHost = true;
  r.abandonClaim();
  check('abandonClaim: keeps the room (still host)', r.isHost === true);
  check('abandonClaim: new window outlasts the probe delay', r.claimUntil - Date.now() > 90000);
  check('abandonClaim: next window will probe again', r.probedForHost === false);
  check('abandonClaim: schedules a reconnect', !!r.reconnectTimer);
  clearTimers(r);
}

/* ---------- 5. a late joiner restarts our encoder ---------- */
{
  const r = newRoom();
  r.screen = { streamId: 's1', quality: 'med', viewers: new Map() };
  swMessages.length = 0;
  r.askForOwnKeyframe();
  const evts = panelEvents('screen:request');
  check('askForOwnKeyframe: asks our panel for a keyframe', evts.length === 1 && evts[0].kind === 'keyframe');
  r.askForOwnKeyframe();
  check('askForOwnKeyframe: throttled (a burst of joiners restarts once)', panelEvents('screen:request').length === 1);
  r.screen = null; r.lastSelfKeyframeAsk = 0;
  r.askForOwnKeyframe();
  check('askForOwnKeyframe: does nothing when we are not sharing', panelEvents('screen:request').length === 1);
  clearTimers(r);
}

/* ---------- 6. when a share may start ---------- */
{
  const r = newRoom();
  check('capability: offline without a transport', r.screenCapability().code === 'offline');
  r.isHost = false;                                   // a guest's video would have to cross the relay
  r.tRoom = { diag: () => ({ transport: 'relay' }) };
  check('capability: relayed video is refused', r.screenCapability().code === 'relay');
  r.isHost = true;
  r.tRoom = { diag: () => ({ transport: 'direct' }) };
  r.remoteScreen = { userId: 'u-other', name: 'Bea', streamId: 's9' };
  const busy = r.screenCapability();
  check('capability: one share at a time', busy.code === 'busy' && busy.by === 'Bea');
  r.remoteScreen = null;
  check('capability: a healthy direct link may share', r.screenCapability().ok === true);
  r.tRoom = { diag: () => ({ transport: 'relay' }) };
  check('capability: the host may share while relayed to others', r.screenCapability().ok === true);
  clearTimers(r);
}

/* ---------- 7. the publisher fans segments out with stream metadata ---------- */
{
  const r = newRoom();
  const sent = [];
  r.vchunk = { send: (data, opts) => sent.push({ size: data.byteLength, opts }) };
  r.peers.set('t1', { transportId: 't1', userId: 'u1' });
  r.peers.set('t2', { transportId: 't2', userId: 'u2' });
  r.updates = []; r.scheduleUpdate = () => {}; r.screenTick = () => {};
  r.screen = { streamId: 's1', quality: 'med', viewers: new Map(), seq: 0, paused: false, worstLag: 0 };
  const payload = Buffer.from(new Uint8Array(500).fill(3)).toString('base64');
  const res = r.publishScreenChunk({ streamId: 's1', seq: 1, data: payload });
  check('publishScreenChunk: fans out to every member', res.ok === true && sent.length === 2);
  check('publishScreenChunk: carries {sid, seq} metadata', sent[0].opts.metadata.sid === 's1' && sent[0].opts.metadata.seq === 1);
  check('publishScreenChunk: ignores another stream id', r.publishScreenChunk({ streamId: 'nope', seq: 2, data: payload }).ok === false);
  check('publishScreenChunk: ignores oversized segments', r.publishScreenChunk({ streamId: 's1', seq: 3, data: 'A'.repeat(64000 * 2 + 10) }).ok === false);
  check('publishScreenChunk: ignores junk', r.publishScreenChunk({ streamId: 's1', seq: 4, data: 42 }).ok === false);
  clearTimers(r);
}

/* ---------- 8. the viewer receives segments and asks for a keyframe on a gap ---------- */
{
  const r = newRoom();
  r.amRelayMember = () => false;
  r.screenView = { streamId: 's1', sharerId: 'u-bea', sharerTransport: 't9', lastSeq: -1, received: 0, since: Date.now() };
  const envs = []; r.sendEnv = async (env, target) => { envs.push({ env, target }); return true; };
  r.vack = { send() {} };
  swMessages.length = 0;
  const chunk = new Uint8Array(900).fill(9);
  r.onLvChunk(chunk.buffer.slice(0), 't9', { sid: 's1', seq: 1 });
  const chunkEvents = panelEvents('screen:chunk');
  check('onLvChunk: hands segments to the panel', chunkEvents.length === 1 && chunkEvents[0].seq === 1);
  check('onLvChunk: forwards the stream id', chunkEvents[0].streamId === 's1');
  check('onLvChunk: base64 round-trips the bytes', Buffer.from(chunkEvents[0].bytes, 'base64').length === 900);
  r.onLvChunk(chunk.buffer.slice(0), 't9', { sid: 's1', seq: 1 });
  check('onLvChunk: drops duplicates', panelEvents('screen:chunk').length === 1);
  r.onLvChunk(chunk.buffer.slice(0), 't5', { sid: 's1', seq: 2 });
  check('onLvChunk: drops segments from another transport', panelEvents('screen:chunk').length === 1);
  envs.length = 0;
  r.onLvChunk(chunk.buffer.slice(0), 't9', { sid: 's1', seq: 60 });    // a big gap
  check('onLvChunk: asks the sharer for a keyframe after a gap', envs.length === 1 && envs[0].env.payload.kind === 'keyframe' && envs[0].target === 't9');
  clearTimers(r);
}

/* ---------- 9. host:false is only saved for a verified hello from the code holder ---------- */
{
  const r = newRoom({ isHost: false });
  r.transportHostId = 'host-transport';
  r.everConnected = true; r.handoffInProgress = true; r.handoffRetry = 2;
  r.systemMessage = () => {}; r.storeMessage = async () => {}; r.checkCapacity = () => {};
  r.lastJoinAnnounce.set('u-host', Date.now());
  const peer = { transportId: 'host-transport', userId: 'u-host', profile: {}, helloSent: Date.now(), joinedAt: Date.now() };
  r.peers.set('host-transport', peer);
  storageWrites.length = 0;
  r.onHello({ senderId: 'u-host', payload: { name: 'Host', presence: 'online' } }, peer, true);
  check('onHello: the code holder is recorded as host', r.hostConfirmed === true);
  check('onHello: a confirmed host ends the handoff retries', r.handoffInProgress === false && r.handoffTimer === null);
  check('onHello: no entry is invented just to demote ourselves', !JSON.stringify(storageWrites).includes('"host":false'));
  clearTimers(r);
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} room-level cases pass`);
process.exit(failed.length ? 1 : 0);
