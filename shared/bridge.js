/* Orbit — UI ⇄ background bridge (classic script; used by content script + side panel).
 *
 * The UI never touches the network. Everything goes over one long-lived
 * chrome.runtime port to the service worker, which relays to the offscreen document.
 *
 *   bridge.send(msg)                 fire-and-forget
 *   bridge.request(msg[, timeoutMs]) -> Promise(response)
 *   bridge.on(type, fn) -> off()     subscribe to events pushed by the background
 *   bridge.ready -> Promise          resolves after the first successful 'hello'
 *
 * Reconnects with backoff when the service worker restarts, and pings every 20s
 * so the worker (and the connection) stays alive.
 */
(function (root) {
  'use strict';
  const PORT_NAME = (root.ORBIT && root.ORBIT.PORT_NAME) || 'orbit-ui';

  function createBridge(hello) {
    const listeners = new Map();   // type -> Set<fn>
    const pending = new Map();     // reqId -> {resolve, reject, timer}
    let port = null;
    let seq = 0;
    let dead = false;
    let backoff = 500;
    let pingTimer = null;
    let readyResolve;
    const ready = new Promise((r) => { readyResolve = r; });
    let helloData = hello || {};

    function emit(type, data) {
      const set = listeners.get(type);
      if (set) for (const fn of Array.from(set)) { try { fn(data); } catch (e) { console.warn('[Orbit] listener error', e); } }
      const any = listeners.get('*');
      if (any) for (const fn of Array.from(any)) { try { fn(data, type); } catch (e) { /* ignore */ } }
    }

    function connect() {
      if (dead) return;
      try {
        if (!chrome.runtime || !chrome.runtime.id) throw new Error('context invalidated');
        port = chrome.runtime.connect({ name: PORT_NAME });
      } catch (e) {
        // Extension was reloaded/removed; nothing we can do from this page.
        dead = true;
        emit('dead', { reason: String(e && e.message || e) });
        return;
      }
      port.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.reqId && pending.has(msg.reqId)) {
          const p = pending.get(msg.reqId);
          pending.delete(msg.reqId);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg);
          return;
        }
        if (msg.type === 'hello-ack') { backoff = 500; readyResolve(msg); }
        emit(msg.type, msg);
      });
      port.onDisconnect.addListener(() => {
        port = null;
        const err = chrome.runtime.lastError;
        const msg = err && err.message || '';
        for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('disconnected')); pending.delete(id); }
        if (/invalidated|closed|uninstalled/i.test(msg) && !chrome.runtime.id) { dead = true; emit('dead', { reason: msg }); return; }
        emit('disconnected', {});
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15000);
      });
      send({ type: 'hello', ...helloData });
    }

    function send(msg) {
      if (!port) return false;
      try { port.postMessage(msg); return true; } catch (e) { return false; }
    }

    function request(msg, timeoutMs) {
      return new Promise((resolve, reject) => {
        const reqId = 'r' + (++seq) + '_' + Math.random().toString(36).slice(2, 8);
        const timer = setTimeout(() => { pending.delete(reqId); reject(new Error('timeout: ' + msg.type)); }, timeoutMs || 20000);
        pending.set(reqId, { resolve, reject, timer });
        if (!send({ ...msg, reqId })) { clearTimeout(timer); pending.delete(reqId); reject(new Error('not connected')); }
      });
    }

    function on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => { const s = listeners.get(type); if (s) s.delete(fn); };
    }

    function setHello(patch) { helloData = { ...helloData, ...patch }; send({ type: 'hello', ...helloData }); }

    // Close the port before the page enters the back/forward cache (otherwise Chrome logs
    // "Unchecked runtime.lastError: ...moved into back/forward cache"), and reopen it on restore.
    let suspended = false;
    if (typeof addEventListener === 'function') {
      addEventListener('pagehide', (e) => {
        if (!e.persisted || dead) return;
        suspended = true;
        for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('page suspended')); pending.delete(id); }
        try { port && port.disconnect(); } catch (err) { /* ignore */ }
        port = null;
      });
      addEventListener('pageshow', (e) => { if (e.persisted && suspended && !dead) { suspended = false; backoff = 500; connect(); } });
    }

    function destroy() { dead = true; clearInterval(pingTimer); try { port && port.disconnect(); } catch (e) { /* ignore */ } }

    pingTimer = setInterval(() => { if (port) send({ type: 'ping', t: Date.now() }); }, 20000);
    connect();

    return { send, request, on, ready, setHello, destroy, get connected() { return !!port; }, get dead() { return dead; } };
  }

  root.OrbitBridge = { create: createBridge };
})(typeof globalThis !== 'undefined' ? globalThis : self);
