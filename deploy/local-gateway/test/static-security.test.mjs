import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const compose = read('compose.yaml');
const gateway = read('public/gateway.mjs');
const envExample = read('config/gateway.env.example');
const runner = read('github-mcp.ps1');
const configure = read('scripts/configure_secrets.ps1');
const smokeCompose = read('test/runtime-secret-smoke.compose.yaml');

const forbiddenPersistent = [
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'GITHUB_MCP_SECRETS_FILE',
  'GATEWAY_SECRET=',
  'GITHUB_PAT_RUNTIME',
];

test('compose does not persist GitHub credentials in service environment', () => {
  for (const marker of forbiddenPersistent) {
    assert.equal(compose.includes(marker), false, `compose contains ${marker}`);
  }
  assert.match(compose, /\/run\/github-mcp-secrets:rw,nosuid,nodev,noexec,size=64k,uid=1000,gid=1000,mode=0700/);
  assert.match(compose, /GITHUB_PAT_FILE:\s*\/run\/github-mcp-secrets\/github_pat/);
});

test('committed gateway routes PAT only to the private GitHub MCP backend', () => {
  assert.match(compose, /UPSTREAM_HOST:\s*github-mcp/);
  assert.match(compose, /UPSTREAM_PORT:\s*"8082"/);
  assert.match(compose, /github_backend:/);
  assert.equal(/^\s*ports:/m.test(compose), false, 'compose must not publish host ports');
});

test('gateway consumes credential from tmpfs and removes the file', () => {
  assert.match(gateway, /\/run\/github-mcp-secrets\/github_pat/);
  assert.equal(gateway.includes('process.env.GITHUB_PERSONAL_ACCESS_TOKEN'), false);
  assert.doesNotMatch(gateway, /process\.env\.GATEWAY_SECRET\b/);
  assert.match(gateway, /unlinkSync/);
  assert.match(gateway, /const TOKEN = consumeRuntimeSecret/);
});

test('Windows runtime uses DPAPI and stdin injection rather than secret env', () => {
  assert.match(configure, /Write-DpapiSecret/);
  assert.match(configure, /Read-DpapiSecret/);
  assert.match(runner, /docker @Compose exec -T --user 1000:1000 github-gateway/);
  assert.doesNotMatch(runner, /\$env:GITHUB_PAT_RUNTIME/);
  assert.doesNotMatch(runner, /-e\s+GITHUB_PERSONAL_ACCESS_TOKEN/);
});

test('every runtime secret import recreates the gateway first', () => {
  assert.match(runner, /function Start-GatewayForSecretImport/);
  assert.match(runner, /up -d --force-recreate github-gateway/);
  assert.match(runner, /'up'[\s\S]*Start-GatewayForSecretImport/);
  assert.match(runner, /'import-secrets'[\s\S]*Start-GatewayForSecretImport/);
});

test('gateway config example contains no runtime credential key', () => {
  assert.equal(envExample.includes('GITHUB_PERSONAL_ACCESS_TOKEN'), false);
  assert.equal(envExample.includes('GATEWAY_SECRET='), false);
});

test('runtime smoke stack is isolated from production networks and hooks', () => {
  assert.equal(smokeCompose.includes('edge:'), false);
  assert.equal(smokeCompose.includes('github_backend'), false);
  assert.equal(smokeCompose.includes('post_start:'), false);
  assert.equal(smokeCompose.includes('GITHUB_PAT_RUNTIME'), false);
  assert.match(smokeCompose, /github-gateway-smoke/);
});
