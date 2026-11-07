# Registers (or replaces) the Windows scheduled task that runs daily_update.ps1 at 20:00 local time.
# This machine's clock is UTC+5:30, so 20:00 local = 20:00 IST, after NSE publishes the day's files.
# If the PC is off or asleep at 20:00, the task runs as soon as it is next available.
# Remove with: Unregister-ScheduledTask -TaskName 'NiftyQuant daily update' -Confirm:$false

$script = Join-Path $PSScriptRoot 'daily_update.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At '20:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'NiftyQuant daily update' -Action $action -Trigger $trigger `
    -Settings $settings -Description 'Fetch NSE Nifty files, rebuild derived tables, run quality checks' -Force
