import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {
  buildDockerRunArgs,
  createForwarder,
  ensureLocalBackend,
  parseDockerPort,
  parsePinnedImage,
  validateRuntimeToken,
  SHARED_CONTAINER_LABEL,
} from '../local-mcp/bridge.mjs';
import { CHATGPT_HIDDEN_TOOLS, rewriteResponse } from '../public/policy.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const compose = read('compose.yaml');
const proxy = read('local-mcp/stdio-proxy.mjs');
const bridge = read('local-mcp/bridge.mjs');
const FAKE_TOKEN = 'ghp_TESTONLY_' + 'x'.repeat(30);

test('local backend uses the exact compose image pin', () => {
  const image = parsePinnedImage(compose);
  assert.ok(compose.includes(`image: ${image}`));
  assert.throws(() => parsePinnedImage('image: ghcr.io/github/github-mcp-server:latest'));
});

test('docker run arguments never carry credentials and bind only to loopback', () => {
  const args = buildDockerRunArgs({ image: parsePinnedImage(compose), configFile: 'C:\\x\\config\\github.env', name: 'n' });
  const joined = args.join(' ');
  assert.equal(args.includes('-e'), false);
  assert.equal(args.includes('--env'), false);
  assert.doesNotMatch(joined, /GITHUB_PERSONAL_ACCESS_TOKEN|secrets\.env|github_pat|ghp_/i);
  assert.equal(args.filter(a => a === '--env-file').length, 1);
  assert.ok(args[args.indexOf('--env-file') + 1].endsWith('github.env'));
  assert.ok(args.includes('127.0.0.1::8082'));
  assert.ok(args.includes('--read-only'));
  assert.equal(args.includes('--rm'), false, 'client exit must not remove the shared backend');
  assert.ok(args.includes(`${SHARED_CONTAINER_LABEL}=1`));
  assert.doesNotMatch(joined, /owner-pid/);
  assert.deepEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
  assert.deepEqual(args.slice(-3), ['http', '--port=8082', '--listen-host=0.0.0.0']);
});

test('successive clients reuse one backend and a stopped backend is started without recreation', async () => {
  const image = parsePinnedImage(compose);
  const calls = [];
  let exists = false;
  let running = true;
  const docker = args => {
    calls.push(args);
    if (args[0] === 'inspect') return exists
      ? { status: 0, stdout: JSON.stringify({ image, shared: '1', running }) }
      : { status: 1 };
    if (args[0] === 'run') { exists = true; return { status: 0 }; }
    if (args[0] === 'start') { running = true; return { status: 0 }; }
    if (args[0] === 'port') return { status: 0, stdout: '127.0.0.1:49152\n' };
    assert.fail('unexpected Docker operation: ' + args[0]);
  };
  const connect = () => ensureLocalBackend({ image, configFile: 'github.env', configText: 'GITHUB_TOOLSETS=repos', docker });
  const first = await connect();
  assert.deepEqual(await connect(), first);
  running = false;
  assert.deepEqual(await connect(), first);
  assert.equal(calls.filter(args => args[0] === 'run').length, 1);
  assert.equal(calls.filter(args => args[0] === 'start').length, 1);
  assert.equal(first.endpoint, 'http://127.0.0.1:49152/');
});

test('a concurrent name reservation is reused after inspect becomes available', async () => {
  const image = parsePinnedImage(compose);
  let inspections = 0;
  const docker = args => {
    if (args[0] === 'inspect') return ++inspections <= 3
      ? { status: 1 }
      : { status: 0, stdout: JSON.stringify({ image, shared: '1', running: true }) };
    if (args[0] === 'run') return { status: 125, stderr: 'Conflict. The container name is already in use.' };
    if (args[0] === 'port') return { status: 0, stdout: '127.0.0.1:49152\n' };
    assert.fail('unexpected Docker operation: ' + args[0]);
  };
  assert.equal((await ensureLocalBackend({ image, configFile: 'github.env', configText: '', docker })).endpoint, 'http://127.0.0.1:49152/');
  assert.equal(inspections, 4);
});

test('wrong backend identity and Docker failure fail closed', async () => {
  const image = parsePinnedImage(compose);
  for (const stdout of [JSON.stringify({ image: 'wrong-image', shared: '1', running: true }), JSON.stringify({ image, shared: '', running: true })]) {
    await assert.rejects(() => ensureLocalBackend({ image, configFile: 'github.env', configText: '',
      docker: args => { assert.equal(args[0], 'inspect'); return { status: 0, stdout }; },
    }), /identity mismatch/);
  }
  await assert.rejects(() => ensureLocalBackend({ image, configFile: 'github.env', configText: '',
    docker: () => ({ status: 1 }),
  }), /failed to create/);
});

test('proxy source keeps the DPAPI path and never persists or logs the PAT', () => {
  assert.match(proxy, /Read-DpapiSecret/);
  assert.match(proxy, /github_pat\.dpapi/);
  assert.doesNotMatch(proxy, /secrets\.env|GITHUB_MCP_SECRETS_FILE|GITHUB_PERSONAL_ACCESS_TOKEN/);
  assert.doesNotMatch(proxy, /writeFile|appendFile|createWriteStream/);
  assert.doesNotMatch(proxy, /log\([^)]*token/i);
  assert.doesNotMatch(proxy, /'-e'|"--env"/);
  assert.doesNotMatch(bridge, /console\.|process\.stderr/);
});

