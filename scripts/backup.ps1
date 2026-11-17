<#
.SYNOPSIS
  把「本地知识库」插件的源码、profile 配置（可选索引）打成一个带时间戳的 zip，便于上传到云端或拷走。

.DESCRIPTION
  默认只备份「丢了自己重写很麻烦」的东西：
    - 插件源码（lib/、client.js、test/、docs/、locale/、package.json、cordis.patch.yml、README.md、icon.svg）
    - profile 里的 cordis.patch.yml（知识库的 root、embedding/rerank/ocr 配置，密钥不在里面，只在凭据库）
  默认不备份：
    - tools/mupdf.zip（94MB，可重新下载）、tools/mutool.exe（46MB，可重新下载或 -IncludeMutool 带上）
    - 索引（-IncludeIndex 才带，约 86MB；丢了可以重建，重建要调 embedding 接口、花时间）
    - ocr 缓存（可重建，且经常变化）

.EXAMPLE
  # 只备份源码与配置
  pwsh -File scripts\backup.ps1

.EXAMPLE
  # 连索引一起备份到 D:\DSH\backup
  pwsh -File scripts\backup.ps1 -IncludeIndex

.EXAMPLE
  # 指定输出目录（例如某个网盘同步目录），并把 mutool.exe 一起带上
  pwsh -File scripts\backup.ps1 -Dest 'D:\OneDrive\backup' -IncludeMutool
#>
[CmdletBinding()]
param(
  [string]$Dest = '',
  [switch]$IncludeIndex,
  [switch]$IncludeMutool,
  [switch]$IncludeToolsArchive,
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$IndexRoot = '',
  [string]$IndexDir = ''
)

$ErrorActionPreference = 'Stop'

$pkg = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
if (-not $Dest) { $Dest = Join-Path $pkg '..\backup' }
$Dest = [System.IO.Path]::GetFullPath($Dest)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$name = "local-kb-$stamp"
$stage = Join-Path $Dest ".stage-$stamp"
$zip = Join-Path $Dest "$name.zip"

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

function Copy-Tree([string]$from, [string]$to, [string[]]$skipNames = @()) {
  if (-not (Test-Path $from)) { return }
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  foreach ($item in Get-ChildItem -LiteralPath $from -Force) {
    if ($skipNames -contains $item.Name) { continue }
    $target = Join-Path $to $item.Name
    if ($item.PSIsContainer) {
      Copy-Tree $item.FullName $target $skipNames
    } else {
      Copy-Item -LiteralPath $item.FullName -Destination $target -Force
    }
  }
}

# 1. 插件源码
$code = Join-Path $stage 'local-kb'
New-Item -ItemType Directory -Force -Path $code | Out-Null
foreach ($file in 'package.json', 'client.js', 'cordis.patch.yml', 'README.md', 'icon.svg') {
  $path = Join-Path $pkg $file
  if (Test-Path $path) { Copy-Item -LiteralPath $path -Destination (Join-Path $code $file) -Force }
}
foreach ($dir in 'lib', 'test', 'docs', 'locale', 'scripts') {
  Copy-Tree (Join-Path $pkg $dir) (Join-Path $code $dir) @('.ocr-work')
}

# 2. tools（默认只带 mutool.exe，可按需带原始压缩包）
$toolsOut = Join-Path $code 'tools'
$mutool = Join-Path $pkg 'tools\mutool.exe'
$archive = Join-Path $pkg 'tools\mupdf.zip'
if ($IncludeMutool -and (Test-Path $mutool)) {
  New-Item -ItemType Directory -Force -Path $toolsOut | Out-Null
  Copy-Item -LiteralPath $mutool -Destination (Join-Path $toolsOut 'mutool.exe') -Force
}
if ($IncludeToolsArchive -and (Test-Path $archive)) {
  New-Item -ItemType Directory -Force -Path $toolsOut | Out-Null
  Copy-Item -LiteralPath $archive -Destination (Join-Path $toolsOut 'mupdf.zip') -Force
}

# 3. profile 配置（不含密钥）
$profileCopy = Join-Path $stage 'profile'
New-Item -ItemType Directory -Force -Path $profileCopy | Out-Null
$profileYml = Join-Path $ProfileDir 'cordis.patch.yml'
if (Test-Path $profileYml) {
  Copy-Item -LiteralPath $profileYml -Destination (Join-Path $profileCopy 'cordis.patch.yml') -Force
}

# 4. 索引（可选）
if ($IncludeIndex) {
  $source = $IndexDir
  if (-not $source) {
    if ($IndexRoot) { $source = Join-Path $IndexRoot '.dsh-kb' }
    elseif (Test-Path $profileYml) {
      $line = Get-Content -LiteralPath $profileYml -Encoding UTF8 | Where-Object { $_ -match '^\s+root:\s*(.+)$' } | Select-Object -First 1
      if ($line -and $line -match '^\s+root:\s*(.+)$') { $source = Join-Path ($Matches[1].Trim().Trim("'").Trim('"')) '.dsh-kb' }
    }
  }
  if ($source -and (Test-Path $source)) {
    $indexOut = Join-Path $stage 'index'
    New-Item -ItemType Directory -Force -Path $indexOut | Out-Null
    foreach ($file in 'index.json', 'vectors.bin') {
      $path = Join-Path $source $file
      if (Test-Path $path) { Copy-Item -LiteralPath $path -Destination (Join-Path $indexOut $file) -Force }
    }
    $ocrDir = Join-Path $source 'ocr'
    if (Test-Path $ocrDir) { Copy-Tree $ocrDir (Join-Path $indexOut 'ocr') }
    "index source: $source"
  } else {
    Write-Warning "没找到索引目录（$source），跳过索引备份。"
  }
}

# 5. 清单
$manifest = @(
  "local-kb backup",
  "created : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')",
  "package : $pkg",
  "profile : $ProfileDir",
  "index   : $(if ($IncludeIndex) { 'included' } else { 'excluded' })",
  "mutool  : $(if ($IncludeMutool) { 'included' } else { 'excluded（可用 -IncludeMutool 带上）' })",
  "",
  "恢复方法：",
  "  1) 把 local-kb/ 解到任意目录，profile/cordis.patch.yml 覆盖回 $ProfileDir\cordis.patch.yml",
  "  2) 在 profile 里启用插件（界面「插件」页勾选「本地知识库」即可重载）",
  "  3) 密钥不在备份里：在设置页重新填 embedding / 重排 / OCR 的 API Key（会写进 DSH 凭据库）",
  "  4) 如果没带索引（index/），进去点一次「重建索引」；带上索引的话，index/ 里的 index.json、vectors.bin 放回 <root>\.dsh-kb\ 即可"
) -join [Environment]::NewLine
[System.IO.File]::WriteAllText((Join-Path $stage 'MANIFEST.txt'), $manifest, (New-Object System.Text.UTF8Encoding($false)))

# 6. 打包
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -Recurse -Force $stage

$size = (Get-Item -LiteralPath $zip).Length
$entries = ([System.IO.Compression.ZipFile]::OpenRead($zip)).Entries.Count
"created: $zip"
"size   : {0:N1} MB, {1} entries" -f ($size / 1MB), $entries
