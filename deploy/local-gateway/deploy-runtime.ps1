param(
  [ValidateSet('Up')]
  [string]$Action = 'Up',
  [string]$RuntimeTarget = 'C:\ClaudeCode\github-mcp-local'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $IsWindows) { throw 'GitHub MCP runtime deployment is supported on Windows only.' }

$SourceRoot = $PSScriptRoot
$Sync = Join-Path $SourceRoot 'sync-runtime.ps1'
$ExpectedTarget = [IO.Path]::GetFullPath('C:\ClaudeCode\github-mcp-local').TrimEnd('\')
$ActualTarget = [IO.Path]::GetFullPath($RuntimeTarget).TrimEnd('\')

if ($ActualTarget -ne $ExpectedTarget) { throw "Unexpected runtime target path: $ActualTarget" }
if (-not (Test-Path -LiteralPath $Sync -PathType Leaf)) { throw "Runtime sync script is missing: $Sync" }

& $Sync -Target $ActualTarget

$RuntimeWrapper = Join-Path $ActualTarget 'github-mcp.ps1'
if (-not (Test-Path -LiteralPath $RuntimeWrapper -PathType Leaf)) { throw "Runtime wrapper is missing after sync: $RuntimeWrapper" }

& $RuntimeWrapper import-secrets

Write-Host 'GITHUB_MCP_DEPLOYED'
