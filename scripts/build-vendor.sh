#!/usr/bin/env bash
# Rebuilds the vendored Trystero bundles in lib/ from npm (no CDN at runtime).
# Requires Node 18+. Run from the extension root:  bash scripts/build-vendor.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build && cd .build
[ -f package.json ] || npm init -y >/dev/null
npm i --no-audit --no-fund esbuild@latest peerjs@1.5.5 @trystero-p2p/nostr@0.25.4 @trystero-p2p/mqtt@0.25.4 @trystero-p2p/torrent@0.25.4
for s in nostr mqtt torrent; do
cat > entry-$s.js <<EOT
// Orbit vendored bundle: Trystero '$s' serverless signaling strategy (MIT, https://github.com/dmotz/trystero)
export {joinRoom, selfId, getRelaySockets, defaultRelayUrls} from '@trystero-p2p/$s'
export const strategy = '$s'
export const trysteroVersion = '0.25.4'
EOT
npx esbuild entry-$s.js --bundle --format=esm --platform=browser --target=chrome116 --minify --legal-comments=none --outfile=../lib/trystero-$s.js
done
cat > entry-peerjs.js <<'EOT'
// PeerJS client (MIT, https://github.com/peers/peerjs)
export { Peer } from 'peerjs'
export const peerjsVersion = '1.5.5'
EOT
npx esbuild entry-peerjs.js --bundle --format=esm --platform=browser --target=chrome116 --minify --legal-comments=none --outfile=../lib/peerjs-client.js
echo "Done. Bundles written to lib/"
