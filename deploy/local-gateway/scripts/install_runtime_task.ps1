param(
    [string]$Target = "C:\ClaudeCode\github-mcp-local",
    [string]$TaskName = "GitHubMcpRuntime"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $IsWindows) { throw "Windows Task Scheduler setup is supported on Windows only." }
$runner = Join-Path $Target "github-mcp.ps1"
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "Runtime wrapper not found: $runner" }

$action = New-ScheduledTaskAction `
    -Execute "pwsh.exe" `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $runner + '" up') `
    -WorkingDirectory $Target
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Host "TASK_INSTALLED: $TaskName"
Write-Host "The task runs under the current Windows user so DPAPI CurrentUser can decrypt the runtime secrets."
