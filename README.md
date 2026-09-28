# GitHub MCP local deployment overlay

## Current deployment and security posture

This repository is a thin local deployment/security overlay around the official GitHub MCP Server image.

- The official GitHub MCP backend is pinned by release and immutable image digest; upstream server source is not vendored here.
- The public gateway runs as non-root `node` with a read-only filesystem, dropped Linux capabilities, and `no-new-privileges`.
- The backend runs with an explicit non-root container user.
- GitHub credentials are protected on the Windows host with DPAPI and injected at runtime through tmpfs rather than Compose environment variables.
- Cloud-facing requests are authenticated and policy-filtered before they can reach the backend.
- Machine-specific paths, account identity, Cloudflare values, repository access tokens, and credentials must remain outside Git.

This repository is the deployment and security overlay for a local GitHub MCP runtime.

It is an **independent repository**, not part of the upstream GitHub MCP fork network, and it does **not** maintain a separate implementation of GitHub MCP Server. The backend is the official GitHub container image, pinned by version and digest in `deploy/local-gateway/compose.yaml`.

## Architecture

```text
Cloud client
  -> Cloudflare Access
  -> Cloudflare Tunnel
  -> github-gateway (Node policy/auth boundary)
  -> github-mcp (official GitHub MCP Server image)
  -> GitHub API
```

The gateway and backend communicate on a private Docker network. Cloud-facing traffic reaches the gateway through the shared Cloudflare edge network; the GitHub MCP backend is not exposed directly.

## Ownership boundary

**Upstream GitHub MCP owns**
- MCP server implementation and tool behavior
- GitHub API integrations
- upstream bug fixes and releases
- the official image: `ghcr.io/github/github-mcp-server`

**This repository owns**
- Docker Compose wiring and container hardening
- the Node policy/auth gateway in `deploy/local-gateway/public/`
- Cloudflare-facing deployment configuration
- Windows DPAPI-backed secret storage and runtime injection
- local security tests and startup helpers
- CI, CodeQL and dependency monitoring for the overlay

Do not vendor or patch upstream GitHub MCP Server Go/UI source here. Upstream changes are consumed as released container versions.

## Current runtime

The authoritative upstream pin is:

`deploy/local-gateway/compose.yaml`

At the time of this update, the backend is pinned to GitHub MCP Server `v1.12.2` plus an immutable SHA-256 image digest.

The deployment also pins its Node gateway image in the same Compose file.

## Automated dependency updates

Dependabot runs weekly and monitors:

- Docker Compose dependencies under `deploy/local-gateway/`, including the official GitHub MCP Server image and the Node gateway image
- GitHub Actions used by repository workflows

When Dependabot detects a supported newer version, it opens a pull request. Updates are **not auto-merged**: normal CI/security checks run before merge.

This replaces the old upstream-source merge model. There is no upstream Git merge workflow.

## CI and branch policy

The active repository workflows are:

- `.github/workflows/overlay-ci.yml` — thin-overlay and gateway validation
- `.github/workflows/local-gateway-security.yml` — runtime-secret, Docker and Windows DPAPI security checks
- `.github/workflows/codeql.yml` — CodeQL for GitHub Actions and JavaScript/TypeScript

The default-branch ruleset protects `main` and requires the `overlay-ci` status check. Changes are made through short-lived branches and pull requests; stale merged branches are deleted.

## Repository layout

- `deploy/local-gateway/` — runtime, gateway, config examples, Windows helpers and tests
- `docs/local-and-cloud-deployment.md` — architecture, trust boundaries and update flow
- `.github/dependabot.yml` — automated Compose and GitHub Actions updates
- `.github/workflows/` — CI, security and CodeQL
- `scripts/windows/new-worktree.ps1` — standard helper for parallel local development

## Updating GitHub MCP Server

Normally Dependabot opens the update PR.

For a manual update:

1. Review the official GitHub MCP Server release.
2. Update the image tag **and digest** in `deploy/local-gateway/compose.yaml`.
3. Let Overlay CI, Local Gateway Security and CodeQL run.
4. Merge through the protected `main` branch.
5. Deploy through the Windows wrapper; do not bypass the DPAPI secret path.
6. Verify with `deploy/local-gateway/github-mcp.ps1 test`.

If an upstream release requires gateway or configuration compatibility changes, implement those changes in this overlay rather than copying upstream server source.

## Security boundary

Real PATs, Cloudflare deployment identity and machine-specific configuration are local-only and gitignored.

The GitHub PAT is stored with Windows DPAPI CurrentUser, decrypted only by the local wrapper, streamed over stdin into container tmpfs, consumed by the gateway and forwarded only to the fixed private `github-mcp` backend. It must not be committed or placed in Compose environment variables, image layers or command-line arguments.

See `deploy/local-gateway/README.md` for operational secret handling and `docs/local-and-cloud-deployment.md` for the full architecture.
