param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'secret-store.ps1')

if (-not $IsWindows) { throw 'GitHub MCP secret migration is supported on Windows only.' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required.' }

function Get-EnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $pattern = '^\s*' + [regex]::Escape($Name) + '='
  $entries = @(Get-Content -LiteralPath $Path | Where-Object { $_ -match $pattern })
  if ($entries.Count -gt 1) { throw "$Path contains more than one $Name entry." }
  if ($entries.Count -eq 0) { return $null }
  return (($entries[0] -split '=', 2)[1]).Trim()
}

function Set-EnvValue([string]$Path, [string]$Name, [string]$Value) {
  $content = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw } else { '' }
  $pattern = '(?m)^\s*' + [regex]::Escape($Name) + '=.*$'
  $replacement = $Name + '=' + $Value
  if ($content -match $pattern) {
    $content = [regex]::Replace($content, $pattern, $replacement)
  } else {
    if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) { $content += "`r`n" }
    $content += $replacement + "`r`n"
  }
  [IO.File]::WriteAllText($Path, $content, [Text.UTF8Encoding]::new($false))
}

function Remove-EnvNames([string]$Path, [string[]]$Names) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  $patterns = @($Names | ForEach-Object { '^\s*' + [regex]::Escape($_) + '=' })
  $remaining = @(Get-Content -LiteralPath $Path | Where-Object {
    $line = $_
    -not @($patterns | Where-Object { $line -match $_ }).Count
  })
  $meaningful = @($remaining | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_) -and -not $_.TrimStart().StartsWith('#')
  })
  if ($meaningful.Count -eq 0) {
    Remove-Item -LiteralPath $Path -Force
    return
  }
  [IO.File]::WriteAllText(
    $Path,
    (($remaining -join [Environment]::NewLine) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )
}

$legacyPaths = @(
  (Join-Path $env:LOCALAPPDATA 'GitHubMCP\secrets.env'),
  (Join-Path $Root 'secrets.env')
) | Select-Object -Unique
$secretRoot = Get-GitHubMcpSecretRoot
$patBlob = Join-Path $secretRoot 'github_pat.dpapi'
$gatewayBlob = Join-Path $secretRoot 'gateway_secret.dpapi'
$gatewayConfig = Join-Path $Root 'config\gateway.env'
$gatewayExample = Join-Path $Root 'config\gateway.env.example'
$rootEnv = Join-Path $Root '.env'

if (-not (Test-Path -LiteralPath $gatewayConfig)) {
  if (-not (Test-Path -LiteralPath $gatewayExample)) { throw "Missing gateway config template: $gatewayExample" }
  Copy-Item -LiteralPath $gatewayExample -Destination $gatewayConfig
}

function Find-LegacyValue([string]$Name) {
  $found = @()
  foreach ($path in $legacyPaths) {
    $value = Get-EnvValue -Path $path -Name $Name
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      $found += [pscustomobject]@{ Path = $path; Value = $value }
    }
  }
  if ($found.Count -gt 1) {
    $first = $found[0].Value
    if (@($found | Where-Object { $_.Value -cne $first }).Count -gt 0) {
      throw "Legacy $Name values disagree across files. Refusing migration."
    }
  }
  if ($found.Count -eq 0) { return $null }
  return $found[0].Value
}

foreach ($name in @('ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ACCESS_ALLOWED_EMAILS', 'ALLOW_SECRET_PATH')) {
  $value = Find-LegacyValue $name
  if ($null -ne $value) { Set-EnvValue $gatewayConfig $name $value }
}

$legacyPat = Find-LegacyValue 'GITHUB_PERSONAL_ACCESS_TOKEN'
if (Test-Path -LiteralPath $patBlob -PathType Leaf) {
  $existing = Read-DpapiSecret -Path $patBlob
  try {
    if (-not [string]::IsNullOrWhiteSpace($legacyPat) -and $existing -cne $legacyPat) {
      throw 'Protected GitHub PAT and legacy plaintext PAT differ; refusing to delete either.'
    }
  } finally {
    $existing = $null
    $legacyPat = $null
  }
} else {
  if ([string]::IsNullOrWhiteSpace($legacyPat)) {
    $secure = Read-Host 'GitHub PAT' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $legacyPat = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
      $secure = $null
    }
  }
  if ([string]::IsNullOrWhiteSpace($legacyPat) -or $legacyPat.Length -lt 20) {
    throw 'GitHub PAT is missing or too short.'
  }
  Write-DpapiSecret -Path $patBlob -Value $legacyPat
  $legacyPat = $null
}

$legacyGateway = Find-LegacyValue 'GATEWAY_SECRET'
if (-not [string]::IsNullOrWhiteSpace($legacyGateway)) {
  if (Test-Path -LiteralPath $gatewayBlob -PathType Leaf) {
    $existingGateway = Read-DpapiSecret -Path $gatewayBlob
    try {
      if ($existingGateway -cne $legacyGateway) {
        throw 'Protected gateway fallback secret and legacy plaintext value differ; refusing deletion.'
      }
    } finally {
      $existingGateway = $null
      $legacyGateway = $null
    }
  } else {
    if ($legacyGateway.Length -lt 32) { throw 'Gateway fallback secret is too short.' }
    Write-DpapiSecret -Path $gatewayBlob -Value $legacyGateway
    $legacyGateway = $null
  }
}

$verifyPat = Read-DpapiSecret -Path $patBlob
if ([string]::IsNullOrWhiteSpace($verifyPat) -or $verifyPat.Length -lt 20) {
  throw 'Protected GitHub PAT verification failed.'
}
$verifyPat = $null

foreach ($path in $legacyPaths) {
  Remove-EnvNames $path @(
    'GITHUB_PERSONAL_ACCESS_TOKEN',
    'GATEWAY_SECRET',
    'ACCESS_TEAM_DOMAIN',
    'ACCESS_AUD',
    'ACCESS_ALLOWED_EMAILS',
    'ALLOW_SECRET_PATH'
  )
}
Remove-EnvNames $rootEnv @('GITHUB_MCP_SECRETS_FILE')

Write-Host 'GITHUB_PAT_STORED_DPAPI'
Write-Host "Path: $patBlob"
if (Test-Path -LiteralPath $gatewayBlob -PathType Leaf) {
  Write-Host 'GATEWAY_FALLBACK_SECRET_STORED_DPAPI'
  Write-Host "Path: $gatewayBlob"
}
Write-Host 'Legacy plaintext secret entries removed only after DPAPI round-trip verification.'
