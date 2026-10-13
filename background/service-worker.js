/* Orbit — background service worker (MV3).
 *
 * Responsibilities (and nothing else — networking lives in the offscreen document):
 *   • Own the offscreen document lifecycle (create it, re-create it if it disappears).
 *   • Act as the message hub: UI ports (content scripts / side panel) ⇄ offscreen document.
 *   • Keyboard commands, toolbar action, badge, desktop notifications, side-panel fallback.
 *   • Lazy-inject the heavy panel UI into a tab the first time the dot is clicked.
 *   • Storage schema migrations + mirroring lightweight settings to chrome.storage.sync.
 *
 * Permissions used here (see manifest.json):
 *   storage (settings/profile/rooms), offscreen (persistent networking host), sidePanel (fallback UI),
 *   notifications (desktop alerts), alarms (30s heartbeat to keep the offscreen doc alive),
 *   scripting (lazy UI injection + injecting into tabs that were open before install),
 *   unlimitedStorage (IndexedDB history/images are not evicted under storage pressure).
 */
'use strict';
importScripts('../shared/brand.js');

const { KEYS, DEFAULT_SETTINGS, DEFAULT_PROFILE, SYNC_KEYS, PORT_NAME, RESTRICTED_URL_RE, ACCENTS, BRAND_NAME } = ORBIT;

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const CONTENT_FILES = ['shared/brand.js', 'shared/bridge.js', 'content/content.js'];
const UI_FILES = ['shared/brand.js', 'ui/strings.js', 'ui/emoji-data.js', 'ui/ui-kit.js', 'ui/panel-settings.js', 'ui/panel.js'];
const KEEPALIVE_ALARM = 'orbit-keepalive';

/* ------------------------------------------------------------------ */
/* Small utils                                                          */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.debug('[Orbit/sw]', ...a);

async function getLocal(keys) { return chrome.storage.local.get(keys); }
async function getSettings() {
  const { [KEYS.SETTINGS]: s } = await getLocal([KEYS.SETTINGS]);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}
async function getProfile() {
  const { [KEYS.PROFILE]: p } = await getLocal([KEYS.PROFILE]);
  return { ...DEFAULT_PROFILE, ...(p || {}) };
}
function isRestrictedUrl(url) { return !url || RESTRICTED_URL_RE.test(url); }

function isQuietNow(settings) {
  const d = settings.dndSchedule;
  if (!d || !d.enabled) return false;
  const toMin = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const now = new Date(); const cur = now.getHours() * 60 + now.getMinutes();
  const a = toMin(d.start), b = toMin(d.end);
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

/* ------------------------------------------------------------------ */
/* Offscreen document lifecycle                                         */
/* ------------------------------------------------------------------ */
let creatingOffscreen = null;
let offscreenReady = false;

async function hasOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  } catch (e) {
    // Very old Chrome: fall back to clients.matchAll
    const url = chrome.runtime.getURL(OFFSCREEN_URL);
    const all = await self.clients.matchAll();
    return all.some((c) => c.url === url);
  }
}

