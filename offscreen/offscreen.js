/* Orbit — offscreen document: ALL networking lives here.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────┐
 * │ HONESTY NOTE ABOUT CONNECTIVITY                                                      │
 * │ Peers connect directly with WebRTC data channels. Peer discovery ("signaling") uses  │
 * │ PeerJS Cloud (0.peerjs.com) brokers connection setup; the room creator stays online   │
 * │ and forwards room traffic. PeerJS is third-party infrastructure, not an Orbit server. │
 * │ NAT traversal uses public STUN servers. WITHOUT A TURN SERVER a small percentage of  │
 * │ strict corporate/school networks (symmetric NAT, UDP blocked) cannot form a direct   │
 * │ connection at all. If that happens, plug a TURN server into                          │
 * │ Settings → Advanced → ICE servers (or ORBIT.DEFAULT_ICE_SERVERS in shared/brand.js). │
 * │ WebRTC uses DTLS on each connection. Optional room passwords add Orbit AES-GCM        │
 * │ encryption; without a password, room members can read messages.                      │
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Room-keeper controls (rename title, soft-mute member) are BEST-EFFORT AND COOPERATIVE:
 * there is no server to enforce them. Every client independently computes the keeper as the
 * member with the earliest self-reported join time, and honours keeper messages only from
 * that peer. A modified client could ignore them. Treat them as etiquette tools, not security.
 */
import * as db from './db.js';
import {
  uuid, shortId, normalizeRoomName, deriveRoomId, deriveRoomKey, sha256Hex,
  sealJson, openJson, sealBytes, openBytes, dataUrlToBytes, bytesToDataUrl, blobToDataUrl
} from './crypto.js';
import { validateEnvelope, RateLimiter, MAX_CTL_BYTES, cleanText, IMAGE_MIMES, MAX_ASSET_BYTES } from './protocol.js';
import { playSound } from './sounds.js';
import { makeThumb, imageSize, sniffImageMime } from './images.js';

const { KEYS, DEFAULT_SETTINGS, DEFAULT_PROFILE, LIMITS, PROTOCOL_VERSION, APP_ID, BRAND_NAME } = globalThis.ORBIT;

const log = (...a) => console.debug('[Orbit/offscreen]', ...a);
const bytesToB64 = (bytes) => { let out = ''; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000))); return btoa(out); };
const b64ToBytes = (text) => { const raw = atob(text); const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// Some Chromium builds do not expose chrome.storage inside offscreen documents.
// Keep storage authoritative in the service worker and broker local-area calls there.
const storageChangeListeners = new Set();
function storageBroker(area, method, value) {
  return chrome.runtime.sendMessage({ target: 'sw', type: 'storage:broker', area, method, value });
}
const nativeStorage = globalThis.chrome && globalThis.chrome.storage;
const extensionStorage = {
  local: nativeStorage && nativeStorage.local ? nativeStorage.local : {
    get: (keys) => storageBroker('local', 'get', keys),
    set: (items) => storageBroker('local', 'set', items),
    clear: () => storageBroker('local', 'clear')
  },
  onChanged: nativeStorage && nativeStorage.onChanged ? nativeStorage.onChanged : {
    addListener(fn) { storageChangeListeners.add(fn); }
  }
};
function deliverStorageChange(changes, area) {
  for (const fn of Array.from(storageChangeListeners)) { try { fn(changes || {}, area || 'local'); } catch (e) { log('storage listener error', e); } }
}

/* ------------------------------------------------------------------ */
/* Global state                                                         */
/* ------------------------------------------------------------------ */
let settings = { ...DEFAULT_SETTINGS };
let profile = { ...DEFAULT_PROFILE };
let userId = null;
let roomsList = [];               // persisted list (extensionStorage.local.rooms)
const rooms = new Map();          // roomId -> Room (live)
const uis = new Map();            // portId -> { context, mode, roomId, open, visible }
let boss = false;
const strategyCache = {};

/* ------------------------------------------------------------------ */
/* Talking to the service worker                                        */
/* ------------------------------------------------------------------ */
async function toSw(msg) {
  try { return await chrome.runtime.sendMessage({ target: 'sw', ...msg }); } catch (e) { return null; }
}
function emit(event, opts = {}) { return toSw({ type: 'event', event, to: opts.to || null, scope: opts.scope || 'all' }); }
function emitPanel(event) { return emit(event, { scope: 'panel' }); }
function toast(text, kind = 'info') { return emitPanel({ type: 'toast', text, kind }); }

/* ------------------------------------------------------------------ */
/* Storage                                                              */
/* ------------------------------------------------------------------ */
async function loadStorage() {
  const r = await extensionStorage.local.get([KEYS.SETTINGS, KEYS.PROFILE, KEYS.USER_ID, KEYS.ROOMS]);
  settings = { ...DEFAULT_SETTINGS, ...(r[KEYS.SETTINGS] || {}), signaling: 'peerjs' };
  // Drop ICE servers that no longer exist (they stall candidate gathering); keep anything the user added.
  const cleanIce = sanitizeIce(settings.iceServers);
  const iceUpgraded = JSON.stringify(cleanIce) !== JSON.stringify(settings.iceServers);
  if (iceUpgraded) settings.iceServers = cleanIce;
  // One-time: add the default TURN relay for installs that only have STUN (needed on strict NATs).
  const iceMigrate = (r[KEYS.SETTINGS] || {}).iceV !== 3;
  if (iceMigrate) {
    const hasRelay = settings.iceServers.some((x) => [].concat(x.urls || []).some((u) => /^turns?:/i.test(String(u))));
    if (!hasRelay) settings.iceServers = settings.iceServers.concat(DEFAULT_SETTINGS.iceServers.filter((x) => x.restSecret));
    settings.iceV = 3;
  }
  profile = { ...DEFAULT_PROFILE, ...(r[KEYS.PROFILE] || {}) };
  userId = r[KEYS.USER_ID];
  roomsList = Array.isArray(r[KEYS.ROOMS]) ? r[KEYS.ROOMS] : [];
  if ((r[KEYS.SETTINGS] || {}).signaling !== 'peerjs' || iceUpgraded || iceMigrate) await extensionStorage.local.set({ [KEYS.SETTINGS]: settings });
  if (!userId) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    userId = 'u' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    await extensionStorage.local.set({ [KEYS.USER_ID]: userId });
  }
}

let roomsWriteChain = Promise.resolve();
function saveRoomsList() {
  roomsWriteChain = roomsWriteChain.then(() => extensionStorage.local.set({ [KEYS.ROOMS]: roomsList })).catch(() => {});
  return roomsWriteChain;
}
function roomEntry(id) { return roomsList.find((r) => r.id === id); }
function upsertRoomEntry(id, patch) {
  let e = roomEntry(id);
  if (!e) { e = { id, name: '', title: '', pinned: false, lastJoined: now(), active: false, password: null, muteUntil: 0, shareHistory: settings.shareHistoryDefault, nick: '', background: null }; roomsList.unshift(e); }
  Object.assign(e, patch);
  saveRoomsList();
  return e;
}

if (extensionStorage.onChanged && typeof extensionStorage.onChanged.addListener === 'function') extensionStorage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[KEYS.SETTINGS]) {
    const prev = settings;
    settings = { ...DEFAULT_SETTINGS, ...(changes[KEYS.SETTINGS].newValue || {}), signaling: 'peerjs' };
    const netChanged = JSON.stringify(prev.iceServers) !== JSON.stringify(settings.iceServers) || prev.signaling !== settings.signaling;
    if (netChanged) { log('network settings changed → reconnecting'); for (const r of rooms.values()) r.reconnect('settings'); }
    if (prev.imageCacheMB !== settings.imageCacheMB) db.pruneImages(settings.imageCacheMB * 1024 * 1024).catch(() => {});
    pushBadge();
  }
  if (changes[KEYS.PROFILE]) {
    profile = { ...DEFAULT_PROFILE, ...(changes[KEYS.PROFILE].newValue || {}) };
    for (const r of rooms.values()) { r.broadcastPresence(); r.scheduleUpdate(); }
  }
  if (changes[KEYS.ROOMS]) {
    const next = Array.isArray(changes[KEYS.ROOMS].newValue) ? changes[KEYS.ROOMS].newValue : [];
    // Only accept external edits (UI pin/unpin/mute etc.); keep our object identity in sync.
    roomsList = next;
    for (const r of rooms.values()) r.scheduleUpdate();
    pushBadge();
  }
});

/* ------------------------------------------------------------------ */
/* Strategy loading (vendored Trystero bundles, lazy)                  */
/* ------------------------------------------------------------------ */
async function loadStrategy(name) {
  if (name === 'peerjs') { if (!strategyCache.peerjs) strategyCache.peerjs = import('./peerjs-room.js'); return strategyCache.peerjs; }
  const file = { nostr: 'trystero-nostr.js', mqtt: 'trystero-mqtt.js', torrent: 'trystero-torrent.js' }[name] || 'trystero-nostr.js';
  if (!strategyCache[file]) strategyCache[file] = import(new URL('../lib/' + file, import.meta.url).href);
  return strategyCache[file];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */
function myName(room) {
  const e = room && roomEntry(room.id);
  return cleanText((e && e.nick) || profile.name || 'Someone', LIMITS.MAX_NAME_CHARS) || 'Someone';
}
function myPresencePayload(room) {
  const a = profile.avatar || DEFAULT_PROFILE.avatar;
  return {
    name: myName(room),
    roomName: cleanText(room && room.name || '', 40),
    avatar: { type: a.type || 'generated', variant: a.variant | 0, emoji: a.emoji || '', dataUrl: a.type === 'image' ? (a.dataUrl || '') : '' },
    banner: String(profile.banner || ''),
    status: cleanText(profile.status || '', LIMITS.MAX_STATUS_CHARS),
    presence: profile.presence === 'invisible' ? 'invisible' : (profile.presence || 'online'),
    nameColor: /^#[0-9a-fA-F]{6}$/.test(profile.nameColor || '') ? profile.nameColor : '',
    joinedAt: room ? room.joinedAt : now(),
    proto: PROTOCOL_VERSION
  };
}
function isRoomViewed(roomId) {
  for (const u of uis.values()) if (u.roomId === roomId && u.open && u.visible) return true;
  return false;
}
function isRoomMuted(roomId) {
  const e = roomEntry(roomId);
  if (!e || !e.muteUntil) return false;
  return e.muteUntil === -1 || e.muteUntil > now();
}
function isUserMuted(uid) { return Array.isArray(settings.mutedUsers) && settings.mutedUsers.includes(uid); }
function isQuietNow() {
  const d = settings.dndSchedule;
  if (!d || !d.enabled) return false;
  const toMin = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const dt = new Date(); const cur = dt.getHours() * 60 + dt.getMinutes();
  const a = toMin(d.start), b = toMin(d.end);
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}
function compareMsg(a, b) { return a.ts - b.ts || (a.senderId < b.senderId ? -1 : a.senderId > b.senderId ? 1 : 0) || (a.id < b.id ? -1 : 1); }
function snippet(m) {
  if (!m) return '';
  if (m.deleted) return '(deleted)';
  if (m.text) return m.text.replace(/\s+/g, ' ').slice(0, 120);
  if (m.images && m.images.length) return m.sticker ? '🩵 sticker' : `📷 ${m.images.length > 1 ? m.images.length + ' images' : 'image'}`;
  if (m.poll) return `📊 ${m.poll.question}`;
  if (m.attachments && m.attachments.length) { const a0 = m.attachments[0]; return a0.kind === 'audio' ? '🎤 Voice message' : /^video\//.test(a0.mime || '') ? `🎬 ${a0.name}` : /^image\//.test(a0.mime || '') ? `🖼 ${a0.name}` : `📎 ${a0.name}`; }
  return '';
}

let badgeTimer = null;
function pushBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    let total = 0;
    for (const r of rooms.values()) if (!isRoomMuted(r.id)) total += r.unread;
    toSw({ type: 'badge', count: boss ? 0 : total });
  }, 80);
}

let dotTimer = null;
function pushDot() {
  clearTimeout(dotTimer);
  dotTimer = setTimeout(() => emit({ type: 'dot', ...dotState() }), 120);
}
function dotState() {
  let unread = 0, latest = null, status = 'none';
  for (const r of rooms.values()) {
    if (!isRoomMuted(r.id)) unread += r.unread;
    if (r.lastMsg && (!latest || r.lastMsg.ts > latest.ts)) latest = { ...r.lastMsg, roomId: r.id, roomName: r.title || r.name };
    if (r.status === 'connected') status = 'connected';
    else if (status !== 'connected' && r.status !== 'full') status = 'connecting';
  }
  return { unread, latest, status, rooms: rooms.size };
}

/* ------------------------------------------------------------------ */
/* Room                                                                 */
/* ------------------------------------------------------------------ */
export class Room {
  constructor({ id, name, code, password, key, sdpPassword, isHost = false }) {
    this.id = id; this.name = name; this.code = code || ''; this.isHost = !!isHost; this.idTaken = false; this.password = password || null; this.key = key || null; this.sdpPassword = sdpPassword;
    this.joinedAt = now();
    this.tRoom = null; this.ctl = null; this.chunk = null; this.mod = null;
    this.peers = new Map();       // transportId -> peer
    this.messages = [];           // in-memory cache (sorted), max 400
    this.byId = new Map();
    this.known = new Set();       // message ids we have seen (dedupe)
    this.outbox = new Map();      // env.id -> { env, pending:Set<userId>, needsAnyone, createdAt }
    this.typing = new Map();      // userId -> { name, until }
    this.seenPointers = new Map();// userId -> { msgId, ts }
    this.mutedByKeeper = new Set();
    this.unread = 0; this.lastMsg = null;
    this.status = 'connecting'; this.everConnected = false; this.lastPeerAt = 0;
    this.history = { requestedFrom: null, requestedAt: 0, done: false };
    this.incoming = new Map();    // imageId -> transfer state
    this.incomingAssets = new Map();
    this.pendingAssetUploads = new Map();
    this.ackWaiters = new Map();  // imageId|transportId -> fn(upTo, done)
    this.imageBytes = new Map();  // imageId -> { bytes, at }
    this.limiter = new RateLimiter(40, 8);
    this.ackQueue = new Map();    // transportId -> Set<ids>
    this.ackTimer = null; this.updateTimer = null; this.statusTimer = null;
    this.reconnectAttempts = 0; this.reconnectTimer = null; this.dead = false; this.full = false;
    this.lastJoinAnnounce = new Map(); // userId -> ts
    this.transportHostId = ''; this.handoffInProgress = false; this.handoffTimer = null; this.handoffRetry = 0; this.handoffAudience = []; this.handoffNoticeSent = false; this.hostConfirmed = false;
    this.msgUpdateTimers = new Map();
    // Re-entry / recovery state. A room whose owner restarts the browser (or whose members all leave and
    // come back) has to reclaim its five-letter code from the PeerJS matchmaker, which may still hold the
    // old session for a while. See connect() / claimCode() / tickStatus().
    this.claiming = false; this.claimUntil = 0; this.idTakenRetries = 0;
    this.screen = null;           // active screen share (see "Screen sharing" below)
    this.screenView = null;       // incoming screen share we are watching
  }

  /** True when this device is allowed to take the room's code back: it created the room (the saved entry
   *  says host) or it is already hosting it, and it is asking for the host role right now. A brand-new
   *  room that collides with somebody else's code must NOT enter the claim loop — createRoom picks
   *  another code instead — hence the entry/claimUntil requirement. */
  canClaim() {
    if (!this.isHost || !this.code) return false;
    if (this.claimUntil > now()) return true;
    const e = roomEntry(this.id);
    return !!(e && e.host);
  }

  get title() { const e = roomEntry(this.id); return (e && e.title) || ''; }
  get shareHistory() { const e = roomEntry(this.id); return e ? e.shareHistory !== false : true; }

