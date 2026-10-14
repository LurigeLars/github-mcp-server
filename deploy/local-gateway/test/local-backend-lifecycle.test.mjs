// Real Docker regression: background discovery and concurrent clients must reuse
// one backend. A unique non-secret config keeps this test separate from runtime.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { parsePinnedImage } from '../local-mcp/bridge.mjs';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const image = parsePinnedImage(fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8'));
const bridgeUrl = pathToFileURL(path.join(root, 'local-mcp/bridge.mjs')).href;
const docker = args => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });

test('concurrent and successive client processes reuse the same container, including after stop', { timeout: 90_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'github-mcp-lifecycle-'));
  const configFile = path.join(temp, 'github.env');
  fs.writeFileSync(configFile, `GITHUB_TOOLSETS=repos\n# isolated lifecycle test ${path.basename(temp)}\n`);
  const client = `
    import { spawnSync } from 'node:child_process';
    import { readFileSync } from 'node:fs';
    import { ensureLocalBackend } from ${JSON.stringify(bridgeUrl)};
    const configFile = ${JSON.stringify(configFile)};
    const docker = args => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    console.log(JSON.stringify(ensureLocalBackend({ image: ${JSON.stringify(image)}, configFile,
      configText: readFileSync(configFile, 'utf8'), docker })));
  `;
  const connect = async () => JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', client], { windowsHide: true, timeout: 40_000 })).stdout);
  let name;
  try {
    const clients = await Promise.allSettled(Array.from({ length: 4 }, connect));
    name = clients.find(r => r.status === 'fulfilled')?.value.name;
    for (const result of clients) assert.equal(result.status, 'fulfilled', result.reason?.message);
    const first = clients[0].value;
    assert.ok(clients.every(r => r.value.name === first.name));
    const inspect = () => {
      const result = docker(['inspect', '--format', '{{.Id}} {{.RestartCount}} {{.HostConfig.AutoRemove}}', name]);
      assert.equal(result.status, 0);
      return result.stdout.trim();
    };
    const original = inspect();
    assert.match(original, /^[a-f0-9]{64} 0 false$/);
    assert.deepEqual(await connect(), first);
    assert.equal(inspect(), original, 'client process exit must leave the same backend running');
    assert.equal(docker(['stop', name]).status, 0);
    const restarted = await connect();
    assert.equal(restarted.name, name);
    assert.equal(inspect(), original, 'Docker stop/reconnect must start the existing container');

    const replies = [];
    const { createForwarder } = await import('../local-mcp/bridge.mjs');
    const forward = createForwarder({ endpoint: restarted.endpoint, getToken: () => 'ghp_' + '0'.repeat(36), emit: reply => replies.push(reply), timeoutMs: 5000 });
    for (let attempt = 0; attempt < 40; attempt++) {
      await forward(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      if (replies.at(-1)?.result?.tools) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(replies.at(-1)?.result?.tools.length > 0, 'shared backend must answer MCP tools/list');
  } finally {
    if (name) assert.equal(docker(['rm', '-f', name]).status, 0);
    fs.unlinkSync(configFile);
    fs.rmdirSync(temp);
  }
});
