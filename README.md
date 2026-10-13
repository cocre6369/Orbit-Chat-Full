# Orbit — serverless peer‑to‑peer chat rooms, on every website

**Version 3.1.0** · MIT (own code) · **[⬇ Download the extension](https://github.com/cocre6369/Orbit-Chat-Full/archive/refs/heads/main.zip)**
· [Repository](https://github.com/cocre6369/Orbit-Chat-Full) · [Releases](https://github.com/cocre6369/Orbit-Chat-Full/releases) · [Report a bug](https://github.com/cocre6369/Orbit-Chat-Full/issues)

Orbit is a Chrome / Edge / Brave (Manifest V3) extension that puts a tiny floating dot on every page.
Click it and a panel slides out where you create rooms with a display name and join them using a
random room code. The name is for people; the code is the actual room address.

## Download & install (anyone can)

1. **[Download the ZIP](https://github.com/cocre6369/Orbit-Chat-Full/archive/refs/heads/main.zip)** — it unpacks to a
   folder that already contains `manifest.json`, so it is directly loadable. (You can also
   `git clone https://github.com/cocre6369/Orbit-Chat-Full.git`, or browse
   [Releases](https://github.com/cocre6369/Orbit-Chat-Full/releases) for tagged builds.)
2. Unzip it somewhere permanent (the browser reads the folder on every start).
3. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`) → turn on
   **Developer mode** → **Load unpacked** → pick the unzipped folder.
4. Open any http(s) page: a small dot appears docked to the right edge. Click it and chat.

Nothing needs building: `lib/` already contains the vendored PeerJS/Trystero bundles and `icons/` the
generated icons. See [Scripts](#scripts) to regenerate them.

> The same links are in the extension itself: **Settings → About → Source code on GitHub / Download ZIP**
> (they open in a new tab and need no GitHub account).

Orbit uses [PeerJS](https://peerjs.com/) with its public PeerServer to broker WebRTC connections.
Creating a room reserves a namespaced PeerJS host ID derived from a five-letter code; members connect to the creator, who stays online
and forwards room traffic between them. PeerJS is bundled locally; its signaling service is
remote. Optional room passwords add end‑to‑end encryption.

**Connection strategy (same as the Neon Nights party game):** a direct WebRTC link is tried first (12 s). If it
cannot form — strict NAT, blocked WebRTC, PeerJS unreachable — the member automatically switches to a **relay**:
the same room frames travel through a public MQTT broker over WebSocket‑TLS (`broker.emqx.io`, `broker.hivemq.com`,
`test.mosquitto.org`, tried in that order). The creator always listens on the relay too, serves direct and relay
members at the same time, and relay members quietly retry a direct link and switch to it when it works
(see [Relay fallback](#relay-fallback)).

> **Renaming:** the product name lives in exactly one constant, `BRAND_NAME` in `shared/brand.js`
> (plus the human‑readable `name`/`short_name` in `manifest.json`).

---

## Contents

1. [Architecture](#architecture)
2. [Download & install (anyone can)](#download--install-anyone-can)
3. [Load it (unpacked)](#load-it-unpacked)
4. [Rejoining after everyone leaves, or after a browser restart](#rejoining-after-everyone-leaves-or-after-a-browser-restart)
5. [Test with two profiles](#test-with-two-profiles)
6. [Everyday use](#everyday-use)
7. [Configuring STUN/TURN and signaling](#configuring-stunturn-and-signaling)
8. [Relay fallback](#relay-fallback)
9. [Screen sharing](#screen-sharing)
10. [Peer protocol](#peer-protocol)
11. [Security & privacy — what leaves your browser](#security--privacy--what-leaves-your-browser)
12. [Storage layout](#storage-layout)
13. [Scripts](#scripts)
14. [Limitations](#limitations)
15. [Troubleshooting](#troubleshooting)
16. [File map](#file-map)

---

## Architecture

```
┌──────────────────────────── every tab ─────────────────────────────┐
│ content/content.js  (tiny: dot + closed Shadow DOM host)            │
│   └─ lazily loads ui/*.js via chrome.scripting when the dot opens   │
│        ui/panel.js + ui/panel-settings.js + ui/ui-kit.js (the UI)   │
└───────────────▲──────── chrome.runtime port (shared/bridge.js) ─────┘
                │
┌───────────────▼──────────── service worker ────────────────────────┐
│ background/service-worker.js: port hub, badge, notifications,      │
│ commands, side-panel fallback, keep-alive alarm, offscreen owner    │
└───────────────▲──────── chrome.runtime.sendMessage ────────────────┘
                │
┌───────────────▼──────────── offscreen document (WEB_RTC) ──────────┐
│ offscreen/offscreen.js: ALL networking & room state                 │
│   PeerJS (lib/) → creator-hosted WebRTC data channels               │
│   crypto.js (room ids, AES‑GCM), db.js (IndexedDB history/images), │
│   protocol.js (validation, rate limits), images.js, sounds.js       │
└─────────────────────────────────────────────────────────────────────┘
```

* **Content script** — creates `<orbit-host>` with a *closed* shadow root (z‑index 2147483647,
  `all: initial`), draws the dot, handles drag/snap/peek/context menu, and re‑attaches itself if the
  page removes it (MutationObserver + SPA guard). It opens a `runtime.Port` (`shared/bridge.js`) and
  asks the service worker to inject the heavy UI files only when the panel is first opened.
* **Service worker** — owns the offscreen document (creates it on demand, recreates it if Chrome
  kills it, keep‑alive alarm + heartbeat), routes port messages, maintains the toolbar badge and
  desktop notifications, handles keyboard commands and falls back to the side panel on restricted
  pages (`chrome://`, the Web Store, PDF viewer).
* **Offscreen document** — the only place with network access. It hosts PeerJS/WebRTC connections,
  uses a namespaced PeerJS ID derived from the creator's five-letter code, relays messages through that creator,
  runs room state machines (presence, typing, seen markers, acknowledgements, history sync, chunked
  images with backpressure), persists history in IndexedDB and plays synthesized notification sounds.
* **Screen sharing** — the panel document captures (`getDisplayMedia`) and encodes (MediaRecorder); the
  offscreen document only routes the encoded segments to peers and hands incoming ones back for playback
  (MediaSource). See [Screen sharing](#screen-sharing).
* **Side panel** — the same UI mounted in `ui/sidepanel.html`, used on pages where content scripts
  cannot run.

## Load it (unpacked)

1. `git clone` / unzip this folder. Nothing needs building — `lib/` already contains the vendored
   PeerJS and legacy Trystero bundles and `icons/` the generated icons. (To regenerate: see [Scripts](#scripts).)
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** → **Load unpacked** → select the folder containing `manifest.json`.
4. Open any http(s) page. A small dot appears docked to the right edge; click it.
5. Optional: pin the toolbar icon. Clicking it toggles the panel; on restricted pages it opens the
   side panel instead. Shortcuts: **Alt+Shift+C** toggle, **Alt+Shift+H** boss key
   (change them at `chrome://extensions/shortcuts`).

## Rejoining after everyone leaves, or after a browser restart

Rooms are hosted by the member who created them, so the way back into a room matters as much as the
way in. Orbit 3.1.0 fixed a family of bugs that used to leave a whole group stranded (everyone sees
“Connecting…”, nobody hosts, the room never comes back):

* **The creator reclaims their code instead of joining as a guest.** Every way back into a saved room
  (clicking the card, the *Rejoin* button, the context menu, the Ctrl+K switcher) now carries the
  saved role. If the entry says you created the room, Orbit asks the matchmaker for the host id again —
  joining as a guest could never work, because a vacant code has no host to answer.
* **A refused claim is retried, never punished.** After a crash or a hard shutdown, the PeerJS
  matchmaker may still hold your id for a while. Orbit now keeps asking (a few seconds apart, for up to
  six minutes) while showing *“Reclaiming this room…”* — it does not give up, and it does **not** demote
  the room to a guest room, which is what used to make the room permanently unhostable.
* **Demotion only happens for a reason.** The saved entry switches to `host: false` only after a
  *verified* hello from the member who really holds the code. A timeout or a refusal no longer rewrites
  who you are, and a room you are already hosting re-asserts `host: true` on every reconnect (which
  repairs profiles that were demoted by the old bug).
* **Guests heal themselves.** If a guest's transport gives up (host not on the matchmaker *and* every
  relay broker refused), it retries with backoff instead of sitting on a dead connection until you
  leave and rejoin by hand.
* **Unacked messages survive a restart.** Text you sent while nobody was around is put back in the
  delivery outbox on load and handed to the next member who greets you, instead of staying on
  “sending” forever.

Transport, topology, codes and encryption are unchanged — these are all state-machine fixes, not a new
way to connect.

## Test with two profiles

Orbit identifies you per browser profile, so the easiest local test is two profiles (or Chrome + Edge):

1. Create a second Chrome profile (avatar menu → *Add*), load the unpacked extension there too.
2. In one profile, click the dot, enter a display name and press **Create room**. The room screen
   shows a generated code; copy it. In the other profile, paste that code under **Join room** and
   press Join. The code—not the display name—is used for peer discovery.
3. Within a few seconds the status line reads *Connected · 1 person*, the presence ring on the dot
   turns green, and the avatar of the other member pops into the members sidebar.
4. Send text, paste a screenshot (Ctrl+V into the composer), drag a GIF onto the panel, react, reply,
   edit, `/roll 2d6`, and close/re‑open tabs — messages keep flowing because networking lives in the
   offscreen document, not in the tab.
5. Add a password in one profile only: the code/password pair resolves to a different room. Use the
   same generated code and password in both profiles to meet again.

The room creator owns the namespaced PeerJS ID associated with the five-letter code and acts as the forwarding hub, so they must stay
online for others to communicate. **Create room** reserves a new random code; **Join room** connects
to that PeerJS host. Share the code (and, if set, the password) out of band. Both machines need the
extension and outbound access to PeerJS Cloud. Most home/mobile networks connect directly via STUN;
corporate/school networks may need TURN.

## Everyday use

* **Dot** — drag it vertically; it snaps back to the edge and remembers its spot. Right‑click for
  *Hide on this site / Hide everywhere for 1 h / Move to other side / Settings*. Hover to peek the
  latest message; unread messages pulse a badge (muted rooms stay quiet). It tucks half off‑screen
  when idle and auto‑hides during fullscreen video (configurable).
* **Panel** — drag the header to the opposite edge to move it, drag the inner edge to resize
  (320–560 px), pin it open to keep using the page underneath, adjust its opacity. `Esc` closes,
  `/` focuses the composer, `Ctrl+K` opens the fuzzy room switcher.
* **Messages** — `Enter` sends, `Shift+Enter` newline. `**bold** *italic* \`code\` \`\`\`blocks\`\`\`
  ~~strike~~`, links (http/https only), `@mentions` with autocomplete, reply/edit/delete/reactions,
  typing indicator, seen markers, date separators, search, jump‑to-latest, shared message pins, automatic host handoff, up to 4 inline images per message
  (drag‑drop or paste), in‑panel lightbox with zoom/pan/download/copy, emoji picker for reactions,
  custom sticker tray, voice notes, configurable polls, and file attachments (any type up to 50 MB; confirmation above 25 MB). Pictures chosen with the paperclip or dropped in are sent as inline images and display automatically; images too big for the inline pipeline and all videos are sent as attachments that preview automatically in the chat (inline image / video player, auto-fetched when visible up to 15 MB for images and 25 MB for videos; larger ones show a *Show preview* button) with a download button alongside.
* **Screen sharing** — the monitor button next to the paperclip shares a tab, a window or the whole
  screen with the room (video only). One sharer at a time; everyone sees a live card above the
  messages with a LIVE pill, viewer count, *Refresh video*, *Hide* and *Fullscreen*, and the room
  keeper can stop a share. The sharer picks a quality preset (Low/Medium/High) and can stop from the
  card or Chrome's own “Stop sharing” bar. See [Screen sharing](#screen-sharing) for the details
  and the honest limits.
* **Slash commands** — `/me`, `/shrug`, `/clear`, `/nick Name`, `/roll 2d6`, `/flip`, `/mute Name`,
  `/leave`, `/help`.
* **Rooms** — pinned & recent lists with unread + online counts, multiple rooms at once, per‑room
  mute (1 h / 8 h / until tomorrow / forever), per‑room nickname, per‑room chat background,
  "Share history with newcomers" toggle (default on), clear local history, Copy invite.
* **Room keeper** — the member who has been present the longest. The keeper can give the room a
  cosmetic title and soft‑mute a member for everyone. This is *cooperative*: peers honour it because
  they run the same code, not because anything enforces it (see comments in `offscreen/offscreen.js`).
* **Profile** — display name (≤ 24 chars), avatar (procedural, emoji, or an uploaded picture cropped
  to a 128×128 WebP under 20 KB — EXIF is stripped by re‑encoding), banner, status line, presence
  (Online/Away/DND/Invisible), name colour, export/import as JSON.
* **Appearance** — light/dark/auto, six accent presets + custom, font size, compact mode, bubbles or
  flat, panel side, dot size/opacity, chat backgrounds (patterns or your own image with blur/dim,
  global or per room), reduce motion, colour or monochrome toolbar icon.
* **Notifications & privacy** — desktop notifications, synthesized sounds (no audio files), notify on
  @mention even when muted, DND schedule, hidden‑sites list, link previews (off by default — see
  warning in settings), max image size and image cache size, clear all local data.

## Configuring STUN/TURN and signaling

Settings → **Advanced**:

* **Peer discovery (signaling)** — PeerJS Cloud (`0.peerjs.com`, TLS/WebSocket on port 443). The
  creator's namespaced PeerJS ID is derived from the five-letter code, and the creator forwards envelopes to
  members. PeerJS is not operated by Orbit; users may self-host PeerServer instead.
* **STUN / TURN servers (JSON)** — an array of `RTCIceServer` objects. The defaults are public STUN
  servers only (PeerJS discontinued its free public TURN, so none can be bundled). If two peers cannot connect (diagnostics show `connecting` / `failed` forever) add a
  TURN server:

  ```json
  [
    { "urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    { "urls": "turn:turn.example.com:3478", "username": "user", "credential": "secret" },
    { "urls": "turns:turn.example.com:5349", "username": "user", "credential": "secret" }
  ]
  ```

  Free options: run [coturn](https://github.com/coturn/coturn) on any VPS, or use a metered TURN
  provider. Saving reconnects your rooms with the new configuration.
* **Connection diagnostics** — per room: signaling provider and per‑peer connection state/RTT. **Test connection** checks PeerJS signaling, gathers available host/STUN/TURN ICE candidate types using your ICE settings, and sends two round-trip pings to each online room member; where the browser exposes stats, it also reports the selected ICE candidate path. Keep another member online for the end-to-end check. Candidate gathering alone does not prove a path can connect.

## Relay fallback

Implemented in `offscreen/peerjs-room.js` (routing, upgrade, heartbeats) and `offscreen/relay-mqtt.js` (a ~200‑line
MQTT 3.1.1‑over‑WebSocket client — written in‑house because the extension CSP forbids CDN scripts).

* **When it kicks in:** the direct link fails or takes longer than 12 s, or PeerJS reports an error / the host isn't
  on the matchmaker. Each broker gets ≈ 11 s (instant failover if it refuses or is unreachable). A creator whose
  PeerJS connection is blocked boots a **relay‑only** room after 12 s.
* **What the broker sees:** a hashed topic (never the room code) and AES‑GCM‑sealed binary frames, plus your IP and
  timing. The key comes from the room code, mixed with the password‑derived secret when the room has a password.
  Without a password the code is the only secret and five letters can be brute‑forced offline — it keeps casual
  snoopers out, it is not strong security. **Use a room password when privacy matters.**
* **Upgrade:** a relay member retries a direct link 5 s after joining (then twice more, 30 s apart) and proves seat
  ownership with a one‑time token, so nobody can hijack someone else's relay seat. On success the broker connection
  is dropped.
* **Liveness:** the creator heartbeats relay members every 3 s; a relay member that hears nothing for 25 s treats
  the creator as gone (triggering the normal host handoff), and the creator drops relay members silent for 25 s.
* **Wire format:** direct links use PeerJS `json` serialization (binary payloads as base64) and frames above ≈ 48 kB are
  fragmented transparently (≈ 150 kB on the relay), so the 256 kB data‑channel message limit is never hit.

## Screen sharing

Implemented in `ui/panel.js` (capture + encoding + playback) and `offscreen/offscreen.js`
(`beginScreen`/`publishScreenChunk`/`onLvChunk`/`screenTick`, plus the `screen` envelope).

* **How it works.** Only a real document can call `getDisplayMedia`, so the **panel captures** the
  screen and encodes it with `MediaRecorder` (`video/webm;codecs=vp8`, one segment per 200–400 ms,
  bitrate from the quality preset). Each segment is handed to the offscreen document, which fans it out
  to room members over the existing transport — the same star forwarding that carries chat, so nothing
  about the connection changed. Viewers feed the segments into a `MediaSource` (`appendBuffer`) and see
  a live picture inside the panel.
* **Quality presets.** Low 960×540 @6 fps ≈350 kbps · Medium 1280×720 @10 fps ≈800 kbps · High
  1600×900 @15 fps ≈1.6 Mbps. The sharer can change preset at any time; it restarts the encoder under a
  new stream id so viewers get a clean header instead of a broken stream.
* **Direct link only.** A public MQTT broker cannot carry a video stream, so the transport refuses to
  relay `lvchunk` frames and a member who is on the relay is told why instead of watching a frozen
  frame. In practice: strict-NAT members use the relay for chat and cannot watch a share.
* **Flow control.** Viewers acknowledge segments; the sharer pauses its recorder when a viewer falls
  behind (dropping encoded segments would corrupt the WebM stream the viewer is playing). A viewer that
  stops acknowledging for 25 s is dropped from the window instead of stalling everyone.
* **Late joiners** are handled without anyone pressing anything: when somebody joins while a share is
  running, the sharer's encoder restarts under a fresh stream id so the new player starts from a clean
  header. A viewer whose card stays black asks for that restart automatically (a few tries), and the
  *Refresh video* button does the same on demand — useful after switching tabs.
* **The share ends with its reason.** Closing the panel or leaving the room stops the capture (the
  browser's "sharing" bar never keeps running unseen), the room keeper can stop somebody else's share,
  and any transport swap ends it cleanly so viewers see a proper goodbye instead of a frozen frame.
* **Bandwidth is per viewer.** The host forwards each segment to every member, so an 800 kbps share
  costs the host roughly 800 kbps × viewers of upstream. In a full 12-person room, prefer Low.
* **Tips that matter.** Share a **window** or the **whole screen** if the shared content has to keep
  running: Chrome does not render a *tab* while that tab is in the background, so a shared tab shows a
  still frame as soon as you switch away. Video only (no sound), one share at a time, and closing the
  panel or the tab (or Chrome's own “Stop sharing” bar) ends the share immediately.
* **Cooperative, like everything else.** The room keeper can stop somebody's share, and it is honoured
  by clients that run this code — not enforced by any server.

## Peer protocol

All peer traffic uses Orbit JSON envelopes inside PeerJS/WebRTC data connections. Every envelope:

```json
{ "v": 1, "type": "chat", "id": "uuid", "roomId": "16 hex", "senderId": "u…", "ts": 1727000000000, "payload": { } }
```

| type              | payload                                                                                   | notes |
|-------------------|-------------------------------------------------------------------------------------------|-------|
| `hello`           | `{userId, name, avatar, banner, status, presence, nameColor, joinedAt, proto}`             | sent to each new peer; maps PeerJS transport IDs to your stable per‑install `userId` |
| `presence`        | same profile fields as `hello`                                                            | profile / presence changes |
| `chat`            | `{text, kind: "chat"\|"me", replyTo?, images?: [meta], mentions?, sticker?, seq}`         | `seq` is per‑sender & monotonically increasing; receivers **ack** the envelope id |
| `ack`             | `{ids: [envelopeId, …]}`                                                                  | batched acknowledgements; unacked chat messages are re‑sent on reconnect |
| `edit`            | `{msgId, text}`                                                                           | only the original sender may edit |
| `delete`          | `{msgId}`                                                                                 | only the original sender may delete |
| `reaction`        | `{msgId, emoji, add}`                                                                     | one entry per user per emoji |
| `typing`          | `{on}`                                                                                    | throttled (≈ 1 per 2.5 s) |
| `seen`            | `{msgId, ts}`                                                                             | read pointer, shown as "Seen by …" |
| `history-offer`   | `{count, latestTs}`                                                                       | sent to newcomers when *Share history* is on |
| `history-request` | `{since, limit}`                                                                          | newcomer asks for up to ~200 messages newer than what it already has |
| `history-batch`   | `{messages: [record…] (≤ 40 per batch), more}`                                            | text + small thumbnails only, never full images |
| `image-meta`      | `{imageId, msgId, size, mime, chunks, chunkBytes}`                                        | announces a transfer (only for images referenced by a known message) |
| *(binary action)* | chunk bytes, metadata `{i: imageId, n: index}`                                            | 64 KB chunks, window of 8 in flight, sent on the separate `chunk` action |
| `image-ack`       | `{imageId, upTo, done}`                                                                   | backpressure / completion |
| `image-request`   | `{imageId}`                                                                               | ask a peer for a full‑size image (e.g. after history sync) |
| `room-title`      | `{title}`                                                                                 | keeper only (cosmetic room title) |
| `room-mute`       | `{userId, on}`                                                                            | keeper only, honoured cooperatively |

Orbit multiplexes control envelopes as `ctl` and binary image chunks as `chunk` over PeerJS data
connections. The room creator forwards these frames to room members; password-protected content has an additional AES-GCM layer.

| `screen`          | `{kind: "start"\|"stop"\|"keyframe"\|"adjust", streamId, quality?, fps?, viewers?, reason?}` | share lifecycle; only the keeper may send `stop` with `reason: "keeper"` |

The screen-share **video** does not travel as envelopes: encoded WebM segments go over a dedicated
transport action (`lvchunk`, metadata `{sid, seq}`) plus a credit action (`lvack`). The transport
refuses to relay those frames, so video is direct-link only.

Ordering is by `(ts, senderId)`; envelopes are validated for shape and size (512 KB max control
message, 4 000 chars text, ≤ 4 images/message, 6 MB per image by default) and every peer is
rate‑limited (token bucket) before any state changes. The room code is five random lowercase letters. The room id is the first 16 hex characters of
`SHA‑256("orbit:room:" + fiveLetterCode [+ ":pw:" + SHA‑256("orbit:pw:" + password)])`. With a room
password every payload and image chunk is AES‑GCM-encrypted with a key derived by PBKDF2 (210 000
iterations) from the normalized code + password. A wrong code/password simply finds no active room.

**Name normalization** (identical in `offscreen/crypto.js` and `ui/ui-kit.js`): NFKC → lowercase →
every character that is not a letter/number/mark/space/`-`/`_` becomes a space → runs of
space/`-`/`_` collapse to a single `-` → trim → max 64 chars.

## Security & privacy — what leaves your browser

* **PeerJS PeerServer** sees your IP address, namespaced room PeerJS ID, peer IDs and WebRTC
  session descriptions (sent over TLS). It brokers connections but does not carry chat payloads.
* **Peers** in a room see: your IP address (inherent to WebRTC unless you use a TURN relay), your
  profile (name, avatar, status, presence, colour), your messages/images, typing and read state.
* **STUN/TURN servers** see your IP address; TURN servers relay WebRTC traffic when direct
  connections fail. The WebRTC hop is DTLS-protected.
* **Link previews** are *off* by default. When enabled, the extension's service worker fetches the
  linked page, which reveals your IP to that site.
* No analytics, update pings, CDN scripts or external fonts. PeerJS is the explicit exception for
  signaling: the bundled client connects to `0.peerjs.com`; icons and UI code remain local.
* Your identity is a random per‑install id (`userId`) plus the display name you choose. Images are
  re‑encoded client‑side, which strips EXIF/location metadata before sending.
* Hardening: no `eval`/inline scripts (strict extension CSP), no `innerHTML` with peer content,
  links limited to `http(s)` and opened with `rel="noopener noreferrer"`, per‑peer rate limits, size
  limits on every field, image bytes sniffed for a real PNG/JPEG/WebP/GIF signature, closed Shadow DOM
  so pages cannot read the chat, and page keyboard handlers never see what you type in the panel.

## Storage layout

| where                       | what                                                                                  |
|-----------------------------|---------------------------------------------------------------------------------------|
| `chrome.storage.local`      | `settings`, `profile`, `rooms` (recent/pinned list incl. per‑room password & prefs), `userId`, `stickers`, `recentEmoji`, `schemaVersion` |
| `chrome.storage.sync`       | `settingsSync` — a small subset of appearance settings (theme, accent, font size, side…) |
| IndexedDB `orbit-db`        | `messages` (capped at 5 000 per room), `images` (blob cache, LRU‑pruned to the configured MB), `meta` |

*Clear all local data* wipes everything above and re‑seeds defaults with a fresh `userId`.

## Scripts

| script                       | purpose |
|------------------------------|---------|
| `scripts/build-vendor.sh`    | Rebuilds the local Trystero and PeerJS bundles with esbuild (see `lib/README.md`). |
| `scripts/make-icons.py`      | Regenerates `icons/` (colour + monochrome PNGs 16/32/48/128 and `orbit.svg`) with Pillow. |
| `scripts/gen-emoji.py`       | Regenerates `ui/emoji-data.js` from Python's Unicode database (no network). |

## Limitations

* **Discovery depends on public infrastructure.** If PeerJS Cloud *and* all three relay brokers are down or
  blocked, peers cannot find each other.
* **Symmetric NATs / strict firewalls** fall back to the public MQTT relay automatically (slower, and large files
  take longer). A TURN server in Advanced settings still gives the best direct path.
* **Creator must stay online.** The creator's browser owns the namespaced PeerJS ID associated with the five-letter code and forwards
  room traffic (passwords add AES-GCM content encryption). If it closes or disconnects, the room becomes unavailable until the creator
  reconnects. There is no offline delivery or room directory. Messages reach online peers; unacked messages are
  re‑sent when a peer reconnects while you are still there, and newcomers get the last ~200 messages
  from anyone who shares history. If everyone leaves, history exists only in members' local databases.
* **Screen sharing needs a direct link** and video only (no sound); a member whose chat goes through the
  relay cannot watch a share, and the host pays the fan-out bandwidth (≈ preset bitrate × viewers).
* **Room size** is capped at 12. Joiners connect to the creator, who forwards messages (a creator-hosted hub).
* **Five-letter codes** are easy to share but are not strong secrets and can collide; PeerJS rejects an
  occupied code and Orbit generates another. Use a room password for content confidentiality.
* **Identity is not authenticated.** Anyone can pick any display name; the per‑install `userId` is
  random and could be spoofed by a modified client. Room codes identify the room but do not authenticate
  a member; optional passwords protect content.
* **Keeper powers are cooperative** (title, soft mute) — a modified client can ignore them.
* Content scripts cannot run on `chrome://` pages, the Web Store, other extensions' pages or the PDF
  viewer; there Orbit opens in the **side panel**.
* Very large pages with aggressive CSPs: the UI works (Shadow DOM + `adoptedStyleSheets`; images fall
  back to canvas rendering when `img-src` blocks `data:` URLs), but a page that removes unknown
  elements in a tight loop will fight the MutationObserver.
* Firefox is not supported (no `chrome.offscreen`).

## Reliability features

Image and file transfers use acknowledged chunks. Failed image transfers can be retried, and interrupted image/file chunks are retained locally so reconnects can resume. File attachments support any file type up to 50 MB; Orbit asks for confirmation above 25 MB. Voice messages are recorded in-browser and capped at 30 seconds. Poll creation supports custom questions/options, single- or multiple-choice voting, and an optional close time; voters can change their vote while the poll is open. Message pins are shared across room members and included in shared history. If the current PeerJS host disappears, online members deterministically elect a replacement that claims the same five-letter room ID; the handoff notice is a bold `@everyone` timeline message and is removed after everyone online at handoff has read through it. Host recovery depends on members retaining a live Orbit session and a usable PeerJS/WebRTC connection.

## Troubleshooting

| symptom | what to check |
|---------|---------------|
| Everyone left and now nobody can get back in | The room's creator has to reclaim the five-letter code — the status line shows *“Reclaiming this room…”* while the matchmaker still holds their old session (up to ~a minute after a browser crash, plus retries). If you *are* the creator: click the room card, wait for the status to change. If the code was created on another device, that device must be the one to open it. From 3.1.0 Orbit keeps retrying this on its own instead of demoting the room. |
| “Room code… is still held by your previous session” | Not an error: the previous Orbit session's PeerJS id has not expired yet. It resolves itself within a minute or two; a fresh window may help. |
| Screen share stays black, frozen or “Waiting for the first frame…” | Share a *window* or the *whole screen* rather than a tab (Chrome stops rendering background tabs), press *Refresh video*, or check the status line — a member on the relay cannot watch video (needs a direct link; add TURN in Advanced). |
| Screen share button says it needs a direct link | This profile's connection to the room is currently going through the MQTT relay. Chat works, video does not; add a TURN server so a direct WebRTC path can form. |
| Screen share is choppy | Lower the quality preset (Low = 960×540 @6 fps), and remember the host forwards every segment to every member, so bandwidth grows with the number of viewers. |
| Dot never appears | Is the site in *Hide on these sites*? Is "Hide everywhere for 1 h" or the boss key active (Alt+Shift+H)? Reload the page after installing/updating the extension. Some pages (`chrome://`, Web Store) never get content scripts — use the toolbar icon → side panel. |
| "Connecting…" forever, 0 peers | At least one room member must remain online. Orbit attempts automatic host handoff when the current host disappears, but if all members leave, the room is offline. Check that the five-letter code/password are exact and outbound TLS/WebSocket access to `0.peerjs.com:443` is allowed. |
| Peers visible but connection stuck in `connecting`/`failed` | NAT traversal failed; add a TURN server in Advanced settings (both sides). |
| Messages arrive only after reopening the panel | The offscreen document was restarted (Chrome killed it); it recovers automatically. Check `chrome://extensions` → Orbit → *service worker* console for errors. |
| Images or files stay waiting | The sender may have left, or the attachment may exceed its size limit. Click *Get file* or the image placeholder to request it from a connected member who has it; interrupted chunks are resumed when a peer reconnects. |
| Voice note cannot record | Allow Orbit microphone access when prompted and retry. The microphone is only used after clicking the voice-record button; recordings stop at 30 seconds. |
| Sounds don't play | Enable *Notification sound*; the boss key and DND schedule mute sounds; Chrome may require the offscreen document to have played once — use *Test*. |
| Panel looks unstyled or tiny on a site | The site's CSS cannot leak in (closed shadow root + `all: initial`), but very old Chrome (<116) lacks `adoptedStyleSheets` in shadow roots — update Chrome. |
| "Orbit was updated — reload this page" | The extension was reloaded; content scripts of already‑open tabs lose their connection by design. Reload the tab. |
| Keyboard shortcut does nothing | Another extension may own it; reassign at `chrome://extensions/shortcuts`. |

Console logs: page console for the content script (`[Orbit]` prefix), `chrome://extensions` →
*service worker* for the background, and `chrome://extensions` → *offscreen.html* (Inspect views)
for networking.

## File map

```
manifest.json                 MV3 manifest (permissions explained inline in the service worker header)
shared/brand.js               BRAND_NAME + every constant/default (rename here)
shared/bridge.js              runtime.Port bridge with reconnect, request/response, heartbeat
background/service-worker.js  hub: ports, offscreen lifecycle, badge, notifications, commands, side panel
offscreen/offscreen.html/.js  networking host: rooms, peers, protocol, history sync, images
offscreen/peerjs-room.js       transport: PeerJS star + relay fallback + upgrade; refuses to relay screen video
offscreen/relay-mqtt.js         tiny MQTT-over-WebSocket client + relay topic/key sealing
offscreen/crypto.js           room id/key derivation, AES-GCM, name normalization
offscreen/db.js               IndexedDB (messages, images, meta) with caps/pruning
offscreen/protocol.js         envelope validation, limits, rate limiter
offscreen/images.js           image sniffing, size probing, thumbnails
offscreen/sounds.js           Web Audio synthesized notification sounds
content/content.js            the dot (closed Shadow DOM, drag/snap, peek, context menu, lazy UI load)
ui/panel.js                   panel core: shell, rooms, room view, composer, images, lightbox, menus, screen capture & playback
ui/panel-settings.js          profile, appearance, notifications/privacy, advanced, about (GitHub links), diagnostics, tour
ui/ui-kit.js                  DOM builder, inline SVG icons, avatars, rich text renderer, image utils
ui/strings.js                 every user-facing string (single object, t(key, vars))
ui/emoji-data.js              local emoji dataset (generated)
ui/panel.css                  the design system (CSS custom properties, light/dark, compact, grain)
ui/sidepanel.html/.js/.css    side panel host (fallback UI)
lib/peerjs-client.js         vendored PeerJS browser client — see lib/README.md
lib/trystero-*.js             legacy Trystero bundles — see lib/README.md
icons/                        generated icons (colour + monochrome) and orbit.svg
scripts/                      build-vendor.sh, make-icons.py, gen-emoji.py
```

License: MIT for Orbit's own code. PeerJS and legacy Trystero bundles are MIT — see `lib/README.md`.
