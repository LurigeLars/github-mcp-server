param(
    [string]$Target = "C:\ClaudeCode\github-mcp-local"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $IsWindows) { throw "This runtime sync is supported on Windows only." }

$Source = $PSScriptRoot
$sourceFull = [IO.Path]::GetFullPath($Source).TrimEnd("\")
$targetFull = [IO.Path]::GetFullPath($Target).TrimEnd("\")
if ($sourceFull -eq $targetFull) { throw "Source and target must be different directories." }
if (-not (Test-Path -LiteralPath $Target -PathType Container)) {
    throw "Runtime target does not exist: $Target"
}

$protected = @(
    ".env",
    "config\github.env",
    "config\gateway.env"
)
foreach ($relative in $protected) {
    $path = Join-Path $Target $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Refusing sync because protected runtime config is missing: $path"
    }
}

function Copy-TrackedFile([string]$Relative) {
    $src = Join-Path $Source $Relative
    $dst = Join-Path $Target $Relative
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
        throw "Source file is missing: $src"
    }
    $parent = Split-Path -Parent $dst
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
}

function Copy-TrackedTree([string]$Relative) {
    $srcRoot = Join-Path $Source $Relative
    if (-not (Test-Path -LiteralPath $srcRoot -PathType Container)) {
        throw "Source directory is missing: $srcRoot"
    }
    Get-ChildItem -LiteralPath $srcRoot -File -Recurse | ForEach-Object {
        $relativeFile = [IO.Path]::GetRelativePath($Source, $_.FullName)
        Copy-TrackedFile $relativeFile
    }
}

foreach ($relative in @(
    "compose.yaml",
    "cloudflared.ingress-snippet.yml",
    ".env.example",
    "secrets.env.example",
    "github-mcp.ps1",
    "config\github.env.example",
    "config\gateway.env.example"
)) {
    Copy-TrackedFile $relative
}
Copy-TrackedTree "public"
Copy-TrackedTree "scripts"

foreach ($relative in $protected) {
    if (-not (Test-Path -LiteralPath (Join-Path $Target $relative) -PathType Leaf)) {
        throw "Protected runtime config disappeared during sync: $relative"
    }
}

Write-Host "RUNTIME_SYNCED"
Write-Host "Target: $Target"
Write-Host "Protected local config and DPAPI secret storage were not modified."
Write-Host "Next: pwsh -NoProfile -File \"$Target\github-mcp.ps1\" up"
