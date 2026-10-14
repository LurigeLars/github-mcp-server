// Building blocks for the local stdio proxy (Claude Code, Claude Desktop, Codex).
// Docker access is injected; this module never launches processes or reads secrets.

import { createHash } from 'node:crypto';

import {
  checkRequestPolicy,
  rewriteLocalClientResponse,
  secretResultIdsFromRequest,
} from '../public/policy.mjs';

export const LOCAL_CONTAINER_LABEL = 'com.lurigelars.github-mcp-local.stdio';
export const LOCAL_OWNER_PID_LABEL = 'com.lurigelars.github-mcp-local.stdio.owner-pid';
export const SHARED_CONTAINER_LABEL = 'com.lurigelars.github-mcp-local.shared-stdio';
export const BACKEND_PORT = 8082;

// The pinned official image is read from compose.yaml so the local proxy can never
// drift from the deployed gateway backend.
export function parsePinnedImage(composeText) {
  const match = /^\s*image:\s*(ghcr\.io\/github\/github-mcp-server:v[^@\s]+@sha256:[0-9a-f]{64})\s*$/m.exec(composeText);
  if (!match) throw new Error('compose.yaml does not contain a pinned official github-mcp-server image');
  return match[1];
}

// The GitHub PAT is deliberately absent: the backend runs in HTTP mode and receives
// the token only as a per-request Authorization header from this process.
export function buildDockerRunArgs({ image, configFile, name }) {
  return [
    'run', '-d',
    '--name', name,
    '--label', `${SHARED_CONTAINER_LABEL}=1`,
    '--publish', `127.0.0.1::${BACKEND_PORT}`,
    '--user', '65532:65532',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '100',
    '--memory', '512m',
    '--cpus', '1.0',
    '--env-file', configFile,
    image,
    'http',
    `--port=${BACKEND_PORT}`,
    '--listen-host=0.0.0.0',
  ];
}

// A backend belongs to its pinned image/config, not to a short-lived MCP client.
// shortcut: old image/config backends need explicit retirement after their clients exit.
export function ensureLocalBackend({ image, configFile, configText, docker }) {
  const key = createHash('sha256').update(image).update('\0').update(configText).digest('hex').slice(0, 16);
  const name = `github-mcp-local-stdio-${key}`;
  const inspect = () => docker(['inspect', '--format',
    `{"image":{{json .Config.Image}},"shared":{{json (index .Config.Labels "${SHARED_CONTAINER_LABEL}")}},"running":{{json .State.Running}}}`, name]);
  let state = inspect();
  if (state.status !== 0) {
    docker(buildDockerRunArgs({ image, configFile, name }));
    // A concurrent client may have won the name; inspect that same backend.
    state = inspect();
  }
  if (state.status !== 0) throw new Error('failed to create the shared local GitHub MCP backend');
  const backend = JSON.parse(state.stdout);
  if (backend.image !== image || backend.shared !== '1') throw new Error('shared local GitHub MCP backend identity mismatch');
  if (backend.running === false) {
    if (docker(['start', name]).status !== 0) throw new Error('failed to start the shared local GitHub MCP backend');
  } else if (backend.running !== true) {
    throw new Error('invalid shared local GitHub MCP backend state');
  }
  const port = docker(['port', name, `${BACKEND_PORT}/tcp`]);
  if (port.status !== 0) throw new Error('failed to resolve the shared local GitHub MCP backend port');
  return { name, endpoint: `http://127.0.0.1:${parseDockerPort(port.stdout)}/` };
}

export function parseDockerPort(output) {
  const m = /^127\.0\.0\.1:(\d+)$/.exec(String(output).trim());
  if (m && Number(m[1]) > 0 && Number(m[1]) <= 65535) return Number(m[1]);
  throw new Error('local GitHub MCP backend is not published on 127.0.0.1');
}

export function validateRuntimeToken(raw) {
  const value = String(raw ?? '').trim();
  if (value.length < 20 || value.length > 4096 || /[\s]/.test(value)) {
    throw new Error('DPAPI-protected GitHub PAT is missing or invalid');
  }
  return value;
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function parseSseMessages(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // ignore non-JSON SSE payloads such as keep-alives
    }
  }
  return out;
}

// Creates a line handler that forwards one JSON-RPC message (or batch) per line to the
// stateless upstream Streamable HTTP endpoint and writes rewritten responses to `emit`.
export function createForwarder({ endpoint, getToken, emit, fetchImpl = fetch, timeoutMs = 330_000 }) {
  let protocolVersion = null;

  return async function handleLine(line) {
    if (!line.trim()) return;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      emit(rpcError(null, -32700, 'parse error'));
      return;
    }

    const messages = [parsed].flat();
    const requestIds = messages.filter(m => m && m.id !== undefined && m.method).map(m => m.id);

    const violation = checkRequestPolicy(parsed);
    if (violation) {
      for (const id of requestIds) emit(rpcError(id, -32001, 'blocked by local GitHub gateway policy: ' + violation.message));
      return;
    }

    const secretIds = secretResultIdsFromRequest(parsed);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${getToken()}`,
    };
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;

    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(parsed),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      for (const id of requestIds) emit(rpcError(id, -32002, 'local GitHub MCP backend unavailable'));
      return;
    }

    const type = String(res.headers.get('content-type') ?? '');
    const text = await res.text();
    let replies = [];
    if (type.includes('text/event-stream')) {
      replies = parseSseMessages(text);
    } else if (text.trim()) {
      try {
        replies = [JSON.parse(text)].flat();
      } catch {
        replies = [];
      }
    }

    if (!res.ok && replies.length === 0) {
      for (const id of requestIds) emit(rpcError(id, -32003, `local GitHub MCP backend returned HTTP ${res.status}`));
      return;
    }

    for (const reply of replies) {
      if (reply?.result?.protocolVersion && typeof reply.result.protocolVersion === 'string') {
        protocolVersion = reply.result.protocolVersion;
      }
      emit(rewriteLocalClientResponse(reply, secretIds));
    }
  };
}
