// Public Cloudflare gatekeeper for the official GitHub MCP HTTP server.
// GitHub credentials are read from a runtime tmpfs file, never container env.
// Node standard library only.

import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  checkRequestPolicy,
  secretResultIdsFromRequest,
  rewriteJsonText,
  rewriteSseLine,
} from './policy.mjs';

const GITHUB_PAT_FILE = process.env.GITHUB_PAT_FILE ?? '/run/github-mcp-secrets/github_pat';
const GATEWAY_SECRET_FILE = process.env.GATEWAY_SECRET_FILE ?? '/run/github-mcp-secrets/gateway_secret';

function readRuntimeSecret(path, label, minLength) {
  try {
    const raw = readFileSync(path, 'utf8');
    if (raw.length > 4096) throw new Error('oversized');
    const value = raw.trim();
    if (value.length < minLength || /[\r\n]/.test(value)) throw new Error('invalid');
    return value;
  } catch {
    console.error(`${label} runtime secret missing/invalid; refusing request`);
    return null;
  }
}

if (!readRuntimeSecret(GITHUB_PAT_FILE, 'GitHub PAT', 20)) process.exit(1);

const UPSTREAM_HOST = process.env.UPSTREAM_HOST ?? 'github-mcp';
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 8082);
const UPSTREAM_PATH = process.env.UPSTREAM_PATH ?? '/';
const PORT = Number(process.env.PORT ?? 8080);
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN ?? 120);
const MAX_BODY = Number(process.env.MAX_BODY_BYTES ?? 5 * 1024 * 1024);