test('helpers validate port output and runtime token shape', () => {
  assert.equal(parseDockerPort('127.0.0.1:49152\n'), 49152);
  assert.throws(() => parseDockerPort('0.0.0.0:49152\n'));
  assert.throws(() => parseDockerPort('127.0.0.1:49152\n0.0.0.0:49152\n'));
  assert.throws(() => parseDockerPort('127.0.0.1:65536\n'));
  assert.equal(validateRuntimeToken(`  ${FAKE_TOKEN}\r\n`), FAKE_TOKEN);
  assert.throws(() => validateRuntimeToken(''));
  assert.throws(() => validateRuntimeToken('short'));
  assert.throws(() => validateRuntimeToken('has space ' + 'x'.repeat(30)));
});

const upstreamTools = [
  { name: 'get_file_contents' },
  { name: 'search_code' },
  { name: 'create_pull_request' },
  { name: 'create_repository' },
  { name: 'delete_repository' },
  { name: 'list_secret_scanning_alerts' },
];

function startMockBackend({ sse = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
        res.writeHead(401).end('unauthorized');
        return;
      }
      const msg = JSON.parse(body);
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result;
      if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock' } };
      else if (msg.method === 'tools/list') result = { tools: upstreamTools };
      else if (msg.params?.name === 'list_secret_scanning_alerts') result = { content: [{ type: 'text', text: JSON.stringify([{ number: 1, secret: 'leaked-value' }]) }] };
      else result = { content: [{ type: 'text', text: 'ok' }] };
      const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${reply}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(reply);
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, endpoint: `http://127.0.0.1:${server.address().port}/` })));
}

async function exchange(lines, opts = {}) {
  const backend = await startMockBackend(opts);
  const out = [];
  const handle = createForwarder({ endpoint: backend.endpoint, getToken: () => opts.token ?? FAKE_TOKEN, emit: m => out.push(m) });
  for (const line of lines) await handle(typeof line === 'string' ? line : JSON.stringify(line));
  backend.server.close();
  return { out, seen: backend.seen };
}

for (const sse of [false, true]) {
  test(`positive: full upstream tool list minus denied tools (${sse ? 'SSE' : 'JSON'})`, async () => {
    const { out, seen } = await exchange([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ], { sse });
    assert.equal(out.length, 2);
    const names = out[1].result.tools.map(t => t.name);
    assert.deepEqual(names, ['get_file_contents', 'search_code', 'create_pull_request', 'list_secret_scanning_alerts']);
    assert.ok(names.some(n => CHATGPT_HIDDEN_TOOLS.has(n)), 'ChatGPT-hidden tools must stay visible locally');
    assert.ok(seen.every(r => r.headers.authorization === `Bearer ${FAKE_TOKEN}`));
    assert.equal(seen[2].headers['mcp-protocol-version'], '2025-06-18');
    assert.ok(seen.every(r => !Object.keys(r.headers).some(h => h.startsWith('x-mcp-'))));
  });
}

test('gateway (ChatGPT) surface is unchanged and still hides duplicates', () => {
  const msg = { jsonrpc: '2.0', id: 1, result: { tools: upstreamTools } };
  const names = rewriteResponse(msg, new Set(), new Set(), new Set()).result.tools.map(t => t.name);
  assert.deepEqual(names, ['list_secret_scanning_alerts']);
});

test('positive: read call is forwarded and secret scanning values are redacted', async () => {
  const { out } = await exchange([
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_file_contents', arguments: { owner: 'octocat', repo: 'Hello-World', path: 'README' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_secret_scanning_alerts', arguments: { owner: 'LurigeLars', repo: 'x' } } },
  ]);
  assert.equal(out[0].result.content[0].text, 'ok');
  assert.doesNotMatch(JSON.stringify(out[1]), /leaked-value/);
  assert.match(JSON.stringify(out[1]), /REDACTED_BY_LOCAL_GATEWAY/);
});

test('negative: denied tools and foreign-owner writes never reach the backend', async () => {
  const { out, seen } = await exchange([
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'delete_repository', arguments: { owner: 'LurigeLars', repo: 'x' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'create_pull_request', arguments: { owner: 'someone-else', repo: 'x' } } },
  ]);
  assert.equal(seen.length, 0);
  assert.equal(out.length, 2);
  for (const reply of out) assert.match(reply.error.message, /blocked by local GitHub gateway policy/);
});

test('negative: wrong token and malformed input produce errors, not crashes', async () => {
  const { out } = await exchange([
    'not json',
    { jsonrpc: '2.0', id: 7, method: 'tools/list' },
  ], { token: 'ghp_wrong_' + 'y'.repeat(30) });
  assert.equal(out[0].error.code, -32700);
  assert.match(out[1].error.message, /HTTP 401/);
  assert.doesNotMatch(JSON.stringify(out), /ghp_/);
});

test('negative: unreachable backend yields a JSON-RPC error', async () => {
  const out = [];
  const handle = createForwarder({ endpoint: 'http://127.0.0.1:9/', getToken: () => FAKE_TOKEN, emit: m => out.push(m), timeoutMs: 2000 });
  await handle(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }));
  assert.match(out[0].error.message, /unavailable/);
});
