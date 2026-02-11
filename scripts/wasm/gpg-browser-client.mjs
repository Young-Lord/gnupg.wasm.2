function toUrlString(value, baseUrl) {
  if (!value) {
    return '';
  }
  if (value instanceof URL) {
    return value.toString();
  }
  const raw = String(value);
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

function normalizePinentryReply(reply) {
  if (typeof reply === 'string') {
    return {
      ok: true,
      passphrase: reply,
    };
  }

  if (!reply || typeof reply !== 'object') {
    return {
      ok: false,
      passphrase: '',
    };
  }

  return {
    ok: reply.ok === true,
    passphrase:
      typeof reply.passphrase === 'string'
        ? reply.passphrase
        : String(reply.passphrase ?? ''),
  };
}

function parseStatusLine(line) {
  const text = String(line ?? '').trim();
  if (!text) {
    return {
      keyword: '',
      payload: '',
    };
  }
  const idx = text.indexOf(' ');
  if (idx === -1) {
    return {
      keyword: text,
      payload: '',
    };
  }
  return {
    keyword: text.slice(0, idx),
    payload: text.slice(idx + 1).trimStart(),
  };
}

function decodeStatusField(text) {
  const raw = String(text ?? '');
  if (!raw) {
    return '';
  }
  const plusAsSpace = raw.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plusAsSpace);
  } catch {
    return plusAsSpace;
  }
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

function inferPinentryHints(args, pinentryRequest) {
  const request = pinentryRequest && typeof pinentryRequest === 'object'
    ? pinentryRequest
    : {};
  const uidHint =
    (typeof request.uidHint === 'string' && request.uidHint)
    || findOptionValue(args, ['--local-user', '--default-key']);
  const keyHint =
    (typeof request.keyHint === 'string' && request.keyHint)
    || findOptionValue(args, ['--default-key', '--local-user']);
  return {
    op:
      (typeof request.op === 'string' && request.op)
      || inferPinentryOperation(args),
    uidHint: uidHint || '',
    keyHint: keyHint || '',
  };
}

function parsePromptHint(prompt) {
  const text = String(prompt ?? '').trim();
  if (!text) {
    return {
      statusKeyword: '',
      keyword: '',
      raw: '',
    };
  }
  const idx = text.indexOf(' ');
  if (idx === -1) {
    return {
      statusKeyword: text,
      keyword: '',
      raw: text,
    };
  }
  return {
    statusKeyword: text.slice(0, idx),
    keyword: text.slice(idx + 1).trimStart(),
    raw: text,
  };
}

function safeInvoke(handler, payload) {
  if (typeof handler !== 'function') {
    return;
  }
  try {
    handler(payload);
  } catch {
    /* Ignore host callback exceptions to keep worker flow alive. */
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item));
}

function normalizeStdinText(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join('');
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') {
      return value.text;
    }
    if (Array.isArray(value.lines)) {
      const out = value.lines.map((line) => String(line));
      return out.join('\n') + (out.length ? '\n' : '');
    }
  }
  return '';
}

