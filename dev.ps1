# Start the dev services in separate windows:
#   SSH tunnel to Postgres (:15432) -> research API (Python, :8001) -> backend (Spring Boot, :8080)
#   -> dashboard (Vite, :5173). Then open http://localhost:5173
$root = $PSScriptRoot

# PG_* settings from the gitignored .env
$envFile = @{}
if (Test-Path "$root\.env") {
    Get-Content "$root\.env" | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=(.*)$' } |
        ForEach-Object { $envFile[$Matches[1]] = $Matches[2].Trim() }
}

if ($envFile['PG_SSH_HOST']) {
    $local = if ($envFile['PG_LOCAL_PORT']) { $envFile['PG_LOCAL_PORT'] } else { '15432' }
    $pgHost = if ($envFile['PG_HOST']) { $envFile['PG_HOST'] } else { 'localhost' }
    $pgPort = if ($envFile['PG_PORT']) { $envFile['PG_PORT'] } else { '5432' }
    $forward = "${local}:${pgHost}:${pgPort}"
    Start-Process powershell -ArgumentList '-NoExit', '-Command',
        "Write-Host 'Postgres tunnel 127.0.0.1:$local -> $($envFile['PG_SSH_HOST']). Keep this window open.'; ssh -N -C -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -L $forward $($envFile['PG_SSH_HOST'])"
    Start-Sleep -Seconds 3  # let the tunnel come up before the backend runs its migrations
}

Start-Process powershell -ArgumentList '-NoExit', '-Command',
    "Set-Location '$root\quant'; .\.venv\Scripts\python.exe -m niftyquant.cli serve"

Start-Process powershell -ArgumentList '-NoExit', '-Command',
    "Set-Location '$root\backend'; mvn spring-boot:run"

Start-Process powershell -ArgumentList '-NoExit', '-Command',
    "Set-Location '$root\frontend'; npm run dev"

Write-Host 'Starting... open http://localhost:5173 once the windows are up.'
