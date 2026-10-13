/* Orbit — crypto helpers (offscreen document only).
 *
 *  • Room names are normalized (see normalizeRoomName) and hashed with SHA-256 to a 16-hex
 *    room ID used as the peer-discovery topic. The password, if any, is mixed into the hash
 *    so two rooms with the same name but different passwords never discover each other.
 *  • With a password, a 256-bit AES-GCM key is derived with PBKDF2 (210k iterations) from
 *    name+password; every control message and every image chunk is encrypted end-to-end.
 *  • Wrong password => different room ID => you simply land in an empty room. Nothing ever
 *    tells a user "a password exists" — there is no oracle to probe.
 */
const te = new TextEncoder();
const td = new TextDecoder();

export const utf8 = {
  encode: (s) => te.encode(s),
  decode: (b) => td.decode(b)
};

export function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function shortId() {
  return toHex(crypto.getRandomValues(new Uint8Array(6)));
}

/** Normalize a room name so "Cheat-Group", "cheat group" and "CHEAT_GROUP" all match.
 *  Mirrors the implementation in ui/ui-kit.js (kept in sync by tests in README). */
export function normalizeRoomName(input) {
  let s = String(input || '').normalize('NFKC').toLowerCase();
  // strip emoji / pictographs / symbols / punctuation (keep letters, numbers, marks, separators)
  s = s.replace(/[^\p{L}\p{N}\p{M}\s_\-]/gu, ' ');
  s = s.replace(/[\s_\-]+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s.slice(0, 64);
}

export async function sha256Hex(str) {
  const d = await crypto.subtle.digest('SHA-256', te.encode(str));
  return toHex(d);
}

/** roomId = first 16 hex chars of SHA-256("orbit:room:" + normalizedName [+ ":pw:" + sha256(password)]) */
export async function deriveRoomId(name, password) {
  // Normalizing here as well makes the function idempotent: "Cheat-Group" and "cheat group" share an id.
  let material = 'orbit:room:' + normalizeRoomName(name);
  if (password) material += ':pw:' + (await sha256Hex('orbit:pw:' + password));
  return (await sha256Hex(material)).slice(0, 16);
}

/** PBKDF2(name + password) -> AES-GCM 256 key (null when no password). */
export async function deriveRoomKey(name, password) {
  if (!password) return null;
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: te.encode('orbit:salt:' + normalizeRoomName(name)), iterations: 210000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

/** Encrypt bytes -> iv(12) || ciphertext. Returns the input unchanged when key is null. */
export async function sealBytes(key, bytes) {
  if (!key) return bytes;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0); out.set(ct, 12);
  return out;
}

export async function openBytes(key, bytes) {
  if (!key) return bytes;
  if (bytes.length < 13) throw new Error('ciphertext too short');
  const iv = bytes.subarray(0, 12);
  const ct = bytes.subarray(12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

export async function sealJson(key, obj) { return sealBytes(key, te.encode(JSON.stringify(obj))); }
export async function openJson(key, bytes, maxBytes) {
  if (bytes.length > maxBytes) throw new Error('message too large');
  const plain = await openBytes(key, bytes);
  if (plain.length > maxBytes) throw new Error('message too large');
  return JSON.parse(td.decode(plain));
}

/* base64 <-> bytes without fetch() (extension CSP does not allow data: in connect-src) */
export function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const mime = (header.match(/^data:([^;,]+)/) || [, 'application/octet-stream'])[1];
  const b64 = dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return { bytes: out, mime };
}

export function bytesToDataUrl(bytes, mime) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return `data:${mime};base64,` + btoa(bin);
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