async function waitForOffscreenReady(timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (!offscreenReady && Date.now() < end) await sleep(100);
  if (!offscreenReady) throw new Error('Orbit networking is still starting. Retry in a moment; inspect the offscreen.html console if this persists.');
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) {
    // A document can exist while its module graph is still loading. Do not send
    // commands until its ready handshake arrives, or Chrome reports no receiver.
    if (!offscreenReady) await waitForOffscreenReady();
    return;
  }
  if (creatingOffscreen) { await creatingOffscreen; if (!offscreenReady) await waitForOffscreenReady(); return; }
  offscreenReady = false;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // WEB_RTC: this document hosts every RTCPeerConnection. AUDIO_PLAYBACK: synthesized notification sounds.
    reasons: ['WEB_RTC', 'AUDIO_PLAYBACK'],
    justification: 'Hosts the peer-to-peer chat connections (WebRTC + signaling) and plays notification sounds; page CSPs would otherwise block them.'
  }).catch((e) => {
    if (!/single offscreen|already exists/i.test(String(e && e.message))) throw e;
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
  await waitForOffscreenReady();
  log('offscreen ensured and ready');
}

async function callOffscreen(msg) {
  let lastErr;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      await ensureOffscreen();
      const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
      if (res && res.error) throw new Error(res.error);
      return res;
    } catch (e) {
      lastErr = e;
      const m = String(e && e.message || e);
      if (!/Receiving end does not exist|message port closed|could not establish|networking is still starting/i.test(m)) throw e;
      offscreenReady = false;
      await sleep(Math.min(1800, 250 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('Orbit networking is unavailable; reload the extension and try again.');
}

/* ------------------------------------------------------------------ */
/* UI ports                                                             */
/* ------------------------------------------------------------------ */
const ports = new Map(); // portId -> { port, tabId, windowId, context, host, mode }
let portSeq = 0;
let bossOn = false;
chrome.storage.session.get('boss').then((r) => { bossOn = !!(r && r.boss); }).catch(() => {});

function postTo(entry, msg) { try { entry.port.postMessage(msg); } catch (e) { /* port gone */ } }
function broadcast(msg, filter) {
  for (const entry of ports.values()) {
    if (filter && !filter(entry)) continue;
    postTo(entry, msg);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const id = 'p' + (++portSeq) + '_' + Math.random().toString(36).slice(2, 7);
  const sender = port.sender || {};
  const entry = {
    port, id,
    tabId: sender.tab ? sender.tab.id : null,
    windowId: sender.tab ? sender.tab.windowId : null,
    context: 'content', host: '', mode: 'dot'
  };
  ports.set(id, entry);

  port.onMessage.addListener((msg) => { handlePortMessage(entry, msg).catch((e) => {
    if (msg && msg.reqId) postTo(entry, { reqId: msg.reqId, error: String(e && e.message || e) });
    else log('port msg error', e);
  }); });

  port.onDisconnect.addListener(() => {
    ports.delete(id);
    callOffscreen({ cmd: 'ui:gone', portId: id }).catch(() => {});
  });
});

async function handlePortMessage(entry, msg) {
  if (!msg || typeof msg !== 'object') return;
  const { type, reqId } = msg;

  if (type === 'ping') { postTo(entry, { type: 'pong', t: Date.now() }); return; }

  if (type === 'hello') {
    entry.context = msg.context || 'content';
    entry.host = msg.host || '';
    entry.mode = msg.mode || 'dot';
    const snapshot = await callOffscreen({ cmd: 'ui:hello', portId: entry.id, context: entry.context, mode: entry.mode, tabId: entry.tabId });
    postTo(entry, { type: 'hello-ack', portId: entry.id, boss: bossOn, ...(snapshot || {}) });
    return;
  }

  if (type === 'load-panel') {
    // Lazy-load the heavy UI into this tab. Done by the browser, so page CSP cannot block it.
    if (entry.tabId != null) {
      await chrome.scripting.executeScript({ target: { tabId: entry.tabId }, files: UI_FILES });
    }
    const css = await getPanelCss();
    postTo(entry, { reqId, ok: true, css });
    return;
  }

  if (type === 'link:preview') {
    const data = await fetchLinkPreview(msg.url);
    postTo(entry, { reqId, ...data });
    return;
  }

  if (type === 'open-url') {
    // Content scripts cannot use chrome.tabs, so the panel asks us to open links (About → GitHub…).
    const url = String(msg.url || '');
    if (!/^https?:\/\//i.test(url)) { if (reqId) postTo(entry, { reqId, error: 'blocked url' }); return; }
    try { await chrome.tabs.create({ url }); postTo(entry, { reqId, ok: true }); }
    catch (e) { if (reqId) postTo(entry, { reqId, error: String(e && e.message || e) }); }
    return;
  }

  if (type === 'open-sidepanel') {
    try { await chrome.sidePanel.open({ tabId: entry.tabId }); } catch (e) { /* needs gesture */ }
    postTo(entry, { reqId, ok: true });
    return;
  }

  if (type === 'boss:toggle') { await toggleBoss(); if (reqId) postTo(entry, { reqId, ok: true, boss: bossOn }); return; }

  if (type === 'data:reset') {
    // "Clear all local data": leave rooms + wipe IndexedDB (offscreen), wipe storage, re-seed defaults,
    // then restart the offscreen document so it boots with the fresh identity.
    try { await callOffscreen({ cmd: 'data:clearAll' }); } catch (e) { /* offscreen may be gone */ }
    await chrome.storage.local.clear();
    try { await chrome.storage.sync.clear(); } catch (e) { /* ignore */ }
    await migrate();
    try { await chrome.offscreen.closeDocument(); } catch (e) { /* not open */ }
    offscreenReady = false;
    await setBadge(0);
    postTo(entry, { reqId, ok: true });
    return;
  }

  // Everything else goes to the offscreen document (room commands, profile, images...)
  const res = await callOffscreen({ cmd: type, portId: entry.id, ...msg, reqId: undefined });
  if (reqId) postTo(entry, { reqId, ...(res || {}) });
}

let cssCache = null;
async function getPanelCss() {
  if (cssCache) return cssCache;
  const res = await fetch(chrome.runtime.getURL('ui/panel.css'));
  cssCache = await res.text();
  return cssCache;
}

/* ------------------------------------------------------------------ */
/* Messages from the offscreen document                                 */
/* ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'sw') return;
  switch (msg.type) {
    case 'storage:broker': {
      const areaName = msg.area === 'sync' ? 'sync' : 'local';
      const area = chrome.storage[areaName];
      if (!area || !['get', 'set', 'clear'].includes(msg.method)) { sendResponse({ error: 'Unsupported storage operation' }); return; }
      Promise.resolve().then(() => msg.method === 'get' ? area.get(msg.value) : msg.method === 'set' ? area.set(msg.value || {}) : area.clear())
        .then((result) => sendResponse(result || { ok: true }), (e) => sendResponse({ error: String(e && e.message || e) }));
      return true;
    }
    case 'ready': offscreenReady = true; sendResponse({ boss: bossOn }); rehelloAll(); return;
    case 'hb': sendResponse({ ok: true }); return;
    case 'event': {
      const ev = msg.event || {};
      if (msg.to) { const e = ports.get(msg.to); if (e) postTo(e, ev); }
      else if (msg.scope === 'panel') broadcast(ev, (e) => e.mode === 'panel');
      else broadcast(ev);
      sendResponse({ ok: true }); return;
    }
    case 'badge': setBadge(msg.count | 0); sendResponse({ ok: true }); return;
    case 'notify': showNotification(msg).catch((e) => log('notify failed', e)); sendResponse({ ok: true }); return;
    case 'colorScheme': applyToolbarIcon(msg.dark).catch(() => {}); sendResponse({ ok: true }); return;
    case 'getBoss': sendResponse({ boss: bossOn }); return;
    default: return;
  }
});

// The offscreen document (re)booted: re-register every live UI port so pushes keep flowing and
// hand each UI a fresh snapshot (panels re-sync their room list from the hello-ack).
async function rehelloAll() {
  for (const entry of Array.from(ports.values())) {
    if (!entry.context) continue; // its own hello has not arrived yet
    try {
      const snapshot = await callOffscreen({ cmd: 'ui:hello', portId: entry.id, context: entry.context, mode: entry.mode, tabId: entry.tabId });
      postTo(entry, { type: 'hello-ack', portId: entry.id, boss: bossOn, ...(snapshot || {}) });
    } catch (e) { /* port may be gone */ }
  }
}

async function setBadge(count) {
  try {
    await chrome.action.setBadgeText({ text: count > 0 ? (count > 99 ? '99+' : String(count)) : '' });
    const settings = await getSettings();
    const accent = settings.accent === 'custom' ? settings.accentCustom : (ACCENTS[settings.accent] || ACCENTS.tangerine).color;
    await chrome.action.setBadgeBackgroundColor({ color: accent });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#1C1611' });
  } catch (e) { /* ignore */ }
}

let lastDarkScheme = null;
async function applyToolbarIcon(dark) {
  if (typeof dark === 'boolean') lastDarkScheme = dark;
  const settings = await getSettings();
  const mono = settings.toolbarIcon === 'mono';
  const prefix = mono ? (lastDarkScheme ? 'icons/mono-dark-' : 'icons/mono-light-') : 'icons/icon-';
  await chrome.action.setIcon({ path: { 16: prefix + '16.png', 32: prefix + '32.png', 48: prefix + '48.png', 128: prefix + '128.png' } });
}

/* ------------------------------------------------------------------ */
/* Notifications                                                        */
/* ------------------------------------------------------------------ */
async function showNotification({ roomId, roomName, title, body, mention }) {
  if (bossOn) return;
  const settings = await getSettings();
  if (!settings.notifications && !mention) return;
  const profile = await getProfile();
  if (profile.presence === 'dnd') return;
  if (isQuietNow(settings) && !mention) return;
  const id = `orbit:${roomId}:${Date.now()}`;
  await chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: title || `${BRAND_NAME} · ${roomName || 'room'}`,
    message: String(body || '').slice(0, 300),
    contextMessage: roomName ? `#${roomName}` : undefined,
    silent: true, // sounds are synthesized by the offscreen document (user-selectable)
    priority: mention ? 2 : 0
  });
  setTimeout(() => chrome.notifications.clear(id).catch(() => {}), 15000);
}

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id).catch(() => {});
  const roomId = String(id).split(':')[1];
  await openRoomSomewhere(roomId);
});

