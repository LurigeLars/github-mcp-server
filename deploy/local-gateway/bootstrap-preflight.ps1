param(
    [string]$Target = "C:\ClaudeCode\github-mcp-local",
    [string]$FirecrawlRoot = "C:\ClaudeCode\firecrawl-local"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $IsWindows) { throw "This bootstrap is supported on Windows only." }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker CLI hittades inte." }
if (Test-Path -LiteralPath $Target) { throw "Målmappen finns redan: $Target" }

$Source = $PSScriptRoot
New-Item -ItemType Directory -Force -Path $Target | Out-Null
foreach ($relative in @(
    "compose.yaml",
    "cloudflared.ingress-snippet.yml",
    ".env.example",
    "secrets.env.example",
    "config",
    "public",
    "scripts",
    "github-mcp.ps1"
)) {
    Copy-Item -LiteralPath (Join-Path $Source $relative) -Destination (Join-Path $Target $relative) -Recurse
}
Copy-Item -LiteralPath (Join-Path $Target ".env.example") -Destination (Join-Path $Target ".env")
Copy-Item -LiteralPath (Join-Path $Target "config\github.env.example") -Destination (Join-Path $Target "config\github.env")
Copy-Item -LiteralPath (Join-Path $Target "config\gateway.env.example") -Destination (Join-Path $Target "config\gateway.env")

function Get-EnvValue([string]$Path, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    $line = @(Get-Content -LiteralPath $Path | Where-Object { $_ -match ("^\s*" + [regex]::Escape($Name) + "=") })[0]
    if (-not $line) { return "" }
    return (($line -split "=", 2)[1]).Trim()
}
function Set-EnvValue([string]$Path, [string]$Name, [string]$Value) {
    $content = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw } else { "" }
    $pattern = "(?m)^" + [regex]::Escape($Name) + "=.*$"
    $replacement = "$Name=$Value"
    if ($content -match $pattern) { $content = [regex]::Replace($content, $pattern, $replacement) }
    else { $content += [Environment]::NewLine + $replacement + [Environment]::NewLine }
    [IO.File]::WriteAllText($Path, $content, [Text.UTF8Encoding]::new($false))
}

$firecrawlEnv = Join-Path $FirecrawlRoot ".env"
$gatewayEnv = Join-Path $FirecrawlRoot "public\gateway.env"
foreach ($name in @("ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ACCESS_ALLOWED_EMAILS")) {
    $value = Get-EnvValue $firecrawlEnv $name
    if (-not $value) { $value = Get-EnvValue $gatewayEnv $name }
    if ($value) { Set-EnvValue (Join-Path $Target "config\gateway.env") $name $value }
}
Set-EnvValue (Join-Path $Target "config\gateway.env") "ALLOW_SECRET_PATH" "0"

Write-Host "BOOTSTRAP_READY"
Write-Host "No GitHub credential was written to env or config files."
Write-Host "Next: pwsh -NoProfile -File $Target\scripts\configure_secrets.ps1"
