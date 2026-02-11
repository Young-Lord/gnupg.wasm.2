import { WasmGpgBrowserClient } from '../gpg-browser-client.mjs';

const DEFAULT_ROOTS = ['/gnupg', '/work'];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const el = {
  gpgScriptUrl: document.querySelector('#gpgScriptUrl'),
  gpgWasmUrl: document.querySelector('#gpgWasmUrl'),
  homedir: document.querySelector('#homedir'),
  defaultPassphrase: document.querySelector('#defaultPassphrase'),
  autoPinentry: document.querySelector('#autoPinentry'),
  sessionInfo: document.querySelector('#sessionInfo'),

  filePath: document.querySelector('#filePath'),
  sourcePath: document.querySelector('#sourcePath'),
  outputPath: document.querySelector('#outputPath'),
  recipient: document.querySelector('#recipient'),
  fileContent: document.querySelector('#fileContent'),
  fileTree: document.querySelector('#fileTree'),

  keyName: document.querySelector('#keyName'),
  keyEmail: document.querySelector('#keyEmail'),
  keyExpire: document.querySelector('#keyExpire'),
  exportSelector: document.querySelector('#exportSelector'),

  rawCommand: document.querySelector('#rawCommand'),
  console: document.querySelector('#console'),

  btnPing: document.querySelector('#btnPing'),
  btnResetSession: document.querySelector('#btnResetSession'),
  btnSaveFile: document.querySelector('#btnSaveFile'),
  btnLoadFile: document.querySelector('#btnLoadFile'),
  btnDeleteFile: document.querySelector('#btnDeleteFile'),
  btnCopyOutputToEditor: document.querySelector('#btnCopyOutputToEditor'),
  btnGenerateKey: document.querySelector('#btnGenerateKey'),
  btnListPub: document.querySelector('#btnListPub'),
  btnListSec: document.querySelector('#btnListSec'),
  btnExportPub: document.querySelector('#btnExportPub'),
  btnImportFromEditor: document.querySelector('#btnImportFromEditor'),
  btnSymmetricEncrypt: document.querySelector('#btnSymmetricEncrypt'),
  btnPublicEncrypt: document.querySelector('#btnPublicEncrypt'),
  btnDecrypt: document.querySelector('#btnDecrypt'),
  btnClearSign: document.querySelector('#btnClearSign'),
  btnVerify: document.querySelector('#btnVerify'),
  btnRunRaw: document.querySelector('#btnRunRaw'),
  btnClearConsole: document.querySelector('#btnClearConsole'),

  pinentryDialog: document.querySelector('#pinentryDialog'),
  pinentryMeta: document.querySelector('#pinentryMeta'),
  pinentryInput: document.querySelector('#pinentryInput'),
  pinentryCancel: document.querySelector('#pinentryCancel'),
  pinentrySubmit: document.querySelector('#pinentrySubmit'),
};

let fsState = null;
let running = false;
let pinentryResolver = null;

function nowLabel() {
  return new Date().toLocaleTimeString();
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x4000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let part = '';
    for (let j = 0; j < chunk.length; j += 1) {
      part += String.fromCharCode(chunk[j]);
    }
    binary += part;
  }

  return btoa(binary);
}

