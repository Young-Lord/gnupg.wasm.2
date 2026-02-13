#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE_DIR="$ROOT_DIR/PLAY/iwa-stage"
OUT_DIR="$ROOT_DIR/PLAY/iwa"
KEY_DIR="$ROOT_DIR/PLAY/iwa-keys"

SEED_BASE_URL="${IWA_SEED_BASE_URL:-https://gnupg-wasm.local/}"
if [[ "$SEED_BASE_URL" != */ ]]; then
  SEED_BASE_URL="${SEED_BASE_URL}/"
fi
WBN_PATH="$OUT_DIR/gnupg-wasm-demo.wbn"
SWBN_PATH="$OUT_DIR/gnupg-wasm-demo.swbn"
SEED_WBN_PATH="$OUT_DIR/gnupg-wasm-demo-seed.wbn"
SEED_SWBN_PATH="$OUT_DIR/gnupg-wasm-demo-seed.swbn"
KEY_PATH="$KEY_DIR/private-key.pem"
APP_VERSION="${IWA_APP_VERSION:-0.1.$(date +%s)}"

echo "[iwa] root: $ROOT_DIR"
echo "[iwa] stage: $STAGE_DIR"
echo "[iwa] output: $OUT_DIR"
echo "[iwa] app version: $APP_VERSION"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/scripts/wasm/demo"
mkdir -p "$STAGE_DIR/scripts/wasm"
mkdir -p "$STAGE_DIR/PLAY/wasm-prefix-browser/bin"
mkdir -p "$STAGE_DIR/.well-known"
mkdir -p "$STAGE_DIR/assets"
mkdir -p "$OUT_DIR"
mkdir -p "$KEY_DIR"

cp "$ROOT_DIR/scripts/wasm/demo/index.html" "$STAGE_DIR/scripts/wasm/demo/demo.html"
cp "$ROOT_DIR/scripts/wasm/demo/app.mjs" "$STAGE_DIR/scripts/wasm/demo/app.mjs"
cp "$ROOT_DIR/scripts/wasm/demo/styles.css" "$STAGE_DIR/scripts/wasm/demo/styles.css"

cp "$ROOT_DIR/scripts/wasm/gpg-browser-client.mjs" "$STAGE_DIR/scripts/wasm/gpg-browser-client.mjs"
cp "$ROOT_DIR/scripts/wasm/gpg-browser-worker.js" "$STAGE_DIR/scripts/wasm/gpg-browser-worker.js"
cp "$ROOT_DIR/scripts/wasm/gpg-agent-server-worker.js" "$STAGE_DIR/scripts/wasm/gpg-agent-server-worker.js"
cp "$ROOT_DIR/scripts/wasm/gpg-agent-session-worker.js" "$STAGE_DIR/scripts/wasm/gpg-agent-session-worker.js"
cp "$ROOT_DIR/scripts/wasm/gpg-scdaemon-server-worker.js" "$STAGE_DIR/scripts/wasm/gpg-scdaemon-server-worker.js"
cp "$ROOT_DIR/scripts/wasm/gpg-dirmngr-fetch-worker.js" "$STAGE_DIR/scripts/wasm/gpg-dirmngr-fetch-worker.js"
cp "$ROOT_DIR/scripts/wasm/dirmngr-fetch-shim.mjs" "$STAGE_DIR/scripts/wasm/dirmngr-fetch-shim.mjs"

cp "$ROOT_DIR/PLAY/wasm-prefix-browser/bin/gpg.js" "$STAGE_DIR/PLAY/wasm-prefix-browser/bin/gpg.js"
cp "$ROOT_DIR/PLAY/wasm-prefix-browser/bin/gpg.wasm" "$STAGE_DIR/PLAY/wasm-prefix-browser/bin/gpg.wasm"
cp "$ROOT_DIR/PLAY/wasm-prefix-browser/bin/gpg-agent.js" "$STAGE_DIR/PLAY/wasm-prefix-browser/bin/gpg-agent.js"
cp "$ROOT_DIR/PLAY/wasm-prefix-browser/bin/gpg-agent.wasm" "$STAGE_DIR/PLAY/wasm-prefix-browser/bin/gpg-agent.wasm"
cp "$ROOT_DIR/PLAY/wasm-prefix-browser/bin/scdaemon.js" "$STAGE_DIR/PLAY/wasm-prefix-browser/bin/scdaemon.js"
cp "$ROOT_DIR/PLAY/wasm-prefix-browser/bin/scdaemon.wasm" "$STAGE_DIR/PLAY/wasm-prefix-browser/bin/scdaemon.wasm"

