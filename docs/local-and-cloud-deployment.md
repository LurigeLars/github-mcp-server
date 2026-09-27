# Deploying this fork locally and for cloud chats

The fork-specific work is deployment rather than MCP features, and this is the deployment it was
hardened for: one pinned container serving two paths — local agents over stdio, and cloud chats
through Cloudflare Access — with a single policy and a single token.

Every hostname, path and network name below is a placeholder. Substitute your own; nothing here
should be copied literally.

## Two paths, one server

```text
Cloud chat     -> Cloudflare Access -> Cloudflare Tunnel -> gateway -> github-mcp (HTTP) -> GitHub API
Claude Code,
Claude Desktop -> node local-mcp/stdio-proxy.mjs -> github-mcp container (stdio) -> GitHub API
Codex
```

Both paths share the pinned image, the same toolset and exclusion policy, the same fine-grained
token, and the same Secret Scanning redaction. That is deliberate: a policy that applies to one path
and not the other is a policy you cannot reason about.

## Before you configure anything real

Do not put a real token or a live Cloudflare route in first. Run the deployment's preflight, which
installs to a working directory, detects an existing tunnel edge network if you have one, and runs
an isolated `--network none` test with a fake token. A deployment that has never been started with a
throwaway credential is one whose first failure will involve a real one.

Verified against upstream **v1.12.2**, pinned by digest:

```text
ghcr.io/github/github-mcp-server:v1.12.2@sha256:508a0857ec762b1ab1cece29193345b501fab1dd9d1228a7b617062954cecac6
```

Pin by digest rather than tag. A tag that moves under a server holding a write-capable token is a
supply-chain change you did not review.

## Files you create locally

All of these are gitignored and must never be committed:

1. `.env` from `.env.example`
2. `config/github.env` from `config/github.env.example` — the toolset and exclusion policy
3. `secrets.env` from `secrets.env.example` — the fine-grained token

For the cloud path you also:

4. Point `MCP_EDGE_NETWORK` at the Docker network your existing `cloudflared` container uses. Verify
   it against `docker network ls` rather than assuming the name; Compose derives it from the project
   directory, so it differs between installations.
5. Add the ingress snippet to your existing tunnel configuration **before** its final catch-all rule.
6. Create a Cloudflare Access application and policy for `<your-mcp-hostname>`, and put its Audience
   tag in `ACCESS_AUD`.

Create the token last, once the repository list and permissions are settled.

## Token permissions

Grant repository access to only the repositories the agents should touch.

| Permission | Level |
|---|---|
| Metadata | Read (automatic) |
| Contents | Read and write |
| Issues | Read and write |
| Pull requests | Read and write |
| Actions | Read |
| Commit statuses | Read |
| Dependabot alerts | Read |
| Code scanning alerts | Read |
| Secret scanning alerts | Read |

Actions **write** is not needed, because `actions_run_trigger` is hard-excluded. If you do not want
direct merging either, add `merge_pull_request` to the exclusion list.

## Start and verify

```powershell
docker compose -f compose.yaml pull
docker compose -f compose.yaml up -d
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs --tail 100 github-mcp github-gateway
```

**Do not publish a host port.** The gateway joins the tunnel's edge network; the MCP container is
reachable only from its Docker networks. A published port is a second, unauthenticated way in.

## Registering a local client

The local path is a stdio proxy, so every local client uses the same command with a different
configuration file. Replace the path with your own deployment directory.

**Claude Code:**

```powershell
claude mcp add-json github-local -s user '{"type":"stdio","command":"node","args":["<deployment-path>/local-mcp/stdio-proxy.mjs"]}'
claude mcp get github-local
```

**Claude Desktop** — Settings > Developer > Edit Config, then restart Desktop fully:

```json
{
  "mcpServers": {
    "github-local": {
      "command": "node",
      "args": ["<deployment-path>/local-mcp/stdio-proxy.mjs"]
    }
  }
}
```

On Windows, give `command` the absolute path to `node.exe`; Claude Desktop does not resolve it from
`PATH`.

**Codex** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.github_local]
command = "node"
args = ["<deployment-path>/local-mcp/stdio-proxy.mjs"]
```

## Registering a cloud chat

Once Access and the tunnel route are live, the server URL is `https://<your-mcp-hostname>/mcp` with
Cloudflare Access OAuth. The token never leaves your machine: the gateway injects it only on the
internal hop.

## What the hardening actually does

- `GITHUB_TOOLSETS` is a server-side allow-list, not a client hint. Discussions are omitted.
- `GITHUB_EXCLUDE_TOOLS` hard-blocks `actions_run_trigger`, `create_repository`,
  `delete_repository`, `delete_file` and `fork_repository`. Excluding destructive tools at the
  server is the only place a client cannot argue with.
- Lockdown mode is enabled as a best-effort prompt-injection filter for untrusted repository
  content. Treat it as reducing the blast radius, not as a guarantee: repository content an agent
  reads is data, never instructions.
- The gateway strips every client-supplied `X-MCP-*` header, so a cloud client cannot widen the tool
  configuration it was given.
- **Upstream returns matched secret material in Secret Scanning alert results.** `policy.mjs` masks
  every `secret` field on both the HTTP and stdio paths. Without that, asking an agent to review
  alerts hands it the leaked credentials in cleartext.
