#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROUNDS = 2000;
const DEFAULT_WARMUP_ROUNDS = 200;
const DEFAULT_WASM_CHUNK_SIZE = 250;
const DEFAULT_GNUPG_AGENT_S2K_COUNT = 65536;
const DEFAULT_PAYLOAD_BYTES = 4096;
const DEFAULT_PASSPHRASE = 'bench-passphrase';

function usage() {
  process.stdout.write(
    [
      'Usage: node scripts/wasm/benchmark-openpgp-core.mjs [options]',
      '',
      'High-round core algorithm benchmark (thousands of operations).',
      'Compared tasks are intentionally batched to minimize process startup bias.',
      '',
      'Benchmarked tasks:',
      '  - pke_encrypt_batch',
      '  - pke_decrypt_batch',
      '  - verify_clearsign_batch',
      '',
      'Options:',
      `  --rounds N         Number of measured operations per task (default: ${DEFAULT_ROUNDS})`,
      `  --warmup-rounds N  Warmup operations per task (default: ${DEFAULT_WARMUP_ROUNDS})`,
      `  --wasm-chunk-size N  Operations per single gnupg wasm command (default: ${DEFAULT_WASM_CHUNK_SIZE})`,
      `  --gnupg-agent-s2k-count N  S2K count written to gpg-agent.conf (default: ${DEFAULT_GNUPG_AGENT_S2K_COUNT})`,
      `  --payload-bytes N  Input payload size in bytes (default: ${DEFAULT_PAYLOAD_BYTES})`,
      `  --passphrase TEXT  Shared passphrase (default: ${DEFAULT_PASSPHRASE})`,
      '  --workdir PATH     Working directory for generated benchmark artifacts',
      '  --json-out PATH    Output JSON report path',
      '  --openpgp-dir PATH Dependency directory where OpenPGP.js is installed',
      '  --skip-build       Skip scripts/wasm/build-all.sh',
      '  --help             Show this help text',
      '',
      'Examples:',
      '  node scripts/wasm/benchmark-openpgp-core.mjs',
      '  node scripts/wasm/benchmark-openpgp-core.mjs --rounds 5000 --warmup-rounds 500',
      '  node scripts/wasm/benchmark-openpgp-core.mjs --skip-build --json-out /tmp/core.json',
      '',
    ].join('\n')
  );
}

function isFlag(arg) {
  return arg.startsWith('--');
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function parseArgs(argv, defaults) {
  const out = {
    rounds: defaults.rounds,
    warmupRounds: defaults.warmupRounds,
    wasmChunkSize: defaults.wasmChunkSize,
    gnupgAgentS2kCount: defaults.gnupgAgentS2kCount,
    payloadBytes: defaults.payloadBytes,
    passphrase: defaults.passphrase,
    workdir: defaults.workdir,
    jsonOut: defaults.jsonOut,
    openpgpDir: defaults.openpgpDir,
    skipBuild: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case '--rounds': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--rounds expects a value');
        }
        out.rounds = parsePositiveInt(next, '--rounds');
        i += 2;
        break;
      }
      case '--warmup-rounds': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--warmup-rounds expects a value');
        }
        out.warmupRounds = parsePositiveInt(next, '--warmup-rounds');
        i += 2;
        break;
      }
      case '--payload-bytes': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--payload-bytes expects a value');
        }
        out.payloadBytes = parsePositiveInt(next, '--payload-bytes');
        i += 2;
        break;
      }
      case '--gnupg-agent-s2k-count': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--gnupg-agent-s2k-count expects a value');
        }
        out.gnupgAgentS2kCount = parsePositiveInt(next, '--gnupg-agent-s2k-count');
        i += 2;
        break;
      }
      case '--wasm-chunk-size': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--wasm-chunk-size expects a value');
        }
        out.wasmChunkSize = parsePositiveInt(next, '--wasm-chunk-size');
        i += 2;
        break;
      }
      case '--passphrase': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--passphrase expects a value');
        }
        out.passphrase = next;
        i += 2;
        break;
      }
      case '--workdir': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--workdir expects a value');
        }
        out.workdir = next;
        i += 2;
        break;
      }
      case '--json-out': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--json-out expects a value');
        }
        out.jsonOut = next;
        i += 2;
        break;
      }
      case '--openpgp-dir': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--openpgp-dir expects a value');
        }
        out.openpgpDir = next;
        i += 2;
        break;
      }
      case '--skip-build':
        out.skipBuild = true;
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

  return out;
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function ensurePrivateDir(dirPath) {
  ensureDir(dirPath);
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    /* Best effort only. */
  }
}

