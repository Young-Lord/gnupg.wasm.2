# GnuPG WASM Browser Worker Callbacks

This adds a browser-specific callback path that does not depend on
Node/NODERAWFS fd bridges.

Use a browser-target launcher build (`--sENVIRONMENT=web,worker`).
Node-target launchers (`--sENVIRONMENT=node`) are not browser compatible.

Current browser build is pthread-enabled, so host page must be served with
COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`).

## What is implemented

- Worker transport for browser runtime:
  - `scripts/wasm/gpg-browser-worker.js`
  - `scripts/wasm/gpg-agent-server-worker.js`
  - `scripts/wasm/gpg-agent-session-worker.js`
- Host-side helper API:
  - `scripts/wasm/gpg-browser-client.mjs`
- Loopback pinentry callback model (no external pinentry process):
  - enforced flags: `--batch --no-tty --pinentry-mode loopback`
  - always uses `--command-fd 0`
  - passphrase is supplied on demand via stdin callback flow (status-driven `GET_HIDDEN`)
- Output callbacks:
  - `onStdout(data)`
  - `onStderr(data)`
  - `onStatus(line)` (`[GNUPG:]` lines parsed from stderr)
- Launcher load fallback:
  - tries `importScripts(gpgScriptUrl)` first
  - if MIME/extension blocks import, falls back to fetch + Blob + `importScripts(blobUrl)`
- Optional in-memory session persistence transport:
  - input: `fsState`, `persistRoots`
  - output: `result.fsState`
  - this allows multi-command browser sessions while keeping one-shot Worker runs
- Browser agent bridge (experimental):
  - gpg worker can launch `gpg-agent --server` in a side Worker
  - side channel wired via Emscripten virtual fd + `GNUPG_WASM_AGENT_FD`
  - enables loopback pinentry-backed operations like key generation/signing
- Persistent agent runtime mode (client-managed):
  - `WasmGpgBrowserClient` can keep a dedicated agent session worker alive
  - each gpg command gets a fresh bridge session while reusing one agent wasm runtime
  - avoids losing in-memory agent runtime cache variables between commands

## Pinentry callback protocol

- Worker emits `stdin-request` with prompt hint from status lines (for example
  `GET_HIDDEN passphrase.enter`).
- `WasmGpgBrowserClient` routes `GET_HIDDEN` requests to `onPinentry(request)` when provided.
- Callback reply is written back into the shared stdin queue:
  - `ok: true` -> passphrase + newline
  - `ok: false` -> cancel with EOF (`Ctrl-D`)
- This mirrors CLI loopback flow and allows GnuPG to control retry/repeat behavior.

## Example

```js
import { WasmGpgBrowserClient } from './gpg-browser-client.mjs';

const client = new WasmGpgBrowserClient({
  workerUrl: new URL('./gpg-browser-worker.js', import.meta.url),
  gpgScriptUrl: '/PLAY/wasm-prefix-browser/bin/gpg.js',
  gpgWasmUrl: '/PLAY/wasm-prefix-browser/bin/gpg.wasm',
  homedir: '/gnupg',
});

const result = await client.run(
  ['--symmetric', '--output', '/tmp/msg.gpg', '/tmp/msg.txt'],
  {
    fsState,
    persistRoots: ['/gnupg', '/work', '/tmp'],
    onStdout: (line) => console.log('[stdout]', line),
    onStderr: (line) => console.log('[stderr]', line),
    onStatus: (line) => console.log('[status]', line),
    onPinentry: async (request) => {
      // Show your own UI here.
      const passphrase = await promptForPassphrase(request);
      if (!passphrase) {
        return { ok: false, passphrase: '' };
      }
      return { ok: true, passphrase };
    },
    pinentryRequest: {
      op: 'symmetric',
      uidHint: '',
      keyHint: '',
    },
  }
);

console.log('exit', result.exitCode);
fsState = result.fsState;
```

## Current scope and limits

- This is the browser callback transport baseline.
- It intentionally does not reuse the Node extra-fd bridge path.
- `WasmGpgBrowserClient.run()` is one-shot per invocation (fresh Worker per run).
- `WasmGpgBrowserClient` keeps gpg runs one-shot, and can optionally keep the
  agent runtime persistent across runs.
- Session persistence is in-memory host transfer only (`fsState`), not IDBFS yet.
- Agent/dirmngr browser transport channels are not wired yet; this layer is
  focused on stdout/stderr/status + loopback pinentry callback flow.

## Interactive demo

- Demo page:
  - `scripts/wasm/demo/index.html`
- Demo docs:
  - `scripts/wasm/demo/README.md`
