/* Orbit — UI kit: safe DOM builders, inline SVG icons, procedural avatars, rich-text rendering,
 * image processing (resize / EXIF strip / crop), time formatting, fuzzy search.
 * Shared by the in-page panel (closed shadow root) and the side panel page.
 *
 * SECURITY: no innerHTML/outerHTML/insertAdjacentHTML/DOMParser anywhere — every node is built
 * with createElement/textContent, so untrusted peer text can never become markup. This also
 * keeps us working on pages that enforce Trusted Types.
 */
(function (root) {
  'use strict';
  if (root.OrbitKit) return;
  const O = root.ORBIT;
  const t = (k, v) => root.OrbitStrings.t(k, v);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ---------------- DOM ---------------- */
  function append(parent, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach((c) => append(parent, c)); return; }
    if (child instanceof Node) { parent.appendChild(child); return; }
    parent.appendChild(document.createTextNode(String(child)));
  }
  /** h(tag, props, ...children). props: class, style{}, on{}, data{}, aria{}, any attribute; text via children. */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && v && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sv == null) continue; if (sk.includes('-')) el.style.setProperty(sk, String(sv)); else el.style[sk] = sv; } }
        else if (k === 'on') for (const ev in v) el.addEventListener(ev, v[ev]);
        else if (k === 'data') for (const d in v) el.dataset[d] = v[d];
        else if (k === 'aria') for (const a in v) el.setAttribute('aria-' + a, v[a]);
        else if (k === 'ref') v(el);
        else if (k in el && typeof v !== 'string' && k !== 'value') { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
        else if (k === 'value') el.value = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, children);
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function svgEl(tag, attrs, ...children) { const el = document.createElementNS(SVG_NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); children.forEach((c) => c && el.appendChild(c)); return el; }

  /* ---------------- icons (24x24 stroke) ---------------- */
  const ICONS = {
    close: 'M6 6l12 12M18 6L6 18', back: 'M15 5l-7 7 7 7', chevronRight: 'M9 5l7 7-7 7', chevronDown: 'M5 9l7 7 7-7', chevronUp: 'M5 15l7-7 7 7',
    send: 'M4 12l16-8-6 16-2-7-8-1z', image: 'M4 5h16v14H4zM8 10a1.5 1.5 0 1 0 0 .01M4 17l5-5 4 4 3-3 4 4',
    emoji: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 14s1.2 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01', sticker: 'M5 4h10l5 5v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM14 4v6h6',
    search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.5-4.5', settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4.6 9l-1.4-1 1.5-2.6 1.6.6a7 7 0 0 1 2-1.2L8.6 3h2.8l.3 1.8a7 7 0 0 1 2 1.2l1.6-.6 1.5 2.6-1.4 1v2.4l1.4 1-1.5 2.6-1.6-.6a7 7 0 0 1-2 1.2l-.3 1.8H8.6l-.3-1.8a7 7 0 0 1-2-1.2l-1.6.6-1.5-2.6 1.4-1z',
    users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 6.5M21 20a6 6 0 0 0-4-5.6', pin: 'M9 4h6l-1 6 3 3v1H7v-1l3-3zM12 14v6', pinned: 'M9 4h6l-1 6 3 3v1H7v-1l3-3zM12 14v6M6 6l12 12',
    more: 'M5 12h.01M12 12h.01M19 12h.01', reply: 'M9 7L4 12l5 5M4 12h9a7 7 0 0 1 7 7', edit: 'M4 20h4l10.5-10.5a1.5 1.5 0 0 0 0-2.1l-1.9-1.9a1.5 1.5 0 0 0-2.1 0L4 16z', trash: 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
    copy: 'M9 9h10v11H9zM5 15V4h10', download: 'M12 4v11m-5-4l5 5 5-5M5 20h14', zoomIn: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.5-4.5M10.5 8v5M8 10.5h5', zoomOut: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.5-4.5M8 10.5h5',
    bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0', bellOff: 'M4 4l16 16M8 16V11a6 6 0 0 1 1.5-4M18 13V11a6 6 0 0 0-2-4.5M6 16l-1.5 2h13M10 20a2 2 0 0 0 4 0',
    check: 'M5 12l5 5L20 7', checkAll: 'M2 12l5 5L17 7M9 17l3 3L22 10', clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2', plus: 'M12 5v14M5 12h14', minus: 'M5 12h14',
    external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6', arrowDown: 'M12 4v16m-6-6l6 6 6-6', lock: 'M6 11h12v10H6zM8 11V8a4 4 0 0 1 8 0v3', sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z', palette: 'M12 3a9 9 0 0 0 0 18h1.5a2 2 0 0 0 1.5-3.3 2 2 0 0 1 1.5-3.2H18a3 3 0 0 0 3-3A8.7 8.7 0 0 0 12 3zM7.5 12h.01M10 7.5h.01M15 7.5h.01',
    upload: 'M12 20V9m-5 4l5-5 5 5M5 4h14', key: 'M15 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11.5 12.5L4 20v-3l1.5-1.5L7 14', refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5', info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
    warning: 'M12 4l9 16H3zM12 10v4M12 17.5h.01', at: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm0 0v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1', hash: 'M5 9h14M5 15h14M10 4L8 20M16 4l-2 16',
    star: 'M12 3l2.8 5.9 6.2.8-4.5 4.4 1.1 6.2L12 17.3 6.4 20.3l1.1-6.2L3 9.7l6.2-.8z', grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01', expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    sidebar: 'M4 5h16v14H4zM15 5v14', help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01', logout: 'M10 4H5v16h5M14 8l4 4-4 4M18 12H9',
    eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', eyeOff: 'M3 3l18 18M10 6.3A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3 3.5M6 7.5A16 16 0 0 0 2 12s3.5 6 10 6c1.4 0 2.6-.3 3.7-.7M9.9 9.9a3 3 0 0 0 4.2 4.2',
    wand: 'M4 20l10-10M14 4v3M18 8h3M17 5l1.5-1.5M13 13l7 7', play: 'M7 5l12 7-12 7z', mute: 'M4 10v4h4l5 4V6L8 10zM16 9l5 6M21 9l-5 6', volume: 'M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5', dice: 'M4 4h16v16H4zM8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01',
    dot: 'M12 12m-3.5 0a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0', broadcast: 'M12 12m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M7 17a7 7 0 0 1 0-10M17 7a7 7 0 0 1 0 10M4.5 19.5a11 11 0 0 1 0-15M19.5 4.5a11 11 0 0 1 0 15',
    filter: 'M4 5h16l-6 8v6l-4-2v-4z', minimize: 'M5 12h14', panelLeft: 'M4 5h16v14H4zM9 5v14', panelRight: 'M4 5h16v14H4zM15 5v14', drag: 'M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01',
    mic: 'M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zM19 11a7 7 0 0 1-14 0M12 18v4M8 22h8', chart: 'M4 19V5M4 19h16M8 15v-4M12 15V7M16 15v-7M20 15v-4', text: 'M5 6h14M12 6v12M9 18h6', paperclip: 'M20 12l-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8', save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
    smile: 'M8.5 14s1.2 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', shield: 'M12 3l8 3v6c0 4.5-3.5 8-8 9-4.5-1-8-4.5-8-9V6z', bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
    monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
    screenShare: 'M3 5h18v11H3zM8 20h8M12 16v4M12 12V7m-2 2l2-2 2 2',
    stopSquare: 'M7 7h10v10H7z',
    code: 'M9 8l-4 4 4 4M15 8l4 4-4 4'
  };
  function icon(name, size) {
    const s = svgEl('svg', { viewBox: '0 0 24 24', width: size || 18, height: size || 18, class: 'ic', 'aria-hidden': 'true', focusable: 'false' });
    s.appendChild(svgEl('path', { d: ICONS[name] || ICONS.help, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return s;
  }
  /** The Orbit mark (logo) as inline SVG. */
  function orbitMark(size, color) {
    const s = svgEl('svg', { viewBox: '0 0 40 40', width: size || 20, height: size || 20, class: 'orbit-mark', 'aria-hidden': 'true' });
    const c = color || 'currentColor';
    const g = svgEl('g', { transform: 'rotate(-30 20 20)' });
    g.appendChild(svgEl('path', { d: 'M 3 20 a 17 7 0 1 0 34 0 a 17 7 0 1 0 -34 0', fill: 'none', stroke: c, 'stroke-width': '2.4', opacity: '.85' }));
    g.appendChild(svgEl('circle', { cx: '8.2', cy: '25.4', r: '3.2', fill: c }));
    s.appendChild(svgEl('circle', { cx: '20', cy: '20', r: '7.5', fill: c }));
    s.appendChild(g);
    return s;
  }

  /* ---------------- misc ---------------- */
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  function debounce(fn, ms) { let tm; return function (...a) { clearTimeout(tm); tm = setTimeout(() => fn.apply(this, a), ms); }; }
  function throttle(fn, ms) { let last = 0, tm; return function (...a) { const n = Date.now(); const rem = ms - (n - last); if (rem <= 0) { last = n; fn.apply(this, a); } else if (!tm) tm = setTimeout(() => { tm = null; last = Date.now(); fn.apply(this, a); }, rem); }; }
  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  function hashStr(s) { let h = 2166136261; s = String(s || ''); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** Mirrors offscreen/crypto.js normalizeRoomName — keep in sync. */
  function normalizeRoomName(input) {
    let s = String(input || '').normalize('NFKC').toLowerCase();
    s = s.replace(/[^\p{L}\p{N}\p{M}\s_\-]/gu, ' ');
    s = s.replace(/[\s_\-]+/g, '-');
    s = s.replace(/^-+|-+$/g, '');
    return s.slice(0, 64);
  }
  function hexValid(hex) { return /^#[0-9a-fA-F]{6}$/.test(hex || ''); }
  function inkFor(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#1C1611'; const n = parseInt(m[1], 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255; return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1C1611' : '#FFFFFF'; }
  function accentOf(settings) { return settings.accent === 'custom' ? (hexValid(settings.accentCustom) ? settings.accentCustom : O.ACCENTS.tangerine.color) : (O.ACCENTS[settings.accent] || O.ACCENTS.tangerine).color; }
  function accentInkOf(settings) { return settings.accent === 'custom' ? inkFor(settings.accentCustom) : (O.ACCENTS[settings.accent] || O.ACCENTS.tangerine).ink; }
  function hexToRgb(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '255,106,31'; const n = parseInt(m[1], 16); return `${n >> 16},${(n >> 8) & 255},${n & 255}`; }
  function fmtBytes(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }

  /* ---------------- time ---------------- */
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const fullFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  function fmtTime(ts) { return timeFmt.format(new Date(ts)); }
  function fmtFull(ts) { return fullFmt.format(new Date(ts)); }
  function sameDay(a, b) { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); }
  function dayLabel(ts) {
    const now = Date.now();
    if (sameDay(ts, now)) return t('today');
    if (sameDay(ts, now - 86400e3)) return t('yesterday');
    const d = new Date(ts);
    return d.getFullYear() === new Date().getFullYear() ? dateFmt.format(d) : d.toLocaleDateString();
  }
  function fmtMuteUntil(ts) { if (ts === -1) return '∞'; return sameDay(ts, Date.now()) ? fmtTime(ts) : dateFmt.format(new Date(ts)) + ' ' + fmtTime(ts); }

  /* ---------------- URLs ---------------- */
  function safeUrl(raw) {
    try { const u = new URL(String(raw)); if (u.protocol === 'http:' || u.protocol === 'https:') return u.href; } catch (e) { /* ignore */ }
    return null;
  }
  const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
  function trimUrl(m) {
    let url = m;
    let trailing = '';
    while (/[.,;:!?'"”’)\]}>]$/.test(url)) {
      const ch = url[url.length - 1];
      if (ch === ')' && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) break;
      trailing = ch + trailing; url = url.slice(0, -1);
    }
    return { url, trailing };
  }

  /* ---------------- rich text → DOM ---------------- */
  // opts: { names: [member names for @mention matching], me: my name, onMentionClick }
  function renderRich(text, opts = {}) {
    const frag = document.createDocumentFragment();
    const parts = String(text || '').split('```');
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        let code = part.replace(/^[a-z0-9_-]*\n/i, '').replace(/\n$/, '');
        frag.appendChild(h('pre', { class: 'o-code' }, h('code', null, code)));
      } else renderInline(part, frag, opts, 0);
    });
    return frag;
  }
  function mentionRegex(opts) {
    const names = (opts.names || []).filter(Boolean).sort((a, b) => b.length - a.length).map(escapeRegExp);
    const alt = names.length ? `(?:${names.join('|')}|everyone|all|here)` : `(?:everyone|all|here|[\\p{L}\\p{N}_]{1,24})`;
    return new RegExp(`(?<![\\p{L}\\p{N}])@${alt}(?![\\p{L}\\p{N}])`, 'iu');
  }
  function renderInline(text, out, opts, depth) {
    if (!text) return;
    if (depth > 4) { out.appendChild(document.createTextNode(text)); return; }
    const mention = opts._mre || (opts._mre = mentionRegex(opts));
    const patterns = [
      { re: /`([^`\n]+)`/, make: (m) => h('code', { class: 'o-inline-code' }, m[1]) },
      { re: /\*\*(?=\S)([\s\S]+?\S)\*\*/, make: (m) => wrap('strong', m[1]) },
      { re: /~~(?=\S)([\s\S]+?\S)~~/, make: (m) => wrap('s', m[1]) },
      { re: /(?<![\p{L}\p{N}*])\*(?=\S)([^*\n]+?\S)\*(?![\p{L}\p{N}*])/u, make: (m) => wrap('em', m[1]) },
      { re: /(?<![\p{L}\p{N}_])_(?=\S)([^_\n]+?\S)_(?![\p{L}\p{N}_])/u, make: (m) => wrap('em', m[1]) },
      { re: /https?:\/\/[^\s<>"'`]+/i, make: (m) => {
        const { url, trailing } = trimUrl(m[0]);
        const safe = safeUrl(url);
        const f = document.createDocumentFragment();
        if (safe) f.appendChild(h('a', { class: 'o-link', href: safe, target: '_blank', rel: 'noopener noreferrer', title: safe }, url.length > 64 ? url.slice(0, 61) + '…' : url));
        else f.appendChild(document.createTextNode(url));
        if (trailing) f.appendChild(document.createTextNode(trailing));
        return f;
      } },
      { re: mention, make: (m) => {
        const name = m[0].slice(1);
        const isMe = opts.me && (name.toLowerCase() === String(opts.me).toLowerCase() || /^(everyone|all|here)$/i.test(name));
        return h('span', { class: 'o-mention' + (isMe ? ' me' : ''), data: { name } }, m[0]);
      } }
    ];
    const wrap = (tag, inner) => { const el = document.createElement(tag); renderInline(inner, el, opts, depth + 1); return el; };
    let rest = text;
    while (rest.length) {
      let best = null;
      for (const p of patterns) {
        const m = p.re.exec(rest);
        if (m && (!best || m.index < best.m.index)) best = { m, p };
      }
      if (!best) { out.appendChild(document.createTextNode(rest)); break; }
      if (best.m.index > 0) out.appendChild(document.createTextNode(rest.slice(0, best.m.index)));
      out.appendChild(best.p.make(best.m));
      rest = rest.slice(best.m.index + best.m[0].length);
    }
  }
  /** Plain-text preview (strip markdown markers). */
  function plain(text) { return String(text || '').replace(/```[\s\S]*?```/g, '[code]').replace(/[*_~`]/g, ''); }

  /* ---------------- avatars ---------------- */
  const AVATAR_VARIANTS = 12;
  function palette(seed) {
    const hsh = hashStr(seed);
    const h1 = hsh % 360, h2 = (h1 + 40 + (hsh >> 8) % 80) % 360;
    return { a: `hsl(${h1} 78% 58%)`, b: `hsl(${h2} 82% 46%)`, c: `hsl(${(h1 + 180) % 360} 70% 88%)`, d: `hsl(${(h2 + 200) % 360} 60% 22%)` };
  }
  function generatedAvatar(seed, variant, size) {
    const v = ((variant | 0) % AVATAR_VARIANTS + AVATAR_VARIANTS) % AVATAR_VARIANTS;
    const p = palette(seed + ':' + v);
    const id = 'g' + hashStr(seed + v).toString(36);
    const s = svgEl('svg', { viewBox: '0 0 64 64', width: size, height: size, preserveAspectRatio: 'xMidYMid meet', class: 'o-gen-avatar', 'aria-hidden': 'true' });
    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' });
    grad.appendChild(svgEl('stop', { offset: '0', 'stop-color': p.a })); grad.appendChild(svgEl('stop', { offset: '1', 'stop-color': p.b }));
    defs.appendChild(grad); s.appendChild(defs);
    s.appendChild(svgEl('circle', { cx: 32, cy: 32, r: 32, fill: `url(#${id})` }));
    const r = (n) => ((hashStr(seed + v + n) % 1000) / 1000);
    switch (v) {
      case 0: { const g = svgEl('g', { transform: 'rotate(-30 32 32)' }); g.appendChild(svgEl('ellipse', { cx: 32, cy: 32, rx: 24, ry: 9, fill: 'none', stroke: p.c, 'stroke-width': 3 })); g.appendChild(svgEl('circle', { cx: 14, cy: 38, r: 4.5, fill: p.c })); s.appendChild(svgEl('circle', { cx: 32, cy: 32, r: 10, fill: p.c })); s.appendChild(g); break; }
      case 1: for (let i = 0; i < 5; i++) s.appendChild(svgEl('rect', { x: 0, y: 6 + i * 12, width: 64, height: 5, fill: p.c, opacity: 0.5 + 0.1 * i, transform: `rotate(${-20 + 8 * r(i) * 5} 32 32)` })); break;
      case 2: s.appendChild(svgEl('path', { d: `M32 ${10 + r(1) * 6} C ${48 + r(2) * 8} 12, 58 ${28 + r(3) * 8}, 46 46 S 18 58, 14 40 S 18 14, 32 ${10 + r(1) * 6} Z`, fill: p.c, opacity: 0.9 })); break;
      case 3: [24, 16, 8].forEach((rr, i) => s.appendChild(svgEl('circle', { cx: 32, cy: 32, r: rr, fill: 'none', stroke: i % 2 ? p.d : p.c, 'stroke-width': 4 }))); break;
      case 4: s.appendChild(svgEl('polygon', { points: '32,12 52,48 12,48', fill: p.c })); s.appendChild(svgEl('polygon', { points: '32,26 42,44 22,44', fill: p.b })); break;
      case 5: for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) s.appendChild(svgEl('circle', { cx: 16 + x * 16, cy: 16 + y * 16, r: 3 + r(x * 3 + y) * 3.5, fill: (x + y) % 2 ? p.c : p.d })); break;
      case 6: for (let i = 0; i < 3; i++) s.appendChild(svgEl('path', { d: `M0 ${22 + i * 10} Q 16 ${12 + i * 10}, 32 ${22 + i * 10} T 64 ${22 + i * 10}`, fill: 'none', stroke: i === 1 ? p.d : p.c, 'stroke-width': 4 })); break;
      case 7: s.appendChild(svgEl('rect', { x: 18, y: 18, width: 28, height: 28, fill: p.c, transform: 'rotate(45 32 32)' })); s.appendChild(svgEl('rect', { x: 26, y: 26, width: 12, height: 12, fill: p.d, transform: 'rotate(45 32 32)' })); break;
      case 8: s.appendChild(svgEl('circle', { cx: 30, cy: 32, r: 18, fill: p.c })); s.appendChild(svgEl('circle', { cx: 38, cy: 28, r: 15, fill: `url(#${id})` })); s.appendChild(svgEl('circle', { cx: 14, cy: 16, r: 2, fill: p.c })); s.appendChild(svgEl('circle', { cx: 52, cy: 50, r: 1.5, fill: p.c })); break;
      case 9: for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if ((x + y) % 2) s.appendChild(svgEl('rect', { x: x * 16, y: y * 16, width: 16, height: 16, fill: p.c, opacity: 0.85 })); break;
      case 10: for (let i = 0; i < 12; i++) s.appendChild(svgEl('rect', { x: 30.5, y: 4, width: 3, height: 12, rx: 1.5, fill: p.c, transform: `rotate(${i * 30} 32 32)` })); s.appendChild(svgEl('circle', { cx: 32, cy: 32, r: 11, fill: p.d })); break;
      default: s.appendChild(svgEl('rect', { x: 27, y: 10, width: 10, height: 44, rx: 3, fill: p.c })); s.appendChild(svgEl('rect', { x: 10, y: 27, width: 44, height: 10, rx: 3, fill: p.c })); s.appendChild(svgEl('circle', { cx: 32, cy: 32, r: 6, fill: p.d })); break;
    }
    return s;
  }
  /** Build an avatar element for {avatar:{type,variant,emoji,dataUrl}, name} */
  function avatarNode(who, size, extraClass) {
    const a = (who && who.avatar) || {};
    const seed = (who && (who.name || who.userId)) || 'orbit';
    const box = h('span', { class: 'o-avatar' + (extraClass ? ' ' + extraClass : ''), style: { width: size + 'px', height: size + 'px' } });
    if (a.type === 'image' && a.dataUrl && /^data:image\/(png|jpeg|webp|gif);base64,/.test(a.dataUrl)) {
      box.appendChild(safeImg(a.dataUrl, { alt: '', width: size, height: size, draggable: false }));
    } else if (a.type === 'emoji' && a.emoji) {
      const p = palette(seed + ':e');
      box.style.background = `linear-gradient(135deg, ${p.a}, ${p.b})`;
      box.appendChild(h('span', { class: 'o-avatar-emoji', style: { fontSize: Math.round(size * 0.55) + 'px' } }, a.emoji));
    } else {
      box.appendChild(generatedAvatar(seed, a.variant | 0, size));
    }
    return box;
  }
  function bannerStyle(banner) {
    if (hexValid(banner)) return banner;
    return O.BANNERS[banner] || O.BANNERS.sunset;
  }

  /* ---------------- images ---------------- */
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  function fileToDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(file); }); }
  function blobToDataUrl(b) { return fileToDataUrl(b); }
  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(','); const mime = (dataUrl.slice(0, comma).match(/^data:([^;,]+)/) || [, 'application/octet-stream'])[1];
    const bin = atob(dataUrl.slice(comma + 1)); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  async function sniffType(file) {
    const buf = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const b = buf;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return null;
  }
  /** Decode a File/Blob to something drawable, honouring EXIF orientation. */
  async function decodeImage(blob) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { /* fall through */ }
    try { return await createImageBitmap(blob); } catch (e) { /* fall through */ }
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob); const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); }; img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode failed')); }; img.src = url;
    });
  }
  function canvasToBlob(canvas, type, quality) { return new Promise((res) => canvas.toBlob(res, type, quality)); }
  /**
   * Prepare an image for sending: type allowlist, GIF passthrough with size cap, otherwise
   * downscale to maxEdge and re-encode as WebP (fallback JPEG) — re-encoding drops every byte
   * of metadata (EXIF/GPS/XMP). Returns {dataUrl, w, h, mime, size, animated, name}.
   */
  async function prepareImageFile(file, limits) {
    const L = { maxEdge: O.LIMITS.MAX_IMAGE_EDGE, quality: O.LIMITS.IMAGE_QUALITY, maxGifBytes: O.LIMITS.MAX_GIF_BYTES, maxBytes: 6 * 1048576, ...(limits || {}) };
    const type = (await sniffType(file)) || (IMAGE_TYPES.includes(file.type) ? file.type : null);
    if (!type || !IMAGE_TYPES.includes(type)) throw Object.assign(new Error('unsupported'), { code: 'unsupported_image' });
    if (type === 'image/gif') {
      if (file.size > Math.min(L.maxGifBytes, L.maxBytes)) throw Object.assign(new Error('gif too big'), { code: 'gif_too_big' });
      const bmp = await decodeImage(file);
      const w = bmp.width || bmp.naturalWidth, hh = bmp.height || bmp.naturalHeight; if (bmp.close) bmp.close();
      return { dataUrl: await fileToDataUrl(file), w, h: hh, mime: type, size: file.size, animated: true, name: file.name || 'image.gif' };
    }
    const bmp = await decodeImage(file);
    const sw = bmp.width || bmp.naturalWidth, sh = bmp.height || bmp.naturalHeight;
    const scale = Math.min(1, L.maxEdge / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), hh = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = hh;
    const g = canvas.getContext('2d'); g.drawImage(bmp, 0, 0, w, hh); if (bmp.close) bmp.close();
    let blob = await canvasToBlob(canvas, 'image/webp', L.quality);
    if (!blob || blob.type !== 'image/webp') blob = await canvasToBlob(canvas, 'image/jpeg', L.quality);
    if (blob.size > L.maxBytes) throw Object.assign(new Error('too big'), { code: 'image_too_big' });
    return { dataUrl: await blobToDataUrl(blob), w, h: hh, mime: blob.type, size: blob.size, animated: false, name: (file.name || 'image').replace(/\.[a-z0-9]+$/i, '') + (blob.type === 'image/webp' ? '.webp' : '.jpg') };
  }
  /** Crop/zoom/reposition to a 128x128 avatar, compressed under maxBytes. */
  async function cropAvatar(source, view, outSize, maxBytes) {
    const canvas = document.createElement('canvas'); canvas.width = outSize; canvas.height = outSize;
    const g = canvas.getContext('2d');
    g.fillStyle = '#1c1611'; g.fillRect(0, 0, outSize, outSize);
    // view: {scale (px per source px in preview), ox, oy (offset in preview px), previewSize}
    const k = outSize / view.previewSize;
    g.drawImage(source, view.ox * k, view.oy * k, source.width * view.scale * k, source.height * view.scale * k);
    let q = 0.86, blob;
    for (let i = 0; i < 8; i++) {
      blob = await canvasToBlob(canvas, 'image/webp', q);
      if (!blob) blob = await canvasToBlob(canvas, 'image/jpeg', q);
      if (blob.size <= maxBytes) break;
      q -= 0.1;
    }
    return blobToDataUrl(blob);
  }
  async function shrinkForSticker(file, maxEdge, maxBytes) {
    const type = (await sniffType(file));
    if (!type || !IMAGE_TYPES.includes(type)) throw Object.assign(new Error('unsupported'), { code: 'unsupported_image' });
    if (type === 'image/gif' && file.size <= maxBytes) return { dataUrl: await fileToDataUrl(file), mime: type };
    const bmp = await decodeImage(file);
    const sw = bmp.width || bmp.naturalWidth, sh = bmp.height || bmp.naturalHeight;
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(sw * scale)); canvas.height = Math.max(1, Math.round(sh * scale));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height); if (bmp.close) bmp.close();
    let q = 0.85, blob;
    for (let i = 0; i < 6; i++) { blob = await canvasToBlob(canvas, 'image/webp', q); if (blob && blob.size <= maxBytes) break; q -= 0.12; }
    return { dataUrl: await blobToDataUrl(blob), mime: blob.type };
  }
  async function copyImageToClipboard(dataUrl) {
    const blob = dataUrlToBlob(dataUrl);
    let png = blob;
    if (blob.type !== 'image/png') {
      const bmp = await decodeImage(blob);
      const canvas = document.createElement('canvas'); canvas.width = bmp.width || bmp.naturalWidth; canvas.height = bmp.height || bmp.naturalHeight;
      canvas.getContext('2d').drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
      png = await canvasToBlob(canvas, 'image/png');
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  }
  /** <img> for a data: URL that survives strict page CSPs. Some sites ship `img-src 'self'`, which also
   *  blocks data: images inserted by content scripts. On error we decode the bytes ourselves
   *  (createImageBitmap is not a document fetch, so CSP does not apply) and swap in a <canvas>. */
  function safeImg(src, props) {
    const img = h('img', { ...(props || {}), src });
    img.addEventListener('error', () => cspFallback(img));
    return img;
  }
  async function cspFallback(img) {
    try {
      const src = img.getAttribute('src');
      if (!src || !/^data:image\//.test(src) || !img.parentNode) return;
      const bmp = await createImageBitmap(dataUrlToBlob(src));
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      c.className = img.className; c.style.cssText = img.style.cssText;
      c.setAttribute('role', 'img'); c.setAttribute('aria-label', img.getAttribute('alt') || '');
      c.dataset.cspFallback = '1';
      if (img.parentNode) img.replaceWith(c);
    } catch (e) { /* leave the broken image alone */ }
  }
  function downloadDataUrl(dataUrl, filename) {
    const a = document.createElement('a'); a.href = dataUrl; a.download = filename || 'image'; a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a); a.click(); setTimeout(() => a.remove(), 0);
  }

  /* ---------------- fuzzy search ---------------- */
  function fuzzyScore(query, text) {
    query = String(query || '').toLowerCase(); text = String(text || '').toLowerCase();
    if (!query) return 1;
    if (text.includes(query)) return 100 - text.indexOf(query);
    let qi = 0, score = 0, streak = 0;
    for (let i = 0; i < text.length && qi < query.length; i++) {
      if (text[i] === query[qi]) { qi++; streak++; score += 2 + streak; } else streak = 0;
    }
    return qi === query.length ? score : 0;
  }

  /* ---------------- focus trap ---------------- */
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function trapTab(container, e) {
    if (e.key !== 'Tab') return;
    const nodes = Array.from(container.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === container.getRootNode().activeElement);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    const active = container.getRootNode().activeElement;
    if (e.shiftKey && (active === first || !container.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  root.OrbitKit = {
    safeImg,
    h, clear, svgEl, icon, orbitMark, ICONS, clamp, debounce, throttle, uid, hashStr, escapeRegExp, normalizeRoomName, hexValid, inkFor, accentOf, accentInkOf, hexToRgb, fmtBytes,
    fmtTime, fmtFull, sameDay, dayLabel, fmtMuteUntil, safeUrl, renderRich, plain, AVATAR_VARIANTS, generatedAvatar, avatarNode, palette, bannerStyle,
    IMAGE_TYPES, fileToDataUrl, blobToDataUrl, dataUrlToBlob, prepareImageFile, cropAvatar, shrinkForSticker, decodeImage, copyImageToClipboard, downloadDataUrl, fuzzyScore, trapTab, FOCUSABLE
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
