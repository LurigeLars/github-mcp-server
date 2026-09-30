param(
  [ValidateSet('up', 'down', 'status', 'logs', 'test', 'import-secrets')]
  [string]$Action = 'status',
  [int]$DockerWaitSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $IsWindows) { throw 'This local runtime wrapper is supported on Windows only.' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required.' }

$Root = $PSScriptRoot
. (Join-Path $Root 'scripts\secret-store.ps1')
$SecretRoot = Get-GitHubMcpSecretRoot
$PatPath = Join-Path $SecretRoot 'github_pat.dpapi'
$GatewaySecretPath = Join-Path $SecretRoot 'gateway_secret.dpapi'
$GatewayEnv = Join-Path $Root 'config\gateway.env'
$LegacyPaths = @(
  (Join-Path $env:LOCALAPPDATA 'GitHubMCP\secrets.env'),
  (Join-Path $Root 'secrets.env')
) | Select-Object -Unique
$Compose = @('compose', '--project-directory', $Root, '--env-file', (Join-Path $Root '.env'), '-f', (Join-Path $Root 'compose.yaml'))
$EdgeNetwork = 'github-public_edge'

function Ensure-DedicatedEdgeNetwork {
  & docker network inspect $EdgeNetwork *> $null
  if ($LASTEXITCODE -ne 0) {
    & docker network create $EdgeNetwork *> $null
    if ($LASTEXITCODE -ne 0) { throw "Failed to create dedicated Docker network $EdgeNetwork." }
  }

  $cloudflared = @(& docker ps --filter 'label=com.docker.compose.service=cloudflared' --format '{{.ID}}' |
    ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($cloudflared.Count -ne 1) {
    throw "Expected exactly one running cloudflared service container; found $($cloudflared.Count)."
  }

  $networks = @(& docker inspect $cloudflared[0] --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{println}}{{end}}' |
    ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($networks -notcontains $EdgeNetwork) {
    & docker network connect $EdgeNetwork $cloudflared[0]
    if ($LASTEXITCODE -ne 0) { throw "Failed to attach cloudflared to $EdgeNetwork." }
  }
}

function Wait-Docker([int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    & docker version --format '{{.Server.Version}}' *> $null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw "Docker did not become ready within $Seconds seconds."
}

function Get-EnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  $line = @(Get-Content -LiteralPath $Path | Where-Object {
    $_ -match ('^\s*' + [regex]::Escape($Name) + '=')
  })[0]
  if (-not $line) { return '' }
  return (($line -split '=', 2)[1]).Trim()
}

function Assert-NoLegacyPlaintextSecrets {
  foreach ($path in $LegacyPaths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    foreach ($name in @('GITHUB_PERSONAL_ACCESS_TOKEN', 'GATEWAY_SECRET')) {
      $value = Get-EnvValue $path $name
      if (-not [string]::IsNullOrWhiteSpace($value)) {
        throw "Legacy plaintext $name found in $path. Run .\scripts\configure_secrets.ps1 before starting."
      }
    }
  }
}

function Import-RuntimeSecret([string]$Path, [string]$Label, [string]$ContainerPath) {
  $plain = Read-DpapiSecret -Path $Path
  try {
    if ([string]::IsNullOrWhiteSpace($plain)) { throw "$Label decrypted to an empty value." }
    $plain | & docker @Compose exec -T --user 1000:1000 github-gateway sh -c "umask 077; cat > '$ContainerPath'"
    if ($LASTEXITCODE -ne 0) { throw "$Label runtime import failed." }
  } finally {
    $plain = $null
  }
}

function Import-RuntimeSecrets {
  Import-RuntimeSecret $PatPath 'GitHub PAT' '/run/github-mcp-secrets/github_pat'
  if ((Get-EnvValue $GatewayEnv 'ALLOW_SECRET_PATH') -eq '1') {
    Import-RuntimeSecret $GatewaySecretPath 'Gateway fallback secret' '/run/github-mcp-secrets/gateway_secret'
  }
}

function Wait-GatewayHealthy {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    & docker @Compose exec -T github-gateway node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>$null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw 'GitHub gateway did not become healthy within 30 seconds.'
}

function Start-GatewayForSecretImport([switch]$ForceRecreate) {
  Ensure-DedicatedEdgeNetwork
  & docker @Compose up -d github-mcp
  if ($LASTEXITCODE -ne 0) { throw 'GitHub MCP backend start failed.' }

  # Normal "up" is intentionally idempotent. A healthy gateway has already
  # consumed its tmpfs credentials into process memory, so recreating it on
  # every supervisor/ensure-up pass causes an unnecessary recreate loop.
  if (-not $ForceRecreate) {
    $gatewayId = (& docker @Compose ps -q github-gateway).Trim()
    if ($gatewayId) {
      $health = (& docker inspect $gatewayId --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}').Trim()
      if ($LASTEXITCODE -eq 0 -and $health -eq 'healthy') {
        return
      }
    }
  }

  # Explicit secret re-import, or recovery from a missing/unhealthy gateway,
  # must recreate the process because credentials are consumed only at startup.
  & docker @Compose up -d --force-recreate github-gateway
  if ($LASTEXITCODE -ne 0) { throw 'GitHub gateway recreate failed.' }

  Import-RuntimeSecrets
  Wait-GatewayHealthy
}

Wait-Docker $DockerWaitSeconds

switch ($Action) {
  'up' {
    Assert-NoLegacyPlaintextSecrets
    if (-not (Test-Path -LiteralPath $PatPath -PathType Leaf)) {
      throw 'GitHub PAT DPAPI secret is missing. Run .\scripts\configure_secrets.ps1 first.'
    }
    Start-GatewayForSecretImport
    Write-Host 'GITHUB_MCP_UP'
  }
  'import-secrets' {
    Assert-NoLegacyPlaintextSecrets
    if (-not (Test-Path -LiteralPath $PatPath -PathType Leaf)) {
      throw 'GitHub PAT DPAPI secret is missing. Run .\scripts\configure_secrets.ps1 first.'
    }
    Start-GatewayForSecretImport -ForceRecreate
    Write-Host 'GITHUB_MCP_RUNTIME_SECRETS_IMPORTED'
  }
  'down' {
    & docker @Compose down
    if ($LASTEXITCODE -ne 0) { throw 'docker compose down failed.' }
  }
  'status' { & docker @Compose ps }
  'logs' { & docker @Compose logs -f --tail 100 github-mcp github-gateway }
  'test' {
    Wait-GatewayHealthy
    $gatewayId = (& docker @Compose ps -q github-gateway).Trim()
    if (-not $gatewayId) { throw 'github-gateway is not running.' }

    $configEnv = @(& docker inspect $gatewayId --format '{{json .Config.Env}}' | ConvertFrom-Json)
    foreach ($name in @('GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_PAT_RUNTIME', 'GATEWAY_SECRET', 'GATEWAY_SECRET_RUNTIME')) {
      if (@($configEnv | Where-Object { $_ -like "$name=*" }).Count) {
        throw "$name is present in Docker .Config.Env."
      }
    }

    & docker @Compose exec -T github-gateway sh -c 'test ! -e /run/github-mcp-secrets/github_pat'
    if ($LASTEXITCODE -ne 0) { throw 'GitHub PAT tmpfs file remained after gateway startup.' }
    if ((Get-EnvValue $GatewayEnv 'ALLOW_SECRET_PATH') -eq '1') {
      & docker @Compose exec -T github-gateway sh -c 'test ! -e /run/github-mcp-secrets/gateway_secret'
      if ($LASTEXITCODE -ne 0) { throw 'Gateway fallback tmpfs file remained after startup.' }
    }

    $diff = @(& docker diff $gatewayId)
    if (@($diff | Where-Object { $_ -match '/run/github-mcp-secrets/(github_pat|gateway_secret)' }).Count) {
      throw 'Runtime secret unexpectedly appeared in the container writable layer.'
    }

    Write-Host 'GITHUB_MCP_SECURITY_TEST_PASS'
    Write-Host '  PAT absent from Docker .Config.Env'
    Write-Host '  Runtime secret tmpfs file consumed and removed'
    Write-Host '  Runtime secret absent from docker diff'
  }
}
