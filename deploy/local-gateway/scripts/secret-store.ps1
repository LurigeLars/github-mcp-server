Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop
Set-StrictMode -Version Latest

function Get-GitHubMcpSecretRoot {
  return (Join-Path $env:LOCALAPPDATA 'GitHubMCP\secrets')
}

function Write-DpapiSecret {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw 'Refusing to protect an empty secret.'
  }

  $directory = Split-Path $Path -Parent
  New-Item -ItemType Directory -Path $directory -Force | Out-Null

  $plainBytes = [Text.Encoding]::UTF8.GetBytes($Value)
  try {
    $protected = [Security.Cryptography.ProtectedData]::Protect(
      $plainBytes,
      $null,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )

    $temp = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
      [IO.File]::WriteAllBytes($temp, $protected)
      Move-Item -LiteralPath $temp -Destination $Path -Force
    } finally {
      if (Test-Path $temp) { Remove-Item -LiteralPath $temp -Force }
    }
  } finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  }

  $roundTrip = Read-DpapiSecret -Path $Path
  if ($roundTrip -cne $Value) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    throw 'DPAPI round-trip verification failed.'
  }
}

function Read-DpapiSecret {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path $Path)) {
    throw "Protected secret is missing: $Path"
  }

  $protected = [IO.File]::ReadAllBytes($Path)
  $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $protected,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  try {
    return [Text.Encoding]::UTF8.GetString($plainBytes)
  } finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  }
}