async function openRoomSomewhere(roomId) {
  // Prefer a content-script tab in the last focused window, then any tab, then the side panel.
  let candidates = Array.from(ports.values()).filter((e) => e.context === 'content' && e.tabId != null);
  if (candidates.length) {
    let win = null;
    try { win = await chrome.windows.getLastFocused(); } catch (e) { /* ignore */ }
    const inWin = win ? candidates.filter((e) => e.windowId === win.id) : [];
    let target = null;
    if (inWin.length) {
      const tabs = await chrome.tabs.query({ active: true, windowId: win.id });
      target = inWin.find((e) => tabs.some((t) => t.id === e.tabId)) || inWin[0];
    } else target = candidates[0];
    try {
      await chrome.tabs.update(target.tabId, { active: true });
      await chrome.windows.update(target.windowId, { focused: true });
    } catch (e) { /* ignore */ }
    postTo(target, { type: 'open-room', roomId });
    return;
  }
  try {
    const win = await chrome.windows.getLastFocused();
    await chrome.sidePanel.open({ windowId: win.id });
    setTimeout(() => broadcast({ type: 'open-room', roomId }, (e) => e.context === 'sidepanel'), 800);
  } catch (e) { log('cannot open side panel without gesture', e); }
}

/* ------------------------------------------------------------------ */
/* Toolbar action + commands + side panel fallback                      */
/* ------------------------------------------------------------------ */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