function normalizeStdinReply(value) {
  if (value && typeof value === 'object' && value.eof === true) {
    return {
      text: '',
      eof: true,
    };
  }
  return {
    text: normalizeStdinText(value),
    eof: false,
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

function queuePushText(queue, text) {
  if (!text) {
    return;
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(String(text));
  for (const value of bytes) {
    queuePushByte(queue, value, true);
  }
}

function queueCloseDescriptor(desc) {
  if (!desc || !desc.meta) {
    return;
  }
  const ctrl = new Int32Array(desc.meta);
  Atomics.store(ctrl, 2, 1);
  Atomics.add(ctrl, 3, 1);
  Atomics.notify(ctrl, 3);
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

function normalizeMode(mode, fallback) {
  if (Number.isFinite(mode)) {
    return Number(mode) & 0o777;
  }
  return fallback;
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

  return {
    version: 1,
    roots,
    dirs: Array.from(dirsMap.values()).sort((a, b) => a.path.localeCompare(b.path)),
    files: Array.from(filesMap.values()).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export class WasmGpgBrowserClient {
  constructor(config = {}) {
    const baseUrl = import.meta.url;

    this.workerUrl = config.workerUrl || new URL('./gpg-browser-worker.js', baseUrl);
    this.gpgScriptUrl = toUrlString(config.gpgScriptUrl, baseUrl);
    this.gpgWasmUrl = toUrlString(config.gpgWasmUrl, baseUrl);
    this.gpgAgentWorkerUrl = config.gpgAgentWorkerUrl
      ? toUrlString(config.gpgAgentWorkerUrl, baseUrl)
      : toUrlString(new URL('./gpg-agent-server-worker.js', baseUrl), baseUrl);
    this.gpgScdaemonWorkerUrl = config.gpgScdaemonWorkerUrl
      ? toUrlString(config.gpgScdaemonWorkerUrl, baseUrl)
      : toUrlString(new URL('./gpg-scdaemon-server-worker.js', baseUrl), baseUrl);
    this.gpgDirmngrWorkerUrl = config.gpgDirmngrWorkerUrl
      ? toUrlString(config.gpgDirmngrWorkerUrl, baseUrl)
      : toUrlString(new URL('./gpg-dirmngr-fetch-worker.js', baseUrl), baseUrl);
    this.gpgAgentSessionWorkerUrl = config.gpgAgentSessionWorkerUrl
      ? toUrlString(config.gpgAgentSessionWorkerUrl, baseUrl)
      : toUrlString(new URL('./gpg-agent-session-worker.js', baseUrl), baseUrl);
    this.gpgAgentScriptUrl = toUrlString(config.gpgAgentScriptUrl, baseUrl);
    this.gpgAgentWasmUrl = toUrlString(config.gpgAgentWasmUrl, baseUrl);
    this.gpgScdaemonScriptUrl = toUrlString(config.gpgScdaemonScriptUrl, baseUrl);
    this.gpgScdaemonWasmUrl = toUrlString(config.gpgScdaemonWasmUrl, baseUrl);
    this.homedir = typeof config.homedir === 'string' && config.homedir
      ? config.homedir
      : '/gnupg';
    this.emitStatusByDefault = config.emitStatusByDefault !== false;
    this.persistRoots = normalizeStringArray(config.persistRoots);
    this.persistentAgentRuntime = config.persistentAgentRuntime !== false;

    this._runInProgress = false;
    this._agentSessionWorker = null;
    this._agentSessionWorkerKey = '';
    this._agentSessionNextId = 0;
    this._agentSessions = new Map();
    this._agentSessionCallbacks = {
      onDebug: null,
      onStderr: null,
    };
  }

  _buildAgentSessionWorkerKey() {
    return [
      this.gpgAgentSessionWorkerUrl,
      this.gpgAgentScriptUrl,
      this.gpgAgentWasmUrl,
      this.gpgScdaemonWorkerUrl,
      this.gpgScdaemonScriptUrl,
      this.gpgScdaemonWasmUrl,
      this.homedir,
    ].join('\n');
  }

  _rejectPendingAgentSessions(errorText) {
    const error = new Error(errorText || 'agent session worker stopped');
    for (const pending of this._agentSessions.values()) {
      if (pending && typeof pending.rejectReady === 'function') {
        pending.rejectReady(error);
      }
      if (pending && typeof pending.rejectResult === 'function') {
        pending.rejectResult(error);
      }
    }
    this._agentSessions.clear();
  }

  _teardownAgentSessionWorker(errorText) {
    if (this._agentSessionWorker) {
      try {
        this._agentSessionWorker.postMessage({ type: 'shutdown' });
      } catch {
        /* Best effort only. */
      }
      this._agentSessionWorker.terminate();
      this._agentSessionWorker = null;
    }
    this._agentSessionWorkerKey = '';
    this._rejectPendingAgentSessions(errorText || 'agent session worker torn down');
  }

  _ensureAgentSessionWorker(onDebug, onStderr) {
    this._agentSessionCallbacks = {
      onDebug: typeof onDebug === 'function' ? onDebug : null,
      onStderr: typeof onStderr === 'function' ? onStderr : null,
    };

    if (!this.persistentAgentRuntime) {
      return null;
    }
    if (!this.gpgAgentScriptUrl) {
      return null;
    }

    const workerKey = this._buildAgentSessionWorkerKey();
    if (this._agentSessionWorker) {
      if (this._agentSessionWorkerKey === workerKey) {
        return this._agentSessionWorker;
      }
      this._teardownAgentSessionWorker('agent session worker config changed');
    }

    const worker = new Worker(this.gpgAgentSessionWorkerUrl);
    worker.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object') {
        return;
      }

      if (message.type === 'debug') {
        const step = typeof message.step === 'string' && message.step
          ? `agent.session.${message.step}`
          : 'agent.session.unknown';
        safeInvoke(this._agentSessionCallbacks.onDebug, {
          step,
          data: message.data && typeof message.data === 'object' ? message.data : null,
        });
        return;
      }

      if (message.type === 'error') {
        safeInvoke(this._agentSessionCallbacks.onStderr, `[agent] ${String(message.message || 'unknown session worker error')}`);
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        if (sessionId && this._agentSessions.has(sessionId)) {
          const pending = this._agentSessions.get(sessionId);
          if (pending) {
            const error = new Error(String(message.message || 'agent session worker error'));
            pending.rejectReady(error);
            pending.rejectResult(error);
            this._agentSessions.delete(sessionId);
          }
        }
        return;
      }

      if (message.type === 'session-ready') {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        const pending = sessionId ? this._agentSessions.get(sessionId) : null;
        if (pending) {
          pending.resolveReady(true);
        }
        return;
      }

      if (message.type === 'session-result') {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        const pending = sessionId ? this._agentSessions.get(sessionId) : null;
        if (pending) {
          pending.resolveResult(message);
          this._agentSessions.delete(sessionId);
        }
      }
    });

    worker.addEventListener('error', (event) => {
      const message = event?.message || 'agent session worker failed';
      safeInvoke(this._agentSessionCallbacks.onStderr, `[agent] ${message}`);
      this._teardownAgentSessionWorker(message);
    });

    this._agentSessionWorker = worker;
    this._agentSessionWorkerKey = workerKey;
    return worker;
  }

  async _startPersistentAgentSession(fsState, persistRoots) {
    const worker = this._ensureAgentSessionWorker(
      this._agentSessionCallbacks.onDebug,
      this._agentSessionCallbacks.onStderr,
    );
    if (!worker) {
      return null;
    }

    const sessionId = `agent-session-${Date.now()}-${(this._agentSessionNextId += 1)}`;
    const bridge = {
      gpgToAgent: createSharedQueueDescriptor(),
      agentToGpg: createSharedQueueDescriptor(),
    };

    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    let resolveResult;
    let rejectResult;
    const resultPromise = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this._agentSessions.set(sessionId, {
      resolveReady,
      rejectReady,
      resolveResult,
      rejectResult,
    });

    try {
      worker.postMessage({
        type: 'run-session',
        sessionId,
        gpgAgentScriptUrl: this.gpgAgentScriptUrl,
        gpgAgentWasmUrl: this.gpgAgentWasmUrl,
        gpgScdaemonWorkerUrl: this.gpgScdaemonWorkerUrl,
        gpgScdaemonScriptUrl: this.gpgScdaemonScriptUrl,
        gpgScdaemonWasmUrl: this.gpgScdaemonWasmUrl,
        homedir: this.homedir,
        fsState,
        persistRoots,
        bridge,
      });
    } catch (error) {
      this._agentSessions.delete(sessionId);
      queueCloseDescriptor(bridge.gpgToAgent);
      queueCloseDescriptor(bridge.agentToGpg);
      throw error;
    }

    let readyTimeoutId = null;
    const readyTimeoutPromise = new Promise((resolve) => {
      readyTimeoutId = setTimeout(() => resolve(false), 12000);
    });

    const ready = await Promise.race([readyPromise, readyTimeoutPromise]).catch(() => false);
    if (readyTimeoutId !== null) {
      clearTimeout(readyTimeoutId);
    }
    if (!ready) {
      this._agentSessions.delete(sessionId);
      queueCloseDescriptor(bridge.gpgToAgent);
      queueCloseDescriptor(bridge.agentToGpg);
      throw new Error('agent session worker did not become ready in time');
    }

    return {
      sessionId,
      bridge,
      resultPromise,
    };
  }

  async close() {
    this._teardownAgentSessionWorker('client closed');
  }

  async run(args, callbacks = {}) {
    if (!this.gpgScriptUrl) {
      throw new Error('WasmGpgBrowserClient requires gpgScriptUrl');
    }

    if (this._runInProgress) {
      throw new Error('WasmGpgBrowserClient only supports one active run at a time');
    }
    this._runInProgress = true;

    try {
      const argv = Array.isArray(args) ? args.map((item) => String(item)) : [];
      const worker = new Worker(this.workerUrl);

      const onStdout = callbacks.onStdout;
      const onStderr = callbacks.onStderr;
      const onStatus = callbacks.onStatus;
      const onDebug = callbacks.onDebug;
      const onPinentry = callbacks.onPinentry;

      const pinentryRequest = callbacks.pinentryRequest && typeof callbacks.pinentryRequest === 'object'
        ? callbacks.pinentryRequest
        : {};
      const pinentryHints = inferPinentryHints(argv, pinentryRequest);
      const pinentryContext = {
        op: pinentryHints.op,
        uidHint: pinentryHints.uidHint,
        keyHint: pinentryHints.keyHint,
        inquireMaxLen: null,
        needPassphrase: '',
        needPassphraseSym: '',
      };
      let pinentryRequestCounter = 0;
      let stdinText = '';
      if (callbacks.stdinText !== undefined) {
        stdinText = normalizeStdinText(callbacks.stdinText);
      }
      const wantsInteractiveStdin = typeof callbacks.onInputRequest === 'function';
      const wantsPinentryStdin = typeof onPinentry === 'function';
      const stdinQueueDesc = (wantsInteractiveStdin || stdinText || wantsPinentryStdin)
        ? createSharedQueueDescriptor()
        : null;
      const stdinQueue = stdinQueueDesc ? createSharedQueue(stdinQueueDesc) : null;
      if (stdinQueue && stdinText) {
        queuePushText(stdinQueue, stdinText);
      }

      const emitStatus = callbacks.emitStatus !== undefined
        ? callbacks.emitStatus !== false
        : this.emitStatusByDefault;
      const runTimeoutMs = Number.isFinite(callbacks.runTimeoutMs)
        ? Number(callbacks.runTimeoutMs)
        : 30000;

      const fsState = callbacks.fsState && typeof callbacks.fsState === 'object'
        ? callbacks.fsState
        : null;

      const persistRoots = Array.isArray(callbacks.persistRoots)
        ? callbacks.persistRoots.map((item) => String(item))
        : this.persistRoots;

      this._agentSessionCallbacks = {
        onDebug: typeof onDebug === 'function' ? onDebug : null,
        onStderr: typeof onStderr === 'function' ? onStderr : null,
      };

      const enableAgentBridge = callbacks.enableAgentBridge !== false;
      let persistentAgentSession = null;
      if (enableAgentBridge) {
        persistentAgentSession = await this._startPersistentAgentSession(fsState, persistRoots);
      }

      return await new Promise((resolve, reject) => {
        let settled = false;
        let workerReportedError = null;
        let stdoutCount = 0;
        let stderrCount = 0;
        let statusCount = 0;
        let watchdogId = null;
        let persistentBridgeClosed = false;

        const clearWatchdog = () => {
          if (watchdogId !== null) {
            clearTimeout(watchdogId);
            watchdogId = null;
          }
        };

        const closePersistentBridge = () => {
          if (!persistentAgentSession || persistentBridgeClosed) {
            return;
          }
          persistentBridgeClosed = true;
          queueCloseDescriptor(persistentAgentSession.bridge.gpgToAgent);
          queueCloseDescriptor(persistentAgentSession.bridge.agentToGpg);
        };

        const finishResolve = (value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearWatchdog();
          setTimeout(() => {
            worker.terminate();
          }, 80);
          if (stdinQueueDesc) {
            queueCloseDescriptor(stdinQueueDesc);
          }
          resolve(value);
        };

        const finishReject = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearWatchdog();
          closePersistentBridge();
          if (stdinQueueDesc) {
            queueCloseDescriptor(stdinQueueDesc);
          }
          worker.terminate();
          reject(error);
        };

        const updatePinentryContextFromStatus = (line) => {
          const { keyword, payload } = parseStatusLine(line);
          if (keyword === 'USERID_HINT') {
            const hint = decodeStatusField(payload);
            if (hint) {
              pinentryContext.uidHint = hint;
            }
            return;
          }
          if (keyword === 'NEED_PASSPHRASE') {
            pinentryContext.needPassphrase = payload;
            const keyid = payload.split(/\s+/).filter(Boolean)[0] || '';
            if (keyid) {
              pinentryContext.keyHint = keyid;
            }
            return;
          }
          if (keyword === 'NEED_PASSPHRASE_SYM') {
            pinentryContext.needPassphraseSym = payload;
            if (!pinentryRequest.op) {
              pinentryContext.op = 'symmetric';
            }
            return;
          }
          if (keyword === 'INQUIRE_MAXLEN') {
            const maxLen = Number.parseInt(payload, 10);
            if (Number.isFinite(maxLen) && maxLen > 0) {
              pinentryContext.inquireMaxLen = maxLen;
            }
          }
        };

        const pushPinentryReplyToQueue = (normalized) => {
          if (!stdinQueue || !stdinQueueDesc) {
            return;
          }
          if (!normalized.ok) {
            queuePushByte(stdinQueue, 0x04, true);
            return;
          }
          const passphrase = typeof normalized.passphrase === 'string'
            ? normalized.passphrase
            : String(normalized.passphrase ?? '');
          if (passphrase) {
            queuePushText(stdinQueue, passphrase);
          }
          if (!passphrase.endsWith('\n')) {
            queuePushByte(stdinQueue, 0x0a, true);
          }
        };

        const handlePinentryViaStdinRequest = (request, promptInfo) => {
          if (!stdinQueue || !stdinQueueDesc || typeof onPinentry !== 'function') {
            if (stdinQueueDesc) {
              queueCloseDescriptor(stdinQueueDesc);
            }
            return;
          }

          pinentryRequestCounter += 1;
          const req = {
            id: `pinentry-stdin-${pinentryRequestCounter}`,
            op: pinentryContext.op || 'passphrase',
            uidHint: pinentryContext.uidHint || '',
            keyHint: pinentryContext.keyHint || '',
            prompt: promptInfo.keyword || request.prompt || '',
            inquireMaxLen: Number.isFinite(pinentryContext.inquireMaxLen)
              ? pinentryContext.inquireMaxLen
              : null,
            needPassphrase: pinentryContext.needPassphrase || '',
            needPassphraseSym: pinentryContext.needPassphraseSym || '',
          };

          safeInvoke(onDebug, {
            step: 'client.pinentry.request',
            data: {
              id: req.id,
              op: req.op,
              uidHint: req.uidHint,
              keyHint: req.keyHint,
              prompt: req.prompt,
              inquireMaxLen: req.inquireMaxLen,
            },
          });

          Promise.resolve(onPinentry(req))
            .then((reply) => {
              const normalized = normalizePinentryReply(reply);
              safeInvoke(onDebug, {
                step: 'client.pinentry.reply',
                data: {
                  id: req.id,
                  ok: normalized.ok,
                  hasPassphrase: typeof normalized.passphrase === 'string' && normalized.passphrase.length > 0,
                },
              });
              pushPinentryReplyToQueue(normalized);
            })
            .catch((error) => {
              safeInvoke(onDebug, {
                step: 'client.pinentry.error',
                data: {
                  id: req.id,
                  error: error instanceof Error ? error.message : String(error),
                },
              });
              safeInvoke(onStderr, `[wasm] pinentry callback failed: ${error instanceof Error ? error.message : String(error)}`);
              pushPinentryReplyToQueue({ ok: false, passphrase: '' });
            });
        };

        if (runTimeoutMs > 0) {
          watchdogId = setTimeout(() => {
            finishReject(new Error(`browser client watchdog timeout after ${runTimeoutMs}ms`));
          }, runTimeoutMs + 1200);
        }

        worker.addEventListener('error', (event) => {
          const message = event?.message || 'worker failed';
          finishReject(new Error(message));
        });

        worker.addEventListener('message', (event) => {
          const message = event.data;
          if (!message || typeof message !== 'object') {
            return;
          }

          if (message.type === 'stdout') {
            stdoutCount += 1;
            safeInvoke(onStdout, message.data);
            return;
          }

          if (message.type === 'stderr') {
            stderrCount += 1;
            safeInvoke(onStderr, message.data);
            return;
          }

          if (message.type === 'status') {
            statusCount += 1;
            const statusLine = typeof message.line === 'string'
              ? message.line
              : String(message.line ?? '');
            updatePinentryContextFromStatus(statusLine);
            safeInvoke(onStatus, statusLine);
            return;
          }

          if (message.type === 'debug') {
            safeInvoke(onDebug, {
              step: typeof message.step === 'string' ? message.step : 'unknown',
              data: message.data && typeof message.data === 'object' ? message.data : null,
            });
            return;
          }

          if (message.type === 'pinentry-request') {
            const req = {
              id: message.id,
              op: message.op || 'passphrase',
              uidHint: message.uidHint || '',
              keyHint: message.keyHint || '',
            };
            safeInvoke(onDebug, {
              step: 'client.pinentry.request',
              data: {
                id: req.id,
                op: req.op,
                uidHint: req.uidHint,
                keyHint: req.keyHint,
              },
            });

            if (typeof onPinentry !== 'function') {
              safeInvoke(onDebug, {
                step: 'client.pinentry.no-callback',
                data: { id: req.id },
              });
              worker.postMessage({
                type: 'pinentry-response',
                id: req.id,
                ok: false,
                passphrase: '',
              });
              return;
            }

            Promise.resolve(onPinentry(req))
              .then((reply) => {
                const normalized = normalizePinentryReply(reply);
                safeInvoke(onDebug, {
                  step: 'client.pinentry.reply',
                  data: {
                    id: req.id,
                    ok: normalized.ok,
                    hasPassphrase: typeof normalized.passphrase === 'string' && normalized.passphrase.length > 0,
                  },
                });
                worker.postMessage({
                  type: 'pinentry-response',
                  id: req.id,
                  ok: normalized.ok,
                  passphrase: normalized.passphrase,
                });
              })
              .catch((error) => {
                safeInvoke(onDebug, {
                  step: 'client.pinentry.error',
                  data: {
                    id: req.id,
                    error: error instanceof Error ? error.message : String(error),
                  },
                });
                safeInvoke(onStderr, `[wasm] pinentry callback failed: ${error instanceof Error ? error.message : String(error)}`);
                worker.postMessage({
                  type: 'pinentry-response',
                  id: req.id,
                  ok: false,
                  passphrase: '',
                });
              });
            return;
          }

          if (message.type === 'stdin-request') {
            const request = {
              id: typeof message.id === 'string' ? message.id : '',
              prompt: typeof message.prompt === 'string' ? message.prompt : '',
              args: Array.isArray(message.args) ? message.args.map((item) => String(item)) : argv.slice(),
            };

            const promptInfo = parsePromptHint(request.prompt);
            if (promptInfo.statusKeyword === 'GET_HIDDEN' && typeof onPinentry === 'function') {
              handlePinentryViaStdinRequest(request, promptInfo);
              return;
            }

            if (!stdinQueue || typeof callbacks.onInputRequest !== 'function') {
              if (stdinQueueDesc) {
                queueCloseDescriptor(stdinQueueDesc);
              }
              return;
            }

            Promise.resolve(callbacks.onInputRequest(request))
              .then((reply) => {
                const normalized = normalizeStdinReply(reply);
                if (normalized.eof) {
                  queueCloseDescriptor(stdinQueueDesc);
                  return;
                }
                if (normalized.text) {
                  queuePushText(stdinQueue, normalized.text);
                }
              })
              .catch((error) => {
                safeInvoke(onStderr, `[wasm] input callback failed: ${error instanceof Error ? error.message : String(error)}`);
                queueCloseDescriptor(stdinQueueDesc);
              });
            return;
          }

          if (message.type === 'error') {
            workerReportedError = new Error(message.message || 'worker reported an error');
            safeInvoke(onStderr, `[wasm] ${workerReportedError.message}`);
            return;
          }

          if (message.type === 'result') {
            const resultStdout = Array.isArray(message.stdoutLines)
              ? message.stdoutLines.map((line) => String(line))
              : [];
            const resultStderr = Array.isArray(message.stderrLines)
              ? message.stderrLines.map((line) => String(line))
              : [];
            const resultStatus = Array.isArray(message.statusLines)
              ? message.statusLines.map((line) => String(line))
              : [];

            if (stdoutCount === 0) {
              for (const line of resultStdout) {
                safeInvoke(onStdout, line);
              }
            }
            if (stderrCount === 0) {
              for (const line of resultStderr) {
                safeInvoke(onStderr, line);
              }
            }
            if (statusCount === 0) {
              for (const line of resultStatus) {
                safeInvoke(onStatus, line);
              }
            }

            const finalizeResult = async () => {
              let finalFsState = message.fsState && typeof message.fsState === 'object'
                ? message.fsState
                : fsState;
              let agentSessionInfo = null;

              if (persistentAgentSession) {
                let timeoutId = null;
                const timeoutPromise = new Promise((resolveTimeout) => {
                  timeoutId = setTimeout(() => resolveTimeout(null), 6000);
                });
                let agentResult = null;
                try {
                  agentResult = await Promise.race([persistentAgentSession.resultPromise, timeoutPromise]);
                } catch (error) {
                  safeInvoke(onStderr, `[agent] session result failed: ${error instanceof Error ? error.message : String(error)}`);
                } finally {
                  if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                  }
                }

                if (agentResult && typeof agentResult === 'object') {
                  if (agentResult.fsState && typeof agentResult.fsState === 'object') {
                    finalFsState = mergeFsStates(finalFsState, agentResult.fsState);
                  }
                  if (typeof agentResult.stderr === 'string' && agentResult.stderr.trim()) {
                    safeInvoke(onStderr, `[agent] ${agentResult.stderr.trimEnd()}`);
                  }
                  if (typeof agentResult.error === 'string' && agentResult.error && agentResult.error !== 'callMain returned') {
                    safeInvoke(onStderr, `[agent] ${agentResult.error}`);
                  }
                  agentSessionInfo = {
                    sessionId: persistentAgentSession.sessionId,
                    exitCode: Number.isFinite(agentResult.exitCode) ? Number(agentResult.exitCode) : null,
                    error: typeof agentResult.error === 'string' ? agentResult.error : '',
                  };
                } else {
                  safeInvoke(onStderr, '[agent] session result timeout; using gpg-side fs state only');
                }
              }

              closePersistentBridge();

              finishResolve({
                exitCode: Number.isFinite(message.exitCode) ? message.exitCode : 1,
                fsState: finalFsState,
                workerError: workerReportedError ? workerReportedError.message : '',
                stdoutLines: resultStdout,
                stderrLines: resultStderr,
                statusLines: resultStatus,
                callbackCounts: {
                  stdout: stdoutCount,
                  stderr: stderrCount,
                  status: statusCount,
                },
                debugInfo: message.debugInfo && typeof message.debugInfo === 'object'
                  ? message.debugInfo
                  : null,
                agentSession: agentSessionInfo,
              });
            };

            void finalizeResult();
          }
        });

        try {
          worker.postMessage({
            type: 'run',
            args: argv,
            gpgScriptUrl: this.gpgScriptUrl,
            gpgWasmUrl: this.gpgWasmUrl,
            gpgAgentWorkerUrl: this.gpgAgentWorkerUrl,
            gpgScdaemonWorkerUrl: this.gpgScdaemonWorkerUrl,
            gpgDirmngrWorkerUrl: this.gpgDirmngrWorkerUrl,
            gpgAgentScriptUrl: this.gpgAgentScriptUrl,
            gpgAgentWasmUrl: this.gpgAgentWasmUrl,
            gpgScdaemonScriptUrl: this.gpgScdaemonScriptUrl,
            gpgScdaemonWasmUrl: this.gpgScdaemonWasmUrl,
            homedir: this.homedir,
            emitStatus,
            fsState,
            persistRoots,
            debug: callbacks.debug === true,
            enableAgentBridge,
            sharedAgentBridge: persistentAgentSession ? persistentAgentSession.bridge : null,
            runTimeoutMs: Number.isFinite(callbacks.runTimeoutMs)
              ? Number(callbacks.runTimeoutMs)
              : undefined,
            pinentry: typeof onPinentry === 'function'
              ? {
                  enabled: true,
                  always: callbacks.pinentryAlways === true,
                  op: pinentryRequest.op || '',
                  uidHint: pinentryRequest.uidHint || '',
                  keyHint: pinentryRequest.keyHint || '',
                }
              : {
                  enabled: false,
                },
            stdinText,
            stdinQueue: stdinQueueDesc,
          });
        } catch (error) {
          finishReject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } finally {
      this._runInProgress = false;
    }
  }
}

export async function runWasmGpgOnce(config, args, callbacks) {
  const client = new WasmGpgBrowserClient(config);
  try {
    return await client.run(args, callbacks);
  } finally {
    await client.close();
  }
}
