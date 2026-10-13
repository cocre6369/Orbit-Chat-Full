/* Orbit transport adapter — connection logic modelled on the "Neon Nights" party game.
 *
 *  TOPOLOGY   One room owner (the host) holds the namespaced PeerJS ID derived from the five-letter code.
 *             Every other member opens ONE connection to the host, who forwards room traffic (a star).
 *
 *  TRANSPORT  1. Primary: WebRTC data channels through PeerJS (fast, direct, free).
 *             2. Fallback: if a direct link can't form (strict NAT, blocked WebRTC, PeerJS matchmaker unreachable,
 *                12 s timeout) the member relays the same frames through a public MQTT broker over WebSocket-TLS.
 *                The host always listens on the relay too, serves both kinds of member at once, and relay members
 *                quietly retry a direct link and hot-swap to it when it succeeds ("upgrade").
 *             Relay frames are sealed with AES-GCM and use a hashed topic (see relay-mqtt.js).
 *
 *  The public API (joinRoom → makeAction / onPeerJoin / onPeerLeave / onTransportLost / getPeers / ping /
 *  diag / leave) is unchanged, so offscreen.js and the Orbit wire protocol are untouched.
 *  Wire frames are plain JSON (PeerJS 'json' serialization, binary payloads as base64), exactly like
 *  Neon Nights; frames bigger than one safe data-channel message are fragmented transparently.
 */
import { Peer } from '../lib/peerjs-client.js';
import { MqttClient, RELAY_BROKERS, makeRelayCrypto } from './relay-mqtt.js';

const SYS = '__orbitPeerJS';
// Namespace the server-side PeerJS ID; the user-facing room code remains exactly five letters.
const ROOM_ID_PREFIX = 'orbit-chat-v1-';
const TIMING = {
  p2pTimeout: 12000,      // direct link must open within this or we switch to the relay
  hostBoot: 12000,        // host: matchmaker silent for this long → run relay-only
  brokerTimeout: 11000,   // per relay broker: connect + subscribe + host welcome
  helloRetry: 3500,       // relay guest repeats its hello once
  hb: 3000,               // host → relay members heartbeat
  dead: 25000,            // silence after which a relay peer is considered gone
  upgradeFirst: 5000,     // relay guest tries a direct link after this
  upgradeRetry: 30000,
  upgradeTimeout: 12000
};
const FRAG = 48000;             // characters of JSON per data-channel message (safe on every browser)
const FRAG_RELAY = 150000;      // characters of JSON per relayed (MQTT) message
const MAX_FRAME = 1200000;      // largest reassembled frame we accept
const MAX_B64 = 1000000;

function makeGuestPeerId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return 'orbit-client-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
const rndToken = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

