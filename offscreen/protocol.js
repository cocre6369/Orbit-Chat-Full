/* Orbit — peer protocol v1: validation + rate limiting (offscreen document only).
 *
 * Every peer message is an envelope:
 *   { v: 1, type, id, roomId, senderId, ts, payload }
 * Nothing received from a peer is ever executed or evaluated — it is parsed as JSON,
 * validated field by field against the schemas below (type + length + range), and dropped
 * on any violation. See README "Message protocol" for the full description.
 */
const { LIMITS, PROTOCOL_VERSION } = globalThis.ORBIT;

export const MAX_CTL_BYTES = 512 * 1024;
export const MAX_ASSET_BYTES = 50 * 1024 * 1024;
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const PRESENCE = ['online', 'away', 'dnd', 'invisible'];
const AVATAR_TYPES = ['generated', 'emoji', 'image'];
const CHAT_KINDS = ['chat', 'me', 'system', 'handoff', 'poll'];
const SCREEN_KINDS = ['start', 'stop', 'keyframe', 'adjust'];
const SCREEN_QUALITIES = ['low', 'med', 'high'];

const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBool = (v) => typeof v === 'boolean';
const isHex = (v) => v === '' || /^#[0-9a-fA-F]{6}$/.test(v);
const isId = (v) => isStr(v, 64) && v.length > 0;
const isArr = (v, max) => Array.isArray(v) && v.length <= max;
const isDataUrl = (v, max) => v === '' || (isStr(v, max) && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v));

