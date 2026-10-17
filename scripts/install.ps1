[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'status', 'uninstall')][string]$Action = 'start',
    [string]$NodePath = '',
    [string]$DataDir = '',
    [switch]$NoOpen,
    [switch]$NoAutoStart,
    [switch]$DownloadRuntime,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$appDirectory = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$runtimeDirectory = Join-Path $appDirectory '.runtime'
$nodeVersion = '24.22.0'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
$checksums = @{
    x64 = 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3'
    arm64 = '3a5c209a5bc59e65b3bc0fa13ed5e166a26bd3d55332847f498b76b037408d61'
}
function Test-Node([string]$Candidate) {
    if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { return $false }
    try {
        $text = & $Candidate --version 2>$null
        if ($LASTEXITCODE -ne 0 -or $text -notmatch '^v(\d+)\.') { return $false }
        return ([int]$Matches[1] -ge 24 -and [int]$Matches[1] -lt 27)
    } catch { return $false }
}
if ($DataDir) { $env:DEVSPACE_SHELL_DATA = [System.IO.Path]::GetFullPath($DataDir) }
$bundledNode = Join-Path $runtimeDirectory 'node\node.exe'
if ($NodePath -and -not (Test-Node $NodePath)) { throw '指定的 Node 不可用，需要 Node 24–26。' }
if (-not $DownloadRuntime -and -not $NodePath -and (Test-Node $bundledNode)) { $NodePath = $bundledNode }
if (-not $DownloadRuntime -and -not $NodePath) {
    $candidate = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate -and (Test-Node $candidate.Source)) { $NodePath = $candidate.Source }
}
if (-not $NodePath -or $DownloadRuntime) {
    if ($Action -ne 'start') { throw '未找到本安装使用的 Node。请先运行一键安装。' }
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    $archiveName = "node-v$nodeVersion-win-$arch.zip"
    $archivePath = Join-Path $runtimeDirectory $archiveName
    if (-not (Test-Path -LiteralPath $archivePath)) {
        Write-Host "正在下载官方 Node.js $nodeVersion（无需管理员权限）……"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$nodeVersion/$archiveName" -OutFile $archivePath
    }
    $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $checksums[$arch]) { throw 'Node 下载校验失败，已停止，未执行下载内容。删除 .runtime 内对应 ZIP 后重试。' }
    $extractDirectory = Join-Path $runtimeDirectory "verified-$nodeVersion-$arch"
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDirectory -Force
    $packageDirectory = Join-Path $extractDirectory "node-v$nodeVersion-win-$arch"
    if (-not (Test-Node (Join-Path $packageDirectory 'node.exe'))) { throw '官方运行时无法启动。' }
    New-Item -ItemType Directory -Path (Join-Path $runtimeDirectory 'node') -Force | Out-Null
    Get-ChildItem -LiteralPath $packageDirectory -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $runtimeDirectory 'node') -Recurse -Force }
    $NodePath = $bundledNode
}
if ($ValidateOnly) { Write-Host "运行时校验成功：$NodePath"; exit 0 }
$manageScript = Join-Path $PSScriptRoot 'manage.mjs'
if ($Action -eq 'uninstall') {
    & $NodePath $manageScript stop
    if ($LASTEXITCODE -ne 0) { throw '停止失败，未继续卸载。' }
    & (Join-Path $PSScriptRoot 'autostart.ps1') -Mode Disable -NodePath $NodePath
    Write-Host '已停止并移除本安装的登录自启动。源码、运行时和个人任务数据已保留；不再需要时可自行删除项目文件夹。'
    exit 0
}
$arguments = @($manageScript, $Action)
if ($Action -eq 'start' -and -not $NoOpen) { $arguments += '--open' }
& $NodePath @arguments
if ($LASTEXITCODE -ne 0) { throw '启动器执行失败，请查看上面的提示。' }
if ($Action -eq 'start' -and -not $NoAutoStart) {
    & (Join-Path $PSScriptRoot 'autostart.ps1') -Mode Enable -NodePath $NodePath
}
if ($Action -eq 'start') { Write-Host 'DevSpace Shell 已就绪。浏览器中的中文向导会带你设置自己的项目和插件。' }
