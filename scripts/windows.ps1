param(
    [ValidateSet('install', 'install-worker', 'start', 'stop')]
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
$SetupDirectory = Join-Path $AppDataDirectory 'setup'
$InstallerFile = Join-Path $SetupDirectory 'installer.json'
$SetupPage = Join-Path $SetupDirectory 'status.html'
$LauncherScript = Join-Path $PSScriptRoot 'windows.ps1'

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

function Write-SetupPage([string]$Message, [bool]$Failed = $false, [string]$Destination = '') {
    New-Item -ItemType Directory -Path $SetupDirectory -Force | Out-Null
    $SafeMessage = [System.Net.WebUtility]::HtmlEncode($Message)
    $RefreshTo = if ($Destination) { $Destination } else { ([Uri]$SetupPage).AbsoluteUri }
    $Refresh = if ($Failed) { '' } else { '<meta http-equiv="refresh" content="3;url=' + $RefreshTo + '">' }
    $Logs = [System.Net.WebUtility]::HtmlEncode((Join-Path $AppDataDirectory 'logs\setup-bootstrap.log'))
    $Body = "<!doctype html><html lang='zh-CN'><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>$Refresh<title>知课 · 环境准备</title><style>body{font:16px/1.9 system-ui;background:#f4f7ef;color:#48603d;padding:8vh 24px}main{background:white;padding:32px;border:1px solid #dce6d1;border-radius:14px;max-width:680px;margin:auto}small{color:#8d9d80}</style><main><h1>正在准备你的学习空间</h1><p>$SafeMessage</p><p>安装在后台继续，可以关闭此页面，稍后双击 install.bat 查看进度。</p><small>日志：$Logs</small></main></html>"
    Set-Content -LiteralPath $SetupPage -Value $Body -Encoding UTF8
}

function Get-InstallerProcess {
    if (-not (Test-Path -LiteralPath $InstallerFile)) { return $null }
    try {
        $Record = Get-Content -LiteralPath $InstallerFile -Raw | ConvertFrom-Json
        $Candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($Record.processId)"
        if ($Record.entry -eq $LauncherScript -and $Candidate -and $Candidate.CommandLine -and $Candidate.CommandLine.Contains($LauncherScript) -and $Candidate.CommandLine.Contains('install-worker')) {
            $StartedAt = (Get-Process -Id $Record.processId).StartTime.ToUniversalTime().ToString('o')
            if ($StartedAt -eq $Record.startedAt) { return $Candidate }
        }
    } catch { }
    Remove-Item -LiteralPath $InstallerFile -ErrorAction SilentlyContinue
    return $null
}

function Refresh-ToolPath {
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH', 'User')
}

function Install-RequiredTool([string]$Executable, [string]$PackageId, [string]$Purpose) {
    if (Get-Command $Executable -ErrorAction SilentlyContinue) { return }
    Write-SetupPage "$Purpose。正在通过 Windows Package Manager 安装 $PackageId；系统安装器可能要求授权。"
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw "Missing $Executable and Windows Package Manager. Install $PackageId, then rerun install.bat." }
    & winget.exe install --exact --id $PackageId --source winget --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget installation failed for $PackageId." }
    Refresh-ToolPath
}

function Get-Python {
    $Candidates = @()
    foreach ($Name in @('python.exe', 'python3.exe')) {
        $Command = Get-Command $Name -ErrorAction SilentlyContinue
        if ($Command -and -not $Command.Source.Contains('WindowsApps')) { $Candidates += $Command.Source }
    }
    $ExplicitPython = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
    if (Test-Path -LiteralPath $ExplicitPython) { $Candidates += $ExplicitPython }
    foreach ($Candidate in $Candidates) {
        try {
            $Version = & $Candidate -c 'import sys; print(int(sys.version_info >= (3,11)))' 2>$null
            if ($LASTEXITCODE -eq 0 -and "$Version".Trim() -eq '1') { return $Candidate }
        } catch { }
    }
    return $null
}