function base64ToBytes(text) {
  if (!text) {
    return new Uint8Array();
  }
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function approxBase64Bytes(text) {
  const clean = String(text || '').replace(/=+$/, '');
  return Math.floor((clean.length * 3) / 4);
}

function normalizePath(pathValue, fallback = '/work/note.txt') {
  let value = typeof pathValue === 'string' ? pathValue.trim() : '';
  if (!value) {
    value = fallback;
  }
  if (!value.startsWith('/')) {
    value = `/${value}`;
  }
  if (value.length > 1 && value.endsWith('/')) {
    value = value.slice(0, -1);
  }
  return value.replace(/\/{2,}/g, '/');
}

function isLikelyKeygenArgs(args) {
  if (!Array.isArray(args)) {
    return false;
  }
  return args.some((arg) => {
    const text = String(arg);
    return text === '--quick-generate-key'
      || text === '--quick-gen-key'
      || text === '--generate-key'
      || text === '--gen-key'
      || text === '--full-generate-key';
  });
}

function parentPath(pathValue) {
  const idx = pathValue.lastIndexOf('/');
  if (idx <= 0) {
    return '/';
  }
  return pathValue.slice(0, idx);
}

function defaultDirMode(path) {
  if (path === '/gnupg') {
    return 0o700;
  }
  if (path === '/tmp') {
    return 0o777;
  }
  return 0o755;
}

function createInitialState() {
  const homedir = normalizePath(el.homedir.value, '/gnupg');
  const roots = Array.from(new Set([...DEFAULT_ROOTS, homedir]));
  const state = {
    version: 1,
    roots,
    dirs: [],
    files: [],
  };

  const addDir = (path, mode) => {
    if (state.dirs.some((entry) => entry.path === path)) {
      return;
    }
    state.dirs.push({ path, mode });
  };

  addDir('/', 0o755);
  for (const root of roots) {
    addDir(root, defaultDirMode(root));
  }

  const samplePath = '/work/input.txt';
  const sampleText = `hello from gpg wasm browser demo\n${new Date().toISOString()}\n`;
  state.files.push({
    path: samplePath,
    mode: 0o600,
    data: bytesToBase64(encoder.encode(sampleText)),
  });

  return state;
}

function ensureState() {
  if (!fsState || typeof fsState !== 'object') {
    fsState = createInitialState();
  }
  if (!Array.isArray(fsState.roots)) {
    fsState.roots = [];
  }
  if (!Array.isArray(fsState.dirs)) {
    fsState.dirs = [];
  }
  if (!Array.isArray(fsState.files)) {
    fsState.files = [];
  }

  const homedir = normalizePath(el.homedir.value, '/gnupg');
  for (const root of [...DEFAULT_ROOTS, homedir]) {
    if (!fsState.roots.includes(root)) {
      fsState.roots.push(root);
    }
    upsertDir(root, defaultDirMode(root));
  }
}

function upsertDir(pathValue, mode = 0o755) {
  const path = normalizePath(pathValue, '/');
  const existing = fsState.dirs.find((entry) => entry.path === path);
  if (existing) {
    existing.mode = mode;
    return;
  }
  fsState.dirs.push({
    path,
    mode,
  });
}

function ensureDirChain(pathValue) {
  const path = normalizePath(pathValue, '/');
  if (path === '/') {
    upsertDir('/', 0o755);
    return;
  }

  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    upsertDir(current, defaultDirMode(current));
  }
}

function upsertTextFile(pathValue, content, mode = 0o600) {
  ensureState();
  const path = normalizePath(pathValue, '/work/note.txt');
  ensureDirChain(parentPath(path));

  const data = bytesToBase64(encoder.encode(content));
  const existing = fsState.files.find((entry) => entry.path === path);
  if (existing) {
    existing.mode = mode;
    existing.data = data;
    return path;
  }

  fsState.files.push({
    path,
    mode,
    data,
  });
  return path;
}

function readTextFile(pathValue) {
  ensureState();
  const path = normalizePath(pathValue, '/work/note.txt');
  const entry = fsState.files.find((item) => item.path === path);
  if (!entry) {
    return null;
  }
  const bytes = base64ToBytes(entry.data);
  return decoder.decode(bytes);
}

function deleteFile(pathValue) {
  ensureState();
  const path = normalizePath(pathValue, '/work/note.txt');
  const before = fsState.files.length;
  fsState.files = fsState.files.filter((entry) => entry.path !== path);
  return fsState.files.length !== before;
}

