# Local GitHub MCP gateway deployment

This directory is the versioned source for the Windows/Docker deployment used to expose the official GitHub MCP HTTP server through the shared Cloudflare edge network.

## Secret boundary

- The GitHub PAT is stored on Windows as `%LOCALAPPDATA%\GitHubMCP\secrets\github_pat.dpapi` using DPAPI CurrentUser.
- The optional secret-path fallback secret is stored as `gateway_secret.dpapi` when present.
- `github-mcp.ps1 up` decrypts the required values in the current Windows user process and streams them over stdin into `/run/github-mcp-secrets`, a container tmpfs owned by the unprivileged `node` user.
- Before each runtime-secret import, the wrapper force-recreates the gateway so the new process consumes and unlinks the tmpfs files during startup. Re-running `up` is therefore safe and deterministic.
- The PAT is not configured in Docker `.Config.Env`, Compose env files, command-line arguments, Git, or the container writable layer.
- Plaintext necessarily exists transiently in the Windows PowerShell process, Docker exec stdin and Node process memory. The PAT remains in Node process memory while the gateway is running because it is required to authorize upstream GitHub requests. DPAPI protects at-rest host storage; it does not eliminate runtime plaintext.

## Existing-install migration

1. Copy this deployment source over the existing `C:\ClaudeCode\github-mcp-local` non-secret files, preserving `.env`, `config\github.env`, and local Cloudflare settings.
2. Run `scripts\configure_secrets.ps1`. It migrates the existing plaintext PAT and optional gateway fallback secret to DPAPI, verifies decryption, copies Access configuration into `config\gateway.env`, and only then removes the legacy plaintext entries.
3. Start with `github-mcp.ps1 up`, then run `github-mcp.ps1 test`.
4. Install `scripts\install-startup-task.ps1` so the current Windows user starts the secure wrapper at logon while Docker Desktop comes up.

The gateway has Docker auto-restart disabled because a container restart cannot reconstruct a DPAPI credential by itself. After manually restarting Docker Desktop during an existing Windows session, rerun `github-mcp.ps1 up` (or the installed task). Do not use `docker compose up` directly after this migration: the gateway intentionally waits for the host wrapper to inject its tmpfs credential.