python3 - "$STAGE_DIR/assets/icon-192.png" <<'PY'
import pathlib
import struct
import zlib
import sys

out_path = pathlib.Path(sys.argv[1])

size = 192
rows = []
for y in range(size):
    row = bytearray()
    for x in range(size):
        if 24 <= x <= 167 and 24 <= y <= 167:
            r, g, b = 247, 244, 234
            if 56 <= x <= 136 and 52 <= y <= 140:
                r, g, b = 23, 70, 90
            if (x - 96) ** 2 + (y - 124) ** 2 <= 26 ** 2 and y >= 100:
                r, g, b = 243, 196, 134
        else:
            r, g, b = 15, 111, 129
        row.extend((r, g, b, 255))
    rows.append(b"\x00" + bytes(row))

raw = b"".join(rows)
comp = zlib.compress(raw, 9)

def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", comp)
png += chunk(b"IEND", b"")

out_path.write_bytes(png)
PY

cat > "$STAGE_DIR/.well-known/manifest.webmanifest" <<JSON
{
  "id": "/",
  "name": "GnuPG WASM Browser Lab",
  "short_name": "GnuPG WASM",
  "version": "$APP_VERSION",
  "start_url": "/scripts/wasm/demo/demo.html",
  "scope": "/",
  "display": "standalone",
  "isolated_storage": true,
  "permissions_policy": {
    "cross-origin-isolated": ["self"],
    "usb": ["self"],
    "usb-unrestricted": ["self"]
  },
  "background_color": "#f8fbfc",
  "theme_color": "#0f6f81",
  "icons": [
    {
      "src": "/assets/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    }
  ]
}
JSON

if [[ ! -f "$KEY_PATH" ]]; then
  echo "[iwa] generating new Ed25519 key: $KEY_PATH"
  openssl genpkey -algorithm Ed25519 -out "$KEY_PATH"
else
  echo "[iwa] reusing existing key: $KEY_PATH"
fi

echo "[iwa] building seed unsigned bundle"
npx --yes wbn \
  --dir "$STAGE_DIR" \
  --baseURL "$SEED_BASE_URL" \
  --output "$SEED_WBN_PATH"

echo "[iwa] signing seed bundle to derive bundle id"
seed_sign_output="$(npx --yes wbn-sign \
  --input "$SEED_WBN_PATH" \
  --private-key "$KEY_PATH" \
  --output "$SEED_SWBN_PATH")"

echo "$seed_sign_output"
bundle_id="$(printf '%s\n' "$seed_sign_output" | sed -n '/^[a-z0-9][a-z0-9]*$/p' | tail -n 1)"
if [[ -z "$bundle_id" ]]; then
  echo "[iwa] failed to derive web bundle id from wbn-sign output" >&2
  exit 1
fi

base_url="isolated-app://$bundle_id/"

echo "[iwa] rebuilding unsigned bundle with isolated-app base URL"
npx --yes wbn \
  --dir "$STAGE_DIR" \
  --baseURL "$base_url" \
  --output "$WBN_PATH"

echo "[iwa] signing final bundle"
npx --yes wbn-sign \
  --input "$WBN_PATH" \
  --private-key "$KEY_PATH" \
  --web-bundle-id "$bundle_id" \
  --output "$SWBN_PATH"

echo "[iwa] done"
echo "[iwa] signed bundle: $SWBN_PATH"
echo "[iwa] bundle id: $bundle_id"
