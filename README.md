# GitHub MCP local deployment overlay

[![Overlay CI](https://github.com/LurigeLars/github-mcp-server/actions/workflows/overlay-ci.yml/badge.svg)](https://github.com/LurigeLars/github-mcp-server/actions/workflows/overlay-ci.yml)
[![Gateway security](https://github.com/LurigeLars/github-mcp-server/actions/workflows/local-gateway-security.yml/badge.svg)](https://github.com/LurigeLars/github-mcp-server/actions/workflows/local-gateway-security.yml)
[![CodeQL](https://github.com/LurigeLars/github-mcp-server/actions/workflows/codeql.yml/badge.svg)](https://github.com/LurigeLars/github-mcp-server/actions/workflows/codeql.yml)
![License](https://img.shields.io/badge/license-MIT-green)

A thin deployment and security overlay around the **official GitHub MCP Server container**.

This repository does not reimplement GitHub MCP Server. Its job is to run the official
backend locally with a controlled secret path, hardened containers and a policy/auth
gateway suitable for an authenticated remote MCP client such as ChatGPT.

## Why this repository exists

The official GitHub MCP Server already owns GitHub API behavior and the MCP tool
implementation. Re-forking or vendoring that code would create an unnecessary
maintenance branch.

The local deployment still needs infrastructure around it:

- an immutable reviewed upstream image pin;
- secure local storage for the GitHub credential;
- runtime-only credential injection;
- a cloud-facing authentication/policy boundary;
- a private backend network;
- container hardening;
- deployment/update scripts;
- CI that tests the overlay itself.

That is the scope of this repository.

## Ownership boundary

| Upstream GitHub MCP Server owns | This repository owns |
|---|---|
| MCP server implementation | Compose/deployment wiring |
| GitHub API integrations | Cloudflare-facing Node gateway |
| Tool behavior and upstream fixes | gateway policy/tool filtering |
| official releases and image | image tag + immutable digest pin |
| upstream documentation | Windows DPAPI secret handling |
| | local runtime scripts, tests and CI |

Do not vendor or patch upstream GitHub MCP Server Go/UI source here. Upstream changes are
adopted through reviewed official container releases.

## Architecture

```text
GitHub API
    ^
    |
official GitHub MCP Server
    ^
    | private Docker network
    |
github-gateway
    ^
    |
Cloudflare Access / Tunnel
    ^
    |
remote MCP client
```

The backend does not join the public edge network. The gateway is the only service that
can see both the private GitHub MCP backend and the Cloudflare-facing edge.

## Secret model

The GitHub credential is intentionally not placed in Compose environment variables,
image layers, command-line arguments or Git.

On Windows:

```text
DPAPI CurrentUser blob
      |
      | decrypt in host wrapper
      v
PowerShell process memory
      |
      | stdin
      v
gateway tmpfs
      |
      | consume + unlink
      v
gateway process memory
      |
      v
fixed private GitHub MCP backend
```

DPAPI protects the credential at rest on the host. Plaintext still necessarily exists
transiently in process memory while the integration is running.

The gateway container does not auto-restart on its own because a bare Docker restart
cannot reconstruct that DPAPI-backed secret path. The Windows wrapper owns secure
rehydration.

## Security model

The maintained deployment uses several independent controls:

- official GitHub MCP backend pinned by release **and immutable image digest**;
- explicit non-root users for backend and gateway;
- read-only filesystems where practical;
- dropped Linux capabilities and `no-new-privileges`;
- private backend Docker network;
- Cloudflare Access in front of the public path;
- independent Access JWT/audience/identity validation in the gateway;
- client credentials stripped before forwarding;
- GitHub PAT injected through DPAPI -> stdin -> tmpfs;
- local deployment identifiers and credentials kept outside Git.

The canonical runtime pin is always the image reference in
[`deploy/local-gateway/compose.yaml`](deploy/local-gateway/compose.yaml). The README
does not duplicate the current version number so it cannot silently drift from the
deployed configuration.

## ChatGPT-specific policy layer

ChatGPT already has a first-party GitHub connector, so exposing every equivalent tool
from the local MCP produces duplicate choices without adding capability.

The gateway therefore presents a **delta tool surface** to ChatGPT:

- overlapping common repository operations can be hidden from `tools/list`;
- upstream tools remain implemented and usable by other local clients;
- distinct capabilities such as Actions control, security scanning, rulesets, releases,
  discussions, teams and other connector gaps can remain visible;
- actual denied tools are controlled separately from discovery filtering.

This is a model/tool-discovery optimization, not the primary security boundary.

For selected small text files owned by `LurigeLars`, the gateway can also rewrite
upstream embedded MCP text resources into ordinary text content so ChatGPT can consume
them without an unnecessary attachment-materialization hop. Binary and large-file paths
remain unchanged.

## Quick start

The canonical deployment lives in `deploy/local-gateway/`.

```powershell
cd deploy\local-gateway
.\github-mcp.ps1 up
.\github-mcp.ps1 status
.\github-mcp.ps1 test
```

Use the wrapper rather than calling `docker compose up` directly after DPAPI migration;
the wrapper is what injects the runtime credential.

To sync a newer checkout into an already-installed runtime:

```powershell
cd deploy\local-gateway
.\sync-runtime.ps1
```

The sync preserves protected local configuration and does not copy the DPAPI secret store.

## Repository layout

| Path | Purpose |
|---|---|
| `deploy/local-gateway/` | canonical Compose runtime, gateway and Windows wrappers |
| `deploy/local-gateway/public/` | Node auth/policy gateway |
| `docs/local-and-cloud-deployment.md` | detailed topology and trust boundaries |
| `.github/dependabot.yml` | upstream image / Actions dependency updates |
| `.github/workflows/` | overlay CI, security, static analysis and CodeQL |
| `scripts/windows/` | repository-development helpers |

## Updating the official GitHub MCP backend

Normally Dependabot proposes supported image updates.

For a manual update:

1. Review the official GitHub MCP Server release.
2. Update the image tag **and digest** in `deploy/local-gateway/compose.yaml`.
3. Run Overlay CI, Local Gateway Security, static analysis and CodeQL.
4. Merge through protected `main`.
5. Sync/deploy through the Windows wrapper.
6. Verify with `github-mcp.ps1 test`.

If an upstream release requires compatibility changes, adapt this overlay rather than
copying upstream server source into the repository.

## CI and branch policy

The main validation workflows are:

- `overlay-ci.yml` — validates the thin-overlay model and gateway behavior;
- `local-gateway-security.yml` — tests runtime-secret, Docker and Windows DPAPI boundaries;
- `static-analysis.yml` — shell/PowerShell/workflow/static checks;
- `codeql.yml` — CodeQL for the languages present in the overlay.

Updates are reviewed through pull requests and are not auto-merged.

## Local-only data

Do not commit GitHub credentials, DPAPI blobs, Cloudflare deployment identity,
machine-specific runtime paths or ignored local configuration.

See [`deploy/local-gateway/README.md`](deploy/local-gateway/README.md) for operational
secret handling and
[`docs/local-and-cloud-deployment.md`](docs/local-and-cloud-deployment.md) for the full
architecture.
