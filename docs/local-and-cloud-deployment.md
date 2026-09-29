# Local and cloud deployment architecture

This repository is an **independent deployment/security overlay** around the official GitHub MCP Server container. It is not part of the upstream fork network and does not carry a separate copy of the upstream server implementation.

## Runtime path

```text
Cloud client
  -> Cloudflare Access
  -> Cloudflare Tunnel
  -> github-gateway (Node policy/auth boundary)
  -> github-mcp (official GitHub MCP Server image)
  -> GitHub API
```

The authoritative image pins live in `deploy/local-gateway/compose.yaml`. Release tags and immutable digests are pinned so a moved tag cannot silently replace the runtime.

## Responsibility split

### Upstream GitHub MCP Server

Upstream owns:

- MCP server implementation
- tool behavior
- GitHub API integrations
- bug fixes and releases
- the official `ghcr.io/github/github-mcp-server` image

### This repository

The overlay owns:

- Compose topology and container hardening
- Cloudflare-facing gateway
- server-side tool/policy and header filtering
- Windows DPAPI-backed GitHub PAT storage
- runtime secret injection over stdin into container tmpfs
- security smoke tests
- startup and maintenance helpers
- CI, CodeQL and dependency monitoring

Upstream source must not be vendored into this repository.

## Network boundary

The backend service `github-mcp` is reachable only on the private Docker network used by the gateway.

The gateway also joins the dedicated GitHub Cloudflare edge network. No host port is published for cloud access.

Cloudflare Access is the external authentication layer. The Node gateway is the internal authorization/policy boundary and injects the GitHub PAT only on the fixed backend hop to `github-mcp:8082`.

Client-supplied `X-MCP-*` headers are stripped so a remote caller cannot widen server-side policy.

## Secret boundary

Real credentials and deployment identity are never committed.

The GitHub PAT is stored on Windows with DPAPI CurrentUser. The Windows wrapper:

1. decrypts the PAT in the current user process,
2. streams it over stdin,
3. writes it into gateway-container tmpfs,
4. starts the gateway,
5. lets the gateway read and unlink the tmpfs file.

The PAT must not appear in Docker `.Config.Env`, Compose env files, Git history, image layers or command-line arguments.

Plaintext necessarily exists transiently in the Windows process, Docker exec stdin and gateway process memory while the service is running. DPAPI protects at-rest host storage; it does not eliminate runtime plaintext.

The gateway has Docker auto-restart disabled because Docker alone cannot reconstruct the DPAPI-protected credential after a container restart.

## Server policy

Local `config/github.env` defines GitHub MCP toolsets and exclusions.

The deployment currently uses server-side lockdown/policy controls as defense-in-depth against untrusted repository content. Repository content remains untrusted input.

The response policy also masks secret values returned by Secret Scanning surfaces before they reach clients.

## Dependency and upstream update flow

There is no upstream Git merge procedure.

`.github/dependabot.yml` runs weekly for:

- `docker-compose` in `/deploy/local-gateway`
- `github-actions` in the repository root

This means the official GitHub MCP Server image pin, Node gateway image and GitHub Actions can receive Dependabot update PRs when newer supported versions are detected.

Dependabot PRs are not auto-merged. They go through the same protected-branch flow as other changes.

For an upstream GitHub MCP update:

1. Dependabot normally opens a PR, or the image tag/digest is updated manually.
2. Review the upstream release notes/change set.
3. Run repository CI/security checks.
4. Merge through protected `main`.
5. Deploy with the Windows wrapper.
6. Run `deploy/local-gateway/github-mcp.ps1 test`.

If the new upstream version requires compatibility work, change the overlay only. Do not copy upstream server source into the repository.

## CI and repository policy

The active versioned workflows are:

- `overlay-ci.yml` — verifies the thin-overlay boundary, official-image pin and gateway syntax/tests
- `local-gateway-security.yml` — verifies secret/runtime invariants and Windows DPAPI behavior
- `codeql.yml` — scans GitHub Actions and JavaScript/TypeScript

The default-branch ruleset:

- protects `main`
- prevents branch deletion
- prevents non-fast-forward updates
- requires pull requests
- requires the `overlay-ci` status check with strict branch freshness

Development branches are short-lived and should be deleted after merge.

## Local verification

From `deploy/local-gateway` on Windows:

```powershell
.\github-mcp.ps1 up
.\github-mcp.ps1 status
.\github-mcp.ps1 test
```

`test` verifies that the gateway is healthy, credentials are absent from Docker `.Config.Env`, tmpfs credential files were consumed, and secret material did not appear in the container writable layer.
