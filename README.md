# GitHub MCP local deployment overlay

This repository is the deployment and security overlay for a local GitHub MCP runtime.

It does **not** maintain a separate implementation of GitHub MCP Server. The MCP backend is the official GitHub container image, pinned by version and digest in `deploy/local-gateway/compose.yaml`.

## Ownership boundary

**Upstream owns**
- MCP server implementation and tool behavior
- GitHub API integrations
- upstream bug fixes and releases
- the official container image: `ghcr.io/github/github-mcp-server`

**This repository owns**
- Docker Compose wiring for the local deployment
- the Node policy/auth gateway in `deploy/local-gateway/public/`
- Cloudflare-facing deployment configuration
- Windows DPAPI-backed secret injection
- local security tests and startup helpers
- dependency/update monitoring for the overlay itself

Do not copy or patch upstream Go server source into this repository. If an upstream server fix is needed, update the pinned official image after reviewing the release.

## Current upstream runtime

The authoritative runtime pin is in:

`deploy/local-gateway/compose.yaml`

When this overlay was created, it used GitHub MCP Server `v1.12.2` with a digest pin.

## Layout

- `deploy/local-gateway/` — runtime, gateway, config examples, Windows helpers and tests
- `.github/workflows/local-gateway-security.yml` — overlay CI/security checks
- `.github/dependabot.yml` — Compose image and GitHub Actions updates
- `docs/local-and-cloud-deployment.md` — architecture and deployment notes
- `scripts/windows/new-worktree.ps1` — standard parallel-development helper

## Updating GitHub MCP Server

1. Review the new official GitHub MCP Server release and relevant upstream changes.
2. Update the image tag **and digest** in `deploy/local-gateway/compose.yaml`.
3. Let CI run the overlay/security tests.
4. Deploy through the normal Windows wrapper; do not bypass the DPAPI secret path.
5. Verify health and the runtime-secret invariants with `github-mcp.ps1 test`.

There is deliberately no upstream merge workflow. Upstream source is consumed as a released container, not vendored here.

## Security boundary

Real PATs, Cloudflare deployment identity and machine-specific config are local-only and gitignored. The gateway is intentionally the policy boundary between cloud clients and the official GitHub MCP backend.

See `deploy/local-gateway/README.md` for secret handling details and `docs/local-and-cloud-deployment.md` for the architecture.
