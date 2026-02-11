# GnuPG WASM Browser Demo

Interactive browser demo for the wasm gpg build.

## Features

- Key generation (`--quick-generate-key`)
- Public/secret key listing
- Key import/export (ASCII armor)
- Symmetric encryption/decryption
- Public-key encryption/decryption
- Clear-sign and verify
- Raw gpg command runner
- Loopback pinentry callback via Worker message protocol
- Experimental browser agent bridge via side Worker (`gpg-agent --server`)

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
