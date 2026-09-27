param([string]$Root = (Split-Path $PSScriptRoot -Parent))

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location $Root

$fake = 'github_pat_test_only_runtime_secret_12345678901234567890'
$env:GITHUB_PAT_RUNTIME = $fake
try {
  & docker compose -f compose.yaml -f test/runtime-secret-smoke.compose.yaml up -d --no-deps --force-recreate github-gateway
  if ($LASTEXITCODE -ne 0) { throw 'Smoke gateway did not start.' }
} finally {
  Remove-Item Env:\GITHUB_PAT_RUNTIME -ErrorAction SilentlyContinue
}

try {
  $id = (& docker compose -f compose.yaml -f test/runtime-secret-smoke.compose.yaml ps -q github-gateway).Trim()
  if (-not $id) { throw 'Smoke gateway container not found.' }
  Start-Sleep -Seconds 1

  $inspect = & docker inspect $id | ConvertFrom-Json
  $envValues = @($inspect[0].Config.Env)
  foreach ($name in @('GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_PAT_RUNTIME')) {
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

  Write-Host 'Runtime secret smoke PASS'
} finally {
  & docker compose -f compose.yaml -f test/runtime-secret-smoke.compose.yaml down -v *> $null
}