function portsForTab(tabId) { return Array.from(ports.values()).filter((e) => e.tabId === tabId && e.context === 'content'); }

async function toggleInTab(tab) {
  if (!tab) return false;
  if (isRestrictedUrl(tab.url)) {
    await chrome.sidePanel.open({ tabId: tab.id });
    return true;
  }
  const entries = portsForTab(tab.id);
  if (entries.length) { entries.forEach((e) => postTo(e, { type: 'toggle' })); return true; }
  // Content script not present (tab predates install?) — inject it, then toggle.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    await sleep(250);
    const again = portsForTab(tab.id);
    if (again.length) { again.forEach((e) => postTo(e, { type: 'toggle' })); return true; }
  } catch (e) { log('inject failed, falling back to side panel', e); }
  try { await chrome.sidePanel.open({ tabId: tab.id }); return true; } catch (e) { log('sidePanel.open failed', e); }
  return false;
}

chrome.action.onClicked.addListener((tab) => { toggleInTab(tab).catch((e) => log('action failed', e)); });

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'boss-key') { await toggleBoss(); return; }
  if (command === 'toggle-panel') {
    let t = tab;
    if (!t) { const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); t = tabs[0]; }
    await toggleInTab(t);
  }
});

async function toggleBoss() {
  bossOn = !bossOn;
  await chrome.storage.session.set({ boss: bossOn }).catch(() => {});
  broadcast({ type: 'boss', on: bossOn });
  callOffscreen({ cmd: 'boss', on: bossOn }).catch(() => {});
  if (bossOn) await chrome.action.setBadgeText({ text: '' }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Link previews (opt-in; fetched by the extension, never by the page)  */
/* ------------------------------------------------------------------ */
async function fetchLinkPreview(url) {
  try {
    const settings = await getSettings();
    if (!settings.linkPreviews) return { error: 'disabled' };
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { error: 'bad-protocol' };
    const res = await fetch(u.href, { redirect: 'follow', credentials: 'omit', signal: AbortSignal.timeout(7000) });
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html/i.test(ct)) return { error: 'not-html' };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let html = '';
    while (html.length < 200000) {
      const { value, done } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
    }
    try { reader.cancel(); } catch (e) { /* ignore */ }
    const meta = (prop) => {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
      const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
      const m = html.match(re) || html.match(re2);
      return m ? decodeEntities(m[1]) : '';
    };
    const t = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    let image = meta('og:image') || meta('twitter:image');
    if (image) { try { image = new URL(image, u.href).href; if (!/^https?:/.test(image)) image = ''; } catch (e) { image = ''; } }
    return {
      url: u.href,
      title: (meta('og:title') || (t ? decodeEntities(t[1]) : '') || u.hostname).trim().slice(0, 140),
      description: (meta('og:description') || meta('description') || '').trim().slice(0, 240),
      image, site: u.hostname
    };
  } catch (e) { return { error: String(e && e.message || e) }; }
}
function decodeEntities(s) {
  return String(s).replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' }[k]))
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)));
}

