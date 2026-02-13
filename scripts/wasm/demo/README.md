# GnuPG WASM Browser Demo

Interactive browser demo for the wasm gpg build.

## Features

- Key generation (`--quick-generate-key`)
- Public/secret key listing
- Key import/export (ASCII armor)
- Keyserver operations (search / recv / send / refresh)
- Symmetric encryption/decryption
- Public-key encryption/decryption
- Clear-sign and verify
- Raw gpg command runner
- Stdin preset per run plus on-demand stdin prompt when gpg requests input
- Loopback pinentry callback via status-driven stdin (`GET_HIDDEN`) dialog
- Experimental browser agent bridge via side Worker (`gpg-agent --server`)
- Browser keyserver bridge via fetch-backed dirmngr shim Worker

Notes for keyserver in browser:

- Browser demo routes keyserver commands through `scripts/wasm/gpg-dirmngr-fetch-worker.js`
  and exposes a dirmngr-compatible Assuan bridge to gpg.
- Keyserver endpoints must allow browser fetch (CORS). If a server blocks CORS, keyserver
  commands may fail in browser even when they work in native gpg.
- For commands that ask on stdin (for example selecting a key from `--search-keys`), use the
  demo stdin preset textarea (e.g. `1` on one line) before running the command.

## Run locally

1. Build wasm binaries first (if needed):

   ```bash
   bash scripts/wasm/build-gnupg-browser.sh --force
   ```

2. Serve repository root with cross-origin isolation headers
   (required for pthread-enabled wasm builds):

   ```bash
   python3 scripts/wasm/demo/serve.py --port 8080
   ```

3. (Optional) Prepare browser launcher copy with `.js` suffix:

   ```bash
   bash scripts/wasm/prepare-browser-assets.sh
   ```

4. Open:

   ```text
   http://localhost:8080/scripts/wasm/demo/index.html
   ```

The demo defaults to these runtime assets:

- `PLAY/wasm-prefix-browser/bin/gpg.js`
- `PLAY/wasm-prefix-browser/bin/gpg.wasm`

If your layout differs, update URLs in the Runtime Setup section.

If your browser still rejects loading scripts from extensionless files,
always use the `.js` launcher copy path.

Important: the Node-target launcher (`PLAY/wasm-prefix/bin/gpg`/`gpg.js`) is
linked with `--sENVIRONMENT=node` and will fail in browsers (for example
`require is not defined`). Use the browser-target build/prefix above.

If you see `DataCloneError: WebAssembly.Memory object cannot be serialized`,
your server is missing COOP/COEP headers; use `serve.py` above.

## Run as Isolated Web App (IWA)

IWA mode packages the demo into a signed web bundle (`.swbn`) that runs in
its own Chromium app window with full cross-origin isolation, Trusted Types,
and WebUSB access — no dev-server needed.

### Quick start

```bash
# One-shot: build everything and launch
bash scripts/wasm/run-iwa.sh --build
```

### Step by step

1. Build dependencies (first time only):

   ```bash
   bash scripts/wasm/build-deps.sh
   ```

2. Build browser wasm:

   ```bash
   bash scripts/wasm/build-gnupg-browser.sh --force
   ```

3. Package into signed IWA bundle:

   ```bash
   bash scripts/wasm/build-iwa.sh
   ```

4. Launch Chromium with the IWA:

   ```bash
   bash scripts/wasm/run-iwa.sh
   ```

   Chromium opens with the IWA installed. The app appears as a standalone
   window (not a regular tab). If it doesn't auto-open, find "GnuPG WASM"
   in your system app launcher or go to `chrome://apps` in Chromium.

### What works in IWA

- `gpg --version` — exit code 0
- `gpg --quick-generate-key "Test <test@test>" ed25519` — key generation
- `gpg --list-secret-keys` — lists generated keys
- Symmetric encrypt/decrypt, sign/verify
- Raw command runner

### Known issues

- **USB/smartcard (`gpg --card-status`)**: scdaemon bridge is integrated but
  WebUSB device selection currently hangs. The CCID+libusb path needs further
  work to surface the browser USB permission prompt correctly.
- IWA windows cannot be opened in regular browser tabs; they require the
  standalone app window launched by `--install-isolated-web-app-from-file`.

### Build notes

- `build-deps.sh` automatically patches `libgcrypt/random/rndoldlinux.c` to
  skip `poll()` under Emscripten (which would trigger an Asyncify unwind
  through the uninstrumented `gcry_pk_genkey` call chain).
- `build-deps.sh` installs to `PLAY/wasm-prefix/`. Browser builds link from
  `PLAY/wasm-prefix-browser/`. After rebuilding libgcrypt, copy the `.a`:

  ```bash
  cp PLAY/wasm-prefix/lib/libgcrypt.a PLAY/wasm-prefix-browser/lib/libgcrypt.a
  ```

- IWA bundle output: `PLAY/iwa/gnupg-wasm-demo.swbn`
- Bundle ID: derived from the Ed25519 key in `PLAY/iwa-keys/private-key.pem`

