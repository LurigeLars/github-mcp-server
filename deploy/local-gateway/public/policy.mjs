// Shared response/request policy for public HTTP gateway and local stdio proxy.
// GitHub Secret Scanning results are redacted before leaving this machine.
// ChatGPT exposes a delta surface on top of the built-in GitHub connector.
// Clear semantic duplicates stay available in the upstream runtime but are
// hidden from tools/list here; unique local/security/admin capabilities remain.

export const SECRET_SCANNING_TOOLS = new Set([
  'get_secret_scanning_alert',
  'list_secret_scanning_alerts',
]);

export const SECURITY_ALERT_LIST_TOOLS = new Set([
  'list_code_scanning_alerts',
  'list_secret_scanning_alerts',
]);

export const CHATGPT_HIDDEN_TOOLS = new Set([
  // Built-in GitHub connector already covers these common CRUD/search flows.
  'add_issue_comment',
  'add_reply_to_pull_request_comment',
  'create_branch',
  'create_or_update_file',
  'create_pull_request',
  'delete_file',
  'get_commit',
  'get_file_contents',
  'get_job_logs',
  'get_me',
  'issue_read',
  'issue_write',
  'list_commits',
  'list_issues',
  'list_pull_requests',
  'merge_pull_request',
  'pull_request_read',
  'push_files',
  'search_code',
  'search_commits',
  'search_issues',
  'search_pull_requests',
  'search_repositories',
  'update_issue_comment',
  'update_pull_request',
]);

export const CHATGPT_DENIED_TOOLS = new Set([
  'create_repository',
  'delete_repository',
  'fork_repository',
  'create_repository_ruleset',
  'custom_properties_write',
]);

export const CHATGPT_WRITE_TOOLS = new Set([
  'actions_run_trigger',
  'add_comment_to_pending_review',
  'add_issue_comment',
  'add_reply_to_pull_request_comment',
  'assign_copilot_to_issue',
  'create_branch',
  'create_or_update_file',
  'create_pull_request',
  'delete_file',
  'discussion_comment_write',
  'issue_write',
  'label_write',
  'merge_pull_request',
  'pull_request_review_write',
  'push_files',
  'request_copilot_review',
  'sub_issue_write',
  'update_issue_comment',
  'update_pull_request',
  'update_pull_request_branch',
]);

const SAFE_WRITE_OWNER = 'LurigeLars';
const MAX_INLINE_TEXT_RESOURCE_CHARS = 128 * 1024;

export function inlineTextResultIdsFromRequest(msg) {
  const ids = new Set();
  for (const m of [msg].flat()) {
    if (m?.method === 'tools/call' &&
        m?.params?.name === 'get_file_contents' &&
        String(m?.params?.arguments?.owner ?? '') === SAFE_WRITE_OWNER &&
        m.id !== undefined) {
      ids.add(m.id);
    }
  }
  return ids;
}

export function secretResultIdsFromRequest(msg) {
  const ids = new Set();
  for (const m of [msg].flat()) {
    if (m?.method === 'tools/call' &&
        SECRET_SCANNING_TOOLS.has(m?.params?.name) &&
        m.id !== undefined) {
      ids.add(m.id);
    }
  }
  return ids;
}

export function securityAlertListResultIdsFromRequest(msg) {
  const ids = new Set();
  for (const m of [msg].flat()) {
    if (m?.method === 'tools/call' &&
        SECURITY_ALERT_LIST_TOOLS.has(m?.params?.name) &&
        m.id !== undefined) {
      ids.add(m.id);
    }
  }
  return ids;
}

function toolCallPolicyViolation(m) {
  if (m?.method !== 'tools/call') return null;

  const name = String(m?.params?.name ?? '');
  const args = m?.params?.arguments ?? {};

  if (CHATGPT_DENIED_TOOLS.has(name)) {
    return 'tool is not exposed by the local ChatGPT GitHub policy: ' + (name || '(missing name)');
  }

  if (!CHATGPT_WRITE_TOOLS.has(name)) return null;

  if (String(args?.owner ?? '') !== SAFE_WRITE_OWNER) {
    return 'write tool ' + name + ' is restricted to owner ' + SAFE_WRITE_OWNER;
  }

  if (name === 'issue_write' &&
      args?.parent_owner !== undefined &&
      args?.parent_owner !== null &&
      String(args.parent_owner) !== SAFE_WRITE_OWNER) {
    return 'issue_write parent_owner is restricted to ' + SAFE_WRITE_OWNER;
  }

  if (name === 'pull_request_review_write' &&
      ['resolve_thread', 'unresolve_thread'].includes(String(args?.method ?? ''))) {
    return 'resolve_thread/unresolve_thread are blocked because threadId ownership cannot be enforced locally';
  }

  return null;
}

export function checkRequestPolicy(msg) {
  for (const m of [msg].flat()) {
    const message = toolCallPolicyViolation(m);
    if (message) return { id: m?.id ?? null, message };
  }
  return null;
}