  /* ---------- lifecycle ---------- */
  async loadHistory() {
    const list = await db.getRoomMessages(this.id, { limit: 300 });
    const repaired = [];
    for (const m of list) {
      let changed = false;
      for (const a of m.attachments || []) {
        let cachedAsset = null; try { cachedAsset = await db.getAsset(a.id); } catch (e) { /* missing asset cache */ }
        const state = cachedAsset && cachedAsset.roomId === this.id ? 'ready' : 'missing';
        if (a.state !== state) { a.state = state; a.progress = state === 'ready' ? 1 : 0; changed = true; }
      }
      for (const im of m.images || []) {
        if (!['pending', 'receiving', 'sending'].includes(im.state)) continue;
        let cached = null;
        try { cached = await db.getImage(im.id); } catch (e) { /* treat unreadable cache as missing */ }
        im.state = cached ? 'ready' : 'missing';
        im.progress = cached ? 1 : 0;
        changed = true;
      }
      if (changed) repaired.push(m);
      this.messages.push(m); this.byId.set(m.id, m); this.known.add(m.id);
    }
    if (repaired.length) db.putMessages(repaired).catch(() => {});
    try { const seen = await db.getMeta('seen:' + this.id); if (seen && typeof seen === 'object') this.seenPointers = new Map(Object.entries(seen)); } catch (e) { /* optional local read receipts */ }
    try { for (const inc of await db.getPartialImages(this.id)) { if (this.byId.has(inc.msgId) && Array.isArray(inc.parts)) this.incoming.set(inc.imageId, { ...inc, from: null, updatedAt: now() }); } } catch (e) { log('partial image restore failed', e); }
    try { for (const inc of await db.getPartialAssets(this.id)) { if (this.byId.has(inc.msgId) && Array.isArray(inc.parts)) this.incomingAssets.set(inc.assetId, { ...inc, from: null, updatedAt: now() }); } } catch (e) { log('partial attachment restore failed', e); }
    this.lastMsg = list.length ? { senderName: list[list.length - 1].senderName, text: snippet(list[list.length - 1]), ts: list[list.length - 1].ts } : null;
    // Rebuild the delivery outbox: plain text messages of ours that nobody acknowledged yet. They used to
    // be lost when the browser closed (and their bubble stayed on “sending” forever); now the next member
    // who greets us receives them, exactly like a message written while the room was empty.
    let revived = 0;
    for (let i = this.messages.length - 1; i >= 0 && revived < 50; i--) {
      const m = this.messages[i];
      if (m.senderId !== userId || m.deleted || m.status === 'acked') continue;
      if (m.kind === 'system' || m.kind === 'handoff' || m.fromHistory) continue;
      if ((m.images && m.images.length) || (m.attachments && m.attachments.length) || m.poll) continue;
      if (!m.text || !m.text.trim()) continue;
      const env = { v: PROTOCOL_VERSION, type: 'chat', id: m.id, roomId: this.id, senderId: userId, ts: m.ts,
        payload: { text: m.text, kind: m.kind === 'me' ? 'me' : 'chat', seq: m.seq || 0, mentions: m.mentions && m.mentions.length ? m.mentions : undefined, replyTo: m.replyTo || undefined } };
      this.outbox.set(m.id, { env, pending: new Set(), needsAnyone: true, createdAt: now() });
      revived++;
    }
    if (revived) log('outbox restored from history', revived);
    this.completeHandoffIfSeen();
  }

  async connect() {
    if (this.dead) return;
    try {
      const usePeerJs = !!this.code;
      this.mod = await loadStrategy(usePeerJs ? 'peerjs' : (settings.signaling === 'peerjs' ? 'nostr' : settings.signaling));
      const config = {
        appId: APP_ID,
        rtcConfig: { iceServers: await resolveIce(settings.iceServers) },
        relayConfig: { warnOnRelayFailure: false }
      };
      if (this.sdpPassword) config.password = this.sdpPassword;
      this.tRoom = usePeerJs
        ? await this.mod.joinRoom(config, this.code, { role: this.isHost ? 'host' : 'join' })
        : this.mod.joinRoom(config, this.id, { onJoinError: (d) => this.onJoinError(d) });
      this.ctl = this.tRoom.makeAction('ctl');
      this.chunk = this.tRoom.makeAction('chunk');
      this.vchunk = this.tRoom.makeAction('lvchunk');   // live screen-share segments (see “Screen sharing”)
      this.vack = this.tRoom.makeAction('lvack');       // viewer credits for those segments
      this.ctl.onMessage = (data, { peerId }) => { this.onCtl(data, peerId).catch((e) => log('ctl error', e)); };
      this.chunk.onMessage = (data, { peerId, metadata }) => { this.onChunk(data, peerId, metadata).catch((e) => log('chunk error', e)); };
      this.vchunk.onMessage = (data, { peerId, metadata }) => { try { this.onLvChunk(data, peerId, metadata); } catch (e) { log('lvchunk error', e); } };
      this.vack.onMessage = (data, { peerId }) => { try { this.onLvAck(data, peerId); } catch (e) { log('lvack error', e); } };
      this.tRoom.onPeerJoin = (peerId) => this.onPeerJoin(peerId);
      this.tRoom.onPeerLeave = (peerId) => this.onPeerLeave(peerId);
      this.transportHostId = this.tRoom.hostPeerId || '';
      if (this.tRoom.onTransportLost) this.tRoom.onTransportLost = (info) => { if (this.dead) return; if (info && info.type === 'host' && !this.isHost) this.handleHostLost(); else if (info && info.type === 'signal' && this.isHost) this.reconnect('PeerJS signaling lost'); };
      this.status = this.everConnected ? 'reconnecting' : 'connecting';
      this.connectStartedAt = now();
      clearInterval(this.statusTimer);
      this.statusTimer = setInterval(() => this.tickStatus(), 3000);
      // We hold the code again (or we never lost it). Make sure the saved entry keeps saying so, so the
      // next browser restart knows it may claim this code instead of joining somebody else's host.
      this.claiming = false; this.claimUntil = 0; this.idTakenRetries = 0;
      if (this.isHost) { const e = roomEntry(this.id); if (e && !e.host) upsertRoomEntry(this.id, { host: true, active: true, code: this.code, lastJoined: now() }); }
      this.scheduleUpdate();
      this.tickStatus();
    } catch (e) {
      log('connect failed', e);
      this.lastError = String(e && e.message || e);
      const unavailable = !!(e && e.code === 'unavailable-id');
      // Our own code is still held by a previous session of ours (browser restart, crash, sleeping laptop)
      // or by a member who took the room over. Ask for it again — never give the room up on our own.
      if (unavailable && this.isHost && this.canClaim()) return this.claimCode();
      if (unavailable) {
        this.idTaken = true; this.status = 'error'; this.scheduleUpdate();
        if (this.isHost && this.everConnected && !this.handoffInProgress) { this.isHost = false; this.handoffInProgress = true; this.handoffCandidate = userId; this.hostConfirmed = false; this.scheduleHandoffRetry(); }
        else this.scheduleReconnect();
        return;
      }
      this.status = 'error';
      this.scheduleUpdate();
      if (this.handoffInProgress) this.scheduleHandoffRetry(); else this.scheduleReconnect();
    }
  }

