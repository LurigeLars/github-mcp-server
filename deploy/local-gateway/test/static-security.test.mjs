import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  inlineTextResultIdsFromRequest,
  rewriteJsonText,
} from '../public/policy.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const compose = read('compose.yaml');
const gateway = read('public/gateway.mjs');
const envExample = read('config/gateway.env.example');
const runner = read('github-mcp.ps1');
const syncRuntime = read('sync-runtime.ps1');
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

test('GitHub gateway uses a dedicated edge network', () => {
  assert.match(compose, /name:\s*github-public_edge/);
  assert.equal(compose.includes('MCP_EDGE_NETWORK'), false);
  assert.equal(compose.includes('firecrawl_edge'), false);
  assert.match(runner, /\$EdgeNetwork = 'github-public_edge'/);
  assert.match(runner, /docker network connect \$EdgeNetwork/);
  assert.match(runner, /Expected exactly one running cloudflared service container/);
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

test('runtime sync preserves local config and only copies tracked runtime files', () => {
  assert.match(syncRuntime, /protected = @\(/);
  assert.match(syncRuntime, /"\.env"/);
  assert.match(syncRuntime, /"config\\github\.env"/);
  assert.match(syncRuntime, /"config\\gateway\.env"/);
  assert.match(syncRuntime, /Copy-TrackedFile/);
  assert.match(syncRuntime, /Copy-TrackedTree "public"/);
  assert.match(syncRuntime, /Copy-TrackedTree "scripts"/);
  assert.doesNotMatch(syncRuntime, /Remove-Item[\s\S]*\.env/);
  assert.doesNotMatch(syncRuntime, /Copy-Item[\s\S]*secrets\\/);
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
});


test('own-repo text file resources are inlined for ChatGPT without request correlation', () => {
  const response = JSON.stringify({
    jsonrpc: '2.0',
    id: 41,
    result: {
      content: [
        { type: 'text', text: 'successfully downloaded text file' },
        {
          type: 'resource',
          resource: {
            uri: 'repo://LurigeLars/github-mcp-server/refs/heads/main/contents/AGENTS.md',
            mimeType: 'text/plain; charset=utf-8',
            text: '# Repository instructions',
          },
        },
      ],
      isError: false,
    },
  });

  const rewritten = JSON.parse(rewriteJsonText(response, new Set(), new Set()));
  assert.deepEqual(rewritten.result.content[1], {
    type: 'text',
    text: '# Repository instructions',
  });
});

test('text resource inlining is scoped to own repos and leaves binary and large resources untouched', () => {
  const foreignTextResponse = JSON.stringify({
    jsonrpc: '2.0',
    id: 42,
    result: {
      content: [{
        type: 'resource',
        resource: {
          uri: 'repo://github/github-mcp-server/refs/heads/main/contents/README.md',
          mimeType: 'text/plain',
          text: '# Upstream',
        },
      }],
      isError: false,
    },
  });
  const foreignRewritten = JSON.parse(rewriteJsonText(foreignTextResponse, new Set(), new Set()));
  assert.equal(foreignRewritten.result.content[0].type, 'resource');

  const binaryResponse = JSON.stringify({
    jsonrpc: '2.0',
    id: 43,
    result: {
      content: [{
        type: 'resource',
        resource: {
          uri: 'repo://LurigeLars/github-mcp-server/refs/heads/main/contents/logo.png',
          mimeType: 'image/png',
          blob: 'AAEC',
        },
      }],
      isError: false,
    },
  });
  const binaryRewritten = JSON.parse(rewriteJsonText(binaryResponse, new Set(), new Set()));
  assert.equal(binaryRewritten.result.content[0].type, 'resource');
  assert.equal(binaryRewritten.result.content[0].resource.blob, 'AAEC');

  const largeTextResponse = JSON.stringify({
    jsonrpc: '2.0',
    id: 44,
    result: {
      content: [{
        type: 'resource',
        resource: {
          uri: 'repo://LurigeLars/github-mcp-server/refs/heads/main/contents/large.txt',
          mimeType: 'text/plain',
          text: 'x'.repeat(128 * 1024 + 1),
        },
      }],
      isError: false,
    },
  });
  const largeRewritten = JSON.parse(rewriteJsonText(largeTextResponse, new Set(), new Set()));
  assert.equal(largeRewritten.result.content[0].type, 'resource');
});
