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
SRC_SCDAEMON="$WASM_PREFIX/libexec/scdaemon"
DST_SCDAEMON_JS="$WASM_PREFIX/bin/scdaemon.js"
SRC_SCDAEMON_WASM="$WASM_PREFIX/libexec/scdaemon.wasm"
DST_SCDAEMON_WASM="$WASM_PREFIX/bin/scdaemon.wasm"

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

if [[ -f "$SRC_SCDAEMON" ]]; then
  cp -f "$SRC_SCDAEMON" "$DST_SCDAEMON_JS"
  chmod +x "$DST_SCDAEMON_JS" || true
  wasm_info "Prepared browser asset: $DST_SCDAEMON_JS"
else
  wasm_info "Skipping scdaemon.js (missing source launcher: $SRC_SCDAEMON)"
fi

if [[ -f "$SRC_SCDAEMON_WASM" ]]; then
  cp -f "$SRC_SCDAEMON_WASM" "$DST_SCDAEMON_WASM"
  wasm_info "Prepared browser asset: $DST_SCDAEMON_WASM"
else
  wasm_info "Skipping scdaemon.wasm (missing sidecar: $SRC_SCDAEMON_WASM)"
fi

wasm_info "Prepared browser asset: $DST_GPG_JS"
wasm_info "Use in demo: /PLAY/wasm-prefix-browser/bin/gpg.js"
