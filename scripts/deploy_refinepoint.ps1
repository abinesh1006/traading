<#
Deploy Nifty Quant to the RefinePoint dev server (the PG_SSH_HOST in .env).

  powershell -ExecutionPolicy Bypass -File scripts\deploy_refinepoint.ps1            # app + core data
  powershell -ExecutionPolicy Bypass -File scripts\deploy_refinepoint.ps1 -DataOnly  # refresh data only
  powershell -ExecutionPolicy Bypass -File scripts\deploy_refinepoint.ps1 -SkipData  # app only
  ... -ChainYears 2024,2025,2026                                                     # option-chain days to copy

What it does:
  1. Builds the React app and packs the committed backend + quant source (git HEAD, not the working tree).
  2. Uploads them; the server builds the jar itself (Maven wrapper) because this PC's uplink is slow.
  3. Copies the data the API reads: derived summary tables, manifest, reports, and per-day option-chain
     files for -ChainYears (default: this year). The full history is ~800 MB; add years as needed.
  4. Writes ~/niftyquant/env (PG_* only, chmod 600) and runs scripts/refinepoint/server.sh install + restart.

Everything on the server stays under ~/niftyquant and listens on 127.0.0.1. Open it with the tunnel
printed at the end. The server never migrates or loads Postgres: that stays with this PC.
#>
param(
    [switch]$DataOnly,
    [switch]$SkipData,
    [int[]]$ChainYears = @((Get-Date).Year)
)
# Native tools (npm, git, ssh, scp, tar) write progress to stderr; failures are caught by exit code.
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$remoteRoot = 'niftyquant'
$port = 18088

$envFile = @{}
Get-Content "$root\.env" | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=(.*)$' } |
    ForEach-Object { $envFile[$Matches[1]] = $Matches[2].Trim() }
$sshHost = $envFile['PG_SSH_HOST']
if (-not $sshHost) { throw 'PG_SSH_HOST is not set in .env' }

$work = Join-Path $env:TEMP "nq-deploy-$PID"
New-Item -ItemType Directory -Force $work | Out-Null

function Invoke-Remote([string]$cmd) {
    ssh -o BatchMode=yes $sshHost $cmd
    if ($LASTEXITCODE -ne 0) { throw "remote command failed: $cmd" }
}
function Send-File([string]$local, [string]$remote) {
    scp -q -o BatchMode=yes $local "${sshHost}:$remote"
    if ($LASTEXITCODE -ne 0) { throw "upload failed: $local" }
}

try {
    Invoke-Remote "mkdir -p ~/$remoteRoot/incoming ~/$remoteRoot/data ~/$remoteRoot/logs"

    if (-not $DataOnly) {
        Write-Host 'Building the React app...'
        Push-Location "$root\frontend"
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'frontend build failed' }
        Pop-Location
        tar -czf "$work\web.tar.gz" -C "$root\frontend\dist" .

        Write-Host "Packing source at $(git -C $root rev-parse --short HEAD)..."
        # core.autocrlf=false: keep LF line endings for the Linux scripts.
        git -C $root -c core.autocrlf=false archive --format=tar.gz -o "$work\src.tar.gz" HEAD `
            backend quant/src quant/pyproject.toml scripts/refinepoint
        if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }

        Write-Host 'Uploading app...'
        Send-File "$work\src.tar.gz" "$remoteRoot/incoming/src.tar.gz"
        Send-File "$work\web.tar.gz" "$remoteRoot/incoming/web.tar.gz"

        # Postgres settings for the server side (Postgres is local there); never the other secrets.
        $pg = 'PG_HOST', 'PG_PORT', 'PG_DB', 'PG_USER', 'PG_PASSWORD', 'PG_SSLMODE' |
            ForEach-Object { "$_='$(([string]$envFile[$_]).Replace("'", "'\''"))'" }
        [IO.File]::WriteAllText("$work\env", ($pg -join "`n") + "`n")
        Send-File "$work\env" "$remoteRoot/env.new"
        Invoke-Remote "cd ~/$remoteRoot && chmod 600 env.new && mv env.new env"
    }

    if (-not $SkipData) {
    Write-Host "Packing data (chain years: $($ChainYears -join ', '))..."
    $data = "$root\data"
    $items = @('manifest.sqlite', 'reports') +
        (Get-ChildItem "$data\derived" -File | ForEach-Object { "derived/$($_.Name)" })
    foreach ($y in $ChainYears) {
        foreach ($d in "curated/nse/fo_bhavcopy/year=$y", "derived/option_greeks/year=$y") {
            if (Test-Path "$data\$d") { $items += $d }
        }
    }
    tar -czf "$work\data.tar.gz" -C $data @items
    $mb = (Get-Item "$work\data.tar.gz").Length / 1MB
    Write-Host ("Uploading data ({0:N1} MB)..." -f $mb)
    Send-File "$work\data.tar.gz" "$remoteRoot/incoming/data.tar.gz"
    Invoke-Remote "cd ~/$remoteRoot && tar -xzf incoming/data.tar.gz -C data && rm incoming/data.tar.gz"
    }

    if ($DataOnly) {
        Invoke-Remote "~/$remoteRoot/server.sh status"
    } else {
        Write-Host 'Installing and restarting on the server...'
        Invoke-Remote "cd ~/$remoteRoot && tar -xzf incoming/src.tar.gz -O scripts/refinepoint/server.sh > server.sh && chmod 755 server.sh && ./server.sh install && ./server.sh restart && ./server.sh status"
    }

    Write-Host ''
    Write-Host "Deployed. Open it through an SSH tunnel (keep the window open):"
    Write-Host "  ssh -N -L ${port}:127.0.0.1:${port} $sshHost"
    Write-Host "  then browse http://localhost:$port"
}
finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
