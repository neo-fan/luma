# Luma dev 进程的唯一启停入口（start / stop / restart / status）。
#
# 口径：
#   - dev 产物名是 Luma_dev.exe（Cargo [[bin]] + tauri.dev.conf.json mainBinaryName），
#     安装版是 Luma.exe / "Luma Beta.exe"；两者不再同名，按名停进程不会误杀正式版。
#   - 状态查询用 2s 超时的 CDP 直连 9222，不等待编译、不读编译输出推断。
#   - 长驻进程后台启动：-WindowStyle Hidden 独立进程，绝不用 -NoNewWindow
#     （它复用当前控制台句柄，会把调用方挂住）。
#
# 用法：
#   pwsh -NoProfile -File tools/devctl.ps1 status
#   pwsh -NoProfile -File tools/devctl.ps1 start|stop|restart

param(
    [ValidateSet('status', 'start', 'stop', 'restart')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'Continue'

$Root = Split-Path -Parent $PSScriptRoot
$OutDir = Join-Path $Root 'tools\.out'
$LogPath = Join-Path $OutDir 'dev.log'
$ErrPath = Join-Path $OutDir 'dev.err.log'
$PidPath = Join-Path $OutDir 'dev.pid'
$ExeName = 'Luma_dev'
$Port = 1420
$CdpPort = 9222

function Get-DevPathPattern {
    Join-Path $Root 'src-tauri\target\debug\'
}

function Get-DevProcesses {
    $prefix = Get-DevPathPattern
    $found = @()
    foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
        if ($p.ProcessName -notin @('Luma_dev', 'luma')) { continue }
        # 非本进程所有者的 Path 读取会抛 Access denied，跳过即可
        $path = $null
        try { $path = $p.Path } catch { continue }
        if ($path -and $path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            $found += $p
        }
    }
    return $found
}

function Get-CdpState {
    try {
        $resp = Invoke-WebRequest "http://127.0.0.1:$CdpPort/json/version" -TimeoutSec 2 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { return 'ok' }
        return "http-$($resp.StatusCode)"
    } catch {
        return 'no'
    }
}

function Get-LauncherPid {
    if (-not (Test-Path -LiteralPath $PidPath)) { return $null }
    $raw = (Get-Content -LiteralPath $PidPath -Raw -ErrorAction SilentlyContinue).Trim()
    if (-not $raw) { return $null }
    $procId = 0
    if ([int]::TryParse($raw, [ref]$procId) -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
        return $procId
    }
    return $null
}

function Get-BuildingMarker {
    # 编译中：日志 60s 内仍在增长，且还没有 READY 的窗口
    if (-not (Test-Path -LiteralPath $ErrPath)) { return $false }
    $item = Get-Item -LiteralPath $ErrPath -ErrorAction SilentlyContinue
    if (-not $item) { return $false }
    return ((Get-Date) - $item.LastWriteTime).TotalSeconds -lt 60
}

function Show-Status {
    $devProcs = @(Get-DevProcesses)
    $cdp = Get-CdpState
    $launcher = Get-LauncherPid
    $building = Get-BuildingMarker

    $state = 'DOWN'
    if ($devProcs.Count -gt 0 -and $cdp -eq 'ok') {
        $state = 'READY'
    } elseif ($devProcs.Count -gt 0) {
        $state = 'BOOTING'
    } elseif ($launcher -and $building) {
        $state = 'BUILDING'
    } elseif ((Test-Path -LiteralPath $PidPath) -and
        ((Get-Content -LiteralPath $PidPath -Raw -ErrorAction SilentlyContinue).Trim() -ne '')) {
        $state = 'STALE'
    }

    $pidText = if ($devProcs.Count -gt 0) { ($devProcs | ForEach-Object { "$($_.ProcessName):$($_.Id)" }) -join ',' } else { 'none' }
    Write-Output "STATE $state"
    Write-Output "PROCESS $pidText"
    Write-Output "CDP $cdp"
    Write-Output "LAUNCHER $(if ($launcher) { $launcher } else { 'none' })"
    Write-Output "PORT $Port"

    # 残留判定：正式版进程永远不碰，只报告
    $others = @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -in @('Luma', 'Luma Beta') })
    if ($others.Count -gt 0) {
        Write-Output ("NOTE installed-build-running " + (($others | ForEach-Object { "$($_.ProcessName):$($_.Id)" }) -join ','))
    }
}

function Stop-Dev {
    $stopped = @()

    $launcher = Get-LauncherPid
    if ($launcher) {
        taskkill /T /F /PID $launcher 2>&1 | Out-Null
        $stopped += "launcher:$launcher"
    }

    foreach ($p in Get-DevProcesses) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        $stopped += "$($p.ProcessName):$($p.Id)"
    }

    foreach ($conn in Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        $owner = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($owner) {
            Stop-Process -Id $owner.Id -Force -ErrorAction SilentlyContinue
            $stopped += "port$($Port):$($owner.Id)"
        }
    }

    # pid 文件只清内容，不删文件（避免任何删除语义）
    if (Test-Path -LiteralPath $PidPath) { Set-Content -LiteralPath $PidPath -Value '' -NoNewline }

    Write-Output ("STOPPED " + $(if ($stopped.Count) { $stopped -join ',' } else { 'none' }))

    # 残留复查：最多 10s
    for ($i = 0; $i -lt 10; $i++) {
        if (-not (Get-DevProcesses) -and $null -eq (Get-LauncherPid)) { break }
        Start-Sleep -Seconds 1
    }
    $left = @(Get-DevProcesses)
    Write-Output ("RESIDUE " + $(if ($left.Count) { ($left | ForEach-Object { "$($_.ProcessName):$($_.Id)" }) -join ',' } else { 'none' }))
}

function Start-Dev {
    $devProcs = @(Get-DevProcesses)
    if ($devProcs.Count -gt 0 -and (Get-CdpState) -eq 'ok') {
        Write-Output 'ALREADY_READY'
        return
    }

    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    Set-Content -LiteralPath $LogPath -Value '' -NoNewline
    Set-Content -LiteralPath $ErrPath -Value '' -NoNewline

    $launcher = Start-Process -FilePath 'pwsh' `
        -ArgumentList '-NoProfile', '-Command', "Set-Location '$Root'; corepack pnpm dev:app" `
        -WindowStyle Hidden `
        -RedirectStandardOutput $LogPath `
        -RedirectStandardError $ErrPath `
        -PassThru
    Set-Content -LiteralPath $PidPath -Value $launcher.Id -NoNewline
    Write-Output "STARTED launcher=$($launcher.Id)"
    Write-Output 'STATE BUILDING|BOOTING（用 status 查询，不要等待编译）'
}

switch ($Action) {
    'status' { Show-Status | Out-Host }
    'start' { Start-Dev }
    'stop' { Stop-Dev }
    'restart' { Stop-Dev; Start-Dev }
}
