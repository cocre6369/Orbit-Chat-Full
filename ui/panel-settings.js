/* Orbit — profile, settings, appearance, notifications/privacy, advanced, diagnostics, onboarding tour,
 * avatar cropper. Everything here renders into a container handed over by ui/panel.js and talks to the
 * app through the small `app` API (state, saveSettings, saveProfile, request, toast, confirm, prompt…). */
(function (root) {
  'use strict';
  if (root.OrbitPanelParts) return;
  const O = root.ORBIT, K = root.OrbitKit, t = root.OrbitStrings.t;
  const { h, icon, clear, clamp } = K;
  const { LIMITS, ACCENTS, BANNERS, DEFAULT_ICE_SERVERS, DEFAULT_SETTINGS } = O;
  const Parts = {};

  /* ---------------- small form helpers ---------------- */
  function field(label, control, help, helpKind) {
    return h('div', { class: 'o-field' }, label ? h('label', { class: 'o-label' }, label) : null, control, help ? h('p', { class: 'o-help' + (helpKind ? ' ' + helpKind : '') }, help) : null);
  }
  function toggle(label, sub, checked, onChange) {
    const input = h('input', { type: 'checkbox' });
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'o-toggle' }, h('span', { class: 'o-tl' }, label, sub ? h('small', null, sub) : null), input, h('span', { class: 'o-track', 'aria-hidden': 'true' }));
  }
  function seg(options, value, onChange) {
    const box = h('div', { class: 'o-seg', role: 'radiogroup' });
    options.forEach(([val, label, ic]) => {
      const b = h('button', { class: 'o-chip' + (val === value ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': String(val === value), on: { click: () => { box.querySelectorAll('.o-chip').forEach((c) => { c.classList.toggle('on', c === b); c.setAttribute('aria-checked', String(c === b)); }); onChange(val); } } }, ic ? icon(ic, 13) : null, label);
      box.appendChild(b);
    });
    return box;
  }
  function range(min, max, step, value, onInput, format) {
    const out = h('span', { class: 'o-mono o-muted o-small', style: { minWidth: '44px', textAlign: 'right' } }, format ? format(value) : String(value));
    const input = h('input', { class: 'o-range', type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    input.addEventListener('input', () => { const v = parseFloat(input.value); out.textContent = format ? format(v) : String(v); onInput(v); });
    return h('div', { class: 'o-row' }, input, out);
  }
  function section(title, ...children) { const s = h('div', { class: 'o-section' }, h('h3', null, title)); children.forEach((c) => c && s.appendChild(c)); return s; }
  function debounced(fn, ms) { return K.debounce(fn, ms || 400); }

  /* ================================================================ */
  /* Profile                                                          */
  /* ================================================================ */
  Parts.renderProfile = function (app, container) {
    const S = app.state; const P = () => S.profile;
    const scroll = h('div', { class: 'o-scroll' });
    container.append(app.subHead(t('profile_title'), null), scroll);

    // hero preview
    const banner = h('div', { class: 'o-profile-banner' });
    const heroAvatar = h('div');
    const heroName = h('div', { class: 'o-pc-name' });
    const heroStatus = h('div', { class: 'o-pc-status' });
    const hero = h('div', { class: 'o-profile-hero' }, banner, h('div', { class: 'o-profile-avatar' }, heroAvatar, h('div', { style: { paddingBottom: '4px', minWidth: '0' } }, heroName, heroStatus)));
    const refreshHero = () => {
      banner.style.background = K.bannerStyle(P().banner);
      clear(heroAvatar); heroAvatar.appendChild(K.avatarNode({ avatar: P().avatar, name: P().name, userId: S.userId }, 64));
      clear(heroName); heroName.append(h('span', { style: P().nameColor ? { color: P().nameColor } : null }, P().name || '—'));
      heroStatus.textContent = P().status || t('presence_' + (P().presence || 'online'));
    };
    refreshHero();
    const save = async (patch) => { await app.saveProfile(patch); refreshHero(); };

    // name
    const nameInput = h('input', { class: 'o-input', type: 'text', maxlength: String(LIMITS.MAX_NAME_CHARS), value: P().name || '', placeholder: t('display_name'), 'aria-label': t('display_name') });
    nameInput.addEventListener('input', debounced(() => { const v = nameInput.value.trim().slice(0, LIMITS.MAX_NAME_CHARS); if (v) save({ name: v }); else refreshHero(); }, 350));
    nameInput.addEventListener('blur', () => { if (!nameInput.value.trim()) nameInput.value = P().name; });

    // avatar
    const avatarBody = h('div', { class: 'o-avatar-body', style: { marginTop: '10px' } });
    const drawAvatarBody = (mode) => {
      clear(avatarBody);
      if (mode === 'generated') {
        const grid = h('div', { class: 'o-avatar-picks' });
        for (let v = 0; v < K.AVATAR_VARIANTS; v++) {
          const on = P().avatar.type === 'generated' && (P().avatar.variant | 0) === v;
          grid.appendChild(h('button', { class: 'o-avatar-pick' + (on ? ' on' : ''), type: 'button', 'aria-label': `${t('avatar_generated')} ${v + 1}`, 'aria-pressed': String(on), on: { click: () => { save({ avatar: { ...P().avatar, type: 'generated', variant: v } }); drawAvatarBody('generated'); } } }, K.avatarNode({ avatar: { type: 'generated', variant: v }, name: P().name, userId: S.userId }, 40)));
        }
        avatarBody.append(grid, h('p', { class: 'o-help' }, t('avatar_generated') + ' · ' + t('display_name').toLowerCase() + ' → seed'));
      } else if (mode === 'emoji') {
        const input = h('input', { class: 'o-input', type: 'text', maxlength: '8', value: P().avatar.emoji || '🪐', 'aria-label': t('avatar_emoji'), style: { width: '90px', textAlign: 'center', fontSize: '22px' } });
        const apply = () => { const v = input.value.trim(); if (v) save({ avatar: { ...P().avatar, type: 'emoji', emoji: Array.from(v).slice(0, 2).join('') } }); };
        input.addEventListener('input', debounced(apply, 250));
        const quick = h('div', { class: 'o-avatar-emoji-grid' });
        const cats = root.OrbitEmoji ? root.OrbitEmoji.categories : [];
        const pool = [].concat(...cats.slice(0, 3).map((c) => c[1])).filter((_, i) => i % 7 === 0).slice(0, 36);
        pool.forEach(([e, name]) => quick.appendChild(h('button', { class: 'o-emoji-btn', type: 'button', title: name, 'aria-label': name, on: { click: () => { input.value = e; apply(); } } }, e)));
        avatarBody.append(h('div', { class: 'o-row' }, input, h('button', { class: 'o-btn sm', type: 'button', on: { click: apply } }, t('save'))), quick);
        if (P().avatar.type !== 'emoji') apply();
      } else {
        const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'o-hidden' });
        file.addEventListener('change', async () => { const f = file.files[0]; file.value = ''; if (!f) return; const dataUrl = await Parts.cropAvatar(app, f); if (dataUrl) save({ avatar: { ...P().avatar, type: 'image', dataUrl } }); });
        avatarBody.append(h('div', { class: 'o-row' }, h('button', { class: 'o-btn', type: 'button', on: { click: () => file.click() } }, icon('upload', 14), t('choose_image')), P().avatar.type === 'image' ? h('button', { class: 'o-btn ghost danger sm', type: 'button', on: { click: () => { save({ avatar: { ...P().avatar, type: 'generated', dataUrl: '' } }); drawAvatarBody('generated'); avatarSeg.querySelectorAll('.o-chip').forEach((c, i) => c.classList.toggle('on', i === 0)); } } }, t('remove')) : null, file), h('p', { class: 'o-help' }, t('avatar_note')));
      }
    };
    const avatarSeg = seg([['generated', t('avatar_generated'), 'wand'], ['emoji', t('avatar_emoji'), 'smile'], ['image', t('avatar_upload'), 'upload']], P().avatar.type === 'image' ? 'image' : P().avatar.type === 'emoji' ? 'emoji' : 'generated', drawAvatarBody);
    drawAvatarBody(P().avatar.type === 'image' ? 'image' : P().avatar.type === 'emoji' ? 'emoji' : 'generated');

    // banner
    const bannerSw = h('div', { class: 'o-swatches' });
    const drawBanners = () => {
      clear(bannerSw);
      Object.entries(BANNERS).forEach(([key, css]) => bannerSw.appendChild(h('button', { class: 'o-swatch' + (P().banner === key ? ' on' : ''), type: 'button', style: { background: css, borderRadius: '8px' }, title: key, 'aria-label': key, 'aria-pressed': String(P().banner === key), on: { click: () => { save({ banner: key }); drawBanners(); } } })));
      const custom = h('input', { type: 'color', value: K.hexValid(P().banner) ? P().banner : '#ff6a1f', 'aria-label': t('custom') });
      custom.addEventListener('input', debounced(() => { save({ banner: custom.value }); drawBanners(); }, 200));
      bannerSw.appendChild(h('span', { class: 'o-swatch custom' + (K.hexValid(P().banner) ? ' on' : ''), style: { borderRadius: '8px' }, title: t('custom') }, custom));
    };
    drawBanners();

    // status + presence
    const statusInput = h('input', { class: 'o-input', type: 'text', maxlength: String(LIMITS.MAX_STATUS_CHARS), value: P().status || '', placeholder: t('status_placeholder'), 'aria-label': t('status_line') });
    statusInput.addEventListener('input', debounced(() => save({ status: statusInput.value.trim().slice(0, LIMITS.MAX_STATUS_CHARS) }), 350));
    const suggestions = h('div', { class: 'o-profile-suggestions' });
    ['🎮 gaming', '📚 studying', '🎧 heads-down', '☕ coffee break', '🌙 late night', '✈️ travelling'].forEach((s) => suggestions.appendChild(h('button', { class: 'o-chip', type: 'button', on: { click: () => { statusInput.value = s; save({ status: s }); } } }, s)));
    const presence = h('div', { class: 'o-presence-opts' });
    const drawPresence = () => { clear(presence); ['online', 'away', 'dnd', 'invisible'].forEach((p) => presence.appendChild(h('button', { class: 'o-chip' + (P().presence === p ? ' on' : ''), type: 'button', 'aria-pressed': String(P().presence === p), on: { click: () => { save({ presence: p }); drawPresence(); } } }, h('span', { class: 'o-presence ' + p }), t('presence_' + p)))); };
    drawPresence();

    // name colour
    const colorSw = h('div', { class: 'o-swatches' });
    const drawColors = () => {
      clear(colorSw);
      colorSw.appendChild(h('button', { class: 'o-chip' + (!P().nameColor ? ' on' : ''), type: 'button', on: { click: () => { save({ nameColor: '' }); drawColors(); } } }, t('default_color')));
      Object.values(ACCENTS).forEach((a) => colorSw.appendChild(h('button', { class: 'o-swatch' + (P().nameColor === a.color ? ' on' : ''), type: 'button', style: { background: a.color }, 'aria-label': a.color, 'aria-pressed': String(P().nameColor === a.color), on: { click: () => { save({ nameColor: a.color }); drawColors(); } } })));
      const custom = h('input', { type: 'color', value: K.hexValid(P().nameColor) ? P().nameColor : '#ff6a1f', 'aria-label': t('custom') });
      custom.addEventListener('input', debounced(() => { save({ nameColor: custom.value }); drawColors(); }, 200));
      colorSw.appendChild(h('span', { class: 'o-swatch custom', title: t('custom') }, custom));
    };
    drawColors();

    // per-room nick
    let nickField = null;
    const live = S.roomId && S.live.get(S.roomId); const entry = S.roomId && app.roomEntry(S.roomId);
    if (live && entry) {
      const nick = h('input', { class: 'o-input', type: 'text', maxlength: String(LIMITS.MAX_NAME_CHARS), value: entry.nick || '', placeholder: t('nickname_placeholder'), 'aria-label': t('per_room_nick') });
      nick.addEventListener('change', () => app.request({ type: 'room:setNick', roomId: S.roomId, nick: nick.value.trim().slice(0, LIMITS.MAX_NAME_CHARS) }));
      nickField = field(`${t('per_room_nick')} · #${live.title || live.name}`, nick);
    }

    // export / import
    const importFile = h('input', { type: 'file', accept: 'application/json,.json', class: 'o-hidden' });
    importFile.addEventListener('change', async () => {
      const f = importFile.files[0]; importFile.value = ''; if (!f) return;
      try {
        const json = JSON.parse(await f.text());
        if (!json || json.app !== O.BRAND_NAME || !json.profile || typeof json.profile !== 'object') throw new Error('bad');
        const p = json.profile; const patch = {};
        if (typeof p.name === 'string' && p.name.trim()) patch.name = p.name.trim().slice(0, LIMITS.MAX_NAME_CHARS);
        if (p.avatar && typeof p.avatar === 'object') { const a = p.avatar; patch.avatar = { type: ['generated', 'emoji', 'image'].includes(a.type) ? a.type : 'generated', variant: a.variant | 0, emoji: typeof a.emoji === 'string' ? Array.from(a.emoji).slice(0, 2).join('') : '🪐', dataUrl: typeof a.dataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(a.dataUrl) && a.dataUrl.length < 40000 ? a.dataUrl : '' }; if (patch.avatar.type === 'image' && !patch.avatar.dataUrl) patch.avatar.type = 'generated'; }
        if (typeof p.banner === 'string' && (BANNERS[p.banner] || K.hexValid(p.banner))) patch.banner = p.banner;
        if (typeof p.status === 'string') patch.status = p.status.slice(0, LIMITS.MAX_STATUS_CHARS);
        if (['online', 'away', 'dnd', 'invisible'].includes(p.presence)) patch.presence = p.presence;
        if (typeof p.nameColor === 'string' && (p.nameColor === '' || K.hexValid(p.nameColor))) patch.nameColor = p.nameColor;
        await save(patch);
        if (json.settings && typeof json.settings === 'object') { const sp = {}; for (const k of ['theme', 'accent', 'accentCustom', 'fontSize', 'compact', 'bubbleStyle', 'side', 'dotSize', 'dotIdleOpacity', 'reduceMotion', 'peek', 'soundName']) if (k in json.settings) sp[k] = json.settings[k]; await app.saveSettings(sp); }
        app.toast(t('import_ok'), 'ok'); app.navigate('profile');
      } catch (e) { app.toast(t('import_bad', { brand: t('brand') }), 'error'); }
    });
    const exportBtn = h('button', { class: 'o-btn', type: 'button', on: { click: () => {
      const s = S.settings; const settings = {}; for (const k of ['theme', 'accent', 'accentCustom', 'fontSize', 'compact', 'bubbleStyle', 'side', 'dotSize', 'dotIdleOpacity', 'reduceMotion', 'peek', 'soundName']) settings[k] = s[k];
      const json = JSON.stringify({ app: O.BRAND_NAME, version: 1, exportedAt: new Date().toISOString(), profile: P(), settings }, null, 2);
      K.downloadDataUrl('data:application/json;charset=utf-8,' + encodeURIComponent(json), `${O.BRAND_NAME.toLowerCase()}-profile.json`);
    } } }, icon('download', 14), t('export_profile'));
    const importBtn = h('button', { class: 'o-btn', type: 'button', on: { click: () => importFile.click() } }, icon('upload', 14), t('import_profile'));

    scroll.append(hero,
      section(t('profile_title'),
        field(t('display_name'), nameInput, t('display_name_help', { n: LIMITS.MAX_NAME_CHARS })),
        field(t('avatar'), h('div', null, avatarSeg, avatarBody)),
        field(t('banner'), bannerSw),
        field(t('status_line'), h('div', { class: 'o-profile-status-control' }, statusInput, suggestions)),
        field(t('presence'), presence),
        field(t('name_color'), colorSw),
        nickField),
      section(t('export_profile'), h('div', { class: 'o-profile-actions' }, exportBtn, importBtn, importFile)),
      h('div', { style: { height: '20px' } }));
    setTimeout(() => nameInput.focus({ preventScroll: true }), 80);
  };

  /* ---------------- avatar cropper ---------------- */
  Parts.cropAvatar = async function (app, file) {
    let bmp;
    try { bmp = await K.decodeImage(file); } catch (e) { app.toast(t('unsupported_image'), 'error'); return null; }
    const sw = bmp.width || bmp.naturalWidth, sh = bmp.height || bmp.naturalHeight;
    const SIZE = 220;
    const minScale = SIZE / Math.min(sw, sh);
    const view = { scale: minScale, ox: (SIZE - sw * minScale) / 2, oy: (SIZE - sh * minScale) / 2, previewSize: SIZE };
    const canvas = h('canvas', { width: SIZE, height: SIZE });
    const g = canvas.getContext('2d');
    const draw = () => { g.fillStyle = '#1c1611'; g.fillRect(0, 0, SIZE, SIZE); g.drawImage(bmp, view.ox, view.oy, sw * view.scale, sh * view.scale); };
    const clampView = () => { view.ox = clamp(view.ox, SIZE - sw * view.scale, 0); view.oy = clamp(view.oy, SIZE - sh * view.scale, 0); };
    draw();
    const stage = h('div', { class: 'o-crop-stage' }, canvas);
    let pid = null, sx = 0, sy = 0, sox = 0, soy = 0;
    stage.addEventListener('pointerdown', (e) => { pid = e.pointerId; sx = e.clientX; sy = e.clientY; sox = view.ox; soy = view.oy; stage.setPointerCapture(pid); });
    stage.addEventListener('pointermove', (e) => { if (pid !== e.pointerId) return; view.ox = sox + (e.clientX - sx); view.oy = soy + (e.clientY - sy); clampView(); draw(); });
    const up = (e) => { if (pid === e.pointerId) { try { stage.releasePointerCapture(pid); } catch (err) { /* ignore */ } pid = null; } };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
    const setScale = (s, cx = SIZE / 2, cy = SIZE / 2) => { const ns = clamp(s, minScale, minScale * 6); view.ox = cx - (cx - view.ox) * (ns / view.scale); view.oy = cy - (cy - view.oy) * (ns / view.scale); view.scale = ns; clampView(); draw(); zoomRange.value = String(view.scale / minScale); };
    stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); setScale(view.scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    const zoomRange = h('input', { class: 'o-range', type: 'range', min: '1', max: '6', step: '0.01', value: '1', 'aria-label': t('zoom') });
    zoomRange.addEventListener('input', () => setScale(minScale * parseFloat(zoomRange.value)));
    const result = await app.dialog((dlg, done) => {
      dlg.append(h('h3', null, t('crop_title')), h('div', { class: 'o-crop' }, stage, h('div', { class: 'o-row', style: { width: '100%' } }, icon('zoomOut', 14), zoomRange, icon('zoomIn', 14)), h('p', { class: 'o-help' }, t('crop_hint'))),
        h('div', { class: 'o-actions' }, h('button', { class: 'o-btn', type: 'button', on: { click: () => done(null) } }, t('cancel')), h('button', { class: 'o-btn primary', type: 'button', on: { click: async () => { try { done(await K.cropAvatar(bmp, view, 128, LIMITS.MAX_AVATAR_BYTES)); } catch (e) { app.toast(t('toast_error', { msg: e.message }), 'error'); done(null); } } } }, t('crop_use'))));
    });
    if (bmp.close) bmp.close();
    return result;
  };

  /* ================================================================ */
  /* Settings                                                         */
  /* ================================================================ */
  Parts.renderSettings = function (app, container, params) {
    params = params || {};
    const S = app.state; const s = () => S.settings;
    const scroll = h('div', { class: 'o-scroll o-settings-scroll' });
    const nav = h('div', { class: 'o-settings-nav' });
    const sections = {};
    const jump = (key) => { const node = sections[key]; if (node) node.scrollIntoView({ block: 'start', behavior: s().reduceMotion ? 'auto' : 'smooth' }); };
    [['appearance', t('appearance'), 'palette'], ['notifications', t('notifications'), 'bell'], ['advanced', t('advanced'), 'bolt'], ['diagnostics', t('diagnostics'), 'refresh']].forEach(([key, label, ic]) => nav.appendChild(h('button', { class: 'o-chip', type: 'button', on: { click: () => key === 'diagnostics' ? app.navigate('diagnostics') : jump(key) } }, icon(ic, 12), label)));
    container.append(app.subHead(t('settings'), t('shortcuts_hint', { toggle: 'Alt+Shift+C', boss: 'Alt+Shift+H' })), nav, scroll);

    /* ---- appearance ---- */
    const accentSw = h('div', { class: 'o-swatches' });
    const drawAccents = () => {
      clear(accentSw);
      Object.entries(ACCENTS).forEach(([key, a]) => accentSw.appendChild(h('button', { class: 'o-swatch' + (s().accent === key ? ' on' : ''), type: 'button', style: { background: a.color }, title: key, 'aria-label': key, 'aria-pressed': String(s().accent === key), on: { click: () => { app.saveSettings({ accent: key }); drawAccents(); } } })));
      const custom = h('input', { type: 'color', value: K.hexValid(s().accentCustom) ? s().accentCustom : '#ff6a1f', 'aria-label': t('custom') });
      custom.addEventListener('input', debounced(() => { app.saveSettings({ accent: 'custom', accentCustom: custom.value }); drawAccents(); }, 150));
      accentSw.appendChild(h('span', { class: 'o-swatch custom' + (s().accent === 'custom' ? ' on' : ''), title: t('custom') }, custom));
    };
    drawAccents();
    const roomScoped = params.roomId || (S.roomId && S.live.has(S.roomId) ? S.roomId : null);
    const bgBox = h('div');
    let bgScope = roomScoped && app.roomEntry(roomScoped) && app.roomEntry(roomScoped).background ? 'room' : 'global';
    const bgGet = () => (bgScope === 'room' && app.roomEntry(roomScoped) && app.roomEntry(roomScoped).background) || s().background || { type: 'none' };
    const bgSet = async (patch) => {
      const next = { ...DEFAULT_SETTINGS.background, ...bgGet(), ...patch };
      if (bgScope === 'room' && roomScoped) await app.patchRoomEntry(roomScoped, { background: next }); else await app.saveSettings({ background: next });
      if (app.el.chatBg && S.roomId) app.applyChatBg(app.el.chatBg, S.roomId);
      drawBg();
    };
    const drawBg = () => {
      clear(bgBox); const bg = bgGet();
      if (roomScoped) bgBox.appendChild(field(t('bg_scope'), seg([['global', t('bg_global')], ['room', t('bg_room')]], bgScope, (v) => { bgScope = v; if (v === 'global' && roomScoped) app.patchRoomEntry(roomScoped, { background: null }); drawBg(); })));
      bgBox.appendChild(seg([['none', t('bg_none')], ['pattern', t('bg_pattern')], ['image', t('bg_image')]], bg.type || 'none', (v) => bgSet({ type: v })));
      if (bg.type === 'pattern') {
        const grid = h('div', { class: 'o-bg-presets', style: { marginTop: '10px' } });
        ['dots', 'grid', 'lines', 'stars'].forEach((p) => { const prev = h('div', { class: 'o-chat-bg pattern-' + p }); grid.appendChild(h('button', { class: 'o-bg-preset' + (bg.pattern === p ? ' on' : ''), type: 'button', title: p, 'aria-label': p, 'aria-pressed': String(bg.pattern === p), on: { click: () => bgSet({ pattern: p }) } }, prev)); });
        bgBox.appendChild(grid);
      } else if (bg.type === 'image') {
        const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'o-hidden' });
        file.addEventListener('change', async () => { const f = file.files[0]; file.value = ''; if (!f) return; try { const r = await K.shrinkForSticker(f, 1200, 400 * 1024); await bgSet({ dataUrl: r.dataUrl }); } catch (e) { app.toast(t('unsupported_image'), 'error'); } });
        const preview = h('div', { class: 'o-bg-preset', style: { height: '90px', marginTop: '10px', backgroundImage: bg.dataUrl ? `url("${bg.dataUrl}")` : '', backgroundSize: 'cover', backgroundPosition: 'center' } });
        bgBox.append(preview, h('div', { class: 'o-row', style: { marginTop: '8px' } }, h('button', { class: 'o-btn sm', type: 'button', on: { click: () => file.click() } }, icon('upload', 13), t('bg_upload')), file),
          field(t('bg_blur'), range(0, 12, 1, bg.blur || 0, debounced((v) => bgSet({ blur: v }), 200), (v) => v + 'px')),
          field(t('bg_dim'), range(0, 0.8, 0.05, bg.dim == null ? 0.35 : bg.dim, debounced((v) => bgSet({ dim: v }), 200), (v) => Math.round(v * 100) + '%')));
      }
    };
    drawBg();
    sections.appearance = section(t('appearance'),
      field(t('theme'), seg([['light', t('theme_light'), 'sun'], ['dark', t('theme_dark'), 'moon'], ['auto', t('theme_auto')]], s().theme, (v) => app.saveSettings({ theme: v }))),
      field(t('accent'), accentSw),
      field(t('font_size'), range(12, 18, 1, s().fontSize || 14, (v) => app.saveSettings({ fontSize: v }), (v) => v + 'px')),
      field(t('message_style'), seg([['bubble', t('style_bubble')], ['flat', t('style_flat')]], s().bubbleStyle || 'bubble', (v) => app.saveSettings({ bubbleStyle: v }))),
      app.isEmbedded ? null : field(t('panel_side'), seg([['left', t('left'), 'panelLeft'], ['right', t('right'), 'panelRight']], s().side, (v) => { app.saveSettings({ side: v }); if (app.hooks.onSideChange) app.hooks.onSideChange(v); })),
      app.isEmbedded ? null : field(t('panel_opacity'), range(0.6, 1, 0.05, s().panelOpacity == null ? 1 : s().panelOpacity, (v) => app.saveSettings({ panelOpacity: v }), (v) => Math.round(v * 100) + '%')),
      field(t('dot_size'), range(14, 18, 1, s().dotSize || 16, (v) => app.saveSettings({ dotSize: v }), (v) => v + 'px')),
      field(t('dot_opacity'), range(0.3, 1, 0.05, s().dotIdleOpacity == null ? 0.7 : s().dotIdleOpacity, (v) => app.saveSettings({ dotIdleOpacity: v }), (v) => Math.round(v * 100) + '%')),
      field(t('chat_background'), bgBox),
      h('div', { class: 'o-card', style: { marginBottom: '16px' } },
        toggle(t('compact_mode'), null, s().compact, (v) => app.saveSettings({ compact: v })),
        toggle(t('reduce_motion'), null, s().reduceMotion, (v) => app.saveSettings({ reduceMotion: v })),
        toggle(t('peek_mode'), null, s().peek !== false, (v) => app.saveSettings({ peek: v })),
        toggle(t('auto_hide_fullscreen'), null, s().autoHideFullscreen !== false, (v) => app.saveSettings({ autoHideFullscreen: v }))),
      field(t('toolbar_icon'), seg([['color', t('icon_color')], ['mono', t('icon_mono')]], s().toolbarIcon || 'color', (v) => app.saveSettings({ toolbarIcon: v }))));

    /* ---- notifications & privacy ---- */
    const soundSel = h('select', { class: 'o-select', 'aria-label': t('sound_name') });
    ['blip', 'pop', 'chime'].forEach((n) => soundSel.appendChild(h('option', { value: n, selected: s().soundName === n ? '' : null }, n)));
    soundSel.addEventListener('change', () => app.saveSettings({ soundName: soundSel.value }));
    const dnd = s().dndSchedule || { enabled: false, start: '22:00', end: '08:00' };
    const dndStart = h('input', { class: 'o-input mono', type: 'time', value: dnd.start || '22:00', 'aria-label': t('from') });
    const dndEnd = h('input', { class: 'o-input mono', type: 'time', value: dnd.end || '08:00', 'aria-label': t('to') });
    const dndSave = () => app.saveSettings({ dndSchedule: { ...(s().dndSchedule || {}), start: dndStart.value || '22:00', end: dndEnd.value || '08:00' } });
    dndStart.addEventListener('change', dndSave); dndEnd.addEventListener('change', dndSave);
    const sitesList = h('div', { class: 'o-list' });
    const drawSites = () => {
      clear(sitesList);
      (s().hiddenSites || []).forEach((site) => sitesList.appendChild(h('div', { class: 'o-list-item' }, icon('eyeOff', 13), h('span', { class: 'o-grow' }, site), h('button', { class: 'o-ibtn sm', type: 'button', 'aria-label': t('remove'), on: { click: () => { app.saveSettings({ hiddenSites: (s().hiddenSites || []).filter((x) => x !== site) }); drawSites(); } } }, icon('close', 13)))));
    };
    drawSites();
    const siteInput = h('input', { class: 'o-input mono', type: 'text', placeholder: t('site_placeholder'), 'aria-label': t('add_site') });
    const addSite = () => { const v = siteInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); if (!v) return; const list = new Set(s().hiddenSites || []); list.add(v); app.saveSettings({ hiddenSites: Array.from(list) }); siteInput.value = ''; drawSites(); };
    siteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSite(); } });
    const host = app.env.host;
    const hereBtn = host && !app.isEmbedded ? h('button', { class: 'o-btn sm', type: 'button', on: { click: () => { const list = new Set(s().hiddenSites || []); if (list.has(host)) list.delete(host); else list.add(host); app.saveSettings({ hiddenSites: Array.from(list) }); drawSites(); app.renderCurrent(); } } }, icon('eyeOff', 13), (s().hiddenSites || []).includes(host) ? t('show_here_again', { host }) : t('never_show_here', { host })) : null;
    const hideUntilRow = s().hideUntil > Date.now() ? h('div', { class: 'o-banner-note', style: { margin: '0 0 12px' } }, icon('clock', 14), h('span', { class: 'o-grow' }, t('hidden_until', { time: K.fmtTime(s().hideUntil) })), h('button', { class: 'o-btn sm', type: 'button', on: { click: () => { app.saveSettings({ hideUntil: 0 }); app.renderCurrent(); } } }, t('unhide_now'))) : null;
    const mutedList = h('div', { class: 'o-list' });
    const drawMuted = () => {
      clear(mutedList);
      (s().mutedUsers || []).forEach((uid) => { let name = uid.slice(0, 10) + '…'; for (const live of S.live.values()) { const m = live.members.find((x) => x.userId === uid); if (m) { name = m.name; break; } } mutedList.appendChild(h('div', { class: 'o-list-item' }, icon('mute', 13), h('span', { class: 'o-grow' }, name), h('button', { class: 'o-btn sm', type: 'button', on: { click: () => { app.toggleMuteUser(uid, name, false).then(drawMuted); } } }, t('unmute')))); });
    };
    drawMuted();
    const usage = h('span', { class: 'o-help' }, t('cache_used', { mb: '…' }));
    app.request({ type: 'storage:usage' }).then((r) => { usage.textContent = t('cache_used', { mb: ((r.imageBytes || 0) / 1048576).toFixed(1) }); }).catch(() => {});
    sections.notifications = section(t('notifications'),
      hideUntilRow,
      h('div', { class: 'o-card', style: { marginBottom: '16px' } },
        toggle(t('desktop_notifications'), null, s().notifications !== false, (v) => app.saveSettings({ notifications: v })),
        toggle(t('sound'), null, s().sound !== false, (v) => app.saveSettings({ sound: v })),
        h('div', { class: 'o-row', style: { padding: '8px 0' } }, h('span', { class: 'o-tl o-grow' }, t('sound_name')), h('div', { style: { width: '120px' } }, soundSel), h('button', { class: 'o-btn sm', type: 'button', on: { click: () => app.request({ type: 'sound:test', name: soundSel.value }) } }, icon('play', 12), t('test_sound'))),
        toggle(t('notify_on_mention'), null, s().notifyOnMention !== false, (v) => app.saveSettings({ notifyOnMention: v })),
        toggle(t('dnd_schedule'), null, dnd.enabled, (v) => app.saveSettings({ dndSchedule: { ...(s().dndSchedule || dnd), enabled: v } })),
        h('div', { class: 'o-row', style: { padding: '4px 0 8px' } }, h('span', { class: 'o-small o-muted' }, t('from')), dndStart, h('span', { class: 'o-small o-muted' }, t('to')), dndEnd)),
      field(t('hidden_sites'), h('div', null, sitesList, h('div', { class: 'o-row', style: { marginTop: '8px' } }, siteInput, h('button', { class: 'o-btn sm', type: 'button', on: { click: addSite } }, icon('plus', 13), t('add_site'))), hereBtn ? h('div', { style: { marginTop: '8px' } }, hereBtn) : null), t('boss_key', { keys: 'Alt+Shift+H' })),
      h('div', { class: 'o-card', style: { marginBottom: '16px' } },
        toggle(t('link_previews'), t('link_previews_warning'), !!s().linkPreviews, (v) => app.saveSettings({ linkPreviews: v }))),
      field(t('max_image_mb'), range(1, 20, 1, s().maxImageMB || 6, (v) => app.saveSettings({ maxImageMB: v }), (v) => v + ' MB'), t('exif_note')),
      field(t('image_cache'), h('div', null, range(50, 1000, 50, s().imageCacheMB || 200, (v) => app.saveSettings({ imageCacheMB: v }), (v) => v + ' MB'), usage)),
      (s().mutedUsers || []).length ? field(t('muted_people'), mutedList) : null,
      h('div', { class: 'o-field' }, h('button', { class: 'o-btn danger block', type: 'button', on: { click: async () => { if (await app.confirm(t('clear_all_data'), t('clear_all_confirm'))) { try { await app.request({ type: 'data:reset' }, 20000); app.toast(t('data_cleared'), 'ok'); setTimeout(() => { if (app.isEmbedded) location.reload(); else app.reloadStorage(); }, 300); } catch (e) { /* toast shown */ } } } } }, icon('trash', 14), t('clear_all_data'))));

    /* ---- advanced ---- */
    const sigSel = h('select', { class: 'o-select', 'aria-label': t('signaling') });
    [['peerjs', t('sig_peerjs')]].forEach(([v, l]) => sigSel.appendChild(h('option', { value: v, selected: s().signaling === v ? '' : null }, l)));
    sigSel.addEventListener('change', () => app.saveSettings({ signaling: sigSel.value }));
    const iceTa = h('textarea', { class: 'o-ta o-input mono', rows: '6', style: { maxHeight: 'none', minHeight: '120px', fontSize: '12px' }, 'aria-label': t('ice_servers') });
    iceTa.value = JSON.stringify(s().iceServers || DEFAULT_ICE_SERVERS, null, 2);
    const iceErr = h('p', { class: 'o-help warn o-hidden' }, t('ice_invalid'));
    const iceSave = async () => {
      try {
        const arr = JSON.parse(iceTa.value);
        if (!Array.isArray(arr) || !arr.every((x) => x && typeof x === 'object' && (typeof x.urls === 'string' || (Array.isArray(x.urls) && x.urls.every((u) => typeof u === 'string'))))) throw new Error('shape');
        const clean = arr.map((x) => { const o = { urls: x.urls }; if (typeof x.username === 'string') o.username = x.username; if (typeof x.credential === 'string') o.credential = x.credential; if (typeof x.restSecret === 'string') o.restSecret = x.restSecret; return o; });
        iceErr.classList.add('o-hidden'); await app.saveSettings({ iceServers: clean }); app.toast(t('ice_saved'), 'ok');
      } catch (e) { iceErr.classList.remove('o-hidden'); }
    };
    sections.advanced = section(t('advanced'),
      field(t('signaling'), sigSel, t('signaling_help')),
      field(t('ice_servers'), h('div', null, iceTa, iceErr, h('div', { class: 'o-row', style: { marginTop: '8px' } }, h('button', { class: 'o-btn sm primary', type: 'button', on: { click: iceSave } }, icon('save', 13), t('save')), h('button', { class: 'o-btn sm ghost', type: 'button', on: { click: () => { iceTa.value = JSON.stringify(DEFAULT_ICE_SERVERS, null, 2); iceSave(); } } }, icon('refresh', 13), t('reset_defaults')))), t('ice_help')),
      field(t('diagnostics'), h('button', { class: 'o-btn', type: 'button', on: { click: () => app.navigate('diagnostics') } }, icon('bolt', 14), t('diagnostics'))),
      h('p', { class: 'o-help o-mono' }, `${O.BRAND_NAME} · ${t('schema_version', { v: DEFAULT_SETTINGS.schemaVersion })} · id ${(S.userId || '').slice(0, 10)}…`),
      h('p', { class: 'o-help' }, t('shortcuts_hint', { toggle: 'Alt+Shift+C', boss: 'Alt+Shift+H' })));

    /* ---- about: where to download it, where the source lives ---- */
    const repo = O.REPO || {};
    // Content scripts cannot call chrome.tabs, so links go through the service worker; window.open is the
    // fallback for side-panel/extension contexts that cannot reach the worker.
    const openTab = (url) => {
      if (!url) return;
      try {
        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) { chrome.tabs.create({ url }).catch(() => {}); return; }
      } catch (e) { /* fall through */ }
      try { app.bridge.send({ type: 'open-url', url }); } catch (e) { /* fall through */ }
      try { window.open(url, '_blank', 'noopener'); } catch (e) { /* give up quietly */ }
    };
    const version = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return O.APP_VERSION || '?'; } })();
    const linkRow = (label, help, url, ic) => h('div', { class: 'o-about-row' },
      h('div', { class: 'o-grow', style: { minWidth: '0' } }, h('div', { class: 'o-about-label' }, label), help ? h('div', { class: 'o-help', style: { margin: '2px 0 0' } }, help) : null),
      h('button', { class: 'o-btn sm', type: 'button', title: url, on: { click: () => openTab(url) } }, icon(ic || 'external', 14), t('open')));
    sections.about = section(t('about'),
      h('p', { class: 'o-help' }, t('about_version', { v: version }), ' · ', t('about_license')),
      linkRow(t('about_repo'), t('about_repo_help'), repo.url || '', 'code'),
      h('div', { class: 'o-row' },
        h('button', { class: 'o-btn', type: 'button', on: { click: () => openTab(repo.zipUrl || repo.url || '') } }, icon('download', 14), t('about_download')),
        h('button', { class: 'o-btn ghost', type: 'button', on: { click: () => openTab(repo.releasesUrl || repo.url || '') } }, icon('star', 14), t('about_releases')),
        h('button', { class: 'o-btn ghost', type: 'button', on: { click: () => openTab(repo.issuesUrl || repo.url || '') } }, icon('warning', 14), t('about_issues'))),
      h('p', { class: 'o-help o-mono' }, repo.url || ''));

    scroll.append(sections.appearance, sections.notifications, sections.advanced, sections.about, h('div', { style: { height: '24px' } }));
    if (params.section) setTimeout(() => jump(params.section), 50);
  };

  /* ================================================================ */
  /* Diagnostics                                                      */
  /* ================================================================ */
  Parts.renderDiagnostics = function (app, container) {
    const S = app.state;
    const body = h('div', { class: 'o-scroll o-diag', style: { padding: '12px 16px' } });
    const testResults = new Map(), testing = new Set();
    const refreshBtn = h('button', { class: 'o-ibtn', type: 'button', title: t('run_diagnostics'), 'aria-label': t('run_diagnostics'), on: { click: () => draw() } }, icon('refresh', 16));
    container.append(app.subHead(t('diagnostics'), null, refreshBtn), body);
    function renderTestResult(result) {
      if (!result) return null;
      const box = h('div', { class: 'o-help', style: { marginTop: '10px', padding: '9px 10px', border: '1px solid var(--o-hair)', borderRadius: '8px' } });
      const signalText = `${t('connection_test_signaling')}: ${result.relayOpen ? 'OK' : 'FAILED'}${(result.relay || []).length ? ' · ' + result.relay.map((r) => r.state).join(', ') : ''}`;
      box.appendChild(h('div', { class: result.relayOpen ? 'ok' : 'bad' }, signalText));
      box.appendChild(h('div', { class: 'o-muted', style: { marginTop: '3px', wordBreak: 'break-all' } }, `Orbit v${(() => { try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; } })()} · ICE: ${(result.iceUrls || []).join(', ')}`));
      const types = (result.iceTypes || []).join(', ') || t('connection_test_no_candidates');
      box.appendChild(h('div', { style: { marginTop: '4px' } }, `${t('connection_test_ice')}: ${result.iceGathering} · ${types}`));
      if (result.iceErrors && result.iceErrors.length) box.appendChild(h('div', { class: 'warn', style: { marginTop: '3px' } }, `${t('connection_test_errors')}: ${result.iceErrors.map((e) => `${e.code}${e.text ? ' ' + e.text : ''}`).join(' · ')}`));
      if (!(result.peers || []).length) box.appendChild(h('div', { class: 'o-muted', style: { marginTop: '4px' } }, t('connection_test_no_peers')));
      else {
        box.appendChild(h('div', { style: { marginTop: '5px', fontWeight: '600' } }, t('connection_test_peers') + ':'));
        result.peers.forEach((p) => {
          const ok = Number.isFinite(p.rttMs);
          const detail = `${p.name || p.userId || t('peer')}: ${p.connectionState}/${p.iceState} · ${ok ? `${p.rttMs} ms ${t('connection_test_ping_ok')}` : t('connection_test_ping_fail')}${p.selectedPath ? ' · ' + p.selectedPath : ''}`;
          box.appendChild(h('div', { class: ok ? 'ok' : 'warn', style: { marginTop: '3px', overflowWrap: 'anywhere' } }, detail));
        });
      }
      box.appendChild(h('div', { class: 'o-muted', style: { marginTop: '5px' } }, `${t('connection_test_elapsed')}: ${Math.round(result.elapsedMs || 0)} ms`));
      return box;
    }
    async function runConnectionTest(roomId) {
      if (testing.has(roomId)) return;
      testing.add(roomId); draw();
      try { testResults.set(roomId, await app.request({ type: 'room:connectionTest', roomId }, 30000)); }
      catch (e) { testResults.set(roomId, { relayOpen: false, relay: [], iceGathering: 'error', iceTypes: [], iceErrors: [{ code: 0, text: e && e.message || 'Test failed' }], peers: [], elapsedMs: 0 }); }
      finally { testing.delete(roomId); draw(); }
    }
    async function draw() {
      const ids = Array.from(S.live.keys());
      const frag = document.createDocumentFragment();
      if (!ids.length) frag.appendChild(h('div', { class: 'o-empty' }, t('diag_none')));
      for (const id of ids) {
        let d; try { d = await app.request({ type: 'room:diagnostics', roomId: id }); } catch (e) { continue; }
        const live = S.live.get(id);
        const card = h('div', { class: 'o-card', style: { marginBottom: '12px' } });
        card.appendChild(h('div', { class: 'o-row between', style: { marginBottom: '8px' } }, h('b', { class: 'o-mono' }, '#' + (live ? live.title || live.name : id)), h('span', { class: 'o-status ' + d.status }, d.status)));
        card.appendChild(h('div', { class: 'o-help o-mono', style: { margin: '0 0 8px' } }, `${t('signaling')}: ${d.strategy} · ${t('keeper')}: ${(live && live.members.find((m) => m.userId === d.keeper) || {}).name || '—'}${d.lastError ? ' · ' + d.lastError : ''}`));
        const isTesting = testing.has(id);
        const testButton = h('button', { class: 'o-btn sm', type: 'button', disabled: isTesting, on: { click: () => runConnectionTest(id) } }, isTesting ? t('testing_connection') : t('test_connection'));
        card.appendChild(h('div', { class: 'o-row', style: { margin: '0 0 4px' } }, testButton));
        card.appendChild(h('div', { class: 'o-help', style: { margin: '0 0 8px' } }, t('connection_test_help')));
        const testResult = renderTestResult(testResults.get(id)); if (testResult) card.appendChild(testResult);
        const rel = h('table', null, h('thead', null, h('tr', null, h('th', null, t('relays')), h('th', null, t('state')))));
        const rb = h('tbody'); (d.relays || []).forEach((r) => rb.appendChild(h('tr', null, h('td', { style: { wordBreak: 'break-all' } }, r.url), h('td', { class: r.state === 'open' ? 'ok' : r.state === 'connecting' ? 'warn' : 'bad' }, r.state)))); rel.appendChild(rb);
        const peers = h('table', { style: { marginTop: '8px' } }, h('thead', null, h('tr', null, h('th', null, t('peer')), h('th', null, t('state')), h('th', null, t('rtt')), h('th', null, t('candidate')))));
        const pb = h('tbody');
        if (!(d.peers || []).length) pb.appendChild(h('tr', null, h('td', { colspan: '4', class: 'o-muted' }, t('nobody_here'))));
        (d.peers || []).forEach((p) => pb.appendChild(h('tr', null, h('td', null, p.name || p.userId || p.transportId.slice(0, 8)), h('td', { class: p.connectionState === 'connected' ? 'ok' : /fail|closed|disconnected/.test(p.connectionState) ? 'bad' : 'warn' }, `${p.connectionState}/${p.iceState}`), h('td', null, p.rtt != null ? p.rtt + ' ms' : '—'), h('td', null, p.candidate || '—'))));
        peers.appendChild(pb);
        card.append(rel, peers);
        frag.appendChild(card);
      }
      if (!body.isConnected) return;
      clear(body); body.appendChild(frag);
    }
    draw();
    const timer = setInterval(() => { if (!body.isConnected || S.view !== 'diagnostics') { clearInterval(timer); return; } draw(); }, 4000);
  };

  /* ================================================================ */
  /* Onboarding tour                                                  */
  /* ================================================================ */
  Parts.showTour = function (app) {
    const steps = [
      { title: t('tour1_title'), body: t('tour1_body'), art: () => K.orbitMark(72) },
      { title: t('tour2_title'), body: t('tour2_body'), art: () => h('div', { class: 'o-mono', style: { fontSize: '13px', lineHeight: '1.8', textAlign: 'left', background: 'var(--o-code)', padding: '10px 14px', borderRadius: '10px', border: '1px solid var(--o-hair)' } }, 'cheat group', h('br'), 'Cheat-Group', h('br'), 'CHEAT   GROUP', h('br'), h('span', { style: { color: 'var(--o-accent)' } }, '→ cheat-group')) },
      { title: t('tour3_title'), body: t('tour3_body'), art: () => h('div', { class: 'o-row' }, ...[0, 3, 7].map((v) => K.avatarNode({ avatar: { type: 'generated', variant: v }, name: app.state.profile.name || 'orbit' }, 44))) }
    ];
    let i = 0;
    app.dialog((dlg, done) => {
      dlg.classList.add('o-tour');
      const draw = () => {
        clear(dlg); const st = steps[i];
        dlg.append(h('div', { class: 'o-tour-art' }, st.art()), h('h3', null, st.title), h('p', null, st.body),
          h('div', { class: 'o-dots' }, ...steps.map((_, k) => h('i', { class: k === i ? 'on' : '' }))),
          h('div', { class: 'o-actions' }, h('button', { class: 'o-btn ghost', type: 'button', on: { click: () => done(false) } }, t('skip')), h('button', { class: 'o-btn primary', type: 'button', on: { click: () => { if (i < steps.length - 1) { i++; draw(); } else done(true); } } }, i < steps.length - 1 ? t('next') : t('finish'))));
        const b = dlg.querySelector('.primary'); if (b) b.focus();
      };
      draw();
    }).then(() => app.saveSettings({ onboarded: true }));
  };

  root.OrbitPanelParts = Parts;
})(typeof globalThis !== 'undefined' ? globalThis : self);