  /** Keep asking the matchmaker for a code we own. Only one peer can hold a PeerJS id, so retrying can
   *  never produce two hosts; after the window expires we check once whether somebody else is hosting it. */
  async claimCode() {
    if (this.dead) return;
    const CLAIM_WINDOW = 6 * 60000;      // keep asking for up to six minutes (the server frees stale ids first)
    this.claimUntil = this.claimUntil || (now() + CLAIM_WINDOW);
    this.idTakenRetries = (this.idTakenRetries || 0) + 1;
    this.idTaken = false;
    if (now() < this.claimUntil) {
      this.claiming = true; this.status = 'claiming';
      this.lastError = `Room code ${String(this.code).toUpperCase()} is still held by your previous session — reclaiming it…`;
      this.scheduleUpdate();
      clearTimeout(this.reconnectTimer);
      const delay = Math.min(15000, 4000 + this.idTakenRetries * 1000);
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.reconnect('reclaiming room code'); }, delay);
      return;
    }
    // Claim window over: if a live host really is on this code, join them instead of fighting for it.
    this.claiming = false;
    const found = await this.probeForHost();
    if (this.dead) return;
    if (!found) {
      // Nobody answered: the reservation is stale or we are offline. Keep trying quietly in the background.
      this.claimUntil = now() + 60000;
      this.idTakenRetries = 0;
      this.isHost = true;
      this.lastError = 'Room code is still reserved — retrying.';
      this.scheduleReconnect();
    }
  }

  /** Try to reach a host on this code as an ordinary guest (used when our own claim is refused). */
  async probeForHost() {
    if (this.dead) return false;
    log('probing for an existing host', this.name);
    this.isHost = false;
    await this.reconnect('probe for an existing host');
    const deadline = now() + 32000;
    while (!this.dead && now() < deadline) {
      if (Array.from(this.peers.values()).some((p) => p.userId)) return true;   // verified Orbit hello from the host
      let d = null; try { d = this.tRoom && this.tRoom.diag ? this.tRoom.diag() : null; } catch (err) { d = null; }
      if (d && (d.hostUnavailable || d.relayFailed)) break;                    // nothing there (or relay exhausted)
      await sleep(250);
    }
    return false;
  }

  handleHostLost() {
    if (this.dead || !this.code || this.isHost) return;
    if (this.handoffInProgress) { this.scheduleHandoffRetry(); return; }
    this.handoffInProgress = true;
    const others = new Map();
    for (const p of this.peers.values()) if (p.userId && p.userId !== userId && p.transportId !== this.transportHostId) others.set(p.userId, p.userId);
    this.handoffAudience = Array.from(others.keys()).slice(0, LIMITS.MAX_ROOM_MEMBERS);
    const elected = [userId, ...this.handoffAudience].sort()[0];
    this.handoffCandidate = elected; this.hostConfirmed = false;
    this.status = 'reconnecting';
    this.scheduleUpdate();
    this.handoffTimer = setTimeout(() => {
      this.handoffTimer = null;
      if (elected === userId) this.tryHostTakeover();
      else this.reconnect('waiting for elected host');
    }, elected === userId ? 1800 : 2400);
  }

  scheduleHandoffRetry() {
    if (this.dead || this.handoffTimer) return;
    this.handoffTimer = setTimeout(() => {
      this.handoffTimer = null;
      if (this.dead || !this.handoffInProgress || this.hostConfirmed) return;
      if (this.isHost) { this.isHost = false; this.reconnect('probe for recovered host'); }
      else if (this.handoffCandidate === userId) this.tryHostTakeover();
      else this.reconnect('retry elected host connection');
    }, Math.min(12000, 2500 + this.handoffRetry++ * 1000));
  }

  async tryHostTakeover() {
    if (this.dead || this.hostConfirmed) return;
    this.handoffCandidate = userId;
    this.isHost = true;
    this.idTaken = false;
    await this.reconnect('automatic host handoff');
    if (this.dead) return;
    if (this.idTaken) {
      // A returning former host may have reclaimed the deterministic PeerJS room ID.
      // Probe it as a guest before retrying the election, avoiding a second room owner.
      this.isHost = false; this.idTaken = false; upsertRoomEntry(this.id, { host: false, active: true });
      await this.reconnect('probe room host after handoff collision');
      this.scheduleHandoffRetry();
      return;
    }
    if (this.isHost && !this.handoffNoticeSent) {
      this.handoffInProgress = false; clearTimeout(this.handoffTimer); this.handoffTimer = null;
      this.handoffNoticeSent = true;
      upsertRoomEntry(this.id, { host: true, active: true, code: this.code, lastJoined: now() });
      await this.sendChat({ text: '@everyone · the room host changed automatically; the conversation continues here.', kind: 'handoff', handoffAudience: this.handoffAudience });
    } else if (this.isHost) { this.handoffInProgress = false; }
    if (!this.isHost) this.scheduleHandoffRetry();
  }

  completeHandoffIfSeen() {
    for (const msg of [...this.messages]) {
      if (msg.kind !== 'handoff' || !msg.handoffAudience || !msg.handoffAudience.length) continue;
      const allSeen = msg.handoffAudience.every((uid) => {
        if (uid === msg.senderId) return true;
        const pointer = this.seenPointers.get(uid);
        return !!pointer && pointer.ts >= msg.ts;
      });
      if (!allSeen) continue;
      this.messages = this.messages.filter((m) => m.id !== msg.id);
      this.byId.delete(msg.id);
      db.deleteMessage(msg.id).catch(() => {});
      emitPanel({ type: 'msg:remove', roomId: this.id, msgId: msg.id });
    }
  }

  onJoinError(d) {
    log('join error', d && d.error);
    this.lastError = d && d.error;
  }

  relayStates() {
    try {
      if (this.code && this.tRoom && typeof this.tRoom.relayStates === 'function') return this.tRoom.relayStates();
      const peerSocket = this.tRoom && this.tRoom.peer && this.tRoom.peer.socket && this.tRoom.peer.socket._socket;
      if (this.code && peerSocket) return [{ url: 'wss://0.peerjs.com:443/peerjs', state: ['connecting', 'open', 'closing', 'closed'][peerSocket.readyState] || 'unknown' }];
      const sockets = this.mod && this.mod.getRelaySockets ? this.mod.getRelaySockets() : {};
      return Object.entries(sockets).map(([url, ws]) => ({ url, state: ['connecting', 'open', 'closing', 'closed'][ws.readyState] || 'unknown' }));
    } catch (e) { return []; }
  }

  tickStatus() {
    if (this.dead) return;
    const prev = this.status;
    const peerCount = this.peers.size;
    const relays = this.relayStates();
    const anyOpen = relays.some((r) => r.state === 'open');
    if (this.full) this.status = 'full';
    else if (peerCount > 0) { this.status = 'connected'; this.everConnected = true; this.lastPeerAt = now(); this.reconnectAttempts = 0; }
    else if (this.claiming) this.status = 'claiming';
    else if (!navigator.onLine) this.status = 'offline';
    else if (anyOpen) this.status = 'waiting';
    else this.status = this.everConnected ? 'reconnecting' : 'connecting';
    // Watchdog: no relay reachable for 45s → rejoin with backoff
    if (!anyOpen && navigator.onLine && now() - (this.connectStartedAt || 0) > 45000 && !this.reconnectTimer) {
      log('watchdog: relays unreachable, rejoining', this.name);
      this.scheduleReconnect();
    }
    // Recovery watchdog: a guest whose transport has given up (host not on the matchmaker and no relay
    // broker answered) would otherwise sit on “Connecting…” forever once everyone left and came back.
    // Retry with the normal backoff instead of waiting for the user to leave and rejoin by hand.
    if (!this.isHost && this.tRoom && !peerCount && !this.full && !this.reconnectTimer && now() - (this.connectStartedAt || 0) > 15000) {
      let d = null; try { d = this.tRoom.diag ? this.tRoom.diag() : null; } catch (err) { d = null; }
      if (d && !d.channelOpen && (d.relayFailed || d.hostUnavailable)) {
        log('watchdog: transport gave up, retrying', this.name, d.transport || '');
        this.scheduleReconnect();
      }
    }
    if (this.screen) this.screenTick();
    // expire typing indicators
    let typingChanged = false;
    for (const [uid, t] of this.typing) if (t.until < now()) { this.typing.delete(uid); typingChanged = true; }
    // GC outgoing image bytes cache
    for (const [id, rec] of this.imageBytes) if (now() - rec.at > 10 * 60000) this.imageBytes.delete(id);
    // GC dedupe set (keeps insertion order → drop oldest)
    if (this.known.size > 12000) { let n = this.known.size - 8000; for (const k of this.known) { if (n-- <= 0) break; this.known.delete(k); } }
    // GC outbox (24h)
    for (const [id, o] of this.outbox) if (now() - o.createdAt > 24 * 3600e3) this.outbox.delete(id);
    // stale incoming transfers (60s without a chunk)
    for (const [id, inc] of this.incoming) if (inc.from && now() - inc.updatedAt > 60000) { inc.from = null; this.setImageState(inc.msgId, id, 'missing', inc.received / inc.chunks); }
    if (prev !== this.status || typingChanged) { this.scheduleUpdate(); pushDot(); }
  }

  scheduleReconnect() {
    if (this.dead || this.reconnectTimer) return;
    const delay = Math.min(60000, 1000 * Math.pow(2, this.reconnectAttempts++)) + Math.random() * 500;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.reconnect('watchdog'); }, delay);
  }

  async reconnect(reason) {
    if (this.dead) return;
    log('reconnect', this.name, reason);
    await this.teardownTransport();
    await sleep(200);
    await this.connect();
  }

  async teardownTransport() {
    clearInterval(this.statusTimer);
    // A screen share cannot survive a transport swap (new data channels, new peers): stop it cleanly so the
    // publisher's panel stops capturing and viewers see a proper end instead of a frozen frame.
    if (this.screen) { this.screen = null; emitPanel({ type: 'screen:stop', roomId: this.id, reason: 'transport', mine: true }); }
    if (this.remoteScreen || this.screenView) { this.remoteScreen = null; this.screenView = null; emitPanel({ type: 'screen:stop', roomId: this.id, reason: 'transport', mine: false }); }
    const t = this.tRoom; this.tRoom = null; this.ctl = null; this.chunk = null; this.vchunk = null; this.vack = null;
    for (const p of this.peers.keys()) this.limiter.forget(p);
    this.peers.clear(); this.ackQueue.clear();
    for (const inc of this.incoming.values()) inc.from = null;
    for (const inc of this.incomingAssets.values()) inc.from = null;
    for (const fn of this.ackWaiters.values()) fn(-1, false, true);
    this.ackWaiters.clear();
    if (t) { try { await t.leave(); } catch (e) { /* ignore */ } }
  }

  async leave() {
    this.dead = true;
    clearTimeout(this.reconnectTimer); clearTimeout(this.updateTimer); clearTimeout(this.ackTimer);
    await this.teardownTransport();
  }

  /* ---------- peers ---------- */
  onPeerJoin(transportId) {
    if (this.dead) return;
    const peer = { transportId, userId: null, profile: null, joinedAt: 0, connectedAt: now(), lastSeen: now(), rtt: null, helloSent: 0 };
    this.peers.set(transportId, peer);
    this.sendHello(transportId);
    // If their hello never arrives (race at channel open), send ours again once.
    setTimeout(() => { const p = this.peers.get(transportId); if (p && !p.userId) this.sendHello(transportId); }, 3000);
    this.tickStatus();
  }

  onPeerLeave(transportId) {
    const peer = this.peers.get(transportId);
    this.peers.delete(transportId);
    this.limiter.forget(transportId);
    for (const [k, fn] of this.ackWaiters) if (k.endsWith('|' + transportId)) { fn(-1, false, true); this.ackWaiters.delete(k); }
    for (const [id, inc] of this.incoming) if (inc.from === transportId) { inc.from = null; this.setImageState(inc.msgId, id, 'missing', inc.received / inc.chunks); }
    for (const inc of this.incomingAssets.values()) if (inc.from === transportId) { inc.from = null; this.setAttachmentState(inc.msgId, inc.assetId, 'missing', inc.received / inc.chunks); }
    if (peer && peer.userId && !this.transportsFor(peer.userId).length) {
      this.typing.delete(peer.userId);
      this.systemMessage(`${peer.profile ? peer.profile.name : 'Someone'} left`);
    }
    this.tickStatus();
    this.scheduleUpdate();
  }

  transportsFor(uid) { return Array.from(this.peers.values()).filter((p) => p.userId === uid).map((p) => p.transportId); }
  members() {
    const map = new Map();
    for (const p of this.peers.values()) {
      if (!p.userId || !p.profile) continue;
      const m = map.get(p.userId);
      if (!m) map.set(p.userId, { userId: p.userId, ...p.profile, joinedAt: p.joinedAt, isSelf: false, transports: 1, rtt: p.rtt, mutedByKeeper: this.mutedByKeeper.has(p.userId) });
      else { m.transports++; }
    }
    return map;
  }
  keeperId() {
    let best = { userId, joinedAt: this.joinedAt };
    for (const m of this.members().values()) {
      if (m.presence === 'invisible') continue;
      if (m.joinedAt < best.joinedAt || (m.joinedAt === best.joinedAt && m.userId < best.userId)) best = m;
    }
    return best.userId;
  }

  /* ---------- sending primitives ---------- */
  makeEnv(type, payload, id) {
    return { v: PROTOCOL_VERSION, type, id: id || uuid(), roomId: this.id, senderId: userId, ts: now(), payload };
  }
  async sendEnv(env, target) {
    if (!this.ctl || this.dead) return false;
    try {
      const bytes = await sealJson(this.key, env);
      if (target) { if (!this.peers.has(target)) return false; await this.ctl.send(bytes, { target }); }
      else { if (!this.peers.size) return false; await this.ctl.send(bytes); }
      return true;
    } catch (e) { log('send failed', env.type, e && e.message); return false; }
  }
  sendHello(transportId) {
    const p = this.peers.get(transportId); if (p) p.helloSent = now();
    return this.sendEnv(this.makeEnv('hello', myPresencePayload(this)), transportId);
  }
  broadcastPresence() { if (this.peers.size) this.sendEnv(this.makeEnv('presence', myPresencePayload(this))); }

  /** Durable send: tracked in the outbox until every intended recipient acks. */
  async sendDurable(env) {
    const pending = new Set();
    for (const p of this.peers.values()) if (p.userId) pending.add(p.userId);
    this.outbox.set(env.id, { env, pending, needsAnyone: pending.size === 0, createdAt: now() });
    if (pending.size) await this.sendEnv(env);
    return pending.size;
  }

  queueAck(transportId, id) {
    if (!this.ackQueue.has(transportId)) this.ackQueue.set(transportId, new Set());
    this.ackQueue.get(transportId).add(id);
    if (!this.ackTimer) this.ackTimer = setTimeout(() => this.flushAcks(), 250);
  }
  flushAcks() {
    this.ackTimer = null;
    for (const [t, ids] of this.ackQueue) {
      this.ackQueue.delete(t);
      const arr = Array.from(ids);
      for (let i = 0; i < arr.length; i += 200) this.sendEnv(this.makeEnv('ack', { ids: arr.slice(i, i + 200) }), t);
    }
  }

  /* ---------- receiving ---------- */
  async onCtl(data, transportId) {
    if (this.dead) return;
    const peer = this.peers.get(transportId);
    if (!peer) return;
    if (!this.limiter.allow(transportId)) return;
    const raw = data instanceof ArrayBuffer ? new Uint8Array(data) : (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null);
    if (!raw || raw.length > MAX_CTL_BYTES) return;
    let env;
    try { env = await openJson(this.key, raw, MAX_CTL_BYTES); } catch (e) { return; } // wrong key / garbage → drop silently
    const reason = validateEnvelope(env, { roomId: this.id, maxImageBytes: settings.maxImageMB * 1024 * 1024, maxAssetBytes: MAX_ASSET_BYTES });
    if (reason) { log('dropped', env && env.type, reason); return; }
    peer.lastSeen = now();

    if (env.type === 'hello' || env.type === 'presence') return this.onHello(env, peer, env.type === 'hello');
    // Everything below requires an identified peer, and the envelope sender must match it.
    if (!peer.userId || env.senderId !== peer.userId) return;
    if (this.mutedByKeeper.has(peer.userId) && ['chat', 'edit', 'reaction', 'poll-vote'].includes(env.type)) { this.queueAck(peer.transportId, env.id); return; }

    switch (env.type) {
      case 'chat': return this.onChat(env, peer);
      case 'edit': return this.onEdit(env, peer);
      case 'delete': return this.onDelete(env, peer);
      case 'reaction': return this.onReaction(env, peer);
      case 'pin': return this.onPin(env, peer);
      case 'poll-vote': return this.onPollVote(env, peer);
      case 'poll-close': return this.onPollClose(env, peer);
      case 'asset-meta': return this.onAssetMeta(env, peer);
      case 'asset-ack': return this.onAssetAck(env, peer);
      case 'asset-request': return this.onAssetRequest(env, peer);
      case 'typing': return this.onTyping(env, peer);
      case 'seen': return this.onSeen(env, peer);
      case 'ack': return this.onAck(env, peer);
      case 'history-offer': return this.onHistoryOffer(env, peer);
      case 'history-request': return this.onHistoryRequest(env, peer);
      case 'history-batch': return this.onHistoryBatch(env, peer);
      case 'image-meta': return this.onImageMeta(env, peer);
      case 'image-ack': return this.onImageAck(env, peer);
      case 'image-request': return this.onImageRequest(env, peer);
      case 'room-title': return this.onRoomTitle(env, peer);
      case 'room-mute': return this.onRoomMute(env, peer);
      case 'screen': return this.onScreen(env, peer);
      default: return;
    }
  }

  onHello(env, peer, isHello) {
    const p = env.payload;
    const firstTime = !peer.userId;
    peer.userId = env.senderId;
    peer.profile = { name: cleanText(p.name, LIMITS.MAX_NAME_CHARS) || 'Someone', avatar: p.avatar, banner: p.banner || '', status: cleanText(p.status || '', LIMITS.MAX_STATUS_CHARS), presence: p.presence, nameColor: p.nameColor || '' };
    if (p.roomName) { const e = roomEntry(this.id); if (!e || !e.name || normalizeRoomCode(e.name)) { this.name = cleanText(p.roomName, 40); upsertRoomEntry(this.id, { name: this.name }); } }
    peer.joinedAt = typeof p.joinedAt === 'number' ? p.joinedAt : now();
    // A verified hello from whoever holds the room's code: it is not us. Only now is it safe to save
    // “this device is not the host” — a timeout or a refused claim is just a stale reservation, and
    // demoting ourselves then is what used to strand a whole group with no host at all.
    if (!this.isHost && peer.transportId === this.transportHostId) {
      this.hostConfirmed = true;
      if (this.handoffInProgress) { this.handoffInProgress = false; clearTimeout(this.handoffTimer); this.handoffTimer = null; this.handoffRetry = 0; }
      const e = roomEntry(this.id);
      if (e && e.host) upsertRoomEntry(this.id, { host: false, active: true });
    }
    if (isHello && firstTime) {
      if (!peer.helloSent) this.sendHello(peer.transportId);
      // Announce join (debounced per user, quiet on quick reconnects)
      const last = this.lastJoinAnnounce.get(peer.userId) || 0;
      if (now() - last > 60000 && peer.profile.presence !== 'invisible') this.systemMessage(`${peer.profile.name} joined`);
      this.lastJoinAnnounce.set(peer.userId, now());
      // Re-send anything they still owe an ack for (or that nobody has received yet)
      for (const o of this.outbox.values()) {
        if (o.needsAnyone || o.pending.has(peer.userId)) { o.pending.add(peer.userId); this.sendEnv(o.env, peer.transportId); }
      }
      // Resume interrupted image downloads from the first newly connected peer that has the data.
      for (const inc of this.incoming.values()) if (!inc.from) this.sendEnv(this.makeEnv('image-request', { imageId: inc.imageId }), peer.transportId);
      for (const inc of this.incomingAssets.values()) if (!inc.from) this.sendEnv(this.makeEnv('asset-request', { assetId: inc.assetId }), peer.transportId);
      // Offer history to the newcomer
      if (this.shareHistory && this.messages.length) {
        const shareable = this.messages.filter((m) => !m.deleted && m.kind !== 'system');
        if (shareable.length) this.sendEnv(this.makeEnv('history-offer', { count: Math.min(shareable.length, LIMITS.HISTORY_SHARE_COUNT), latestTs: shareable[shareable.length - 1].ts }), peer.transportId);
      }
      // Room capacity (best effort): if I am the newest and there are already MAX members, I back off.
      this.checkCapacity();
    }
    this.tickStatus();
    this.scheduleUpdate();
  }

  checkCapacity() {
    const members = this.members();
    const others = Array.from(members.values()).filter((m) => m.joinedAt <= this.joinedAt);
    if (others.length >= LIMITS.MAX_ROOM_MEMBERS && !this.full) {
      this.full = true;
      this.status = 'full';
      emitPanel({ type: 'room:full', roomId: this.id, name: this.name });
      this.scheduleUpdate();
      setTimeout(() => leaveRoom(this.id, { keepEntry: true }), 1500);
    }
  }

  async onChat(env, peer) {
    this.queueAck(peer.transportId, env.id);
    if (this.known.has(env.id)) return;
    if (isUserMuted(peer.userId)) { this.known.add(env.id); return; }
    const p = env.payload;
    const msg = this.buildMessage(env, peer, p);
    for (const a of msg.attachments || []) { const cached = await db.getAsset(a.id).catch(() => null); if (cached && cached.roomId === this.id) { a.state = 'ready'; a.progress = 1; } }
    await this.storeMessage(msg);
    // Was it addressed to me?
    const mentioned = (p.mentions || []).includes(userId) || textMentions(msg.text, myName(this));
    msg.mentionsMe = mentioned;
    const viewed = isRoomViewed(this.id);
    if (!viewed) this.unread++;
    this.lastMsg = { senderName: msg.senderName, text: snippet(msg), ts: msg.ts };
    emitPanel({ type: 'msg:new', roomId: this.id, message: msg });
    this.typing.delete(peer.userId);
    this.scheduleUpdate(); pushDot(); pushBadge();
    if (!viewed) this.notify(msg, mentioned);
  }

  buildMessage(env, peer, p) {
    const prof = peer.profile || {};
    return {
      id: env.id, roomId: this.id, senderId: env.senderId, senderName: prof.name || 'Someone',
      nameColor: prof.nameColor || '', avatar: prof.avatar ? { type: prof.avatar.type, variant: prof.avatar.variant | 0, emoji: prof.avatar.emoji || '' } : null,
      ts: env.ts, kind: p.kind || 'chat', text: cleanText(p.text, LIMITS.MAX_TEXT_CHARS),
      replyTo: p.replyTo ? { id: p.replyTo.id, senderName: cleanText(p.replyTo.senderName || '', LIMITS.MAX_NAME_CHARS), text: cleanText(p.replyTo.text || '', 200) } : null,
      pinned: false, handoffAudience: p.handoffAudience || [], poll: p.poll ? { ...p.poll, options: p.poll.options.map((o) => ({ id: o.id, text: cleanText(o.text, 120) })), votes: {} } : null,
      attachments: (p.attachments || []).map((a) => ({ id: a.id, kind: a.kind, name: cleanText(a.name, 180), mime: a.mime, size: a.size, duration: a.duration || null, state: 'missing', progress: 0 })),
      images: (p.images || []).map((im) => ({ id: im.id, w: im.w, h: im.h, mime: im.mime, size: im.size, thumb: im.thumb || '', animated: !!im.animated, state: 'pending', progress: 0 })),
      mentions: p.mentions || [], sticker: !!p.sticker, reactions: {}, edited: null, deleted: false, status: null, seq: p.seq || 0
    };
  }

  async storeMessage(msg) {
    this.known.add(msg.id);
    this.insertCached(msg);
    await db.putMessage(msg);
    if (this.messages.length % 100 === 0) db.pruneRoomMessages(this.id, LIMITS.HISTORY_KEEP_PER_ROOM).catch(() => {});
  }
  insertCached(msg) {
    this.byId.set(msg.id, msg);
    let i = this.messages.length;
    while (i > 0 && compareMsg(this.messages[i - 1], msg) > 0) i--;
    this.messages.splice(i, 0, msg);
    if (this.messages.length > 400) { const gone = this.messages.splice(0, this.messages.length - 400); for (const g of gone) this.byId.delete(g.id); }
  }
  async getMsg(id) { return this.byId.get(id) || (await db.getMessage(id)) || null; }
  async saveMsg(msg) { this.byId.has(msg.id) ? (this.byId.set(msg.id, msg)) : null; await db.putMessage(msg); this.emitMsgUpdate(msg); }
  emitMsgUpdate(msg) {
    clearTimeout(this.msgUpdateTimers.get(msg.id));
    this.msgUpdateTimers.set(msg.id, setTimeout(() => { this.msgUpdateTimers.delete(msg.id); emitPanel({ type: 'msg:update', roomId: this.id, message: msg }); }, 60));
  }

  notify(msg, mentioned) {
    const roomMuted = isRoomMuted(this.id);
    if (roomMuted && !(mentioned && settings.notifyOnMention)) return;
    if (boss || profile.presence === 'dnd') return;
    const roomName = this.title || this.name;
    toSw({ type: 'notify', roomId: this.id, roomName, title: `${msg.senderName} · ${roomName}`, body: mentioned ? `@you: ${snippet(msg)}` : snippet(msg), mention: mentioned });
    if (settings.sound && !isQuietNow()) playSound(settings.soundName, 0.8);
  }

  systemMessage(text) {
    emitPanel({ type: 'msg:new', roomId: this.id, message: { id: 'sys-' + shortId(), roomId: this.id, senderId: 'system', senderName: '', ts: now(), kind: 'system', text, ephemeral: true, images: [], reactions: {} } });
  }

  async onEdit(env, peer) {
    this.queueAck(peer.transportId, env.id);
    if (this.known.has(env.id)) return; this.known.add(env.id);
    const m = await this.getMsg(env.payload.msgId);
    if (!m || m.senderId !== peer.userId || m.deleted) return;
    m.text = cleanText(env.payload.text, LIMITS.MAX_TEXT_CHARS); m.edited = env.ts;
    await this.saveMsg(m);
  }
  async onDelete(env, peer) {
    this.queueAck(peer.transportId, env.id);
    if (this.known.has(env.id)) return; this.known.add(env.id);
    const m = await this.getMsg(env.payload.msgId);
    if (!m || m.senderId !== peer.userId) return;
    m.deleted = true; m.text = ''; m.images = []; for (const a of m.attachments || []) db.deleteAsset(a.id).catch(() => {}); m.attachments = []; m.poll = null; m.reactions = {}; m.replyTo = null;
    await this.saveMsg(m);
  }
  async onReaction(env, peer) {
    this.queueAck(peer.transportId, env.id);
    if (this.known.has(env.id)) return; this.known.add(env.id);
    const m = await this.getMsg(env.payload.msgId);
    if (!m || m.deleted) return;
    applyReaction(m, env.payload.emoji, peer.userId, env.payload.add);
    await this.saveMsg(m);
  }
  async onPollVote(env, peer) {
    this.queueAck(peer.transportId, env.id);
    const msg = await this.getMsg(env.payload.msgId);
    if (!msg || !msg.poll || msg.poll.closed || (msg.poll.closesAt && now() >= msg.poll.closesAt)) return;
    const ids = env.payload.optionIds;
    if ((!msg.poll.multiple && ids.length > 1) || ids.some((id) => !msg.poll.options.some((o) => o.id === id))) return;
    msg.poll.votes = msg.poll.votes || {};
    if (!ids.length) delete msg.poll.votes[peer.userId]; else msg.poll.votes[peer.userId] = ids;
    await this.saveMsg(msg);
  }

  async onPollClose(env, peer) {
    this.queueAck(peer.transportId, env.id);
    const msg = await this.getMsg(env.payload.msgId);
    if (!msg || !msg.poll || msg.senderId !== peer.userId || msg.poll.closed) return;
    msg.poll.closed = true; msg.poll.closedAt = now();
    await this.saveMsg(msg);
  }

  async votePoll(msgId, optionIds) {
    const msg = await this.getMsg(msgId);
    if (!msg || !msg.poll || msg.poll.closed || (msg.poll.closesAt && now() >= msg.poll.closesAt)) return false;
    const ids = Array.from(new Set(optionIds || []));
    if ((!msg.poll.multiple && ids.length !== 1) || (!msg.poll.multiple && ids.length < 1) || ids.some((id) => !msg.poll.options.some((o) => o.id === id))) return false;
    msg.poll.votes = msg.poll.votes || {}; if (!ids.length) delete msg.poll.votes[userId]; else msg.poll.votes[userId] = ids;
    await this.saveMsg(msg);
    await this.sendDurable(this.makeEnv('poll-vote', { msgId, optionIds: ids }));
    return true;
  }

  async closePoll(msgId) {
    const msg = await this.getMsg(msgId);
    if (!msg || !msg.poll || msg.senderId !== userId || msg.poll.closed) return false;
    msg.poll.closed = true; msg.poll.closedAt = now();
    await this.saveMsg(msg);
    await this.sendDurable(this.makeEnv('poll-close', { msgId }));
    return true;
  }

  async onPin(env, peer) {
    this.queueAck(peer.transportId, env.id);
    const msg = await this.getMsg(env.payload.msgId);
    if (!msg || msg.deleted) return;
    msg.pinned = env.payload.pinned;
    await this.saveMsg(msg);
    this.scheduleUpdate();
  }

  async pinMessage(msgId, pinned) {
    const msg = await this.getMsg(msgId);
    if (!msg || msg.deleted) return false;
    msg.pinned = !!pinned;
    await this.saveMsg(msg);
    await this.sendDurable(this.makeEnv('pin', { msgId: msg.id, pinned: msg.pinned }));
    this.scheduleUpdate();
    return true;
  }

  onTyping(env, peer) {
    if (env.payload.on) this.typing.set(peer.userId, { name: peer.profile.name, until: now() + 4500 });
    else this.typing.delete(peer.userId);
    this.scheduleUpdate();
  }
  async onSeen(env, peer) {
    const cur = this.seenPointers.get(peer.userId);
    if (!cur || env.payload.ts >= cur.ts) { this.seenPointers.set(peer.userId, { msgId: env.payload.msgId, ts: env.payload.ts }); db.setMeta('seen:' + this.id, Object.fromEntries(this.seenPointers)).catch(() => {}); this.scheduleUpdate(); this.completeHandoffIfSeen(); }
  }
  async onAck(env, peer) {
    for (const id of env.payload.ids) {
      const o = this.outbox.get(id); if (!o) continue;
      o.pending.delete(peer.userId); o.needsAnyone = false;
      if (o.env.type === 'chat') {
        const m = await this.getMsg(id);
        if (m && m.status !== 'acked') { m.status = o.pending.size ? 'sent' : 'acked'; await this.saveMsg(m); }
      }
      if (!o.pending.size) this.outbox.delete(id);
    }
  }

  /* ---------- history sync ---------- */
  onHistoryOffer(env, peer) {
    const latestMine = this.messages.length ? this.messages[this.messages.length - 1].ts : 0;
    if (env.payload.count <= 0 || env.payload.latestTs <= latestMine) return;
    const h = this.history;
    if (h.requestedFrom && now() - h.requestedAt < 20000) return; // already syncing from someone
    h.requestedFrom = peer.transportId; h.requestedAt = now();
    this.sendEnv(this.makeEnv('history-request', { since: latestMine, limit: LIMITS.HISTORY_SHARE_COUNT }), peer.transportId);
  }
  async onHistoryRequest(env, peer) {
    if (!this.shareHistory) return;
    const since = env.payload.since;
    let list = await db.getRoomMessages(this.id, { limit: LIMITS.HISTORY_SHARE_COUNT + 50 });
    list = list.filter((m) => m.ts > since && !m.deleted && m.kind !== 'system' && !m.ephemeral).slice(-env.payload.limit);
    const records = list.map((m) => ({
      id: m.id, senderId: m.senderId, senderName: m.senderName, nameColor: m.nameColor || '', ts: m.ts, kind: m.kind || 'chat', text: m.text || '',
      replyTo: m.replyTo || null,
      images: (m.images || []).map((im) => ({ id: im.id, w: im.w, h: im.h, mime: im.mime, size: im.size, thumb: im.thumb || '', animated: !!im.animated })),
      mentions: m.mentions || [], sticker: !!m.sticker, edited: m.edited || null, pinned: !!m.pinned, handoffAudience: m.handoffAudience || [], poll: m.poll || undefined, attachments: (m.attachments || []).map(({ id, kind, name, mime, size, duration }) => ({ id, kind, name, mime, size, duration })), reactions: m.reactions || {}
    }));
    if (!records.length) { await this.sendEnv(this.makeEnv('history-batch', { messages: [], more: false }), peer.transportId); return; }
    for (let i = 0; i < records.length; i += 25) {
      const batch = records.slice(i, i + 25);
      const ok = await this.sendEnv(this.makeEnv('history-batch', { messages: batch, more: i + 25 < records.length }), peer.transportId);
      if (!ok) break;
    }
  }
  async onHistoryBatch(env, peer) {
    const added = [];
    for (const r of env.payload.messages) {
      if (this.known.has(r.id)) continue;
      if (isUserMuted(r.senderId)) continue;
      const msg = {
        id: r.id, roomId: this.id, senderId: r.senderId, senderName: cleanText(r.senderName || 'Someone', LIMITS.MAX_NAME_CHARS), nameColor: r.nameColor || '', avatar: null,
        ts: r.ts, kind: r.kind || 'chat', text: cleanText(r.text || '', LIMITS.MAX_TEXT_CHARS),
        replyTo: r.replyTo ? { id: r.replyTo.id, senderName: cleanText(r.replyTo.senderName || '', LIMITS.MAX_NAME_CHARS), text: cleanText(r.replyTo.text || '', 200) } : null,
        poll: r.poll ? { ...r.poll, votes: r.poll.votes || {} } : null,
        attachments: (r.attachments || []).map((a) => ({ ...a, state: 'missing', progress: 0 })),
        images: (r.images || []).map((im) => ({ id: im.id, w: im.w, h: im.h, mime: im.mime, size: im.size, thumb: im.thumb || '', animated: !!im.animated, state: 'missing', progress: 0 })),
        mentions: r.mentions || [], sticker: !!r.sticker, reactions: r.reactions || {}, edited: r.edited || null, pinned: !!r.pinned, handoffAudience: r.handoffAudience || [], deleted: false,
        status: r.senderId === userId ? 'acked' : null, seq: 0, fromHistory: true
      };
      for (const a of msg.attachments || []) { const cached = await db.getAsset(a.id).catch(() => null); if (cached && cached.roomId === this.id) { a.state = 'ready'; a.progress = 1; } }
      this.known.add(msg.id); this.insertCached(msg); added.push(msg);
    }
    if (added.length) {
      await db.putMessages(added);
      const last = this.messages[this.messages.length - 1];
      this.lastMsg = { senderName: last.senderName, text: snippet(last), ts: last.ts };
      emitPanel({ type: 'msgs:batch', roomId: this.id, messages: added });
      this.scheduleUpdate(); pushDot();
    }
    if (!env.payload.more) { this.history.done = true; this.history.requestedFrom = null; }
  }

  /* ---------- images ---------- */
  setImageState(msgId, imageId, state, progress) {
    const m = this.byId.get(msgId);
    if (!m) return;
    const im = (m.images || []).find((x) => x.id === imageId);
    if (!im) return;
    im.state = state; if (typeof progress === 'number') im.progress = progress;
    this.emitMsgUpdate(m);
    if (state === 'ready' || state === 'missing') db.putMessage(m).catch(() => {});
  }

  async onImageMeta(env, peer) {
    const p = env.payload;
    const maxBytes = settings.maxImageMB * 1024 * 1024;
    if (p.size > maxBytes || p.chunks !== Math.ceil(p.size / p.chunkBytes)) return;
    if (await db.getImage(p.imageId)) { this.sendEnv(this.makeEnv('image-ack', { imageId: p.imageId, upTo: p.chunks - 1, done: true }), peer.transportId); return; }
    const m = await this.getMsg(p.msgId);
    if (!m || !(m.images || []).some((im) => im.id === p.imageId)) return; // unknown image → refuse
    let inflight = 0; for (const inc of this.incoming.values()) inflight += inc.size;
    if (inflight + p.size > 4 * maxBytes) return; // too many concurrent transfers from peers
    let inc = this.incoming.get(p.imageId);
    if (inc && (inc.size !== p.size || inc.chunks !== p.chunks || inc.msgId !== p.msgId)) { this.incoming.delete(p.imageId); inc = null; }
    if (!inc) inc = { imageId: p.imageId, msgId: p.msgId, size: p.size, mime: p.mime, chunks: p.chunks, chunkBytes: p.chunkBytes, parts: new Array(p.chunks), received: 0, from: null, updatedAt: now(), upTo: -1 };
    if (inc.from && inc.from !== peer.transportId) return;
    inc.from = peer.transportId; inc.updatedAt = now();
    while (inc.upTo + 1 < inc.chunks && inc.parts[inc.upTo + 1]) inc.upTo++;
    this.incoming.set(p.imageId, inc);
    db.putPartialImage({ ...inc, roomId: this.id, from: null }).catch((e) => log('partial image save failed', e));
    this.setImageState(p.msgId, p.imageId, 'receiving', inc.received / inc.chunks);
    this.sendEnv(this.makeEnv('image-ack', { imageId: p.imageId, upTo: inc.upTo, done: false }), peer.transportId);
  }

  async onChunk(data, transportId, metadata) {
    if (this.dead || !metadata || typeof metadata.i !== 'string' || !Number.isInteger(metadata.n)) return;
    if (metadata.kind === 'asset') return this.onAssetChunk(data, transportId, metadata);
    const inc = this.incoming.get(metadata.i);
    if (!inc || inc.from !== transportId) return;
    if (metadata.n < 0 || metadata.n >= inc.chunks || inc.parts[metadata.n]) return;
    let raw = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (raw.length > inc.chunkBytes + 28) return;
    let plain;
    try { plain = await openBytes(this.key, raw); } catch (e) { return; }
    inc.parts[metadata.n] = plain; inc.received++; inc.updatedAt = now();
    while (inc.upTo + 1 < inc.chunks && inc.parts[inc.upTo + 1]) inc.upTo++;
    const done = inc.received === inc.chunks;
    if (done || metadata.n % 4 === 3) this.sendEnv(this.makeEnv('image-ack', { imageId: inc.imageId, upTo: inc.upTo, done }), transportId);
    this.setImageState(inc.msgId, inc.imageId, 'receiving', inc.received / inc.chunks);
    if (!done) { db.putPartialImage({ ...inc, roomId: this.id, from: null }).catch((e) => log('partial image save failed', e)); return; }
    this.incoming.delete(inc.imageId);
    db.deletePartialImage(this.id, inc.imageId).catch(() => {});
    const total = inc.parts.reduce((s, p) => s + p.length, 0);
    if (total !== inc.size) { this.setImageState(inc.msgId, inc.imageId, 'missing', inc.received / inc.chunks); return; }
    const bytes = new Uint8Array(total); let off = 0; for (const p of inc.parts) { bytes.set(p, off); off += p.length; }
    const sniffed = sniffImageMime(bytes);
    if (!sniffed || !IMAGE_MIMES.includes(sniffed)) { this.setImageState(inc.msgId, inc.imageId, 'missing', inc.received / inc.chunks); return; }
    const { w, h } = await imageSize(bytes, sniffed);
    await db.putImage({ id: inc.imageId, roomId: this.id, msgId: inc.msgId, blob: new Blob([bytes], { type: sniffed }), mime: sniffed, size: total, w, h, ts: now() });
    this.setImageState(inc.msgId, inc.imageId, 'ready', 1);
    db.pruneImages(settings.imageCacheMB * 1024 * 1024).catch(() => {});
  }

  onImageAck(env, peer) {
    const fn = this.ackWaiters.get(env.payload.imageId + '|' + peer.transportId);
    if (fn) fn(env.payload.upTo, env.payload.done, false);
  }

  async onImageRequest(env, peer) {
    const rec = await this.imageBytesFor(env.payload.imageId);
    if (!rec || !rec.msgId) return;
    this.transferImage(env.payload.imageId, rec.msgId, peer.transportId).catch(() => {});
  }

  async imageBytesFor(imageId) {
    const cached = this.imageBytes.get(imageId);
    if (cached) return cached;
    const rec = await db.getImage(imageId);
    if (!rec || rec.roomId !== this.id) return null;
    const bytes = new Uint8Array(await rec.blob.arrayBuffer());
    const out = { bytes, mime: rec.mime, msgId: rec.msgId || '', at: now() };
    this.imageBytes.set(imageId, out);
    return out;
  }

  /** Chunked transfer with an ack window (application-level backpressure on top of the data
   *  channel's own bufferedAmount throttling handled by Trystero). */
  async transferImage(imageId, msgId, transportId) {
    const rec = await this.imageBytesFor(imageId);
    if (!rec || !this.peers.has(transportId) || !this.chunk) return;
    const { bytes, mime } = rec;
    const chunkBytes = LIMITS.CHUNK_BYTES;
    const chunks = Math.ceil(bytes.length / chunkBytes);
    const key = imageId + '|' + transportId;
    let acked = -1, done = false, aborted = false, wake = null, metaAck = false;
    this.ackWaiters.set(key, (upTo, isDone, abort) => { if (abort) aborted = true; else { acked = Math.max(acked, upTo); done = isDone; metaAck = true; } if (wake) wake(); });
    const ok = await this.sendEnv(this.makeEnv('image-meta', { imageId, msgId, size: bytes.length, mime, chunks, chunkBytes }), transportId);
    if (!ok) { this.ackWaiters.delete(key); return; }
    try {
      // Wait briefly for the receiver's resume offset before deciding where to restart.
      await Promise.race([new Promise((resolve) => { const poll = () => metaAck ? resolve() : setTimeout(poll, 20); poll(); }), new Promise((resolve) => setTimeout(resolve, 1200))]);
      for (let n = Math.max(0, acked + 1); n < chunks && !aborted && !done; n++) {
        while (n - acked > LIMITS.CHUNK_WINDOW && !aborted && !done) {
          const timeout = new Promise((r) => setTimeout(() => r('timeout'), 20000));
          const got = await Promise.race([new Promise((r) => { wake = r; }), timeout]);
          wake = null;
          if (got === 'timeout') { aborted = true; break; }
        }
        if (aborted || done) break;
        const slice = bytes.subarray(n * chunkBytes, Math.min(bytes.length, (n + 1) * chunkBytes));
        const payload = await sealBytes(this.key, slice);
        if (!this.chunk || !this.peers.has(transportId)) { aborted = true; break; }
        await this.chunk.send(payload, { target: transportId, metadata: { i: imageId, n } });
        emitPanel({ type: 'image:progress', roomId: this.id, msgId, imageId, pct: (n + 1) / chunks, dir: 'up', peer: transportId });
      }
      // wait for final ack (bounded)
      const deadline = now() + 30000;
      while (!done && !aborted && now() < deadline) {
        const got = await Promise.race([new Promise((r) => { wake = r; }), new Promise((r) => setTimeout(() => r('t'), 2000))]);
        wake = null; void got;
      }
    } finally { this.ackWaiters.delete(key); }
  }

  /* ---------- screen sharing ---------- */
  /* Live video travels as encoded WebM segments over a dedicated transport action ('lvchunk' with
   * metadata {sid, seq}), so the chat path and its rate limits are untouched and the room host forwards
   * it exactly like any other frame. Every relayed frame would cost a base64 round-trip through a public
   * MQTT broker, so video is direct-link only: the transport refuses to relay 'lvchunk' frames and a
   * member on the relay is told why instead of watching a stalled stream.
   * Flow control is credit-based: viewers acknowledge segments, the publisher pauses its recorder when a
   * viewer falls behind (dropping encoded segments would corrupt the WebM stream it is playing). */

  screenSnapshot() {
    if (!this.screen) return null;
    const viewers = this.screen.viewers.size;
    return { streamId: this.screen.streamId, quality: this.screen.quality, viewers, paused: this.screen.paused, startedAt: this.screen.startedAt, lag: Math.round(this.screen.worstLag || 0) };
  }
  remoteScreenSnapshot() {
    if (!this.remoteScreen) return null;
    return { userId: this.remoteScreen.userId, name: this.remoteScreen.name, streamId: this.remoteScreen.streamId, quality: this.remoteScreen.quality, since: this.remoteScreen.since };
  }
  /** Why a share cannot start right now (or {} when it can). */
  screenCapability() {
    if (this.dead) return { ok: false, code: 'dead' };
    if (!this.code || !this.tRoom) return { ok: false, code: 'offline' };
    let transport = '';
    try { transport = (this.tRoom.diag && this.tRoom.diag().transport) || ''; } catch (e) { transport = ''; }
    if (!this.isHost && transport === 'relay') return { ok: false, code: 'relay' };
    if (this.remoteScreen && this.remoteScreen.userId !== userId) return { ok: false, code: 'busy', by: this.remoteScreen.name };
    return { ok: true };
  }
  /** A member on the relay cannot receive video: let the UI say so instead of pretending. */
  amRelayMember() { try { return ((this.tRoom && this.tRoom.diag && this.tRoom.diag().transport) || '') === 'relay'; } catch (e) { return false; } }

  async beginScreen({ quality } = {}) {
    const cap = this.screenCapability();
    if (!cap.ok) { const e = new Error(cap.code); e.code = cap.code; e.by = cap.by; throw e; }
    const q = SCREEN_QUALITY[quality] ? quality : 'med';
    this.screen = {
      streamId: shortId(), quality: q, seq: 0, startedAt: now(), paused: false, worstLag: 0,
      viewers: new Map(),       // transportId -> { acked, at, lag }
      inflight: 0, dropped: 0
    };
    for (const p of this.peers.values()) if (p.userId) this.screen.viewers.set(p.transportId, { acked: -1, at: now(), lag: 0 });
    await this.sendEnv(this.makeEnv('screen', { kind: 'start', streamId: this.screen.streamId, quality: q, fps: SCREEN_QUALITY[q].fps }), null);
    emitPanel({ type: 'screen:state', roomId: this.id, screen: this.screenSnapshot(), remote: this.remoteScreenSnapshot(), relay: this.amRelayMember() });
    pushDot();
    log('screen share started', this.screen.streamId, q);
    return this.screenSnapshot();
  }

  /** One encoded segment from the publishing panel → every viewer (best effort, credit-limited). */
  publishScreenChunk({ streamId, seq, data }) {
    const s = this.screen;
    if (!s || !this.vchunk || s.streamId !== streamId || typeof data !== 'string' || data.length > SCREEN_MAX_CHUNK * 2) return { ok: false };
    let bytes; try { bytes = b64ToBytes(data); } catch (e) { return { ok: false }; }
    if (!bytes.length || bytes.length > SCREEN_MAX_CHUNK) return { ok: false };
    s.seq = seq;
    const payload = bytes.buffer.slice(0);
    for (const p of this.peers.values()) {
      if (!p.userId) continue;
      const v = s.viewers.get(p.transportId) || { acked: -1, at: now(), lag: 0 };
      s.viewers.set(p.transportId, v);
      try { this.vchunk.send(payload, { target: p.transportId, metadata: { sid: streamId, seq } }); } catch (e) { /* peer left */ }
    }
    this.screenTick();
    return { ok: true, viewers: s.viewers.size };
  }

  /** Viewers acknowledge what they received; a lagging viewer pauses the recorder (never drop segments). */
  onLvAck(data, transportId) {
    const s = this.screen;
    if (!s || !data || data.sid !== s.streamId || !Number.isInteger(data.seq)) return;
    let v = s.viewers.get(transportId);
    if (!v) { const peer = this.peers.get(transportId); if (!peer || !peer.userId) return; v = { acked: -1, at: now(), lag: 0 }; s.viewers.set(transportId, v); }
    if (data.seq > v.acked) v.acked = data.seq;
    v.lag = (typeof data.lag === 'number' && Number.isFinite(data.lag)) ? data.lag : 0;
    v.at = now();
    this.screenTick();
  }
  screenTick() {
    const s = this.screen;
    if (!s) return;
    let worst = 0, backlog = 0;
    for (const [tid, v] of Array.from(s.viewers)) {
      if (now() - v.at > 25000) { s.viewers.delete(tid); continue; }        // viewer gone quiet: stop counting it
      const behind = Math.max(0, s.seq - v.acked);
      if (behind > worst) worst = behind;
      if (behind > backlog) backlog = behind;
    }
    s.worstLag = worst;
    const shouldPause = backlog >= SCREEN_WINDOW && s.viewers.size > 0;
    if (shouldPause !== s.paused) {
      s.paused = shouldPause;
      emitPanel({ type: 'screen:flow', roomId: this.id, streamId: s.streamId, paused: shouldPause });
    }
  }

  async endScreen({ reason = 'user', streamId } = {}) {
    const s = this.screen;
    if (!s) return { ok: false };
    if (streamId && streamId !== s.streamId) return { ok: false };
    this.screen = null;
    await this.sendEnv(this.makeEnv('screen', { kind: 'stop', streamId: s.streamId, viewers: s.viewers.size, reason }), null);
    emitPanel({ type: 'screen:state', roomId: this.id, screen: null, remote: this.remoteScreenSnapshot() });
    pushDot();
    log('screen share ended', reason);
    return { ok: true };
  }

  /** A 'screen' envelope from a peer: share lifecycle + keyframe requests (cooperative, like room-mute). */
  onScreen(env, peer) {
    const p = env.payload;
    if (p.kind === 'start') {
      this.remoteScreen = { userId: peer.userId, name: (peer.profile && peer.profile.name) || 'Someone', streamId: p.streamId, quality: p.quality || 'med', since: now() };
      this.screenView = { streamId: p.streamId, sharerId: peer.userId, sharerTransport: peer.transportId, lastSeq: -1, received: 0, since: now() };
      emitPanel({ type: 'screen:state', roomId: this.id, screen: this.screenSnapshot(), remote: this.remoteScreenSnapshot(), start: true, relay: this.amRelayMember() });
      pushDot();
      return;
    }
    if (p.kind === 'stop') {
      if (p.reason === 'keeper' && peer.userId !== this.keeperId()) return;   // only the keeper may say that
      if (this.remoteScreen) {
        this.remoteScreen = null; this.screenView = null;
        emitPanel({ type: 'screen:state', roomId: this.id, screen: this.screenSnapshot(), remote: null, stopped: true, by: this.remoteScreenName(peer), relay: this.amRelayMember() });
        pushDot();
      }
      return;
    }
    if (p.kind === 'keyframe' || p.kind === 'adjust') {
      // Only the current sharer reacts; the panel restarts the recorder so viewers get a clean segment.
      if (this.screen) emitPanel({ type: 'screen:request', roomId: this.id, kind: p.kind, quality: p.quality });
      return;
    }
  }
  remoteScreenName(peer) { return (peer && peer.profile && peer.profile.name) || 'Someone'; }

  onLvChunk(data, transportId, metadata) {
    if (this.dead || !metadata || typeof metadata.sid !== 'string' || !Number.isInteger(metadata.seq)) return;
    const view = this.screenView;
    if (!view || view.sharerTransport !== transportId) return;      // not from the member we are watching
    if (this.amRelayMember()) return;                               // relayed video is refused by the transport (see peerjs-room.js)
    const raw = data instanceof ArrayBuffer ? new Uint8Array(data) : (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null);
    if (!raw || !raw.length || raw.length > SCREEN_MAX_CHUNK) return;
    if (metadata.sid !== view.streamId) return;                     // a previous/next stream: wait for its start envelope
    if (metadata.seq <= view.lastSeq) return;                        // stale/duplicate (relay reordering)
    if (metadata.seq > view.lastSeq + 40) {                          // a gap: ask for a fresh keyframe instead of playing broken video
      this.lastKeyframeAsk = this.lastKeyframeAsk || 0;
      if (now() - this.lastKeyframeAsk > 4000) {
        this.lastKeyframeAsk = now();
        this.sendEnv(this.makeEnv('screen', { kind: 'keyframe', streamId: view.streamId }), transportId);
      }
      return;
    }
    view.lastSeq = metadata.seq; view.received++;
    emitPanel({ type: 'screen:chunk', roomId: this.id, streamId: metadata.sid, seq: metadata.seq, senderId: view.sharerId, bytes: bytesToB64(raw) });
    // Credit back to the sharer (throttled: one ack per ~5 segments is plenty).
    if (metadata.seq % 4 === 0) { try { this.vack.send({ sid: view.streamId, seq: metadata.seq, lag: Math.round((now() - view.since) / 1000) }, { target: transportId }); } catch (e) { /* peer gone */ } }
  }

  /* ---------- keeper controls (cooperative, see header) ---------- */
  onRoomTitle(env, peer) {
    if (peer.userId !== this.keeperId()) return;
    upsertRoomEntry(this.id, { title: cleanText(env.payload.title, 40) });
    this.systemMessage(`${peer.profile.name} renamed the room to “${cleanText(env.payload.title, 40) || this.name}”`);
    this.scheduleUpdate();
  }
  onRoomMute(env, peer) {
    if (peer.userId !== this.keeperId()) return;
    if (env.payload.on) this.mutedByKeeper.add(env.payload.userId); else this.mutedByKeeper.delete(env.payload.userId);
    const target = this.members().get(env.payload.userId);
    this.systemMessage(`${peer.profile.name} ${env.payload.on ? 'muted' : 'unmuted'} ${target ? target.name : (env.payload.userId === userId ? 'you' : 'a member')}`);
    this.scheduleUpdate();
  }

  setAttachmentState(msgId, assetId, state, progress) {
    const msg = this.byId.get(msgId); if (!msg) return;
    const attachment = (msg.attachments || []).find((a) => a.id === assetId); if (!attachment) return;
    attachment.state = state; if (typeof progress === 'number') attachment.progress = progress;
    this.emitMsgUpdate(msg);
    if (state === 'ready' || state === 'missing') db.putMessage(msg).catch(() => {});
  }

  abortAssetUpload(uploadId) { return this.pendingAssetUploads.delete(uploadId); }
  async deleteUploadedAsset(assetId) { const a = await db.getAsset(assetId); if (a && a.roomId === this.id && !a.msgId) { await db.deleteAsset(assetId); return true; } return false; }

  async beginAssetUpload({ name, mime, size, kind, duration }) {
    if (!['file', 'audio'].includes(kind) || !Number.isInteger(size) || size < 1 || size > MAX_ASSET_BYTES) throw new Error('Attachment must be 50 MB or smaller.');
    if (this.pendingAssetUploads.size >= 4) throw new Error('Another attachment upload is still running.');
    const safeMime = cleanText(mime || 'application/octet-stream', 128);
    if (!/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(safeMime) || (kind === 'audio' && !safeMime.startsWith('audio/'))) throw new Error('Unsupported attachment type.');
    const uploadId = uuid(), assetId = uuid();
    const chunkBytes = 512 * 1024, chunks = Math.ceil(size / chunkBytes);
    this.pendingAssetUploads.set(uploadId, { assetId, roomId: this.id, name: cleanText(name || 'file', 180) || 'file', mime: safeMime, size, kind, duration: kind === 'audio' ? Math.min(30, Math.max(0, Number(duration) || 0)) : null, chunkBytes, chunks, parts: new Array(chunks), received: 0, ts: now() });
    return { uploadId, assetId, chunkBytes, chunks };
  }

  async receiveAssetUploadChunk(uploadId, index, data) {
    const upload = this.pendingAssetUploads.get(uploadId);
    if (!upload || !Number.isInteger(index) || index < 0 || index >= upload.chunks || typeof data !== 'string' || data.length > 710000) throw new Error('Invalid attachment upload chunk.');
    const bytes = b64ToBytes(data);
    const expected = index === upload.chunks - 1 ? upload.size - index * upload.chunkBytes : upload.chunkBytes;
    if (bytes.length !== expected) throw new Error('Attachment upload chunk size mismatch.');
    if (!upload.parts[index]) { upload.parts[index] = bytes; upload.received++; }
    if (upload.received !== upload.chunks) return { ok: true, complete: false, received: upload.received, chunks: upload.chunks };
    const blob = new Blob(upload.parts, { type: upload.mime });
    await db.putAsset({ id: upload.assetId, roomId: this.id, msgId: '', name: upload.name, mime: upload.mime, kind: upload.kind, duration: upload.duration, size: upload.size, blob, ts: upload.ts });
    this.pendingAssetUploads.delete(uploadId);
    return { ok: true, complete: true, id: upload.assetId };
  }

  async assetInfo(assetId) {
    const a = await db.getAsset(assetId);
    if (!a || a.roomId !== this.id) return null;
    return { id: a.id, name: a.name, mime: a.mime, kind: a.kind, size: a.size, duration: a.duration || null };
  }

  async assetReadChunk(assetId, index, chunkBytes = 512 * 1024) {
    const a = await db.getAsset(assetId);
    if (!a || a.roomId !== this.id || !Number.isInteger(index) || index < 0) return null;
    const from = index * chunkBytes;
    if (from >= a.size) return null;
    const bytes = new Uint8Array(await a.blob.slice(from, Math.min(a.size, from + chunkBytes)).arrayBuffer());
    return { index, count: Math.ceil(a.size / chunkBytes), data: bytesToB64(bytes) };
  }

  async onAssetMeta(env, peer) {
    const p = env.payload;
    if (p.size > MAX_ASSET_BYTES || p.chunks !== Math.ceil(p.size / p.chunkBytes)) return;
    const msg = await this.getMsg(p.msgId);
    const ref = msg && msg.roomId === this.id ? (msg.attachments || []).find((a) => a.id === p.assetId) : null;
    if (!ref || ref.size !== p.size || ref.mime !== p.mime || ref.name !== p.name) return;
    const cachedAsset = await db.getAsset(p.assetId);
    if (cachedAsset && cachedAsset.roomId === this.id) { this.setAttachmentState(p.msgId, p.assetId, 'ready', 1); this.sendEnv(this.makeEnv('asset-ack', { assetId: p.assetId, upTo: p.chunks - 1, done: true }), peer.transportId); return; }
    let inc = this.incomingAssets.get(p.assetId);
    if (inc && (inc.size !== p.size || inc.chunks !== p.chunks || inc.msgId !== p.msgId)) { this.incomingAssets.delete(p.assetId); inc = null; }
    if (!inc) inc = { assetId: p.assetId, msgId: p.msgId, size: p.size, mime: p.mime, name: p.name, kind: ref.kind, duration: ref.duration || null, chunks: p.chunks, chunkBytes: p.chunkBytes, parts: new Array(p.chunks), received: 0, from: null, updatedAt: now(), upTo: -1 };
    if (inc.from && inc.from !== peer.transportId) return;
    inc.from = peer.transportId; inc.updatedAt = now();
    while (inc.upTo + 1 < inc.chunks && inc.parts[inc.upTo + 1]) inc.upTo++;
    this.incomingAssets.set(p.assetId, inc);
    db.putPartialAsset({ ...inc, roomId: this.id, from: null }).catch(() => {});
    this.sendEnv(this.makeEnv('asset-ack', { assetId: p.assetId, upTo: inc.upTo, done: false }), peer.transportId);
    this.setAttachmentState(msg.id, p.assetId, 'receiving', inc.received / inc.chunks);
  }

  async onAssetChunk(data, transportId, metadata) {
    const inc = this.incomingAssets.get(metadata.i);
    if (!inc || inc.from !== transportId || metadata.n < 0 || metadata.n >= inc.chunks || inc.parts[metadata.n]) return;
    const raw = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (raw.length > inc.chunkBytes + 28) return;
    let plain; try { plain = await openBytes(this.key, raw); } catch (e) { return; }
    inc.parts[metadata.n] = plain; inc.received++; inc.updatedAt = now();
    while (inc.upTo + 1 < inc.chunks && inc.parts[inc.upTo + 1]) inc.upTo++;
    const done = inc.received === inc.chunks;
    if (done || metadata.n % 4 === 3) this.sendEnv(this.makeEnv('asset-ack', { assetId: inc.assetId, upTo: inc.upTo, done }), transportId);
    this.setAttachmentState(inc.msgId, inc.assetId, 'receiving', inc.received / inc.chunks);
    if (!done) { db.putPartialAsset({ ...inc, roomId: this.id, from: null }).catch(() => {}); return; }
    const total = inc.parts.reduce((n, p) => n + p.length, 0);
    if (total !== inc.size) { this.setAttachmentState(inc.msgId, inc.assetId, 'missing', inc.received / inc.chunks); return; }
    await db.putAsset({ id: inc.assetId, roomId: this.id, msgId: inc.msgId, name: inc.name, mime: inc.mime, kind: inc.kind, duration: inc.duration, size: inc.size, blob: new Blob(inc.parts, { type: inc.mime }), ts: now() });
    this.incomingAssets.delete(inc.assetId); db.deletePartialAsset(this.id, inc.assetId).catch(() => {});
    this.setAttachmentState(inc.msgId, inc.assetId, 'ready', 1);
  }

  onAssetAck(env, peer) { const fn = this.ackWaiters.get(env.payload.assetId + '|' + peer.transportId); if (fn) fn(env.payload.upTo, env.payload.done, false); }
  async onAssetRequest(env, peer) { const asset = await db.getAsset(env.payload.assetId); if (asset && asset.roomId === this.id) { const attachedMsg = await this.getMsg(asset.msgId); if (!asset.msgId || !attachedMsg || !(attachedMsg.attachments || []).some((a) => a.id === asset.id)) return; this.transferAsset(asset.id, asset.msgId, peer.transportId).catch((e) => log('asset transfer failed', e)); } }

  async transferAsset(assetId, msgId, transportId) {
    const rec = await db.getAsset(assetId);
    if (!rec || rec.roomId !== this.id || !this.peers.has(transportId) || !this.chunk) return;
    const bytes = new Uint8Array(await rec.blob.arrayBuffer());
    const chunkBytes = 128 * 1024, chunks = Math.ceil(bytes.length / chunkBytes), key = assetId + '|' + transportId;
    let acked = -1, done = false, aborted = false, wake = null, metaAck = false;
    this.ackWaiters.set(key, (upTo, isDone, abort) => { if (abort) aborted = true; else { acked = Math.max(acked, upTo); done = isDone; metaAck = true; } if (wake) wake(); });
    if (!await this.sendEnv(this.makeEnv('asset-meta', { assetId, msgId, name: rec.name, mime: rec.mime, size: rec.size, chunks, chunkBytes }), transportId)) { this.ackWaiters.delete(key); return; }
    try {
      await Promise.race([new Promise((resolve) => { const poll = () => metaAck ? resolve() : setTimeout(poll, 20); poll(); }), new Promise((resolve) => setTimeout(resolve, 1200))]);
      for (let n = Math.max(0, acked + 1); n < chunks && !aborted && !done; n++) {
        while (n - acked > LIMITS.CHUNK_WINDOW && !aborted && !done) {
          const got = await Promise.race([new Promise((r) => { wake = r; }), new Promise((r) => setTimeout(() => r('timeout'), 20000))]); wake = null;
          if (got === 'timeout') { aborted = true; break; }
        }
        if (aborted || done) break;
        const payload = await sealBytes(this.key, bytes.subarray(n * chunkBytes, Math.min(bytes.length, (n + 1) * chunkBytes)));
        if (!this.chunk || !this.peers.has(transportId)) { aborted = true; break; }
        await this.chunk.send(payload, { target: transportId, metadata: { kind: 'asset', i: assetId, n } });
      }
      const deadline = now() + 30000;
      while (!done && !aborted && now() < deadline) { await Promise.race([new Promise((r) => { wake = r; }), new Promise((r) => setTimeout(r, 2000))]); wake = null; }
    } finally { this.ackWaiters.delete(key); }
  }

  requestAsset(assetId) { if (this.peers.size) this.sendEnv(this.makeEnv('asset-request', { assetId })); }

  /* ---------- outgoing (from UI) ---------- */
  async sendChat({ text, replyTo, images, sticker, kind, handoffAudience, attachments, poll }) {
    text = cleanText(text || '', LIMITS.MAX_TEXT_CHARS);
    const id = uuid();
    const imgs = [];
    const assetRefs = [];
    for (const a of (attachments || []).slice(0, 4)) {
      const rec = await db.getAsset(a.id);
      if (!rec || rec.roomId !== this.id || rec.size > MAX_ASSET_BYTES) throw new Error('Attachment data is missing; upload it again.');
      rec.msgId = id; await db.putAsset(rec);
      assetRefs.push({ id: rec.id, kind: rec.kind, name: cleanText(rec.name, 180), mime: rec.mime, size: rec.size, duration: rec.duration || null, state: 'ready', progress: 1 });
    }
    for (const im of (images || []).slice(0, LIMITS.MAX_IMAGES_PER_MESSAGE)) {
      const prepared = await this.prepareOutgoingImage(im, id);
      if (prepared) imgs.push(prepared);
    }
    if (!text.trim() && !imgs.length && !assetRefs.length && !poll) return null;
    const members = this.members();
    const mentions = [];
    for (const m of members.values()) if (textMentions(text, m.name)) mentions.push(m.userId);
    const a = profile.avatar || {};
    const msg = {
      id, roomId: this.id, senderId: userId, senderName: myName(this), nameColor: profile.nameColor || '',
      avatar: { type: a.type || 'generated', variant: a.variant | 0, emoji: a.emoji || '' },
      ts: now(), kind: kind || 'chat', text, poll: poll ? { question: cleanText(poll.question, 240), options: poll.options.slice(0, 10).map((o) => ({ id: String(o.id).slice(0, 64), text: cleanText(o.text, 120) })), multiple: !!poll.multiple, closesAt: poll.closesAt || 0, votes: {} } : null,
      attachments: assetRefs,
      replyTo: replyTo ? { id: String(replyTo.id).slice(0, 64), senderName: cleanText(replyTo.senderName || '', LIMITS.MAX_NAME_CHARS), text: cleanText(replyTo.text || '', 200) } : null,
      images: imgs.map((im) => ({ ...im.meta, state: 'ready', progress: 1 })),
      mentions, sticker: !!sticker, reactions: {}, edited: null, deleted: false, status: 'pending', seq: ++this.seqCounter, handoffAudience: (handoffAudience || []).slice(0, LIMITS.MAX_ROOM_MEMBERS)
    };
    await this.storeMessage(msg);
    this.lastMsg = { senderName: msg.senderName, text: snippet(msg), ts: msg.ts };
    emitPanel({ type: 'msg:new', roomId: this.id, message: msg });
    const env = this.makeEnv('chat', {
      text, kind: msg.kind, replyTo: msg.replyTo || undefined, images: imgs.length ? imgs.map((im) => im.meta) : undefined,
      mentions: mentions.length ? mentions : undefined, sticker: sticker ? true : undefined, seq: msg.seq, handoffAudience: msg.handoffAudience.length ? msg.handoffAudience : undefined, poll: msg.poll ? { question: msg.poll.question, options: msg.poll.options, multiple: msg.poll.multiple, closesAt: msg.poll.closesAt } : undefined, attachments: msg.attachments.length ? msg.attachments.map(({ id, kind, name, mime, size, duration }) => ({ id, kind, name, mime, size, duration })) : undefined
    }, id);
    const n = await this.sendDurable(env);
    msg.status = n ? 'sending' : 'pending';
    this.emitMsgUpdate(msg); db.putMessage(msg).catch(() => {});
    if (imgs.length) {
      for (const p of this.peers.values()) if (p.userId) for (const im of imgs) this.transferImage(im.meta.id, id, p.transportId).catch((e) => log('transfer failed', e));
    }
    pushDot();
    return msg;
  }
  seqCounter = 0;

  async prepareOutgoingImage(im, msgId) {
    try {
      const { bytes } = dataUrlToBytes(im.dataUrl);
      const sniffed = sniffImageMime(bytes); // never trust the declared MIME
      if (!sniffed || !IMAGE_MIMES.includes(sniffed)) return null;
      const maxBytes = settings.maxImageMB * 1024 * 1024;
      if (bytes.length > maxBytes) { toast(`Image is larger than ${settings.maxImageMB} MB`, 'error'); return null; }
      const size = await imageSize(bytes, sniffed);
      const id = uuid();
      const thumb = await makeThumb(bytes, sniffed, im.sticker ? 160 : 200);
      await db.putImage({ id, roomId: this.id, msgId, blob: new Blob([bytes], { type: sniffed }), mime: sniffed, size: bytes.length, w: size.w, h: size.h, ts: now() });
      this.imageBytes.set(id, { bytes, mime: sniffed, msgId, at: now() });
      return { meta: { id, w: size.w || 1, h: size.h || 1, mime: sniffed, size: bytes.length, thumb, animated: sniffed === 'image/gif' } };
    } catch (e) { log('prepare image failed', e); return null; }
  }

  async editMessage(msgId, text) {
    const m = await this.getMsg(msgId);
    if (!m || m.senderId !== userId || m.deleted) return false;
    m.text = cleanText(text, LIMITS.MAX_TEXT_CHARS); m.edited = now();
    await this.saveMsg(m);
    await this.sendDurable(this.makeEnv('edit', { msgId, text: m.text }));
    return true;
  }
  async deleteMessage(msgId) {
    const m = await this.getMsg(msgId);
    if (!m || m.senderId !== userId) return false;
    m.deleted = true; m.text = ''; m.images = []; for (const a of m.attachments || []) db.deleteAsset(a.id).catch(() => {}); m.attachments = []; m.poll = null; m.reactions = {}; m.replyTo = null;
    await this.saveMsg(m);
    await this.sendDurable(this.makeEnv('delete', { msgId }));
    return true;
  }
  async react(msgId, emoji, add) {
    const m = await this.getMsg(msgId);
    if (!m || m.deleted) return false;
    emoji = String(emoji).slice(0, 16);
    applyReaction(m, emoji, userId, add);
    await this.saveMsg(m);
    await this.sendDurable(this.makeEnv('reaction', { msgId, emoji, add: !!add }));
    return true;
  }
  sendTyping(on) { if (this.peers.size) this.sendEnv(this.makeEnv('typing', { on: !!on })); }
  sendSeen(msgId, ts) {
    if (profile.presence === 'invisible') return;
    const cur = this.seenPointers.get(userId);
    if (cur && cur.ts >= ts) return;
    this.seenPointers.set(userId, { msgId, ts });
    db.setMeta('seen:' + this.id, Object.fromEntries(this.seenPointers)).catch(() => {});
    if (this.peers.size) this.sendEnv(this.makeEnv('seen', { msgId, ts }));
  }
  async setTitle(title) {
    if (this.keeperId() !== userId) return false;
    title = cleanText(title, 40);
    upsertRoomEntry(this.id, { title });
    await this.sendDurable(this.makeEnv('room-title', { title }));
    this.scheduleUpdate();
    return true;
  }
  async muteMember(uid, on) {
    if (this.keeperId() !== userId) return false;
    if (on) this.mutedByKeeper.add(uid); else this.mutedByKeeper.delete(uid);
    await this.sendDurable(this.makeEnv('room-mute', { userId: uid, on: !!on }));
    this.scheduleUpdate();
    return true;
  }
  requestImage(imageId) { if (this.peers.size) this.sendEnv(this.makeEnv('image-request', { imageId })); }

  async clearHistory() {
    this.messages = []; this.byId.clear(); this.lastMsg = null; this.unread = 0;
    await db.deleteRoomMessages(this.id);
    await db.deleteRoomImages(this.id); await db.deleteRoomAssets(this.id); await db.deleteRoomPartialAssets(this.id);
    this.imageBytes.clear(); this.incomingAssets.clear(); this.pendingAssetUploads.clear();
    emitPanel({ type: 'room:cleared', roomId: this.id });
    this.scheduleUpdate(); pushDot(); pushBadge();
  }

  async diagnostics() {
    const peers = [];
    for (const p of this.peers.values()) {
      let rtt = null, connectionState = 'unknown', iceState = 'unknown', candidate = '';
      try {
        const pcs = this.tRoom ? this.tRoom.getPeers() : {};
        const pc = pcs[p.transportId];
        if (pc) {
          connectionState = pc.connectionState; iceState = pc.iceConnectionState;
          const stats = await pc.getStats();
          let pair = null; const cands = new Map();
          stats.forEach((s) => { if (s.type === 'candidate-pair' && (s.selected || s.nominated) && s.state === 'succeeded') pair = s; if (s.type === 'local-candidate' || s.type === 'remote-candidate') cands.set(s.id, s); });
          if (pair) { const l = cands.get(pair.localCandidateId), r = cands.get(pair.remoteCandidateId); candidate = `${l ? l.candidateType : '?'} ↔ ${r ? r.candidateType : '?'}`; if (typeof pair.currentRoundTripTime === 'number') rtt = Math.round(pair.currentRoundTripTime * 1000); }
        }
        if (rtt == null && this.tRoom) rtt = Math.round(await Promise.race([this.tRoom.ping(p.transportId), sleep(3000).then(() => NaN)]));
        if (Number.isNaN(rtt)) rtt = null;
      } catch (e) { /* ignore */ }
      p.rtt = rtt;
      peers.push({ transportId: p.transportId, userId: p.userId, name: p.profile ? p.profile.name : '(handshaking)', connectionState, iceState, rtt, candidate });
    }
    return { roomId: this.id, strategy: settings.signaling, relays: this.relayStates(), peers, status: this.status, lastError: this.lastError || null, keeper: this.keeperId(), joinedAt: this.joinedAt };
  }

  async connectionTest() {
    const started = now();
    const relay = this.relayStates();
    const iceTypes = new Set(), iceErrors = [];
    let gatherState = 'unsupported';
    if (typeof RTCPeerConnection !== 'undefined') {
      let pc;
      try {
        pc = new RTCPeerConnection({ iceServers: await resolveIce(settings.iceServers) });
        gatherState = 'gathering';
        const gathered = new Promise((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 10000);
          const finish = (state) => { clearTimeout(timer); resolve(state); };
          pc.onicecandidate = (event) => {
            if (event.candidate && event.candidate.candidate) {
              const match = event.candidate.candidate.match(/\btyp\s+(host|srflx|relay|prflx)\b/);
              if (match) iceTypes.add(match[1]);
            } else if (!event.candidate) finish('complete');
          };
          pc.onicecandidateerror = (event) => { if (iceErrors.length < 8) iceErrors.push({ code: Number(event.errorCode) || 0, text: cleanText((event.url ? event.url + ' — ' : '') + (event.errorText || ''), 160) }); };
        });
        pc.createDataChannel('orbit-connection-test');
        await pc.setLocalDescription(await pc.createOffer());
        gatherState = await gathered;
      } catch (e) {
        gatherState = 'error';
        iceErrors.push({ code: 0, text: cleanText(e && e.message || 'ICE candidate gathering failed', 120) });
      } finally { if (pc) { pc.onicecandidate = null; pc.onicecandidateerror = null; try { pc.close(); } catch (e) { /* noop */ } } }
    }

    const livePeers = Array.from(this.peers.values());
    const peerResults = await Promise.all(livePeers.map(async (p) => {
      let rttMs = null;
      if (this.tRoom && typeof this.tRoom.ping === 'function') {
        const samples = await Promise.all([0, 1].map(() => Promise.race([this.tRoom.ping(p.transportId), sleep(3000).then(() => NaN)])));
        const good = samples.filter((n) => Number.isFinite(n));
        if (good.length) rttMs = Math.round(good.reduce((sum, n) => sum + n, 0) / good.length);
      }
      let connectionState = 'unknown', iceState = 'unknown', selectedPath = '';
      try {
        const pc = this.tRoom && this.tRoom.getPeers && this.tRoom.getPeers()[p.transportId];
        if (pc) {
          connectionState = pc.connectionState || connectionState;
          iceState = pc.iceConnectionState || iceState;
          if (pc.getStats) {
            const stats = await pc.getStats(); const byId = new Map(); let selected = null;
            stats.forEach((item) => { if (item.type === 'local-candidate' || item.type === 'remote-candidate') byId.set(item.id, item); if (item.type === 'candidate-pair' && (item.selected || item.nominated) && item.state === 'succeeded') selected = item; });
            if (selected) { const local = byId.get(selected.localCandidateId), remote = byId.get(selected.remoteCandidateId); if (local || remote) selectedPath = `${local ? local.candidateType : '?'} ↔ ${remote ? remote.candidateType : '?'}`; }
          }
        }
      } catch (e) { /* peer may have disconnected during test */ }
      return { userId: p.userId, name: p.profile && p.profile.name || '', connectionState, iceState, rttMs, selectedPath };
    }));
    return { roomId: this.id, signaling: settings.signaling, relay, relayOpen: relay.some((r) => r.state === 'open'), iceGathering: gatherState, iceTypes: Array.from(iceTypes), iceErrors, iceUrls: sanitizeIce(settings.iceServers).flatMap((x) => x.urls), peers: peerResults, elapsedMs: now() - started };
  }

  /* ---------- snapshots ---------- */
  scheduleUpdate() {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => { this.updateTimer = null; emitPanel({ type: 'room:update', room: this.snapshot() }); }, 100);
  }
  snapshot() {
    const e = roomEntry(this.id) || {};
    const members = Array.from(this.members().values()).filter((m) => m.presence !== 'invisible');
    const me = { userId, ...myPresencePayload(this), isSelf: true, transports: 1, rtt: null, mutedByKeeper: this.mutedByKeeper.has(userId) };
    members.unshift(me);
    const seen = {}; for (const [k, v] of this.seenPointers) seen[k] = v;
    return {
      id: this.id, name: e.name || this.name, code: e.code || this.code || '', title: e.title || '', status: this.status, unread: this.unread, lastMsg: this.lastMsg,
      members, keeperId: this.keeperId(), typing: Array.from(this.typing.entries()).map(([uid, t]) => ({ userId: uid, name: t.name })),
      seenPointers: seen, shareHistory: e.shareHistory !== false, nick: e.nick || '', muteUntil: e.muteUntil || 0, hasPassword: !!this.password,
      peerCount: this.peers.size, relays: this.relayStates(), full: this.full,
      pinnedMessages: this.messages.filter((m) => m.pinned && !m.deleted).map((m) => ({ id: m.id, text: m.text || '', senderName: m.senderName, ts: m.ts }))
    };
  }
}

