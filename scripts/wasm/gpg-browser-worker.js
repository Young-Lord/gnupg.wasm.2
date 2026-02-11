/* eslint-env worker */

const STATUS_PREFIX = '[GNUPG:]';
let runInProgress = false;
let pinentryCounter = 0;
const pendingPinentry = new Map();
const PINENTRY_TIMEOUT_MS = 120000;
const SUPPRESSED_DEBUG_STEPS = new Set([
  'run.finish',
  'run.callMain.return',
  'run.agent.heartbeat',
  'run.agent.write-chunk',
  'agent.finish',
  'agent.bridge.stdin',
  'agent.bridge.stdout',
  'agent.bridge.stdin.eagain',
  'agent.bridge.stdin.call',
  'agent.bridge.stdin.byte',
  'agent.bridge.stdout.byte',
]);

function postDebug(step, data) {
  if (!self.__gnupg_debug_enabled) {
    return;
  }
  if (SUPPRESSED_DEBUG_STEPS.has(step)) {
    return;
  }
  postMessage({
    type: 'debug',
    step,
    data: data && typeof data === 'object' ? data : { value: data },
  });
}

function postError(message) {
  postMessage({
    type: 'error',
    message,
  });
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function explainLauncherError(message) {
  if (/require is not defined/i.test(message)) {
    return `${message} (likely Node-target launcher; rebuild with scripts/wasm/build-gnupg-browser.sh and use PLAY/wasm-prefix-browser/bin/gpg.js)`;
  }
  if (/redeclaration of let ExitStatus/i.test(message)) {
    return `${message} (launcher loaded more than once in same Worker context)`;
  }
  return message;
}

function normalizeArgs(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item));
}

function normalizePath(pathValue, fallback) {
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

function normalizePersistRoots(value, fallback) {
  const roots = [];
  const seen = new Set();

  if (Array.isArray(value)) {
    for (const raw of value) {
      if (typeof raw !== 'string') {
        continue;
      }
      const path = normalizePath(raw, '/');
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      roots.push(path);
    }
  }

  if (!roots.length && Array.isArray(fallback)) {
    for (const raw of fallback) {
      if (typeof raw !== 'string') {
        continue;
      }
      const path = normalizePath(raw, '/');
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      roots.push(path);
    }
  }

  return roots;
}

function splitAtOptionTerminator(args) {
  const idx = args.indexOf('--');
  if (idx === -1) {
    return {
      optionsAndOperands: args.slice(),
      tail: [],
    };
  }
  return {
    optionsAndOperands: args.slice(0, idx),
    tail: args.slice(idx),
  };
}

function hasOption(args, optionName) {
  for (const arg of args) {
    if (arg === optionName || arg.startsWith(`${optionName}=`)) {
      return true;
    }
  }
  return false;
}

function removeOption(args, optionName, expectsValue) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === optionName) {
      if (expectsValue && i + 1 < args.length) {
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(`${optionName}=`)) {
      continue;
    }
    out.push(arg);
  }
  return out;
}

function hasAnyPassphraseOption(args) {
  return [
    '--passphrase',
    '--passphrase-file',
    '--passphrase-fd',
  ].some((name) => hasOption(args, name));
}

function includesAnyOption(args, optionNames) {
  for (const arg of args) {
    for (const optionName of optionNames) {
      if (arg === optionName || arg.startsWith(`${optionName}=`)) {
        return true;
      }
    }
  }
  return false;
}

function findOptionValue(args, optionNames) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    for (const optionName of optionNames) {
      if (arg === optionName) {
        return i + 1 < args.length ? args[i + 1] : '';
      }
      if (arg.startsWith(`${optionName}=`)) {
        return arg.slice(optionName.length + 1);
      }
    }
  }
  return '';
}

function inferPinentryOperation(args) {
  if (includesAnyOption(args, ['--quick-generate-key', '--quick-gen-key', '--generate-key', '--gen-key', '--full-generate-key'])) {
    return 'generate-key';
  }
  if (includesAnyOption(args, ['--sign', '--clearsign', '--detach-sign'])) {
    return 'sign';
  }
  if (includesAnyOption(args, ['--decrypt'])) {
    return 'decrypt';
  }
  if (includesAnyOption(args, ['--symmetric'])) {
    return 'symmetric';
  }
  return 'passphrase';
}

function inferPinentryHints(args, pinentryConfig) {
  const uidHint =
    (typeof pinentryConfig.uidHint === 'string' && pinentryConfig.uidHint)
      || findOptionValue(args, ['--local-user', '--default-key']);
  const keyHint =
    (typeof pinentryConfig.keyHint === 'string' && pinentryConfig.keyHint)
      || findOptionValue(args, ['--default-key', '--local-user']);
  return {
    op:
      (typeof pinentryConfig.op === 'string' && pinentryConfig.op)
      || inferPinentryOperation(args),
    uidHint: uidHint || '',
    keyHint: keyHint || '',
  };
}

function operationLikelyNeedsPinentry(args) {
  return includesAnyOption(args, [
    '--quick-generate-key',
    '--quick-gen-key',
    '--generate-key',
    '--gen-key',
    '--full-generate-key',
    '--quick-add-key',
    '--passwd',
    '--change-passphrase',
    '--sign',
    '--clearsign',
    '--detach-sign',
    '--symmetric',
    '--decrypt',
  ]);
}

function shouldRequestPinentry(args, pinentryConfig) {
  if (!pinentryConfig || pinentryConfig.enabled === false) {
    return false;
  }
  if (pinentryConfig.always === true) {
    return true;
  }
  return operationLikelyNeedsPinentry(args);
}

function pinentryRequestCount(args) {
  if (includesAnyOption(args, ['--symmetric'])) {
    return 2;
  }
  return 1;
}

function requestPinentry(args, pinentryConfig, overrides = null) {
  const id = `pinentry-${Date.now()}-${(pinentryCounter += 1)}`;
  const hints = inferPinentryHints(args, pinentryConfig);
  if (overrides && typeof overrides === 'object') {
    if (typeof overrides.op === 'string' && overrides.op) {
      hints.op = overrides.op;
    }
    if (typeof overrides.uidHint === 'string') {
      hints.uidHint = overrides.uidHint;
    }
    if (typeof overrides.keyHint === 'string') {
      hints.keyHint = overrides.keyHint;
    }
  }
  postDebug('run.pinentry.request', {
    id,
    op: hints.op,
    uidHint: hints.uidHint,
    keyHint: hints.keyHint,
  });
  postMessage({
    type: 'pinentry-request',
    id,
    op: hints.op,
    uidHint: hints.uidHint,
    keyHint: hints.keyHint,
  });

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingPinentry.delete(id);
      postDebug('run.pinentry.timeout', { id, timeoutMs: PINENTRY_TIMEOUT_MS });
      resolve({ ok: false, passphrase: '' });
    }, PINENTRY_TIMEOUT_MS);

    pendingPinentry.set(id, (value) => {
      clearTimeout(timeoutId);
      resolve(value);
    });
  });
}

function parentDirectory(pathValue) {
  const idx = pathValue.lastIndexOf('/');
  if (idx <= 0) {
    return '/';
  }
  return pathValue.slice(0, idx);
}

function ensureDirectory(FS, dirPath) {
  if (!dirPath || dirPath === '/') {
    return;
  }
  const parts = dirPath.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try {
      FS.mkdir(current);
    } catch {
      if (!FS.analyzePath(current).exists) {
        throw new Error(`unable to create directory: ${current}`);
      }
    }
  }
}