function toMs(startNs, endNs) {
  return Number(endNs - startNs) / 1e6;
}

function formatMs(value) {
  return value.toFixed(2);
}

async function runCommand(command, args, options = {}) {
  const {
    cwd,
    env,
    inheritOutput = false,
    input,
  } = options;

  const start = process.hrtime.bigint();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...(env || {}),
      },
      stdio: inheritOutput ? ['pipe', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    if (!inheritOutput) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    if (input !== undefined && input !== null) {
      child.stdin.write(input);
    }
    child.stdin.end();

    child.once('error', (error) => {
      reject(error);
    });

    child.once('close', (code, signal) => {
      const durationMs = toMs(start, process.hrtime.bigint());
      if (code === 0) {
        resolve({
          code,
          signal,
          stdout,
          stderr,
          durationMs,
        });
        return;
      }
      const error = new Error(
        `Command failed: ${command} ${args.join(' ')} (code=${code}, signal=${signal ?? 'none'})`
      );
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      error.durationMs = durationMs;
      reject(error);
    });
  });
}

async function ensureOpenpgpInstall(openpgpDir) {
  ensureDir(openpgpDir);

  const packageJsonPath = path.join(openpgpDir, 'package.json');
  let pkg = {
    private: true,
    type: 'module',
    dependencies: {},
  };

  if (existsSync(packageJsonPath)) {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (!pkg.dependencies || typeof pkg.dependencies !== 'object') {
      pkg.dependencies = {};
    }
  }

  if (pkg.dependencies.openpgp !== '^6') {
    pkg.dependencies.openpgp = '^6';
    writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }

  await runCommand('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: openpgpDir,
    inheritOutput: true,
  });

  const installedPackageJsonPath = path.join(
    openpgpDir,
    'node_modules',
    'openpgp',
    'package.json'
  );
  if (!existsSync(installedPackageJsonPath)) {
    throw new Error(`OpenPGP.js install missing at: ${installedPackageJsonPath}`);
  }
  const installedPackageJson = JSON.parse(readFileSync(installedPackageJsonPath, 'utf8'));
  return installedPackageJson.version;
}

async function loadOpenpgp(openpgpDir) {
  const packageJsonPath = path.join(openpgpDir, 'package.json');
  const requireFromOpenpgpDir = createRequire(packageJsonPath);
  const openpgpEntry = requireFromOpenpgpDir.resolve('openpgp');
  return import(pathToFileURL(openpgpEntry).href);
}

function renderComparisonTable(results) {
  const rows = [
    ['Task', 'rounds', 'gnupg-wasm total(ms)', 'gnupg per-op(ms)', 'OpenPGP.js total(ms)', 'openpgp per-op(ms)', 'ratio(per-op)'],
  ];

  for (const result of results) {
    rows.push([
      result.task,
      String(result.rounds),
      formatMs(result.wasm.totalMs),
      formatMs(result.wasm.perOpMs),
      formatMs(result.openpgp.totalMs),
      formatMs(result.openpgp.perOpMs),
      result.ratioWasmToOpenpgp.toFixed(2),
    ]);
  }

  const widths = [];
  for (const row of rows) {
    row.forEach((cell, idx) => {
      widths[idx] = Math.max(widths[idx] || 0, cell.length);
    });
  }

  return rows
    .map((row) => row.map((cell, idx) => cell.padEnd(widths[idx])).join('  '))
    .join('\n');
}

async function timeOpenpgpLoop(rounds, warmupRounds, fn) {
  for (let i = 0; i < warmupRounds; i += 1) {
    await fn(i, true);
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < rounds; i += 1) {
    await fn(i, false);
  }
  const totalMs = toMs(start, process.hrtime.bigint());
  return {
    totalMs,
    perOpMs: totalMs / rounds,
  };
}

function chunkCounts(total, chunkSize) {
  const chunks = [];
  let remaining = total;
  while (remaining > 0) {
    const size = Math.min(remaining, chunkSize);
    chunks.push(size);
    remaining -= size;
  }
  return chunks;
}

