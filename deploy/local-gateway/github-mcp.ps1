param(
    [ValidateSet("up", "down", "status", "logs", "test", "import-secrets")]
    [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $IsWindows) { throw "This local runtime wrapper is supported on Windows only." }
if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA is required." }

$Root = $PSScriptRoot
$SecretDir = Join-Path $env:LOCALAPPDATA "GitHubMCP\secrets"
$PatPath = Join-Path $SecretDir "github_pat.dpapi"
$GatewaySecretPath = Join-Path $SecretDir "gateway_secret.dpapi"
$GatewayEnv = Join-Path $Root "config\gateway.env"
$LegacyPaths = @(
    (Join-Path $env:LOCALAPPDATA "GitHubMCP\secrets.env"),
    (Join-Path $Root "secrets.env")
) | Select-Object -Unique
$Compose = @("compose", "--project-directory", $Root, "--env-file", (Join-Path $Root ".env"), "-f", (Join-Path $Root "compose.yaml"))

function Wait-Docker {
    $deadline = (Get-Date).AddSeconds(120)
    do {
        try {
            & docker version --format '{{.Server.Version}}' 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { return }
        } catch {}
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw "Docker engine did not become ready within 120 seconds."
}

function Get-EnvValue([string]$Path, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    $line = @(Get-Content -LiteralPath $Path | Where-Object {
        $_ -match ("^\s*" + [regex]::Escape($Name) + "=")
    })[0]
    if (-not $line) { return "" }
    return (($line -split "=", 2)[1]).Trim()
}

function Get-DpapiSecretValue([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label DPAPI secret is missing. Run .\scripts\configure_secrets.ps1."
    }
    $secure = ConvertTo-SecureString -String (Get-Content -LiteralPath $Path -Raw)
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        if ([string]::IsNullOrWhiteSpace($plain)) { throw "$Label DPAPI secret decrypted to an empty value." }
        return $plain
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        $secure = $null
    }
}

function Assert-NoLegacyPlaintextSecrets {
    foreach ($path in $LegacyPaths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        foreach ($name in @("GITHUB_PERSONAL_ACCESS_TOKEN", "GATEWAY_SECRET")) {
            $value = Get-EnvValue -Path $path -Name $name
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                throw "Legacy plaintext $name found in $path. Run .\scripts\configure_secrets.ps1 before starting."
            }
        }
    }
}

function Import-RuntimeSecret([string]$Path, [string]$Label, [string]$ContainerPath) {
    $plain = Get-DpapiSecretValue -Path $Path -Label $Label
    try {
        $plain | & docker @Compose exec -T --user 1000:1000 github-gateway sh -c "umask 077; cat > '$ContainerPath'"
        if ($LASTEXITCODE -ne 0) { throw "$Label runtime import failed." }
    } finally {
        $plain = $null
    }
    & docker @Compose exec -T --user 1000:1000 github-gateway sh -c "test -s '$ContainerPath'"
    if ($LASTEXITCODE -ne 0) { throw "$Label runtime verification failed." }
}

function Import-RuntimeSecrets {
    Import-RuntimeSecret -Path $PatPath -Label "GitHub PAT" -ContainerPath "/run/github-mcp-secrets/github_pat"
    if ((Get-EnvValue -Path $GatewayEnv -Name "ALLOW_SECRET_PATH") -eq "1") {
        Import-RuntimeSecret -Path $GatewaySecretPath -Label "Gateway fallback secret" -ContainerPath "/run/github-mcp-secrets/gateway_secret"
    }
}

function Wait-GatewayHealthy {
    $deadline = (Get-Date).AddSeconds(30)
    do {
        & docker @Compose exec -T github-gateway node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>$null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "GitHub gateway did not become healthy within 30 seconds."
}

Wait-Docker

switch ($Action) {
    "up" {
        Assert-NoLegacyPlaintextSecrets
        if (-not (Test-Path -LiteralPath $PatPath -PathType Leaf)) {
            throw "GitHub PAT DPAPI secret is missing. Run .\scripts\configure_secrets.ps1 first."
        }
        & docker @Compose up -d
        if ($LASTEXITCODE -ne 0) { throw "docker compose up failed." }
        Import-RuntimeSecrets
        Wait-GatewayHealthy
        Write-Host "GITHUB_MCP_UP"
    }
    "import-secrets" {
        Assert-NoLegacyPlaintextSecrets
        Import-RuntimeSecrets
        Wait-GatewayHealthy
        Write-Host "GITHUB_MCP_RUNTIME_SECRETS_IMPORTED"
    }
    "down" {
        & docker @Compose down
        if ($LASTEXITCODE -ne 0) { throw "docker compose down failed." }
    }
    "status" {
        & docker @Compose ps
    }
    "logs" {
        & docker @Compose logs -f --tail 100 github-mcp github-gateway
    }
    "test" {
        Wait-GatewayHealthy
        $gatewayId = (& docker @Compose ps -q github-gateway).Trim()
        if (-not $gatewayId) { throw "github-gateway is not running." }

        $configEnv = @(& docker inspect $gatewayId --format '{{json .Config.Env}}' | ConvertFrom-Json)
        foreach ($name in @("GITHUB_PERSONAL_ACCESS_TOKEN", "GATEWAY_SECRET")) {
            if (@($configEnv | Where-Object { $_ -like "$name=*" }).Count) {
                throw "$name is present in Docker .Config.Env."
            }
        }

        & docker @Compose exec -T github-gateway sh -c 'test -s /run/github-mcp-secrets/github_pat'
        if ($LASTEXITCODE -ne 0) { throw "GitHub PAT tmpfs file is missing." }

        $diff = @(& docker diff $gatewayId)
        if (@($diff | Where-Object { $_ -match '/run/github-mcp-secrets/(github_pat|gateway_secret)' }).Count) {
            throw "Runtime secret unexpectedly appeared in the container writable layer."
        }

        Write-Host "GITHUB_MCP_SECURITY_TEST_PASS"
        Write-Host "  PAT absent from Docker .Config.Env"
        Write-Host "  PAT present in runtime tmpfs"
        Write-Host "  Runtime secret absent from docker diff"
    }
}
