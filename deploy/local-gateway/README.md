# Local ChatGPT GitHub MCP deployment

This directory is the source of truth for the local Docker deployment that exposes the official GitHub MCP Server through a Cloudflare Access gateway.

## Secret boundary

- The GitHub PAT is encrypted at rest on Windows with DPAPI CurrentUser at `%LOCALAPPDATA%\GitHubMCP\secrets\github_pat.dpapi`.
- `scripts/up.ps1` decrypts it only for the lifetime of the startup command and passes it to a Compose `post_start` hook.
- The hook writes the PAT to a `tmpfs` file owned by the unprivileged `node` user.
- `public/gateway.mjs` reads the file once, unlinks it immediately, and keeps the credential only in process memory while forwarding requests.
- The PAT is not stored in Git, `.env`, Docker `.Config.Env`, or the container writable layer.
- Plaintext necessarily exists transiently in the Windows PowerShell process, Docker exec/post-start environment, and the Node gateway process memory.

Cloudflare Access is mandatory. The old secret-path emergency fallback has been removed rather than maintaining a second long-lived secret.

## Local-only files

Copy examples before first use:

- `.env.example` -> `.env`
- `config/github.env.example` -> `config/github.env`
- `config/gateway.env.example` -> `config/gateway.env`

These generated files are ignored by Git.

## Existing-install migration

For a fresh installation, protect the PAT once with:

```powershell
pwsh -NoProfile -File .\scripts\configure-pat.ps1
```

For an existing deployment that still uses `%LOCALAPPDATA%\GitHubMCP\secrets.env`, update the deployment files first and then run:

```powershell
pwsh -NoProfile -File .\scripts\migrate-secrets.ps1
pwsh -NoProfile -File .\scripts\up.ps1
```

The migration verifies the DPAPI round trip before deleting the legacy plaintext file. It also moves the non-secret Cloudflare Access settings into `config/gateway.env` and removes the obsolete `GITHUB_MCP_SECRETS_FILE` entry from `.env`.

## Startup

`github-gateway` deliberately uses `restart: "no"` because its tmpfs credential disappears whenever the container stops. Install the logon task after a successful manual migration:

```powershell
pwsh -NoProfile -File .\scripts\install-startup-task.ps1
```

If Docker Desktop is restarted during a session, rerun `scripts/up.ps1`.