async function timeWasmChunked(rounds, warmupRounds, chunkSize, runChunk) {
  const warmupChunks = chunkCounts(warmupRounds, chunkSize);
  for (const size of warmupChunks) {
    await runChunk(size, true);
  }

  const measuredChunks = chunkCounts(rounds, chunkSize);
  let totalMs = 0;
  let stderrLineCount = 0;
  for (const size of measuredChunks) {
    const result = await runChunk(size, false);
    totalMs += result.durationMs;
    if (result.stderr) {
      stderrLineCount += result.stderr.split('\n').filter(Boolean).length;
    }
  }

  return {
    totalMs,
    perOpMs: totalMs / rounds,
    stderrLineCount,
  };
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..', '..');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const defaults = {
    rounds: DEFAULT_ROUNDS,
    warmupRounds: DEFAULT_WARMUP_ROUNDS,
    wasmChunkSize: DEFAULT_WASM_CHUNK_SIZE,
    gnupgAgentS2kCount: DEFAULT_GNUPG_AGENT_S2K_COUNT,
    payloadBytes: DEFAULT_PAYLOAD_BYTES,
    passphrase: DEFAULT_PASSPHRASE,
    workdir: path.join(repoRoot, 'PLAY', 'wasm-build', 'bench-openpgp-core', timestamp),
    jsonOut: path.join(repoRoot, 'PLAY', 'wasm-build', 'bench-openpgp-core', timestamp, 'results.json'),
    openpgpDir: path.join(repoRoot, 'PLAY', 'wasm-build', 'openpgp-bench-node'),
  };

  let options;
  try {
    options = parseArgs(process.argv.slice(2), defaults);
  } catch (error) {
    usage();
    throw error;
  }

  const buildAllScriptPath = path.join(scriptDir, 'build-all.sh');
  const gpgNodeCliPath = path.join(scriptDir, 'gpg-node-cli.sh');

  if (!existsSync(buildAllScriptPath)) {
    throw new Error(`Missing build script: ${buildAllScriptPath}`);
  }
  if (!existsSync(gpgNodeCliPath)) {
    throw new Error(`Missing gpg node CLI: ${gpgNodeCliPath}`);
  }

  const workdir = path.resolve(options.workdir);
  const jsonOut = path.resolve(options.jsonOut);
  const openpgpDir = path.resolve(options.openpgpDir);

  ensureDir(workdir);
  ensureDir(path.dirname(jsonOut));

  if (!options.skipBuild) {
    process.stdout.write('[core-bench] Ensuring gnupg wasm build is available...\n');
    await runCommand('bash', [buildAllScriptPath], {
      cwd: repoRoot,
      inheritOutput: true,
    });
  }

  process.stdout.write('[core-bench] Installing/updating OpenPGP.js dependency...\n');
  const openpgpVersion = await ensureOpenpgpInstall(openpgpDir);
  const openpgp = await loadOpenpgp(openpgpDir);
  process.stdout.write(`[core-bench] OpenPGP.js version: ${openpgpVersion}\n`);

  const inputsDir = path.join(workdir, 'inputs');
  const outputsDir = path.join(workdir, 'outputs');
  const gnupgHome = path.join(workdir, 'gnupg-home');
  const gpgAgentConfPath = path.join(gnupgHome, 'gpg-agent.conf');
  ensureDir(inputsDir);
  ensureDir(outputsDir);
  ensurePrivateDir(gnupgHome);
  writeFileSync(
    gpgAgentConfPath,
    `s2k-count ${options.gnupgAgentS2kCount}\n`,
    'utf8'
  );
  process.stdout.write(`[core-bench] Wrote ${gpgAgentConfPath} (s2k-count ${options.gnupgAgentS2kCount})\n`);

  const binaryInputPath = path.join(inputsDir, `payload-${options.payloadBytes}.bin`);
  const cleartextInputPath = path.join(inputsDir, 'verify-message.txt');
  writeFileSync(binaryInputPath, randomBytes(options.payloadBytes));
  writeFileSync(
    cleartextInputPath,
    `core benchmark message ${new Date().toISOString()}\n`,
    'utf8'
  );

  const binaryInputData = readFileSync(binaryInputPath);
  const cleartextInputData = readFileSync(cleartextInputPath, 'utf8');

  const userTag = `${Date.now()}-${process.pid}`;
  const gnupgUserId = `Core Bench <core-bench-${userTag}@example.test>`;

  async function runWasm(gpgArgs, runOptions = {}) {
    const {
      useAgentBridge = true,
      useDirmngrBridge = false,
      useScdaemonBridge = false,
    } = runOptions;

    const cliArgs = [
      gpgNodeCliPath,
      '--homedir',
      gnupgHome,
    ];

    if (!useAgentBridge) {
      cliArgs.push('--no-agent-bridge');
    }
    if (!useDirmngrBridge) {
      cliArgs.push('--no-dirmngr-bridge');
    }
    if (!useScdaemonBridge) {
      cliArgs.push('--no-scdaemon-bridge');
    }

    cliArgs.push('--', ...gpgArgs);

    return runCommand('bash', cliArgs, {
      cwd: repoRoot,
      env: {
        GNUPGHOME: gnupgHome,
      },
    });
  }

  process.stdout.write('[core-bench] Preparing gnupg wasm key material...\n');
  await runWasm(
    [
      '--pinentry-mode',
      'loopback',
      '--passphrase',
      '',
      '--quick-generate-key',
      gnupgUserId,
      'default',
      'default',
      'never',
    ],
    {
      useAgentBridge: true,
      useDirmngrBridge: false,
      useScdaemonBridge: false,
    }
  );

  const gnupgCipherPath = path.join(outputsDir, 'gnupg-pke-reference.gpg');
  const gnupgClearSignedPath = path.join(outputsDir, 'gnupg-reference.clear.asc');

  await runWasm(
    [
      '--quiet',
      '--trust-model',
      'always',
      '--recipient',
      gnupgUserId,
      '--output',
      gnupgCipherPath,
      '--encrypt',
      binaryInputPath,
    ],
    {
      useAgentBridge: false,
      useDirmngrBridge: false,
      useScdaemonBridge: false,
    }
  );

  await runWasm(
    [
      '--local-user',
      gnupgUserId,
      '--output',
      gnupgClearSignedPath,
      '--clearsign',
      cleartextInputPath,
    ],
    {
      useAgentBridge: true,
      useDirmngrBridge: false,
      useScdaemonBridge: false,
    }
  );

  process.stdout.write('[core-bench] Preparing OpenPGP.js key material...\n');
  const openpgpKeyPair = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519',
    userIDs: [
      {
        name: 'OpenPGP Core Bench',
        email: `openpgp-core-${userTag}@example.test`,
      },
    ],
    passphrase: options.passphrase,
    format: 'armored',
  });

  const openpgpPublicKey = await openpgp.readKey({
    armoredKey: openpgpKeyPair.publicKey,
  });

  const openpgpPrivateKey = await openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({
      armoredKey: openpgpKeyPair.privateKey,
    }),
    passphrase: options.passphrase,
  });

  const openpgpCipherReference = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: binaryInputData }),
    encryptionKeys: openpgpPublicKey,
    format: 'binary',
  });

  const openpgpClearSignedReference = await openpgp.sign({
    message: await openpgp.createCleartextMessage({ text: cleartextInputData }),
    signingKeys: openpgpPrivateKey,
    format: 'armored',
  });

  const measuredPaths = {
    binaryInputPath,
    cleartextInputPath,
    gnupgCipherPath,
    gnupgClearSignedPath,
    gpgAgentConfPath,
  };

  const warmupRounds = Math.min(options.warmupRounds, options.rounds);
  const rounds = options.rounds;
  const wasmChunkSize = Math.min(options.wasmChunkSize, rounds);
  const makeRepeatedPaths = (filePath, count) => Array(count).fill(filePath);

  const tasks = [];

  process.stdout.write('[core-bench] Running task: pke_encrypt_batch\n');
  const wasmEncrypt = await timeWasmChunked(
    rounds,
    warmupRounds,
    wasmChunkSize,
    (chunkCount) => runWasm(
      [
        '--quiet',
        '--trust-model',
        'always',
        '--encrypt-files',
        '--recipient',
        gnupgUserId,
        ...makeRepeatedPaths(binaryInputPath, chunkCount),
      ],
      {
        useAgentBridge: false,
        useDirmngrBridge: false,
        useScdaemonBridge: false,
      }
    )
  );

  const openpgpEncrypt = await timeOpenpgpLoop(rounds, warmupRounds, async () => {
    await openpgp.encrypt({
      message: await openpgp.createMessage({ binary: binaryInputData }),
      encryptionKeys: openpgpPublicKey,
      format: 'binary',
    });
  });

  tasks.push({
    task: 'pke_encrypt_batch',
    rounds,
    warmupRounds,
    wasmChunkSize,
    wasm: wasmEncrypt,
    openpgp: openpgpEncrypt,
    ratioWasmToOpenpgp: wasmEncrypt.perOpMs / openpgpEncrypt.perOpMs,
  });

  process.stdout.write('[core-bench] Running task: pke_decrypt_batch\n');
  const wasmDecrypt = await timeWasmChunked(
    rounds,
    warmupRounds,
    wasmChunkSize,
    (chunkCount) => runWasm(
      [
        '--quiet',
        '--decrypt-files',
        ...makeRepeatedPaths(gnupgCipherPath, chunkCount),
      ],
      {
        useAgentBridge: true,
        useDirmngrBridge: false,
        useScdaemonBridge: false,
      }
    )
  );

  const openpgpDecrypt = await timeOpenpgpLoop(rounds, warmupRounds, async () => {
    const message = await openpgp.readMessage({
      binaryMessage: openpgpCipherReference,
    });
    await openpgp.decrypt({
      message,
      decryptionKeys: openpgpPrivateKey,
      format: 'binary',
    });
  });

  tasks.push({
    task: 'pke_decrypt_batch',
    rounds,
    warmupRounds,
    wasmChunkSize,
    wasm: wasmDecrypt,
    openpgp: openpgpDecrypt,
    ratioWasmToOpenpgp: wasmDecrypt.perOpMs / openpgpDecrypt.perOpMs,
  });

  process.stdout.write('[core-bench] Running task: verify_clearsign_batch\n');
  const wasmVerify = await timeWasmChunked(
    rounds,
    warmupRounds,
    wasmChunkSize,
    (chunkCount) => runWasm(
      ['--quiet', '--verify-files', ...makeRepeatedPaths(gnupgClearSignedPath, chunkCount)],
      {
        useAgentBridge: false,
        useDirmngrBridge: false,
        useScdaemonBridge: false,
      }
    )
  );

  const openpgpVerify = await timeOpenpgpLoop(rounds, warmupRounds, async () => {
    const message = await openpgp.readCleartextMessage({
      cleartextMessage: openpgpClearSignedReference,
    });
    const result = await openpgp.verify({
      message,
      verificationKeys: openpgpPublicKey,
    });
    await result.signatures[0].verified;
  });

  tasks.push({
    task: 'verify_clearsign_batch',
    rounds,
    warmupRounds,
    wasmChunkSize,
    wasm: wasmVerify,
    openpgp: openpgpVerify,
    ratioWasmToOpenpgp: wasmVerify.perOpMs / openpgpVerify.perOpMs,
  });

  const report = {
    createdAt: new Date().toISOString(),
    repoRoot,
    nodeVersion: process.version,
    openpgpVersion,
    config: {
      rounds,
      warmupRounds,
      wasmChunkSize: options.wasmChunkSize,
      gnupgAgentS2kCount: options.gnupgAgentS2kCount,
      gnupgSecretKeyProtection: 'none',
      payloadBytes: options.payloadBytes,
      skipBuild: options.skipBuild,
      passphrase: options.passphrase,
    },
    workdir,
    measuredPaths,
    tasks,
  };

  await fs.writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stdout.write('\n[core-bench] Comparison table (lower per-op is better):\n');
  process.stdout.write(`${renderComparisonTable(tasks)}\n`);
  process.stdout.write(`\n[core-bench] JSON report written to: ${jsonOut}\n`);
}

main().catch((error) => {
  process.stderr.write(`[core-bench] error: ${error.message}\n`);
  if (error.stderr) {
    process.stderr.write(`[core-bench] stderr:\n${error.stderr}\n`);
  }
  if (error.stdout) {
    process.stderr.write(`[core-bench] stdout:\n${error.stdout}\n`);
  }
  process.exit(1);
});
