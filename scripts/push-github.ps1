<#
.SYNOPSIS
  把本地仓库推送到 GitHub（走 SSH，因为本机到 github.com:443 不通、22 通）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\push-github.ps1 -Repo your-name/dsh-local-kb
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$Message = '',
  [string]$KeyPath = 'D:\DSH\.ssh\id_ed25519_github',
  [string]$KnownHosts = 'D:\DSH\.ssh\known_hosts',
  [string]$Remote = 'origin'
)

$ErrorActionPreference = 'Stop'
$git = 'D:\DSH\tools\mingit\cmd\git.exe'
if (-not (Test-Path $git)) { $git = (Get-Command git -ErrorAction Stop).Source }

if ($Repo -notmatch '^[\w.-]+/[\w.-]+$') {
  # 也接受完整 URL
  if ($Repo -match 'github\.com[:/](?<o>[\w.-]+)/(?<r>[\w.-]+?)(\.git)?$') { $Repo = "$($Matches.o)/$($Matches.r)" }
  else { throw "仓库参数应形如 your-name/dsh-local-kb，收到：$Repo" }
}
$url = "git@github.com:$Repo.git"

$sshCommand = "`"$env:WINDIR\System32\OpenSSH\ssh.exe`" -i `"$KeyPath`" -o UserKnownHostsFile=`"$KnownHosts`" -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  $existing = & $git remote 2>$null
  if ($existing -contains $Remote) { & $git remote set-url $Remote $url } else { & $git remote add $Remote $url }

  & $git add -A
  $dirty = (& $git status --porcelain) -join ''
  if ($dirty) {
    if (-not $Message) { $Message = "备份 $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
    & $git -c core.quotepath=false commit -q -m $Message
  } else { "没有新的改动，只推送已有提交。" }

  $env:GIT_SSH_COMMAND = $sshCommand
  & $git push -u $Remote main
  if ($LASTEXITCODE -ne 0) { throw "git push 失败（exit $LASTEXITCODE）。先确认公钥已加到 GitHub：Settings → SSH and GPG keys。" }
  "已推送：$url"
} finally {
  Push-Location
}
