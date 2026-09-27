# scp-update.ps1 — 只同步「有更新」的檔案：Windows(本機) -> Linux(遠端)
# 直接在下面「設定區」填好路徑，執行即可：
#   .\scp-update.ps1
#
# 需求: Windows 需有 OpenSSH client（ssh / scp）與內建 tar，遠端為 Linux（GNU find / tar）。
#       強烈建議設定 SSH 金鑰（見 README 或 ssh-keygen + ssh-copy-id），之後完全不用輸入密碼；
#       用密碼驗證時，本腳本仍需輸入約 2 次（一次列清單、一次傳輸）。
#
# 注意: 本檔含中文，請以 UTF-8 with BOM 儲存，否則 Windows PowerShell 5.1 會誤判編碼。

# ===== 設定區（改這裡就好）========================
$Source      = "C:\Users\noel\Documents\Line_webhook"          # 本機來源目錄
$Remote      = "root@192.168.0.110"           # 遠端 SSH（user@host 或 ~/.ssh/config 的別名）
$Destination = "/usr/share/nginx/Line_webhook"           # 遠端目的目錄
$Port        = 22                    # SSH port
$Exclude     = @('.env', 'node_modules', 'logs', '*.log', 'settings.json', 'storage.json')   # 排除樣式（glob）
$DryRun      = $false                # $true = 只列出、不複製
# ==================================================

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    Write-Error "來源不存在或不是目錄：$Source"
    exit 1
}
foreach ($cmd in @('ssh', 'scp')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Error "找不到 $cmd，請先安裝 OpenSSH client"
        exit 1
    }
}

function Test-Excluded([string]$rel) {
    foreach ($pat in $Exclude) {
        if ([string]::IsNullOrWhiteSpace($pat)) { continue }
        $p = $pat.Trim()
        if ($rel -like $p -or $rel -like "$p/*") { return $true }
    }
    return $false
}

$srcRoot = (Resolve-Path -LiteralPath $Source).Path.TrimEnd('\', '/')
$dest = $Destination.TrimEnd('/')

Write-Host "來源：$srcRoot"
Write-Host "目的：${Remote}:${dest} (port $Port)"
Write-Host "排除：$($Exclude -join ', ')"
if ($DryRun) { Write-Host "模式：dry-run（只列出，不複製）" }
Write-Host ""

# 1) 取得遠端檔案清單：相對路徑 <TAB> 大小 <TAB> mtime(epoch)
$destEscaped = $dest.Replace("'", "'\''")
$remoteCmd = "find '$destEscaped' -type f -printf '%P\t%s\t%T@\n' 2>/dev/null"
$remoteLines = @()
try { $remoteLines = & ssh -p $Port $Remote $remoteCmd 2>$null } catch { $remoteLines = @() }

$remoteMap = @{}
foreach ($line in $remoteLines) {
    if (-not $line) { continue }
    $parts = $line -split "`t"
    if ($parts.Count -lt 3) { continue }
    $remoteMap[$parts[0]] = @{
        Size  = [long]$parts[1]
        Mtime = [long]([double]$parts[2])
    }
}

# 2) 比對本機檔案：不存在 / 大小不同 / 本機較新 => 需要更新
$updated = New-Object System.Collections.Generic.List[string]
Get-ChildItem -LiteralPath $srcRoot -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($srcRoot.Length).TrimStart('\', '/').Replace('\', '/')
    if (Test-Excluded $rel) { return }
    $lepoch = ([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeSeconds()
    $r = $remoteMap[$rel]
    if (-not $r -or $r.Size -ne $_.Length -or $lepoch -gt $r.Mtime) {
        $updated.Add($rel)
    }
}

# 3) 列出變更
if ($updated.Count -eq 0) {
    Write-Host "沒有需要更新的檔案。"
    exit 0
}

Write-Host "以下 $($updated.Count) 個檔案有更新，將複製到 ${Remote}:${dest} ："
$updated | ForEach-Object { Write-Host "  $_" }
Write-Host ""

if ($DryRun) {
    Write-Host "(dry-run) 未複製任何檔案。"
    exit 0
}

# 4) 確認（預設 Yes）
$ans = Read-Host "確定要複製嗎？[Y/n]"
if ([string]::IsNullOrWhiteSpace($ans)) { $ans = 'Y' }
if ($ans -notmatch '^[Yy]') { Write-Host "已取消。"; exit 0 }

# 5) 複製（把更新檔打包成單一 tar，一次上傳 + 一次解壓）
$tarName = "scpupd_" + [guid]::NewGuid().ToString("N") + ".tar.gz"
$tarFile = Join-Path $env:TEMP $tarName
$listFile = Join-Path $env:TEMP ("scpupd_" + [guid]::NewGuid().ToString("N") + ".txt")
[IO.File]::WriteAllLines($listFile, $updated, (New-Object System.Text.UTF8Encoding($false)))

& tar -C $srcRoot -czf $tarFile -T $listFile
& scp -P $Port -q $tarFile "${Remote}:/tmp/$tarName"
$remoteTar = "/tmp/$tarName"
& ssh -p $Port $Remote "mkdir -p '$destEscaped' && tar -xzf '$remoteTar' -C '$destEscaped' && rm -f '$remoteTar'"

Remove-Item -LiteralPath $tarFile, $listFile -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "完成，共更新 $($updated.Count) 個檔案。"
