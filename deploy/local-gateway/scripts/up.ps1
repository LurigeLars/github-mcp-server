param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent),
  [int]$DockerWaitSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'secret-store.ps1')

function Wait-Docker([int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    & docker version --format '{{.Server.Version}}' *> $null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw "Docker did not become ready within $Seconds seconds."
}

Set-Location $Root
Wait-Docker -Seconds $DockerWaitSeconds

$patPath = Join-Path (Get-GitHubMcpSecretRoot) 'github_pat.dpapi'
$pat = Read-DpapiSecret -Path $patPath

try {
  $env:GITHUB_PAT_RUNTIME = $pat

  & docker compose -f compose.yaml up -d github-mcp
  if ($LASTEXITCODE -ne 0) { throw 'Could not start GitHub MCP backend.' }

  & docker compose -f compose.yaml up -d --force-recreate github-gateway
  if ($LASTEXITCODE -ne 0) { throw 'Could not start GitHub gateway.' }
} finally {
  Remove-Item Env:\GITHUB_PAT_RUNTIME -ErrorAction SilentlyContinue
  $pat = $null
}

$gatewayId = (& docker compose -f compose.yaml ps -q github-gateway).Trim()
if (-not $gatewayId) { throw 'GitHub gateway container is missing.' }

$inspect = & docker inspect $gatewayId | ConvertFrom-Json
$keys = @($inspect[0].Config.Env) | ForEach-Object { ($_ -split '=', 2)[0] }
$forbidden = @(
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'GITHUB_PAT_RUNTIME',
  'GATEWAY_SECRET',
  'GATEWAY_SECRET_RUNTIME'
)
$leaked = @($forbidden | Where-Object { $keys -contains $_ })
if ($leaked.Count -gt 0) {
  throw ('Persistent container environment contains forbidden secret keys: ' + ($leaked -join ', '))
}

& docker exec $gatewayId sh -eu -c 'test ! -e /run/github-mcp-secrets/github_pat'
if ($LASTEXITCODE -ne 0) { throw 'Runtime GitHub PAT file still exists after gateway startup.' }

& docker exec $gatewayId node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
if ($LASTEXITCODE -ne 0) { throw 'GitHub gateway health check failed.' }

Write-Host 'GitHub MCP local stack started.'
Write-Host '  DPAPI PAT: verified'
Write-Host '  Docker Config.Env secret keys: absent'
Write-Host '  Runtime tmpfs PAT file after startup: absent'
Write-Host '  Gateway health: pass'
