<#
.SYNOPSIS
  把本地仓库推送到 GitHub（走 SSH：本机 github.com:443 不通，22 通）。

.DESCRIPTION
  依赖 %USERPROFILE%\.ssh\config 里 github.com 这一段（IdentityFile 指向 id_ed25519_github）：
    Host github.com
      HostName github.com
      User git
      IdentityFile ~/.ssh/id_ed25519_github
      IdentitiesOnly yes
      StrictHostKeyChecking accept-new
      BatchMode yes
  并在本次进程里设 GIT_SSH 指向 Windows 自带 ssh.exe——不要用 GIT_SSH_COMMAND 带参数：
  Git for Windows 会绕 msys 的 sh 去解析参数，在本机沙箱里会报 “couldn't create signal pipe”。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\push-github.ps1 -Repo cairobin1102/dsh-local-kb

.EXAMPLE
  # 只推送、不自动提交
  powershell -ExecutionPolicy Bypass -File scripts\push-github.ps1 -Repo cairobin1102/dsh-local-kb -NoCommit
#>
[CmdletBinding()]
param(
  [string]$Repo = 'cairobin1102/dsh-local-kb',
  [string]$Message = '',
  [switch]$NoCommit,
  [string]$Remote = 'origin'
)

$ErrorActionPreference = 'Stop'

$git = 'D:\DSH\tools\mingit\cmd\git.exe'
if (-not (Test-Path $git)) { $git = (Get-Command git -ErrorAction Stop).Source }

$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path $ssh)) { throw "没找到 Windows 自带的 ssh.exe：$ssh" }

$sshConfig = Join-Path $env:USERPROFILE '.ssh\config'
if (-not (Test-Path $sshConfig)) {
  throw "缺少 SSH 配置：$sshConfig。先按 docs/BACKUP.md 的「推到 GitHub」一节把密钥与 config 放好。"
}

if ($Repo -notmatch '^[\w.-]+/[\w.-]+$') {
  if ($Repo -match 'github\.com[:/](?<o>[\w.-]+)/(?<r>[\w.-]+?)(\.git)?$') { $Repo = "$($Matches.o)/$($Matches.r)" }
  else { throw "仓库参数应形如 owner/name，收到：$Repo" }
}

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  $existing = & $git remote 2>$null
  $url = "git@github.com:$Repo.git"
  if ($existing -contains $Remote) { & $git remote set-url $Remote $url } else { & $git remote add $Remote $url }

  if (-not $NoCommit) {
    & $git add -A
    if ((& $git status --porcelain)) {
      if (-not $Message) { $Message = "备份 $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
      & $git -c core.quotepath=false commit -q -m $Message
      "已提交：$Message"
    } else {
      "没有新的改动。"
    }
  }

  # 关键：GIT_SSH 只给路径，不给参数（带参数会走 msys sh，本机沙箱下起不来）
  $env:GIT_SSH = $ssh
  $env:GIT_SSH_VARIANT = 'ssh'
  Remove-Item Env:\GIT_SSH_COMMAND -ErrorAction SilentlyContinue

  & $git push -u $Remote main
  if ($LASTEXITCODE -ne 0) { throw "git push 失败（exit $LASTEXITCODE），先确认公钥已加到 GitHub。" }
  "已推送：https://github.com/$Repo"
} finally {
  Pop-Location
}