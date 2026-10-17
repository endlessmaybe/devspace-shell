[CmdletBinding()]
param([ValidateSet('Enable', 'Disable', 'Status')][string]$Mode = 'Status', [Parameter(Mandatory=$true)][string]$NodePath, [string]$DataDir = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$appDirectory = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $DataDir) { $DataDir = $env:DEVSPACE_SHELL_DATA }
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'DevSpaceShell\data' }
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$configFile = Join-Path $DataDir 'config.json'
if (-not (Test-Path -LiteralPath $configFile)) { throw '请先运行安装器生成本机配置。' }
$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.installationId -notmatch '^[a-f0-9]{32}$') { throw '安装标识无效。' }
$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory "DevSpaceShell-$($config.installationId).lnk"
$runtimeDirectory = Join-Path $appDirectory '.runtime'
$vbsPath = Join-Path $runtimeDirectory "autostart-$($config.installationId).vbs"
$wscriptPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shell = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $shortcutPath) {
    $existing = $shell.CreateShortcut($shortcutPath)
    if ($existing.TargetPath -ne $wscriptPath -or $existing.Arguments -ne ('"' + $vbsPath + '"')) { throw '同名启动项不属于这个安装，未修改。' }
}
if ($Mode -eq 'Status') { Write-Output (@{ enabled = (Test-Path -LiteralPath $shortcutPath) } | ConvertTo-Json -Compress); exit 0 }
if ($Mode -eq 'Disable') {
    if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
    if (Test-Path -LiteralPath $vbsPath) { Remove-Item -LiteralPath $vbsPath -Force }
    Write-Host '本安装的登录自启动已关闭。'; exit 0
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node 路径不存在。' }
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$managePath = Join-Path $PSScriptRoot 'manage.mjs'
function Vbs-Quote([string]$Value) { return '"' + $Value.Replace('"', '""') + '"' }
$command = '"' + $NodePath + '" "' + $managePath + '" start'
$vbs = 'Set shell = CreateObject("WScript.Shell")' + "`r`n" +
    'shell.Environment("PROCESS")("DEVSPACE_SHELL_DATA") = ' + (Vbs-Quote $DataDir) + "`r`n" +
    'shell.Run ' + (Vbs-Quote $command) + ', 0, False' + "`r`n"
[System.IO.File]::WriteAllText($vbsPath, $vbs, [System.Text.Encoding]::Unicode)
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $wscriptPath
$shortcut.Arguments = '"' + $vbsPath + '"'
$shortcut.WorkingDirectory = $appDirectory
$shortcut.WindowStyle = 7
$shortcut.Description = 'DevSpace Shell - this installation only'
$shortcut.Save()
Write-Host '已开启当前用户登录自启动，无需管理员权限。'