function applyReaction(m, emoji, uid, add) {
  m.reactions = m.reactions || {};
  const list = m.reactions[emoji] || [];
  const i = list.indexOf(uid);
  if (add && i < 0) list.push(uid);
  if (!add && i >= 0) list.splice(i, 1);
  if (list.length) m.reactions[emoji] = list; else delete m.reactions[emoji];
  if (Object.keys(m.reactions).length > 40) delete m.reactions[emoji];
}
function textMentions(text, name) {
  if (!text || !name) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])@${esc}(?![\\p{L}\\p{N}])`, 'iu').test(text) || /(^|\s)@(everyone|all|here)\b/i.test(text);
}
// Defunct public servers: PeerJS free TURN (discontinued) and Mozilla's STUN.
const DEAD_ICE_HOST = /(^|[@:.])(turn\.peerjs\.com|stun\.services\.mozilla\.com)(:|\/|$)/i;
function sanitizeIce(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || !s.urls) continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => /^(stun|stuns|turn|turns):/i.test(String(u)) && !DEAD_ICE_HOST.test(String(u)));
    if (!urls.length) continue;
    const entry = { urls };
    if (s.username) entry.username = String(s.username);
    if (s.credential) entry.credential = String(s.credential);
    if (s.restSecret) entry.restSecret = String(s.restSecret);
    out.push(entry);
  }
  return out.length ? out : sanitizeIce(DEFAULT_SETTINGS.iceServers);
}

// TURN REST auth: entries with `restSecret` get short-lived credentials (HMAC-SHA1 of "expiry:name").
async function resolveIce(list) {
  const out = [];
  for (const e of sanitizeIce(list)) {
    if (!e.restSecret) { out.push(e); continue; }
    try {
      const username = `${Math.floor(Date.now() / 1000) + 24 * 3600}:orbit`;
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', enc.encode(e.restSecret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(username)));
      let bin = ''; for (const b of sig) bin += String.fromCharCode(b);
      out.push({ urls: e.urls, username, credential: btoa(bin) });
    } catch (err) { log('TURN credential derivation failed', err); }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Screen sharing presets                                               */
/* ------------------------------------------------------------------ */
/* One encoded WebM/VP8 segment is produced every `slice` ms; the bitrate is chosen so a segment stays
 * comfortably below the data-channel fragment size (48 kB) — a big segment is fine too (the transport
 * fragments it), it just costs more latency when the link is slow. */
const SCREEN_QUALITY = {
  low:  { label: 'Low',    width: 960,  height: 540,  fps: 6,  bitsPerSecond: 350000,  slice: 400 },
  med:  { label: 'Medium', width: 1280, height: 720,  fps: 10, bitsPerSecond: 800000,  slice: 250 },
  high: { label: 'High',   width: 1600, height: 900,  fps: 15, bitsPerSecond: 1600000, slice: 200 }
};
const SCREEN_WINDOW = 24;          // unacked segments allowed per viewer before the recorder pauses
const SCREEN_MAX_CHUNK = 64000;    // biggest segment we accept/forward (bytes, before base64)

/* ------------------------------------------------------------------ */
/* Room manager                                                         */
/* ------------------------------------------------------------------ */
const ROOM_CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
function normalizeRoomCode(input) {
  const code = String(input || '').toLowerCase().replace(/\s/g, '');
  return /^[a-z]{5}$/.test(code) ? code : '';
}
function formatRoomCode(code) { return code; }
function generateRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]).join('');
}
async function roomFromCode(code, displayName, password, isHost = false) {
  const canonical = normalizeRoomCode(code);
  if (!canonical) throw new Error('Invalid room code.');
  const formatted = formatRoomCode(canonical);
  const id = await deriveRoomId(canonical, password);
  const key = await deriveRoomKey(canonical, password);
  const sdpPassword = password ? await sha256Hex('orbit:sdp:' + canonical + ':' + password) : null;
  return new Room({ id, name: displayName || formatted, code: formatted, password, key, sdpPassword, isHost });
}
async function createRoom(rawName, password) {
  const name = normalizeRoomName(rawName);
  if (!name) throw new Error('Room name is empty after cleaning');
  password = password ? String(password) : null;
  let room = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = generateRoomCode();
    room = await roomFromCode(code, name, password, true);
    await room.loadHistory();
    await room.connect();
    if (room.idTaken) { await room.leave(); room = null; continue; }
    break;
  }
  if (!room || room.idTaken || !room.tRoom) { if (room) await room.leave(); throw new Error('Could not reserve a five-letter room code. Check the PeerJS connection and try again.'); }
  rooms.set(room.id, room);
  upsertRoomEntry(room.id, { name, code: room.code, host: true, lastJoined: now(), active: true, password });
  room.scheduleUpdate(); pushDot(); pushBadge();
  return { roomId: room.id, name, code: room.code, existing: false };
}
/**
 * Enter a room by its code.
 *
 * `opts.asHost` means “this device created this room” (the saved entry says host: true). That distinction
 * matters: after everybody leaves, or after a browser restart, the creator has to *reclaim* the code —
 * joining as a guest can never work, because a vacant code has no host to answer. A claim that is refused
 * (the matchmaker still holds our own previous session) is retried in the background instead of failing,
 * so the room stays rejoinable and the group can meet again in the same place.
 */
/**
 * Enter a room by its code.
 *
 * `opts.asHost` means “this device created this room” (the saved entry says host: true). That distinction
 * matters: after everybody leaves, or after a browser restart, the creator has to *reclaim* the code —
 * joining as a guest can never work, because a vacant code has no host to answer. A claim that is refused
 * (the matchmaker still holds our own previous session) is retried in the background instead of failing,
 * so the room stays rejoinable and the group can meet again in the same place.
 */
async function joinRoomByCode(rawCode, password, opts = {}) {
  const code = normalizeRoomCode(rawCode);
  if (!code) throw new Error('Enter a valid five-letter room code.');
  password = password ? String(password) : null;
  const id = await deriveRoomId(code, password);
  const existing = rooms.get(id);
  if (existing) return { roomId: id, name: existing.name, code: existing.code, existing: true, host: existing.isHost };
  const display = formatRoomCode(code);
  if (opts.asHost) return claimRoomCode({ id, display, password, name: opts.name });

  const room = await roomFromCode(display, display, password, false);
  await room.loadHistory();
  await room.connect();
  // Require a valid decrypted Orbit hello, not just an open WebRTC channel. This rejects stale codes and wrong passwords.
  const deadline = Date.now() + 55000; // direct link (≈12 s) then up to three relay brokers
  const hasVerifiedHost = () => Array.from(room.peers.values()).some((peer) => !!peer.userId);
  const joinDiag = () => { try { return (room.tRoom && room.tRoom.diag && room.tRoom.diag()) || null; } catch (e) { return null; } };
  let channelSince = 0;
  while (!hasVerifiedHost() && Date.now() < deadline && !room.dead) {
    const d0 = joinDiag();
    if (d0 && (d0.hostUnavailable || d0.relayFailed)) break; // direct link and relay both exhausted: fail fast
    if (d0 && d0.channelOpen) { if (!channelSince) channelSince = Date.now(); else if (Date.now() - channelSince > 15000) break; } // linked but no valid hello (wrong password?)
    await sleep(100);
  }
  if (!hasVerifiedHost()) {
    const d = joinDiag();
    await room.leave();
    // Recovery: the code exists but nobody is hosting it, and this device has been in that room before
    // (its saved entry carries the room's real name, not just the code). Take the room over so the group
    // can meet in the same place again — this is what makes “everyone left, now we are all back” work
    // when the creator is not the first one to return. Codes we have never seen stay honest errors.
    const prior = roomEntry(id);
    const formerName = prior && prior.name && !normalizeRoomCode(prior.name) ? cleanText(prior.name, 40) : '';
    if (d && d.hostUnavailable && formerName) {
      log('vacant room, taking it over:', formerName);
      upsertRoomEntry(id, { host: true, active: true });
      await emitPanel({ type: 'toast', text: `Nobody is hosting “${formerName}” — hosting it from this device instead.`, kind: 'info' });
      return claimRoomCode({ id, display, password, name: formerName });
    }
    let msg = 'No active room found for that code. Check the code/password and confirm a room member is online.';
    if (!d) msg = 'Could not start the connection. Check your internet connection or firewall and try again.';
    else if (d.relayFailed && !d.relayReached && !d.signalingOpen) msg = 'Could not reach PeerJS (0.peerjs.com) or any relay broker. Check your internet connection or firewall (a phone hotspot is a quick test).';
    else if (d.hostUnavailable) msg = 'No room with that code is online. The creator must be online with the room open, and the code must be typed exactly (five letters).';
    else if (!d.signalingOpen && !d.relayReached) msg = 'Lost the connection to the signaling server before the room answered. Try again.';
    else if (!d.channelOpen) msg = 'Found the room but could not open a direct connection (ICE: ' + (d.iceState || 'not started') + '). One side is likely behind a strict NAT or firewall: add a TURN server in Settings → Advanced.';
    else msg = 'Connected to the room but it did not answer. If the room has a password, check that it matches exactly.';
    throw new Error(msg);
  }
  rooms.set(id, room);
  upsertRoomEntry(id, { name: room.name, code: display, host: false, lastJoined: now(), active: true, password });
  room.scheduleUpdate(); pushDot(); pushBadge();
  return { roomId: id, name: room.name, code: display, existing: true, host: false };
}

/** Take (or take back) the host role for a code we own. Never fails hard: an unresolved claim stays a
 *  live room in the “claiming” state and keeps retrying in the background. */
async function claimRoomCode({ id, display, password, name }) {
  const room = await roomFromCode(display, name || display, password, true);
  room.claimUntil = now() + 5 * 60000;      // keep asking the matchmaker for our own code
  await room.loadHistory();
  await room.connect();
  rooms.set(id, room);
  upsertRoomEntry(id, { name: room.name, code: display, host: true, lastJoined: now(), active: true, password });
  room.scheduleUpdate(); pushDot(); pushBadge();
  if (room.claiming) emitPanel({ type: 'toast', text: `Room code ${display.toUpperCase()} is still held by your previous session — reclaiming it…`, kind: 'info' });
  return { roomId: id, name: room.name, code: display, existing: false, host: true, claiming: !!room.claiming };
}

async function resumeRoom(entry) {
  if (entry.code) {
    const code = normalizeRoomCode(entry.code);
    if (!code) return null;
    const id = await deriveRoomId(code, entry.password || null);
    if (rooms.has(id)) return rooms.get(id);
    const room = await roomFromCode(formatRoomCode(code), entry.name || formatRoomCode(code), entry.password || null, !!entry.host);
    room.everConnected = !!entry.host;
    // A host coming back from a restart: our own previous PeerJS id can still be reserved on the
    // matchmaker. Give the claim a window and retry instead of dropping to guest/error (the old
    // behaviour) — otherwise nobody hosts the room again and every member just sits on “Connecting…”.
    if (entry.host) room.claimUntil = now() + 5 * 60000;
    await room.loadHistory(); rooms.set(id, room); await room.connect(); room.scheduleUpdate();
    return room;
  }
  // Legacy saved room from the older name-derived scheme: leave it available locally,
  // but future invitations use code-based rooms.
  const name = normalizeRoomName(entry.name);
  if (!name) return null;
  const id = await deriveRoomId(name, entry.password || null);
  if (rooms.has(id)) return rooms.get(id);
  const key = await deriveRoomKey(name, entry.password || null);
  const sdpPassword = entry.password ? await sha256Hex('orbit:sdp:' + name + ':' + entry.password) : null;
  const room = new Room({ id, name, password: entry.password || null, key, sdpPassword });
  await room.loadHistory(); rooms.set(id, room); await room.connect(); room.scheduleUpdate(); return room;
}
async function leaveRoom(roomId, { keepEntry = true } = {}) {
  const room = rooms.get(roomId);
  if (room) { rooms.delete(roomId); await room.leave(); }
  const e = roomEntry(roomId);
  if (e) { e.active = false; if (!keepEntry) roomsList = roomsList.filter((r) => r.id !== roomId); await saveRoomsList(); }
  emitPanel({ type: 'room:left', roomId });
  pushDot(); pushBadge();
}

async function rejoinActiveRooms() {
  for (const e of roomsList) {
    if (!e.active || !e.name) continue;
    try { await resumeRoom(e); } catch (err) { log('rejoin failed', e.name, err); }
  }
}

/* ------------------------------------------------------------------ */
/* Command handling (from the service worker, on behalf of UI ports)    */
/* ------------------------------------------------------------------ */
const handlers = {
  async 'ui:hello'(m) {
    uis.set(m.portId, { context: m.context, mode: m.mode, roomId: null, open: m.context === 'sidepanel', visible: true, tabId: m.tabId });
    return { userId, rooms: Array.from(rooms.values()).map((r) => r.snapshot()), dot: dotState(), boss };
  },
  async 'ui:gone'(m) {
    uis.delete(m.portId);
    // If the panel that was publishing a screen share just closed, stop the share instead of leaving it live.
    for (const r of rooms.values()) if (r.screen && r.screen.publisherPort === m.portId) r.endScreen({ reason: 'panel-closed' }).catch(() => {});
    pushBadge();
    return { ok: true };
  },
  async 'ui:view'(m) {
    const u = uis.get(m.portId) || { context: 'content', mode: 'panel' };
    u.roomId = m.roomId || null; u.open = !!m.open; u.visible = m.visible !== false; if (m.mode) u.mode = m.mode;
    uis.set(m.portId, u);
    if (u.roomId && u.open && u.visible) { const r = rooms.get(u.roomId); if (r && r.unread) { r.unread = 0; r.scheduleUpdate(); } }
    pushDot(); pushBadge();
    return { ok: true };
  },
  async 'room:create'(m) { return createRoom(m.name, m.password); },
  async 'room:join'(m) { return joinRoomByCode(m.code, m.password, { asHost: !!m.asHost, name: m.name }); },
  async 'room:leave'(m) { await leaveRoom(m.roomId, { keepEntry: m.forget !== true }); return { ok: true }; },
  async 'room:send'(m) { const r = need(m.roomId); const msg = await r.sendChat(m); return { ok: !!msg, message: msg }; },
  async 'room:edit'(m) { return { ok: await need(m.roomId).editMessage(m.msgId, m.text) }; },
  async 'room:delete'(m) { return { ok: await need(m.roomId).deleteMessage(m.msgId) }; },
  async 'room:pinMessage'(m) { return { ok: await need(m.roomId).pinMessage(m.msgId, m.pinned) }; },
  async 'room:pollVote'(m) { return { ok: await need(m.roomId).votePoll(m.msgId, m.optionIds) }; },
  async 'room:pollClose'(m) { return { ok: await need(m.roomId).closePoll(m.msgId) }; },
  async 'asset:uploadBegin'(m) { return need(m.roomId).beginAssetUpload(m); },
  async 'asset:uploadChunk'(m) { return need(m.roomId).receiveAssetUploadChunk(m.uploadId, m.index, m.data); },
  async 'asset:uploadAbort'(m) { return { ok: need(m.roomId).abortAssetUpload(m.uploadId) }; },
  async 'asset:delete'(m) { const r = rooms.get(m.roomId); return { ok: r ? await r.deleteUploadedAsset(m.assetId) : false }; },
  async 'asset:info'(m) { const r = rooms.get(m.roomId); return { asset: r ? await r.assetInfo(m.assetId) : null }; },
  async 'asset:readChunk'(m) { const r = rooms.get(m.roomId); return { chunk: r ? await r.assetReadChunk(m.assetId, m.index) : null }; },
  async 'asset:fetch'(m) { const r = rooms.get(m.roomId); if (r) r.requestAsset(m.assetId); return { ok: !!r }; },
  async 'room:react'(m) { return { ok: await need(m.roomId).react(m.msgId, m.emoji, m.add) }; },
  async 'room:typing'(m) { const r = rooms.get(m.roomId); if (r) r.sendTyping(m.on); return { ok: true }; },
  async 'room:seen'(m) { const r = rooms.get(m.roomId); if (r) r.sendSeen(m.msgId, m.ts); return { ok: true }; },
  async 'room:markRead'(m) { const r = rooms.get(m.roomId); if (r) { r.unread = 0; r.scheduleUpdate(); pushDot(); pushBadge(); } return { ok: true }; },
  async 'room:history'(m) {
    const limit = Math.min(200, m.limit || 100);
    const list = await db.getRoomMessages(m.roomId, { before: m.before || Infinity, limit: limit + 1 });
    const hasMore = list.length > limit;
    return { messages: hasMore ? list.slice(1) : list, hasMore };
  },
  async 'room:search'(m) { return { messages: await db.searchRoomMessages(m.roomId, m.q, 60) }; },
  async 'room:clear'(m) { const r = rooms.get(m.roomId); if (r) await r.clearHistory(); else { await db.deleteRoomMessages(m.roomId); await db.deleteRoomImages(m.roomId); await db.deleteRoomAssets(m.roomId); await db.deleteRoomPartials(m.roomId); await db.deleteRoomPartialAssets(m.roomId); await db.deleteMeta('seen:' + m.roomId); } return { ok: true }; },
  async 'room:setTitle'(m) { return { ok: await need(m.roomId).setTitle(m.title) }; },
  async 'room:muteMember'(m) { return { ok: await need(m.roomId).muteMember(m.userId, m.on) }; },
  async 'room:setShareHistory'(m) { upsertRoomEntry(m.roomId, { shareHistory: !!m.on }); const r = rooms.get(m.roomId); if (r) r.scheduleUpdate(); return { ok: true }; },
  async 'room:setNick'(m) { upsertRoomEntry(m.roomId, { nick: cleanText(m.nick || '', LIMITS.MAX_NAME_CHARS) }); const r = rooms.get(m.roomId); if (r) { r.broadcastPresence(); r.scheduleUpdate(); } return { ok: true }; },
  async 'room:mute'(m) { upsertRoomEntry(m.roomId, { muteUntil: m.until | 0 }); const r = rooms.get(m.roomId); if (r) r.scheduleUpdate(); pushBadge(); pushDot(); return { ok: true }; },
  async 'room:pin'(m) { upsertRoomEntry(m.roomId, { pinned: !!m.pinned }); return { ok: true }; },
  async 'room:forget'(m) { await leaveRoom(m.roomId, { keepEntry: false }); await db.deleteRoomMessages(m.roomId); await db.deleteRoomImages(m.roomId); await db.deleteRoomAssets(m.roomId); await db.deleteRoomPartials(m.roomId); await db.deleteRoomPartialAssets(m.roomId); await db.deleteMeta('seen:' + m.roomId); return { ok: true }; },
  /* ---------- screen sharing (the panel captures + encodes; this host only routes) ---------- */
  async 'screen:begin'(m) {
    const r = need(m.roomId);
    const snap = await r.beginScreen({ quality: m.quality });
    if (r.screen) r.screen.publisherPort = m.portId;   // so closing that panel stops the capture
    return { screen: snap };
  },
  async 'screen:chunk'(m) { const r = rooms.get(m.roomId); if (!r) return { ok: false }; return r.publishScreenChunk(m); },
  async 'screen:end'(m) { const r = rooms.get(m.roomId); if (!r) return { ok: false }; return r.endScreen({ reason: m.reason || 'user', streamId: m.streamId }); },
  async 'screen:keyframe'(m) {
    // A viewer wants a fresh start segment (it joined late, or missed segments). `to` is a user id.
    const r = rooms.get(m.roomId); if (!r) return { ok: false };
    if (r.screen) { emitPanel({ type: 'screen:request', roomId: r.id, kind: 'keyframe' }); return { ok: true, local: true }; }
    const target = (m.to && r.transportsFor(m.to)[0]) || null;
    r.sendEnv(r.makeEnv('screen', { kind: 'keyframe', streamId: m.streamId || '' }), target).catch(() => {});
    return { ok: true };
  },
  async 'screen:stopForAll'(m) {
    // Keeper-only, cooperative: ask the sharer to stop (they may refuse by ignoring it, like room-mute).
    const r = rooms.get(m.roomId); if (!r) return { ok: false };
    const snap = r.remoteScreenSnapshot();
    if (!snap) return { ok: false };
    const target = Array.from(r.peers.values()).find((p) => p.userId === snap.userId);
    if (!target) return { ok: false };
    r.sendEnv(r.makeEnv('screen', { kind: 'stop', streamId: snap.streamId, viewers: 0, reason: 'keeper' }), target.transportId).catch(() => {});
    return { ok: true };
  },
  async 'screen:state'(m) { const r = rooms.get(m.roomId); if (!r) return { screen: null, remote: null }; return { screen: r.screenSnapshot(), remote: r.remoteScreenSnapshot(), relay: r.amRelayMember() }; },
  async 'room:diagnostics'(m) { const r = rooms.get(m.roomId); return r ? r.diagnostics() : { error: 'not joined' }; },
  async 'room:connectionTest'(m) { const r = rooms.get(m.roomId); return r ? r.connectionTest() : { error: 'not joined' }; },
  async 'room:snapshot'(m) { const r = rooms.get(m.roomId); return { room: r ? r.snapshot() : null }; },
  async 'image:get'(m) {
    const rec = await db.getImage(m.id);
    if (!rec) return { missing: true };
    return { id: m.id, dataUrl: await blobToDataUrl(rec.blob), mime: rec.mime, w: rec.w, h: rec.h, size: rec.size };
  },
  async 'image:fetch'(m) { const r = rooms.get(m.roomId); if (r) r.requestImage(m.imageId); return { ok: !!r }; },
  async 'presence:refresh'() { for (const r of rooms.values()) r.broadcastPresence(); return { ok: true }; },
  async 'badge:refresh'() { pushBadge(); pushDot(); return { ok: true }; },
  async 'boss'(m) { boss = !!m.on; pushBadge(); return { ok: true }; },
  async 'sound:test'(m) { playSound(m.name || settings.soundName, 0.8); return { ok: true }; },
  async 'data:clearAll'() {
    for (const id of Array.from(rooms.keys())) await leaveRoom(id, { keepEntry: false });
    await db.clearAll();
    return { ok: true };
  },
  async 'storage:usage'() {
    let bytes = 0; try { bytes = await db.totalImageBytes(); } catch (e) { /* ignore */ }
    return { imageBytes: bytes };
  }
};
function need(roomId) { const r = rooms.get(roomId); if (!r) throw new Error('Not in that room'); return r; }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'storage:changed') { deliverStorageChange(msg.changes, msg.area); sendResponse({ ok: true }); return; }
  const h = handlers[msg.cmd];
  if (!h) { sendResponse({ error: 'unknown command: ' + msg.cmd }); return; }
  Promise.resolve().then(() => h(msg)).then((res) => sendResponse(res || { ok: true }), (e) => sendResponse({ error: String(e && e.message || e) }));
  return true;
});

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */
(async function boot() {
  await loadStorage();
  await db.openDb();
  const r = await toSw({ type: 'ready' });
  boss = !!(r && r.boss);
  // Heartbeat keeps the service worker warm and lets it know we exist.
  setInterval(() => toSw({ type: 'hb' }), 20000);
  // Toolbar icon theme hint (the worker cannot query prefers-color-scheme itself).
  const mq = matchMedia('(prefers-color-scheme: dark)');
  toSw({ type: 'colorScheme', dark: mq.matches });
  mq.addEventListener('change', () => toSw({ type: 'colorScheme', dark: mq.matches }));
  window.addEventListener('online', () => { for (const room of rooms.values()) if (room.status !== 'connected') room.reconnect('online'); });
  await rejoinActiveRooms();
  db.pruneImages(settings.imageCacheMB * 1024 * 1024).catch(() => {});
  log(`${BRAND_NAME} offscreen ready as`, userId);
})();
