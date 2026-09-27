import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const compose = read('compose.yaml');
const gateway = read('public/gateway.mjs');
const envExample = read('config/gateway.env.example');

const forbiddenPersistent = [
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'GITHUB_MCP_SECRETS_FILE',
  'GATEWAY_SECRET=',
];

test('compose does not persist GitHub credentials in service environment', () => {
  for (const marker of forbiddenPersistent) {
    assert.equal(compose.includes(marker), false, `compose contains ${marker}`);
  }
  assert.match(compose, /\/run\/github-mcp-secrets:.*tmpfs|\/run\/github-mcp-secrets:/s);
  assert.match(compose, /post_start:/);
  assert.match(compose, /GITHUB_PAT_RUNTIME/);
});

test('gateway reads credential from tmpfs, not process env', () => {
  assert.match(gateway, /\/run\/github-mcp-secrets\/github_pat/);
  assert.equal(gateway.includes('process.env.GITHUB_PERSONAL_ACCESS_TOKEN'), false);
  assert.match(gateway, /unlinkSync/);
});

test('gateway config example contains no runtime credential key', () => {
  assert.equal(envExample.includes('GITHUB_PERSONAL_ACCESS_TOKEN'), false);
  assert.equal(envExample.includes('GATEWAY_SECRET'), false);
});
