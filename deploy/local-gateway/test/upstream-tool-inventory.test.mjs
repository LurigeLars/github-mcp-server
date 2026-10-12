// Regression check of the upstream tool inventory against the gateway policy.
//
// policy.mjs restricts writes by tool name. A write tool the policy does not know is
// announced to ChatGPT as read-only and escapes the owner restriction, so an image bump
// that adds or renames a write tool must fail here before it is merged.
//
// The pinned image answers tools/list for a correctly formatted placeholder token without
// calling GitHub, so this needs Docker but no credential. Upstream marks every tool with
// readOnlyHint; that marking is the source of truth for "write".
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parsePinnedImage } from '../local-mcp/bridge.mjs';
import { CHATGPT_DENIED_TOOLS, CHATGPT_WRITE_TOOLS } from '../public/policy.mjs';

// Upstream write tools in toolsets this deployment does not enable. Before enabling one of
// those toolsets, move its tools into CHATGPT_WRITE_TOOLS or CHATGPT_DENIED_TOOLS.
const UNDEPLOYED_UPSTREAM_WRITE_TOOLS = new Set([
  'assign_copilot_to_issue_with_intent',
  'create_gist',
  'dismiss_notification',
  'manage_notification_subscription',
  'manage_repository_notification_subscription',
  'mark_all_notifications_read',
  'projects_write',
  'star_repository',
  'unstar_repository',
  'update_gist',
]);

const root = path.resolve(import.meta.dirname, '..');
const image = parsePinnedImage(fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8'));
const container = `github-mcp-inventory-check-${process.pid}`;
const docker = args => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });

async function listUpstreamTools() {
  const run = docker([
    'run', '-d', '--rm', '--name', container,
    '--publish', '127.0.0.1::8082',
    '--user', '65532:65532', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--env', 'GITHUB_TOOLSETS=all',
    image, 'http', '--port=8082', '--listen-host=0.0.0.0',
  ]);
  assert.equal(run.status, 0, `docker run failed: ${run.stderr}`);
  try {
    const port = docker(['port', container, '8082/tcp']).stdout.trim().split(':').pop();
    let lastError;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            // Placeholder with a valid shape; never sent to GitHub by tools/list.
            authorization: 'Bearer ghp_' + '0'.repeat(36),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        const data = text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('') || text;
        return JSON.parse(data).result.tools;
      } catch (err) {
        lastError = err;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    throw lastError;
  } finally {
    docker(['stop', container]);
  }
}

test('every upstream write tool is covered by the gateway policy', async () => {
  const tools = await listUpstreamTools();
  const names = new Set(tools.map(tool => tool.name));
  assert.ok(names.size > 50, `unexpectedly small upstream tool list: ${names.size}`);

  const unmarked = tools.filter(tool => typeof tool.annotations?.readOnlyHint !== 'boolean').map(tool => tool.name);
  assert.deepEqual(unmarked, [], 'upstream tools without readOnlyHint cannot be classified');

  const upstreamWrite = tools.filter(tool => tool.annotations.readOnlyHint !== true).map(tool => tool.name);
  const unknownWrite = upstreamWrite.filter(name =>
    !CHATGPT_WRITE_TOOLS.has(name) &&
    !CHATGPT_DENIED_TOOLS.has(name) &&
    !UNDEPLOYED_UPSTREAM_WRITE_TOOLS.has(name));
  assert.deepEqual(unknownWrite.sort(), [],
    `${image.split('@')[0]} has write tools the policy does not know; classify them in policy.mjs`);

  // Denied names are not checked: denying a tool upstream does not ship is harmless.
  const vanished = [...CHATGPT_WRITE_TOOLS, ...UNDEPLOYED_UPSTREAM_WRITE_TOOLS]
    .filter(name => !names.has(name));
  assert.deepEqual(vanished.sort(), [],
    'policy names missing upstream; a renamed write tool would lose its restriction');

  const mislabeled = tools
    .filter(tool => tool.annotations.readOnlyHint === true && CHATGPT_WRITE_TOOLS.has(tool.name))
    .map(tool => tool.name);
  assert.deepEqual(mislabeled, [], 'policy write tools that upstream now marks read-only');
});
