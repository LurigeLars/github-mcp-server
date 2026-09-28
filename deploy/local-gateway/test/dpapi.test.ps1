$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\secret-store.ps1')

$temp = Join-Path $env:TEMP ('github-mcp-dpapi-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $path = Join-Path $temp 'secret.dpapi'
  $secret = 'github_pat_test_only_not_a_real_credential_1234567890'
  Write-DpapiSecret -Path $path -Value $secret
  $roundTrip = Read-DpapiSecret -Path $path
  if ($roundTrip -cne $secret) { throw 'DPAPI round trip mismatch.' }
  $raw = [IO.File]::ReadAllBytes($path)
  $rawText = [Text.Encoding]::UTF8.GetString($raw)
  if ($rawText.Contains($secret)) { throw 'Plaintext secret found in protected blob.' }
  Write-Host 'DPAPI test PASS'
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