function Start-Setup {
    if (Get-InstallerProcess) {
        Start-Process $SetupPage
        Write-Host 'Setup is already running in the background.'
        return
    }
    if (Get-AppProcess) { throw 'The app is running. Finish active course processing and use stop.bat before reinstalling.' }
    New-Item -ItemType Directory -Path (Join-Path $AppDataDirectory 'logs') -Force | Out-Null
    Write-SetupPage '正在启动后台安装。Node.js、Python、FFmpeg 和本地语音模型会按需准备。'
    $PowerShell = (Get-Command powershell.exe).Source
    $Worker = Start-Process -FilePath $PowerShell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $LauncherScript + '"'),'-Action','install-worker') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $AppDataDirectory 'logs\setup-bootstrap.log') -RedirectStandardError (Join-Path $AppDataDirectory 'logs\setup-bootstrap-error.log')
    @{ processId = $Worker.Id; entry = $LauncherScript; startedAt = $Worker.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $InstallerFile
    Start-Process $SetupPage
    Write-Host 'Setup continues in the background. Progress is open in your browser.'
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
    Start-Setup
    exit 0
}

if ($Action -eq 'install-worker') {
    try {
        Write-SetupPage '检查并安装运行工具。模型下载会缓存，失败后重新运行可复用已校验的文件。'
        Install-RequiredTool 'node.exe' 'OpenJS.NodeJS.LTS' '准备 Node.js LTS'
        try { Assert-Toolchain } catch {
            Write-SetupPage '正在更新 Node.js LTS 到应用需要的版本。'
            if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw }
            & winget.exe install --exact --id OpenJS.NodeJS.LTS --source winget --silent --force --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -ne 0) { throw 'Node.js update failed.' }
            Refresh-ToolPath
            Assert-Toolchain
        }
        Install-RequiredTool 'ffmpeg.exe' 'Gyan.FFmpeg' '准备音视频处理工具'
        if (-not (Get-Command ffprobe.exe -ErrorAction SilentlyContinue)) { throw 'ffprobe.exe is missing; repair FFmpeg and rerun install.bat.' }
        $Python = Get-Python
        if (-not $Python) {
            if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw 'Python 3.11+ is required. Install Python 3.12 and rerun install.bat.' }
            Write-SetupPage '正在安装 Python 3.12，用于本地免费语音识别。'
            & winget.exe install --exact --id Python.Python.3.12 --source winget --silent --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -ne 0) { throw 'Python installation failed.' }
            Refresh-ToolPath
            $Python = Get-Python
            if (-not $Python) { throw 'Python was installed but is not available yet. Reopen install.bat.' }
        }
        & $Python (Join-Path $PSScriptRoot 'setup-all.py') --port $AppPort *> (Join-Path $AppDataDirectory 'logs\setup.log')
        if ($LASTEXITCODE -ne 0) { throw 'Local setup did not complete. See data\logs\setup.log and data\setup\status.html.' }
        & $LauncherScript -Action start
        if ($LASTEXITCODE -ne 0) { throw 'The app did not start. See data\logs\server-error.log.' }
        Write-SetupPage '应用与本地语音复核模型已准备好，正在进入学习空间。' $false $AppUrl
    } catch {
        Write-SetupPage ("环境准备未完成：" + $_.Exception.Message) $true
        Write-Error $_
        exit 1
    } finally {
        Remove-Item -LiteralPath $InstallerFile -ErrorAction SilentlyContinue
    }
    exit 0
}

$Installing = Get-InstallerProcess
if ($Installing -and $Installing.ProcessId -ne $PID) { Start-Process $SetupPage; exit 0 }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -or -not (Test-Path (Join-Path $ProjectRoot 'node_modules\tsx')) -or -not (Test-Path (Join-Path $ProjectRoot 'dist\index.html'))) { Start-Setup; exit 0 }
try { Assert-Toolchain } catch { Start-Setup; exit 0 }
$RunningApp = Get-AppProcess
if ($RunningApp) {
    $RunningRecord = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
    $RunningPort = if ($RunningRecord.port) { [int]$RunningRecord.port } else { $AppPort }
    $RunningUrl = "http://127.0.0.1:$RunningPort"
    Write-Host "Application is already running at $RunningUrl"
    Start-Process $RunningUrl
    exit 0
}
if (-not (Test-Path (Join-Path $SetupDirectory 'readiness.json'))) { Start-Setup; exit 0 }
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
