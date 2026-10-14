// Local stdio MCP proxy for Claude Code, Claude Desktop and Codex.
//
// Secret path (unchanged storage, same pattern as github-mcp.ps1):
//   DPAPI file -> Read-DpapiSecret in a child pwsh -> stdout pipe -> this process memory
//   -> per-request Authorization header over 127.0.0.1 to a shared official backend.
// The PAT is never written to a file, command-line argument, Docker Config.Env, image
// layer or log. The production gateway, its tmpfs import and its private backend network
// are not touched. The backend image is the exact pin from compose.yaml.
//
// Usage: node stdio-proxy.mjs   (Windows, Docker Desktop and PowerShell 7 required)

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  LOCAL_CONTAINER_LABEL,
  LOCAL_OWNER_PID_LABEL,
  createForwarder,
  ensureLocalBackend,
  parsePinnedImage,
  validateRuntimeToken,
} from './bridge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = message => process.stderr.write(`[github-local] ${message}\n`);
const fail = message => {
  log(message);
  process.exit(1);
};

if (process.platform !== 'win32') fail('this proxy uses Windows DPAPI and is supported on Windows only');
if (!process.env.LOCALAPPDATA) fail('LOCALAPPDATA is required');

// Non-secret toolset/lockdown config. Overridable only so a development worktree can be
// tested against the runtime copy's gitignored config without copying it.
const configFile = process.env.GITHUB_MCP_LOCAL_CONFIG_FILE || join(ROOT, 'config', 'github.env');
if (!/github\.env$/i.test(configFile)) fail('GITHUB_MCP_LOCAL_CONFIG_FILE must point to a github.env file');
const secretStore = join(ROOT, 'scripts', 'secret-store.ps1');
for (const path of [configFile, secretStore]) {
  if (!existsSync(path)) fail(`required runtime file is missing: ${path}`);
}

const image = parsePinnedImage(readFileSync(join(ROOT, 'compose.yaml'), 'utf8'));
const docker = args => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });

function readPatFromDpapi() {
  const literal = secretStore.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `. '${literal}'`,
    "[Console]::Out.Write((Read-DpapiSecret -Path (Join-Path (Get-GitHubMcpSecretRoot) 'github_pat.dpapi')))",
  ].join('; ');
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024,
  });
  if (r.error || r.status !== 0) fail(`DPAPI PAT read failed (pwsh exit ${r.status ?? 'n/a'})`);
  return validateRuntimeToken(r.stdout);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function removeOrphanedBackends() {
  const r = docker(['ps', '-a', '--filter', `label=${LOCAL_CONTAINER_LABEL}=1`, '--format', `{{.ID}} {{.Label "${LOCAL_OWNER_PID_LABEL}"}}`]);
  if (r.status !== 0) return;
  for (const line of r.stdout.split(/\r?\n/)) {
    const [id, pid] = line.trim().split(/\s+/);
    if (id && !pidAlive(Number(pid))) docker(['rm', '-f', id]);
  }
}

let token = readPatFromDpapi();
process.on('exit', () => { token = null; });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
process.on('uncaughtException', () => {
  log('unexpected proxy error; shutting down');
  process.exit(1);
});

removeOrphanedBackends();

const { name, endpoint } = await ensureLocalBackend({
  image, configFile, configText: readFileSync(configFile, 'utf8'), docker,
});

async function waitReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(endpoint, { method: 'GET', signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  fail('local GitHub MCP backend did not become reachable');
}
await waitReady();
log(`ready (${image.split('@')[0]}, shared loopback backend ${name})`);

const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const handleLine = createForwarder({
  endpoint,
  getToken: () => {
    if (!token) throw new Error('token unavailable');
    return token;
  },
  emit,
});

const pending = new Set();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const p = handleLine(line).catch(() => log('request handling failed')).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
