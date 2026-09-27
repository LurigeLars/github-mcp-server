param(
    [string]$Target = "C:\ClaudeCode\github-mcp-local"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $IsWindows) { throw "GitHub MCP DPAPI secret storage is supported on Windows only." }
if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA is required." }

$SecretDir = Join-Path $env:LOCALAPPDATA "GitHubMCP\secrets"
$PatPath = Join-Path $SecretDir "github_pat.dpapi"
$GatewaySecretPath = Join-Path $SecretDir "gateway_secret.dpapi"
$GatewayEnv = Join-Path $Target "config\gateway.env"
$GatewayEnvExample = Join-Path $Target "config\gateway.env.example"
$RootEnv = Join-Path $Target ".env"
$LegacyPaths = @(
    (Join-Path $env:LOCALAPPDATA "GitHubMCP\secrets.env"),
    (Join-Path $Target "secrets.env")
) | Select-Object -Unique

New-Item -ItemType Directory -Force -Path $SecretDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $GatewayEnv -Parent) | Out-Null
if (-not (Test-Path -LiteralPath $GatewayEnv) -and (Test-Path -LiteralPath $GatewayEnvExample)) {
    Copy-Item -LiteralPath $GatewayEnvExample -Destination $GatewayEnv
}

function Get-EnvValue([string]$Path, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $pattern = "^\s*" + [regex]::Escape($Name) + "="
    $entries = @(Get-Content -LiteralPath $Path | Where-Object { $_ -match $pattern })
    if ($entries.Count -gt 1) { throw "$Path contains more than one $Name entry." }
    if ($entries.Count -eq 0) { return $null }
    return (($entries[0] -split "=", 2)[1]).Trim()
}

function Set-EnvValue([string]$Path, [string]$Name, [string]$Value) {
    $content = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw } else { "" }
    $pattern = "(?m)^\s*" + [regex]::Escape($Name) + "=.*$"
    $replacement = $Name + "=" + $Value
    if ($content -match $pattern) {
        $content = [regex]::Replace($content, $pattern, $replacement)
    } else {
        if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) { $content += "`r`n" }
        $content += $replacement + "`r`n"
    }
    [IO.File]::WriteAllText($Path, $content, [Text.UTF8Encoding]::new($false))
}

function Save-DpapiSecret([Security.SecureString]$Secure, [string]$Path, [string]$Label) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        if ([string]::IsNullOrWhiteSpace($plain)) { throw "$Label must not be empty." }
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        $plain = $null
    }

    $encrypted = ConvertFrom-SecureString -SecureString $Secure
    $tmp = "$Path.tmp"
    [IO.File]::WriteAllText($tmp, $encrypted, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmp -Destination $Path -Force

    $verifySecure = ConvertTo-SecureString -String (Get-Content -LiteralPath $Path -Raw)
    $verifyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($verifySecure)
    try {
        $verifyPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($verifyPtr)
        if ([string]::IsNullOrWhiteSpace($verifyPlain)) { throw "DPAPI verification failed for $Label." }
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($verifyPtr)
        $verifyPlain = $null
        $verifySecure = $null
    }
}

function Get-DpapiPlain([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $secure = ConvertTo-SecureString -String (Get-Content -LiteralPath $Path -Raw)
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        if ([string]::IsNullOrWhiteSpace($plain)) { throw "$Label DPAPI secret is empty." }
        return $plain
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        $secure = $null
    }
}

function Find-LegacyValue([string]$Name) {
    $found = @()
    foreach ($path in $LegacyPaths) {
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

function Remove-EnvNames([string]$Path, [string[]]$Names) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $patterns = @($Names | ForEach-Object { "^\s*" + [regex]::Escape($_) + "=" })
    $remaining = @(Get-Content -LiteralPath $Path | Where-Object {
        $line = $_
        -not @($patterns | Where-Object { $line -match $_ }).Count
    })
    $meaningful = @($remaining | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_) -and -not $_.TrimStart().StartsWith("#")
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

foreach ($name in @("ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ACCESS_ALLOWED_EMAILS", "ALLOW_SECRET_PATH")) {
    $value = Find-LegacyValue -Name $name
    if ($null -ne $value) { Set-EnvValue -Path $GatewayEnv -Name $name -Value $value }
}

$legacyPat = Find-LegacyValue -Name "GITHUB_PERSONAL_ACCESS_TOKEN"
if (Test-Path -LiteralPath $PatPath -PathType Leaf) {
    $existingPat = Get-DpapiPlain -Path $PatPath -Label "GitHub PAT"
    try {
        if (-not [string]::IsNullOrWhiteSpace($legacyPat) -and $existingPat -cne $legacyPat) {
            throw "Existing DPAPI GitHub PAT does not match the legacy PAT. Refusing to delete plaintext."
        }
    } finally {
        $existingPat = $null
        $legacyPat = $null
    }
} else {
    if (-not [string]::IsNullOrWhiteSpace($legacyPat)) {
        $securePat = ConvertTo-SecureString -String $legacyPat -AsPlainText -Force
        $legacyPat = $null
    } else {
        $securePat = Read-Host "Klistra in GitHub PAT" -AsSecureString
    }
    Save-DpapiSecret -Secure $securePat -Path $PatPath -Label "GitHub PAT"
    $securePat = $null
}

$legacyGatewaySecret = Find-LegacyValue -Name "GATEWAY_SECRET"
if (-not [string]::IsNullOrWhiteSpace($legacyGatewaySecret)) {
    if (Test-Path -LiteralPath $GatewaySecretPath -PathType Leaf) {
        $existingGatewaySecret = Get-DpapiPlain -Path $GatewaySecretPath -Label "Gateway fallback secret"
        try {
            if ($existingGatewaySecret -cne $legacyGatewaySecret) {
                throw "Existing DPAPI gateway secret does not match the legacy value. Refusing to delete plaintext."
            }
        } finally {
            $existingGatewaySecret = $null
            $legacyGatewaySecret = $null
        }
    } else {
        $secureGateway = ConvertTo-SecureString -String $legacyGatewaySecret -AsPlainText -Force
        $legacyGatewaySecret = $null
        Save-DpapiSecret -Secure $secureGateway -Path $GatewaySecretPath -Label "Gateway fallback secret"
        $secureGateway = $null
    }
}

$verifyPat = Get-DpapiPlain -Path $PatPath -Label "GitHub PAT"
$verifyPat = $null

foreach ($path in $LegacyPaths) {
    Remove-EnvNames -Path $path -Names @(
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "GATEWAY_SECRET",
        "ACCESS_TEAM_DOMAIN",
        "ACCESS_AUD",
        "ACCESS_ALLOWED_EMAILS",
        "ALLOW_SECRET_PATH"
    )
}
Remove-EnvNames -Path $RootEnv -Names @("GITHUB_MCP_SECRETS_FILE")

Write-Host "GITHUB_PAT_STORED_DPAPI"
Write-Host "Path: $PatPath"
if (Test-Path -LiteralPath $GatewaySecretPath -PathType Leaf) {
    Write-Host "GATEWAY_FALLBACK_SECRET_STORED_DPAPI"
    Write-Host "Path: $GatewaySecretPath"
}
Write-Host "Legacy plaintext GitHub/gateway secret entries removed after DPAPI verification."
