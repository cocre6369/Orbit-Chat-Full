/* Orbit — shared constants. Loaded (as a classic script) by every context:
 * content script, service worker (importScripts), offscreen document, side panel.
 *
 * To rename the extension: change BRAND_NAME below and "name"/"short_name" in manifest.json.
 */
(function (root) {
  'use strict';
  const BRAND_NAME = 'Orbit';

  const ACCENTS = {
    tangerine: { color: '#FF6A1F', ink: '#1C1611' },
    lime:      { color: '#9EE83A', ink: '#141A0B' },
    cyan:      { color: '#2BD4F2', ink: '#0B1A1E' },
    magenta:   { color: '#FF4D9D', ink: '#1E0B14' },
    butter:    { color: '#FFD23F', ink: '#1E1808' },
    violet:    { color: '#A78BFA', ink: '#160F26' }
  };

  // STUN only. PeerJS discontinued its free public TURN relays, so no keyless TURN exists any more.
  // If two peers can't connect (symmetric NAT / strict firewall), add your own TURN server under
  // Settings -> Advanced -> STUN / TURN servers (e.g. a free Metered Open Relay or Cloudflare TURN account).
  const DEFAULT_ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Metered Open Relay's documented shared-secret TURN endpoint (TURN REST auth: Orbit derives short-lived
    // credentials from the published secret). Shared and best-effort; for reliable relaying add your own TURN.
    { urls: ['turn:staticauth.openrelay.metered.ca:80', 'turn:staticauth.openrelay.metered.ca:443', 'turns:staticauth.openrelay.metered.ca:443?transport=tcp'], restSecret: 'openrelayprojectsecret' }
  ];

  const DEFAULT_SETTINGS = {
    schemaVersion: 1,
    theme: 'auto',              // 'light' | 'dark' | 'auto'
    accent: 'tangerine',        // key of ACCENTS or 'custom'
    accentCustom: '#FF6A1F',
    fontSize: 14,               // px, 12..18
    compact: false,
    bubbleStyle: 'bubble',      // 'bubble' | 'flat'
    side: 'right',              // 'left' | 'right'
    dotSize: 16,                // px, 12..24
    dotIdleOpacity: 0.55,       // 0.2..1
    dotY: 0.5,                  // fraction of viewport height
    panelWidth: 380,            // 320..560
    panelOpacity: 1,            // 0.5..1 (background alpha)
    pinned: false,
    reduceMotion: false,
    peek: true,
    notifications: true,
    sound: true,
    soundName: 'blip',          // 'blip' | 'pop' | 'chime'
    notifyOnMention: true,
    dndSchedule: { enabled: false, start: '22:00', end: '07:00' },
    hiddenSites: [],
    hideUntil: 0,
    autoHideFullscreen: true,
    linkPreviews: false,        // OFF by default: previews fetch third-party URLs (IP leak)
    signaling: 'peerjs',         // PeerJS room-ID signaling (five-letter room codes)
    iceServers: DEFAULT_ICE_SERVERS,
    shareHistoryDefault: true,
    maxImageMB: 6,
    imageCacheMB: 200,
    background: { type: 'none', pattern: 'dots', dataUrl: '', blur: 0, dim: 0.35 },
    toolbarIcon: 'color',       // 'color' | 'mono'
    mutedUsers: [],
    onboarded: false
  };

  const DEFAULT_PROFILE = {
    name: '',
    avatar: { type: 'generated', variant: 0, emoji: '🪐', dataUrl: '' },
    banner: 'sunset',           // key of BANNERS or '#hex'
    status: '',
    presence: 'online',         // 'online' | 'away' | 'dnd' | 'invisible'
    nameColor: ''
  };

  const BANNERS = {
    sunset:  'linear-gradient(120deg,#ff6a1f,#ff4d9d)',
    meadow:  'linear-gradient(120deg,#9ee83a,#2bd4f2)',
    dusk:    'linear-gradient(120deg,#a78bfa,#2bd4f2)',
    ember:   'linear-gradient(120deg,#ffd23f,#ff6a1f)',
    ink:     'linear-gradient(120deg,#3b3a42,#17140f)',
    paper:   'linear-gradient(120deg,#f6f1e8,#e2d7c3)'
  };

  const LIMITS = {
    MAX_ROOM_MEMBERS: 12,
    MAX_TEXT_CHARS: 4000,
    MAX_IMAGES_PER_MESSAGE: 4,
    MAX_IMAGE_EDGE: 1600,
    IMAGE_QUALITY: 0.8,
    MAX_GIF_BYTES: 6 * 1024 * 1024,
    MAX_AVATAR_BYTES: 20 * 1024,
    MAX_THUMB_BYTES: 12 * 1024,
    MAX_STICKER_BYTES: 100 * 1024,
    HISTORY_SHARE_COUNT: 200,
    HISTORY_KEEP_PER_ROOM: 5000,
    MAX_NAME_CHARS: 24,
    MAX_STATUS_CHARS: 60,
    CHUNK_BYTES: 64 * 1024,
    CHUNK_WINDOW: 8
  };

  // Storage keys (chrome.storage.local)
  const KEYS = {
    SETTINGS: 'settings',
    PROFILE: 'profile',
    ROOMS: 'rooms',
    USER_ID: 'userId',
    STICKERS: 'stickers',
    RECENT_EMOJI: 'recentEmoji',
    SCHEMA: 'schemaVersion'
  };

  // Subset of settings mirrored to chrome.storage.sync (small, non-sensitive)
  const SYNC_KEYS = ['theme', 'accent', 'accentCustom', 'fontSize', 'compact', 'bubbleStyle',
    'side', 'dotSize', 'dotIdleOpacity', 'reduceMotion', 'peek', 'soundName'];

  const PROTOCOL_VERSION = 1;
  const APP_ID = 'orbit-p2p-chat-v1'; // Legacy Trystero namespace; PeerJS room IDs are public PeerServer IDs
  const APP_VERSION = '3.1.0';

  // Public source of truth: the unpacked source lives at the root of this repository.
  // "Download ZIP" of the default branch is directly loadable as an unpacked extension.
  const REPO_URL = 'https://github.com/cocre6369/Orbit-Chat-Full';
  const REPO = {
    url: REPO_URL,
    zipUrl: REPO_URL + '/archive/refs/heads/main.zip',
    releasesUrl: REPO_URL + '/releases',
    issuesUrl: REPO_URL + '/issues',
    readmeUrl: REPO_URL + '#readme'
  };

  root.ORBIT = Object.freeze({
    BRAND_NAME, ACCENTS, BANNERS, DEFAULT_SETTINGS, DEFAULT_PROFILE, DEFAULT_ICE_SERVERS,
    LIMITS, KEYS, SYNC_KEYS, PROTOCOL_VERSION, APP_ID, APP_VERSION, REPO, REPO_URL,
    PORT_NAME: 'orbit-ui',
    RESTRICTED_URL_RE: /^(chrome|chrome-extension|chrome-untrusted|edge|brave|about|devtools|view-source|file):\/\/|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
