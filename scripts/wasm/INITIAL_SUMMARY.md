# GnuPG WASM Node Build - Status Summary

Date: 2026-02-11

## What is done

- Added a Node-first wasm build flow for GnuPG under `scripts/wasm/`.
- Implemented dependency build order:
  - `libgpg-error -> npth -> libgcrypt -> libassuan -> libksba`
- Implemented GnuPG wasm build/install logic with launcher post-processing.
- Added sidecar copy (`*.wasm`) into `PLAY/wasm-prefix/bin` after install.
- Added launcher patches for:
  - Emscripten poll-guard compatibility
  - Extra inherited fd registration (`GNUPG_WASM_EXTRA_FDS`)
- Added Emscripten IPC fallback in `common/asshelp.c`:
  - `GNUPG_WASM_AGENT_FD`
  - `GNUPG_WASM_DIRMNGR_FD`
  - `GNUPG_WASM_KEYBOXD_FD`
- Added Node orchestration CLI:
  - `scripts/wasm/gpg-node-cli.mjs`
  - `scripts/wasm/gpg-node-cli.sh` (thin launcher)
- Added fetch-backed dirmngr shim:
  - `scripts/wasm/dirmngr-fetch-shim.mjs`
  - supports `GETINFO`, `OPTION`, `KEYSERVER`, `KS_GET`, `KS_SEARCH`, `KS_FETCH`, `WKD_GET`
- Added integrated feature smoke:
  - `scripts/wasm/run-node-agent-dirmngr-smoke.sh`

## Build and validation status

- Full build path passed:
  - `bash scripts/wasm/build-all.sh --clean --force`
- GnuPG rebuild path passed:
  - `bash scripts/wasm/build-gnupg.sh --force`
- Baseline Node smoke passed:
  - `bash scripts/wasm/run-node-smoke.sh`
- Agent+dirmngr smoke passed:
  - `bash scripts/wasm/run-node-agent-dirmngr-smoke.sh`

## Runtime capability matrix (current)

- Works:
  - `--version`
  - Symmetric encrypt/decrypt (`--symmetric`, `--decrypt`)
  - Key import (`--import`)
  - Local trustdb operations (`--check-trustdb`, `--import-ownertrust`)
  - Key generation (`--quick-generate-key`) via bridged wasm `gpg-agent --server`
  - Signing (`--sign`) via bridged wasm `gpg-agent --server` with loopback pinentry
  - Keyserver receive (`--recv-keys`) via fetch-backed dirmngr shim

- Known caveats:
  - `scdaemon` is still unavailable in this wasm profile (smartcard paths log warnings)
  - keyserver behavior depends on selected server and key availability

## Important profile limits

- The wasm configure profile still disables native daemons/components:
  - `dirmngr`, `keyboxd`, `scdaemon`, `tpm2d`, `gpgsm`, `g13`
  - LDAP/libdns/TLS native dirmngr stack
  - several optional compression/helper features
- Current strategy is to provide Node-side bridge/shim services for missing runtime IPC features.

## Useful commands

- Rebuild all:
  - `bash scripts/wasm/build-all.sh --clean --force`
- Baseline smoke:
  - `bash scripts/wasm/run-node-smoke.sh`
- Agent+dirmngr smoke:
  - `bash scripts/wasm/run-node-agent-dirmngr-smoke.sh`
- Node CLI passthrough:
  - `bash scripts/wasm/gpg-node-cli.sh -- --version`
  - `bash scripts/wasm/gpg-node-cli.sh -- --quick-generate-key "User <u@example.test>" default default never`
  - `bash scripts/wasm/gpg-node-cli.sh -- --keyserver hkps://keyserver.ubuntu.com --recv-keys 0x3B4FE6ACC0B21F32`
