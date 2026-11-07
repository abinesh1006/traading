# Daily NSE refresh: fetch the last 10 days, rebuild derived tables, re-run quality checks.
# Run by the "NiftyQuant daily update" scheduled task (see scripts\register_daily_task.ps1).
# Safe to run by hand any time; days already fetched are skipped.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'quant\.venv\Scripts\niftyquant.exe'
$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ("update_{0:yyyyMMdd_HHmm}.log" -f (Get-Date))

"[$(Get-Date -Format s)] niftyquant update starting" | Out-File $log -Encoding utf8
# Through cmd so stderr (Python logging) lands in the log as plain text; PowerShell 5.1 would
# otherwise wrap each stderr line as an error record and abort under ErrorActionPreference=Stop.
cmd.exe /c "`"$exe`" update >> `"$log`" 2>&1"
$code = $LASTEXITCODE
"[$(Get-Date -Format s)] finished with exit code $code" | Out-File $log -Append -Encoding utf8

# Keep the 60 most recent update logs.
Get-ChildItem $logDir -Filter 'update_*.log' | Sort-Object Name -Descending |
    Select-Object -Skip 60 | Remove-Item -Force

exit $code
