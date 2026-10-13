/* Orbit relay fallback — the "Neon Nights" safety net.
 *
 * When a direct WebRTC link cannot form (strict NAT, blocked WebRTC, PeerJS matchmaker unreachable) Orbit
 * relays the very same room frames through public MQTT brokers over WebSocket-TLS (ports 443/8084/8884/8081),
 * which looks like ordinary HTTPS traffic and passes essentially every firewall.
 *
 * This file contains:
 *   • MqttClient      — a minimal MQTT 3.1.1 client over WebSocket (CONNECT / SUBSCRIBE / PUBLISH QoS 0 / PING).
 *                       Written in-house because the extension CSP forbids loading mqtt.js from a CDN.
 *   • makeRelayCrypto — topic + AES-GCM key derivation. Brokers are public, so every relayed frame is sealed
 *                       and the topic is a hash, never the plain room code. If the room has a password the
 *                       password-derived secret is mixed in, so the broker cannot even guess the code offline.
 *                       Without a password the code is the only secret: that is casual privacy, not strong
 *                       security (five letters can be brute-forced) — use a room password for real privacy.
 */
const te = new TextEncoder();
const td = new TextDecoder();

export const RELAY_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081'
];

const concat = (...parts) => {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const remLen = (n) => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0); return Uint8Array.from(out); };
const u16 = (n) => Uint8Array.of((n >> 8) & 255, n & 255);
const mqttStr = (s) => { const b = te.encode(s); return concat(u16(b.length), b); };
const packet = (first, ...body) => { const b = concat(...body); return concat(Uint8Array.of(first), remLen(b.length), b); };
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export class MqttClient {
  constructor(url, opts = {}) {
    this.url = url;
    this.keepAlive = opts.keepAlive || 30;
    this.reconnectMs = opts.reconnectMs === undefined ? 3000 : opts.reconnectMs;
    this.connectTimeout = opts.connectTimeout || 7000;
    this.WS = opts.WebSocketCtor || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.clientId = 'orbit_' + hex(crypto.getRandomValues(new Uint8Array(8)));
    this.state = 'idle';            // idle | connecting | open | closed | ended
    this.ended = false;
    this.ws = null;
    this.buf = new Uint8Array(0);
    this.subs = new Set();          // topics to restore after a reconnect
    this.pendingSubs = new Map();   // packetId -> {resolve, reject, timer, topic}
    this.nextId = 1;
    this.pingTimer = null; this.connTimer = null; this.retryTimer = null;
    this.onopen = null; this.onmessage = null; this.onclose = null;
  }

  open() {
    if (this.ended || !this.WS) { if (!this.ended) this._closed(); return; }
    clearTimeout(this.retryTimer);
    this.state = 'connecting';
    let ws;
    try { ws = new this.WS(this.url, 'mqtt'); } catch (e) { this._closed(); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws; this.buf = new Uint8Array(0);
    clearTimeout(this.connTimer);
    this.connTimer = setTimeout(() => { if (this.ws === ws && this.state === 'connecting') { try { ws.close(); } catch (e) { /* noop */ } this._closed(); } }, this.connectTimeout);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      try {
        ws.send(packet(0x10, mqttStr('MQTT'), Uint8Array.of(4, 0x02), u16(this.keepAlive), mqttStr(this.clientId)));
      } catch (e) { /* closed meanwhile */ }
    };
    ws.onmessage = (ev) => { if (this.ws === ws && ev.data instanceof ArrayBuffer) this._feed(new Uint8Array(ev.data)); };
    ws.onerror = () => { if (this.ws === ws && this.state === 'connecting') this._closed(); };   // refused connection (some engines skip onclose)
    ws.onclose = () => { if (this.ws === ws) this._closed(); };
  }

  _feed(chunk) {
    this.buf = this.buf.length ? concat(this.buf, chunk) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let i = 1, mult = 1, len = 0, byte;
      do {
        if (i >= b.length) return;                    // remaining-length bytes not complete yet
        byte = b[i++]; len += (byte & 127) * mult; mult *= 128;
        if (mult > 128 * 128 * 128 * 128) { this._protocolError(); return; }
      } while (byte & 128);
      if (b.length < i + len) return;                 // body not complete yet
      const type = b[0] >> 4, flags = b[0] & 15, body = b.subarray(i, i + len);
      this.buf = b.subarray(i + len);
      this._handle(type, flags, body);
      if (!this.ws) return;
    }
  }

  _handle(type, flags, p) {
    if (type === 2) {                                  // CONNACK
      if (p[1] !== 0) { this._protocolError(); return; }
      clearTimeout(this.connTimer);
      this.state = 'open';
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => { try { if (this.ws && this.state === 'open') this.ws.send(Uint8Array.of(0xC0, 0)); } catch (e) { /* noop */ } }, Math.max(1000, this.keepAlive * 500));
      for (const t of this.subs) this._sendSubscribe(t);   // restore subscriptions after a reconnect
      if (this.onopen) { try { this.onopen(); } catch (e) { /* noop */ } }
    } else if (type === 9) {                           // SUBACK
      const id = (p[0] << 8) | p[1], rc = p[2], pend = this.pendingSubs.get(id);
      if (pend) { clearTimeout(pend.timer); this.pendingSubs.delete(id); if (rc === 0x80) pend.reject(new Error('subscribe refused')); else { this.subs.add(pend.topic); pend.resolve(); } }
    } else if (type === 3) {                           // PUBLISH
      const tl = (p[0] << 8) | p[1];
      const topic = td.decode(p.subarray(2, 2 + tl));
      let idx = 2 + tl;
      const qos = (flags >> 1) & 3;
      if (qos > 0) { const pid = p.subarray(idx, idx + 2); idx += 2; if (qos === 1) { try { this.ws.send(Uint8Array.of(0x40, 2, pid[0], pid[1])); } catch (e) { /* noop */ } } }
      if (this.onmessage) { try { this.onmessage(topic, p.slice(idx)); } catch (e) { /* noop */ } }
    }
    // PINGRESP (13) and everything else: nothing to do
  }

  _protocolError() { try { this.ws && this.ws.close(); } catch (e) { /* noop */ } this._closed(); }

  _closed() {
    const wasOpen = this.state === 'open';
    clearInterval(this.pingTimer); clearTimeout(this.connTimer);
    const ws = this.ws; this.ws = null;
    try { ws && ws.close(); } catch (e) { /* noop */ }
    for (const [, pend] of this.pendingSubs) { clearTimeout(pend.timer); pend.reject(new Error('connection closed')); }
    this.pendingSubs.clear();
    if (this.ended) { this.state = 'ended'; return; }
    this.state = 'closed';
    if (this.onclose) { try { this.onclose(wasOpen); } catch (e) { /* noop */ } }
    if (this.reconnectMs > 0 && !this.ended) { clearTimeout(this.retryTimer); this.retryTimer = setTimeout(() => this.open(), this.reconnectMs); }
  }

  _sendSubscribe(topic, id) {
    id = id || (this.nextId = (this.nextId % 65535) + 1);
    try { this.ws.send(packet(0x82, u16(id), mqttStr(topic), Uint8Array.of(0))); } catch (e) { /* noop */ }
    return id;
  }

  subscribe(topic) {
    return new Promise((resolve, reject) => {
      if (this.state !== 'open' || !this.ws) { reject(new Error('not connected')); return; }
      const id = this._sendSubscribe(topic);
      const timer = setTimeout(() => { this.pendingSubs.delete(id); reject(new Error('subscribe timeout')); }, 8000);
      this.pendingSubs.set(id, { resolve, reject, timer, topic });
    });
  }

  publish(topic, payload) {
    if (this.state !== 'open' || !this.ws) return false;
    try { this.ws.send(packet(0x30, mqttStr(topic), payload)); return true; } catch (e) { return false; }
  }

  end() {
    this.ended = true;
    clearTimeout(this.retryTimer); clearTimeout(this.connTimer); clearInterval(this.pingTimer);
    const ws = this.ws; this.ws = null;
    for (const [, pend] of this.pendingSubs) { clearTimeout(pend.timer); pend.reject(new Error('ended')); }
    this.pendingSubs.clear();
    try { if (ws && this.state === 'open') ws.send(Uint8Array.of(0xE0, 0)); } catch (e) { /* noop */ }
    try { ws && ws.close(); } catch (e) { /* noop */ }
    this.state = 'ended';
  }
}

/** Topic + AES-GCM key for one room. `secret` is the password-derived secret (empty when the room has none). */
export async function makeRelayCrypto(code, secret) {
  secret = secret || '';
  const h = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)));
  const topicHash = await h('orbit:relay:topic:v1:' + code + ':' + secret);
  const keyBytes = await h('orbit:relay:key:v1:' + code + ':' + secret);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return {
    topic: 'orbitchat1/' + hex(topicHash.slice(0, 12)),
    async seal(str) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(str)));
      return concat(iv, ct);
    },
    async open(bytes) {
      if (!bytes || bytes.length < 29) return null;
      try { return td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12))); } catch (e) { return null; }
    }
  };
}
