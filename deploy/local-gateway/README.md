# Local GitHub MCP gateway deployment

This directory is the versioned source for the Windows/Docker deployment used to expose the official GitHub MCP HTTP server through the shared Cloudflare edge network.

## Secret boundary

- The GitHub PAT is stored on Windows as `%LOCALAPPDATA%\GitHubMCP\secrets\github_pat.dpapi` using DPAPI CurrentUser.
- The optional secret-path fallback secret is stored as `gateway_secret.dpapi` when present.
- `github-mcp.ps1 up` decrypts the required values in the current Windows user process and streams them over stdin into `/run/github-mcp-secrets`, which is a container tmpfs owned by the unprivileged `node` user.
- The gateway reads credentials from the tmpfs files. The PAT is not configured in Docker `.Config.Env`, Compose env files, command-line arguments, Git, or the container writable layer.
- Plaintext necessarily exists transiently in the Windows PowerShell process, Docker exec stdin, the container tmpfs file, and the Node process memory while a request is authorized. DPAPI protects at-rest host storage; it does not make runtime plaintext impossible.

## Existing-install migration

1. Copy this deployment source over the existing `C:\ClaudeCode\github-mcp-local` non-secret files, preserving `.env`, `config\github.env`, and local Cloudflare settings.
2. Create `config\gateway.env` from `config\gateway.env.example` if it does not exist.
3. Run `scripts\configure_secrets.ps1`. It migrates the existing plaintext PAT and optional gateway fallback secret to DPAPI, verifies decryption, copies Access configuration into `config\gateway.env`, and only then removes the legacy plaintext entries.
4. Start with `github-mcp.ps1 up`, then run `github-mcp.ps1 test`.
5. Optionally install `scripts\install_runtime_task.ps1` so the current Windows user re-injects runtime secrets after logon/Docker restart.

Do not use `docker compose up` directly after this migration: the gateway intentionally waits for the host wrapper to inject its tmpfs credential.