function renderFileTree() {
  ensureState();

  const dirs = fsState.dirs
    .map((entry) => entry.path)
    .sort((a, b) => a.localeCompare(b));

  const files = fsState.files
    .map((entry) => ({ path: entry.path, size: approxBase64Bytes(entry.data) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const lines = [];
  lines.push('dirs');
  for (const dir of dirs) {
    lines.push(`  ${dir}`);
  }

  lines.push('');
  lines.push('files');
  for (const file of files) {
    lines.push(`  ${file.path} (${file.size} bytes)`);
  }

  if (!files.length) {
    lines.push('  (no files yet)');
  }

  el.fileTree.textContent = lines.join('\n');
}

function appendConsole(kind, text) {
  const line = document.createElement('div');
  line.className = `console-line line-${kind}`;
  line.textContent = `${nowLabel()}  ${text}`;
  el.console.append(line);

  while (el.console.childElementCount > 1200) {
    el.console.removeChild(el.console.firstChild);
  }
  el.console.scrollTop = el.console.scrollHeight;
}

function updateSessionInfo(message) {
  el.sessionInfo.textContent = message;
}

function formatDebugData(data) {
  const LIMIT = 1000;
  if (!data || typeof data !== 'object') {
    const text = String(data ?? '');
    return text.length > LIMIT ? `${text.slice(0, LIMIT)}...` : text;
  }
  try {
    const text = JSON.stringify(data);
    return text.length > LIMIT ? `${text.slice(0, LIMIT)}...` : text;
  } catch {
    return '[unserializable debug payload]';
  }
}

function shellQuote(arg) {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'"'"'`)}'`;
}

function parseArgLine(line) {
  const source = String(line || '').trim();
  if (!source) {
    return [];
  }

  const out = [];
  let current = '';
  let quote = '';
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      if (quote === "'") {
        current += ch;
      } else {
        escaped = true;
      }
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = '';
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (escaped) {
    current += '\\';
  }

  if (quote) {
    throw new Error('Unclosed quote in raw command');
  }

  if (current) {
    out.push(current);
  }

  return out;
}

function setRunningUi(isRunning) {
  running = isRunning;
  const runButtons = document.querySelectorAll('.run-action');
  for (const button of runButtons) {
    button.disabled = isRunning;
  }
}

function setActivePath(pathValue) {
  el.filePath.value = normalizePath(pathValue, '/work/note.txt');
}

function readActivePath() {
  const path = normalizePath(el.filePath.value, '/work/note.txt');
  el.filePath.value = path;
  return path;
}

function writeEditorToPath(pathValue) {
  const path = normalizePath(pathValue, '/work/input.txt');
  upsertTextFile(path, el.fileContent.value);
  renderFileTree();
  return path;
}

function loadPathIntoEditor(pathValue) {
  const path = normalizePath(pathValue, '/work/note.txt');
  const text = readTextFile(path);
  if (text === null) {
    appendConsole('error', `file not found in session: ${path}`);
    return false;
  }
  el.fileContent.value = text;
  setActivePath(path);
  appendConsole('note', `loaded ${path} into editor`);
  return true;
}

async function promptPinentry(request) {
  const autoEnabled = el.autoPinentry.checked;
  const defaultPassphrase = el.defaultPassphrase.value;

  appendConsole(
    'note',
    `[pinentry] request id=${request.id} op=${request.op} auto=${String(autoEnabled)} defaultPassphrase=${defaultPassphrase ? 'set' : 'empty'}`
  );

  if (autoEnabled) {
    appendConsole(
      'note',
      `pinentry auto reply (${request.op}) hasPassphrase=${defaultPassphrase ? 'yes' : 'no (empty passphrase)'}`
    );
    return {
      ok: true,
      passphrase: defaultPassphrase,
    };
  }

  return new Promise((resolve) => {
    pinentryResolver = resolve;
    const details = [
      `op=${request.op || 'passphrase'}`,
      `uid=${request.uidHint || '-'}`,
      `key=${request.keyHint || '-'}`,
    ];
    el.pinentryMeta.textContent = details.join(' | ');
    el.pinentryInput.value = defaultPassphrase;

    if (!el.pinentryDialog.open) {
      el.pinentryDialog.showModal();
    }

    appendConsole('note', '[pinentry] waiting for manual input in dialog');
    el.pinentryInput.focus();
    el.pinentryInput.select();
  });
}

function settlePinentry(ok) {
  if (!pinentryResolver) {
    if (el.pinentryDialog.open) {
      el.pinentryDialog.close();
    }
    return;
  }

  const resolve = pinentryResolver;
  pinentryResolver = null;

  const passphrase = ok ? el.pinentryInput.value : '';
  appendConsole('note', `[pinentry] ${ok ? 'submitted' : 'cancelled'} hasPassphrase=${passphrase ? 'yes' : 'no'}`);
  if (el.pinentryDialog.open) {
    el.pinentryDialog.close();
  }

  resolve({ ok, passphrase });
}

function createClient(homedir, persistRoots) {
  const gpgScriptUrl = el.gpgScriptUrl.value.trim();
  const gpgWasmUrl = el.gpgWasmUrl.value.trim();

  const gpgAgentScriptUrl = gpgScriptUrl
    ? gpgScriptUrl.replace(/gpg(?:\.js)?(?=(?:[?#].*)?$)/, 'gpg-agent.js')
    : '';
  const gpgAgentWasmUrl = gpgWasmUrl
    ? gpgWasmUrl.replace(/gpg\.wasm(?=(?:[?#].*)?$)/, 'gpg-agent.wasm')
    : '';

  return new WasmGpgBrowserClient({
    workerUrl: new URL('../gpg-browser-worker.js', import.meta.url),
    gpgScriptUrl,
    gpgWasmUrl,
    gpgAgentWorkerUrl: new URL('../gpg-agent-server-worker.js', import.meta.url),
    gpgAgentScriptUrl,
    gpgAgentWasmUrl,
    homedir,
    persistRoots,
  });
}

async function runGpg(args, pinentryRequest = {}, options = {}) {
  if (running) {
    appendConsole('error', 'another command is already running');
    return { exitCode: 1, fsState };
  }

  const homedir = normalizePath(el.homedir.value, '/gnupg');
  const persistRoots = Array.from(new Set([...DEFAULT_ROOTS, homedir]));

  ensureState();
  for (const root of persistRoots) {
    if (!fsState.roots.includes(root)) {
      fsState.roots.push(root);
    }
    ensureDirChain(root);
  }

  setRunningUi(true);
  appendConsole('cmd', `$ gpg ${args.map((arg) => shellQuote(arg)).join(' ')}`);

  try {
    const client = createClient(homedir, persistRoots);
    const defaultRunTimeoutMs = isLikelyKeygenArgs(args) ? 600000 : 90000;
    const runTimeoutMs = Number.isFinite(options.runTimeoutMs)
      ? Number(options.runTimeoutMs)
      : defaultRunTimeoutMs;

    if (!Number.isFinite(options.runTimeoutMs) && defaultRunTimeoutMs > 90000) {
      appendConsole('note', `detected key generation command; using extended timeout ${Math.round(defaultRunTimeoutMs / 1000)}s`);
    }

    const result = await client.run(args, {
      fsState,
      persistRoots,
      emitStatus: true,
      debug: true,
      runTimeoutMs,
      onStdout: (line) => {
        appendConsole('stdout', `[stdout] ${String(line ?? '')}`);
      },
      onStderr: (line) => {
        appendConsole('stderr', `[stderr] ${String(line ?? '')}`);
      },
      onStatus: (line) => {
        appendConsole('status', `[status] ${String(line ?? '')}`);
      },
      onDebug: (entry) => {
        const step = entry && typeof entry.step === 'string' ? entry.step : 'unknown';
        const dataText = formatDebugData(entry ? entry.data : null);
        appendConsole('note', `[debug:${step}] ${dataText}`);
      },
      onPinentry: promptPinentry,
      pinentryRequest,
    });

    if (result.fsState) {
      fsState = result.fsState;
    }

    ensureState();
    renderFileTree();
    updateSessionInfo(`last exit code: ${result.exitCode}`);

    if (result.exitCode === 0) {
      appendConsole('ok', `exit code ${result.exitCode}`);
    } else {
      appendConsole('error', `exit code ${result.exitCode}`);
      if (result.workerError) {
        appendConsole('error', `worker: ${result.workerError}`);
      }
    }

    if (result.callbackCounts && typeof result.callbackCounts === 'object') {
      appendConsole(
        'note',
        `callback counters client stdout/stderr/status=${result.callbackCounts.stdout}/${result.callbackCounts.stderr}/${result.callbackCounts.status}`
      );
    }

    return result;
  } catch (error) {
    const detail = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    appendConsole('error', `runner failure: ${detail}`);
    if (error instanceof Error && error.stack) {
      appendConsole('error', error.stack);
    }
    updateSessionInfo(`command failed before exit code: ${detail}`);
    return { exitCode: 1, fsState };
  } finally {
    setRunningUi(false);
  }
}

async function handleGenerateKey() {
  const name = el.keyName.value.trim();
  const email = el.keyEmail.value.trim();
  const expire = el.keyExpire.value.trim() || '1y';

  if (!name || !email) {
    appendConsole('error', 'name and email are required to generate a key');
    return;
  }

  appendConsole('note', 'generate-key may take longer in wasm; using extended timeout');
  const uid = `${name} <${email}>`;
  const result = await runGpg(
    ['--quick-generate-key', uid, 'future-default', 'default', expire],
    { op: 'generate-key', uidHint: uid, keyHint: uid },
    { runTimeoutMs: 300000 }
  );

  if (result.exitCode === 0 && !el.exportSelector.value.trim()) {
    el.exportSelector.value = uid;
  }
}

async function handleListPublic() {
  await runGpg(['--list-keys', '--keyid-format', 'long']);
}

async function handleListSecret() {
  await runGpg(['--list-secret-keys', '--keyid-format', 'long']);
}

async function handleExportPublic() {
  const selector = el.exportSelector.value.trim() || el.recipient.value.trim();
  if (!selector) {
    appendConsole('error', 'set export selector or recipient first');
    return;
  }

  const outPath = normalizePath(el.outputPath.value, '/work/export-public.asc');
  el.outputPath.value = outPath;

  const result = await runGpg(['--armor', '--output', outPath, '--export', selector]);
  if (result.exitCode === 0) {
    loadPathIntoEditor(outPath);
  }
}

async function handleImportFromEditor() {
  const source = normalizePath(el.sourcePath.value, '/work/import.asc');
  el.sourcePath.value = source;
  writeEditorToPath(source);

  await runGpg(['--import', source]);
}

async function handleSymmetricEncrypt() {
  const source = normalizePath(el.sourcePath.value, '/work/input.txt');
  const output = normalizePath(el.outputPath.value, '/work/output.asc');
  el.sourcePath.value = source;
  el.outputPath.value = output;

  writeEditorToPath(source);
  const result = await runGpg(['--armor', '--output', output, '--symmetric', source], {
    op: 'symmetric',
    keyHint: source,
  });
  if (result.exitCode === 0) {
    loadPathIntoEditor(output);
  }
}

async function handlePublicEncrypt() {
  const recipient = el.recipient.value.trim() || el.exportSelector.value.trim();
  if (!recipient) {
    appendConsole('error', 'recipient or key selector is required for public-key encryption');
    return;
  }

  const source = normalizePath(el.sourcePath.value, '/work/input.txt');
  const output = normalizePath(el.outputPath.value, '/work/output.asc');
  el.sourcePath.value = source;
  el.outputPath.value = output;

  writeEditorToPath(source);
  const result = await runGpg([
    '--armor',
    '--trust-model', 'always',
    '--output', output,
    '--encrypt',
    '--recipient', recipient,
    source,
  ]);

  if (result.exitCode === 0) {
    loadPathIntoEditor(output);
  }
}

async function handleDecrypt() {
  const source = normalizePath(el.sourcePath.value, '/work/input.asc');
  const output = normalizePath(el.outputPath.value, '/work/output.txt');
  el.sourcePath.value = source;
  el.outputPath.value = output;

  writeEditorToPath(source);
  const result = await runGpg(['--output', output, '--decrypt', source], {
    op: 'decrypt',
    keyHint: source,
  });

  if (result.exitCode === 0) {
    loadPathIntoEditor(output);
  }
}

async function handleClearSign() {
  const source = normalizePath(el.sourcePath.value, '/work/input.txt');
  const output = normalizePath(el.outputPath.value, '/work/output.asc');
  el.sourcePath.value = source;
  el.outputPath.value = output;

  writeEditorToPath(source);
  const result = await runGpg(['--armor', '--output', output, '--clearsign', source], {
    op: 'sign',
    keyHint: source,
  });

  if (result.exitCode === 0) {
    loadPathIntoEditor(output);
  }
}

async function handleVerify() {
  const source = normalizePath(el.sourcePath.value, '/work/input.asc');
  el.sourcePath.value = source;
  writeEditorToPath(source);

  await runGpg(['--verify', source]);
}

async function handleRawCommand() {
  let args;
  try {
    args = parseArgLine(el.rawCommand.value);
  } catch (error) {
    appendConsole('error', error instanceof Error ? error.message : String(error));
    return;
  }

  if (!args.length) {
    appendConsole('error', 'raw command is empty');
    return;
  }

  await runGpg(args);
}

function resetSession() {
  if (running) {
    appendConsole('error', 'wait for current command to finish before resetting session');
    return;
  }
  fsState = createInitialState();
  ensureState();
  renderFileTree();

  const defaultInput = readTextFile('/work/input.txt');
  if (defaultInput !== null) {
    el.fileContent.value = defaultInput;
    setActivePath('/work/input.txt');
    el.sourcePath.value = '/work/input.txt';
    el.outputPath.value = '/work/output.asc';
  }

  updateSessionInfo('session state reset (in-memory only)');
  appendConsole('note', 'session state reset');
}

function bindEvents() {
  el.btnPing.addEventListener('click', async () => {
    await runGpg(['--version']);
  });

  el.btnResetSession.addEventListener('click', () => {
    resetSession();
  });

  el.btnSaveFile.addEventListener('click', () => {
    const path = readActivePath();
    upsertTextFile(path, el.fileContent.value);
    renderFileTree();
    appendConsole('note', `saved ${path}`);
  });

  el.btnLoadFile.addEventListener('click', () => {
    loadPathIntoEditor(readActivePath());
  });

  el.btnDeleteFile.addEventListener('click', () => {
    const path = readActivePath();
    if (deleteFile(path)) {
      renderFileTree();
      appendConsole('note', `deleted ${path}`);
      return;
    }
    appendConsole('error', `cannot delete missing file: ${path}`);
  });

  el.btnCopyOutputToEditor.addEventListener('click', () => {
    loadPathIntoEditor(el.outputPath.value);
  });

  el.btnGenerateKey.addEventListener('click', async () => {
    await handleGenerateKey();
  });

  el.btnListPub.addEventListener('click', async () => {
    await handleListPublic();
  });

  el.btnListSec.addEventListener('click', async () => {
    await handleListSecret();
  });

  el.btnExportPub.addEventListener('click', async () => {
    await handleExportPublic();
  });

  el.btnImportFromEditor.addEventListener('click', async () => {
    await handleImportFromEditor();
  });

  el.btnSymmetricEncrypt.addEventListener('click', async () => {
    await handleSymmetricEncrypt();
  });

  el.btnPublicEncrypt.addEventListener('click', async () => {
    await handlePublicEncrypt();
  });

  el.btnDecrypt.addEventListener('click', async () => {
    await handleDecrypt();
  });

  el.btnClearSign.addEventListener('click', async () => {
    await handleClearSign();
  });

  el.btnVerify.addEventListener('click', async () => {
    await handleVerify();
  });

  el.btnRunRaw.addEventListener('click', async () => {
    await handleRawCommand();
  });

  el.btnClearConsole.addEventListener('click', () => {
    el.console.textContent = '';
  });

  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      const cmd = chip.dataset.cmd || '';
      el.rawCommand.value = cmd;
      el.rawCommand.focus();
      el.rawCommand.select();
    });
  }

  el.pinentrySubmit.addEventListener('click', () => {
    settlePinentry(true);
  });

  el.pinentryCancel.addEventListener('click', () => {
    settlePinentry(false);
  });

  el.pinentryDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    settlePinentry(false);
  });
}

function initDefaults() {
  el.gpgScriptUrl.value = new URL('../../../PLAY/wasm-prefix-browser/bin/gpg.js', import.meta.url).toString();
  el.gpgWasmUrl.value = new URL('../../../PLAY/wasm-prefix-browser/bin/gpg.wasm', import.meta.url).toString();
}

function main() {
  initDefaults();
  bindEvents();
  resetSession();
  appendConsole(
    'note',
    `[env] crossOriginIsolated=${String(self.crossOriginIsolated)} sharedArrayBuffer=${String(typeof SharedArrayBuffer !== 'undefined')}`
  );
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    appendConsole(
      'error',
      'browser is not cross-origin isolated; use scripts/wasm/demo/serve.py and hard refresh'
    );
  }
  appendConsole('note', 'ready; start with "Run --version" or "Generate Key"');
}

main();
