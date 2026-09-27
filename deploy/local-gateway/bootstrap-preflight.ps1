param(
  [string]$Target = 'C:\ClaudeCode\github-mcp-local',
  [string]$FirecrawlRoot = 'C:\ClaudeCode\firecrawl-local'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-EnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path $Path)) { return '' }
  $line = Get-Content $Path | Where-Object { $_ -match ('^\s*' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if (-not $line) { return '' }
  return ($line -replace ('^\s*' + [regex]::Escape($Name) + '='), '').Trim()
}

function Set-EnvValue([string]$Path, [string]$Name, [string]$Value) {
  $content = if (Test-Path $Path) { Get-Content $Path -Raw } else { '' }
  $pattern = '(?m)^' + [regex]::Escape($Name) + '=.*$'
  $replacement = $Name + '=' + $Value
  if ($content -match $pattern) {
    $content = [regex]::Replace($content, $pattern, $replacement)
  } else {
    if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) { $content += "`r`n" }
    $content += $replacement + "`r`n"
  }
  Set-Content -LiteralPath $Path -Value $content -Encoding UTF8
}

if (Test-Path $Target) { throw "Target already exists: $Target" }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI not found.' }
& docker version --format '{{.Server.Version}}' | Out-Null

$source = $PSScriptRoot
New-Item -ItemType Directory -Path $Target -Force | Out-Null
Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $Target -Recurse -Force
}
Copy-Item (Join-Path $Target '.env.example') (Join-Path $Target '.env')
Copy-Item (Join-Path $Target 'config\github.env.example') (Join-Path $Target 'config\github.env')
Copy-Item (Join-Path $Target 'config\gateway.env.example') (Join-Path $Target 'config\gateway.env')

$rows = @(docker ps --filter 'label=com.docker.compose.service=cloudflared' --format '{{.ID}}|{{.Names}}')
if ($rows.Count -eq 0) { throw 'No running cloudflared Compose service found.' }

$chosen = $null
foreach ($row in $rows) {
  $cid = ($row -split '\|', 2)[0]
  $project = docker inspect $cid --format '{{ index .Config.Labels "com.docker.compose.project" }}'
  if ($project -eq 'firecrawl') { $chosen = $cid; break }
}
if (-not $chosen -and $rows.Count -eq 1) { $chosen = ($rows[0] -split '\|', 2)[0] }
if (-not $chosen) { throw 'Could not uniquely select the Firecrawl cloudflared container.' }

$networks = @(docker inspect $chosen --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{println}}{{end}}' |
  ForEach-Object { $_.Trim() } | Where-Object { $_ })
$edge = @($networks | Where-Object { $_ -like '*_edge' })
if ($edge.Count -ne 1) { throw 'Could not uniquely identify the shared *_edge network.' }
Set-EnvValue (Join-Path $Target '.env') 'MCP_EDGE_NETWORK' $edge[0]

$firecrawlEnv = Join-Path $FirecrawlRoot '.env'
$gatewayEnv = Join-Path $FirecrawlRoot 'public\gateway.env'
$team = Get-EnvValue $firecrawlEnv 'ACCESS_TEAM_DOMAIN'
if (-not $team) { $team = Get-EnvValue $gatewayEnv 'ACCESS_TEAM_DOMAIN' }
$aud = Get-EnvValue $firecrawlEnv 'ACCESS_AUD'
if (-not $aud) { $aud = Get-EnvValue $gatewayEnv 'ACCESS_AUD' }
$emails = Get-EnvValue $firecrawlEnv 'ACCESS_ALLOWED_EMAILS'
if (-not $emails) { $emails = Get-EnvValue $gatewayEnv 'ACCESS_ALLOWED_EMAILS' }

$targetGatewayEnv = Join-Path $Target 'config\gateway.env'
if ($team) { Set-EnvValue $targetGatewayEnv 'ACCESS_TEAM_DOMAIN' $team }
if ($aud) { Set-EnvValue $targetGatewayEnv 'ACCESS_AUD' $aud }
if ($emails) { Set-EnvValue $targetGatewayEnv 'ACCESS_ALLOWED_EMAILS' $emails }

Write-Host 'PRE-FLIGHT PASS'
Write-Host "  Folder: $Target"
Write-Host "  Edge:   $($edge[0])"
Write-Host '  GitHub PAT: not configured; use scripts/migrate-secrets.ps1 for an existing install or protect a PAT with scripts/secret-store.ps1.'
Write-Host '  Production containers: not started'
