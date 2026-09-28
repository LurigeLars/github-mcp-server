# Repository instructions

Scope: local deployment and security overlay for the official GitHub MCP Server container.

- Keep this repository thin. Do not vendor or reintroduce upstream GitHub MCP Server Go/UI source.
- Upstream server changes are adopted by updating the official image tag and digest in `deploy/local-gateway/compose.yaml`.
- Preserve the DPAPI -> stdin -> tmpfs secret path. Never move credentials into Compose environment variables, committed files, image layers or command-line arguments.
- Preserve the gateway as the cloud-facing policy boundary; client-supplied headers must not widen server policy.
- Any runtime/deployment change must keep `.github/workflows/local-gateway-security.yml` green.
- Keep the canonical runtime checkout on `main`; use a separate worktree for development branches.
