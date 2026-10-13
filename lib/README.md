# lib/ — vendored third‑party code

Orbit loads **no code from the network**. The files here are the third‑party JavaScript bundles imported by `offscreen/offscreen.js` at runtime. PeerJS additionally connects to its public PeerServer over TLS for signaling; that service brokers connections but does not carry chat payloads:

| file                  | contents                                                            | size   |
|-----------------------|---------------------------------------------------------------------|--------|
| `peerjs-client.js`    | PeerJS 1.5.5 client for namespaced five-letter room IDs                 | ~87 KB |
| `trystero-nostr.js`   | Legacy Trystero Nostr bundle                                         | ~60 KB |
| `trystero-mqtt.js`    | Trystero 0.25.4 — MQTT‑broker signaling strategy (+ mqtt.js)        | ~384 KB |
| `trystero-torrent.js` | Legacy Trystero BitTorrent bundle                                    | ~52 KB |

The Trystero bundles export `joinRoom`, `selfId`, `getRelaySockets`, `defaultRelayUrls`, plus Orbit
strategy/version constants. They were produced from the unmodified npm packages
`@trystero-p2p/{nostr,mqtt,torrent}@0.25.4`. PeerJS is the unmodified `peerjs@1.5.5` client. All
are bundled with esbuild (`--bundle --format=esm --platform=browser --target=chrome116 --minify`). None uses `eval`,
`new Function` or remote `import()`, so they run under the extension's strict CSP.

## Rebuilding

```bash
# from the extension root; needs Node 18+ and npm
bash scripts/build-vendor.sh
```

The script installs the pinned packages into `.build/`, writes the entry files and bundles them into
`lib/`. To upgrade PeerJS or Trystero, bump the pinned version in `scripts/build-vendor.sh` (and the
corresponding version constant), rebuild, and re-test host/join with two profiles. Orbit keeps its own
JSON wire protocol (see the main README); both libraries provide transport/signaling only.

## Licenses

* **Trystero** — MIT © Dan Motzenbecker — https://github.com/dmotz/trystero
* **PeerJS** — MIT — https://github.com/peers/peerjs
* Bundled transitive dependencies (e.g. `mqtt`, `@noble/*`, `nostr-tools`) are MIT/BSD/Apache‑2.0
  licensed; their notices are preserved in the respective npm packages (run the build script to
  inspect `.build/node_modules/*/LICENSE`).

Everything outside `lib/` is Orbit's own code (MIT).
