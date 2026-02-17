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

## Agent runtime mode in demo

The demo now uses external/persistent agent runtime mode
(`persistentAgentRuntime: true`).

- A dedicated `gpg-agent-session-worker` runtime stays alive across commands.
- Each gpg command still uses a fresh bridge session, but reuses the same
  agent wasm runtime.
- This reduces repeated agent cold-start overhead and startup log noise.

Reference behavior difference:

- `persistentAgentRuntime: false` (spawn mode): starts `gpg-agent-server-worker`
  on every command.
- `persistentAgentRuntime: true` (external/persistent): reuses one
  `gpg-agent-session-worker` runtime across commands.

### Startup path details (A vs B)

Path A: spawn mode (`persistentAgentRuntime: false`)

1. UI calls `runGpg(...)`.
2. Client creates a fresh `gpg-browser-worker` for this command.
3. `gpg-browser-worker` spawns `gpg-agent-server-worker`.
4. `gpg-agent-server-worker` boots wasm runtime for this run and serves the
   agent bridge (`GNUPG_WASM_AGENT_FD`).
5. Command finishes; browser worker and agent worker are torn down.
6. Next command repeats full startup from scratch.

Path B: external/persistent mode (`persistentAgentRuntime: true`, demo default)

1. UI calls `runGpg(...)`.
2. Client keeps one long-lived `gpg-agent-session-worker` runtime.
3. For each command, client opens a fresh shared-memory bridge session to that
   runtime.
4. `gpg-browser-worker` runs gpg and binds to the provided external bridge
   (no per-command agent runtime boot).
5. Command finishes; per-command bridge is closed, but session worker stays
   alive.
6. Next command reuses the same agent runtime and repeats only the bridge setup.

Trade-offs

- Spawn mode (A):
  - Pros: strongest per-command isolation, clean state each run.
  - Cons: repeated startup overhead, repeated startup logs/noise.
- External/persistent mode (B):
  - Pros: lower latency for multi-command sessions, less startup noise.
  - Cons: stateful runtime across commands; when runtime gets into a bad state,
    you may need a client/session reset.

Scope note

- This A/B difference applies to `gpg-agent` bridge behavior.
- `gpg` execution itself remains one-shot per command in both modes.
- `dirmngr` and `scdaemon` bridges are still created per command/session and
  are not globally persistent yet.

## Debug and perf modes

- `debug` mode: enables verbose runtime traces (`[debug:...]`) for bridge/runtime troubleshooting.
- `perf` mode: enables timing/performance summary lines (`[perf:...]`) for a run.

In demo code, these are per-run options passed to `runGpg(args, pinentryRequest, options)`:

```js
await runGpg(args, {}, {
  debug: true,
  perfEnabled: true,
  perfLabel: 'my-run',
  perfInputPath: '/work/input.txt',
  perfOutputPath: '/work/output.asc',
});
```

Notes:

- `perfEnabled: true` is currently used by the demo symmetric-encrypt flow.
- `callback counters client stdout/stderr/status=...` is shown only when `perfEnabled` is true.

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
