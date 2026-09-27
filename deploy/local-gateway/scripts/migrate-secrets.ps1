param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'secret-store.ps1')

function Get-EnvMap([string]$Path) {
  $map = @{}
  if (-not (Test-Path $Path)) { return $map }
  foreach ($line in Get-Content $Path) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $map[$Matches[1]] = $Matches[2]
    }
  }
  return $map
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

function Remove-EnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path $Path)) { return }
  $lines = Get-Content $Path | Where-Object {
    $_ -notmatch ('^\s*' + [regex]::Escape($Name) + '=')
  }
  Set-Content -LiteralPath $Path -Value $lines -Encoding UTF8
}

$legacy = Join-Path $env:LOCALAPPDATA 'GitHubMCP\secrets.env'
$secretRoot = Get-GitHubMcpSecretRoot
$patBlob = Join-Path $secretRoot 'github_pat.dpapi'
$gatewayConfig = Join-Path $Root 'config\gateway.env'
$gatewayExample = Join-Path $Root 'config\gateway.env.example'
$rootEnv = Join-Path $Root '.env'

$legacyMap = Get-EnvMap $legacy

if (-not (Test-Path $gatewayConfig)) {
  Copy-Item -LiteralPath $gatewayExample -Destination $gatewayConfig
}

foreach ($name in @('ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ACCESS_ALLOWED_EMAILS')) {
  if ($legacyMap.ContainsKey($name) -and -not [string]::IsNullOrWhiteSpace($legacyMap[$name])) {
    Set-EnvValue $gatewayConfig $name $legacyMap[$name]
  }
}

if (Test-Path $patBlob) {
  $existing = Read-DpapiSecret -Path $patBlob
  if ($legacyMap.ContainsKey('GITHUB_PERSONAL_ACCESS_TOKEN') -and
      -not [string]::IsNullOrWhiteSpace($legacyMap['GITHUB_PERSONAL_ACCESS_TOKEN']) -and
      $existing -cne $legacyMap['GITHUB_PERSONAL_ACCESS_TOKEN']) {
    throw 'Protected GitHub PAT and legacy plaintext PAT differ; refusing to delete either.'
  }
  Write-Host 'Existing DPAPI GitHub PAT verified.'
} else {
  if (-not $legacyMap.ContainsKey('GITHUB_PERSONAL_ACCESS_TOKEN') -or
      [string]::IsNullOrWhiteSpace($legacyMap['GITHUB_PERSONAL_ACCESS_TOKEN'])) {
    throw 'Legacy GitHub PAT not found; cannot migrate automatically.'
  }
  Write-DpapiSecret -Path $patBlob -Value $legacyMap['GITHUB_PERSONAL_ACCESS_TOKEN']
  Write-Host 'GitHub PAT protected with Windows DPAPI CurrentUser and verified.'
}

if (Test-Path $legacy) {
  Remove-Item -LiteralPath $legacy -Force
  Write-Host 'Legacy plaintext secrets.env removed.'
}

Remove-EnvValue $rootEnv 'GITHUB_MCP_SECRETS_FILE'

Write-Host 'Migration complete.'
Write-Host "Protected PAT: $patBlob"
Write-Host "Gateway config: $gatewayConfig"