/* ------------------------------------------------------------------ */
/* Install / startup / migrations / settings sync                       */
/* ------------------------------------------------------------------ */
async function migrate() {
  const cur = await getLocal(null);
  const version = cur[KEYS.SCHEMA] || 0;
  const patch = {};
  if (!cur[KEYS.USER_ID]) {
    // Random per-install identity: never derived from IP, hardware or account data.
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    patch[KEYS.USER_ID] = 'u' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (!cur[KEYS.SETTINGS]) patch[KEYS.SETTINGS] = { ...DEFAULT_SETTINGS };
  if (!cur[KEYS.PROFILE]) {
    const adjectives = ['Quiet', 'Bright', 'Swift', 'Cosmic', 'Tiny', 'Lucky', 'Warm', 'Bold'];
    const nouns = ['Comet', 'Moon', 'Orbit', 'Nova', 'Photon', 'Quasar', 'Meteor', 'Pulsar'];
    const name = adjectives[Math.floor(Math.random() * adjectives.length)] + ' ' + nouns[Math.floor(Math.random() * nouns.length)];
    patch[KEYS.PROFILE] = { ...DEFAULT_PROFILE, name };
  }
  if (!cur[KEYS.ROOMS]) patch[KEYS.ROOMS] = [];
  // ---- migration hook: bump ORBIT.DEFAULT_SETTINGS.schemaVersion and add steps here ----
  // if (version < 2) { ...transform cur[KEYS.SETTINGS]...; }
  if (version !== DEFAULT_SETTINGS.schemaVersion) patch[KEYS.SCHEMA] = DEFAULT_SETTINGS.schemaVersion;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  // fill in any new default settings keys
  const s = await getSettings();
  await chrome.storage.local.set({ [KEYS.SETTINGS]: s });
  // merge synced lightweight settings
  try {
    const { settingsSync } = await chrome.storage.sync.get('settingsSync');
    if (settingsSync && typeof settingsSync === 'object') {
      const merged = { ...s };
      for (const k of SYNC_KEYS) if (k in settingsSync) merged[k] = settingsSync[k];
      await chrome.storage.local.set({ [KEYS.SETTINGS]: merged });
    }
  } catch (e) { /* sync unavailable */ }
}

let syncTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (offscreenReady) chrome.runtime.sendMessage({ target: 'offscreen', type: 'storage:changed', changes, area }).catch(() => {});
  if (area !== 'local') return;
  if (changes[KEYS.SETTINGS]) {
    const s = changes[KEYS.SETTINGS].newValue || {};
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      const subset = {};
      for (const k of SYNC_KEYS) if (k in s) subset[k] = s[k];
      chrome.storage.sync.set({ settingsSync: subset }).catch(() => {});
    }, 1500);
    applyToolbarIcon().catch(() => {});
    setBadgeFromOffscreen();
  }
});
function setBadgeFromOffscreen() { callOffscreen({ cmd: 'badge:refresh' }).catch(() => {}); }

async function injectIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id || isRestrictedUrl(t.url)) continue;
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: CONTENT_FILES }).catch(() => {});
    }
  } catch (e) { /* ignore */ }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await migrate();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  await ensureOffscreen();
  if (details.reason === 'install' || details.reason === 'update') injectIntoOpenTabs();
  applyToolbarIcon().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  await migrate();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  await ensureOffscreen();
  applyToolbarIcon().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) ensureOffscreen().catch((e) => log('keepalive ensure failed', e));
});

// Every time the worker (re)starts make sure the offscreen document exists.
(async () => {
  try {
    await migrate();
    chrome.alarms.get(KEEPALIVE_ALARM).then((a) => { if (!a) chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); });
    await ensureOffscreen();
  } catch (e) { log('startup error', e); }
})();
