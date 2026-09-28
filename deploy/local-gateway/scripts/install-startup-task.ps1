param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent),
  [string]$TaskName = 'GitHubMcpLocalStart'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $IsWindows) { throw 'Windows Task Scheduler setup is supported on Windows only.' }
$runner = Join-Path $Root 'github-mcp.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "Runtime wrapper not found: $runner" }

$pwsh = (Get-Command pwsh).Source
$arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $runner + '" up'
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "TASK_INSTALLED: $TaskName"
Write-Host 'The task runs as the current Windows user so DPAPI CurrentUser can decrypt the runtime secrets.'
