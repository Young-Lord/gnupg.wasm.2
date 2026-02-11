#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function usage() {
  process.stdout.write(
    [
      'Usage: scripts/wasm/gpg-node-cli.sh [options] -- [gpg args...]',
      '',
      'Run wasm gpg under Node with agent+dirmngr bridges enabled.',
      '',
      'Examples:',
      '  scripts/wasm/gpg-node-cli.sh -- --version',
      '  scripts/wasm/gpg-node-cli.sh -- --recv-keys 0x99242560',
      '  scripts/wasm/gpg-node-cli.sh -- --quick-generate-key user@example.com',
      '',
      'Options:',
      '  --gpg PATH            Explicit gpg launcher path',
      '  --node PATH           Explicit node binary for wasm launchers',
      '  --agent PATH          Explicit gpg-agent launcher path',
      '  --dirmngr-shim PATH   Explicit dirmngr fetch shim script path',
      '  --scdaemon PATH       Explicit scdaemon launcher path',
      '  --keyserver URI       Default keyserver for dirmngr shim',
      '  --homedir PATH        Explicit GNUPGHOME for this invocation',
      '  --raw                 Do not inject default gpg flags',
      '  --no-agent-bridge     Disable GNUPG_WASM_AGENT_FD bridge',
      '  --no-dirmngr-bridge   Disable GNUPG_WASM_DIRMNGR_FD bridge',
      '  --no-scdaemon-bridge  Disable GNUPG_WASM_SCDAEMON_FD bridge',
      '  --help                Show this help text',
      '',
      'Default injected gpg flags (unless --raw):',
      '  --homedir <dir> --batch --yes --no-tty --no-autostart',
      '',
    ].join('\n')
  );
}

