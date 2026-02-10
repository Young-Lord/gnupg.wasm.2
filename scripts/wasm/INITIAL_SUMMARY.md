# GnuPG WASM Node Build - Initial Summary

Date: 2026-02-11

## What is done

- Added a Node-first wasm build flow for GnuPG under `scripts/wasm/`.
- Implemented dependency build order:
  - `libgpg-error -> npth -> libgcrypt -> libassuan -> libksba`
- Implemented GnuPG wasm build and install logic.
- Added post-install sidecar copy (`*.wasm`) into `PLAY/wasm-prefix/bin`.
- Added launcher compatibility patch for current Emscripten poll behavior.
- Added Node smoke test script for symmetric encrypt/decrypt verification.
- Added a passthrough CLI wrapper (`gpg-node-cli.sh`) for ffmpeg-style argument forwarding.

## Build and smoke status

- Full rebuild command passed:
  - `bash scripts/wasm/build-all.sh --clean --force`
- Node smoke command passed:
  - `bash scripts/wasm/run-node-smoke.sh`

## Runtime capability matrix (current)

- Works:
  - `--version`
  - Symmetric encrypt/decrypt (`--symmetric`, `--decrypt`)
  - Key import (`--import`)
  - Local trustdb operations (`--check-trustdb`, `--import-ownertrust`)

- Not working yet:
  - Keyserver receive (`--recv-keys`)
    - reason: no `dirmngr` runtime path in this build profile
  - Key generation (`--quick-generate-key`, `--full-generate-key`)
    - reason: no working `gpg-agent` session/IPC path in this build profile

## Important build profile limits

- The wasm configure profile currently disables or omits:
  - `dirmngr`, `keyboxd`, `scdaemon`, `tpm2d`, `gpgsm`, `g13`
  - LDAP/libdns/TLS keyserver paths
  - several optional compression and helper features

This is intentional for a minimal Node-first baseline.

## Useful commands

- Rebuild all:
  - `bash scripts/wasm/build-all.sh --clean --force`
- Run smoke test:
  - `bash scripts/wasm/run-node-smoke.sh`
- Run arbitrary gpg args (passthrough):
  - `bash scripts/wasm/gpg-node-cli.sh -- --version`
  - `bash scripts/wasm/gpg-node-cli.sh -- --list-keys --with-colons`

## Next implementation options

1. Add host-assisted key fetch (`curl`/HTTP + `gpg --import`) as a practical replacement for `--recv-keys`.
2. Add a wasm-compatible agent strategy for key generation workflows.
3. Add a broader command compatibility test suite on top of `gpg-node-cli.sh`.
