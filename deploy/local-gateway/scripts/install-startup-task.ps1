param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent),
  [string]$TaskName = 'GitHubMcpLocalStart'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$upScript = Join-Path $Root 'scripts\up.ps1'
if (-not (Test-Path $upScript)) { throw "Missing startup script: $upScript" }

$pwsh = (Get-Command pwsh).Source
$arguments = "-NoProfile -WindowStyle Hidden -Command `"Start-Sleep -Seconds 45; & '$upScript'`""
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Installed scheduled task: $TaskName"
