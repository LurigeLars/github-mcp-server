param([string]$Root = (Split-Path $PSScriptRoot -Parent))

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location $Root

$project = 'github-mcp-secret-smoke'
$compose = 'test/runtime-secret-smoke.compose.yaml'
$fake = 'github_pat_test_only_runtime_secret_12345678901234567890'
$env:GITHUB_MCP_DEPLOY_ROOT = $Root
$env:GITHUB_PAT_RUNTIME = $fake
try {
  & docker compose -p $project -f $compose up -d --force-recreate github-gateway-smoke
  if ($LASTEXITCODE -ne 0) { throw 'Smoke gateway did not start.' }
} finally {
  Remove-Item Env:\GITHUB_PAT_RUNTIME -ErrorAction SilentlyContinue
}

try {
  $id = (& docker compose -p $project -f $compose ps -q github-gateway-smoke).Trim()
  if (-not $id) { throw 'Smoke gateway container not found.' }
  Start-Sleep -Seconds 1

  $inspect = & docker inspect $id | ConvertFrom-Json
  $envValues = @($inspect[0].Config.Env)
  foreach ($name in @('GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_PAT_RUNTIME', 'GATEWAY_SECRET')) {
    if ($envValues | Where-Object { $_ -like "$name=*" }) {
      throw "$name leaked into Docker Config.Env."
    }
  }

  & docker exec $id sh -eu -c 'test ! -e /run/github-mcp-secrets/github_pat'
  if ($LASTEXITCODE -ne 0) { throw 'PAT file remained in tmpfs after gateway startup.' }

  $diff = @(& docker diff $id)
  if ($diff | Where-Object { $_ -match 'github_pat|github-mcp-secrets' }) {
    throw 'Secret path appeared in container writable-layer diff.'
  }

  & docker exec $id node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
  if ($LASTEXITCODE -ne 0) { throw 'Smoke gateway health check failed.' }

  Write-Host 'Runtime secret smoke PASS'
} finally {
  & docker compose -p $project -f $compose down -v *> $null
  Remove-Item Env:\GITHUB_MCP_DEPLOY_ROOT -ErrorAction SilentlyContinue
}
