import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const compose = readFileSync(join(root, 'compose.yaml'), 'utf8');
const gateway = readFileSync(join(root, 'public', 'gateway.mjs'), 'utf8');
const runner = readFileSync(join(root, 'github-mcp.ps1'), 'utf8');
const configure = readFileSync(join(root, 'scripts', 'configure_secrets.ps1'), 'utf8');

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(err => err ? reject(err) : resolvePort(port));
    });
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`gateway exited early: ${child.exitCode}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error('gateway health timeout');
}

test('compose keeps GitHub credentials out of container Config.Env', () => {
  assert.doesNotMatch(compose, /GITHUB_PERSONAL_ACCESS_TOKEN/);
  assert.doesNotMatch(compose, /GITHUB_MCP_SECRETS_FILE/);
  assert.match(compose, /\/run\/github-mcp-secrets:rw,nosuid,nodev,noexec,size=64k,uid=1000,gid=1000,mode=0700/);
  assert.match(compose, /GITHUB_PAT_FILE:\s*\/run\/github-mcp-secrets\/github_pat/);
});

test('gateway reads PAT and fallback secret from runtime files rather than env values', () => {
  assert.doesNotMatch(gateway, /process\.env\.GITHUB_PERSONAL_ACCESS_TOKEN/);
  assert.doesNotMatch(gateway, /process\.env\.GATEWAY_SECRET\b/);
  assert.match(gateway, /readFileSync/);
  assert.match(gateway, /github_pat/);
  assert.match(gateway, /gateway_secret/);
});

test('Windows runtime uses DPAPI and stdin injection into tmpfs', () => {
  assert.match(configure, /ConvertFrom-SecureString/);
  assert.match(configure, /ConvertTo-SecureString/);
  assert.match(runner, /docker @Compose exec -T --user 1000:1000 github-gateway/);
  assert.match(runner, /cat > '\$ContainerPath'/);
  assert.doesNotMatch(runner, /-e\s+GITHUB_PERSONAL_ACCESS_TOKEN/);
});

test('gateway starts with file-backed fake secrets without PAT in environment', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcp-gateway-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pat = join(dir, 'pat');
  const fallback = join(dir, 'fallback');
  writeFileSync(pat, 'github_pat_test_value_12345678901234567890');
  writeFileSync(fallback, 'fallback-test-value-123456789012345678901234');
  const port = await freePort();

  const env = {
    ...process.env,
    PORT: String(port),
    GITHUB_PAT_FILE: pat,
    GATEWAY_SECRET_FILE: fallback,
    ACCESS_AUD: '',
    ACCESS_TEAM_DOMAIN: '',
    ACCESS_ALLOWED_EMAILS: '',
    ALLOW_SECRET_PATH: '1',
  };
  delete env.GITHUB_PERSONAL_ACCESS_TOKEN;
  delete env.GATEWAY_SECRET;

  const child = spawn(process.execPath, [join(root, 'public', 'gateway.mjs')], {
    cwd: join(root, 'public'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForHealth(port, child);
  assert.equal(child.exitCode, null);
});

test('gateway fails closed when PAT runtime file is absent', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, 'public', 'gateway.mjs')], {
    cwd: join(root, 'public'),
    env: {
      ...process.env,
      PORT: String(port),
      GITHUB_PAT_FILE: join(tmpdir(), `missing-${process.pid}-${Date.now()}`),
      ACCESS_AUD: '',
      ALLOW_SECRET_PATH: '1',
      GATEWAY_SECRET_FILE: join(tmpdir(), `also-missing-${process.pid}-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = await new Promise(resolveExit => child.once('exit', resolveExit));
  assert.equal(code, 1);
});
