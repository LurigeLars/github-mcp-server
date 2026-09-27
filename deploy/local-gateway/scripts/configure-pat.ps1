param([string]$Root = (Split-Path $PSScriptRoot -Parent))

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'secret-store.ps1')

$secure = Read-Host 'GitHub PAT' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$plain = $null
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if ([string]::IsNullOrWhiteSpace($plain) -or $plain.Length -lt 20) {
    throw 'GitHub PAT is missing or too short.'
  }
  $path = Join-Path (Get-GitHubMcpSecretRoot) 'github_pat.dpapi'
  Write-DpapiSecret -Path $path -Value $plain
  Write-Host "Protected GitHub PAT verified: $path"
} finally {
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  $plain = $null
  $secure = $null
}