/** Remove control chars (keep \n and \t) and clamp length. */
export function cleanText(s, max) {
  return String(s || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
}

function validAvatar(a) {
  if (!a || typeof a !== 'object') return false;
  if (!AVATAR_TYPES.includes(a.type)) return false;
  if (!isInt(a.variant || 0, 0, 64)) return false;
  if (a.emoji != null && !isStr(a.emoji, 16)) return false;
  if (a.dataUrl != null && !isDataUrl(a.dataUrl, 40000)) return false;
  return true;
}

function validProfile(p) {
  return p && typeof p === 'object' &&
    isStr(p.name, LIMITS.MAX_NAME_CHARS) &&
    (p.roomName == null || isStr(p.roomName, 40)) &&
    validAvatar(p.avatar) &&
    (p.banner == null || isStr(p.banner, 64)) &&
    (p.status == null || isStr(p.status, LIMITS.MAX_STATUS_CHARS)) &&
    PRESENCE.includes(p.presence) &&
    (p.nameColor == null || (isStr(p.nameColor, 7) && isHex(p.nameColor))) &&
    (p.joinedAt == null || isNum(p.joinedAt));
}

function validImageMeta(im, maxBytes) {
  return im && typeof im === 'object' &&
    isId(im.id) && isInt(im.w, 1, 20000) && isInt(im.h, 1, 20000) &&
    IMAGE_MIMES.includes(im.mime) && isInt(im.size, 1, maxBytes) &&
    (im.thumb == null || isDataUrl(im.thumb, 24000)) &&
    (im.animated == null || isBool(im.animated));
}

function validAttachment(a, maxBytes) {
  return a && typeof a === 'object' && isId(a.id) && ['file', 'audio'].includes(a.kind) &&
    isStr(a.name, 180) && a.name.trim().length > 0 && isStr(a.mime, 128) && /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(a.mime) &&
    isInt(a.size, 1, maxBytes) && (a.kind !== 'audio' || a.mime.startsWith('audio/')) && (a.duration == null || (isNum(a.duration) && a.duration > 0 && a.duration <= 30));
}
function validPoll(p, history = false) {
  if (!p || typeof p !== 'object' || !isStr(p.question, 240) || !p.question.trim() ||
      !isArr(p.options, 10) || p.options.length < 2 || !p.options.every((o) => o && isId(o.id) && isStr(o.text, 120) && o.text.trim()) ||
      new Set(p.options.map((o) => o.id)).size !== p.options.length || !isBool(p.multiple) ||
      (p.closesAt != null && p.closesAt !== 0 && (!isNum(p.closesAt) || p.closesAt < 0))) return false;
  if (!history && p.votes != null) return false;
  if (history && p.votes != null) {
    if (typeof p.votes !== 'object' || Object.keys(p.votes).length > 64) return false;
    for (const [uid, selected] of Object.entries(p.votes)) {
      if (!isId(uid) || !isArr(selected, 10) || !selected.every((id) => p.options.some((o) => o.id === id))) return false;
      if (!p.multiple && selected.length > 1) return false;
    }
  }
  return (p.closed == null || isBool(p.closed)) && (p.closedAt == null || isNum(p.closedAt));
}

function validReplyTo(r) {
  return r == null || (r && typeof r === 'object' && isId(r.id) && isStr(r.senderName || '', LIMITS.MAX_NAME_CHARS) && isStr(r.text || '', 200));
}

function validChatPayload(p, maxImageBytes, maxAssetBytes = MAX_ASSET_BYTES, history = false) {
  if (!p || typeof p !== 'object') return false;
  if (!isStr(p.text, LIMITS.MAX_TEXT_CHARS)) return false;
  if (p.kind != null && !CHAT_KINDS.includes(p.kind)) return false;
  if (!validReplyTo(p.replyTo)) return false;
  if (p.images != null) {
    if (!isArr(p.images, LIMITS.MAX_IMAGES_PER_MESSAGE)) return false;
    if (!p.images.every((im) => validImageMeta(im, maxImageBytes))) return false;
  }
  if (p.mentions != null && !(isArr(p.mentions, 16) && p.mentions.every(isId))) return false;
  if (p.sticker != null && !isBool(p.sticker)) return false;
  if (p.seq != null && !isInt(p.seq, 0, 1e12)) return false;
  if (p.handoffAudience != null && !(isArr(p.handoffAudience, 32) && p.handoffAudience.every(isId))) return false;
  if (p.attachments != null && !(isArr(p.attachments, 4) && p.attachments.every((a) => validAttachment(a, maxAssetBytes)))) return false;
  if (p.poll != null && !validPoll(p.poll, history)) return false;
  if ((p.kind === 'poll') !== !!p.poll) return false;
  if (!p.text.trim() && !(p.images && p.images.length) && !(p.attachments && p.attachments.length)) return false;
  return true;
}

/** A message record as shared inside history-batch (subset of our stored message shape). */
function validHistoryRecord(m, maxImageBytes, maxAssetBytes) {
  return m && typeof m === 'object' && isId(m.id) && isId(m.senderId) && isNum(m.ts) &&
    isStr(m.senderName || '', LIMITS.MAX_NAME_CHARS) &&
    (m.nameColor == null || isHex(m.nameColor)) &&
    validChatPayload({ text: m.text || '', kind: m.kind, replyTo: m.replyTo, images: m.images, attachments: m.attachments, poll: m.poll, mentions: m.mentions, sticker: m.sticker, handoffAudience: m.handoffAudience }, maxImageBytes, maxAssetBytes, true) &&
    (m.edited == null || isNum(m.edited)) && (m.pinned == null || isBool(m.pinned)) &&
    (m.handoffAudience == null || (isArr(m.handoffAudience, 32) && m.handoffAudience.every(isId))) &&
    (m.reactions == null || (typeof m.reactions === 'object' && Object.keys(m.reactions).length <= 40 &&
      Object.entries(m.reactions).every(([k, v]) => isStr(k, 16) && isArr(v, 64) && v.every(isId))));
}

const validators = {
  hello: (p) => validProfile(p) && isInt(p.proto || 1, 1, 99),
  presence: (p) => validProfile(p),
  chat: (p, ctx) => validChatPayload(p, ctx.maxImageBytes, ctx.maxAssetBytes || MAX_ASSET_BYTES),
  edit: (p) => p && isId(p.msgId) && isStr(p.text, LIMITS.MAX_TEXT_CHARS) && p.text.trim().length > 0,
  delete: (p) => p && isId(p.msgId),
  reaction: (p) => p && isId(p.msgId) && isStr(p.emoji, 16) && p.emoji.length > 0 && isBool(p.add),
  typing: (p) => p && isBool(p.on),
  seen: (p) => p && isId(p.msgId) && isNum(p.ts),
  ack: (p) => p && isArr(p.ids, 200) && p.ids.every(isId),
  'history-offer': (p) => p && isInt(p.count, 0, 100000) && isNum(p.latestTs),
  'history-request': (p) => p && isNum(p.since) && isInt(p.limit, 1, LIMITS.HISTORY_SHARE_COUNT),
  'history-batch': (p, ctx) => p && isArr(p.messages, 40) && p.messages.every((m) => validHistoryRecord(m, ctx.maxImageBytes, ctx.maxAssetBytes || MAX_ASSET_BYTES)) && isBool(p.more),
  'image-meta': (p, ctx) => p && isId(p.imageId) && isId(p.msgId) && isInt(p.size, 1, ctx.maxImageBytes) && IMAGE_MIMES.includes(p.mime) &&
    isInt(p.chunks, 1, Math.ceil(ctx.maxImageBytes / 4096)) && isInt(p.chunkBytes, 1024, 256 * 1024),
  'image-ack': (p) => p && isId(p.imageId) && isInt(p.upTo, -1, 1e7) && isBool(p.done),
  'image-request': (p) => p && isId(p.imageId),
  pin: (p) => p && isId(p.msgId) && isBool(p.pinned),
  'poll-vote': (p) => p && isId(p.msgId) && isArr(p.optionIds, 10) && p.optionIds.every(isId) && new Set(p.optionIds).size === p.optionIds.length,
  'poll-close': (p) => p && isId(p.msgId),
  'asset-meta': (p, ctx) => p && isId(p.assetId) && isId(p.msgId) && isInt(p.size, 1, ctx.maxAssetBytes || MAX_ASSET_BYTES) && isStr(p.mime, 128) && /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(p.mime) && isStr(p.name, 180) && isInt(p.chunks, 1, 10000) && isInt(p.chunkBytes, 1024, 512 * 1024),
  'asset-ack': (p) => p && isId(p.assetId) && isInt(p.upTo, -1, 1e7) && isBool(p.done),
  'asset-request': (p) => p && isId(p.assetId),
  'room-title': (p) => p && isStr(p.title, 40),
  'room-mute': (p) => p && isId(p.userId) && isBool(p.on),
  // Screen sharing lifecycle (the video itself travels as an opaque 'lvchunk' action, not as an envelope).
  screen: (p) => p && SCREEN_KINDS.includes(p.kind) && isId(p.streamId) &&
    (p.kind !== 'start' || (SCREEN_QUALITIES.includes(p.quality) && isInt(p.fps, 1, 30))) &&
    (p.kind !== 'stop' || (isInt(p.viewers == null ? 0 : p.viewers, 0, 64) && (p.reason == null || isStr(p.reason, 24)))) &&
    (p.quality == null || SCREEN_QUALITIES.includes(p.quality))
};

export const MESSAGE_TYPES = Object.keys(validators);

/** Validate a decoded envelope. Returns null if OK or a string reason. */
export function validateEnvelope(env, ctx) {
  if (!env || typeof env !== 'object') return 'not-object';
  if (env.v !== PROTOCOL_VERSION) return 'bad-version';
  if (!validators[env.type]) return 'unknown-type';
  if (!isId(env.id)) return 'bad-id';
  if (!isId(env.senderId)) return 'bad-sender';
  if (!isNum(env.ts)) return 'bad-ts';
  if (env.roomId != null && env.roomId !== ctx.roomId) return 'wrong-room';
  if (env.payload == null || typeof env.payload !== 'object') return 'bad-payload';
  try { if (!validators[env.type](env.payload, ctx)) return 'invalid-' + env.type; } catch (e) { return 'validator-threw'; }
  return null;
}

/** Token bucket per peer: `capacity` burst, `refillPerSec` sustained. */
export class RateLimiter {
  constructor(capacity = 40, refillPerSec = 8) { this.capacity = capacity; this.refill = refillPerSec; this.buckets = new Map(); }
  allow(peerId, cost = 1) {
    const now = performance.now();
    let b = this.buckets.get(peerId);
    if (!b) { b = { tokens: this.capacity, last: now, strikes: 0, blockedUntil: 0 }; this.buckets.set(peerId, b); }
    if (now < b.blockedUntil) return false;
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.last) / 1000) * this.refill);
    b.last = now;
    if (b.tokens >= cost) { b.tokens -= cost; return true; }
    // flooding: after repeated violations, ignore the peer for 10 seconds
    if (++b.strikes > 20) { b.blockedUntil = now + 10000; b.strikes = 0; }
    return false;
  }
  forget(peerId) { this.buckets.delete(peerId); }
}
