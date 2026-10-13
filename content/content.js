/* Orbit — content script: the floating dot (launcher) + lazy panel loader.
 *
 * Deliberately tiny: it creates a closed Shadow DOM host with the dot, handles drag/snap,
 * hover peek, context menu, unread badge and status ring, and talks to the background over one
 * port. The full chat UI (ui/*.js) is injected by the background only when the dot is first
 * clicked, so page loads are not slowed down.
 *
 * Works on strict-CSP pages: no inline scripts, no eval, no innerHTML, styles via constructed
 * stylesheets in the shadow root, and zero network access from here.
 */
(function () {
  'use strict';
  if (window.top !== window) return;
  if (window.__orbitInjected) return;
  window.__orbitInjected = true;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  const O = globalThis.ORBIT;
  if (!O || !globalThis.OrbitBridge) return;
  const { KEYS, DEFAULT_SETTINGS, ACCENTS } = O;

  const DOT_CSS = `
:host{all:initial;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483647!important;display:block!important;pointer-events:none}
*,*::before,*::after{box-sizing:border-box}
.wrap{position:fixed;top:50%;z-index:2147483647;pointer-events:auto;--size:16px;--accent:#FF6A1F;--ink:#1C1611;--ring:#8b8579;--idle:.55;--tuck:45%;--panel-w:380px;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;color:#f2ebe0}
.wrap[data-side="right"]{right:0}
.wrap[data-side="left"]{left:0}
.wrap[data-open][data-side="right"]{right:var(--panel-w)}
.wrap[data-open][data-side="left"]{left:var(--panel-w)}
.wrap.snapping{transition:left .3s cubic-bezier(.2,.8,.2,1),right .3s cubic-bezier(.2,.8,.2,1)}
.wrap.slide{transition:left .25s ease-out,right .25s ease-out}
.wrap.hidden{display:none}
.dot{all:unset;position:relative;display:grid;place-items:center;width:calc(var(--size) + 10px);height:calc(var(--size) + 10px);margin:6px;border-radius:50%;cursor:pointer;opacity:var(--idle);transform:translateX(var(--tuck));transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .22s;touch-action:none;user-select:none;-webkit-user-select:none}
.wrap[data-side="left"] .dot{transform:translateX(calc(-1 * var(--tuck)))}
.dot:hover,.dot:focus-visible,.wrap[data-open] .dot,.wrap[data-unread] .dot,.wrap.dragging .dot,.wrap.menu-open .dot{opacity:1;transform:translateX(0) scale(1.25)}
.wrap.dragging .dot{cursor:grabbing;transition:none}
.dot:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.dot::before{content:"";position:absolute;inset:0;border-radius:50%;background:rgba(24,20,16,.92);box-shadow:0 0 0 2px var(--ring),0 2px 10px rgba(0,0,0,.28)}
.wrap[data-unread] .dot::before{animation:orbit-pulse 1.8s ease-in-out infinite}
@keyframes orbit-pulse{0%,100%{box-shadow:0 0 0 2px var(--ring),0 2px 10px rgba(0,0,0,.28),0 0 0 0 color-mix(in srgb,var(--accent) 55%,transparent)}50%{box-shadow:0 0 0 2px var(--ring),0 2px 10px rgba(0,0,0,.28),0 0 0 9px color-mix(in srgb,var(--accent) 0%,transparent)}}
.mark{position:relative;width:var(--size);height:var(--size);overflow:visible;display:block}
.core{fill:var(--accent)}.ringp{fill:none;stroke:var(--accent);stroke-width:2.4;opacity:.85}.sat{fill:var(--accent)}
.badge{position:absolute;top:-5px;right:-7px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:var(--accent);color:var(--ink);font:700 10px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:center;letter-spacing:-.02em;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.badge[hidden]{display:none}
.card{position:absolute;top:50%;transform:translateY(-50%);width:240px;background:#1f1a14;color:#f2ebe0;border:1px solid rgba(255,255,255,.1);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);padding:10px 12px;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}
.wrap[data-side="right"] .card{right:calc(100% + 6px)}
.wrap[data-side="left"] .card{left:calc(100% + 6px)}
.card.show{opacity:1;pointer-events:auto}
.card .k{font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:#a1978a;display:flex;justify-content:space-between;gap:8px;margin-bottom:4px}
.card .k b{color:var(--accent);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .t{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.card .t b{font-weight:600}
.menu{position:absolute;top:50%;transform:translateY(-50%);min-width:210px;background:#1f1a14;color:#f2ebe0;border:1px solid rgba(255,255,255,.1);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);padding:6px;display:none}
.menu.show{display:block}
.wrap[data-side="right"] .menu{right:calc(100% + 6px)}
.wrap[data-side="left"] .menu{left:calc(100% + 6px)}
.menu .h{padding:6px 10px 4px;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#a1978a}
.mi{all:unset;display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border-radius:7px;cursor:pointer;font:13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#f2ebe0}
.mi:hover,.mi:focus-visible{background:rgba(255,255,255,.08);outline:none}
.mi:focus-visible{box-shadow:inset 0 0 0 2px var(--accent)}
.mi .ic{width:14px;height:14px;flex:none;opacity:.8}
.sep{height:1px;background:rgba(255,255,255,.08);margin:4px 6px}
.reduce *,.reduce *::before{animation:none!important;transition:none!important}
`;

  /* ---------------- state ---------------- */
  let settings = { ...DEFAULT_SETTINGS };
  let host, shadow, wrap, dot, badge, peek, peekRoom, peekText, menu, svg;
  let panel = null, panelLoading = null;
  let dotState = { unread: 0, status: 'none', latest: null };
  const hidden = { site: false, until: false, boss: false, fullscreen: false };
  let forceShow = false;
  let observer = null, untilTimer = null, peekTimer = null, dead = false;
  const reduceMq = matchMedia('(prefers-reduced-motion: reduce)');

  const bridge = globalThis.OrbitBridge.create({ context: 'content', host: location.hostname, mode: 'dot' });

  /* ---------------- helpers ---------------- */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) { const el = document.createElementNS(SVG_NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function accentColor() { return settings.accent === 'custom' ? (settings.accentCustom || ACCENTS.tangerine.color) : (ACCENTS[settings.accent] || ACCENTS.tangerine).color; }
  function accentInk() { return settings.accent === 'custom' ? inkFor(settings.accentCustom) : (ACCENTS[settings.accent] || ACCENTS.tangerine).ink; }
  function inkFor(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#1C1611'; const n = parseInt(m[1], 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255; return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1C1611' : '#FFFFFF'; }
  function siteHidden() { const h = location.hostname; return (settings.hiddenSites || []).some((s) => h === s || h.endsWith('.' + s)); }
  function icon(kind) {
    const s = svgEl('svg', { viewBox: '0 0 16 16', class: 'ic', 'aria-hidden': 'true' });
    const p = { eyeoff: 'M2 2l12 12M6.5 6.6A2 2 0 0 0 9.4 9.5M3.2 5.3C2 6.4 1.3 8 1.3 8s2.5 4.7 6.7 4.7c1.1 0 2-.3 2.9-.7M7 3.4c.3 0 .7-.1 1-.1 4.2 0 6.7 4.7 6.7 4.7s-.7 1.3-1.9 2.5', clock: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM8 4.5V8l2.5 1.5', swap: 'M2 5.5h10.5L10 3M14 10.5H3.5L6 13', gear: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zm-5.2 1l-1.3-.9 1.2-2 1.5.5c.4-.3.8-.6 1.3-.8L5.8 1.7h2.4l.3 1.6c.5.2.9.5 1.3.8l1.5-.5 1.2 2-1.3.9v1.6l1.3.9-1.2 2-1.5-.5c-.4.3-.8.6-1.3.8l-.3 1.6H5.8l-.3-1.6c-.5-.2-.9-.5-1.3-.8l-1.5.5-1.2-2 1.3-.9z' }[kind];
    s.appendChild(svgEl('path', { d: p, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return s;
  }

  /* ---------------- build ---------------- */
  function buildMark() {
    svg = svgEl('svg', { viewBox: '0 0 40 40', class: 'mark', 'aria-hidden': 'true' });
    const g = svgEl('g', { transform: 'rotate(-30 20 20)' });
    const ring = svgEl('path', { id: 'orbit-ring', class: 'ringp', d: 'M 3 20 a 17 7 0 1 0 34 0 a 17 7 0 1 0 -34 0' });
    const sat = svgEl('circle', { class: 'sat', cx: '0', cy: '0', r: '3.2' });
    const motion = svgEl('animateMotion', { dur: '3.2s', repeatCount: 'indefinite', rotate: '0' });
    motion.appendChild(svgEl('mpath', { href: '#orbit-ring' }));
    sat.appendChild(motion);
    g.appendChild(ring); g.appendChild(sat);
    svg.appendChild(svgEl('circle', { class: 'core', cx: '20', cy: '20', r: '7.5' }));
    svg.appendChild(g);
    try { svg.pauseAnimations(); svg.setCurrentTime(0.6); } catch (e) { /* ignore */ }
    return svg;
  }

  function mount() {
    if (host && host.isConnected) return;
    if (!host) {
      host = document.createElement('orbit-host');
      host.setAttribute('data-orbit', '');
      Object.assign(host.style, { all: 'initial', position: 'fixed', top: '0', left: '0', width: '0', height: '0', zIndex: '2147483647', display: 'block', pointerEvents: 'none' });
      shadow = host.attachShadow({ mode: 'closed' });
      applyCss(DOT_CSS);

      wrap = el('div', 'wrap');
      wrap.setAttribute('data-side', settings.side);
      dot = el('button', 'dot');
      dot.type = 'button';
      dot.setAttribute('aria-label', `Open ${O.BRAND_NAME} chat`);
      dot.setAttribute('aria-haspopup', 'dialog');
      dot.setAttribute('aria-expanded', 'false');
      dot.title = `${O.BRAND_NAME} — click to chat, drag to move, right-click for options`;
      dot.appendChild(buildMark());
      badge = el('span', 'badge'); badge.hidden = true; badge.setAttribute('aria-live', 'polite');
      dot.appendChild(badge);
      wrap.appendChild(dot);

      peek = el('div', 'card'); peek.setAttribute('role', 'status');
      const k = el('div', 'k'); peekRoom = el('b'); const kk = el('span', null, 'latest'); k.appendChild(peekRoom); k.appendChild(kk);
      peekText = el('div', 't');
      peek.appendChild(k); peek.appendChild(peekText);
      wrap.appendChild(peek);

      menu = buildMenu();
      wrap.appendChild(menu);
      shadow.appendChild(wrap);
      wireDot();
    }
    (document.documentElement || document.body).appendChild(host);
    applySettings();
  }

  function applyCss(css) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
    } catch (e) {
      const st = document.createElement('style'); st.textContent = css; shadow.appendChild(st);
    }
  }

  function buildMenu() {
    const m = el('div', 'menu'); m.setAttribute('role', 'menu');
    m.appendChild(el('div', 'h', O.BRAND_NAME));
    const items = [
      ['eyeoff', 'Hide on this site', () => { const list = new Set(settings.hiddenSites || []); list.add(location.hostname); saveSettings({ hiddenSites: Array.from(list) }); }],
      ['clock', 'Hide everywhere for 1 hour', () => saveSettings({ hideUntil: Date.now() + 3600e3 })],
      ['swap', 'Move to other side', () => setSide(settings.side === 'right' ? 'left' : 'right', true)],
      ['gear', 'Settings', () => { openPanel().then(() => panel && panel.showSettings()); }]
    ];
    items.forEach(([ic, label, fn], i) => {
      if (i === 3) m.appendChild(el('div', 'sep'));
      const b = el('button', 'mi'); b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.appendChild(icon(ic)); b.appendChild(el('span', null, label));
      b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); fn(); });
      m.appendChild(b);
    });
    return m;
  }

  /* ---------------- settings ---------------- */
  async function loadSettings() {
    try { const r = await chrome.storage.local.get([KEYS.SETTINGS]); settings = { ...DEFAULT_SETTINGS, ...(r[KEYS.SETTINGS] || {}) }; } catch (e) { /* ignore */ }
  }
  async function saveSettings(patch) {
    try {
      const r = await chrome.storage.local.get([KEYS.SETTINGS]);
      const next = { ...DEFAULT_SETTINGS, ...(r[KEYS.SETTINGS] || {}), ...patch };
      await chrome.storage.local.set({ [KEYS.SETTINGS]: next });
    } catch (e) { /* ignore */ }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEYS.SETTINGS]) {
      const prev = settings;
      settings = { ...DEFAULT_SETTINGS, ...(changes[KEYS.SETTINGS].newValue || {}) };
      if (prev.side !== settings.side && wrap) { wrap.setAttribute('data-side', settings.side); }
      applySettings();
    }
  });

  function applySettings() {
    if (!wrap) return;
    wrap.style.setProperty('--size', settings.dotSize + 'px');
    wrap.style.setProperty('--accent', accentColor());
    wrap.style.setProperty('--ink', accentInk());
    wrap.style.setProperty('--idle', String(settings.dotIdleOpacity));
    wrap.style.setProperty('--panel-w', (settings.panelWidth || 380) + 'px');
    wrap.classList.toggle('reduce', !!settings.reduceMotion || reduceMq.matches);
    if (!wrap.classList.contains('dragging')) {
      wrap.setAttribute('data-side', settings.side);
      positionDot();
    }
    hidden.site = siteHidden();
    hidden.until = settings.hideUntil > Date.now();
    clearTimeout(untilTimer);
    if (hidden.until) untilTimer = setTimeout(() => { hidden.until = false; applyHidden(); }, Math.min(settings.hideUntil - Date.now() + 50, 2147000000));
    applyHidden();
  }
  function positionDot() {
    const h = innerHeight; const y = Math.min(Math.max(28, settings.dotY * h), h - 28);
    wrap.style.top = y + 'px';
    wrap.style.transform = 'translateY(-50%)';
  }
  function applyHidden() {
    const isHidden = hidden.boss || hidden.fullscreen || ((hidden.site || hidden.until) && !forceShow);
    if (wrap) wrap.classList.toggle('hidden', isHidden);
    if (isHidden && panel && panel.isOpen()) panel.close();
  }
  addEventListener('resize', () => { if (wrap && !wrap.classList.contains('dragging')) positionDot(); }, { passive: true });

  /* ---------------- dot interactions ---------------- */
  function wireDot() {
    let startX = 0, startY = 0, dragging = false, pointerId = null, moved = false;
    dot.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pointerId = e.pointerId; startX = e.clientX; startY = e.clientY; dragging = false; moved = false;
      dot.setPointerCapture(pointerId);
      closeMenu(); hidePeek();
    });
    dot.addEventListener('pointermove', (e) => {
      if (pointerId !== e.pointerId) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > 4) {
        dragging = true; moved = true;
        wrap.classList.add('dragging'); wrap.classList.remove('snapping', 'slide');
        wrap.style.right = 'auto';
      }
      if (dragging) {
        const size = settings.dotSize + 22;
        wrap.style.left = Math.min(Math.max(0, e.clientX - size / 2), innerWidth - size) + 'px';
        wrap.style.top = Math.min(Math.max(28, e.clientY), innerHeight - 28) + 'px';
      }
    });
    const finish = (e) => {
      if (pointerId !== e.pointerId) return;
      try { dot.releasePointerCapture(pointerId); } catch (err) { /* ignore */ }
      pointerId = null;
      if (!dragging) { if (e.type === 'pointerup') togglePanel(); return; }
      dragging = false;
      const side = e.clientX < innerWidth / 2 ? 'left' : 'right';
      const size = settings.dotSize + 22;
      const y = Math.min(Math.max(28, e.clientY), innerHeight - 28) / innerHeight;
      // Snap animation: animate `left` to the edge, then hand over to side-based positioning.
      wrap.classList.add('snapping');
      requestAnimationFrame(() => {
        wrap.style.left = (side === 'left' ? 0 : innerWidth - size) + 'px';
        const done = () => {
          wrap.removeEventListener('transitionend', done);
          wrap.classList.remove('snapping', 'dragging');
          wrap.style.left = ''; wrap.style.right = '';
          settings.side = side; settings.dotY = y;
          wrap.setAttribute('data-side', side);
          positionDot();
          if (panel) panel.setSide(side);
        };
        wrap.addEventListener('transitionend', done);
        setTimeout(done, 400);
      });
      saveSettings({ side, dotY: y });
    };
    dot.addEventListener('pointerup', finish);
    dot.addEventListener('pointercancel', finish);
    dot.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (moved) { moved = false; } });
    dot.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(); } if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); openMenu(); } });
    dot.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openMenu(); });
    dot.addEventListener('mouseenter', () => {
      if (!settings.reduceMotion && !reduceMq.matches) { try { svg.unpauseAnimations(); } catch (e) { /* ignore */ } }
      if (settings.peek && dotState.latest && !(panel && panel.isOpen())) { clearTimeout(peekTimer); peekTimer = setTimeout(showPeek, 450); }
    });
    dot.addEventListener('mouseleave', () => { clearTimeout(peekTimer); hidePeek(); if (!dotState.unread) { try { svg.pauseAnimations(); } catch (e) { /* ignore */ } } });
    document.addEventListener('pointerdown', (e) => { if (menu.classList.contains('show') && e.composedPath && !e.composedPath().includes(menu)) closeMenu(); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.classList.contains('show')) { closeMenu(); dot.focus(); } }, true);
  }

  function showPeek() {
    if (!dotState.latest) return;
    peekRoom.textContent = '#' + (dotState.latest.roomName || '');
    peekText.textContent = '';
    const b = el('b', null, (dotState.latest.senderName || '') + ': ');
    peekText.appendChild(b); peekText.appendChild(document.createTextNode(dotState.latest.text || ''));
    peek.classList.add('show');
  }
  function hidePeek() { peek.classList.remove('show'); }
  function openMenu() { hidePeek(); menu.classList.add('show'); wrap.classList.add('menu-open'); const first = menu.querySelector('.mi'); if (first) first.focus(); }
  function closeMenu() { menu.classList.remove('show'); wrap.classList.remove('menu-open'); }

  function setSide(side, save) {
    settings.side = side;
    wrap.classList.add('slide'); wrap.setAttribute('data-side', side);
    setTimeout(() => wrap.classList.remove('slide'), 300);
    if (panel) panel.setSide(side);
    if (save) saveSettings({ side });
  }

  function renderDot() {
    if (!wrap) return;
    const ringColor = dotState.status === 'connected' ? '#3ddc84' : dotState.status === 'connecting' ? '#ffb020' : '#8b8579';
    wrap.style.setProperty('--ring', ringColor);
    const open = panel && panel.isOpen();
    const n = open ? 0 : dotState.unread;
    badge.hidden = !n; badge.textContent = n > 99 ? '99+' : String(n);
    if (n) wrap.setAttribute('data-unread', ''); else wrap.removeAttribute('data-unread');
    const animate = n > 0 && !settings.reduceMotion && !reduceMq.matches;
    try { if (animate) svg.unpauseAnimations(); else if (!dot.matches(':hover')) svg.pauseAnimations(); } catch (e) { /* ignore */ }
    dot.setAttribute('aria-label', `${open ? 'Close' : 'Open'} ${O.BRAND_NAME} chat${n ? `, ${n} unread` : ''}`);
  }

  /* ---------------- panel ---------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function ensurePanel() {
    if (panel) return panel;
    if (!panelLoading) {
      panelLoading = (async () => {
        const res = await bridge.request({ type: 'load-panel' }, 30000);
        let tries = 0;
        while (!globalThis.OrbitPanel && tries++ < 150) await sleep(20);
        if (!globalThis.OrbitPanel) throw new Error('panel UI failed to load');
        if (res.css) applyCss(res.css);
        panel = globalThis.OrbitPanel.mount({
          root: shadow, bridge,
          env: { context: 'content', host: location.hostname, url: location.href },
          hooks: {
            onOpenChange(open) {
              if (open) wrap.setAttribute('data-open', ''); else wrap.removeAttribute('data-open');
              dot.setAttribute('aria-expanded', String(open));
              if (open) hidePeek();
              renderDot();
            },
            onSideChange(side) { setSide(side, false); },
            onWidthChange(w) { wrap.style.setProperty('--panel-w', w + 'px'); },
            focusDot() { dot.focus(); }
          }
        });
        bridge.setHello({ mode: 'panel' });
        return panel;
      })().catch((e) => { panelLoading = null; throw e; });
    }
    return panelLoading;
  }
  async function openPanel() { const p = await ensurePanel(); forceShow = true; applyHidden(); p.open(); return p; }
  async function togglePanel() {
    if (dead) return;
    if (panel && panel.isOpen()) { panel.close(); return; }
    try { await openPanel(); } catch (e) { console.warn('[Orbit] cannot open panel here:', e && e.message); }
  }

  /* ---------------- bridge events ---------------- */
  bridge.on('hello-ack', (m) => { if (m.dot) dotState = m.dot; hidden.boss = !!m.boss; renderDot(); applyHidden(); });
  bridge.on('dot', (m) => { dotState = { unread: m.unread, status: m.status, latest: m.latest }; renderDot(); });
  bridge.on('toggle', () => { forceShow = true; applyHidden(); togglePanel(); });
  bridge.on('boss', (m) => { hidden.boss = !!m.on; applyHidden(); });
  bridge.on('open-room', (m) => { forceShow = true; applyHidden(); openPanel().then((p) => p.openRoom(m.roomId)).catch(() => {}); });
  bridge.on('dead', () => { dead = true; try { if (host) host.remove(); } catch (e) { /* ignore */ } if (observer) observer.disconnect(); });

  /* ---------------- page integration ---------------- */
  document.addEventListener('fullscreenchange', () => {
    hidden.fullscreen = !!document.fullscreenElement && settings.autoHideFullscreen;
    applyHidden();
  });
  document.addEventListener('visibilitychange', () => { if (panel) panel.setVisible(!document.hidden); });
  addEventListener('pagehide', () => { if (panel) panel.setVisible(false); });

  // Re-attach if the page rewrites the DOM (SPA frameworks, "clean-up" scripts).
  function watch() {
    let pending = false;
    observer = new MutationObserver(() => {
      if (dead || pending) return;
      if (!host.isConnected) { pending = true; setTimeout(() => { pending = false; if (!dead && !host.isConnected) mount(); }, 50); }
    });
    observer.observe(document.documentElement, { childList: true });
  }

  (async () => {
    await loadSettings();
    mount();
    watch();
    hidden.fullscreen = !!document.fullscreenElement && settings.autoHideFullscreen;
    applyHidden();
  })();
})();
