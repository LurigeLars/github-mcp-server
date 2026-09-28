# Local and cloud deployment architecture

This repository is a **deployment overlay** around the official GitHub MCP Server container. It does not maintain a separate copy of the upstream server implementation.

## Runtime path

```text
Cloud client
  -> Cloudflare Access
  -> Cloudflare Tunnel
  -> github-gateway (Node policy/auth boundary)
  -> github-mcp (official GitHub MCP Server image)
  -> GitHub API
```

The authoritative image pin lives in `deploy/local-gateway/compose.yaml`. Both the release tag and digest are pinned so an upstream tag movement cannot silently replace the runtime.

## What this repository owns

- Compose topology and container hardening
- Cloudflare-facing gateway
- server-side policy/header filtering
- Windows DPAPI-backed GitHub PAT storage
- runtime secret injection over stdin into container tmpfs
- security smoke tests
- startup/maintenance helpers

The GitHub MCP server implementation, tools and GitHub API behavior are upstream responsibilities.

## Secret boundary

Real credentials and deployment identity are never committed.

The GitHub PAT is stored on Windows with DPAPI CurrentUser. The Windows wrapper decrypts it only for runtime injection, streams it over stdin into a tmpfs file inside the gateway container, and the gateway consumes/unlinks that file during startup. The secret must not appear in Docker `.Config.Env`, Compose env files, Git history or a container writable layer.

Use the example files under `deploy/local-gateway/` to create local configuration.

## Network boundary

Do not publish the gateway or backend directly to a host port for cloud access. The gateway joins the existing Cloudflare edge network; the backend remains on the private Docker network.

Cloudflare Access is the external authentication layer. The Node gateway remains the internal authorization/policy boundary and injects the GitHub PAT only on the backend hop.

## Server policy

`config/github.env` defines the server-side GitHub MCP toolsets and exclusions. The gateway strips client-supplied `X-MCP-*` headers so a remote client cannot widen those choices.

Lockdown mode is enabled as defense-in-depth for untrusted repository content. It reduces prompt-injection exposure but does not turn repository content into trusted instructions.

The response policy also masks secret values returned by GitHub Secret Scanning surfaces before they reach clients.

## Updating upstream

There is no upstream merge procedure.

When GitHub releases a new GitHub MCP Server version:

1. Review the official release/change set.
2. Update the official image tag and digest in `deploy/local-gateway/compose.yaml`.
3. Run the repository CI/security checks.
4. Deploy with the Windows wrapper.
5. Run `deploy/local-gateway/github-mcp.ps1 test`.

If the new upstream version requires a gateway/config compatibility change, make that change in this overlay. Do not copy the upstream server source into the repository.

## Local verification

From the deployment directory on Windows:

```powershell
.\github-mcp.ps1 up
.\github-mcp.ps1 status
.\github-mcp.ps1 test
```

`test` verifies that the gateway is healthy, credentials are absent from Docker `.Config.Env`, tmpfs credential files were consumed, and secret material did not appear in the container writable layer.
