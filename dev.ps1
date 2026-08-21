# SensePro+ — start the whole stack, correctly, every time.
#
#   .\dev.ps1
#
# Starts the FastAPI backend (port 8000) and the Vite dev server (port 5173) in
# two windows, waits until each is genuinely answering, then prints the ONE URL
# that works.
#
# Why this exists rather than "just run the two commands":
#  * The backend loads the InsightFace model inside uvicorn's lifespan, which
#    blocks every connection — including the capture WebSocket — until it
#    finishes. Cold start is ~30s and looks exactly like an outage. This waits
#    for /healthz and says so.
#  * Vite runs with host:true (the phone needs to reach the QR page), so it
#    advertises a LAN URL like http://192.168.1.19:5173. Browsers only expose
#    navigator.mediaDevices on a SECURE origin, and a plain-http LAN address is
#    not one — open the app there and the camera silently cannot start, while
#    the API and socket still connect fine. So: always open http://localhost:5173
#    on this machine. (Phones use the https tunnel, which IS secure.)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backend = Join-Path $root 'backend'
$web = Join-Path $root 'apps\web'
$py = Join-Path $backend '.venv\Scripts\python.exe'

if (-not (Test-Path $py)) {
    Write-Host "No backend venv at $py" -ForegroundColor Red
    Write-Host "Create it first:  cd backend; python -m venv .venv; .\.venv\Scripts\pip install -e '.[dev]'"
    exit 1
}
if (-not (Test-Path (Join-Path $web 'node_modules'))) {
    Write-Host "Frontend deps missing. Run:  cd apps\web; npm install" -ForegroundColor Red
    exit 1
}

function Test-Port($port) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $c
}

# A listening socket is NOT proof of a working backend. The vision pipeline
# spawns a multiprocessing child that inherits the listening socket, and it can
# outlive its parent — so after a Ctrl+C the port stays held by an orphan that
# answers nothing. A fresh uvicorn then fails to bind and the whole app looks
# like it "won't start". Detect that and clear it rather than reporting "reusing".
function Clear-StalePort($port) {
    if (-not (Test-Port $port)) { return }
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 4 | Out-Null
        return  # a real backend is answering; leave it alone
    } catch { }
    Write-Host "backend  : :$port is held but not answering /healthz - clearing orphans" -ForegroundColor Yellow
    $owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($owner in $owners) {
        $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "           stopping $($proc.ProcessName) (PID $owner)" -ForegroundColor DarkGray
            Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
        }
    }
    # The orphaned multiprocessing child holds an inherited handle and is not
    # always the reported owner — sweep any stray backend python too.
    Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -like '*multiprocessing-fork*' -or
                       ($_.CommandLine -like '*uvicorn*app.main*' -and $_.CommandLine -like "*$port*") } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 15; $i++) {
        if (-not (Test-Port $port)) { break }
        Start-Sleep -Seconds 1
    }
}

Clear-StalePort 8000

# Reuse whatever is already up instead of starting a second copy on a stray port.
if (Test-Port 8000) {
    Write-Host "backend  : already listening on :8000 (reusing)" -ForegroundColor DarkGray
} else {
    Write-Host "backend  : starting on :8000 ..." -ForegroundColor Cyan
    Start-Process -FilePath $py `
        -ArgumentList '-m', 'uvicorn', 'app.main:app', '--reload', '--port', '8000' `
        -WorkingDirectory $backend -WindowStyle Normal
}

if (Test-Port 5173) {
    Write-Host "frontend : already listening on :5173 (reusing)" -ForegroundColor DarkGray
} else {
    Write-Host "frontend : starting on :5173 ..." -ForegroundColor Cyan
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' `
        -WorkingDirectory $web -WindowStyle Normal
}

# The backend is the slow one: it is not reachable at all until the vision model
# is loaded, so poll /healthz rather than the port.
Write-Host ''
Write-Host 'waiting for the backend to finish loading the vision model (~30s cold) ...' -NoNewline
$health = $null
for ($i = 0; $i -lt 90; $i++) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/healthz' -TimeoutSec 3
        break
    } catch {
        Start-Sleep -Seconds 2
        Write-Host '.' -NoNewline
    }
}
Write-Host ''

if ($null -eq $health) {
    Write-Host 'backend did not answer /healthz in 3 minutes.' -ForegroundColor Red
    Write-Host 'Check the backend window for a traceback (a bad SUPABASE_* value in backend\.env is the usual cause).'
    exit 1
}

Write-Host ''
Write-Host ('backend  OK   vision={0}  supabase={1}  roster={2}  embeddings={3}' -f `
        $health.vision_backend, $health.supabase_configured, $health.roster_count, $health.embeddings_count) -ForegroundColor Green

for ($i = 0; $i -lt 60; $i++) {
    if (Test-Port 5173) { break }
    Start-Sleep -Seconds 1
}
if (Test-Port 5173) {
    Write-Host 'frontend OK   http://localhost:5173' -ForegroundColor Green
} else {
    Write-Host 'frontend did not come up on :5173 — check its window.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '  Open  ->  http://localhost:5173' -ForegroundColor Yellow
Write-Host ''
Write-Host '  Use localhost, not the LAN address Vite also prints: browsers only allow' -ForegroundColor DarkGray
Write-Host '  camera access on a secure origin, so /capture cannot start a session over' -ForegroundColor DarkGray
Write-Host '  plain http://192.168.x.x. Phones scanning the QR should use the https tunnel.' -ForegroundColor DarkGray
Write-Host ''