function parseArgs(argv, defaults) {
  const out = {
    nodeBin: defaults.nodeBin,
    gpgBin: defaults.gpgBin,
    agentBin: defaults.agentBin,
    dirmngrShim: defaults.dirmngrShim,
    scdaemonBin: defaults.scdaemonBin,
    homedir: defaults.homedir,
    keyserver: process.env.GNUPG_WASM_KEYSERVER || 'hkps://keys.openpgp.org',
    rawMode: false,
    useAgentBridge: true,
    useDirmngrBridge: true,
    useScdaemonBridge: true,
    gpgArgs: [],
  };

  let i = 0;
  let passthrough = false;
  while (i < argv.length) {
    const arg = argv[i];

    if (passthrough) {
      out.gpgArgs.push(arg);
      i += 1;
      continue;
    }

    switch (arg) {
      case '--':
        passthrough = true;
        i += 1;
        break;
      case '--gpg':
        out.gpgBin = argv[i + 1] || '';
        i += 2;
        break;
      case '--node':
        out.nodeBin = argv[i + 1] || '';
        i += 2;
        break;
      case '--agent':
        out.agentBin = argv[i + 1] || '';
        i += 2;
        break;
      case '--dirmngr-shim':
        out.dirmngrShim = argv[i + 1] || '';
        i += 2;
        break;
      case '--scdaemon':
        out.scdaemonBin = argv[i + 1] || '';
        i += 2;
        break;
      case '--keyserver':
        out.keyserver = argv[i + 1] || out.keyserver;
        i += 2;
        break;
      case '--homedir':
        out.homedir = argv[i + 1] || '';
        i += 2;
        break;
      case '--raw':
        out.rawMode = true;
        i += 1;
        break;
      case '--no-agent-bridge':
        out.useAgentBridge = false;
        i += 1;
        break;
      case '--no-dirmngr-bridge':
        out.useDirmngrBridge = false;
        i += 1;
        break;
      case '--no-scdaemon-bridge':
        out.useScdaemonBridge = false;
        i += 1;
        break;
      case '--help':
      case '-h':
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!out.gpgArgs.length) {
    throw new Error('Missing gpg arguments after --');
  }

  return out;
}

function bridgeStreamToChild(stream, childProc) {
  stream.on('data', (chunk) => {
    if (!childProc.stdin.destroyed) {
      childProc.stdin.write(chunk);
    }
  });

  childProc.stdout.on('data', (chunk) => {
    if (!stream.destroyed) {
      stream.write(chunk);
    }
  });

  stream.on('end', () => {
    if (!childProc.stdin.destroyed) {
      childProc.stdin.end();
    }
  });

  childProc.stdout.on('end', () => {
    if (!stream.destroyed) {
      stream.end();
    }
  });

  stream.on('error', () => {});
  childProc.stdin.on('error', () => {});
  childProc.stdout.on('error', () => {});

  childProc.on('exit', () => {
    if (!stream.destroyed) {
      stream.destroy();
    }
  });
}

function waitForExit(childProc) {
  return new Promise((resolve) => {
    childProc.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function terminate(childProc, signal = 'SIGTERM') {
  if (!childProc || childProc.exitCode !== null || childProc.signalCode) {
    return;
  }

  childProc.kill(signal);
  const result = await Promise.race([
    waitForExit(childProc),
    new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
  ]);

  if (!result) {
    childProc.kill('SIGKILL');
  }
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..', '..');
  const wasmPrefix = process.env.WASM_PREFIX || path.join(repoRoot, 'PLAY', 'wasm-prefix');
  const wasmBuildDir = process.env.WASM_BUILD_DIR || path.join(repoRoot, 'PLAY', 'wasm-build');

  const defaults = {
    nodeBin: process.env.NODE_BIN || process.env.EMSDK_NODE || process.execPath,
    gpgBin: process.env.GPG_BIN || path.join(wasmPrefix, 'bin', 'gpg'),
    agentBin: process.env.GPG_AGENT_BIN || path.join(wasmPrefix, 'bin', 'gpg-agent'),
    dirmngrShim: process.env.GPG_DIRMNGR_SHIM || path.join(scriptDir, 'dirmngr-fetch-shim.mjs'),
    scdaemonBin: process.env.SCDAEMON_BIN || path.join(wasmPrefix, 'libexec', 'scdaemon'),
    homedir: process.env.GPG_CLI_HOME || path.join(wasmBuildDir, 'cli-node', 'gnupghome'),
  };

  let options;
  try {
    options = parseArgs(process.argv.slice(2), defaults);
  } catch (error) {
    usage();
    process.stderr.write(`[wasm] error: ${error.message}\n`);
    process.exit(1);
    return;
  }

  if (!existsSync(options.gpgBin)) {
    throw new Error(`Given gpg path does not exist: ${options.gpgBin}`);
  }
  if (!options.useAgentBridge) {
    options.useScdaemonBridge = false;
  }
  if (options.useAgentBridge && !existsSync(options.agentBin)) {
    throw new Error(`Given gpg-agent path does not exist: ${options.agentBin}`);
  }
  if (options.useDirmngrBridge && !existsSync(options.dirmngrShim)) {
    throw new Error(`Given dirmngr shim path does not exist: ${options.dirmngrShim}`);
  }
  if (options.useScdaemonBridge && !existsSync(options.scdaemonBin)) {
    throw new Error(`Given scdaemon path does not exist: ${options.scdaemonBin}`);
  }

  mkdirSync(options.homedir, { recursive: true });
  try {
    chmodSync(options.homedir, 0o700);
  } catch {
    /* Best effort permission fix-up.  */
  }

  process.stdout.write(`[wasm] Node: ${options.nodeBin}\n`);
  process.stdout.write(`[wasm] gpg:  ${options.gpgBin}\n`);
  process.stdout.write(`[wasm] home: ${options.homedir}\n`);

  const serviceProcesses = [];
  const bridgeStreams = [];

  const env = {
    ...process.env,
    GNUPGHOME: options.homedir,
  };
  const gpgStdio = ['inherit', 'inherit', 'inherit'];
  let nextFd = 3;
  const extraFds = [];

  if (options.useAgentBridge) {
    gpgStdio.push('pipe');
    env.GNUPG_WASM_AGENT_FD = String(nextFd);
    extraFds.push(nextFd);
    nextFd += 1;
  }

  if (options.useScdaemonBridge) {
    gpgStdio.push('pipe');
    env.GNUPG_WASM_SCDAEMON_FD = String(nextFd);
    extraFds.push(nextFd);
    nextFd += 1;
  }

  if (options.useDirmngrBridge) {
    gpgStdio.push('pipe');
    env.GNUPG_WASM_DIRMNGR_FD = String(nextFd);
    extraFds.push(nextFd);
    nextFd += 1;
  }

  if (extraFds.length) {
    env.GNUPG_WASM_EXTRA_FDS = extraFds.join(',');
  }

  const defaultFlags = [
    '--homedir', options.homedir,
    '--batch',
    '--yes',
    '--no-tty',
    '--no-autostart',
  ];
  const finalArgs = options.rawMode ? options.gpgArgs : [...defaultFlags, ...options.gpgArgs];

  const gpgProc = spawn(options.nodeBin, [options.gpgBin, ...finalArgs], {
    stdio: gpgStdio,
    env,
  });

  let bridgeFd = 3;

  if (options.useAgentBridge) {
    const agentBridge = gpgProc.stdio[bridgeFd];
    if (!agentBridge) {
      throw new Error(`Missing bridge stream for fd ${bridgeFd}`);
    }

    const agentProc = spawn(
      options.nodeBin,
      [
        options.agentBin,
        '--server',
        '--homedir', options.homedir,
      ],
      {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...process.env,
          GNUPGHOME: options.homedir,
        },
      }
    );

    bridgeStreamToChild(agentBridge, agentProc);
    bridgeStreams.push(agentBridge);
    serviceProcesses.push(agentProc);
    bridgeFd += 1;
  }

  if (options.useScdaemonBridge) {
    const scdaemonBridge = gpgProc.stdio[bridgeFd];
    if (!scdaemonBridge) {
      throw new Error(`Missing bridge stream for fd ${bridgeFd}`);
    }

    const scdaemonProc = spawn(
      options.nodeBin,
      [
        options.scdaemonBin,
        '--multi-server',
        '--homedir', options.homedir,
      ],
      {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...process.env,
          GNUPGHOME: options.homedir,
        },
      }
    );

    bridgeStreamToChild(scdaemonBridge, scdaemonProc);
    bridgeStreams.push(scdaemonBridge);
    serviceProcesses.push(scdaemonProc);
    bridgeFd += 1;
  }

  if (options.useDirmngrBridge) {
    const dirmngrBridge = gpgProc.stdio[bridgeFd];
    if (!dirmngrBridge) {
      throw new Error(`Missing bridge stream for fd ${bridgeFd}`);
    }

    const dirmngrProc = spawn(
      options.nodeBin,
      [options.dirmngrShim, '--homedir', options.homedir, '--keyserver', options.keyserver],
      {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...process.env,
          GNUPGHOME: options.homedir,
          GNUPG_WASM_KEYSERVER: options.keyserver,
        },
      }
    );

    bridgeStreamToChild(dirmngrBridge, dirmngrProc);
    bridgeStreams.push(dirmngrBridge);
    serviceProcesses.push(dirmngrProc);
  }

  const forwardSignal = (sig) => {
    if (!gpgProc.killed && gpgProc.exitCode === null) {
      gpgProc.kill(sig);
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  const gpgResult = await waitForExit(gpgProc);

  for (const stream of bridgeStreams) {
    if (!stream.destroyed) {
      stream.destroy();
    }
  }

  for (const childProc of serviceProcesses) {
    await terminate(childProc);
  }

  if (gpgResult.signal) {
    process.kill(process.pid, gpgResult.signal);
    return;
  }

  process.exit(gpgResult.code ?? 1);
}

main().catch(async (error) => {
  process.stderr.write(`[wasm] error: ${error.message}\n`);
  process.exit(1);
});
