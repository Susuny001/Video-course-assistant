param(
    [ValidateSet('install', 'start', 'stop')]
    [string]$Action = 'start'
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$AppDataDirectory = Join-Path $ProjectRoot 'data'
$PidFile = Join-Path $AppDataDirectory 'launcher.json'
$ServerEntry = Join-Path $ProjectRoot 'server\index.ts'
$AppPort = if ($env:PORT) { [int]$env:PORT } else { 3001 }
$AppUrl = "http://127.0.0.1:$AppPort"

function Get-AppProcess {
    if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
    $Record = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
    if ($Record.entry -ne $ServerEntry) { throw 'PID record belongs to another checkout; refusing to stop it.' }
    $Candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($Record.processId)"
    if ($Candidate -and $Candidate.Name -eq 'node.exe' -and $Candidate.CommandLine -and $Candidate.CommandLine.Contains($ServerEntry)) {
        $StartedAt = (Get-Process -Id $Record.processId).StartTime.ToUniversalTime().ToString('o')
        if ($StartedAt -eq $Record.startedAt) { return $Candidate }
    }
    Remove-Item -LiteralPath $PidFile
    return $null
}

function Assert-Toolchain {
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        throw 'Node.js 22+ is required. Run install.bat, or install Node.js LTS from nodejs.org.'
    }
    $NodeVersion = (& node.exe --version).TrimStart('v').Split('.')
    $NodeMajor = [int]$NodeVersion[0]
    $NodeMinor = [int]$NodeVersion[1]
    if ($NodeMajor -lt 22 -or ($NodeMajor -eq 22 -and $NodeMinor -lt 12)) { throw 'Node.js 22.12+ is required. Upgrade Node.js LTS, then reopen this window.' }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd is missing from PATH.' }
}

function Install-OptionalTool([string]$Executable, [string]$PackageId, [string]$Purpose) {
    if (Get-Command $Executable -ErrorAction SilentlyContinue) { return }
    Write-Host "$Executable is missing: $Purpose"
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        Write-Host "Install $PackageId manually, then reopen your terminal. No system changes were made."
        return
    }
    $Answer = Read-Host "Install $PackageId using Windows Package Manager? [y/N]"
    if ($Answer -notmatch '^[yY]$') { return }
    & winget.exe install --exact --id $PackageId --source winget
    if ($LASTEXITCODE -ne 0) { throw "winget installation failed for $PackageId." }
    # Refresh PATH after an approved installation; keep all existing entries.
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH', 'User')
}

if ($Action -eq 'stop') {
    $RunningApp = Get-AppProcess
    if ($RunningApp) {
        Stop-Process -Id $RunningApp.ProcessId
        Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
        Write-Host 'Course assistant stopped.'
    } else {
        Write-Host 'No server started by this launcher is running.'
    }
    exit 0
}

if ($Action -eq 'install') {
    if (Get-AppProcess) { throw 'Stop the running app with stop.bat before reinstalling dependencies.' }
    Install-OptionalTool 'node.exe' 'OpenJS.NodeJS.LTS' 'Required to run the application.'
    Assert-Toolchain
    Install-OptionalTool 'ffmpeg.exe' 'Gyan.FFmpeg' 'Needed for audio chunking and video frames; text import works without it.'
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Check network access and the lockfile.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
    Write-Host 'Dependencies installed and application built.'
    exit 0
}

Assert-Toolchain
$RunningApp = Get-AppProcess
if ($RunningApp) {
    $RunningRecord = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
    $RunningPort = if ($RunningRecord.port) { [int]$RunningRecord.port } else { $AppPort }
    $RunningUrl = "http://127.0.0.1:$RunningPort"
    Write-Host "Application is already running at $RunningUrl"
    Start-Process $RunningUrl
    exit 0
}
if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules\tsx'))) { throw 'Dependencies are missing. Run install.bat first.' }
if (-not (Test-Path (Join-Path $ProjectRoot 'dist\index.html'))) { throw 'The web build is missing. Run install.bat first.' }
try {
    $Probe = New-Object Net.Sockets.TcpClient
    $Probe.Connect('127.0.0.1', $AppPort)
    $Probe.Dispose()
    throw "Port $AppPort is already in use. Set PORT to a free port or stop the other service."
} catch [System.Net.Sockets.SocketException] {
    # Connection refused means the desired local port is available.
}
New-Item -ItemType Directory -Path (Join-Path $AppDataDirectory 'logs') -Force | Out-Null
$env:HOST = '127.0.0.1'
$env:DATA_DIR = $AppDataDirectory
$env:PORT = "$AppPort"
$ServerProcess = Start-Process -FilePath (Get-Command node.exe).Source `
    -ArgumentList @('--import', 'tsx', ('"' + $ServerEntry + '"')) `
    -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $AppDataDirectory 'logs\server.log') `
    -RedirectStandardError (Join-Path $AppDataDirectory 'logs\server-error.log')
$StartedAt = $ServerProcess.StartTime.ToUniversalTime().ToString('o')
@{ processId = $ServerProcess.Id; entry = $ServerEntry; startedAt = $StartedAt; port = $AppPort } | ConvertTo-Json | Set-Content -LiteralPath $PidFile
$Ready = $false
for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
    $ServerProcess.Refresh()
    if ($ServerProcess.HasExited) { break }
    try {
        $Response = Invoke-WebRequest "$AppUrl/api/health" -UseBasicParsing -TimeoutSec 1
        if ($Response.StatusCode -eq 200) { $Ready = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
}
if (-not $Ready) {
    $OwnedProcess = Get-AppProcess
    if ($OwnedProcess) { Stop-Process -Id $OwnedProcess.ProcessId }
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
    throw 'The server did not become ready. See data\logs\server-error.log.'
}
Write-Host "Course assistant is running in the background at $AppUrl. Use stop.bat to stop it."
Start-Process $AppUrl
