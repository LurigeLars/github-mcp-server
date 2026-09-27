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
$pat = Read-DpapiSecret -Path $patSchema
