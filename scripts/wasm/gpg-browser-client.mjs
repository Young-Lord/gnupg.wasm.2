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

export class WasmGpgBrowserClient {
  constructor(config = {}) {
    const baseUrl = import.meta.url;

    this.workerUrl = config.workerUrl || new URL('./gpg-browser-worker.js', baseUrl);
    this.gpgScriptUrl = toUrlString(config.gpgScriptUrl, baseUrl);
    this.gpgWasmUrl = toUrlString(config.gpgWasmUrl, baseUrl);
    this.gpgAgentWorkerUrl = config.gpgAgentWorkerUrl
      ? toUrlString(config.gpgAgentWorkerUrl, baseUrl)
      : toUrlString(new URL('./gpg-agent-server-worker.js', baseUrl), baseUrl);
    this.gpgAgentScriptUrl = toUrlString(config.gpgAgentScriptUrl, baseUrl);
    this.gpgAgentWasmUrl = toUrlString(config.gpgAgentWasmUrl, baseUrl);
    this.homedir = typeof config.homedir === 'string' && config.homedir
      ? config.homedir
      : '/gnupg';
    this.emitStatusByDefault = config.emitStatusByDefault !== false;
    this.persistRoots = normalizeStringArray(config.persistRoots);
  }

  async run(args, callbacks = {}) {
    if (!this.gpgScriptUrl) {
      throw new Error('WasmGpgBrowserClient requires gpgScriptUrl');
    }

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

    return new Promise((resolve, reject) => {
      let settled = false;
      let workerReportedError = null;
      let stdoutCount = 0;
      let stderrCount = 0;
      let statusCount = 0;
      let watchdogId = null;

      const clearWatchdog = () => {
        if (watchdogId !== null) {
          clearTimeout(watchdogId);
          watchdogId = null;
        }
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
        resolve(value);
      };

      const finishReject = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearWatchdog();
        worker.terminate();
        reject(error);
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
          safeInvoke(onStatus, message.line);
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

          finishResolve({
            exitCode: Number.isFinite(message.exitCode) ? message.exitCode : 1,
            fsState: message.fsState && typeof message.fsState === 'object'
              ? message.fsState
              : fsState,
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
          });
        }
      });

      worker.postMessage({
        type: 'run',
        args: argv,
        gpgScriptUrl: this.gpgScriptUrl,
        gpgWasmUrl: this.gpgWasmUrl,
        gpgAgentWorkerUrl: this.gpgAgentWorkerUrl,
        gpgAgentScriptUrl: this.gpgAgentScriptUrl,
        gpgAgentWasmUrl: this.gpgAgentWasmUrl,
        homedir: this.homedir,
        emitStatus,
        fsState,
        persistRoots,
        debug: callbacks.debug === true,
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
      });
    });
  }
}

export async function runWasmGpgOnce(config, args, callbacks) {
  const client = new WasmGpgBrowserClient(config);
  return client.run(args, callbacks);
}