function b64enc(data) {
  let u8;
  if (typeof data === 'string') u8 = new TextEncoder().encode(data);
  else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else u8 = new Uint8Array(0);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64dec(str) {
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

export function joinRoom(config, roomCode, options = {}) {
  const role = options.role === 'host' ? 'host' : 'join';
  const code = String(roomCode || '').toLowerCase();
  if (!/^[a-z]{5}$/.test(code)) return Promise.reject(new Error('Room codes must be exactly five letters.'));
  const hostPeerId = ROOM_ID_PREFIX + code;
  const T = { ...TIMING, ...(options.timing || {}) };
  const PeerType = options.PeerCtor || Peer;
  const MqttType = options.MqttCtor || MqttClient;
  const brokers = options.brokers || RELAY_BROKERS;
  const selfId = role === 'host' ? hostPeerId : makeGuestPeerId();
  const peerOpts = {
    host: '0.peerjs.com', port: 443, path: '/', secure: true, debug: 0,
    config: config && config.rtcConfig || undefined
  };
  const relaySecret = config && config.password || '';

  return new Promise((resolve, reject) => {
    let settled = false, closed = false;
    const channels = new Map();            // peerId -> conn  (host: every member; guest: host + virtual peers)
    const notified = new Set();
    const virtual = new Set();
    const actions = new Map();
    const pings = new Map();
    const toks = new Map();                // host: relay member id -> upgrade token
    const lastSeen = new Map();            // host: relay member id -> last frame time
    let joinCb = null, leaveCb = null, lostCb = null;
    let hostLost = false, hostLossDelivered = false;
    let lastPeerErr = '';

    // peers
    let peer = null;                       // host: the room's PeerJS peer;  guest: the current direct-link peer
    let upgPeer = null;
    let roomConn = null, hostChannel = null;
    // guest state
    let joined = false, fellBack = false, transport = null, relayWhy = '', joinedTok = null;
    let hostUnavailable = false, relayReached = false, relayFailed = false;
    let lastFromHost = Date.now();
    // relay
    let relayClient = null, relayUrl = '', relayCrypto = null;
    let txChain = Promise.resolve(), rxChain = Promise.resolve();
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
    const every = (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; };

    /* ------------------------------ callbacks ------------------------------ */
    function signalLoss(info) {
      if (info && info.type === 'host') { hostLost = true; if (hostLossDelivered) return; hostLossDelivered = true; }
      if (lostCb) { try { lostCb(info || {}); } catch (e) { /* noop */ } }
    }
    function notifyJoin(id) {
      if (!id || notified.has(id)) return;
      notified.add(id);
      if (joinCb) { try { joinCb(id); } catch (e) { console.warn('[Orbit/PeerJS] join callback', e); } }
    }
    function notifyLeave(id) {
      if (!id || !notified.delete(id)) return;
      if (leaveCb) { try { leaveCb(id); } catch (e) { console.warn('[Orbit/PeerJS] leave callback', e); } }
    }
    function dispatch(action, b64, peerId, metadata) {
      const a = actions.get(action);
      if (!a || !a.callback || typeof b64 !== 'string' || b64.length > MAX_B64) return;
      let data; try { data = b64dec(b64); } catch (e) { return; }
      try { a.callback(data, { peerId, metadata: metadata || null }); } catch (e) { console.warn('[Orbit/PeerJS] action callback', e); }
    }

    /* ------------------------------- sending ------------------------------- */
    function relayPublish(topic, obj) {
      txChain = txChain.then(async () => {
        const c = relayClient;
        if (!c || !relayCrypto || closed) return;
        try { c.publish(topic, await relayCrypto.seal(JSON.stringify(obj))); } catch (e) { /* noop */ }
      });
    }
    function sendFrame(conn, frame) {
      if (!conn || !conn.open) return false;
      // Live screen-share video ('lvchunk') is direct-link only: a public MQTT broker cannot carry a video
      // stream, and trying would stall the room. The sharer's panel is told why instead (see offscreen.js).
      if (conn._relay && frame && frame[SYS] === 'data' && frame.action === 'lvchunk') return false;
      try {
        const out = conn._relay ? conn._relaySend : (f) => conn.send(f);
        const limit = conn._relay ? FRAG_RELAY : FRAG;
        if (typeof frame.data === 'string' && frame.data.length > limit - 2000) {
          const s = JSON.stringify(frame), id = rndToken(), n = Math.ceil(s.length / limit);
          for (let i = 0; i < n; i++) out({ [SYS]: 'frag', id, i, n, s: s.slice(i * limit, (i + 1) * limit) });
        } else out(frame);
        return true;
      } catch (e) { return false; }
    }
    function defrag(conn, f) {
      if (f[SYS] !== 'frag') return f;
      if (typeof f.id !== 'string' || !(f.n > 0 && f.n <= 64) || !(f.i >= 0 && f.i < f.n) || typeof f.s !== 'string') return null;
      const m = conn._frags || (conn._frags = new Map());
      const t = Date.now();
      for (const [k, e] of m) if (t - e.at > 30000) m.delete(k);
      let e = m.get(f.id);
      if (!e) { if (m.size >= 8) m.delete(m.keys().next().value); e = { n: f.n, parts: new Array(f.n), got: 0, size: 0, at: t }; m.set(f.id, e); }
      if (e.parts[f.i] === undefined) { e.parts[f.i] = f.s; e.got++; e.size += f.s.length; if (e.size > MAX_FRAME) { m.delete(f.id); return null; } }
      if (e.got < e.n) return null;
      m.delete(f.id);
      try { return JSON.parse(e.parts.join('')); } catch (err) { return null; }
    }

    /* ---------------------------- host-side members ---------------------------- */
    function announceLeft(id) {
      if (role === 'host') for (const [otherId, conn] of channels) if (otherId !== id && otherId !== selfId) sendFrame(conn, { [SYS]: 'left', id });
      notifyLeave(id);
      virtual.delete(id); channels.delete(id); toks.delete(id); lastSeen.delete(id);
    }
    function hostAddChannel(conn) {
      channels.set(conn.peer, conn);
      const existing = Array.from(channels.keys()).filter((id) => id !== conn.peer && id !== selfId);
      sendFrame(conn, { [SYS]: 'roster', peers: existing });
      for (const [id, other] of channels) if (id !== conn.peer && id !== selfId) sendFrame(other, { [SYS]: 'joined', id: conn.peer });
      notifyJoin(conn.peer);
    }
    function hostAttachP2P(conn) {
      conn.on('open', () => {
        if (closed) { try { conn.close(); } catch (e) { /* noop */ } return; }
        const existing = channels.get(conn.peer);
        if (existing && existing._relay) { conn._pending = true; return; }   // relay member proving it owns this seat
        hostAddChannel(conn);
      });
      conn.on('data', (d) => onFrame(conn, d));
      conn.on('close', () => { if (!conn._pending && channels.get(conn.peer) === conn) announceLeft(conn.peer); });
      conn.on('error', (err) => { if (channels.get(conn.peer) === conn && err && /unavailable|not found/i.test(String(err.type || err.message || ''))) announceLeft(conn.peer); });
    }
    function hostUpgrade(conn, f) {
      const id = conn.peer, old = channels.get(id);
      if (!old || !old._relay || !f.tok || toks.get(id) !== f.tok) { try { conn.close(); } catch (e) { /* noop */ } return; }
      conn._pending = false;
      old.open = false;
      channels.set(id, conn);
      lastSeen.delete(id);
      sendFrame(conn, { [SYS]: 'upgraded' });
    }
    function mkHostRelayConn(gid) {
      return { peer: gid, open: true, _relay: true, close() { this.open = false; }, _relaySend: (f) => relayPublish(relayCrypto.topic + '/g/' + gid, f) };
    }
    function hostRelayMsg(bytes) {
      rxChain = rxChain.then(async () => {
        if (closed || !relayCrypto) return;
        const s = await relayCrypto.open(bytes);
        if (!s) return;
        let d; try { d = JSON.parse(s); } catch (e) { return; }
        if (!d || typeof d.from !== 'string' || !d.m || typeof d.m !== 'object') return;
        if (d.from === hostPeerId || d.from === selfId) return;          // cannot spoof the host
        let conn = channels.get(d.from);
        if (conn && !conn._relay) return;                                // cannot spoof a direct peer over the relay
        if (!conn) {
          if (d.m[SYS] !== 'hello') return;                              // must say hello first
          conn = mkHostRelayConn(d.from);
          const tok = rndToken(); toks.set(d.from, tok);
          lastSeen.set(d.from, Date.now());
          sendFrame(conn, { [SYS]: 'welcome', tok });
          hostAddChannel(conn);
          return;
        }
        if (d.m[SYS] === 'hello') { sendFrame(conn, { [SYS]: 'welcome', tok: toks.get(d.from) }); return; }   // repeated hello
        onFrame(conn, d.m);
      }).catch(() => {});
    }
    async function startRelayHost(bi) {
      if (closed || role !== 'host') return;
      if (bi >= brokers.length) { relayFailed = true; return; }
      try { relayCrypto = relayCrypto || await makeRelayCrypto(code, relaySecret); } catch (e) { relayFailed = true; return; }
      let ok = false, client, t = null;
      const fail = () => { if (ok || closed) return; ok = true; clearTimeout(t); try { client && client.end(); } catch (e) { /* noop */ } startRelayHost(bi + 1); };
      try { client = new MqttType(brokers[bi], { reconnectMs: 3000, connectTimeout: 7000 }); } catch (e) { return fail(); }
      t = later(fail, 10000);
      client.onopen = async () => {
        if (ok || closed) return;
        try { await client.subscribe(relayCrypto.topic + '/h'); } catch (e) { return fail(); }
        if (ok || closed) return;
        ok = true; clearTimeout(t); relayClient = client; relayUrl = brokers[bi]; relayReached = true;
      };
      client.onmessage = (topic, bytes) => hostRelayMsg(bytes);
      client.onclose = () => { if (!ok) fail(); };               // refused/unreachable broker: move on at once
      client.open();
    }
    function startHostLoops() {
      every(() => {
        const t = Date.now();
        for (const [id, conn] of Array.from(channels)) {
          if (!conn._relay) continue;
          sendFrame(conn, { [SYS]: 'hb' });
          if (t - (lastSeen.get(id) || t) > T.dead) announceLeft(id);
        }
      }, T.hb);
    }

    /* ------------------------------ frame router ------------------------------ */
    function routeData(conn, frame) {
      const origin = role === 'host' ? conn.peer : frame.origin;
      if (!origin || typeof frame.action !== 'string') return;
      dispatch(frame.action, frame.data, origin, frame.metadata);
      if (role !== 'host') return;
      const target = frame.target || null;
      const fwd = { [SYS]: 'data', origin, action: frame.action, data: frame.data, metadata: frame.metadata || null };
      if (target) {
        if (target !== selfId) sendFrame(channels.get(target), fwd);
      } else {
        for (const [id, other] of channels) if (id !== origin && id !== selfId && !other._orbitVirtual) sendFrame(other, fwd);
      }
    }
    function onFrame(conn, raw) {
      if (!raw || typeof raw !== 'object') return;
      const data = defrag(conn, raw);
      if (!data) return;
      if (role === 'host') {
        if (conn._pending) { if (data[SYS] === 'upgrade') hostUpgrade(conn, data); return; }
        if (conn._relay) lastSeen.set(conn.peer, Date.now());
      } else if (conn === hostChannel || conn._relay || data[SYS] === 'welcome') lastFromHost = Date.now();

      const kind = data[SYS];
      if (role === 'join') {
        if (kind === 'welcome') { guestWelcome(conn, data); return; }
        if (kind === 'roster') { (data.peers || []).forEach(addVirtual); return; }
        if (kind === 'joined') { addVirtual(data.id); return; }
        if (kind === 'left') { notifyLeave(data.id); virtual.delete(data.id); channels.delete(data.id); return; }
        if (kind === 'hb') { if (transport === 'relay') sendFrame(hostChannel, { [SYS]: 'hbr' }); return; }
      } else if (kind === 'bye') { if (conn._relay) announceLeft(conn.peer); return; }
      if (kind === 'data') { routeData(conn, data); return; }
      if (kind === 'ping') {
        if (role === 'host' && data.target && data.target !== selfId) {
          sendFrame(channels.get(data.target), { [SYS]: 'ping', nonce: data.nonce, origin: data.origin, at: data.at });
        } else if (role === 'join' && data.target && data.target !== hostPeerId) {
          sendFrame(hostChannel, { [SYS]: 'ping', nonce: data.nonce, origin: selfId, target: data.target, at: data.at });
        } else {
          const response = { [SYS]: 'pong', nonce: data.nonce, target: data.origin, at: data.at };
          if (role === 'host') sendFrame(channels.get(conn.peer), response); else sendFrame(hostChannel, response);
        }
        return;
      }
      if (kind === 'pong') {
        if (role === 'host' && data.target && data.target !== selfId) sendFrame(channels.get(data.target), data);
        else { const res = pings.get(data.nonce); if (res) { pings.delete(data.nonce); res(Date.now() - data.at); } }
      }
    }

    /* ------------------------------- guest side ------------------------------- */
    function addVirtual(id) {
      if (!id || id === selfId || id === hostPeerId || virtual.has(id)) return;
      virtual.add(id);
      // Guest-side IDs are routed through the room owner; they need no connection of their own.
      if (role === 'join') channels.set(id, { peer: id, open: true, _orbitVirtual: true });
      notifyJoin(id);
    }
    function hostGone() {
      if (closed) return;
      signalLoss({ type: 'host' });
      for (const id of Array.from(notified)) notifyLeave(id);
      channels.clear(); virtual.clear(); hostChannel = null; joined = false;
      stopRelay();
    }
    function guestJoined(conn, via) {
      joined = true; transport = via; hostChannel = conn; lastFromHost = Date.now();
      channels.set(hostPeerId, conn);
      notifyJoin(hostPeerId);
      sendFrame(conn, { [SYS]: 'register', id: selfId });
    }
    function guestWelcome(conn, f) {
      if (joined) { if (typeof f.tok === 'string') joinedTok = f.tok; return; }
      if (!conn._relay) return;
      joinedTok = typeof f.tok === 'string' ? f.tok : null;
      relayWhy = relayWhy || 'direct link unavailable';
      guestJoined(conn, 'relay');
      every(() => { if (transport === 'relay' && Date.now() - lastFromHost > T.dead) hostGone(); }, 3000);
      later(() => tryUpgrade(1), T.upgradeFirst);
    }

    // direct (PeerJS) link, first attempt
    function startP2P() {
      let p;
      try { p = new PeerType(selfId, peerOpts); } catch (e) { fallback('webrtc unavailable'); return; }
      peer = p;
      const failT = later(() => fallback('timeout'), T.p2pTimeout);
      p.on('open', () => {
        if (closed || joined || fellBack) return;
        const conn = p.connect(hostPeerId, { reliable: true, serialization: 'json', metadata: { orbitRoom: true } });
        roomConn = conn;
        conn.on('open', () => { if (closed || joined || fellBack) return; clearTimeout(failT); guestJoined(conn, 'p2p'); });
        conn.on('data', (d) => onFrame(conn, d));
        conn.on('close', () => { if (conn === hostChannel) hostGone(); else if (!joined) fallback('host dropped the link'); });
        conn.on('error', () => { /* surfaces as a peer error or close */ });
      });
      p.on('error', (err) => {
        if (err) lastPeerErr = String(err.type || err.message || '');
        if (joined || closed) return;
        fallback(lastPeerErr || 'error');
      });
      p.on('disconnected', () => { /* a live data channel does not need the matchmaker */ });
    }
    function fallback(why) {
      if (joined || fellBack || closed) return;
      fellBack = true;
      relayWhy = why === 'peer-unavailable' ? "the room isn't reachable on the matchmaker" : why === 'timeout' ? 'the direct link timed out' : 'direct link failed (' + why + ')';
      try { peer && peer.destroy(); } catch (e) { /* noop */ }
      peer = null; roomConn = null;
      startRelayGuest(0);
    }
    async function startRelayGuest(bi) {
      if (closed || joined) return;
      if (bi >= brokers.length) { relayFailed = true; hostUnavailable = relayReached; return; }
      try { relayCrypto = relayCrypto || await makeRelayCrypto(code, relaySecret); } catch (e) { relayFailed = true; return; }
      if (closed || joined) return;
      let client, moved = false, t = null;
      const giveUp = () => { if (moved || joined || closed) return; moved = true; clearTimeout(t); try { client && client.end(); } catch (e) { /* noop */ } if (relayClient === client) relayClient = null; startRelayGuest(bi + 1); };
      try { client = new MqttType(brokers[bi], { reconnectMs: 2000, connectTimeout: 7000 }); } catch (e) { relayFailed = true; return; }
      relayClient = client; relayUrl = brokers[bi];
      t = later(giveUp, T.brokerTimeout);
      const hello = () => { if (!joined && !moved && !closed) relayPublish(relayCrypto.topic + '/h', { from: selfId, m: { [SYS]: 'hello' } }); };
      client.onopen = async () => {
        if (moved || joined || closed) return;
        try { await client.subscribe(relayCrypto.topic + '/g/' + selfId); } catch (e) { return giveUp(); }
        relayReached = true;
        hello(); later(hello, T.helloRetry);
      };
      client.onmessage = (topic, bytes) => {
        rxChain = rxChain.then(async () => {
          if (closed || !relayCrypto) return;
          const s = await relayCrypto.open(bytes);
          if (!s) return;
          let f; try { f = JSON.parse(s); } catch (e) { return; }
          if (f && typeof f === 'object') onFrame(guestRelayConn, f);
        }).catch(() => {});
      };
      client.onclose = () => { if (!joined) giveUp(); };          // refused/unreachable broker: move on at once
      client.open();
    }
    const guestRelayConn = {
      peer: hostPeerId, open: true, _relay: true, close() { this.open = false; },
      _relaySend(f) { relayPublish(relayCrypto.topic + '/h', { from: selfId, m: f }); }
    };

    // relay guests quietly retry a direct link and hot-swap to it
    function tryUpgrade(attempt) {
      if (closed || transport !== 'relay' || !joinedTok) return;
      let p;
      try { p = new PeerType(selfId, peerOpts); } catch (e) { return; }
      upgPeer = p;
      let done = false, bailT = null;
      const bail = () => {
        if (done) return; done = true; clearTimeout(bailT);
        try { p.destroy(); } catch (e) { /* noop */ }
        if (upgPeer === p) upgPeer = null;
        if (attempt < 3 && !closed && transport === 'relay') later(() => tryUpgrade(attempt + 1), T.upgradeRetry);
      };
      bailT = later(bail, T.upgradeTimeout);
      p.on('open', () => {
        if (done || closed) return;
        const conn = p.connect(hostPeerId, { reliable: true, serialization: 'json', metadata: { orbitRoom: true, upgrade: true } });
        conn.on('open', () => { try { conn.send({ [SYS]: 'upgrade', tok: joinedTok }); } catch (e) { /* noop */ } });
        conn.on('data', (d) => {
          if (conn === hostChannel) { onFrame(conn, d); return; }
          if (d && d[SYS] === 'upgraded' && !done && transport === 'relay') {
            done = true; clearTimeout(bailT);
            transport = 'p2p'; hostChannel = conn; channels.set(hostPeerId, conn);
            peer = p; roomConn = conn; upgPeer = null; lastFromHost = Date.now();
            stopRelay();
          }
        });
        conn.on('close', () => { if (conn === hostChannel) hostGone(); else bail(); });
        conn.on('error', () => { /* surfaces as close */ });
      });
      p.on('error', () => { if (!done) bail(); });
    }
    function stopRelay() {
      const c = relayClient; relayClient = null;
      if (c) { try { c.end(); } catch (e) { /* noop */ } }
    }

    /* -------------------------------- host boot -------------------------------- */
    function bootHost(relayOnly) {
      if (settled) return;
      settled = true;
      startHostLoops();
      startRelayHost(0);
      resolve(api);
    }
    function startHost() {
      let p;
      try { p = new PeerType(hostPeerId, peerOpts); } catch (e) { bootHost(true); return; }
      peer = p;
      const bootT = later(() => bootHost(true), T.hostBoot);         // matchmaker silent → relay-only room
      p.on('connection', (conn) => { if (closed) { try { conn.close(); } catch (e) { /* noop */ } return; } hostAttachP2P(conn); });
      p.on('open', () => { clearTimeout(bootT); bootHost(false); });
      p.on('error', (err) => {
        if (err) lastPeerErr = String(err.type || err.message || '');
        if (!settled) {
          clearTimeout(bootT);
          if (err && err.type === 'unavailable-id') {                  // code collision / still reserved → caller decides
            settled = true;
            const e = new Error(err.message || 'Room code is already taken');
            e.code = 'unavailable-id';
            try { p.destroy(); } catch (ignored) { /* noop */ }
            reject(e);
          } else bootHost(true);                                       // matchmaker blocked → relay-only room
        } else if (!closed && err && err.type === 'unavailable-id') signalLoss({ type: 'signal' });
      });
      p.on('disconnected', () => {
        const retry = () => { if (closed || peer !== p || p.destroyed || !p.disconnected) return; try { p.reconnect(); } catch (e) { /* noop */ } later(retry, 4000); };
        later(retry, 1000);
      });
    }

    /* ----------------------------------- API ----------------------------------- */
    const api = {
      get peer() { return peer; },
      hostPeerId,
      makeAction(name) {
        if (!actions.has(name)) actions.set(name, { callback: null });
        const item = actions.get(name);
        return {
          send(data, opts = {}) {
            const target = opts && opts.target || null;
            const metadata = opts && opts.metadata || null;
            const payload = b64enc(data);
            if (role === 'host') {
              const frame = { [SYS]: 'data', origin: selfId, action: name, data: payload, metadata };
              if (target) sendFrame(channels.get(target), frame);
              else for (const [pid, conn] of channels) if (pid !== selfId && !conn._orbitVirtual) sendFrame(conn, frame);
            } else {
              sendFrame(hostChannel, { [SYS]: 'data', origin: selfId, action: name, data: payload, metadata, target });
            }
          },
          get onMessage() { return item.callback; },
          set onMessage(fn) { item.callback = fn; }
        };
      },
      getPeers() {
        const out = {};
        for (const [pid, conn] of channels) {
          const pc = conn && (conn.peerConnection || conn._peerConnection);
          out[pid] = pc || { connectionState: 'connected', iceConnectionState: conn && conn._relay ? 'relay' : 'connected', getStats: async () => new Map() };
        }
        return out;
      },
      ping(target) {
        const nonce = Math.random().toString(36).slice(2);
        return new Promise((res) => {
          const timer = setTimeout(() => { pings.delete(nonce); res(NaN); }, 2500);
          pings.set(nonce, (ms) => { clearTimeout(timer); res(ms); });
          if (role === 'host') sendFrame(channels.get(target), { [SYS]: 'ping', nonce, origin: selfId, at: Date.now() });
          else sendFrame(hostChannel, { [SYS]: 'ping', nonce, origin: selfId, target, at: Date.now() });
        });
      },
      /** Signaling socket + relay broker states, for the status line and diagnostics. */
      relayStates() {
        const names = ['connecting', 'open', 'closing', 'closed'];
        const out = [];
        try {
          const cur = peer || upgPeer;
          const sock = cur && cur.socket && cur.socket._socket;
          if (sock) out.push({ url: 'wss://0.peerjs.com:443/peerjs', state: names[sock.readyState] || 'unknown' });
        } catch (e) { /* noop */ }
        if (relayClient) out.push({ url: relayUrl, state: relayClient.state === 'open' ? 'open' : (relayClient.state === 'connecting' ? 'connecting' : 'closed') });
        return out;
      },
      leave() {
        if (closed) return;
        // A relay guest says goodbye so the host can drop the seat immediately instead of timing it out.
        const byeClient = (role === 'join' && transport === 'relay' && joined) ? relayClient : null;
        if (byeClient && relayCrypto) {
          const rc = relayCrypto; relayClient = null;
          rc.seal(JSON.stringify({ from: selfId, m: { [SYS]: 'bye' } })).then((bytes) => { byeClient.publish(rc.topic + '/h', bytes); setTimeout(() => { try { byeClient.end(); } catch (e) { /* noop */ } }, 250); }).catch(() => { try { byeClient.end(); } catch (e) { /* noop */ } });
        }
        closed = true;
        for (const t of timers) { clearTimeout(t); clearInterval(t); }
        timers.clear();
        for (const conn of channels.values()) { try { if (conn && !conn._orbitVirtual && !conn._relay) conn.close(); } catch (e) { /* noop */ } }
        channels.clear(); virtual.clear();
        stopRelay();
        for (const p of [peer, upgPeer]) { try { p && p.destroy(); } catch (e) { /* noop */ } }
      },
      // Why a join might be failing: used to give an actionable error instead of a generic one.
      diag() {
        const cur = peer || upgPeer;
        const pc = roomConn && (roomConn.peerConnection || roomConn._peerConnection);
        return {
          signalingOpen: !!(cur && cur.open),
          hostUnavailable,
          channelOpen: !!(hostChannel && hostChannel.open),
          iceState: pc ? (pc.iceConnectionState || '') : '',
          lastError: lastPeerErr,
          transport,
          relayReached,
          relayFailed,
          relayConnected: !!(relayClient && relayClient.state === 'open'),
          relayWhy
        };
      },
      get onTransportLost() { return true; },
      set onTransportLost(fn) { lostCb = fn; if (hostLost && fn && !hostLossDelivered) { hostLossDelivered = true; try { fn({ type: 'host' }); } catch (e) { /* noop */ } } },
      set onPeerJoin(fn) { joinCb = fn; for (const id of notified) { try { fn(id); } catch (e) { /* noop */ } } },
      get onPeerJoin() { return joinCb; },
      set onPeerLeave(fn) { leaveCb = fn; },
      get onPeerLeave() { return leaveCb; }
    };

    if (role === 'host') startHost();
    else { settled = true; resolve(api); startP2P(); }
  });
}
