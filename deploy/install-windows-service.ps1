# Windows server: run `npm ci; npm run build` in the campus-board folder first,
# then run this in an elevated PowerShell.
# Registers a startup task that runs the server as SYSTEM and restarts it if it stops.
$dir  = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$action   = New-ScheduledTaskAction -Execute $node -Argument "`"$dir\dist\server.js`"" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName "Campus Board" -Action $action -Trigger $trigger -Settings $settings `
  -User "SYSTEM" -RunLevel Highest -Force
New-NetFirewallRule -DisplayName "Campus Board 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Domain,Private | Out-Null
Start-ScheduledTask -TaskName "Campus Board"
Write-Host "Campus Board started. Open http://localhost:8080"
