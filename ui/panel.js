/* Orbit — the chat panel (core): shell, rooms screen, room screen, composer, images, lightbox.
 * Mounted either inside the content script's closed shadow root or in the side panel page:
 *   OrbitPanel.mount({ root, bridge, env: {context:'content'|'sidepanel', host}, hooks })
 * Profile / settings / diagnostics / onboarding screens live in ui/panel-settings.js.
 * The UI never touches the network: every action is a message to the background bridge.
 */
(function (root) {
  'use strict';
  if (root.OrbitPanel) return;
  const O = root.ORBIT, K = root.OrbitKit, t = root.OrbitStrings.t;
  const { h, icon, clear, clamp } = K;
  const { KEYS, DEFAULT_SETTINGS, DEFAULT_PROFILE, LIMITS } = O;
  const RENDER_STEP = 100, RENDER_INITIAL = 150, GROUP_GAP_MS = 5 * 60000;
  const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '😮'];

  function mount(opts) {
    const app = createApp(opts);
    return app.controller;
  }

  function createApp({ root: mountRoot, bridge, env, hooks }) {
    hooks = hooks || {};
    const isEmbedded = env.context === 'sidepanel';
    const app = { bridge, env, hooks, t, K, O, isEmbedded };
    const S = app.state = {
      settings: { ...DEFAULT_SETTINGS }, profile: { ...DEFAULT_PROFILE }, roomsList: [], stickers: [], recentEmoji: [], userId: null,
      live: new Map(), msgs: new Map(), view: 'rooms', roomId: null, open: isEmbedded, visible: !document.hidden,
      membersOpen: false, compose: new Map(), search: null, imgCache: new Map(), assetCache: new Map(), leaving: new Set(), renderLimit: new Map()
    };
    const el = app.el = {};
    let themeMq = matchMedia('(prefers-color-scheme: dark)');
    const reduceMq = matchMedia('(prefers-reduced-motion: reduce)');

    /* ============================================================ */
    /* Shell                                                        */
    /* ============================================================ */
    el.root = h('div', { class: 'o-root' });
    el.backdrop = h('div', { class: 'o-backdrop', on: { click: () => close() } });
    el.panel = h('div', { class: 'o-panel' + (isEmbedded ? ' embedded' : ''), role: 'dialog', 'aria-modal': isEmbedded ? 'false' : 'true', 'aria-label': t('brand'), tabindex: '-1' });
    el.grain = h('div', { class: 'o-grain', 'aria-hidden': 'true' });
    el.resize = h('div', { class: 'o-resize', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': t('panel_width'), tabindex: '0' });
    el.head = h('header', { class: 'o-head' });
    el.screen = h('div', { class: 'o-screen' });
    el.toasts = h('div', { class: 'o-toasts', role: 'status', 'aria-live': 'polite' });
    el.panel.append(el.grain, el.head, el.screen, el.toasts);
    if (!isEmbedded) el.panel.appendChild(el.resize);
    el.root.append(el.backdrop, el.panel);
    mountRoot.appendChild(el.root);
    if (isEmbedded) el.panel.setAttribute('data-open', '');

    function buildHead() {
      clear(el.head);
      const brand = h('div', { class: 'o-brand' }, K.orbitMark(20), h('div', { class: 'o-grow', style: { minWidth: '0' } }, h('div', { class: 'o-brand-title' }, t('brand')), el.headSub = h('div', { class: 'o-brand-sub' }, t('rooms_title'))));
      const actions = h('div', { class: 'o-head-actions' });
      if (!isEmbedded) {
        actions.appendChild(el.pinBtn = h('button', { class: 'o-ibtn' + (S.settings.pinned ? ' on' : ''), title: t('pin_open'), 'aria-label': t('pin_open'), 'aria-pressed': String(!!S.settings.pinned), on: { click: () => { saveSettings({ pinned: !S.settings.pinned }); } } }, icon('pin', 17)));
      }
      actions.appendChild(el.compactBtn = h('button', { class: 'o-ibtn' + (S.settings.compact ? ' on' : ''), title: t('compact'), 'aria-label': t('compact'), 'aria-pressed': String(!!S.settings.compact), on: { click: () => saveSettings({ compact: !S.settings.compact }) } }, icon('minimize', 17)));
      actions.appendChild(h('button', { class: 'o-ibtn', title: t('settings'), 'aria-label': t('settings'), on: { click: () => navigate('settings') } }, icon('settings', 17)));
      actions.appendChild(el.avatarBtn = h('button', { class: 'o-ibtn', title: t('profile'), 'aria-label': t('profile'), on: { click: () => navigate('profile') } }, K.avatarNode({ avatar: S.profile.avatar, name: S.profile.name, userId: S.userId }, 24)));
      if (!isEmbedded) actions.appendChild(h('button', { class: 'o-ibtn', title: t('close') + ' (Esc)', 'aria-label': t('close'), on: { click: () => close() } }, icon('close', 18)));
      el.head.append(brand, actions);
      wireHeadDrag();
    }
    function refreshAvatarBtn() { if (el.avatarBtn) { clear(el.avatarBtn); el.avatarBtn.appendChild(K.avatarNode({ avatar: S.profile.avatar, name: S.profile.name, userId: S.userId }, 24)); } }

    // Drag the header horizontally to move the panel to the other side.
    function wireHeadDrag() {
      if (isEmbedded) return;
      let startX = 0, id = null, moved = false;
      el.head.addEventListener('pointerdown', (e) => { if (e.button !== 0 || e.target.closest('button')) return; id = e.pointerId; startX = e.clientX; moved = false; el.head.setPointerCapture(id); });
      el.head.addEventListener('pointermove', (e) => { if (id !== e.pointerId) return; if (Math.abs(e.clientX - startX) > 6) moved = true; if (moved) el.panel.style.transform = `translateX(${e.clientX - startX}px)`; });
      const end = (e) => {
        if (id !== e.pointerId) return; try { el.head.releasePointerCapture(id); } catch (err) { /* ignore */ } id = null;
        el.panel.style.transform = '';
        if (!moved) return;
        const targetSide = e.clientX < innerWidth / 2 ? 'left' : 'right';
        if (targetSide !== S.settings.side) { setSide(targetSide); saveSettings({ side: targetSide }); if (hooks.onSideChange) hooks.onSideChange(targetSide); }
      };
      el.head.addEventListener('pointerup', end); el.head.addEventListener('pointercancel', end);
    }
    // Resize handle
    if (!isEmbedded) {
      let id = null, startX = 0, startW = 0;
      el.resize.addEventListener('pointerdown', (e) => { id = e.pointerId; startX = e.clientX; startW = S.settings.panelWidth || 380; el.resize.setPointerCapture(id); el.panel.classList.add('resizing'); });
      el.resize.addEventListener('pointermove', (e) => { if (id !== e.pointerId) return; const d = S.settings.side === 'right' ? startX - e.clientX : e.clientX - startX; const w = clamp(startW + d, 320, 560); el.panel.style.setProperty('--o-w', w + 'px'); S.settings.panelWidth = w; if (hooks.onWidthChange) hooks.onWidthChange(w); });
      const end = (e) => { if (id !== e.pointerId) return; try { el.resize.releasePointerCapture(id); } catch (err) { /* ignore */ } id = null; el.panel.classList.remove('resizing'); saveSettings({ panelWidth: S.settings.panelWidth }); };
      el.resize.addEventListener('pointerup', end); el.resize.addEventListener('pointercancel', end);
      el.resize.addEventListener('keydown', (e) => { const d = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0; if (!d) return; e.preventDefault(); const w = clamp((S.settings.panelWidth || 380) + (S.settings.side === 'right' ? -d : d), 320, 560); saveSettings({ panelWidth: w }); if (hooks.onWidthChange) hooks.onWidthChange(w); });
    }

    /* ============================================================ */
    /* Theme / settings application                                 */
    /* ============================================================ */
    function applyTheme() {
      const s = S.settings;
      const theme = s.theme === 'auto' ? (themeMq.matches ? 'dark' : 'light') : s.theme;
      el.panel.setAttribute('data-theme', theme);
      el.panel.setAttribute('data-side', s.side);
      el.panel.setAttribute('data-style', s.bubbleStyle || 'bubble');
      if (s.compact) el.panel.setAttribute('data-compact', ''); else el.panel.removeAttribute('data-compact');
      const accent = K.accentOf(s);
      el.panel.style.setProperty('--o-accent', accent);
      el.panel.style.setProperty('--o-accent-ink', K.accentInkOf(s));
      el.panel.style.setProperty('--o-accent-rgb', K.hexToRgb(accent));
      el.panel.style.setProperty('--o-font', clamp(s.fontSize || 14, 12, 18) + 'px');
      el.panel.style.setProperty('--o-panel-alpha', String(clamp(s.panelOpacity == null ? 1 : s.panelOpacity, 0.5, 1)));
      el.panel.style.setProperty('--o-w', clamp(s.panelWidth || 380, 320, 560) + 'px');
      el.panel.classList.toggle('no-motion', !!s.reduceMotion || reduceMq.matches);
      if (el.pinBtn) { el.pinBtn.classList.toggle('on', !!s.pinned); el.pinBtn.setAttribute('aria-pressed', String(!!s.pinned)); }
      if (el.compactBtn) { el.compactBtn.classList.toggle('on', !!s.compact); el.compactBtn.setAttribute('aria-pressed', String(!!s.compact)); }
      updateBackdrop();
      if (S.view === 'room' && el.chatBg) applyChatBg(el.chatBg, S.roomId);
    }
    themeMq.addEventListener('change', applyTheme);
    reduceMq.addEventListener('change', applyTheme);

    function updateBackdrop() { if (!isEmbedded) el.backdrop.classList.toggle('show', S.open && !S.settings.pinned); }

    async function loadStorage() {
      const r = await chrome.storage.local.get([KEYS.SETTINGS, KEYS.PROFILE, KEYS.ROOMS, KEYS.STICKERS, KEYS.RECENT_EMOJI, KEYS.USER_ID]);
      S.settings = { ...DEFAULT_SETTINGS, ...(r[KEYS.SETTINGS] || {}), signaling: 'peerjs' };
      S.profile = { ...DEFAULT_PROFILE, ...(r[KEYS.PROFILE] || {}) };
      S.roomsList = Array.isArray(r[KEYS.ROOMS]) ? r[KEYS.ROOMS] : [];
      S.stickers = Array.isArray(r[KEYS.STICKERS]) ? r[KEYS.STICKERS] : [];
      S.recentEmoji = Array.isArray(r[KEYS.RECENT_EMOJI]) ? r[KEYS.RECENT_EMOJI] : [];
      S.userId = r[KEYS.USER_ID] || S.userId;
    }
    async function saveSettings(patch) {
      S.settings = { ...S.settings, ...patch };
      applyTheme();
      try { const r = await chrome.storage.local.get([KEYS.SETTINGS]); await chrome.storage.local.set({ [KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, ...(r[KEYS.SETTINGS] || {}), ...patch, signaling: 'peerjs' } }); } catch (e) { /* ignore */ }
    }
    async function saveProfile(patch) {
      S.profile = { ...S.profile, ...patch };
      refreshAvatarBtn();
      try { const r = await chrome.storage.local.get([KEYS.PROFILE]); await chrome.storage.local.set({ [KEYS.PROFILE]: { ...DEFAULT_PROFILE, ...(r[KEYS.PROFILE] || {}), ...patch } }); } catch (e) { /* ignore */ }
    }
    async function saveStickers(list) { S.stickers = list; try { await chrome.storage.local.set({ [KEYS.STICKERS]: list }); } catch (e) { /* ignore */ } }
    async function saveRecentEmoji(list) { S.recentEmoji = list; try { await chrome.storage.local.set({ [KEYS.RECENT_EMOJI]: list }); } catch (e) { /* ignore */ } }
    function roomEntry(id) { return S.roomsList.find((r) => r.id === id); }
    function normalizeRoomCode(value) {
      const code = String(value || '').toLowerCase().replace(/\s/g, '');
      return /^[a-z]{5}$/.test(code) ? code : '';
    }
    async function patchRoomEntry(id, patch) {
      try {
        const r = await chrome.storage.local.get([KEYS.ROOMS]);
        const list = Array.isArray(r[KEYS.ROOMS]) ? r[KEYS.ROOMS] : [];
        const e = list.find((x) => x.id === id); if (!e) return;
        Object.assign(e, patch); S.roomsList = list;
        await chrome.storage.local.set({ [KEYS.ROOMS]: list });
      } catch (e) { /* ignore */ }
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[KEYS.SETTINGS]) { S.settings = { ...DEFAULT_SETTINGS, ...(changes[KEYS.SETTINGS].newValue || {}), signaling: 'peerjs' }; applyTheme(); } // settings screen keeps its own controls in sync (no re-render: sliders would lose focus)
      if (changes[KEYS.PROFILE]) { S.profile = { ...DEFAULT_PROFILE, ...(changes[KEYS.PROFILE].newValue || {}) }; refreshAvatarBtn(); }
      if (changes[KEYS.ROOMS]) { S.roomsList = Array.isArray(changes[KEYS.ROOMS].newValue) ? changes[KEYS.ROOMS].newValue : []; if (S.view === 'rooms') renderCurrent(); else if (S.view === 'room') updateRoomHeader(); }
      if (changes[KEYS.STICKERS]) S.stickers = changes[KEYS.STICKERS].newValue || [];
      if (changes[KEYS.RECENT_EMOJI]) S.recentEmoji = changes[KEYS.RECENT_EMOJI].newValue || [];
    });

    /* ============================================================ */
    /* Bridge plumbing                                              */
    /* ============================================================ */
    async function request(msg, timeout) {
      try { return await bridge.request(msg, timeout); }
      catch (e) { toast(t('toast_error', { msg: e.message }), 'error'); throw e; }
    }
    function sendView() {
      bridge.send({ type: 'ui:view', mode: 'panel', roomId: S.view === 'room' && S.open && S.visible ? S.roomId : null, open: S.open, visible: S.visible });
    }
    bridge.on('hello-ack', (m) => {
      if (m.userId) S.userId = m.userId;
      S.live.clear();
      (m.rooms || []).forEach((r) => S.live.set(r.id, r));
      sendView();
      if (S.view === 'rooms') renderRoomsListOnly(); else if (S.view === 'room') { updateRoomHeader(); renderMembers(); }
    });
    bridge.on('room:update', (m) => {
      const prev = S.live.get(m.room.id);
      S.live.set(m.room.id, m.room);
      if (S.view === 'room' && S.roomId === m.room.id) { updateRoomHeader(); renderPinnedBar(); renderMembers(prev); renderTyping(); updateSeenMarkers(); renderLive(); }
      else if (S.view === 'rooms') renderRoomsListOnly();
    });
    bridge.on('room:left', (m) => {
      S.live.delete(m.roomId);
      if (S.view === 'room' && S.roomId === m.roomId && !S.leaving.has(m.roomId)) { toast(t('room_not_joined')); navigate('rooms'); }
      S.leaving.delete(m.roomId);
      if (S.view === 'rooms') renderRoomsListOnly();
    });
    bridge.on('room:full', (m) => toast(t('room_full', { name: m.name, max: LIMITS.MAX_ROOM_MEMBERS }), 'error'));
    bridge.on('msg:new', (m) => onIncoming(m.roomId, [m.message], false));
    bridge.on('msgs:batch', (m) => onIncoming(m.roomId, m.messages, true));
    bridge.on('msg:remove', (m) => {
      const store = S.msgs.get(m.roomId); if (store) { store.list = store.list.filter((x) => x.id !== m.msgId); store.byId.delete(m.msgId); }
      if (S.view === 'room' && S.roomId === m.roomId && el.msgs) { const node = el.msgs.querySelector(`.o-msg[data-id=\"${cssEscape(m.msgId)}\"]`); if (node) node.remove(); renderPinnedBar(); }
    });
    bridge.on('msg:update', (m) => {
      const store = S.msgs.get(m.roomId); if (!store) return;
      const cur = store.byId.get(m.message.id); if (!cur) return;
      Object.assign(cur, m.message);
      if (S.view === 'room' && S.roomId === m.roomId) { rerenderMessage(cur); updateSeenMarkers(); }
    });
    bridge.on('room:cleared', (m) => { S.msgs.delete(m.roomId); if (S.view === 'room' && S.roomId === m.roomId) { renderMessages(true); toast(t('history_cleared')); } });
    bridge.on('image:progress', (m) => {
      if (S.view !== 'room' || S.roomId !== m.roomId || !el.msgs) return;
      const node = el.msgs.querySelector(`.o-msg-img[data-img="${cssEscape(m.imageId)}"]`);
      if (node) setImgState(node, m.pct >= 1 ? { id: m.imageId, state: 'ready' } : { id: m.imageId, state: 'sending', progress: m.pct });
    });
    bridge.on('toast', (m) => toast(m.text, m.kind));
    bridge.on('disconnected', () => { /* bridge auto-reconnects; hello-ack restores state */ });
    bridge.on('dead', () => { toast(t('extension_reloaded', { brand: t('brand') }), 'error'); });
    /* ---------- screen sharing events ---------- */
    bridge.on('screen:state', (m) => {
      if (m.roomId !== S.roomId) return;
      share.remote = m.remote || null;
      share.viewers = m.screen ? m.screen.viewers : 0;
      if (typeof m.relay === 'boolean') share.relay = m.relay;
      if (m.stopped && m.by) {
        // A stop we are told about can be aimed at us: the room keeper asked for our share to end.
        toast(t('screen_stopped_by_keeper', { name: m.by }), 'info');
        if (share.publishing) stopShare({ silent: true, reason: 'keeper' });
      } else if (m.start && m.remote) toast(t('screen_started', { name: m.remote.name || 'Someone' }), 'info');
      renderLive();
    });
    bridge.on('screen:chunk', (m) => { if (m.roomId !== S.roomId) return; pushScreenChunk(m); });
    bridge.on('screen:stop', (m) => {
      if (m.roomId !== S.roomId) return;
      if (m.mine) stopShare({ silent: true });
      else { share.remote = null; destroyView(); renderLive(); if (!m.silent) toast(t('screen_stopped')); }
    });
    bridge.on('screen:flow', (m) => { if (m.roomId !== S.roomId || !share.publishing) return; share.paused = !!m.paused; if (share.recorder) { try { if (m.paused && share.recorder.state === 'recording') share.recorder.pause(); else if (!m.paused && share.recorder.state === 'paused') share.recorder.resume(); } catch (e) { /* ignore */ } } renderLive(); });
    bridge.on('screen:request', (m) => { if (m.roomId === S.roomId && share.publishing && m.kind === 'keyframe') restartShare(); });

    function cssEscape(s) { return (root.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

    /* ============================================================ */
    /* Navigation                                                   */
    /* ============================================================ */
    function navigate(view, params) {
      closePopovers();
      S.view = view; if (params && params.roomId) S.roomId = params.roomId;
      renderCurrent(params);
      sendView();
    }
    function renderCurrent(params) {
      clear(el.screen); el.msgs = null; el.chatBg = null; el.live = null; el.shareBtn = null;
      const Parts = root.OrbitPanelParts;
      switch (S.view) {
        case 'room': renderRoom(); el.headSub.textContent = '#' + roomLabel(S.roomId); break;
        case 'profile': el.headSub.textContent = t('profile_title'); Parts.renderProfile(app, el.screen); break;
        case 'settings': el.headSub.textContent = t('settings'); Parts.renderSettings(app, el.screen, params); break;
        case 'diagnostics': el.headSub.textContent = t('diagnostics'); Parts.renderDiagnostics(app, el.screen); break;
        default: S.view = 'rooms'; el.headSub.textContent = t('rooms_title'); renderRooms(); break;
      }
    }
    function roomLabel(id) { const live = S.live.get(id); const e = roomEntry(id); return (live && (live.title || live.name)) || (e && (e.title || e.name)) || ''; }
    function subHead(title, sub, extraActions) {
      return h('div', { class: 'o-sub-head' }, h('button', { class: 'o-ibtn', 'aria-label': t('back'), title: t('back'), on: { click: () => navigate(S.roomId && S.live.has(S.roomId) ? 'room' : 'rooms') } }, icon('back')), h('div', { class: 'o-title' }, title, sub ? h('small', null, sub) : null), extraActions || null);
    }
    app.subHead = subHead;

    /* ============================================================ */
    /* Rooms screen                                                 */
    /* ============================================================ */
    function renderRooms() {
      const create = h('div', { class: 'o-join o-room-form' });
      create.appendChild(h('h3', { class: 'o-form-title' }, icon('plus', 15), t('create_room')));
      create.appendChild(h('p', { class: 'o-help' }, t('create_room_help')));
      const nameInput = h('input', { class: 'o-input', type: 'text', placeholder: t('room_name_placeholder'), 'aria-label': t('room_name_label'), maxlength: '80', autocomplete: 'off' });
      const createPw = h('input', { class: 'o-input', type: 'password', placeholder: t('password_placeholder'), 'aria-label': t('password_placeholder'), autocomplete: 'new-password' });
      const createBtn = h('button', { class: 'o-btn primary block', type: 'button', disabled: true }, icon('plus', 16), t('create_room'));
      const namePreview = h('div', { class: 'o-join-preview', 'aria-live': 'polite' }, t('youll_create_empty'));
      const updateName = () => { const n = K.normalizeRoomName(nameInput.value); createBtn.disabled = !n; clear(namePreview); if (n) namePreview.append(t('youll_create', { name: '' }).replace(/:\s*$/, ': '), h('b', null, n)); else namePreview.textContent = t('youll_create_empty'); };
      nameInput.addEventListener('input', updateName);
      const createAction = async () => {
        const name = K.normalizeRoomName(nameInput.value); if (!name) return;
        createBtn.disabled = true; clear(createBtn); createBtn.append(icon('broadcast', 16), t('creating_room'));
        try {
          const res = await request({ type: 'room:create', name: nameInput.value, password: createPw.value || null }, 30000);
          nameInput.value = ''; createPw.value = ''; updateName();
          toast(t('room_created', { name: res.name, code: res.code }), 'ok');
          navigate('room', { roomId: res.roomId });
        } catch (e) { updateName(); clear(createBtn); createBtn.append(icon('plus', 16), t('create_room')); }
      };
      createBtn.addEventListener('click', createAction);
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createAction(); } });
      create.append(h('label', { class: 'o-label' }, t('room_name_label')), nameInput, namePreview,
        h('label', { class: 'o-label o-password-label' }, t('password_optional')), createPw, createBtn);

      const join = h('div', { class: 'o-join o-room-form' });
      join.appendChild(h('h3', { class: 'o-form-title' }, icon('key', 15), t('join_room')));
      join.appendChild(h('p', { class: 'o-help' }, t('join_room_help')));
      const codeInput = h('input', { class: 'o-input mono', type: 'text', placeholder: t('room_code_placeholder'), 'aria-label': t('room_code'), maxlength: '5', autocomplete: 'off', spellcheck: 'false' });
      const joinPw = h('input', { class: 'o-input', type: 'password', placeholder: t('password_placeholder'), 'aria-label': t('password_placeholder'), autocomplete: 'current-password' });
      const joinBtn = h('button', { class: 'o-btn block', type: 'button', disabled: true }, icon('broadcast', 16), t('join_room'));
      const codePreview = h('div', { class: 'o-join-preview', 'aria-live': 'polite' }, t('room_code_help'));
      const canonicalCode = () => codeInput.value.toUpperCase().replace(/\s/g, '');
      const updateCode = () => { const c = canonicalCode(); joinBtn.disabled = !/^[a-z]{5}$/i.test(c); codePreview.textContent = joinBtn.disabled ? t('room_code_help') : t('room_code_ready', { code: c }); };
      codeInput.addEventListener('input', updateCode);
      const joinAction = async () => {
        const code = canonicalCode(); if (!/^[a-z]{5}$/i.test(code)) return;
        joinBtn.disabled = true; clear(joinBtn); joinBtn.append(icon('broadcast', 16), t('joining_room'));
        try {
          const res = await request({ type: 'room:join', code, password: joinPw.value || null }, 30000);
          codeInput.value = ''; joinPw.value = ''; updateCode();
          navigate('room', { roomId: res.roomId });
        } catch (e) { updateCode(); clear(joinBtn); joinBtn.append(icon('broadcast', 16), t('join_room')); }
      };
      joinBtn.addEventListener('click', joinAction);
      codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); joinAction(); } });
      joinPw.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); joinAction(); } });
      join.append(h('label', { class: 'o-label' }, t('room_code')), codeInput, codePreview,
        h('label', { class: 'o-label o-password-label' }, t('password_optional')), joinPw, joinBtn);

      el.roomList = h('div', { class: 'o-room-list' });
      const scroll = h('div', { class: 'o-scroll' }, create, join, el.roomList);
      el.screen.appendChild(scroll);
      renderRoomsListOnly();
      if (!isEmbedded && S.open) setTimeout(() => nameInput.focus(), 60);
    }
    function renderRoomsListOnly() {
      if (!el.roomList || !el.roomList.isConnected) return;
      clear(el.roomList);
      const live = S.roomsList.filter((r) => S.live.has(r.id));
      const pinned = S.roomsList.filter((r) => r.pinned && !S.live.has(r.id));
      const recent = S.roomsList.filter((r) => !r.pinned && !S.live.has(r.id)).sort((a, b) => (b.lastJoined || 0) - (a.lastJoined || 0)).slice(0, 30);
      if (!S.roomsList.length) { el.roomList.appendChild(h('div', { class: 'o-empty' }, K.orbitMark(36), h('div', null, t('no_rooms')))); return; }
      const section = (title, list) => { if (!list.length) return; el.roomList.appendChild(h('h4', null, title)); list.forEach((r) => el.roomList.appendChild(roomCard(r))); };
      section(t('connected_rooms'), live.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)));
      section(t('pinned'), pinned);
      section(t('recent'), recent);
    }
    function roomCard(r) {
      const live = S.live.get(r.id);
      const online = live ? live.members.length : 0;
      const label = r.title || r.name;
      const sub = live && live.lastMsg ? `${live.lastMsg.senderName}: ${live.lastMsg.text}` : (live ? statusText(live) : t('offline_saved'));
      const muted = r.muteUntil && (r.muteUntil === -1 || r.muteUntil > Date.now());
      const card = h('div', { class: 'o-room-card' + (live ? ' active' : ' inactive'), role: live ? 'button' : null, tabindex: live ? '0' : null, data: { id: r.id }, on: { click: (e) => { if (live && !e.target.closest('.o-rc-actions')) openRoom(r.id, r); }, keydown: (e) => { if (live && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openRoom(r.id, r); } }, contextmenu: (e) => { e.preventDefault(); roomCardMenu(e.currentTarget, r); } } },
        h('div', { class: 'o-rc-ico' + (live ? '' : ' off') }, (label || '?').slice(0, 1).toUpperCase()),
        h('div', { style: { minWidth: '0' } }, h('div', { class: 'o-rc-name' }, r.password ? icon('lock', 12) : null, label, muted ? icon('bellOff', 12) : null), h('div', { class: 'o-rc-sub' }, sub)),
        h('div', { class: 'o-rc-meta' }, live ? h('span', { class: 'o-online', title: t('online_help'), 'aria-label': t('online_help') }, t('online_count', { n: online })) : null, live && live.unread && !muted ? h('span', { class: 'o-badge' }, String(live.unread)) : null),
        h('div', { class: 'o-rc-actions' },
          h('button', { class: 'o-btn sm o-rc-action', title: r.pinned ? t('unpin_room_help') : t('pin_room_help'), 'aria-label': r.pinned ? t('unpin_room') : t('pin_room'), on: { click: (e) => { e.stopPropagation(); patchRoomEntry(r.id, { pinned: !r.pinned }).then(renderRoomsListOnly); } } }, icon(r.pinned ? 'pinned' : 'pin', 13), h('span', null, t(r.pinned ? 'unpin_room' : 'pin_room'))),
          live
            ? h('button', { class: 'o-btn sm o-rc-action', title: t('invite_help'), 'aria-label': t('invite'), on: { click: (e) => { e.stopPropagation(); copyInvite(r.name, r.code); } } }, icon('link', 13), h('span', null, t('invite')))
            : h('button', { class: 'o-btn sm o-rc-action', title: t('rejoin_help'), 'aria-label': t('rejoin'), on: { click: (e) => { e.stopPropagation(); openRoom(r.id, r); } } }, icon('refresh', 13), h('span', null, t('rejoin'))),
          live
            ? h('button', { class: 'o-btn sm o-rc-action', title: t('leave_room_help'), 'aria-label': t('leave_room'), on: { click: async (e) => { e.stopPropagation(); if (await confirmDlg(t('leave_room'), t('confirm_leave', { name: r.name }))) { S.leaving.add(r.id); await request({ type: 'room:leave', roomId: r.id }); } } } }, icon('logout', 13), h('span', null, t('leave_room')))
            : h('button', { class: 'o-btn sm danger o-rc-action', title: t('delete_room_memory_help'), 'aria-label': t('delete_room_memory'), on: { click: async (e) => { e.stopPropagation(); if (await confirmDlg(t('delete_room_memory'), t('delete_room_memory_confirm', { name: r.name }))) { await request({ type: 'room:forget', roomId: r.id }); renderRoomsListOnly(); } } } }, icon('trash', 13), h('span', null, t('delete_room_memory')))));
      return card;
    }
    function roomCardMenu(anchor, r) {
      showMenu(anchor, [
        { label: r.pinned ? t('unpin_room') : t('pin_room'), icon: 'pin', run: () => patchRoomEntry(r.id, { pinned: !r.pinned }).then(renderRoomsListOnly) },
        { label: t('invite'), icon: 'link', run: () => copyInvite(r.name, r.code) },
        ...(!S.live.has(r.id) ? [{ label: t('rejoin'), icon: 'refresh', run: () => openRoom(r.id, r) }] : []),
        { sep: true },
        { label: t('delete_room_memory'), icon: 'trash', danger: true, run: async () => { if (await confirmDlg(t('delete_room_memory'), t('delete_room_memory_confirm', { name: r.name }))) { await request({ type: 'room:forget', roomId: r.id }); renderRoomsListOnly(); } } }
      ]);
    }
    async function openRoom(roomId, entry) {
      if (S.live.has(roomId)) { navigate('room', { roomId }); return; }
      const e = entry || roomEntry(roomId);
      if (!e) return;
      const code = normalizeRoomCode(e.code);
      if (!code) { toast(t('legacy_room_no_code'), 'error'); return; }
      // asHost matters: the member who created the room must reclaim the code (a vacant code has nobody to
      // join). Everyone else joins as a guest. The offscreen document gives a claim up to ~a minute of
      // retries, so the request budget is generous — and a room that is still being reclaimed opens anyway,
      // showing “Reclaiming this room…” instead of an error.
      const asHost = !!e.host && !e.__guest;
      try {
        const res = await request({ type: 'room:join', code, password: e.password || null, asHost, name: e.name }, 75000);
        if (res && res.claiming) toast(t('room_reserved_note'), 'info');
        navigate('room', { roomId: res.roomId });
      } catch (err) { /* toast shown by request() */ }
    }
    function copyInvite(name, code) {
      const validCode = normalizeRoomCode(code);
      if (!validCode) { toast(t('legacy_room_no_code'), 'error'); return; }
      const text = t('invite_text', { brand: t('brand'), name, code: validCode.toUpperCase() });
      navigator.clipboard.writeText(text).then(() => toast(t('invite_copied'), 'ok'), () => toast(text));
    }
    function copyCode(code) {
      const validCode = normalizeRoomCode(code);
      if (!validCode) { toast(t('legacy_room_no_code'), 'error'); return; }
      navigator.clipboard.writeText(validCode.toUpperCase()).then(() => toast(t('code_copied'), 'ok'), () => toast(validCode.toUpperCase()));
    }
    function currentRoomCode() {
      const entry = roomEntry(S.roomId) || {};
      const live = S.live.get(S.roomId);
      return normalizeRoomCode(entry.code || (live && live.code) || '');
    }
    function updateRoomCodeBar() {
      if (!el.roomCodeBar || S.view !== 'room') return;
      const code = currentRoomCode();
      clear(el.roomCodeBar);
      el.roomCodeBar.classList.toggle('o-hidden', !code);
      if (!code) return;
      el.roomCodeBar.append(
        h('span', { class: 'o-room-code-label' }, t('room_code')),
        h('code', { class: 'o-room-code-value' }, code.toUpperCase()),
        h('button', { class: 'o-btn sm primary o-room-code-copy', type: 'button', title: t('copy_code'), on: { click: () => copyCode(currentRoomCode()) } }, icon('copy', 14), t('copy_code'))
      );
    }
    function renderPinnedBar() {
      if (!el.pinnedBar) return;
      clear(el.pinnedBar);
      const live = S.live.get(S.roomId);
      const pins = live && live.pinnedMessages || [];
      el.pinnedBar.classList.toggle('o-hidden', !pins.length);
      if (!pins.length) return;
      el.pinnedBar.append(icon('pin', 13), h('b', null, t('pinned') + ':' ));
      pins.forEach((m) => el.pinnedBar.appendChild(h('button', { class: 'o-pinned-item', type: 'button', title: m.senderName, on: { click: () => jumpTo(m.id) } }, (m.text || '📷').slice(0, 90))));
    }
    function statusText(live) {
      const n = live.members.length - 1;
      switch (live.status) {
        case 'connected': return t('status_connected', { n, people: n === 1 ? t('people_one') : t('people_many') });
        case 'waiting': return t('status_waiting'); case 'reconnecting': return t('status_reconnecting'); case 'offline': return t('status_offline');
        case 'claiming': return t('status_claiming');
        case 'full': return t('status_full'); case 'error': return t('status_error'); default: return t('status_connecting');
      }
    }

    /* ============================================================ */
    /* Room screen                                                  */
    /* ============================================================ */
    function store(roomId) {
      let s = S.msgs.get(roomId);
      if (!s) { s = { list: [], byId: new Map(), hasMore: true, loaded: false, loading: null }; S.msgs.set(roomId, s); }
      return s;
    }
    function cmp(a, b) { return a.ts - b.ts || (a.senderId < b.senderId ? -1 : a.senderId > b.senderId ? 1 : 0) || (a.id < b.id ? -1 : 1); }
    function insertSorted(list, msg) { let i = list.length; while (i > 0 && cmp(list[i - 1], msg) > 0) i--; list.splice(i, 0, msg); return i; }
    async function ensureLoaded(roomId) {
      const s = store(roomId);
      if (s.loaded) return s;
      if (!s.loading) s.loading = (async () => {
        const res = await request({ type: 'room:history', roomId, limit: 100 });
        for (const m of res.messages) if (!s.byId.has(m.id)) { s.byId.set(m.id, m); insertSorted(s.list, m); }
        s.hasMore = res.hasMore; s.loaded = true; s.loading = null;
      })();
      await s.loading;
      return s;
    }
    async function loadEarlier(roomId) {
      const s = store(roomId);
      const oldest = s.list.find((m) => !m.ephemeral);
      if (!s.hasMore || !oldest) return 0;
      const res = await request({ type: 'room:history', roomId, before: oldest.ts, limit: 100 });
      let n = 0;
      for (const m of res.messages) if (!s.byId.has(m.id)) { s.byId.set(m.id, m); insertSorted(s.list, m); n++; }
      s.hasMore = res.hasMore;
      return n;
    }

    function renderRoom() {
      const roomId = S.roomId;
      if (imgObserver) { imgObserver.disconnect(); imgObserver = null; } // root element changes per room view
      if (attObserver) { attObserver.disconnect(); attObserver = null; }
      const wrap = h('div', { class: 'o-room' });
      el.roomHead = h('div', { class: 'o-room-head' });
      el.searchBar = null;
      const body = h('div', { class: 'o-room-body' });
      el.chatBg = h('div', { class: 'o-chat-bg', 'aria-hidden': 'true' }, h('div', { class: 'o-dim' }));
      el.msgs = h('div', { class: 'o-msgs o-scroll', role: 'log', 'aria-live': 'polite', 'aria-label': t('rooms') , tabindex: '0' });
      el.members = h('aside', { class: 'o-members o-scroll' + (S.membersOpen ? '' : ' o-hidden'), 'aria-label': t('members') });
      el.jump = h('div', { class: 'o-jump' }, h('button', { class: 'o-btn sm', type: 'button', on: { click: () => { scrollToBottom(true); } } }, icon('arrowDown', 14), el.jumpLabel = h('span', null, t('jump_to_bottom'))));
      body.append(el.chatBg, el.msgs, el.members, el.jump);
      el.typing = h('div', { class: 'o-typing', 'aria-live': 'polite' });
      el.composer = buildComposer(roomId);
      el.roomCodeBar = h('div', { class: 'o-room-code' });
      el.pinnedBar = h('div', { class: 'o-pinned-bar o-hidden' });
      el.live = h('div', { class: 'o-live o-hidden' });
      wrap.append(el.roomHead, el.roomCodeBar, el.pinnedBar, el.live, body, el.typing, el.composer);
      el.screen.appendChild(wrap);
      applyChatBg(el.chatBg, roomId);
      updateRoomHeader(); renderMembers(); renderTyping();
      // Show a running screen share (ours or a member's) and keep the button state in sync.
      if (!share.remote && !share.publishing) bridge.request({ type: 'screen:state', roomId }, 6000).then((res) => { if (S.roomId === roomId && S.view === 'room') { share.remote = (res && res.remote) || null; share.relay = !!(res && res.relay); renderLive(); updateShareBtn(); } }).catch(() => {});
      else { renderLive(); updateShareBtn(); }
      // scrolling
      let lastTop = 0;
      el.msgs.addEventListener('scroll', () => {
        const atBottom = isAtBottom();
        if (atBottom) { S.newCount = 0; updateJump(); maybeSendSeen(); }
        el.jump.classList.toggle('show', !atBottom);
        if (el.msgs.scrollTop < 80 && el.msgs.scrollTop < lastTop) tryLoadEarlier();
        lastTop = el.msgs.scrollTop;
      }, { passive: true });
      // drag & drop images anywhere on the room
      wrap.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); el.composer.classList.add('drag'); } });
      wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) el.composer.classList.remove('drag'); });
      wrap.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); el.composer.classList.remove('drag'); const dropped = Array.from(e.dataTransfer.files); sendPickedFiles(dropped, roomId); });
      S.newCount = 0;
      ensureLoaded(roomId).then(() => { if (S.roomId !== roomId || !el.msgs) return; renderMessages(true); scrollToBottom(false); maybeSendSeen(); });
      bridge.send({ type: 'room:markRead', roomId });
      if (S.open) setTimeout(() => el.ta && el.ta.focus({ preventScroll: true }), 50);
    }
    function hasFiles(e) { return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'); }
    function isAtBottom() { return el.msgs.scrollHeight - el.msgs.scrollTop - el.msgs.clientHeight < 48; }
    function scrollToBottom(smooth) { if (!el.msgs) return; const prev = el.msgs.style.scrollBehavior; if (!smooth) el.msgs.style.scrollBehavior = 'auto'; el.msgs.scrollTop = el.msgs.scrollHeight; el.msgs.style.scrollBehavior = prev; S.newCount = 0; updateJump(); }
    function updateJump() { if (!el.jumpLabel) return; el.jumpLabel.textContent = S.newCount ? t('new_messages', { n: S.newCount }) : t('jump_to_bottom'); }
    let loadingEarlier = false;
    async function tryLoadEarlier() {
      if (loadingEarlier || !el.msgs) return;
      const roomId = S.roomId; const s = store(roomId);
      const limit = S.renderLimit.get(roomId) || RENDER_INITIAL;
      const renderable = s.list.length;
      if (renderable > limit) { S.renderLimit.set(roomId, limit + RENDER_STEP); preserveScroll(() => renderMessages(false)); return; }
      if (!s.hasMore) return;
      loadingEarlier = true;
      try { const n = await loadEarlier(roomId); if (n && S.roomId === roomId && el.msgs) { S.renderLimit.set(roomId, limit + n); preserveScroll(() => renderMessages(false)); } }
      finally { loadingEarlier = false; }
    }
    function preserveScroll(fn) { const before = el.msgs.scrollHeight, top = el.msgs.scrollTop; fn(); const prev = el.msgs.style.scrollBehavior; el.msgs.style.scrollBehavior = 'auto'; el.msgs.scrollTop = top + (el.msgs.scrollHeight - before); el.msgs.style.scrollBehavior = prev; }

    function applyChatBg(node, roomId) {
      const e = roomEntry(roomId);
      const bg = (e && e.background) || S.settings.background || { type: 'none' };
      node.className = 'o-chat-bg';
      node.style.backgroundImage = '';
      node.style.filter = '';
      const dim = node.querySelector('.o-dim');
      if (bg.type === 'pattern') { node.classList.add('pattern-' + (bg.pattern || 'dots')); if (dim) dim.style.setProperty('--dim', '0'); }
      else if (bg.type === 'image' && /^data:image\//.test(bg.dataUrl || '')) { node.style.backgroundImage = `url("${bg.dataUrl}")`; node.style.filter = bg.blur ? `blur(${bg.blur}px)` : ''; if (dim) dim.style.setProperty('--dim', String(bg.dim == null ? 0.35 : bg.dim)); }
      else if (dim) dim.style.setProperty('--dim', '0');
    }
    app.applyChatBg = applyChatBg;

    function updateRoomHeader() {
      if (!el.roomHead || S.view !== 'room') return;
      const live = S.live.get(S.roomId); const e = roomEntry(S.roomId) || {};
      clear(el.roomHead);
      const name = live ? (live.title || live.name) : (e.title || e.name || '');
      const isKeeper = live && live.keeperId === S.userId;
      const muted = e.muteUntil && (e.muteUntil === -1 || e.muteUntil > Date.now());
      el.roomHead.append(
        h('button', { class: 'o-ibtn', 'aria-label': t('back'), title: t('back'), on: { click: () => navigate('rooms') } }, icon('back')),
        h('div', { class: 'o-rh-main' },
          h('div', { class: 'o-rh-name' }, live && live.hasPassword ? icon('lock', 12) : icon('hash', 12), name, isKeeper ? h('span', { class: 'o-group-head', title: t('keeper_help') }, h('span', { class: 'o-tag' }, t('keeper'))) : null, muted ? icon('bellOff', 12) : null),
          h('div', { class: 'o-status ' + (live ? live.status : 'offline') }, live ? statusText(live) : t('room_not_joined'))),
        h('button', { class: 'o-ibtn' + (S.search ? ' on' : ''), title: t('search'), 'aria-label': t('search'), on: { click: toggleSearch } }, icon('search', 17)),
        h('button', { class: 'o-ibtn' + (S.membersOpen ? ' on' : ''), title: t('members'), 'aria-label': t('members'), 'aria-pressed': String(S.membersOpen), on: { click: () => { S.membersOpen = !S.membersOpen; el.members.classList.toggle('o-hidden', !S.membersOpen); updateRoomHeader(); } } }, icon('users', 17)),
        h('button', { class: 'o-ibtn', title: t('room_options'), 'aria-label': t('room_options'), on: { click: (ev) => roomMenu(ev.currentTarget) } }, icon('more', 17))
      );
      if (el.headSub) el.headSub.textContent = '#' + name;
      updateRoomCodeBar();
      renderPinnedBar();
    }
    function roomMenu(anchor) {
      const roomId = S.roomId; const live = S.live.get(roomId); const e = roomEntry(roomId) || {};
      const muted = e.muteUntil && (e.muteUntil === -1 || e.muteUntil > Date.now());
      const isKeeper = live && live.keeperId === S.userId;
      const items = [
        { label: t('copy_code'), icon: 'copy', run: () => copyCode(e.code) },
        { label: t('invite'), icon: 'link', run: () => copyInvite(live ? live.name : e.name, e.code) },
        { label: t('nickname_in_room'), icon: 'edit', run: async () => { const v = await promptDlg(t('nickname_in_room'), t('nickname_placeholder'), e.nick || ''); if (v != null) { await request({ type: 'room:setNick', roomId, nick: v.slice(0, LIMITS.MAX_NAME_CHARS) }); if (v) toast(t('nick_set', { name: v })); } } },
        { label: t('share_history'), icon: 'refresh', check: e.shareHistory !== false, run: () => request({ type: 'room:setShareHistory', roomId, on: e.shareHistory === false }) },
        { sep: true },
        muted ? { label: t('unmute') + (e.muteUntil > 0 ? ` (${K.fmtMuteUntil(e.muteUntil)})` : ''), icon: 'bell', run: () => request({ type: 'room:mute', roomId, until: 0 }) } : { label: t('mute_room'), icon: 'bellOff', sub: [
          { label: t('mute_1h'), run: () => request({ type: 'room:mute', roomId, until: Date.now() + 3600e3 }) },
          { label: t('mute_8h'), run: () => request({ type: 'room:mute', roomId, until: Date.now() + 8 * 3600e3 }) },
          { label: t('mute_tomorrow'), run: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return request({ type: 'room:mute', roomId, until: d.getTime() }); } },
          { label: t('mute_forever'), run: () => request({ type: 'room:mute', roomId, until: -1 }) }] },
        { label: t('chat_background'), icon: 'image', run: () => navigate('settings', { section: 'appearance', roomId }) },
        { sep: true }
      ];
      if (isKeeper) items.push({ label: t('rename_room'), icon: 'edit', run: async () => { const v = await promptDlg(t('rename_room'), t('rename_prompt'), live.title || ''); if (v != null) request({ type: 'room:setTitle', roomId, title: v.slice(0, 40) }); } });
      items.push({ label: t('clear_history'), icon: 'trash', run: async () => { if (await confirmDlg(t('clear_history'), t('clear_history_confirm'))) request({ type: 'room:clear', roomId }); } });
      items.push({ label: t('leave_room'), icon: 'logout', danger: true, run: async () => { if (await confirmDlg(t('leave_room'), t('confirm_leave', { name: live ? live.name : e.name }))) { S.leaving.add(roomId); await request({ type: 'room:leave', roomId }); toast(t('left_room', { name: live ? live.name : e.name })); navigate('rooms'); } } });
      showMenu(anchor, items);
    }

    /* ---------- members sidebar ---------- */
    function renderMembers(prev) {
      if (!el.members || S.view !== 'room') return;
      const live = S.live.get(S.roomId);
      clear(el.members);
      if (!live) return;
      const prevIds = new Set(prev ? prev.members.map((m) => m.userId) : []);
      el.members.appendChild(h('h4', null, `${t('members')} · ${live.members.length}`));
      live.members.forEach((m) => {
        const av = K.avatarNode(m, 22);
        if (prev && !prevIds.has(m.userId) && !m.isSelf) av.classList.add('joined');
        el.members.appendChild(h('button', { class: 'o-member', type: 'button', title: m.status || m.name, on: { click: (e) => showProfileCard(e.currentTarget, m) } },
          av, h('span', { class: 'o-mname', style: m.nameColor ? { color: m.nameColor } : null }, m.name + (m.isSelf ? ` (${t('you')})` : ''), m.status ? h('span', { class: 'o-mstatus' }, m.status) : null),
          m.userId === live.keeperId ? h('span', { class: 'o-crown', title: t('keeper') }, icon('star', 12)) : null,
          m.mutedByKeeper ? icon('mute', 12) : null,
          h('span', { class: 'o-presence ' + (m.presence || 'online'), title: m.presence })));
      });
    }
    function renderTyping() {
      if (!el.typing || S.view !== 'room') return;
      const live = S.live.get(S.roomId); clear(el.typing);
      if (!live || !live.typing.length) return;
      const names = live.typing.filter((x) => x.userId !== S.userId).map((x) => x.name);
      if (!names.length) return;
      const text = names.length === 1 ? t('typing_one', { a: names[0] }) : names.length === 2 ? t('typing_two', { a: names[0], b: names[1] }) : t('typing_many');
      el.typing.append(h('i'), h('i'), h('i'), ' ', text);
    }

    /* ---------- messages ---------- */
    function onIncoming(roomId, messages, isBatch) {
      const s = store(roomId);
      let appended = 0, needFull = false;
      for (const m of messages) {
        if (s.byId.has(m.id)) { Object.assign(s.byId.get(m.id), m); continue; }
        s.byId.set(m.id, m);
        const idx = insertSorted(s.list, m);
        if (idx === s.list.length - 1) appended++; else needFull = true;
      }
      if (S.view !== 'room' || S.roomId !== roomId || !el.msgs) { if (S.view === 'rooms') renderRoomsListOnly(); return; }
      const wasAtBottom = isAtBottom();
      if (needFull || isBatch) renderMessages(false);
      else for (let i = messages.length - appended; i < messages.length; i++) appendMessage(s.byId.get(messages[i].id));
      const mine = messages.some((m) => m.senderId === S.userId);
      if (wasAtBottom || mine) scrollToBottom(!isBatch); else { S.newCount += messages.filter((m) => m.senderId !== S.userId && !m.ephemeral).length; updateJump(); el.jump.classList.add('show'); }
      maybeSendSeen();
    }

    let lastRendered = null; // { senderId, ts, groupEl, kind, day }
    function renderMessages(reset) {
      if (!el.msgs) return;
      const s = store(S.roomId);
      clear(el.msgs); lastRendered = null;
      if (reset) S.renderLimit.set(S.roomId, RENDER_INITIAL);
      const limit = S.renderLimit.get(S.roomId) || RENDER_INITIAL;
      const list = s.list.length > limit ? s.list.slice(s.list.length - limit) : s.list;
      if (s.list.length > limit || s.hasMore) el.msgs.appendChild(h('div', { class: 'o-load-earlier' }, h('button', { class: 'o-btn sm ghost', type: 'button', on: { click: tryLoadEarlier } }, icon('chevronUp', 14), t('load_earlier'))));
      const frag = document.createDocumentFragment();
      const holder = { appendChild: (n) => frag.appendChild(n), lastChild: null };
      for (const m of list) appendMessage(m, holder, true);
      el.msgs.appendChild(frag);
      updateSeenMarkers();
      observeImages();
    }
    function appendMessage(m, container, noPop) {
      container = container || el.msgs;
      const sys = m.kind === 'system';
      const me = m.senderId === S.userId;
      const newDay = !lastRendered || !K.sameDay(lastRendered.ts, m.ts);
      if (newDay) container.appendChild(h('div', { class: 'o-day', role: 'separator' }, K.dayLabel(m.ts)));
      const cont = !newDay && lastRendered && !sys && lastRendered.kind !== 'system' && lastRendered.senderId === m.senderId && m.ts - lastRendered.ts < GROUP_GAP_MS;
      let group;
      if (cont) group = lastRendered.groupEl;
      else {
        group = h('div', { class: 'o-group' + (sys ? ' system' : me ? ' me' : ''), data: { sender: m.senderId } });
        if (!sys) {
          const who = { avatar: m.avatar, name: m.senderName, userId: m.senderId };
          const liveM = memberOf(m.senderId); if (liveM) who.avatar = liveM.avatar;
          if (!me || S.settings.bubbleStyle === 'flat') group.appendChild(h('button', { class: 'o-avatar-btn', type: 'button', 'aria-label': m.senderName, on: { click: (e) => showProfileCard(e.currentTarget, liveM || { userId: m.senderId, name: m.senderName, avatar: m.avatar, nameColor: m.nameColor, offline: true }) } }, K.avatarNode(who, 34)));
          group.appendChild(h('div', { class: 'o-group-head' }, h('span', { class: 'o-name', style: m.nameColor && K.hexValid(m.nameColor) ? { color: m.nameColor } : null, on: { click: () => insertMention(m.senderName) } }, me ? `${m.senderName}` : m.senderName), me ? h('span', { class: 'o-tag' }, t('you')) : null, h('span', { class: 'o-time', title: K.fmtFull(m.ts) }, K.fmtTime(m.ts))));
        }
        container.appendChild(group);
      }
      const node = buildMsgNode(m);
      if (!noPop && !sys) node.classList.add('pop');
      group.appendChild(node);
      lastRendered = { senderId: m.senderId, ts: m.ts, groupEl: group, kind: m.kind };
      if (!noPop) observeImages();
    }
    function buildPollCard(m) {
      const poll = m.poll; const votes = poll.votes || {};
      const mine = votes[S.userId] || [];
      const tally = new Map(poll.options.map((o) => [o.id, 0]));
      Object.values(votes).forEach((ids) => (ids || []).forEach((id) => { if (tally.has(id)) tally.set(id, tally.get(id) + 1); }));
      const total = Object.keys(votes).length;
      const closed = !!poll.closed || !!(poll.closesAt && Date.now() >= poll.closesAt);
      const card = h('div', { class: 'o-poll-card' + (closed ? ' closed' : '') });
      card.appendChild(h('div', { class: 'o-poll-question' }, poll.question));
      if (!mine.length && !closed) card.appendChild(h('div', { class: 'o-poll-help' }, t('poll_tap_vote')));
      poll.options.forEach((option) => {
        const count = tally.get(option.id) || 0; const pct = total ? Math.round(count / total * 100) : 0;
        card.appendChild(h('button', { class: 'o-poll-choice' + (mine.includes(option.id) ? ' selected' : ''), type: 'button', disabled: closed, on: { click: () => {
          let next;
          if (poll.multiple) next = mine.includes(option.id) ? mine.filter((x) => x !== option.id) : [...mine, option.id];
          else next = [option.id];
          bridge.send({ type: 'room:pollVote', roomId: S.roomId, msgId: m.id, optionIds: next });
        } } }, h('i', { class: 'o-poll-bar', style: { '--poll-pct': pct + '%' } }), h('span', { class: 'o-poll-choice-text' }, option.text), h('span', { class: 'o-poll-count' }, `${count} · ${pct}%`)));
      });
      const foot = h('div', { class: 'o-poll-footer' }, t(closed ? 'poll_closed' : 'poll_votes', { n: total }), poll.multiple ? t('poll_multiple_short') : t('poll_single_short'));
      if (!closed && poll.closesAt) foot.appendChild(h('span', null, t('poll_closes_at', { time: K.fmtTime(poll.closesAt) })));
      if (!closed && m.senderId === S.userId) foot.appendChild(h('button', { class: 'o-btn sm', type: 'button', on: { click: () => bridge.send({ type: 'room:pollClose', roomId: S.roomId, msgId: m.id }) } }, t('poll_close')));
      card.appendChild(foot); return card;
    }

    /* ---- inline media attachments: images + videos show automatically instead of a download card ---- */
    const PREVIEW_IMAGE_RE = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;
    const AUTO_PREVIEW_MAX = { image: 15 * 1048576, video: 25 * 1048576 }; // bigger files wait for a click (they travel through the bridge as base64)
    const attPreviews = (S.attPreviews = new Map()); // assetId -> ready <img>/<canvas>/<video> (survives message re-renders)
    const autoAsked = new Map(); // assetId -> last auto-request time
    let attObserver = null; const attWatchers = new WeakMap();
    function previewKind(a) {
      if (!a || a.kind !== 'file') return null;
      const mime = String(a.mime || '').toLowerCase();
      if (PREVIEW_IMAGE_RE.test(mime)) return 'image';
      if (/^video\/[a-z0-9.+-]+$/.test(mime)) return 'video';
      return null;
    }
    function watchAttachment(node, fn) { // run fn once the attachment scrolls near the viewport
      if (!el.msgs || typeof IntersectionObserver === 'undefined') { setTimeout(fn, 0); return; }
      if (!attObserver) attObserver = new IntersectionObserver((entries) => { for (const en of entries) if (en.isIntersecting) { attObserver.unobserve(en.target); const f = attWatchers.get(en.target); attWatchers.delete(en.target); if (f) f(); } }, { root: el.msgs, rootMargin: '300px' });
      attWatchers.set(node, fn); attObserver.observe(node);
    }
    function liveAttachment(m, id) { const cur = (S.msgs.get(S.roomId) && S.msgs.get(S.roomId).byId.get(m.id)) || m; return { msg: cur, att: (cur.attachments || []).find((x) => x.id === id) }; }
    function fetchAttachment(m, a) {
      requestAsset(S.roomId, a.id); a.state = 'pending'; rerenderMessage(m);
      setTimeout(() => { const { msg, att } = liveAttachment(m, a.id); if (att && att.state === 'pending') { att.state = 'missing'; rerenderMessage(msg); } }, 25000);
    }
    function autoFetchAttachment(m, a) {
      if (Date.now() - (autoAsked.get(a.id) || 0) < 90000) return;
      const { att } = liveAttachment(m, a.id); if (!att || att.state !== 'missing') return;
      autoAsked.set(a.id, Date.now()); fetchAttachment(m, att);
    }
    async function downloadAsset(a) {
      try { const asset = await loadAssetUrl(S.roomId, a.id); const link = h('a', { href: asset.url, download: asset.info.name, class: 'o-hidden' }); el.panel.appendChild(link); link.click(); link.remove(); }
      catch (err) { toast(t('asset_not_available'), 'error'); }
    }
    function makeImagePreview(asset, a) {
      return new Promise((resolve, reject) => {
        const img = document.createElement('img'); img.className = 'o-media-img'; img.alt = a.name || ''; img.draggable = false;
        img.onload = () => resolve(img);
        img.onerror = async () => { // strict page CSP blocked the blob: URL → draw it ourselves
          try { const bmp = await createImageBitmap(asset.blob); const c = document.createElement('canvas'); c.className = 'o-media-img'; c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0); if (bmp.close) bmp.close(); resolve(c); }
          catch (e) { reject(e); }
        };
        img.src = asset.url;
      });
    }
    function makeVideoPreview(asset) {
      return new Promise((resolve, reject) => {
        const v = document.createElement('video'); v.className = 'o-media-video'; v.controls = true; v.preload = 'metadata'; v.muted = false; v.setAttribute('playsinline', '');
        let done = false; const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
        const timer = setTimeout(() => finish(resolve, v), 8000); // controls are still usable if metadata is slow
        v.addEventListener('loadeddata', () => finish(resolve, v), { once: true });
        v.addEventListener('loadedmetadata', () => finish(resolve, v), { once: true });
        v.addEventListener('error', () => finish(reject, new Error('video')), { once: true });
        v.src = asset.url + '#t=0.1'; // #t forces the first frame to render as the preview poster
      });
    }
    async function mountPreview(stage, a, pk) {
      let node = attPreviews.get(a.id);
      if (!node) {
        clear(stage); stage.appendChild(h('span', { class: 'o-media-status' }, icon('clock', 12), t('preview_loading')));
        try {
          const asset = await loadAssetUrl(S.roomId, a.id);
          node = attPreviews.get(a.id) || await (pk === 'image' ? makeImagePreview(asset, a) : makeVideoPreview(asset));
          attPreviews.set(a.id, node);
        } catch (e) { clear(stage); stage.appendChild(h('span', { class: 'o-media-status err' }, t('preview_failed'))); return; }
      }
      clear(stage); stage.appendChild(node);
      if (pk === 'image' && !node._o) { node._o = 1; node.addEventListener('click', () => node.classList.toggle('expanded')); node.title = t('preview_expand'); }
    }
    function buildMediaAttachment(m, a, pk) {
      const wrap = h('div', { class: 'o-attachment media ' + pk });
      const stage = h('div', { class: 'o-media-stage' });
      const auto = a.size <= AUTO_PREVIEW_MAX[pk];
      const label = t(pk === 'video' ? 'video_attachment' : 'image_attachment');
      const dl = h('button', { class: 'o-ibtn o-media-dl', type: 'button', title: t('file_download'), 'aria-label': t('file_download'), on: { click: () => downloadAsset(a) } }, icon('download', 14));
      const cap = h('div', { class: 'o-media-cap' }, h('span', { class: 'o-media-name', title: a.name }, a.name), h('span', { class: 'o-media-meta' }, `${label} · ${K.fmtBytes(a.size)}`));
      const waiting = (text) => { stage.appendChild(h('span', { class: 'o-media-status' }, icon(pk === 'video' ? 'play' : 'image', 16), text)); };
      if (a.state === 'receiving' || a.state === 'pending') {
        const pct = Math.round((a.progress || 0) * 100);
        waiting(a.state === 'receiving' ? t('file_receiving', { pct }) : t('file_waiting'));
        if (a.state === 'receiving') stage.appendChild(h('span', { class: 'o-bar' }, h('i', { style: { '--p': pct + '%' } })));
        wrap.append(stage, cap);
      } else if (a.state === 'missing') {
        waiting(auto ? t('file_waiting') : label);
        stage.appendChild(h('button', { class: 'o-btn sm', type: 'button', on: { click: () => fetchAttachment(m, a) } }, icon('download', 13), t('file_get')));
        wrap.append(stage, cap);
        if (auto) watchAttachment(wrap, () => autoFetchAttachment(m, a));
      } else {
        wrap.append(stage, cap, dl);
        if (auto || attPreviews.has(a.id)) {
          if (attPreviews.has(a.id)) mountPreview(stage, a, pk); else { waiting(t('preview_loading')); watchAttachment(wrap, () => { if (stage.isConnected || !el.msgs) mountPreview(stage, a, pk); }); }
        } else {
          waiting(label);
          stage.appendChild(h('button', { class: 'o-btn sm', type: 'button', on: { click: () => mountPreview(stage, a, pk) } }, icon('play', 13), t('preview_show')));
        }
      }
      return wrap;
    }

    function buildAttachmentNode(m, attachment) {
      const a = attachment;
      const pk = previewKind(a); if (pk) return buildMediaAttachment(m, a, pk);
      const wrap = h('div', { class: 'o-attachment' + (a.kind === 'audio' ? ' audio' : '') });
      wrap.append(h('span', { class: 'o-attachment-icon' }, icon(a.kind === 'audio' ? 'volume' : 'paperclip', 18)),
        h('div', { class: 'o-attachment-info' }, h('b', null, a.kind === 'audio' ? t('voice_message') : a.name), h('span', null, `${K.fmtBytes(a.size)} · ${a.kind === 'audio' ? t('audio_file') : t('file_attachment')}`)));
      if (a.state === 'receiving' || a.state === 'pending') {
        wrap.appendChild(h('span', { class: 'o-attachment-status' }, a.state === 'receiving' ? t('file_receiving', { pct: Math.round((a.progress || 0) * 100) }) : t('file_waiting')));
      } else if (a.state === 'missing') {
        wrap.appendChild(h('button', { class: 'o-btn sm', type: 'button', on: { click: () => fetchAttachment(m, a) } }, icon('download', 13), t(a.kind === 'audio' ? 'voice_get' : 'file_get')));
      } else if (a.kind === 'audio') {
        wrap.appendChild(h('button', { class: 'o-btn sm', type: 'button', on: { click: async (e) => { try { const asset = await loadAssetUrl(S.roomId, a.id); const player = h('audio', { controls: true, preload: 'metadata', src: asset.url }); e.currentTarget.replaceWith(player); player.play().catch(() => {}); } catch (err) { toast(t('asset_not_available'), 'error'); } } } }, icon('play', 13), t('voice_play')));
      } else {
        wrap.appendChild(h('button', { class: 'o-btn sm', type: 'button', on: { click: () => downloadAsset(a) } }, icon('download', 13), t('file_download')));
      }
      return wrap;
    }

    function memberOf(userId) { const live = S.live.get(S.roomId); return live ? live.members.find((m) => m.userId === userId) : null; }
    function memberNames() { const live = S.live.get(S.roomId); return live ? live.members.map((m) => m.name) : []; }

    function buildMsgNode(m) {
      const me = m.senderId === S.userId; const sys = m.kind === 'system';
      const node = h('div', { class: 'o-msg' + (m.kind === 'handoff' ? ' o-handoff-msg' : '') + (m.mentionsMe || (m.mentions || []).includes(S.userId) ? ' mention' : ''), data: { id: m.id }, tabindex: sys ? null : '-1' });
      const body = h('div', { class: 'o-body' });
      if (sys) { body.textContent = m.text; node.appendChild(body); return node; }
      if (m.deleted) { body.appendChild(h('div', { class: 'o-text deleted' }, t('deleted'))); node.appendChild(body); return node; }
      if (m.replyTo) body.appendChild(h('button', { class: 'o-quote', type: 'button', title: t('jump_to_reply'), on: { click: () => jumpTo(m.replyTo.id) } }, h('b', null, m.replyTo.senderName || ''), h('span', null, K.plain(m.replyTo.text || ''))));
      if (m.text && m.kind !== 'poll') {
        const txt = h('div', { class: 'o-text' + (m.kind === 'me' ? ' me-action' : '') });
        if (m.kind === 'me') txt.append(h('b', null, m.senderName + ' '));
        txt.appendChild(K.renderRich(m.text, { names: memberNames(), me: myDisplayName() }));
        if (m.edited) txt.appendChild(h('span', { class: 'o-edited', title: K.fmtFull(m.edited) }, `(${t('edited')})`));
        body.appendChild(txt);
        if (S.settings.linkPreviews && !m.sticker) maybeLinkPreview(body, m);
      }
      if (m.poll) body.appendChild(buildPollCard(m));
      if (m.attachments && m.attachments.length) { const files = h('div', { class: 'o-attachments' }); m.attachments.forEach((a) => files.appendChild(buildAttachmentNode(m, a))); body.appendChild(files); }
      if (m.images && m.images.length) {
        const grid = h('div', { class: 'o-imgs', data: { n: String(Math.min(4, m.images.length)) } });
        m.images.forEach((im) => grid.appendChild(buildImgNode(m, im)));
        body.appendChild(grid);
      }
      const reactions = h('div', { class: 'o-reactions' + (Object.keys(m.reactions || {}).length ? '' : ' o-hidden') });
      renderReactions(reactions, m);
      body.appendChild(reactions);
      node.appendChild(body);
      // hover tools + time + status
      const side = h('div', { class: 'o-msg-side' });
      const tools = h('div', { class: 'o-tools' },
        h('button', { class: 'o-ibtn', title: t('react'), 'aria-label': t('react'), on: { click: (e) => reactPopover(e.currentTarget, m) } }, icon('smile', 14)),
        h('button', { class: 'o-ibtn', title: t('reply'), 'aria-label': t('reply'), on: { click: () => setReply(m) } }, icon('reply', 14)),
        h('button', { class: 'o-ibtn', title: t('more'), 'aria-label': t('more'), on: { click: (e) => msgMenu(e.currentTarget, m) } }, icon('more', 14)));
      side.append(tools, h('span', { class: 'o-msg-time', title: K.fmtFull(m.ts) }, K.fmtTime(m.ts)));
      if (me && m.status) side.appendChild(statusIcon(m.status));
      node.appendChild(side);
      node.addEventListener('contextmenu', (e) => { if (e.target.closest('a,img,.o-msg-img')) return; e.preventDefault(); msgMenu(node, m); });
      node.addEventListener('keydown', (e) => { if (e.key === 'r' && !e.ctrlKey && !e.metaKey && e.target === node) setReply(m); if (e.key === 'e' && me && e.target === node) startEdit(m); });
      return node;
    }
    function statusIcon(status) {
      const map = { pending: ['clock', t('pending')], sending: ['check', t('sending')], sent: ['check', t('sent')], acked: ['checkAll', t('delivered')] };
      const [ic, label] = map[status] || map.sending;
      return h('span', { class: 'o-status-ic ' + status, title: label, 'aria-label': label }, icon(ic, 12));
    }
    function rerenderMessage(m) {
      if (!el.msgs) return;
      const old = el.msgs.querySelector(`.o-msg[data-id="${cssEscape(m.id)}"]`);
      if (!old) return;
      const fresh = buildMsgNode(m);
      old.replaceWith(fresh);
      observeImages();
    }
    function renderReactions(container, m) {
      clear(container);
      const entries = Object.entries(m.reactions || {}).filter(([, users]) => users && users.length);
      container.classList.toggle('o-hidden', !entries.length);
      for (const [emoji, users] of entries) {
        const mine = users.includes(S.userId);
        const names = users.map((u) => { const mm = memberOf(u); return mm ? mm.name : (u === S.userId ? t('you') : '?'); }).join(', ');
        container.appendChild(h('button', { class: 'o-reaction' + (mine ? ' mine' : ''), type: 'button', title: names, 'aria-pressed': String(mine), on: { click: () => request({ type: 'room:react', roomId: S.roomId, msgId: m.id, emoji, add: !mine }) } }, emoji, h('span', { class: 'n' }, String(users.length))));
      }
    }
    function updateSeenMarkers() {
      if (!el.msgs) return;
      el.msgs.querySelectorAll('.o-seen').forEach((n) => n.remove());
      const live = S.live.get(S.roomId); if (!live) return;
      const s = store(S.roomId);
      let last = null; for (let i = s.list.length - 1; i >= 0; i--) if (s.list[i].senderId === S.userId && !s.list[i].ephemeral) { last = s.list[i]; break; }
      if (!last) return;
      const names = [];
      for (const [uid, p] of Object.entries(live.seenPointers || {})) { if (uid === S.userId) continue; if (p.ts >= last.ts) { const mm = memberOf(uid); names.push(mm ? mm.name : '?'); } }
      if (!names.length) return;
      const node = el.msgs.querySelector(`.o-msg[data-id="${cssEscape(last.id)}"]`);
      if (node) node.after(h('div', { class: 'o-seen' }, t('seen_by', { names: names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '') })));
    }
    const maybeSendSeen = K.throttle(() => {
      if (S.view !== 'room' || !S.open || !S.visible || !el.msgs || !isAtBottom()) return;
      const s = store(S.roomId);
      for (let i = s.list.length - 1; i >= 0; i--) { const m = s.list[i]; if (m.ephemeral) continue; if (m.senderId !== S.userId) { bridge.send({ type: 'room:seen', roomId: S.roomId, msgId: m.id, ts: m.ts }); } return; }
    }, 1500);
    async function jumpTo(msgId) {
      let node = el.msgs.querySelector(`.o-msg[data-id="${cssEscape(msgId)}"]`);
      if (!node) {
        const s = store(S.roomId);
        // extend the render window / load until found (bounded)
        for (let i = 0; i < 12 && !s.byId.has(msgId); i++) { const n = await loadEarlier(S.roomId); if (!n) break; }
        if (s.byId.has(msgId)) { const idx = s.list.findIndex((m) => m.id === msgId); S.renderLimit.set(S.roomId, Math.max(S.renderLimit.get(S.roomId) || RENDER_INITIAL, s.list.length - idx + 5)); renderMessages(false); node = el.msgs.querySelector(`.o-msg[data-id="${cssEscape(msgId)}"]`); }
      }
      if (!node) { toast(t('no_results')); return; }
      node.scrollIntoView({ block: 'center', behavior: S.settings.reduceMotion ? 'auto' : 'smooth' });
      node.classList.remove('hl'); void node.offsetWidth; node.classList.add('hl'); node.focus({ preventScroll: true });
    }
    app.jumpTo = jumpTo;

    /* ---------- message menus ---------- */
    function msgMenu(anchor, m) {
      const me = m.senderId === S.userId;
      const items = [
        { label: t(m.pinned ? 'unpin_message' : 'pin_message'), icon: m.pinned ? 'pinned' : 'pin', run: () => request({ type: 'room:pinMessage', roomId: S.roomId, msgId: m.id, pinned: !m.pinned }) },
        { label: t('reply'), icon: 'reply', run: () => setReply(m) },
        { label: t('react'), icon: 'smile', run: () => reactPopover(anchor, m) },
        { label: t('copy_text'), icon: 'copy', run: () => navigator.clipboard.writeText(m.text || '').then(() => toast(t('copied'), 'ok')) }
      ];
      if (m.images && m.images.some((im) => ['missing', 'pending'].includes(im.state))) items.push({ label: t('retry_image'), icon: 'download', run: () => m.images.filter((im) => ['missing', 'pending'].includes(im.state)).forEach((im) => bridge.send({ type: 'image:fetch', roomId: S.roomId, imageId: im.id })) });
      if (m.images && m.images.length && m.images[0].state === 'ready') items.push({ label: t('copy_image'), icon: 'image', run: async () => { try { const d = await imageData(m.images[0].id); await K.copyImageToClipboard(d.dataUrl); toast(t('copied'), 'ok'); } catch (e) { toast(t('toast_error', { msg: e.message }), 'error'); } } });
      if (m.sticker && m.images && m.images[0]) items.push({ label: t('save_as_sticker'), icon: 'sticker', run: async () => { try { const d = await imageData(m.images[0].id); await saveStickers([...S.stickers, { id: K.uid(), dataUrl: d.dataUrl }]); toast(t('sticker_saved'), 'ok'); } catch (e) { /* ignore */ } } });
      if (me) { items.push({ sep: true }); items.push({ label: t('edit'), icon: 'edit', run: () => startEdit(m) }); items.push({ label: t('delete'), icon: 'trash', danger: true, run: async () => { if (await confirmDlg(t('delete'), t('deleted') + '?')) request({ type: 'room:delete', roomId: S.roomId, msgId: m.id }); } }); }
      showMenu(anchor, items);
    }
    function reactPopover(anchor, m) {
      const pop = h('div', { class: 'o-pop o-react-pop', role: 'menu' });
      QUICK_REACTIONS.forEach((e) => pop.appendChild(h('button', { class: 'o-emoji-btn', type: 'button', 'aria-label': e, on: { click: () => { closePopovers(); request({ type: 'room:react', roomId: S.roomId, msgId: m.id, emoji: e, add: !((m.reactions || {})[e] || []).includes(S.userId) }); } } }, e)));
      pop.appendChild(h('button', { class: 'o-ibtn', type: 'button', 'aria-label': t('more'), on: { click: () => { closePopovers(); emojiPicker(anchor, (e) => request({ type: 'room:react', roomId: S.roomId, msgId: m.id, emoji: e, add: true })); } } }, icon('plus', 14)));
      openPopover(pop, anchor);
    }

    /* ---------- images ---------- */
    function buildImgNode(m, im) {
      const btn = h('button', { class: 'o-msg-img' + (m.sticker ? ' sticker' : ''), type: 'button', data: { img: im.id, msg: m.id }, 'aria-label': t('open'), style: { '--ar': `${im.w || 4}/${im.h || 3}` } });
      const img = im.thumb ? K.safeImg(im.thumb, { alt: '', draggable: false, loading: 'lazy' }) : h('img', { alt: '', draggable: false });
      btn.appendChild(img);
      btn.appendChild(h('div', { class: 'o-img-state o-hidden' }));
      setImgState(btn, im, m);
      btn.addEventListener('click', () => {
        if (im.state === 'missing') { bridge.send({ type: 'image:fetch', roomId: S.roomId, imageId: im.id }); setImgState(btn, { ...im, state: 'pending' }); return; }
        if (im.state === 'ready') openLightbox(m, im.id);
      });
      return btn;
    }
    const picOf = (btn) => btn.querySelector('img, canvas');
    function setImgState(btn, im) {
      const st = btn.querySelector('.o-img-state'); const img = picOf(btn);
      const state = im.state || 'ready';
      btn.dataset.state = state;
      clear(st); st.classList.add('o-hidden');
      if (img) img.classList.remove('blur');
      if (state === 'ready') { loadFull(btn, im.id); return; }
      // A real thumbnail is already useful content. Keep it sharp and avoid a fake 0% overlay
      // while the full-resolution file transfers invisibly in the background.
      if (im.thumb && ['pending', 'receiving', 'sending'].includes(state)) return;
      st.classList.remove('o-hidden');
      if (state === 'receiving' || state === 'sending') { const pct = Math.round((im.progress || 0) * 100); st.append(h('span', null, t(state === 'sending' ? 'image_sending' : 'image_receiving', { pct })), h('span', { class: 'o-bar' }, h('i', { style: { '--p': pct + '%' } }))); if (state === 'sending') { img.classList.remove('blur'); loadFull(btn, im.id); } }
      else if (state === 'missing') st.append(icon('download', 12), t('image_missing'));
      else st.append(icon('clock', 12), t('image_waiting'));
    }
    let imgObserver = null;
    function observeImages() {
      if (!el.msgs) return;
      if (!imgObserver) imgObserver = new IntersectionObserver((entries) => { for (const en of entries) if (en.isIntersecting) { imgObserver.unobserve(en.target); if (en.target.dataset.state === 'ready') loadFull(en.target, en.target.dataset.img, true); } }, { root: el.msgs, rootMargin: '200px' });
      el.msgs.querySelectorAll('.o-msg-img[data-state="ready"]:not([data-full])').forEach((n) => imgObserver.observe(n));
    }
    async function loadFull(btn, imageId, force) {
      if (btn.dataset.full) return;
      if (!force) { if (imgObserver) imgObserver.observe(btn); return; }
      try { const d = await imageData(imageId); if (!d) return; btn.dataset.full = '1'; const fresh = K.safeImg(d.dataUrl, { alt: '', draggable: false }); const old = picOf(btn); if (old) old.replaceWith(fresh); else btn.prepend(fresh); }
      catch (e) { /* stays as thumbnail */ }
    }
    async function imageData(imageId) {
      if (S.imgCache.has(imageId)) { const v = S.imgCache.get(imageId); S.imgCache.delete(imageId); S.imgCache.set(imageId, v); return v; }
      const res = await bridge.request({ type: 'image:get', id: imageId });
      if (res.missing) return null;
      S.imgCache.set(imageId, res);
      if (S.imgCache.size > 40) S.imgCache.delete(S.imgCache.keys().next().value);
      return res;
    }
    app.imageData = imageData;

    function openLightbox(m, imageId) {
      const s = store(S.roomId);
      const all = [];
      for (const msg of s.list) for (const im of (msg.images || [])) if (im.state === 'ready' && !msg.deleted) all.push({ msg, im });
      let idx = Math.max(0, all.findIndex((x) => x.im.id === imageId));
      let scale = 1, tx = 0, ty = 0, natural = { w: 1, h: 1 }, curDataUrl = '';
      let pic = h('img', { alt: '', draggable: false });
      const stage = h('div', { class: 'o-lb-stage' }, pic);
      const swapPic = (node) => { node.setAttribute('draggable', 'false'); pic.replaceWith(node); pic = node; };
      function setPicture(dataUrl) {
        curDataUrl = dataUrl;
        const im = new Image(); im.alt = ''; im.draggable = false;
        im.onload = () => { natural = { w: im.naturalWidth, h: im.naturalHeight }; swapPic(im); fit(); };
        im.onerror = async () => { // strict page CSP blocked the data: URL → draw it ourselves
          try { const bmp = await createImageBitmap(K.dataUrlToBlob(dataUrl)); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0); natural = { w: bmp.width, h: bmp.height }; if (bmp.close) bmp.close(); swapPic(c); fit(); } catch (e) { /* ignore */ }
        };
        im.src = dataUrl;
      }
      const title = h('div', { class: 'o-grow' });
      const box = h('div', { class: 'o-lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('open'), tabindex: '-1' });
      const bar = h('div', { class: 'o-lb-bar' }, title,
        h('button', { class: 'o-ibtn', title: t('zoom_out'), 'aria-label': t('zoom_out'), on: { click: () => zoom(1 / 1.3) } }, icon('zoomOut')),
        h('button', { class: 'o-ibtn', title: t('zoom_in'), 'aria-label': t('zoom_in'), on: { click: () => zoom(1.3) } }, icon('zoomIn')),
        h('button', { class: 'o-ibtn', title: t('copy_image'), 'aria-label': t('copy_image'), on: { click: async () => { try { await K.copyImageToClipboard(curDataUrl); toast(t('copied'), 'ok'); } catch (e) { toast(t('toast_error', { msg: e.message }), 'error'); } } } }, icon('copy')),
        h('button', { class: 'o-ibtn', title: t('download'), 'aria-label': t('download'), on: { click: () => { const cur = all[idx]; K.downloadDataUrl(curDataUrl, `orbit-${cur.im.id.slice(0, 8)}.${(cur.im.mime || 'image/webp').split('/')[1]}`); } } }, icon('download')),
        h('button', { class: 'o-ibtn', title: t('close'), 'aria-label': t('close'), on: { click: closeLb } }, icon('close')));
      const prev = h('button', { class: 'o-ibtn o-lb-nav prev', 'aria-label': t('prev'), on: { click: () => show(idx - 1) } }, icon('back'));
      const next = h('button', { class: 'o-ibtn o-lb-nav next', 'aria-label': t('next_img'), on: { click: () => show(idx + 1) } }, icon('chevronRight'));
      box.append(bar, stage, prev, next);
      function apply() { pic.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) translate(50%, 50%) scale(${scale}) translate(-50%, -50%)`; }
      function fit() { const r = stage.getBoundingClientRect(); const k = Math.min(1, (r.width - 24) / natural.w, (r.height - 24) / natural.h); pic.style.width = natural.w * k + 'px'; pic.style.height = natural.h * k + 'px'; scale = 1; tx = 0; ty = 0; apply(); }
      function zoom(f, cx, cy) { const ns = clamp(scale * f, 0.5, 8); const r = stage.getBoundingClientRect(); cx = cx == null ? r.width / 2 : cx; cy = cy == null ? r.height / 2 : cy; const px = cx - r.width / 2 - tx, py = cy - r.height / 2 - ty; tx -= px * (ns / scale - 1); ty -= py * (ns / scale - 1); scale = ns; apply(); }
      async function show(i) {
        if (!all.length) return; idx = (i + all.length) % all.length;
        const cur = all[idx]; title.textContent = `${cur.msg.senderName} · ${K.fmtFull(cur.msg.ts)} · ${idx + 1}/${all.length}`;
        prev.classList.toggle('o-hidden', all.length < 2); next.classList.toggle('o-hidden', all.length < 2);
        const d = await imageData(cur.im.id); if (!d) return;
        setPicture(d.dataUrl);
      }
      stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
      let pid = null, sx = 0, sy = 0, stx = 0, sty = 0;
      stage.addEventListener('pointerdown', (e) => { pid = e.pointerId; sx = e.clientX; sy = e.clientY; stx = tx; sty = ty; stage.setPointerCapture(pid); });
      stage.addEventListener('pointermove', (e) => { if (pid !== e.pointerId) return; tx = stx + e.clientX - sx; ty = sty + e.clientY - sy; apply(); });
      const up = (e) => { if (pid === e.pointerId) { try { stage.releasePointerCapture(pid); } catch (err) { /* ignore */ } pid = null; } };
      stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
      stage.addEventListener('dblclick', () => { if (scale > 1) fit(); else zoom(2); });
      box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeLb(); } else if (e.key === 'ArrowLeft') show(idx - 1); else if (e.key === 'ArrowRight') show(idx + 1); else if (e.key === '+' || e.key === '=') zoom(1.3); else if (e.key === '-') zoom(1 / 1.3); });
      function closeLb() { box.remove(); el.lightbox = null; if (el.ta) el.ta.focus(); }
      el.lightbox = box; el.panel.appendChild(box); box.focus(); show(idx);
    }
    app.openLightbox = openLightbox;

    /* ---------- link previews (opt-in) ---------- */
    const previewCache = new Map();
    function maybeLinkPreview(body, m) {
      const match = /https?:\/\/[^\s<>"'`]+/i.exec(m.text || ''); if (!match) return;
      const url = K.safeUrl(match[0].replace(/[.,;:!?)\]]+$/, '')); if (!url) return;
      const holder = h('div');
      body.appendChild(holder);
      const render = (d) => { if (!d || d.error) return; holder.appendChild(h('a', { class: 'o-link-preview', href: d.url, target: '_blank', rel: 'noopener noreferrer' }, d.image ? h('img', { src: d.image, alt: '' }) : null, h('div', { class: 'o-grow' }, h('div', { class: 't' }, d.title), d.description ? h('div', { class: 'd' }, d.description) : null, h('div', { class: 's' }, d.site)))); };
      if (previewCache.has(url)) { render(previewCache.get(url)); return; }
      bridge.request({ type: 'link:preview', url }, 10000).then((d) => { previewCache.set(url, d); render(d); }).catch(() => {});
    }

    /* ============================================================ */
    /* Screen sharing                                                */
    /* ============================================================ */
    /* Capture + encoding happen here (only a real document can call getDisplayMedia); the offscreen
     * document routes the encoded segments to the room and hands incoming ones back for playback.
     * Late joiners ask for a keyframe, which restarts the recorder under a new stream id so their player
     * starts from a clean WebM header. */
    const share = { publishing: false, streamId: null, stream: null, recorder: null, quality: 'med', seq: 0, paused: false, viewers: 0, remote: null, view: null, hidden: false, relay: false, restarting: false };
    const SCREEN_CODECS = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
    const SCREEN_QUALITY = {
      low: { width: 960, height: 540, fps: 6, bps: 350000, slice: 400 },
      med: { width: 1280, height: 720, fps: 10, bps: 800000, slice: 250 },
      high: { width: 1600, height: 900, fps: 15, bps: 1600000, slice: 200 }
    };
    function q(spec) { return SCREEN_QUALITY[spec] || SCREEN_QUALITY.med; }
    function fromB64(text) { const bin = atob(text); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
    function bytesToB64(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000))); return btoa(bin); }
    function pickScreenMime() { return SCREEN_CODECS.find((x) => { try { return MediaRecorder.isTypeSupported(x); } catch (e) { return false; } }) || ''; }

    async function startShare(roomId) {
      if (share.publishing) { stopShare({ reason: 'user' }); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia || typeof MediaRecorder === 'undefined') { toast(t('screen_unavailable'), 'error'); return; }
      let pre = null;
      try { pre = await bridge.request({ type: 'screen:state', roomId }, 5000); } catch (e) { pre = null; }
      if (pre && pre.relay) { toast(t('screen_relay_blocked'), 'error'); return; }
      if (pre && pre.remote) { toast(t('screen_busy', { name: pre.remote.name }), 'error'); return; }
      const spec = q(share.quality);
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: spec.fps, width: { ideal: spec.width }, height: { ideal: spec.height } }, audio: false, preferCurrentTab: true });
      } catch (e) { toast(t('screen_denied'), 'error'); return; }
      let began = null;
      try { began = await bridge.request({ type: 'screen:begin', roomId, quality: share.quality }, 15000); }
      catch (e) {
        for (const tr of stream.getTracks()) tr.stop();
        const code = String((e && e.message) || '');
        toast(code === 'relay' ? t('screen_relay_blocked') : code === 'busy' ? t('screen_busy', { name: (e && e.by) || '' }) : t('screen_unavailable'), 'error');
        return;
      }
      share.publishing = true; share.stream = stream; share.streamId = began.screen.streamId; share.seq = 0; share.paused = false;
      startRecorder(roomId);
      const track = stream.getVideoTracks()[0];
      if (track) track.addEventListener('ended', () => stopShare({ reason: 'track-ended' }));
      toast(t('screen_shared_by_you'));
      renderLive();
      updateShareBtn();
    }

    function startRecorder(roomId) {
      const spec = q(share.quality);
      const mime = pickScreenMime();
      try { share.recorder = new MediaRecorder(share.stream, mime ? { mimeType: mime, videoBitsPerSecond: spec.bps } : { videoBitsPerSecond: spec.bps }); }
      catch (e) { toast(t('screen_unavailable'), 'error'); stopShare({ reason: 'recorder' }); return; }
      share.recorder.ondataavailable = async (ev) => {
        if (!ev.data || !ev.data.size || !share.publishing) return;
        let bytes; try { bytes = new Uint8Array(await ev.data.arrayBuffer()); } catch (e) { return; }
        if (!bytes.length) return;
        share.seq += 1;
        bridge.send({ type: 'screen:chunk', roomId, streamId: share.streamId, seq: share.seq, data: bytesToB64(bytes) });
      };
      try { share.recorder.start(spec.slice); } catch (e) { stopShare({ reason: 'recorder' }); }
    }

    /** Restart the encoder under a fresh stream id: viewers get a clean header instead of a broken stream. */
    async function restartShare() {
      if (!share.publishing || share.restarting) return;
      share.restarting = true;
      try {
        const roomId = S.roomId;
        const oldRecorder = share.recorder;
        if (oldRecorder && oldRecorder.state !== 'inactive') { try { oldRecorder.stop(); } catch (e) { /* ignore */ } }
        const began = await bridge.request({ type: 'screen:begin', roomId, quality: share.quality }, 15000);
        share.streamId = began.screen.streamId; share.seq = 0;
        startRecorder(roomId);
        renderLive();
      } catch (e) { /* keep the old stream id; the share continues */ }
      finally { share.restarting = false; }
    }

    async function stopShare(opts = {}) {
      const { silent = false, reason = 'user' } = opts;
      if (!share.publishing) return;
      share.publishing = false;
      const recorder = share.recorder; share.recorder = null;
      if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (e) { /* ignore */ } }
      for (const tr of (share.stream && share.stream.getTracks()) || []) { try { tr.stop(); } catch (e) { /* ignore */ } }
      share.stream = null;
      try { await bridge.request({ type: 'screen:end', roomId: S.roomId, reason }, 5000); } catch (e) { /* best effort */ }
      if (!silent) toast(t('screen_stopped'));
      renderLive();
      updateShareBtn();
    }
    function updateShareBtn() {
      const btn = el.shareBtn;
      if (!btn) return;
      btn.classList.toggle('on', share.publishing);
      btn.title = share.publishing ? t('screen_stop') : t('screen_share_help');
      btn.setAttribute('aria-label', share.publishing ? t('screen_stop') : t('screen_share'));
      clear(btn); btn.appendChild(icon(share.publishing ? 'stopSquare' : 'screenShare', 18));
    }

    /* ---------- viewer side (Media Source playback) ---------- */
    function destroyView() {
      const v = share.view;
      share.view = null;
      if (!v) return;
      try { if (v.ms && v.ms.readyState === 'open') v.ms.endOfStream(); } catch (e) { /* ignore */ }
      try { if (v.video) { v.video.pause(); v.video.removeAttribute('src'); v.video.load(); } } catch (e) { /* ignore */ }
      try { if (v.url) URL.revokeObjectURL(v.url); } catch (e) { /* ignore */ }
    }
    function ensureView(streamId) {
      if (share.view && share.view.streamId === streamId) return share.view;
      destroyView();
      const video = h('video', { class: 'o-live-video', autoplay: '', muted: '', playsinline: '', 'aria-label': t('screen_share') });
      const v = { streamId, video, queue: [], sb: null, ms: null, url: '', bytes: 0, lastSeq: -1, firstFrame: false };
      share.view = v;
      const ctor = root.MediaSource || root.ManagedMediaSource;
      if (ctor && ctor.isTypeSupported) {
        const ms = new ctor(); v.ms = ms;
        v.url = URL.createObjectURL(ms);
        video.src = v.url;
        ms.addEventListener('sourceopen', () => {
          const type = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9'].find((x) => { try { return ctor.isTypeSupported(x); } catch (e) { return false; } }) || 'video/webm';
          try { v.sb = ms.addSourceBuffer(type); v.sb.mode = 'segments'; v.sb.addEventListener('updateend', () => flushView(v)); flushView(v); }
          catch (e) { toast(t('screen_unavailable'), 'error'); }
        }, { once: true });
      } else { toast(t('screen_unavailable'), 'error'); }
      video.addEventListener('playing', () => { v.firstFrame = true; renderLive(); });
      return v;
    }
    function flushView(v) {
      if (!v.sb || v.sb.updating || !v.ms || v.ms.readyState !== 'open') return;
      const next = v.queue.shift();
      if (next) { try { v.sb.appendBuffer(next); } catch (e) { /* decoding hiccup: skip this segment */ } return; }
      // Keep memory bounded and stay near the live edge.
      try {
        const buffered = v.sb.buffered;
        if (buffered.length) {
          const end = buffered.end(buffered.length - 1);
          const start = buffered.start(0);
          if (v.video.currentTime < end - 12) v.video.currentTime = Math.max(start, end - 1.2);
          if (end - start > 30 && v.video.currentTime > start + 10) v.sb.remove(start, v.video.currentTime - 4);
        }
      } catch (e) { /* ignore */ }
    }
    function pushScreenChunk(m) {
      const v = ensureView(m.streamId);
      if (!v) return;
      if (m.seq <= v.lastSeq) return;
      v.lastSeq = m.seq;
      let bytes; try { bytes = fromB64(m.bytes); } catch (e) { return; }
      v.bytes += bytes.length;
      v.queue.push(bytes.buffer);
      if (v.queue.length > 200) v.queue.splice(0, v.queue.length - 200);   // never grow without bound
      if (!v.video.isConnected) return;                                   // stream remembered, card not on screen
      flushView(v);
      if (!v.video.paused) v.video.play().catch(() => {});
    }

    /* ---------- the live card ---------- */
    function renderLive() {
      if (S.view !== 'room' || !el.live) return;
      const live = S.live.get(S.roomId);
      const remote = share.remote;
      const showingRemote = !!remote && !share.publishing;
      const visible = share.publishing || showingRemote;
      el.live.classList.toggle('o-hidden', !visible);
      if (!visible) { destroyView(); clear(el.live); return; }
      if (share.hidden && !share.publishing) {
        // Collapsed: only a pill, the stream keeps playing in the background (the video node stays alive).
        clear(el.live);
        el.live.append(h('div', { class: 'o-live-mini' },
          h('span', { class: 'o-live-pill' }, h('span', { class: 'o-live-dot' }), t('screen_live')),
          h('span', { class: 'o-live-title' }, t('screen_shared_by', { name: remote.name || 'Someone' })),
          h('button', { class: 'o-btn sm', type: 'button', on: { click: () => { share.hidden = false; renderLive(); } } }, icon('eye', 14), t('screen_show'))));
        return;
      }
      const isKeeper = live && live.keeperId === S.userId;
      clear(el.live);
      const head = h('div', { class: 'o-live-head' },
        h('span', { class: 'o-live-pill' }, h('span', { class: 'o-live-dot' }), t('screen_live')),
        h('span', { class: 'o-live-title' }, share.publishing ? t('screen_shared_by_you') : t('screen_shared_by', { name: remote.name || 'Someone' })),
        share.publishing && share.viewers ? h('span', { class: 'o-live-viewers' }, t('screen_watching', { n: share.viewers })) : null,
        share.paused ? h('span', { class: 'o-live-paused' }, t('loading')) : null
      );
      const actions = h('div', { class: 'o-live-actions' });
      if (share.publishing) {
        const select = h('select', { class: 'o-live-select', 'aria-label': t('screen_quality'), title: t('screen_q_help'), on: { change: (e) => { share.quality = e.target.value; restartShare(); } } },
          ['low', 'med', 'high'].map((k) => h('option', { value: k }, t(k === 'low' ? 'screen_q_low' : k === 'med' ? 'screen_q_med' : 'screen_q_high'))));
        select.value = share.quality;
        actions.append(h('span', { class: 'o-live-q' }, t('screen_quality')), select);
        actions.appendChild(h('button', { class: 'o-btn sm danger', type: 'button', on: { click: () => stopShare({ reason: 'user' }) } }, icon('stopSquare', 14), t('screen_stop')));
      } else {
        actions.appendChild(h('button', { class: 'o-btn sm', type: 'button', title: t('screen_refresh_help'), on: { click: () => { destroyView(); bridge.request({ type: 'screen:keyframe', roomId: S.roomId, to: (remote && remote.userId) || null, streamId: remote && remote.streamId }, 8000).catch(() => {}); toast(t('screen_waiting')); } } }, icon('refresh', 14), t('screen_refresh')));
        if (isKeeper) actions.appendChild(h('button', { class: 'o-btn sm danger', type: 'button', title: t('screen_keeper_stop'), on: { click: () => bridge.request({ type: 'screen:stopForAll', roomId: S.roomId }, 8000).catch(() => {}) } }, icon('stopSquare', 14), t('screen_stop')));
        actions.appendChild(h('button', { class: 'o-btn sm', type: 'button', on: { click: () => { share.hidden = true; renderLive(); } } }, t('screen_hide')));
      }
      const videoWrap = h('div', { class: 'o-live-stage' });
      if (share.publishing) {
        const video = h('video', { class: 'o-live-video', autoplay: '', muted: '', playsinline: '' });
        video.srcObject = share.stream;
        video.play().catch(() => {});
        videoWrap.appendChild(video);
      } else if (share.relay) {
        videoWrap.appendChild(h('div', { class: 'o-live-waiting' }, t('screen_needs_direct')));
      } else if (share.view && share.view.video) {
        videoWrap.appendChild(share.view.video);
        share.view.video.play().catch(() => {});
        flushView(share.view);
      }
      if (!share.publishing && share.view && !share.view.firstFrame) videoWrap.appendChild(h('div', { class: 'o-live-waiting' }, t('screen_waiting')));
      el.live.append(head, videoWrap, actions);
      if (share.publishing) el.live.appendChild(h('p', { class: 'o-live-tip' }, t('screen_tab_tip')));
    }
    app.renderLive = renderLive;
    app.startShare = startShare;
    app.stopShare = stopShare;

    /* ============================================================ */
    /* Composer                                                     */
    /* ============================================================ */
    function composeState(roomId) { let c = S.compose.get(roomId); if (!c) { c = { replyTo: null, editing: null, images: [], draft: '' }; S.compose.set(roomId, c); } return c; }
    function myDisplayName() { const e = roomEntry(S.roomId); return (e && e.nick) || S.profile.name || ''; }

    function buildComposer(roomId) {
      const c = composeState(roomId);
      const wrap = h('div', { class: 'o-composer' });
      wrap.appendChild(h('div', { class: 'o-drop-hint' }, t('drop_hint')));
      el.ctx = h('div', { class: 'o-ctx o-hidden' });
      el.tray = h('div', { class: 'o-tray o-hidden' });
      el.ta = h('textarea', { class: 'o-ta', rows: '1', placeholder: t('composer_placeholder', { room: roomLabel(roomId) }), 'aria-label': t('send'), maxlength: String(LIMITS.MAX_TEXT_CHARS) });
      el.ta.value = c.draft || '';
      const assetFile = h('input', { type: 'file', multiple: true, class: 'o-hidden', on: { change: () => { sendPickedFiles(Array.from(assetFile.files), roomId); assetFile.value = ''; } } });
      let recorder = null, recordStream = null, recordTimer = null, recordStarted = 0;
      const voiceBtn = h('button', { class: 'o-ibtn o-voice-record', type: 'button', title: t('voice_record'), 'aria-label': t('voice_record'), on: { click: async () => {
        if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') { toast(t('voice_unavailable'), 'error'); return; }
        try {
          recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((x) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(x)) || '';
          recorder = new MediaRecorder(recordStream, type ? { mimeType: type } : undefined);
          const parts = []; recordStarted = Date.now();
          recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) parts.push(ev.data); };
          recorder.onstop = async () => {
            clearInterval(recordTimer); recordTimer = null; voiceBtn.classList.remove('on'); voiceBtn.title = t('voice_record'); voiceBtn.setAttribute('aria-label', t('voice_record'));
            for (const track of (recordStream && recordStream.getTracks()) || []) track.stop(); recordStream = null;
            const duration = Math.min(30, (Date.now() - recordStarted) / 1000);
            if (!parts.length) return;
            const mime = (recorder.mimeType || 'audio/webm').split(';')[0];
            const blob = new Blob(parts, { type: mime });
            await uploadAttachments([new File([blob], 'Voice message.webm', { type: mime })], roomId, 'audio', duration);
          };
          recorder.start(250); voiceBtn.classList.add('on');
          const refresh = () => { const left = Math.max(0, 30 - Math.floor((Date.now() - recordStarted) / 1000)); voiceBtn.title = t('voice_recording', { seconds: left }); voiceBtn.setAttribute('aria-label', t('voice_recording', { seconds: left })); if (!left && recorder && recorder.state === 'recording') recorder.stop(); };
          refresh(); recordTimer = setInterval(refresh, 500);
        } catch (e) { if (recordStream) for (const track of recordStream.getTracks()) track.stop(); recordStream = null; toast(t('voice_permission'), 'error'); }
      } } }, icon('mic', 18));
      const pollBtn = h('button', { class: 'o-ibtn', type: 'button', title: t('create_poll'), 'aria-label': t('create_poll'), on: { click: (e) => openPollCreator(e.currentTarget, roomId) } }, icon('chart', 18));
      const sendBtn = h('button', { class: 'o-ibtn on', type: 'button', title: t('send') + ' (Enter)', 'aria-label': t('send'), on: { click: () => sendCurrent() } }, icon('send', 18));
      el.shareBtn = h('button', { class: 'o-ibtn o-share-btn', type: 'button', title: t('screen_share_help'), 'aria-label': t('screen_share'), on: { click: () => startShare(roomId) } }, icon('screenShare', 18));
      const row = h('div', { class: 'o-compose-row' },
        h('button', { class: 'o-ibtn', type: 'button', title: t('share_file_help'), 'aria-label': t('share_file'), on: { click: () => assetFile.click() } }, icon('paperclip', 18)), voiceBtn, pollBtn, el.shareBtn,
        h('button', { class: 'o-ibtn', type: 'button', title: t('stickers'), 'aria-label': t('stickers'), on: { click: (e) => stickerTray(e.currentTarget) } }, icon('sticker', 18)),
        el.ta, sendBtn, assetFile);
      updateShareBtn();
      el.ac = null;
      wrap.append(el.ctx, el.tray, row, h('div', { class: 'o-compose-hint' }, t('composer_hint')));
      const grow = () => { el.ta.style.height = 'auto'; el.ta.style.height = Math.min(160, el.ta.scrollHeight) + 'px'; };
      const typingPing = K.throttle(() => bridge.send({ type: 'room:typing', roomId, on: true }), 2500);
      let typingOffTimer = null;
      el.ta.addEventListener('input', () => { grow(); c.draft = el.ta.value; if (el.ta.value.trim()) { typingPing(); clearTimeout(typingOffTimer); typingOffTimer = setTimeout(() => bridge.send({ type: 'room:typing', roomId, on: false }), 4000); } updateAutocomplete(); });
      el.ta.addEventListener('keydown', (e) => {
        if (el.ac && acKeydown(e)) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendCurrent(); }
        else if (e.key === 'Escape') { if (c.replyTo || c.editing) { e.stopPropagation(); clearCtx(); } }
        else if (e.key === 'ArrowUp' && !el.ta.value) { const s = store(roomId); for (let i = s.list.length - 1; i >= 0; i--) if (s.list[i].senderId === S.userId && !s.list[i].deleted && s.list[i].text) { e.preventDefault(); startEdit(s.list[i]); break; } }
      });
      el.ta.addEventListener('paste', (e) => {
        const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => /^image\//.test(f.type));
        if (files.length) { e.preventDefault(); addFiles(files); }
      });
      el.ta.addEventListener('blur', () => { setTimeout(() => { if (el.ac && !el.ac.contains(el.root.getRootNode().activeElement)) hideAutocomplete(); }, 120); });
      requestAnimationFrame(grow);
      renderCtx(); renderTray();
      return wrap;
    }
    function renderCtx() {
      const c = composeState(S.roomId); if (!el.ctx) return;
      clear(el.ctx);
      if (c.editing) el.ctx.append(icon('edit', 14), h('span', { class: 'o-grow' }, h('b', null, t('editing'))), h('button', { class: 'o-ibtn sm', type: 'button', 'aria-label': t('cancel'), on: { click: clearCtx } }, icon('close', 14)));
      else if (c.replyTo) el.ctx.append(icon('reply', 14), h('span', { class: 'o-grow' }, h('b', null, t('reply_to', { name: c.replyTo.senderName })), ' ', K.plain(c.replyTo.text || '').slice(0, 80)), h('button', { class: 'o-ibtn sm', type: 'button', 'aria-label': t('cancel'), on: { click: clearCtx } }, icon('close', 14)));
      el.ctx.classList.toggle('o-hidden', !c.editing && !c.replyTo);
    }
    function clearCtx() { const c = composeState(S.roomId); if (c.editing) { c.editing = null; el.ta.value = c.draftBackup || ''; c.draft = el.ta.value; } c.replyTo = null; renderCtx(); el.ta.focus(); }
    function setReply(m) { const c = composeState(S.roomId); c.editing = null; c.replyTo = { id: m.id, senderName: m.senderName, text: m.text || (m.images && m.images.length ? '📷' : '') }; renderCtx(); el.ta.focus(); }
    function startEdit(m) { const c = composeState(S.roomId); c.replyTo = null; c.editing = m; c.draftBackup = el.ta.value; el.ta.value = m.text; el.ta.dispatchEvent(new Event('input')); renderCtx(); el.ta.focus(); el.ta.setSelectionRange(el.ta.value.length, el.ta.value.length); }
    function renderTray() {
      const c = composeState(S.roomId); if (!el.tray) return;
      clear(el.tray); el.tray.classList.toggle('o-hidden', !c.images.length);
      c.images.forEach((im, i) => el.tray.appendChild(h('div', { class: 'o-tray-item' }, K.safeImg(im.dataUrl, { alt: im.name || '' }), h('button', { class: 'o-ibtn', type: 'button', 'aria-label': t('remove'), on: { click: () => { c.images.splice(i, 1); renderTray(); } } }, icon('close', 12)))));
    }
    const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', mkv: 'video/x-matroska' };
    function guessMime(file) { if (file.type) return file.type; const m = /\.([a-z0-9]+)$/i.exec(file.name || ''); return (m && EXT_MIME[m[1].toLowerCase()]) || ''; }
    const isImageFile = (f) => /^image\//.test(guessMime(f));
    /** Paperclip / drag-drop: pictures go in the composer as inline images (shown automatically); videos and other files upload as attachments. */
    function sendPickedFiles(files, roomId) {
      files = Array.from(files || []); if (!files.length) return;
      const imgs = files.filter(isImageFile), rest = files.filter((f) => !isImageFile(f));
      if (imgs.length) addFiles(imgs);
      if (rest.length) uploadAttachments(rest, roomId, 'file');
    }
    async function addFiles(files) {
      const c = composeState(S.roomId);
      const overflow = []; // images the inline pipeline can't take (too big / odd format) still send as attachments, which preview automatically
      for (const f of files) {
        if (c.images.length >= LIMITS.MAX_IMAGES_PER_MESSAGE) { toast(t('images_max', { n: LIMITS.MAX_IMAGES_PER_MESSAGE })); break; }
        try {
          const maxBytes = (S.settings.maxImageMB || 6) * 1048576;
          const prepared = await K.prepareImageFile(f, { maxBytes, maxGifBytes: Math.min(LIMITS.MAX_GIF_BYTES, maxBytes) });
          c.images.push(prepared);
        } catch (e) {
          if (['gif_too_big', 'image_too_big', 'unsupported_image'].includes(e.code) && isImageFile(f)) { overflow.push(f); continue; }
          const mb = S.settings.maxImageMB || 6;
          toast(e.code === 'gif_too_big' ? t('gif_too_big', { mb: Math.min(6, mb) }) : e.code === 'image_too_big' ? t('image_too_big', { mb }) : t('unsupported_image'), 'error');
        }
      }
      renderTray(); if (el.ta) el.ta.focus();
      if (overflow.length) uploadAttachments(overflow, S.roomId, 'file');
    }
    app.addFiles = addFiles;
    function toB64(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000))); return btoa(bin); }
    async function uploadAttachments(files, roomId, kind, duration) {
      files = Array.from(files || []); if (!files.length) return;
      if (files.length > 4) { toast(t('attachment_limit'), 'error'); files = files.slice(0, 4); }
      const attachments = [];
      for (const file of files) {
        if (file.size > 50 * 1048576) { toast(t('file_too_large'), 'error'); continue; }
        if (file.size > 25 * 1048576 && !(await confirmDlg(t('large_file_title'), t('large_file_warning', { name: file.name, size: K.fmtBytes(file.size) })))) continue;
        let uploadMeta = null;
        try {
          toast(t('attachment_uploading', { name: file.name }));
          const mime = guessMime(file) || (kind === 'audio' ? 'audio/webm' : 'application/octet-stream');
          uploadMeta = await request({ type: 'asset:uploadBegin', roomId, name: file.name, mime, size: file.size, kind, duration }, 30000);
          for (let i = 0; i < uploadMeta.chunks; i++) {
            const start = i * uploadMeta.chunkBytes;
            const bytes = new Uint8Array(await file.slice(start, Math.min(file.size, start + uploadMeta.chunkBytes)).arrayBuffer());
            await request({ type: 'asset:uploadChunk', roomId, uploadId: uploadMeta.uploadId, index: i, data: toB64(bytes) }, 30000);
          }
          attachments.push({ id: uploadMeta.assetId, kind, name: file.name, mime, size: file.size, duration: duration || null });
        } catch (e) { if (uploadMeta && uploadMeta.uploadId) bridge.send({ type: 'asset:uploadAbort', roomId, uploadId: uploadMeta.uploadId }); toast(t('attachment_failed', { name: file.name }), 'error'); }
      }
      if (!attachments.length) return;
      try { await request({ type: 'room:send', roomId, text: '', attachments, kind: 'chat' }, 180000); if (kind === 'audio') toast(t('voice_saved'), 'ok'); }
      catch (e) { for (const a of attachments) bridge.send({ type: 'asset:delete', roomId, assetId: a.id }); }
    }

    function openPollCreator(anchor, roomId) {
      const pop = h('div', { class: 'o-pop o-poll-create', role: 'dialog', 'aria-label': t('create_poll') });
      const question = h('input', { class: 'o-input', type: 'text', maxlength: '240', placeholder: t('poll_question'), 'aria-label': t('poll_question') });
      const rows = h('div', { class: 'o-poll-edit-options' });
      function addOption(value = '') {
        if (rows.children.length >= 10) return;
        const field = h('input', { class: 'o-input', type: 'text', maxlength: '120', placeholder: t('poll_option', { n: rows.children.length + 1 }), value });
        const row = h('div', { class: 'o-poll-edit-row' }, field, h('button', { class: 'o-ibtn sm', type: 'button', title: t('remove_option'), 'aria-label': t('remove_option'), on: { click: () => { if (rows.children.length > 2) row.remove(); } } }, icon('close', 13)));
        rows.appendChild(row);
      }
      addOption(); addOption();
      const multiple = h('input', { type: 'checkbox' });
      const closes = h('select', { class: 'o-select', 'aria-label': t('poll_closes') },
        h('option', { value: '0' }, t('poll_never')), h('option', { value: '300000' }, t('poll_5m')),
        h('option', { value: '3600000' }, t('poll_1h')), h('option', { value: '86400000' }, t('poll_1d')));
      const controls = h('div', { class: 'o-poll-create-controls' },
        h('label', { class: 'o-check' }, multiple, h('span', null, t('poll_multiple'))),
        h('label', { class: 'o-poll-close-select' }, h('span', null, t('poll_closes')), closes));
      const add = h('button', { class: 'o-btn sm', type: 'button', on: { click: () => addOption() } }, icon('plus', 13), t('add_option'));
      const submit = h('button', { class: 'o-btn primary', type: 'button', on: { click: async () => {
        const q = question.value.trim(); const options = Array.from(rows.querySelectorAll('input')).map((x) => x.value.trim()).filter(Boolean);
        if (!q || options.length < 2) { toast(t('poll_need_question_options'), 'error'); return; }
        const span = Number(closes.value); const poll = { question: q, options: options.map((text) => ({ id: K.uid(), text })), multiple: multiple.checked, closesAt: span ? Date.now() + span : 0 };
        closePopovers();
        try { await request({ type: 'room:send', roomId, text: q, kind: 'poll', poll }, 30000); toast(t('poll_saved'), 'ok'); } catch (e) { /* request shows error */ }
      } } }, icon('chart', 14), t('create_poll'));
      pop.append(h('div', { class: 'o-poll-create-title' }, t('create_poll')), question, rows, h('div', { class: 'o-poll-create-actions' }, add, submit), controls,
        h('div', { class: 'o-help' }, t('poll_change_vote')));
      openPopover(pop, anchor);
    }

    const assetLoading = new Map();
    function loadAssetUrl(roomId, assetId) {
      const existing = S.assetCache.get(assetId); if (existing) return Promise.resolve(existing);
      if (assetLoading.has(assetId)) return assetLoading.get(assetId);
      const p = (async () => {
        const infoRes = await bridge.request({ type: 'asset:info', roomId, assetId });
        const info = infoRes && infoRes.asset; if (!info) throw new Error(t('asset_not_available'));
        const pieces = [];
        const count = Math.ceil(info.size / (512 * 1024));
        for (let i = 0; i < count; i++) {
          const res = await bridge.request({ type: 'asset:readChunk', roomId, assetId, index: i });
          if (!res || !res.chunk) throw new Error(t('asset_not_available'));
          const raw = atob(res.chunk.data); const bytes = new Uint8Array(raw.length);
          for (let j = 0; j < raw.length; j++) bytes[j] = raw.charCodeAt(j);
          pieces.push(bytes);
        }
        const blob = new Blob(pieces, { type: info.mime });
        const url = URL.createObjectURL(blob);
        S.assetCache.set(assetId, { url, info, blob });
        if (S.assetCache.size > 24) { const [oldId, old] = S.assetCache.entries().next().value; URL.revokeObjectURL(old.url); S.assetCache.delete(oldId); if (S.attPreviews) S.attPreviews.delete(oldId); }
        return { url, info, blob };
      })();
      assetLoading.set(assetId, p);
      const done = () => assetLoading.delete(assetId); p.then(done, done);
      return p;
    }
    function requestAsset(roomId, assetId) { bridge.send({ type: 'asset:fetch', roomId, assetId }); }

    function insertAtCaret(text) {
      const ta = el.ta; if (!ta) return;
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + text.length;
      ta.dispatchEvent(new Event('input')); ta.focus();
    }
    function insertMention(name) { if (!el.ta) return; const pre = el.ta.value && !/\s$/.test(el.ta.value) ? ' ' : ''; insertAtCaret(`${pre}@${name} `); }

    async function sendCurrent() {
      const roomId = S.roomId; const c = composeState(roomId);
      const text = el.ta.value.replace(/\s+$/, '');
      if (c.editing) {
        const m = c.editing; c.editing = null; renderCtx();
        el.ta.value = c.draftBackup || ''; c.draft = el.ta.value; el.ta.dispatchEvent(new Event('input'));
        if (text.trim() && text !== m.text) await request({ type: 'room:edit', roomId, msgId: m.id, text });
        return;
      }
      if (text.startsWith('/') && !c.images.length) { const handled = await slashCommand(text, roomId); if (handled) { el.ta.value = ''; c.draft = ''; el.ta.dispatchEvent(new Event('input')); return; } }
      if (!text.trim() && !c.images.length) return;
      const payload = { type: 'room:send', roomId, text, replyTo: c.replyTo, images: c.images.map((im) => ({ dataUrl: im.dataUrl, w: im.w, h: im.h, mime: im.mime, name: im.name })), kind: 'chat' };
      const restore = { text: el.ta.value, images: c.images.slice(), replyTo: c.replyTo };
      el.ta.value = ''; c.draft = ''; c.images = []; c.replyTo = null; renderCtx(); renderTray(); el.ta.dispatchEvent(new Event('input'));
      bridge.send({ type: 'room:typing', roomId, on: false });
      try { await request(payload, 60000); }
      catch (e) { el.ta.value = restore.text; c.images = restore.images; c.replyTo = restore.replyTo; renderCtx(); renderTray(); }
    }
    async function sendSticker(dataUrl) {
      const roomId = S.roomId;
      try { await request({ type: 'room:send', roomId, text: '', images: [{ dataUrl }], sticker: true, kind: 'chat' }, 60000); } catch (e) { /* toast shown */ }
    }

    async function slashCommand(text, roomId) {
      const m = /^\/(\w+)\s*([\s\S]*)$/.exec(text); if (!m) return false;
      const cmd = m[1].toLowerCase(), arg = m[2].trim();
      const live = S.live.get(roomId);
      switch (cmd) {
        case 'me': if (!arg) return true; await request({ type: 'room:send', roomId, text: arg, kind: 'me' }); return true;
        case 'shrug': await request({ type: 'room:send', roomId, text: (arg ? arg + ' ' : '') + t('shrug'), kind: 'chat' }); return true;
        case 'clear': await request({ type: 'room:clear', roomId }); return true;
        case 'nick': await request({ type: 'room:setNick', roomId, nick: arg.slice(0, LIMITS.MAX_NAME_CHARS) }); toast(arg ? t('nick_set', { name: arg }) : t('done')); return true;
        case 'roll': {
          const d = /^(\d{0,2})d(\d{1,4})$/i.exec(arg || '1d6') || [null, '1', '6'];
          const n = clamp(parseInt(d[1] || '1', 10) || 1, 1, 20), sides = clamp(parseInt(d[2], 10) || 6, 2, 1000);
          const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
          await request({ type: 'room:send', roomId, text: t('roll_result', { dice: `${n}d${sides}`, rolls: rolls.join(' + '), total: rolls.reduce((a, b) => a + b, 0) }), kind: 'me' }); return true;
        }
        case 'flip': await request({ type: 'room:send', roomId, text: t('flip_result', { result: Math.random() < 0.5 ? t('heads') : t('tails') }), kind: 'me' }); return true;
        case 'mute': {
          const target = live && live.members.find((x) => x.name.toLowerCase() === arg.toLowerCase() && !x.isSelf);
          if (!target) { toast(t('no_such_member', { name: arg }), 'error'); return true; }
          await toggleMuteUser(target.userId, target.name, true); return true;
        }
        case 'leave': S.leaving.add(roomId); await request({ type: 'room:leave', roomId }); navigate('rooms'); return true;
        case 'help': toast(t('slash_help')); return true;
        default: toast(t('unknown_command', { cmd: '/' + cmd, help: t('slash_help') }), 'error'); return true;
      }
    }
    async function toggleMuteUser(userId, name, on) {
      const list = new Set(S.settings.mutedUsers || []);
      if (on) list.add(userId); else list.delete(userId);
      await saveSettings({ mutedUsers: Array.from(list) });
      toast(on ? t('muted_user', { name }) : t('unmuted_user', { name }), 'ok');
    }

    /* ---------- @mention autocomplete ---------- */
    let acItems = [], acIndex = 0, acRange = null;
    function updateAutocomplete() {
      const ta = el.ta; const pos = ta.selectionStart; const before = ta.value.slice(0, pos);
      const m = /(^|\s)@([^\s@]{0,24})$/.exec(before);
      if (!m) { hideAutocomplete(); return; }
      const q = m[2];
      const live = S.live.get(S.roomId); const members = live ? live.members.filter((x) => !x.isSelf) : [];
      acItems = members.map((x) => ({ x, score: K.fuzzyScore(q, x.name) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
      if (!acItems.length) { hideAutocomplete(); return; }
      acRange = { start: pos - q.length - 1, end: pos }; acIndex = 0;
      renderAutocomplete();
    }
    function renderAutocomplete() {
      if (!el.ac) { el.ac = h('div', { class: 'o-ac', role: 'listbox' }); el.composer.appendChild(el.ac); }
      clear(el.ac);
      acItems.forEach((it, i) => el.ac.appendChild(h('button', { class: 'o-ac-item' + (i === acIndex ? ' on' : ''), type: 'button', role: 'option', 'aria-selected': String(i === acIndex), on: { mousedown: (e) => e.preventDefault(), click: () => pickAutocomplete(i) } }, K.avatarNode(it.x, 20), h('span', null, it.x.name), it.x.status ? h('span', { class: 'o-mono' }, it.x.status) : null)));
    }
    function hideAutocomplete() { if (el.ac) { el.ac.remove(); el.ac = null; } acItems = []; }
    function pickAutocomplete(i) { const it = acItems[i]; if (!it || !acRange) return; const v = el.ta.value; el.ta.value = v.slice(0, acRange.start) + '@' + it.x.name + ' ' + v.slice(acRange.end); const p = acRange.start + it.x.name.length + 2; el.ta.setSelectionRange(p, p); hideAutocomplete(); el.ta.dispatchEvent(new Event('input')); el.ta.focus(); }
    function acKeydown(e) {
      if (e.key === 'ArrowDown') { acIndex = (acIndex + 1) % acItems.length; renderAutocomplete(); e.preventDefault(); return true; }
      if (e.key === 'ArrowUp') { acIndex = (acIndex - 1 + acItems.length) % acItems.length; renderAutocomplete(); e.preventDefault(); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { pickAutocomplete(acIndex); e.preventDefault(); return true; }
      if (e.key === 'Escape') { hideAutocomplete(); e.preventDefault(); e.stopPropagation(); return true; }
      return false;
    }

    /* ---------- emoji picker & stickers ---------- */
    function emojiPicker(anchor, onPick) {
      const data = root.OrbitEmoji ? root.OrbitEmoji.categories : [];
      const pop = h('div', { class: 'o-pop o-emoji-pop', role: 'dialog', 'aria-label': t('emoji') });
      const input = h('input', { class: 'o-input', type: 'search', placeholder: t('search'), 'aria-label': t('search') });
      const tabs = h('div', { class: 'o-emoji-tabs', role: 'tablist' });
      const grid = h('div', { class: 'o-emoji-grid' });
      const cats = [['Recent', S.recentEmoji.map((e) => [e, ''])], ...data].filter((c) => c[1].length);
      const tabIcons = { Recent: '🕘', Smileys: '😀', Gestures: '👋', 'Animals & Nature': '🐻', 'Food & Drink': '🍕', Activities: '⚽', 'Travel & Places': '🚀', Objects: '💡', Symbols: '❤️' };
      let active = cats[0] ? cats[0][0] : '';
      const pick = (e) => { onPick(e); const rec = [e, ...S.recentEmoji.filter((x) => x !== e)].slice(0, 24); saveRecentEmoji(rec); closePopovers(); };
      const draw = () => {
        clear(grid); const q = input.value.trim().toLowerCase();
        if (q) { let n = 0; for (const [, items] of data) for (const [e, name] of items) { if (name.includes(q)) { grid.appendChild(emojiBtn(e, name)); if (++n > 200) break; } } return; }
        for (const [cat, items] of cats) { grid.appendChild(h('h5', { data: { cat } }, cat)); items.forEach(([e, name]) => grid.appendChild(emojiBtn(e, name))); }
      };
      const emojiBtn = (e, name) => h('button', { class: 'o-emoji-btn', type: 'button', title: name, 'aria-label': name || e, on: { click: () => pick(e) } }, e);
      cats.forEach(([cat]) => tabs.appendChild(h('button', { class: 'o-tab' + (cat === active ? ' on' : ''), type: 'button', role: 'tab', title: cat, 'aria-label': cat, on: { click: () => { active = cat; tabs.querySelectorAll('.o-tab').forEach((b) => b.classList.toggle('on', b.title === cat)); const hh = grid.querySelector(`h5[data-cat="${cssEscape(cat)}"]`); if (hh) grid.scrollTop = hh.offsetTop - grid.offsetTop; } } }, tabIcons[cat] || '•')));
      input.addEventListener('input', draw);
      pop.append(input, tabs, grid);
      draw();
      openPopover(pop, anchor, { above: true });
      setTimeout(() => input.focus(), 30);
    }
    function stickerTray(anchor) {
      const pop = h('div', { class: 'o-pop o-emoji-pop', role: 'dialog', 'aria-label': t('stickers') });
      const grid = h('div', { class: 'o-sticker-grid' });
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'o-hidden', on: { change: async () => { const f = file.files[0]; if (!f) return; try { const r = await K.shrinkForSticker(f, 256, LIMITS.MAX_STICKER_BYTES); await saveStickers([...S.stickers, { id: K.uid(), dataUrl: r.dataUrl }]); draw(); toast(t('sticker_saved'), 'ok'); } catch (e) { toast(t('unsupported_image'), 'error'); } file.value = ''; } } });
      const draw = () => {
        clear(grid);
        grid.appendChild(h('button', { class: 'o-sticker add', type: 'button', title: t('sticker_add'), 'aria-label': t('sticker_add'), on: { click: () => file.click() } }, icon('plus', 20)));
        S.stickers.forEach((s) => grid.appendChild(h('button', { class: 'o-sticker', type: 'button', on: { click: () => { closePopovers(); sendSticker(s.dataUrl); } } }, K.safeImg(s.dataUrl, { alt: '' }), h('span', { class: 'o-ibtn', role: 'button', tabindex: '0', title: t('sticker_remove'), 'aria-label': t('sticker_remove'), on: { click: (e) => { e.stopPropagation(); saveStickers(S.stickers.filter((x) => x.id !== s.id)).then(draw); } } }, icon('close', 10)))));
      };
      draw();
      pop.append(h('div', { class: 'o-help', style: { padding: '8px 10px 0' } }, t('sticker_add_help')), grid, file);
      openPopover(pop, anchor, { above: true });
    }

    /* ============================================================ */
    /* Popovers, menus, dialogs, toasts                             */
    /* ============================================================ */
    let popover = null;
    function openPopover(pop, anchor, opts = {}) {
      closePopovers();
      popover = pop;
      el.panel.appendChild(pop);
      const pr = el.panel.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
      const w = pop.offsetWidth, hgt = pop.offsetHeight;
      let left = ar.left - pr.left; let top = opts.above ? ar.top - pr.top - hgt - 6 : ar.bottom - pr.top + 6;
      if (left + w > pr.width - 8) left = pr.width - w - 8; if (left < 8) left = 8;
      if (top < 8) top = ar.bottom - pr.top + 6; if (top + hgt > pr.height - 8) top = Math.max(8, pr.height - hgt - 8);
      pop.style.left = left + 'px'; pop.style.top = top + 'px';
      const first = pop.querySelector(K.FOCUSABLE); if (first && !opts.noFocus) first.focus();
      setTimeout(() => { el.root.getRootNode().addEventListener('pointerdown', onDocDown, true); }, 0);
    }
    function onDocDown(e) { if (popover && !e.composedPath().includes(popover)) closePopovers(); }
    function closePopovers() { if (popover) { popover.remove(); popover = null; } el.root.getRootNode().removeEventListener('pointerdown', onDocDown, true); }
    app.closePopovers = closePopovers;
    function showMenu(anchor, items) {
      const menu = h('div', { class: 'o-pop o-menu', role: 'menu' });
      const add = (list, container) => list.forEach((it) => {
        if (it.sep) { container.appendChild(h('div', { class: 'o-menu-sep' })); return; }
        if (it.header) { container.appendChild(h('div', { class: 'o-menu-h' }, it.header)); return; }
        const b = h('button', { class: 'o-menu-item' + (it.danger ? ' danger' : ''), type: 'button', role: 'menuitem', on: { click: () => { if (it.sub) { clear(menu); add([{ header: it.label }, ...it.sub], menu); const f = menu.querySelector('button'); if (f) f.focus(); } else { closePopovers(); it.run(); } } } }, it.icon ? icon(it.icon, 15) : h('span', { style: { width: '15px' } }), h('span', { class: 'o-grow' }, it.label), it.check != null ? icon(it.check ? 'check' : 'minus', 14) : null, it.sub ? icon('chevronRight', 14) : null);
        container.appendChild(b);
      });
      add(items, menu);
      menu.addEventListener('keydown', (e) => { const btns = Array.from(menu.querySelectorAll('button')); const i = btns.indexOf(menu.getRootNode().activeElement); if (e.key === 'ArrowDown') { e.preventDefault(); (btns[i + 1] || btns[0]).focus(); } if (e.key === 'ArrowUp') { e.preventDefault(); (btns[i - 1] || btns[btns.length - 1]).focus(); } if (e.key === 'Escape') { e.stopPropagation(); closePopovers(); } });
      openPopover(menu, anchor);
    }
    app.showMenu = showMenu;
    function showProfileCard(anchor, m) {
      const isMuted = (S.settings.mutedUsers || []).includes(m.userId);
      const live = S.live.get(S.roomId); const isKeeper = live && live.keeperId === S.userId;
      const card = h('div', { class: 'o-pop o-profile-card', role: 'dialog', 'aria-label': m.name },
        h('div', { class: 'o-pc-banner', style: { background: K.bannerStyle(m.banner) } }),
        h('div', { class: 'o-pc-body' }, K.avatarNode(m, 52),
          h('div', { class: 'o-pc-name', style: m.nameColor ? { color: m.nameColor } : null }, m.name, m.isSelf ? h('span', { class: 'o-tag' }, t('you')) : null, live && m.userId === live.keeperId ? h('span', { class: 'o-crown', title: t('keeper') }, icon('star', 12)) : null),
          h('div', { class: 'o-pc-status' }, h('span', { class: 'o-presence ' + (m.offline ? 'offline' : (m.presence || 'online')), style: { display: 'inline-block', marginRight: '6px' } }), m.status || t('presence_' + (m.presence || 'online'))),
          h('div', { class: 'o-pc-actions' },
            h('button', { class: 'o-btn sm', type: 'button', on: { click: () => { navigator.clipboard.writeText(m.name).then(() => toast(t('copied_name'), 'ok')); closePopovers(); } } }, icon('copy', 13), t('copy_name')),
            !m.isSelf ? h('button', { class: 'o-btn sm', type: 'button', on: { click: () => { closePopovers(); insertMention(m.name); } } }, icon('at', 13), t('mention_hint')) : null,
            !m.isSelf ? h('button', { class: 'o-btn sm' + (isMuted ? '' : ' danger'), type: 'button', on: { click: () => { closePopovers(); toggleMuteUser(m.userId, m.name, !isMuted); } } }, icon(isMuted ? 'volume' : 'mute', 13), isMuted ? t('unmute_person') : t('mute_person')) : null,
            isKeeper && !m.isSelf ? h('button', { class: 'o-btn sm', type: 'button', title: t('keeper_help'), on: { click: () => { closePopovers(); request({ type: 'room:muteMember', roomId: S.roomId, userId: m.userId, on: !m.mutedByKeeper }); } } }, icon('shield', 13), m.mutedByKeeper ? t('unmute_member') : t('mute_member')) : null)));
      openPopover(card, anchor);
    }
    app.showProfileCard = showProfileCard;

    function dialog(build) {
      return new Promise((resolve) => {
        const ov = h('div', { class: 'o-overlay', role: 'presentation' });
        const dlg = h('div', { class: 'o-dialog', role: 'dialog', 'aria-modal': 'true', tabindex: '-1' });
        const done = (v) => { ov.remove(); resolve(v); if (el.ta) el.ta.focus(); };
        build(dlg, done);
        ov.appendChild(dlg);
        ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } K.trapTab(dlg, e); });
        el.panel.appendChild(ov);
        const f = dlg.querySelector('input, textarea, button.primary, button'); (f || dlg).focus();
      });
    }
    app.dialog = dialog;
    function confirmDlg(title, text) { return dialog((dlg, done) => { dlg.append(h('h3', null, title), h('p', null, text), h('div', { class: 'o-actions' }, h('button', { class: 'o-btn', type: 'button', on: { click: () => done(false) } }, t('cancel')), h('button', { class: 'o-btn primary', type: 'button', on: { click: () => done(true) } }, t('ok')))); }).then((v) => !!v); }
    function promptDlg(title, label, value) { return dialog((dlg, done) => { const inp = h('input', { class: 'o-input', type: 'text', value: value || '', placeholder: label, 'aria-label': label }); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(inp.value); }); dlg.append(h('h3', null, title), inp, h('div', { class: 'o-actions' }, h('button', { class: 'o-btn', type: 'button', on: { click: () => done(null) } }, t('cancel')), h('button', { class: 'o-btn primary', type: 'button', on: { click: () => done(inp.value) } }, t('save')))); }); }
    app.confirm = confirmDlg; app.prompt = promptDlg;
    function toast(text, kind) {
      const node = h('div', { class: 'o-toast ' + (kind || '') }, icon(kind === 'error' ? 'warning' : kind === 'ok' ? 'check' : 'info', 14), h('span', null, text));
      el.toasts.appendChild(node);
      setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 300); }, kind === 'error' ? 6000 : 3200);
      while (el.toasts.children.length > 4) el.toasts.firstChild.remove();
    }
    app.toast = toast;

    /* ---------- quick switcher (Ctrl+K) ---------- */
    function quickSwitcher() {
      if (el.switcher) { el.switcher.remove(); el.switcher = null; return; }
      const input = h('input', { class: 'o-input', type: 'text', placeholder: t('quick_switch_placeholder'), 'aria-label': t('quick_switch_placeholder') });
      const list = h('div', { class: 'o-list', role: 'listbox' });
      const box = el.switcher = h('div', { class: 'o-switcher' }, input, list);
      let sel = 0, items = [];
      const draw = () => {
        const q = input.value; items = S.roomsList.map((r) => ({ r, score: K.fuzzyScore(q, (r.title ? r.title + ' ' : '') + r.name) })).filter((x) => x.score > 0).sort((a, b) => (S.live.has(b.r.id) ? 1 : 0) - (S.live.has(a.r.id) ? 1 : 0) || b.score - a.score).slice(0, 8);
        sel = Math.min(sel, Math.max(0, items.length - 1)); clear(list);
        if (!items.length && q.trim()) items.push({ create: K.normalizeRoomName(q) });
        items.forEach((it, i) => list.appendChild(h('button', { class: 'o-ac-item' + (i === sel ? ' on' : ''), type: 'button', role: 'option', on: { click: () => go(i) } }, icon(it.create ? 'plus' : S.live.has(it.r.id) ? 'broadcast' : 'hash', 14), h('span', { class: 'o-grow' }, it.create ? `${t('join_or_create')}: ${it.create}` : (it.r.title || it.r.name)), !it.create && S.live.has(it.r.id) ? h('span', { class: 'o-mono' }, t('online_count', { n: S.live.get(it.r.id).members.length })) : null)));
      };
      const go = async (i) => { const it = items[i]; if (!it) return; box.remove(); el.switcher = null; if (it.create) { const res = await request({ type: 'room:create', name: it.create }); navigate('room', { roomId: res.roomId }); } else openRoom(it.r.id, it.r); };
      input.addEventListener('input', draw);
      input.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); draw(); e.preventDefault(); } else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); } else if (e.key === 'Enter') { go(sel); e.preventDefault(); } else if (e.key === 'Escape') { e.stopPropagation(); box.remove(); el.switcher = null; } });
      input.addEventListener('blur', () => setTimeout(() => { if (el.switcher === box && !box.contains(box.getRootNode().activeElement)) { box.remove(); el.switcher = null; } }, 150));
      el.panel.appendChild(box); draw(); input.focus();
    }

    /* ---------- in-room search ---------- */
    function toggleSearch() {
      if (S.search) { S.search = null; if (el.searchBar) { el.searchBar.remove(); el.searchBar = null; } el.msgs.classList.remove('o-hidden'); if (el.searchResults) { el.searchResults.remove(); el.searchResults = null; } updateRoomHeader(); return; }
      S.search = { q: '' };
      const input = h('input', { class: 'o-input mono', type: 'search', placeholder: t('search_placeholder'), 'aria-label': t('search_placeholder') });
      el.searchBar = h('div', { class: 'o-search-bar' }, icon('search', 14), input, h('button', { class: 'o-ibtn sm', type: 'button', 'aria-label': t('close'), on: { click: toggleSearch } }, icon('close', 14)));
      el.roomHead.after(el.searchBar);
      const run = K.debounce(async () => {
        const q = input.value.trim();
        if (!q) { if (el.searchResults) { el.searchResults.remove(); el.searchResults = null; } el.msgs.classList.remove('o-hidden'); return; }
        const res = await request({ type: 'room:search', roomId: S.roomId, q });
        if (!el.searchResults) { el.searchResults = h('div', { class: 'o-scroll', style: { flex: '1', padding: '6px 10px', position: 'relative', zIndex: '1' } }); el.msgs.before(el.searchResults); }
        el.msgs.classList.add('o-hidden'); clear(el.searchResults);
        el.searchResults.appendChild(h('div', { class: 'o-help', style: { margin: '4px 4px 8px' } }, t('search_results', { n: res.messages.length })));
        if (!res.messages.length) el.searchResults.appendChild(h('div', { class: 'o-empty' }, t('no_results')));
        res.messages.forEach((m) => {
          const span = h('span'); const txt = m.text || ''; const i = txt.toLowerCase().indexOf(q.toLowerCase());
          if (i >= 0) span.append(txt.slice(Math.max(0, i - 40), i), h('mark', null, txt.slice(i, i + q.length)), txt.slice(i + q.length, i + q.length + 80)); else span.textContent = txt.slice(0, 120);
          el.searchResults.appendChild(h('button', { class: 'o-search-hit', type: 'button', on: { click: () => { toggleSearch(); jumpTo(m.id); } } }, h('b', null, h('span', null, m.senderName), h('span', null, K.dayLabel(m.ts) + ' ' + K.fmtTime(m.ts))), span));
        });
      }, 250);
      input.addEventListener('input', run);
      input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); toggleSearch(); } });
      updateRoomHeader(); input.focus();
    }

    /* ============================================================ */
    /* Keyboard: Esc, /, Ctrl+K, focus trap                         */
    /* ============================================================ */
    el.panel.addEventListener('keydown', (e) => {
      const active = el.root.getRootNode().activeElement;
      const inField = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (e.key === 'Escape') {
        if (popover) { closePopovers(); e.stopPropagation(); return; }
        if (el.switcher) { el.switcher.remove(); el.switcher = null; e.stopPropagation(); return; }
        if (S.search && inField) return; // handled by search input
        if (!isEmbedded) { e.stopPropagation(); close(); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); quickSwitcher(); return; }
      if (e.key === '/' && !inField && S.view === 'room' && el.ta) { e.preventDefault(); el.ta.focus(); return; }
      if (!isEmbedded && !S.settings.pinned) K.trapTab(el.panel, e);
    });
    // Do not let page shortcuts see our typing
    ['keydown', 'keyup', 'keypress'].forEach((ev) => el.panel.addEventListener(ev, (e) => { e.stopPropagation(); }));
    el.panel.addEventListener('wheel', (e) => { e.stopPropagation(); }, { passive: true });

    /* ============================================================ */
    /* Open / close                                                 */
    /* ============================================================ */
    let booted = false;
    function open() {
      if (isEmbedded) return;
      if (!booted) { bootPromise.then(open); return; }
      if (S.open) return;
      S.open = true; el.panel.setAttribute('data-open', ''); updateBackdrop();
      if (hooks.onOpenChange) hooks.onOpenChange(true);
      sendView();
      if (!S.settings.onboarded) setTimeout(() => root.OrbitPanelParts.showTour(app), 300);
      setTimeout(() => { const f = S.view === 'room' && el.ta ? el.ta : el.screen.querySelector('input, button'); (f || el.panel).focus({ preventScroll: true }); }, 260);
      if (S.view === 'room') { bridge.send({ type: 'room:markRead', roomId: S.roomId }); maybeSendSeen(); }
    }
    function close() {
      if (isEmbedded || !S.open) return;
      closePopovers(); if (el.lightbox) { el.lightbox.remove(); el.lightbox = null; }
      // Closing the panel hides every control for the share, so stop capturing instead of leaving it running.
      if (share.publishing) stopShare({ silent: true, reason: 'panel-closed' });
      share.remote = null; destroyView();
      S.open = false; el.panel.removeAttribute('data-open'); updateBackdrop();
      if (hooks.onOpenChange) hooks.onOpenChange(false);
      if (hooks.focusDot) hooks.focusDot();
      sendView();
    }
    function toggle() { S.open ? close() : open(); }
    function setSide(side) { S.settings.side = side; el.panel.setAttribute('data-side', side); }
    function setVisible(v) { S.visible = v; sendView(); if (v) maybeSendSeen(); }
    async function openRoomExternal(roomId) { await bootPromise; open(); await openRoom(roomId); }

    app.controller = {
      open, close, toggle, isOpen: () => S.open, setSide, setVisible,
      openRoom: openRoomExternal, showSettings: () => { open(); navigate('settings'); }, showProfile: () => { open(); navigate('profile'); },
      navigate,
      destroy() { closePopovers(); if (share.publishing) stopShare({ silent: true, reason: 'destroyed' }); destroyView(); el.root.remove(); }
    };
    async function reloadStorage() { await loadStorage(); S.msgs.clear(); S.compose.clear(); S.imgCache.clear(); buildHead(); applyTheme(); S.view = 'rooms'; S.roomId = null; renderCurrent(); sendView(); }
    Object.assign(app, { navigate, saveSettings, saveProfile, saveStickers, patchRoomEntry, roomEntry, request, openRoom, copyInvite, statusText, toggleMuteUser, renderCurrent, reloadStorage });

    /* ---------- boot ---------- */
    const bootPromise = loadStorage().then(() => { booted = true; buildHead(); applyTheme(); renderCurrent(); sendView(); });
    return app;
  }

  root.OrbitPanel = { mount };
})(typeof globalThis !== 'undefined' ? globalThis : self);
