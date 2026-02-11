#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/env.sh"

WASM_PREFIX="$WASM_PREFIX/../wasm-prefix-browser"
SRC_GPG="$WASM_PREFIX/bin/gpg"
DST_GPG_JS="$WASM_PREFIX/bin/gpg.js"
SRC_GPG_AGENT="$WASM_PREFIX/bin/gpg-agent"
DST_GPG_AGENT_JS="$WASM_PREFIX/bin/gpg-agent.js"

if [[ ! -f "$SRC_GPG" ]]; then
  wasm_die "Missing wasm launcher: $SRC_GPG"
fi

cp -f "$SRC_GPG" "$DST_GPG_JS"
chmod +x "$DST_GPG_JS" || true

if [[ -f "$SRC_GPG_AGENT" ]]; then
  cp -f "$SRC_GPG_AGENT" "$DST_GPG_AGENT_JS"
  chmod +x "$DST_GPG_AGENT_JS" || true
  wasm_info "Prepared browser asset: $DST_GPG_AGENT_JS"
else
  wasm_info "Skipping gpg-agent.js (missing source launcher: $SRC_GPG_AGENT)"
fi

wasm_info "Prepared browser asset: $DST_GPG_JS"
wasm_info "Use in demo: /PLAY/wasm-prefix-browser/bin/gpg.js"