function writePassphraseFile(FS, filePath, passphrase) {
  ensureDirectory(FS, parentDirectory(filePath));
  FS.writeFile(filePath, `${passphrase}\n`);
  try {
    FS.chmod(filePath, 0o600);
  } catch {
    /* Best-effort permission fixup. */
  }
}

function scrubPassphraseFile(FS, filePath) {
  if (!filePath) {
    return;
  }
  try {
    if (FS.analyzePath(filePath).exists) {
      FS.writeFile(filePath, '\n');
      FS.unlink(filePath);
    }
  } catch {
    /* Best effort cleanup. */
  }
}

function normalizeMode(mode, fallback) {
  if (Number.isFinite(mode)) {
    return Number(mode) & 0o777;
  }
  return fallback;
}

function encodeBase64(bytes) {
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

function decodeBase64(base64Text) {
  if (!base64Text) {
    return new Uint8Array();
  }
  const binary = atob(base64Text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function restoreFsState(FS, state) {
  if (!state || typeof state !== 'object') {
    return;
  }

  const dirs = Array.isArray(state.dirs) ? state.dirs.slice() : [];
  dirs.sort((a, b) => String(a.path || '').length - String(b.path || '').length);

  for (const entry of dirs) {
    if (!entry || typeof entry.path !== 'string') {
      continue;
    }
    const path = normalizePath(entry.path, '/');
    ensureDirectory(FS, path);
    try {
      FS.chmod(path, normalizeMode(entry.mode, 0o700));
    } catch {
      /* Keep going even if chmod is unsupported. */
    }
  }

  const files = Array.isArray(state.files) ? state.files.slice() : [];
  files.sort((a, b) => String(a.path || '').length - String(b.path || '').length);

  for (const entry of files) {
    if (!entry || typeof entry.path !== 'string') {
      continue;
    }
    const path = normalizePath(entry.path, '/');
    ensureDirectory(FS, parentDirectory(path));
    const bytes = decodeBase64(typeof entry.data === 'string' ? entry.data : '');
    FS.writeFile(path, bytes);
    try {
      FS.chmod(path, normalizeMode(entry.mode, 0o600));
    } catch {
      /* Keep going even if chmod is unsupported. */
    }
  }
}

function captureFsState(FS, roots) {
  if (!FS || !roots.length) {
    return null;
  }

  const dirs = [];
  const files = [];
  const seen = new Set();

  const walk = (path) => {
    if (seen.has(path)) {
      return;
    }
    seen.add(path);

    const stat = FS.stat(path);
    if (FS.isDir(stat.mode)) {
      dirs.push({
        path,
        mode: normalizeMode(stat.mode, 0o700),
      });

      const names = FS.readdir(path);
      for (const name of names) {
        if (name === '.' || name === '..') {
          continue;
        }
        const child = path === '/' ? `/${name}` : `${path}/${name}`;
        walk(child);
      }
      return;
    }

    if (FS.isFile(stat.mode)) {
      const bytes = FS.readFile(path, { encoding: 'binary' });
      files.push({
        path,
        mode: normalizeMode(stat.mode, 0o600),
        data: encodeBase64(bytes),
      });
    }
  };

  for (const rootRaw of roots) {
    const root = normalizePath(rootRaw, '/');
    const info = FS.analyzePath(root);
    if (!info.exists) {
      continue;
    }
    walk(root);
  }

  dirs.sort((a, b) => a.path.localeCompare(b.path));
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    version: 1,
    roots: roots.slice(),
    dirs,
    files,
  };
}

function buildFinalArgs(inputArgs, options) {
  const { optionsAndOperands, tail } = splitAtOptionTerminator(inputArgs);
  let base = optionsAndOperands.slice();

  base = removeOption(base, '--batch', false);
  base = removeOption(base, '--no-tty', false);
  base = removeOption(base, '--pinentry-mode', true);
  base = removeOption(base, '--no-autostart', false);
  base = removeOption(base, '--homedir', true);
  if (options.emitStatus) {
    base = removeOption(base, '--status-fd', true);
  }

  const enforced = [];

  if (options.homedir) {
    enforced.push('--homedir', options.homedir);
  }

  enforced.push('--batch', '--no-tty', '--pinentry-mode', 'loopback', '--no-autostart');

  if (options.emitStatus) {
    enforced.push('--status-fd', '2');
  }

  if (options.passphraseFile && !hasAnyPassphraseOption(base)) {
    enforced.push('--passphrase-file', options.passphraseFile);
    if (!hasOption(base, '--passphrase-repeat')) {
      enforced.push('--passphrase-repeat', '0');
    }
  }

  return [...enforced, ...base, ...tail];
}

function emitS2kDebugFromStderr(text) {
  const line = String(text || '');
  if (!line.includes('[wasm-s2k]')) {
    return;
  }

  let match = line.match(/\[wasm-s2k\]\s+gpg\s+s2k-count\s+encoded=(\d+)\s+decoded=(\d+)\s+source=([^\s]+)/);
  if (match) {
    postDebug('run.s2k.actual', {
      encodedCount: Number.parseInt(match[1], 10),
      decodedCount: Number.parseInt(match[2], 10),
      source: String(match[3] || ''),
    });
    return;
  }

  match = line.match(/\[wasm-s2k\]\s+probe\s+calibrated\s+raw_count=(\d+)\s+effective_count=(\d+)\s+s2k_time_ms=(\d+)/);
  if (match) {
    postDebug('run.s2k.agent-probe', {
      rawCount: Number.parseInt(match[1], 10),
      effectiveCount: Number.parseInt(match[2], 10),
      s2kTimeMs: Number.parseInt(match[3], 10),
    });
    return;
  }

  match = line.match(/\[wasm-s2k\]\s+(enter|leave)\s+([a-zA-Z0-9_]+)/);
  if (match) {
    postDebug('run.s2k.agent-fn', {
      phase: String(match[1]),
      fn: String(match[2]),
      line,
    });
    return;
  }

  postDebug('run.s2k.raw-log', { line });
 }

function emitStderrAndStatus(line) {
  const text = String(line ?? '');
  emitS2kDebugFromStderr(text);
  if (self.__gnupg_stream_capture) {
    self.__gnupg_stream_capture.stderr.push(text);
    self.__gnupg_stream_capture.metrics.stderrLivePosted += 1;
  }
  postMessage({ type: 'stderr', data: text });

  const idx = text.indexOf(STATUS_PREFIX);
  if (idx === -1) {
    return;
  }
  const statusLine = text.slice(idx + STATUS_PREFIX.length).trimStart();
  if (self.__gnupg_stream_capture) {
    self.__gnupg_stream_capture.status.push(statusLine);
    self.__gnupg_stream_capture.metrics.statusLivePosted += 1;
  }
  postMessage({
    type: 'status',
    line: statusLine,
  });
}

function makeFsLineWriter(onLine, charMetricKey, flushMetricKey) {
  let pending = '';

  const emitPending = () => {
    if (!pending) {
      return;
    }
    if (self.__gnupg_stream_capture) {
      self.__gnupg_stream_capture.metrics[flushMetricKey] += 1;
    }
    onLine(pending);
    pending = '';
  };

  return {
    write(ch) {
      if (ch === null || ch === undefined) {
        emitPending();
        return;
      }

      if (ch === 10) {
        emitPending();
        return;
      }

      if (ch === 13 || ch === 0) {
        return;
      }

      if (self.__gnupg_stream_capture) {
        self.__gnupg_stream_capture.metrics[charMetricKey] += 1;
      }
      pending += String.fromCharCode(ch);
      if (pending.length > 4096) {
        emitPending();
      }
    },
    flush() {
      emitPending();
    },
  };
}

function getActiveFS() {
  if (self.FS) {
    return self.FS;
  }
  if (self.Module && self.Module.FS) {
    return self.Module.FS;
  }
  return null;
}

function mergeFsStates(baseState, overlayState) {
  if (!baseState && !overlayState) {
    return null;
  }
  if (!baseState) {
    return overlayState;
  }
  if (!overlayState) {
    return baseState;
  }

  const roots = [];
  const rootSeen = new Set();
  for (const raw of [...(baseState.roots || []), ...(overlayState.roots || [])]) {
    if (typeof raw !== 'string') {
      continue;
    }
    const path = normalizePath(raw, '/');
    if (rootSeen.has(path)) {
      continue;
    }
    rootSeen.add(path);
    roots.push(path);
  }

  const dirsMap = new Map();
  for (const entry of [...(baseState.dirs || []), ...(overlayState.dirs || [])]) {
    if (!entry || typeof entry.path !== 'string') {
      continue;
    }
    const path = normalizePath(entry.path, '/');
    dirsMap.set(path, {
      path,
      mode: normalizeMode(entry.mode, 0o700),
    });
  }

  const filesMap = new Map();
  for (const entry of [...(baseState.files || []), ...(overlayState.files || [])]) {
    if (!entry || typeof entry.path !== 'string') {
      continue;
    }
    const path = normalizePath(entry.path, '/');
    filesMap.set(path, {
      path,
      mode: normalizeMode(entry.mode, 0o600),
      data: typeof entry.data === 'string' ? entry.data : '',
    });
  }

  const dirs = Array.from(dirsMap.values()).sort((a, b) => a.path.localeCompare(b.path));
  const files = Array.from(filesMap.values()).sort((a, b) => a.path.localeCompare(b.path));

  return {
    version: 1,
    roots,
    dirs,
    files,
  };
}

function createSharedQueueDescriptor(size = 262144) {
  const normalizedSize = Number.isFinite(size) ? Math.max(1024, Number(size) | 0) : 262144;
  return {
    meta: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4),
    data: new SharedArrayBuffer(normalizedSize),
  };
}

function createSharedQueue(desc) {
  if (!desc || !desc.meta || !desc.data) {
    throw new Error('invalid shared queue descriptor');
  }
  return {
    ctrl: new Int32Array(desc.meta),
    data: new Uint8Array(desc.data),
  };
}

function summarizeQueue(queue) {
  const head = Atomics.load(queue.ctrl, 0);
  const tail = Atomics.load(queue.ctrl, 1);
  const closed = Atomics.load(queue.ctrl, 2) !== 0;
  const size = queue.data.length;
  const used = head >= tail ? head - tail : (size - tail) + head;
  return {
    head,
    tail,
    size,
    used,
    closed,
  };
}

function queueNotify(queue) {
  const { ctrl } = queue;
  Atomics.add(ctrl, 3, 1);
  Atomics.notify(ctrl, 3);
}

function queuePushByte(queue, byteValue, shouldBlock = true) {
  const { ctrl, data } = queue;
  const size = data.length;
  const value = Number(byteValue) & 0xff;

  while (true) {
    const head = Atomics.load(ctrl, 0);
    const tail = Atomics.load(ctrl, 1);
    const next = (head + 1) % size;
    if (next !== tail) {
      data[head] = value;
      Atomics.store(ctrl, 0, next);
      queueNotify(queue);
      return true;
    }
    if (Atomics.load(ctrl, 2) !== 0) {
      return false;
    }

    if (!shouldBlock) {
      return false;
    }

    const stamp = Atomics.load(ctrl, 3);
    Atomics.wait(ctrl, 3, stamp, 10);
  }
}

function queuePopByte(queue, shouldBlock = false) {
  const { ctrl, data } = queue;
  const size = data.length;

  while (true) {
    const head = Atomics.load(ctrl, 0);
    const tail = Atomics.load(ctrl, 1);

    if (tail !== head) {
      const value = data[tail];
      const next = (tail + 1) % size;
      Atomics.store(ctrl, 1, next);
      queueNotify(queue);
      return value;
    }

    if (Atomics.load(ctrl, 2) !== 0) {
      return null;
    }

    if (!shouldBlock) {
      return undefined;
    }

    const stamp = Atomics.load(ctrl, 3);
    Atomics.wait(ctrl, 3, stamp, 10);
  }
}

function queueClose(queue) {
  Atomics.store(queue.ctrl, 2, 1);
  queueNotify(queue);
}

function queueHasData(queue) {
  const head = Atomics.load(queue.ctrl, 0);
  const tail = Atomics.load(queue.ctrl, 1);
  return head !== tail;
}

function invokeCallMain(args) {
  if (typeof self.callMain === 'function') {
    return self.callMain(args);
  }
  if (self.Module && typeof self.Module.callMain === 'function') {
    return self.Module.callMain(args);
  }
  throw new Error('callMain is not available on global scope or Module');
}

async function importLauncherScript(scriptUrl) {
  const useFetchBlobPath = !/\.m?js(?:[?#].*)?$/i.test(scriptUrl);

  if (!useFetchBlobPath) {
    importScripts(scriptUrl);
    return;
  }

  let response;
  try {
    response = await fetch(scriptUrl, { credentials: 'same-origin' });
  } catch (fetchError) {
    throw new Error(`launcher fetch failed: ${formatError(fetchError)}`);
  }

  if (!response.ok) {
    throw new Error(`launcher fetch failed: ${response.status} ${response.statusText}`);
  }

  const source = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    importScripts(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function handleRun(message) {
  if (runInProgress) {
    postError('worker is already running a gpg invocation');
    return;
  }
  runInProgress = true;

  const args = normalizeArgs(message.args);
  const homedir = normalizePath(message.homedir, '/gnupg');
  const emitStatus = message.emitStatus !== false;
  const gpgScriptUrl = typeof message.gpgScriptUrl === 'string' ? message.gpgScriptUrl : '';
  const gpgWasmUrl = typeof message.gpgWasmUrl === 'string' ? message.gpgWasmUrl : '';
  const gpgAgentWorkerUrl = typeof message.gpgAgentWorkerUrl === 'string'
    ? message.gpgAgentWorkerUrl
    : new URL('./gpg-agent-server-worker.js', self.location.href).toString();
  let gpgAgentScriptUrl = typeof message.gpgAgentScriptUrl === 'string'
    ? message.gpgAgentScriptUrl
    : '';
  let gpgAgentWasmUrl = typeof message.gpgAgentWasmUrl === 'string'
    ? message.gpgAgentWasmUrl
    : '';

  if (!gpgAgentScriptUrl && gpgScriptUrl) {
    gpgAgentScriptUrl = gpgScriptUrl.replace(/gpg(?:\.js)?(?=(?:[?#].*)?$)/, 'gpg-agent.js');
  }
  if (!gpgAgentWasmUrl && gpgWasmUrl) {
    gpgAgentWasmUrl = gpgWasmUrl.replace(/gpg\.wasm(?=(?:[?#].*)?$)/, 'gpg-agent.wasm');
  }

  const debugEnabled = message.debug === true;
  self.__gnupg_debug_enabled = debugEnabled;
  const incomingFsState = message.fsState && typeof message.fsState === 'object'
    ? message.fsState
    : null;
  const streamCapture = {
    stdout: [],
    stderr: [],
    status: [],
    metrics: {
      modulePrintCalls: 0,
      modulePrintErrCalls: 0,
      stdoutLivePosted: 0,
      stderrLivePosted: 0,
      statusLivePosted: 0,
      fsStdoutChars: 0,
      fsStderrChars: 0,
      fsStdoutFlushes: 0,
      fsStderrFlushes: 0,
    },
  };
  self.__gnupg_stream_capture = streamCapture;
  let restoreConsole = () => {};
  if (debugEnabled && typeof console === 'object' && console) {
    const originalLog = typeof console.log === 'function' ? console.log.bind(console) : null;
    const originalError = typeof console.error === 'function' ? console.error.bind(console) : null;
    console.log = (...parts) => {
      postDebug('worker.console.log', {
        text: parts.map((part) => String(part)).join(' '),
      });
      if (originalLog) {
        originalLog(...parts);
      }
    };
    console.error = (...parts) => {
      postDebug('worker.console.error', {
        text: parts.map((part) => String(part)).join(' '),
      });
      if (originalError) {
        originalError(...parts);
      }
    };
    restoreConsole = () => {
      if (originalLog) {
        console.log = originalLog;
      }
      if (originalError) {
        console.error = originalError;
      }
    };
  }
  postDebug('run.begin', {
    args,
    homedir,
    emitStatus,
    gpgScriptUrl,
    gpgWasmUrl,
    gpgAgentWorkerUrl,
    gpgAgentScriptUrl,
    gpgAgentWasmUrl,
    crossOriginIsolated: Boolean(self.crossOriginIsolated),
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  });

  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    emitStderrAndStatus(
      '[wasm] warning: browser is not cross-origin isolated; pthread-enabled builds may fail (serve with COOP/COEP headers)'
    );
    postDebug('run.cross-origin-isolation', {
      crossOriginIsolated: Boolean(self.crossOriginIsolated),
      hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    });
  }

  let gpgScriptDir = '';
  if (gpgScriptUrl) {
    try {
      gpgScriptDir = new URL('.', gpgScriptUrl).toString();
    } catch {
      gpgScriptDir = '';
    }
  }

  let persistRoots = normalizePersistRoots(
    message.persistRoots,
    incomingFsState && Array.isArray(incomingFsState.roots) ? incomingFsState.roots : []
  );
  if (!persistRoots.includes(homedir)) {
    persistRoots.push(homedir);
  }
  persistRoots = normalizePersistRoots(persistRoots, [homedir]);
  postDebug('run.persist-roots', {
    persistRoots,
    incomingStateRoots: incomingFsState && Array.isArray(incomingFsState.roots)
      ? incomingFsState.roots
      : [],
  });

  if (!gpgScriptUrl) {
    postError('missing gpgScriptUrl for wasm launcher');
    postDebug('run.abort', { reason: 'missing gpgScriptUrl' });
    postMessage({
      type: 'result',
      exitCode: 2,
      fsState: incomingFsState,
      stdoutLines: streamCapture.stdout,
      stderrLines: streamCapture.stderr,
      statusLines: streamCapture.status,
      debugInfo: {
        phase: 'missing-script-url',
        args,
        homedir,
        gpgScriptUrl,
        gpgWasmUrl,
        persistRoots,
        streamMetrics: { ...streamCapture.metrics },
      },
    });
    restoreConsole();
    delete self.__gnupg_stream_capture;
    delete self.__gnupg_debug_enabled;
    self.close();
    runInProgress = false;
    return;
  }

  const pinentryConfig =
    message.pinentry && typeof message.pinentry === 'object'
      ? message.pinentry
      : null;

  let passphraseFile = '';
  let passphraseValue = '';
  const stdoutWriter = makeFsLineWriter((line) => {
    streamCapture.stdout.push(line);
    streamCapture.metrics.stdoutLivePosted += 1;
    postMessage({ type: 'stdout', data: line });
  }, 'fsStdoutChars', 'fsStdoutFlushes');
  const stderrWriter = makeFsLineWriter((line) => {
    emitStderrAndStatus(line);
  }, 'fsStderrChars', 'fsStderrFlushes');

  const enableAgentBridge = message.enableAgentBridge !== false;
  const sharedAgentBridge =
    message.sharedAgentBridge && typeof message.sharedAgentBridge === 'object'
      ? message.sharedAgentBridge
      : null;
  let agentBridge = null;
  let agentHeartbeatId = null;

  const createAgentBridge = () => {
    const worker = new Worker(gpgAgentWorkerUrl);
    let agentDone = false;
    let agentReady = false;
    let resolveResult;
    let rejectResult;
    const resultPromise = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const gpgToAgentDesc = createSharedQueueDescriptor();
    const agentToGpgDesc = createSharedQueueDescriptor();
    const gpgToAgent = {
      ctrl: new Int32Array(gpgToAgentDesc.meta),
      data: new Uint8Array(gpgToAgentDesc.data),
    };
    const agentToGpg = {
      ctrl: new Int32Array(agentToGpgDesc.meta),
      data: new Uint8Array(agentToGpgDesc.data),
    };
    const bridgeMetrics = {
      gpgWriteBytes: 0,
      gpgReadBytes: 0,
      gpgWritePreview: [],
      gpgReadPreview: [],
      lastWriteAt: 0,
      lastReadAt: 0,
    };
    const readableHandlers = [];
    let readableWatcherId = null;
    let lastReadableState = false;
    let lastClosedState = false;

    const pushPreview = (list, value) => {
      if (list.length < 32) {
        list.push(Number(value) & 0xff);
      }
    };

    const notifyReadableHandlers = (mask) => {
      while (readableHandlers.length > 0) {
        const handler = readableHandlers.shift();
        try {
          handler(mask);
        } catch {
          /* Ignore callback failures from runtime polling layer. */
        }
      }
    };

    const ensureReadableWatcher = () => {
      if (readableWatcherId !== null) {
        return;
      }
      readableWatcherId = setInterval(() => {
        const hasData = queueHasData(agentToGpg);
        const closed = Atomics.load(agentToGpg.ctrl, 2) !== 0;
        const becameReadable = hasData && !lastReadableState;
        const becameClosed = closed && !lastClosedState;
        lastReadableState = hasData;
        lastClosedState = closed;
        if (becameReadable || becameClosed) {
          const POLLIN = 0x001;
          const POLLHUP = 0x010;
          let mask = 0;
          if (hasData) {
            mask |= POLLIN;
          }
          if (closed) {
            mask |= POLLHUP;
          }
          if (mask !== 0) {
            notifyReadableHandlers(mask);
          }
        }
      }, 10);
    };

    worker.addEventListener('message', (event) => {
      const messageData = event.data;
      if (!messageData || typeof messageData !== 'object') {
        return;
      }

      if (messageData.type === 'debug') {
        postDebug(`agent.${messageData.step || 'unknown'}`, messageData.data || null);
        return;
      }

      if (messageData.type === 'ready') {
        agentReady = true;
        resolveReady(true);
        postDebug('agent.ready', {});
        return;
      }

      if (messageData.type === 'error') {
        emitStderrAndStatus(`[agent] ${messageData.message || 'unknown worker error'}`);
        return;
      }

      if (messageData.type === 'result') {
        agentDone = true;
        resolveResult(messageData);
        if (!agentReady) {
          resolveReady(false);
        }
      }
    });

    worker.addEventListener('error', (event) => {
      const messageText = event && event.message ? event.message : 'agent worker failed';
      rejectResult(new Error(messageText));
      rejectReady(new Error(messageText));
    });

    worker.postMessage({
      type: 'start',
      gpgAgentScriptUrl,
      gpgAgentWasmUrl,
      homedir,
      fsState: incomingFsState,
      persistRoots,
      bridge: {
        gpgToAgent: gpgToAgentDesc,
        agentToGpg: agentToGpgDesc,
      },
    });

    const recordRead = (value) => {
      if (value === null || value === undefined) {
        return value;
      }
      bridgeMetrics.gpgReadBytes += 1;
      bridgeMetrics.lastReadAt = Date.now();
      pushPreview(bridgeMetrics.gpgReadPreview, value);
      return value;
    };

    return {
      readByte(shouldBlock = true) {
        const value = queuePopByte(agentToGpg, shouldBlock);
        return recordRead(value);
      },
      readAvailableByte() {
        const value = queuePopByte(agentToGpg, false);
        return recordRead(value);
      },
      hasReadableData() {
        return queueHasData(agentToGpg);
      },
      isReadableClosed() {
        return Atomics.load(agentToGpg.ctrl, 2) !== 0;
      },
      registerReadableHandler(callback) {
        if (typeof callback !== 'function') {
          return;
        }
        readableHandlers.push(callback);
        ensureReadableWatcher();
      },
      writeByte(ch) {
        if (ch === null || ch === undefined) {
          return;
        }
        bridgeMetrics.gpgWriteBytes += 1;
        bridgeMetrics.lastWriteAt = Date.now();
        pushPreview(bridgeMetrics.gpgWritePreview, ch);
        if (!queuePushByte(gpgToAgent, ch, true)) {
          emitStderrAndStatus('[agent] bridge queue is full/closed while writing');
          postDebug('run.agent.write-failed', {
            byte: Number(ch) & 0xff,
            gpgToAgent: summarizeQueue(gpgToAgent),
          });
        }
      },
      getStats() {
        return {
          ...bridgeMetrics,
          gpgToAgent: summarizeQueue(gpgToAgent),
          agentToGpg: summarizeQueue(agentToGpg),
        };
      },
      async awaitReady(timeoutMs) {
        let timeoutId = null;
        const timeoutPromise = new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve(false), timeoutMs);
        });
        try {
          const ready = await Promise.race([readyPromise, timeoutPromise]);
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          return Boolean(ready);
        } catch {
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          return false;
        }
      },
      async shutdownAndWait(timeoutMs) {
        if (!agentDone) {
          for (const byteValue of [66, 89, 69, 10]) {
            queuePushByte(gpgToAgent, byteValue, false);
          }
        }
        queueClose(gpgToAgent);

        let timeoutId = null;
        const timeoutPromise = new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve(null), timeoutMs);
        });

        try {
          const result = await Promise.race([resultPromise, timeoutPromise]);
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          return result;
        } catch (error) {
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          postDebug('run.agent.shutdown.error', {
            error: formatError(error),
          });
          return null;
        } finally {
          if (readableWatcherId !== null) {
            clearInterval(readableWatcherId);
            readableWatcherId = null;
          }
          postDebug('run.agent.shutdown.finalize', {
            agentDone,
            agentReady,
            bridgeMetrics,
            gpgToAgent: summarizeQueue(gpgToAgent),
            agentToGpg: summarizeQueue(agentToGpg),
          });
          queueClose(agentToGpg);
          worker.terminate();
        }
      },
    };
  };

  const createExternalAgentBridge = (bridgeDesc) => {
    const gpgToAgent = createSharedQueue(bridgeDesc.gpgToAgent);
    const agentToGpg = createSharedQueue(bridgeDesc.agentToGpg);
    const bridgeMetrics = {
      gpgWriteBytes: 0,
      gpgReadBytes: 0,
      gpgWritePreview: [],
      gpgReadPreview: [],
      lastWriteAt: 0,
      lastReadAt: 0,
    };
    const readableHandlers = [];
    let readableWatcherId = null;
    let lastReadableState = false;
    let lastClosedState = false;
    let didCloseWriteQueue = false;

    const pushPreview = (list, value) => {
      if (list.length < 32) {
        list.push(Number(value) & 0xff);
      }
    };

    const notifyReadableHandlers = (mask) => {
      while (readableHandlers.length > 0) {
        const handler = readableHandlers.shift();
        try {
          handler(mask);
        } catch {
          /* Ignore callback failures from runtime polling layer. */
        }
      }
    };

    const ensureReadableWatcher = () => {
      if (readableWatcherId !== null) {
        return;
      }
      readableWatcherId = setInterval(() => {
        const hasData = queueHasData(agentToGpg);
        const closed = Atomics.load(agentToGpg.ctrl, 2) !== 0;
        const becameReadable = hasData && !lastReadableState;
        const becameClosed = closed && !lastClosedState;
        lastReadableState = hasData;
        lastClosedState = closed;
        if (becameReadable || becameClosed) {
          const POLLIN = 0x001;
          const POLLHUP = 0x010;
          let mask = 0;
          if (hasData) {
            mask |= POLLIN;
          }
          if (closed) {
            mask |= POLLHUP;
          }
          if (mask !== 0) {
            notifyReadableHandlers(mask);
          }
        }
      }, 10);
    };

    const recordRead = (value) => {
      if (value === null || value === undefined) {
        return value;
      }
      bridgeMetrics.gpgReadBytes += 1;
      bridgeMetrics.lastReadAt = Date.now();
      pushPreview(bridgeMetrics.gpgReadPreview, value);
      return value;
    };

    return {
      externalMode: true,
      readByte(shouldBlock = true) {
        const value = queuePopByte(agentToGpg, shouldBlock);
        return recordRead(value);
      },
      readAvailableByte() {
        const value = queuePopByte(agentToGpg, false);
        return recordRead(value);
      },
      hasReadableData() {
        return queueHasData(agentToGpg);
      },
      isReadableClosed() {
        return Atomics.load(agentToGpg.ctrl, 2) !== 0;
      },
      registerReadableHandler(callback) {
        if (typeof callback !== 'function') {
          return;
        }
        readableHandlers.push(callback);
        ensureReadableWatcher();
      },
      writeByte(ch) {
        if (ch === null || ch === undefined) {
          return;
        }
        bridgeMetrics.gpgWriteBytes += 1;
        bridgeMetrics.lastWriteAt = Date.now();
        pushPreview(bridgeMetrics.gpgWritePreview, ch);
        if (!queuePushByte(gpgToAgent, ch, true)) {
          emitStderrAndStatus('[agent] bridge queue is full/closed while writing');
          postDebug('run.agent.write-failed', {
            byte: Number(ch) & 0xff,
            gpgToAgent: summarizeQueue(gpgToAgent),
          });
        }
      },
      getStats() {
        return {
          ...bridgeMetrics,
          gpgToAgent: summarizeQueue(gpgToAgent),
          agentToGpg: summarizeQueue(agentToGpg),
        };
      },
      async awaitReady() {
        return true;
      },
      async shutdownAndWait() {
        if (!didCloseWriteQueue) {
          didCloseWriteQueue = true;
          for (const byteValue of [66, 89, 69, 10]) {
            queuePushByte(gpgToAgent, byteValue, false);
          }
          queueClose(gpgToAgent);
        }

        if (readableWatcherId !== null) {
          clearInterval(readableWatcherId);
          readableWatcherId = null;
        }

        postDebug('run.agent.external.shutdown', {
          bridgeMetrics,
          gpgToAgent: summarizeQueue(gpgToAgent),
          agentToGpg: summarizeQueue(agentToGpg),
        });
        return {
          external: true,
        };
      },
    };
  };

  if (shouldRequestPinentry(args, pinentryConfig)) {
    postDebug('run.pinentry.await', {
      mode: pinentryConfig && pinentryConfig.always === true ? 'always' : 'heuristic',
    });
    const responses = [];
    const requestCount = pinentryRequestCount(args);
    for (let i = 0; i < requestCount; i += 1) {
      const response = await requestPinentry(args, pinentryConfig, requestCount > 1
        ? { op: i === 0 ? 'symmetric-passphrase' : 'symmetric-confirm' }
        : null);
      responses.push(response);
    }
    const response = responses[0] || { ok: false, passphrase: '' };
    postDebug('run.pinentry.response', {
      ok: Boolean(response && response.ok === true),
      hasPassphrase: Boolean(response && typeof response.passphrase === 'string' && response.passphrase.length > 0),
      responses: responses.length,
    });
    const ok = responses.every((item) => item && item.ok === true);
    if (!ok) {
      emitStderrAndStatus('[wasm] pinentry was cancelled by user callback');
      postDebug('run.pinentry-cancelled', {});
      postMessage({
        type: 'result',
        exitCode: 1,
        fsState: incomingFsState,
        stdoutLines: streamCapture.stdout,
        stderrLines: streamCapture.stderr,
        statusLines: streamCapture.status,
        debugInfo: {
          phase: 'pinentry-cancelled',
          args,
          homedir,
          gpgScriptUrl,
          gpgWasmUrl,
          persistRoots,
          streamMetrics: { ...streamCapture.metrics },
        },
      });
      restoreConsole();
      delete self.__gnupg_stream_capture;
      delete self.__gnupg_debug_enabled;
      self.close();
      runInProgress = false;
      return;
    }

    if (responses.length > 1) {
      const first = typeof responses[0].passphrase === 'string'
        ? responses[0].passphrase
        : String(responses[0].passphrase ?? '');
      const second = typeof responses[1].passphrase === 'string'
        ? responses[1].passphrase
        : String(responses[1].passphrase ?? '');
      if (first !== second) {
        emitStderrAndStatus('[wasm] pinentry mismatch: passphrase confirmation does not match');
        postMessage({
          type: 'result',
          exitCode: 1,
          fsState: incomingFsState,
          stdoutLines: streamCapture.stdout,
          stderrLines: streamCapture.stderr,
          statusLines: streamCapture.status,
          debugInfo: {
            phase: 'pinentry-mismatch',
            args,
            homedir,
            gpgScriptUrl,
            gpgWasmUrl,
            persistRoots,
            streamMetrics: { ...streamCapture.metrics },
          },
        });
        restoreConsole();
        delete self.__gnupg_stream_capture;
        delete self.__gnupg_debug_enabled;
        self.close();
        runInProgress = false;
        return;
      }
    }

    passphraseValue = typeof response.passphrase === 'string'
      ? response.passphrase
      : String(response.passphrase ?? '');
    passphraseFile = `/tmp/.gnupg-pinentry-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}.txt`;
  }

  if (enableAgentBridge) {
    if (sharedAgentBridge) {
      postDebug('run.agent.start', {
        mode: 'external',
      });
      try {
        agentBridge = createExternalAgentBridge(sharedAgentBridge);
      } catch (error) {
        postError(`failed to bind external agent bridge: ${formatError(error)}`);
      }
    } else if (!gpgAgentScriptUrl) {
      emitStderrAndStatus('[wasm] warning: gpg-agent bridge requested but gpgAgentScriptUrl is missing');
    } else {
      postDebug('run.agent.start', {
        mode: 'spawn',
        gpgAgentWorkerUrl,
        gpgAgentScriptUrl,
        gpgAgentWasmUrl,
      });
      agentBridge = createAgentBridge();
    }

    if (agentBridge) {
      const agentReady = await agentBridge.awaitReady(12000);
      postDebug('run.agent.ready', {
        agentReady,
        external: agentBridge.externalMode === true,
      });
      if (!agentReady) {
        emitStderrAndStatus('[agent] worker did not report ready within timeout');
      }
      agentHeartbeatId = setInterval(() => {
        if (!agentBridge) {
          return;
        }
        postDebug('run.agent.heartbeat', agentBridge.getStats());
      }, 2000);
    }
  }

  const finalArgs = buildFinalArgs(args, {
    homedir,
    emitStatus,
    passphraseFile,
  });
  postDebug('run.final-args', { finalArgs });
  const runTimeoutMs = Number.isFinite(message.runTimeoutMs)
    ? Number(message.runTimeoutMs)
    : 120000;

  let didFinish = false;
  let resolveRunCompletion;
  const runCompletion = new Promise((resolve) => {
    resolveRunCompletion = resolve;
  });
  let runTimeoutId = null;
  const buildDebugInfo = (phase, extra) => ({
    phase,
    args,
    finalArgs,
    homedir,
    emitStatus,
    gpgScriptUrl,
    gpgWasmUrl,
    gpgAgentWorkerUrl,
    gpgAgentScriptUrl,
    gpgAgentWasmUrl,
    enableAgentBridge,
    agentBridgeActive: Boolean(agentBridge),
    persistRoots,
    streamMetrics: { ...streamCapture.metrics },
    streamLengths: {
      stdout: streamCapture.stdout.length,
      stderr: streamCapture.stderr.length,
      status: streamCapture.status.length,
    },
    ...(extra && typeof extra === 'object' ? extra : {}),
  });

  const clearRunTimeout = () => {
    if (runTimeoutId !== null) {
      clearTimeout(runTimeoutId);
      runTimeoutId = null;
    }
  };

  const captureState = () => {
    if (!persistRoots.length) {
      return incomingFsState;
    }
    try {
      const fs = getActiveFS();
      if (fs) {
        return captureFsState(fs, persistRoots);
      }
      postDebug('run.capture.fs-missing', {
        hasGlobalFS: Boolean(self.FS),
        hasModuleFS: Boolean(self.Module && self.Module.FS),
      });
    } catch (error) {
      postError(`failed to capture fs state: ${formatError(error)}`);
    }
    return incomingFsState;
  };

  const finish = (exitCode) => {
    if (didFinish) {
      return;
    }
    clearRunTimeout();
    if (agentHeartbeatId !== null) {
      clearInterval(agentHeartbeatId);
      agentHeartbeatId = null;
    }
    stdoutWriter.flush();
    stderrWriter.flush();
    didFinish = true;

    const postResult = async () => {
      let capturedState = captureState();
      const agentInfo = {
        enabled: enableAgentBridge,
        active: Boolean(agentBridge),
        merged: false,
        timeout: false,
        exitCode: null,
        error: '',
      };

      if (agentBridge) {
        const agentResult = await agentBridge.shutdownAndWait(2500);
        if (agentResult && typeof agentResult === 'object') {
          if (agentResult.external === true) {
            agentInfo.external = true;
          }
          if (Number.isFinite(agentResult.exitCode)) {
            agentInfo.exitCode = Number(agentResult.exitCode);
          }
          if (typeof agentResult.error === 'string' && agentResult.error) {
            agentInfo.error = agentResult.error;
            emitStderrAndStatus(`[agent] ${agentResult.error}`);
          }
          if (typeof agentResult.stderr === 'string' && agentResult.stderr.trim()) {
            emitStderrAndStatus(`[agent] ${agentResult.stderr.trimEnd()}`);
          }
          if (agentResult.external !== true && agentResult.fsState && typeof agentResult.fsState === 'object') {
            capturedState = mergeFsStates(capturedState, agentResult.fsState);
            agentInfo.merged = true;
          }
        } else {
          agentInfo.timeout = true;
          emitStderrAndStatus('[agent] shutdown timed out; proceeding with gpg-side fs state only');
        }
      }

      const fsStateStats = capturedState && typeof capturedState === 'object'
        ? {
            roots: Array.isArray(capturedState.roots) ? capturedState.roots.length : 0,
            dirs: Array.isArray(capturedState.dirs) ? capturedState.dirs.length : 0,
            files: Array.isArray(capturedState.files) ? capturedState.files.length : 0,
            homedirFiles: Array.isArray(capturedState.files)
              ? capturedState.files.filter((entry) => entry && typeof entry.path === 'string' && entry.path.startsWith(`${homedir}/`)).length
              : 0,
          }
        : null;

      const debugInfo = buildDebugInfo('finished', {
        exitCode: Number.isFinite(exitCode) ? exitCode : 1,
        fsStateStats,
        agentInfo,
      });
      postDebug('run.finish', debugInfo);
      postMessage({
        type: 'result',
        exitCode: Number.isFinite(exitCode) ? exitCode : 1,
        fsState: capturedState,
        stdoutLines: streamCapture.stdout,
        stderrLines: streamCapture.stderr,
        statusLines: streamCapture.status,
        debugInfo,
      });
      setTimeout(() => {
        self.close();
      }, 0);
      if (resolveRunCompletion) {
        resolveRunCompletion();
      }
    };

    void postResult();
  };

  const cleanupSecrets = () => {
    if (!passphraseFile) {
      return;
    }
    try {
      const fs = getActiveFS();
      if (fs) {
        scrubPassphraseFile(fs, passphraseFile);
      }
    } catch {
      /* Ignore cleanup errors. */
    }
    passphraseValue = '';
    passphraseFile = '';
  };

  const handleGlobalError = (event) => {
    const reason = formatError(
      event && (event.error || event.reason || event.message || event)
    );
    postError(`worker uncaught error: ${reason}`);
    postDebug('run.global-error', {
      reason,
      message: event && event.message ? String(event.message) : '',
    });
    cleanupSecrets();
    if (!didFinish) {
      finish(1);
    }
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  };

  const handleUnhandledRejection = (event) => {
    const reason = formatError(event && event.reason ? event.reason : event);
    postError(`worker unhandled rejection: ${reason}`);
    postDebug('run.unhandled-rejection', { reason });
    cleanupSecrets();
    if (!didFinish) {
      finish(1);
    }
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  };

  self.addEventListener('error', handleGlobalError);
  self.addEventListener('unhandledrejection', handleUnhandledRejection);

  self.Module = {
    arguments: finalArgs,
    noInitialRun: true,
    mainScriptUrlOrBlob: gpgScriptUrl,
    print: (line) => {
      const text = String(line ?? '');
      streamCapture.metrics.modulePrintCalls += 1;
      streamCapture.stdout.push(text);
      streamCapture.metrics.stdoutLivePosted += 1;
      postMessage({ type: 'stdout', data: text });
    },
    printErr: (line) => {
      streamCapture.metrics.modulePrintErrCalls += 1;
      emitStderrAndStatus(line);
    },
    locateFile: (fileName, scriptDirectory) => {
      if (gpgWasmUrl && fileName.endsWith('.wasm')) {
        return gpgWasmUrl;
      }
      if (gpgScriptDir) {
        return `${gpgScriptDir}${fileName}`;
      }
      return `${scriptDirectory}${fileName}`;
    },
    onRuntimeInitialized: () => {
      postDebug('run.runtime-initialized', {
        hasGlobalCallMain: typeof self.callMain === 'function',
        hasModuleCallMain: Boolean(self.Module && typeof self.Module.callMain === 'function'),
      });

      if (didFinish) {
        return;
      }

      try {
        const rc = invokeCallMain(finalArgs.slice());
        postDebug('run.callMain.return', { rc });
        cleanupSecrets();
        finish(Number.isFinite(rc) ? rc : 0);
      } catch (error) {
        postDebug('run.callMain.error', {
          error: formatError(error),
          status: error && typeof error === 'object' && Number.isFinite(error.status)
            ? Number(error.status)
            : null,
        });
        cleanupSecrets();
        if (!didFinish && error && typeof error === 'object' && Number.isFinite(error.status)) {
          finish(Number(error.status));
        } else if (!didFinish) {
          postError(`callMain failed: ${formatError(error)}`);
          finish(1);
        }
      }
    },
    preRun: [
      () => {
        const FS = getActiveFS();
        if (!FS || typeof FS.init !== 'function') {
          postDebug('run.preRun.fs-missing', {
            hasGlobalFS: Boolean(self.FS),
            hasModuleFS: Boolean(self.Module && self.Module.FS),
          });
          return;
        }

        FS.init(
          () => null,
          (ch) => stdoutWriter.write(ch),
          (ch) => stderrWriter.write(ch)
        );
        postDebug('run.preRun.fs-init', {
          hasIncomingFsState: Boolean(incomingFsState),
          persistRoots,
        });

        if (incomingFsState) {
          restoreFsState(FS, incomingFsState);
        }

        const envObj = self.ENV || (self.Module && self.Module.ENV);
        if (envObj && debugEnabled) {
          envObj.GNUPG_WASM_TRACE = '1';
        }
        if (agentBridge && envObj) {
          const devName = `gnupg-agent-bridge-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
          const devPath = `/dev/${devName}`;
          try {
            if (!FS.registerDevice || !FS.mkdev || !FS.makedev) {
              throw new Error('FS device registration APIs are unavailable');
            }

            const major = 64;
            const minor = (Date.now() % 200) + Math.floor(Math.random() * 50);
            const dev = FS.makedev(major, minor);
            const POLLIN = 0x001;
            const POLLOUT = 0x004;
            const POLLHUP = 0x010;
            const errnoCodes = self.ERRNO_CODES || (self.Module && self.Module.ERRNO_CODES) || null;
            const EAGAIN = errnoCodes && Number.isFinite(errnoCodes.EAGAIN)
              ? Number(errnoCodes.EAGAIN)
              : 6;
            let bridgeReadCalls = 0;
            let bridgeWriteCalls = 0;
            let bridgePollCalls = 0;
            let bridgeWriteLoggedCalls = 0;
            let bridgeLastReadLogAt = 0;
            let bridgeLastWriteLogAt = 0;
            let bridgeLastPollLogAt = 0;

            FS.registerDevice(dev, {
              read(stream, buffer, offset, length) {
                bridgeReadCalls += 1;
                let count = 0;
                while (count < length) {
                  const byteValue = agentBridge.readAvailableByte();

                  if (byteValue === undefined) {
                    break;
                  }
                  if (byteValue === null || byteValue === undefined) {
                    break;
                  }
                  buffer[offset + count] = byteValue;
                  count += 1;

                  if (!agentBridge.hasReadableData()) {
                    break;
                  }
                }

                if (count === 0 && !agentBridge.isReadableClosed()) {
                  const now = Date.now();
                  if (debugEnabled && now - bridgeLastReadLogAt > 1500) {
                    bridgeLastReadLogAt = now;
                    emitStderrAndStatus(`[agent-bridge] read->EAGAIN calls=${bridgeReadCalls}`);
                  }
                  throw new FS.ErrnoError(EAGAIN);
                }
                if (debugEnabled && count > 0) {
                  const now = Date.now();
                  if (now - bridgeLastReadLogAt > 1500) {
                    bridgeLastReadLogAt = now;
                    emitStderrAndStatus(`[agent-bridge] read bytes=${count} calls=${bridgeReadCalls}`);
                  }
                }
                return count;
              },
              write(stream, buffer, offset, length) {
                bridgeWriteCalls += 1;
                let count = 0;
                const firstBytes = [];
                while (count < length) {
                  const byteValue = buffer[offset + count];
                  if (firstBytes.length < 64) {
                    firstBytes.push(Number(byteValue) & 0xff);
                  }
                  agentBridge.writeByte(byteValue);
                  count += 1;
                }
                if (debugEnabled && bridgeWriteLoggedCalls < 12) {
                  bridgeWriteLoggedCalls += 1;
                  const hasLf = firstBytes.includes(10);
                  const ascii = String.fromCharCode(...firstBytes.map((v) => (v >= 32 && v <= 126 ? v : 46)));
                  const stats = agentBridge.getStats();
                  postDebug('run.agent.write-chunk', {
                    call: bridgeWriteCalls,
                    bytes: count,
                    hasLf,
                    preview: firstBytes,
                    ascii,
                    queue: stats.gpgToAgent,
                  });
                }
                if (debugEnabled) {
                  const now = Date.now();
                  if (now - bridgeLastWriteLogAt > 1500) {
                    bridgeLastWriteLogAt = now;
                    emitStderrAndStatus(`[agent-bridge] write bytes=${count} calls=${bridgeWriteCalls}`);
                  }
                }
                return count;
              },
              poll(stream, timeout, notifyCallback) {
                bridgePollCalls += 1;
                let mask = POLLOUT;
                if (agentBridge.hasReadableData()) {
                  mask |= POLLIN;
                }
                if (agentBridge.isReadableClosed()) {
                  mask |= POLLHUP;
                }
                if (mask === POLLOUT && typeof notifyCallback === 'function') {
                  agentBridge.registerReadableHandler(notifyCallback);
                }
                if (debugEnabled) {
                  const now = Date.now();
                  if (now - bridgeLastPollLogAt > 1500) {
                    bridgeLastPollLogAt = now;
                    emitStderrAndStatus(`[agent-bridge] poll mask=${mask} calls=${bridgePollCalls}`);
                  }
                }
                return mask;
              },
            });

            FS.mkdev(devPath, 0o600, dev);
            const stream = FS.open(devPath, 'r+');
            envObj.GNUPG_WASM_AGENT_FD = String(stream.fd);
            postDebug('run.preRun.agent-fd', {
              devPath,
              fd: stream.fd,
            });
          } catch (error) {
            postError(`failed to create agent bridge fd: ${formatError(error)}`);
          }
        } else if (agentBridge && !envObj) {
          postError('agent bridge requested but ENV object is unavailable in runtime');
        } else if (envObj && envObj.GNUPG_WASM_AGENT_FD) {
          delete envObj.GNUPG_WASM_AGENT_FD;
        }

        for (const root of persistRoots) {
          ensureDirectory(FS, root);
        }
        ensureDirectory(FS, homedir);

        try {
          FS.chmod(homedir, 0o700);
        } catch {
          /* Best-effort permission fixup. */
        }
        if (passphraseFile) {
          writePassphraseFile(FS, passphraseFile, passphraseValue);
        }
      },
    ],
    onExit: (code) => {
      cleanupSecrets();
      finish(code);
    },
    onAbort: (why) => {
      postError(`wasm runtime aborted: ${formatError(why)}`);
      postDebug('run.onAbort', { why: formatError(why) });
      cleanupSecrets();
      if (!didFinish) {
        finish(1);
      }
    },
  };

  try {
    if (runTimeoutMs > 0) {
      runTimeoutId = setTimeout(() => {
        postError(`wasm gpg timed out after ${runTimeoutMs}ms`);
        postDebug('run.timeout', { runTimeoutMs });
        cleanupSecrets();
        finish(124);
      }, runTimeoutMs);
    }

    postDebug('run.import-launcher.start', { gpgScriptUrl });
    await importLauncherScript(gpgScriptUrl);
    postDebug('run.import-launcher.done', {});
    postDebug('run.await-completion', { runTimeoutMs });
    await runCompletion;
  } catch (error) {
    cleanupSecrets();
    postDebug('run.import-launcher.error', {
      error: formatError(error),
    });

    if (!didFinish && error && typeof error === 'object' && Number.isFinite(error.status)) {
      finish(Number(error.status));
    } else if (!didFinish) {
      postError(`failed to run wasm gpg: ${explainLauncherError(formatError(error))}`);
      finish(1);
    }
  } finally {
    clearRunTimeout();
    if (agentHeartbeatId !== null) {
      clearInterval(agentHeartbeatId);
      agentHeartbeatId = null;
    }
    if (agentBridge && !didFinish) {
      void agentBridge.shutdownAndWait(300).catch(() => null);
    }
    self.removeEventListener('error', handleGlobalError);
    self.removeEventListener('unhandledrejection', handleUnhandledRejection);
    restoreConsole();
    delete self.__gnupg_stream_capture;
    delete self.__gnupg_debug_enabled;
    for (const resolve of pendingPinentry.values()) {
      resolve({ ok: false, passphrase: '' });
    }
    pendingPinentry.clear();
    runInProgress = false;
  }
}

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'pinentry-response') {
    postDebug('run.pinentry.response-message', {
      id: message.id,
      ok: message.ok === true,
      hasPassphrase: typeof message.passphrase === 'string' && message.passphrase.length > 0,
    });
    const resolve = pendingPinentry.get(message.id);
    if (!resolve) {
      postDebug('run.pinentry.response-unmatched', { id: message.id });
      return;
    }
    pendingPinentry.delete(message.id);
    resolve({
      ok: message.ok === true,
      passphrase: typeof message.passphrase === 'string' ? message.passphrase : '',
    });
    return;
  }

  if (message.type === 'run') {
    void handleRun(message).catch((error) => {
      postError(`unexpected worker failure: ${formatError(error)}`);
      const capture = self.__gnupg_stream_capture || { stdout: [], stderr: [], status: [] };
      const metrics = capture.metrics && typeof capture.metrics === 'object'
        ? capture.metrics
        : {};
      postDebug('run.unexpected-failure', {
        error: formatError(error),
        streamMetrics: metrics,
      });
      postMessage({
        type: 'result',
        exitCode: 1,
        fsState: null,
        stdoutLines: capture.stdout,
        stderrLines: capture.stderr,
        statusLines: capture.status,
        debugInfo: {
          phase: 'unexpected-failure',
          error: formatError(error),
          streamMetrics: metrics,
          streamLengths: {
            stdout: capture.stdout.length,
            stderr: capture.stderr.length,
            status: capture.status.length,
          },
        },
      });
      self.close();
      runInProgress = false;
    });
  }
});
