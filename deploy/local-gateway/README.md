# Local GitHub MCP gateway deployment

This directory is the versioned source for the Windows/Docker deployment that exposes the **official GitHub MCP Server container** through the shared Cloudflare edge network.

The repository itself is only the deployment/security overlay. Do not add upstream GitHub MCP Server implementation source here.

## Runtime topology

```text
Cloudflare edge
  -> github-gateway
  -> private Docker network
  -> github-mcp
```

`github-mcp` uses the official pinned GitHub MCP image from `compose.yaml`. The gateway is the policy/auth boundary and the only service that joins both the private backend network and the Cloudflare edge network.

## Secret boundary

- The GitHub PAT is stored on Windows as `%LOCALAPPDATA%\GitHubMCP\secrets\github_pat.dpapi` using DPAPI CurrentUser.
- The optional secret-path fallback secret is stored as `gateway_secret.dpapi` when present.
- `github-mcp.ps1 up` decrypts required values in the current Windows user process and streams them over stdin into `/run/github-mcp-secrets`, a gateway-container tmpfs owned by the unprivileged `node` user.
- Before each runtime-secret import, the wrapper force-recreates the gateway so the new process consumes and unlinks the tmpfs files during startup. Re-running `up` is safe and deterministic.
- The PAT is not configured in Docker `.Config.Env`, Compose env files, command-line arguments, Git, or the container writable layer.
- Plaintext necessarily exists transiently in the Windows PowerShell process, Docker exec stdin and Node process memory. The PAT remains in Node process memory while the gateway is running because it is required to authorize backend GitHub requests.

DPAPI protects at-rest host storage; it does not eliminate runtime plaintext.

## Existing-install migration

1. Copy this deployment source over the existing local deployment's non-secret files, preserving local `.env`, `config\github.env` and Cloudflare settings.
2. Run `scripts\configure_secrets.ps1`. It migrates an existing plaintext PAT and optional gateway fallback secret to DPAPI, verifies decryption, copies Access configuration into `config\gateway.env`, and only then removes legacy plaintext entries.
3. Start with `github-mcp.ps1 up`, then run `github-mcp.ps1 test`.
4. Install `scripts\install-startup-task.ps1` so the current Windows user starts the secure wrapper at logon while Docker Desktop comes up.

The gateway has Docker auto-restart disabled because a container restart cannot reconstruct a DPAPI credential by itself. After manually restarting Docker Desktop during an existing Windows session, rerun `github-mcp.ps1 up` or the installed task.

Do not use `docker compose up` directly as a replacement for the wrapper after DPAPI migration: the gateway intentionally waits for the host wrapper to inject the tmpfs credential.

## Normal operations

From this directory:

```powershell
.\github-mcp.ps1 up
.\github-mcp.ps1 status
.\github-mcp.ps1 test
```

Use `test` after deployment changes or upstream image updates.

## Upstream and dependency updates

The root `.github/dependabot.yml` checks Compose dependencies weekly. This includes:

- `ghcr.io/github/github-mcp-server`
- the Node gateway image

GitHub Actions dependencies are also checked weekly.

Dependabot opens PRs for supported updates; it does not auto-merge them. Overlay CI, Local Gateway Security and CodeQL should pass before an update is merged and deployed.

The source of truth for the deployed image version and digest remains `compose.yaml`.