function redactSecretKeys(value) {
  if (Array.isArray(value)) return value.map(redactSecretKeys);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = key.toLowerCase() === 'secret'
      ? '[REDACTED_BY_LOCAL_GATEWAY]'
      : redactSecretKeys(val);
  }
  return out;
}

function redactTextPayload(text) {
  if (typeof text !== 'string') return text;
  try {
    return JSON.stringify(redactSecretKeys(JSON.parse(text)));
  } catch {
    return text;
  }
}

function compactText(value, maxChars) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const firstSentence = text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
  if (firstSentence && firstSentence.length <= maxChars) return firstSentence;
  return text.slice(0, Math.max(1, maxChars - 1)).trimEnd() + '…';
}

function compactSchema(value) {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '$schema' || key === 'title' || key === 'examples') continue;
    if (key === 'description') {
      out[key] = compactText(item, 96);
      continue;
    }
    out[key] = compactSchema(item);
  }
  return out;
}

export function compactToolDefinition(tool) {
  const out = structuredClone(tool);
  if (out.description) out.description = compactText(out.description, 180);
  if (out.inputSchema) out.inputSchema = compactSchema(out.inputSchema);
  delete out.outputSchema;
  return out;
}

function annotateTool(tool) {
  const out = compactToolDefinition(tool);
  const existing = out.annotations && typeof out.annotations === 'object'
    ? out.annotations
    : {};
  const isWrite = CHATGPT_WRITE_TOOLS.has(out.name);

  out.annotations = {
    ...existing,
    readOnlyHint: !isWrite,
  };

  if (isWrite) {
    out.annotations.openWorldHint = false;
  } else {
    out.annotations.destructiveHint = false;
  }
  if (out.name === 'get_me') out.annotations.openWorldHint = false;

  if (out.name === 'label_write' &&
      out.inputSchema?.properties?.description &&
      !out.inputSchema.properties.label_description) {
    out.inputSchema.properties.label_description = {
      ...out.inputSchema.properties.description,
      description: 'Label description text. Optional for create and update.',
    };
    delete out.inputSchema.properties.description;
  }

  return out;
}

function rewriteToolList(msg) {
  if (!Array.isArray(msg?.result?.tools)) return msg;
  const out = structuredClone(msg);
  out.result.tools = out.result.tools
    .filter(tool =>
      !CHATGPT_DENIED_TOOLS.has(tool?.name) &&
      !CHATGPT_HIDDEN_TOOLS.has(tool?.name)
    )
    .map(annotateTool);
  return out;
}

function inlineEmbeddedTextResources(msg) {
  if (!Array.isArray(msg?.result?.content)) return msg;

  let changed = false;
  const content = msg.result.content.map(item => {
    const uri = String(item?.resource?.uri ?? '');
    if (item?.type !== 'resource' ||
        typeof item?.resource?.text !== 'string' ||
        item.resource.text.length > MAX_INLINE_TEXT_RESOURCE_CHARS ||
        !uri.startsWith(`repo://${SAFE_WRITE_OWNER}/`)) return item;
    changed = true;
    const out = { ...item, type: 'text', text: item.resource.text };
    delete out.resource;
    return out;
  });

  if (!changed) return msg;
  const out = structuredClone(msg);
  out.result.content = content;
  return out;
}

export function rewriteResponse(msg, secretIds, inlineTextIds) {
  if (!msg || typeof msg !== 'object') return msg;

  let out = rewriteToolList(msg);
  // Tool results may arrive on a different Streamable HTTP/SSE response than
  // the request that initiated them, so normalize from the trusted repo URI.
  out = inlineEmbeddedTextResources(out);

  if (!secretIds?.has(out.id)) return out;

  if (out === msg) out = structuredClone(msg);

  if (Array.isArray(out?.result?.content)) {
    out.result.content = out.result.content.map(item =>
      item?.type === 'text' && typeof item.text === 'string'
        ? { ...item, text: redactTextPayload(item.text) }
        : item
    );
  }

  if (out?.result?.structuredContent) {
    out.result.structuredContent = redactSecretKeys(out.result.structuredContent);
  }
  return out;
}

export function rewriteJsonText(text, secretIds, inlineTextIds) {
  try {
    const parsed = JSON.parse(text);
    const rewritten = Array.isArray(parsed)
      ? parsed.map(m => rewriteResponse(m, secretIds, inlineTextIds))
      : rewriteResponse(parsed, secretIds, inlineTextIds);
    return JSON.stringify(rewritten);
  } catch {
    return text;
  }
}

export function rewriteSseLine(line, secretIds, inlineTextIds) {
  if (!line.startsWith('data:')) return line;
  const raw = line.slice(5).trimStart();
  const rewritten = rewriteJsonText(raw, secretIds, inlineTextIds);
  return 'data: ' + rewritten;
}