const ACCESS_TEAM_DOMAIN = process.env.ACCESS_TEAM_DOMAIN ?? '';
const ACCESS_AUD = process.env.ACCESS_AUD ?? '';
const ACCESS_EMAILS = new Set(
  (process.env.ACCESS_ALLOWED_EMAILS ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
);
const ACCESS_ENABLED = ACCESS_AUD !== '';
if (ACCESS_ENABLED && !ACCESS_TEAM_DOMAIN) {
  console.error('ACCESS_AUD is set but ACCESS_TEAM_DOMAIN is missing; refusing to start');
  process.exit(1);
}
const ACCESS_ISSUER = ACCESS_ENABLED ? `https://${ACCESS_TEAM_DOMAIN}` : '';

const SECRET_FALLBACK = process.env.ALLOW_SECRET_PATH === '1';
if (!ACCESS_ENABLED && !SECRET_FALLBACK) {
  console.error('Cloudflare Access is not configured and secret-path fallback is disabled; refusing to start');
  process.exit(1);
}
if (SECRET_FALLBACK && !readRuntimeSecret(GATEWAY_SECRET_FILE, 'Gateway fallback', 32)) {
  process.exit(1);
}

const jwks = { keys: new Map(), fetchedAt: 0 };
async function accessKey(kid) {
  const stale = Date.now() - jwks.fetchedAt > 3_600_000;
  const canRefresh = Date.now() - jwks.fetchedAt > 30_000;
  if ((stale || !jwks.keys.has(kid)) && canRefresh) {
    jwks.fetchedAt = Date.now();
    const r = await fetch(`${ACCESS_ISSUER}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`certs HTTP ${r.status}`);
    const { keys = [] } = await r.json();
    jwks.keys = new Map(
      keys.map(k => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]),
    );
  }
  return jwks.keys.get(kid);
}

const b64json = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

async function verifyAccessJwt(token) {
  const parts = (token ?? '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'missing token' };
  try {
    const header = b64json(parts[0]);
    const claims = b64json(parts[1]);
    if (header.alg !== 'RS256') return { ok: false, reason: `alg ${header.alg}` };

    const key = await accessKey(header.kid);
    if (!key) return { ok: false, reason: 'unknown kid' };

    const valid = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], 'base64url'),
    );
    if (!valid) return { ok: false, reason: 'bad signature' };

    const now = Date.now() / 1000;
    const aud = [claims.aud].flat();
    if (!aud.includes(ACCESS_AUD)) return { ok: false, reason: 'wrong audience' };
    if (claims.iss !== ACCESS_ISSUER) return { ok: false, reason: 'wrong issuer' };
    if (typeof claims.exp !== 'number' || claims.exp < now - 30) {
      return { ok: false, reason: 'expired' };
    }
    if (typeof claims.nbf === 'number' && claims.nbf > now + 30) {
      return { ok: false, reason: 'not yet valid' };
    }

    const email = String(claims.email ?? '').toLowerCase();
    if (ACCESS_EMAILS.size && !ACCESS_EMAILS.has(email)) {
      return { ok: false, reason: `email not allowed: ${email || '(none)'}` };
    }
    return { ok: true, email };
  } catch (err) {
    return { ok: false, reason: `verify error: ${err.message}` };
  }
}

function pathAllowed(url) {
  const path = (url ?? '').split('?')[0];
  if (ACCESS_ENABLED && path === '/mcp') return true;
  if (!SECRET_FALLBACK) return false;

  const secret = readRuntimeSecret(GATEWAY_SECRET_FILE, 'Gateway fallback', 32);
  if (!secret) return false;
  const expected = Buffer.from(`/${secret}/mcp`);
  const actual = Buffer.from(path);
  return actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected);
}

const windows = new Map();
function rateLimited(key) {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    windows.set(key, { start: now, count: 1 });
    return false;
  }
  return ++w.count > RATE_PER_MIN;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, w] of windows) {
    if (now - w.start >= 60_000) windows.delete(key);
  }
}, 60_000).unref();

function clientIp(req) {
  return req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? 'unknown';
}

function send(res, status, body = '') {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function upstreamHeaders(req, bodyLength) {
  const token = readRuntimeSecret(GITHUB_PAT_FILE, 'GitHub PAT', 20);
  if (!token) return null;

  const headers = { ...req.headers };
  for (const name of [
    'authorization',
    'cookie',
    'cf-access-jwt-assertion',
    'x-mcp-toolsets',
    'x-mcp-tools',
    'x-mcp-exclude-tools',
    'x-mcp-readonly',
    'x-mcp-lockdown',
    'x-mcp-insiders',
    'x-mcp-features',
    'content-length',
  ]) {
    delete headers[name];
  }

  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  headers.authorization = `Bearer ${token}`;
  if (bodyLength !== null) headers['content-length'] = String(bodyLength);
  return headers;
}

function rewriteUpstreamRequest(parsed, originalBody) {
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  let changed = false;

  const rewritten = messages.map(message => {
    if (message?.method !== 'tools/call' ||
        message?.params?.name !== 'label_write') {
      return message;
    }

    const args = message?.params?.arguments;
    if (!args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        !Object.prototype.hasOwnProperty.call(args, 'label_description')) {
      return message;
    }

    const out = structuredClone(message);
    out.params.arguments.description = out.params.arguments.label_description;
    delete out.params.arguments.label_description;
    changed = true;
    return out;
  });

  if (!changed) return originalBody;
  const payload = Array.isArray(parsed) ? rewritten : rewritten[0];
  return Buffer.from(JSON.stringify(payload));
}

function forward(req, res, body, secretIds) {
  const headers = upstreamHeaders(req, body ? body.length : null);
  if (!headers) return send(res, 503, 'GitHub credential unavailable');

  const up = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: UPSTREAM_PATH,
      headers,
    },
    upRes => {
      const responseHeaders = { ...upRes.headers };
      delete responseHeaders['content-length'];

      const type = String(upRes.headers['content-type'] ?? '');
      if (type.includes('text/event-stream')) {
        res.writeHead(upRes.statusCode ?? 502, responseHeaders);
        let pending = '';
        upRes.setEncoding('utf8');
        upRes.on('data', chunk => {
          pending += chunk;
          const lines = pending.split('\n');
          pending = lines.pop();
          if (lines.length) {
            res.write(lines.map(line => rewriteSseLine(line, secretIds)).join('\n') + '\n');
          }
        });
        upRes.on('end', () => {
          res.end(pending ? rewriteSseLine(pending, secretIds) : undefined);
        });
        return;
      }

      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const out = Buffer.from(rewriteJsonText(raw, secretIds));

        delete responseHeaders['transfer-encoding'];
        responseHeaders['content-length'] = String(out.length);
        res.writeHead(upRes.statusCode ?? 502, responseHeaders);
        res.end(out);
      });
    },
  );

  up.on('error', err => {
    console.warn(`upstream error: ${err.code ?? err.message}`);
    if (!res.headersSent) send(res, 502, 'upstream unavailable');
    else res.destroy();
  });

  res.on('close', () => {
    if (!res.writableFinished) up.destroy();
  });

  up.end(body);
}

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    return send(res, 200, 'ok');
  }
  if (!pathAllowed(req.url)) return send(res, 404);

  let identity = clientIp(req);
  if (ACCESS_ENABLED) {
    const verified = await verifyAccessJwt(req.headers['cf-access-jwt-assertion']);
    if (!verified.ok) {
      console.warn(`access denied from ${identity}: ${verified.reason}`);
      return send(res, 403, 'forbidden');
    }
    if (verified.email) identity = verified.email;
  }

  if (rateLimited(identity)) return send(res, 429, 'rate limited');

  if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
    return send(res, 405, 'method not allowed');
  }

  if (req.method !== 'POST') {
    return forward(req, res, null, new Set());
  }

  const chunks = [];
  let size = 0;
  let aborted = false;

  req.on('data', chunk => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      aborted = true;
      send(res, 413, 'request too large');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);

    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return send(res, 400, 'invalid json');
    }

    const violation = checkRequestPolicy(parsed);
    if (violation) {
      console.warn(new Date().toISOString() + ' ' + identity + ' policy-block: ' + violation.message);
      return send(res, 403, 'blocked by local GitHub gateway policy: ' + violation.message);
    }

    const secretIds = secretResultIdsFromRequest(parsed);
    const methods = [parsed].flat().map(m =>
      m?.method === 'tools/call' ? `call:${m?.params?.name}` : m?.method
    );
    console.log(`${new Date().toISOString()} ${identity} ${methods.join(',')}`);

    const upstreamBody = rewriteUpstreamRequest(parsed, body);
    forward(req, res, upstreamBody, secretIds);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(
    `github gateway listening on ${PORT}; cloudflare access: ` +
    `${ACCESS_ENABLED ? `required (${ACCESS_TEAM_DOMAIN})` : 'off'}; ` +
    `secret fallback: ${SECRET_FALLBACK ? 'enabled' : 'off'}`,
  );
});
