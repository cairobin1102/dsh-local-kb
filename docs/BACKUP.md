# 备份与恢复

这套东西分三块，价值与体积差很多，备份方式也不同：

| 内容 | 位置 | 体积 | 丢了会怎样 | 怎么备 |
| --- | --- | --- | --- | --- |
| 插件源码 | `D:\DSH\local-kb`（不含 `tools/`） | 约 250 KB | 要重写 | **本 Git 仓库** |
| 配置 | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里 `local-kb` 那段 | 3 KB | 重填一遍 | 仓库里的 `cordis.patch.yml` 是默认模板；实际值见备份 zip 的 `profile/` |
| 密钥 | DSH 凭据库（`local-kb/embedding`、`local-kb/rerank`、`local-kb/ocr`） | 极小 | 重新填 API Key | **故意不备份**，恢复后重新填 |
| 索引 | `<root>\.dsh-kb`（`index.json` + `vectors.bin`） | 约 86 MB | 重新 `rebuild`（约 7 分钟、要花 embedding 额度） | `scripts/backup.ps1 -IncludeIndex` |
| OCR 引擎 | `tools/mutool.exe` | 46 MB | 重新下载 | 见 `tools/README.md` |

## 一键打包（含配置，可选索引）

```powershell
# 只备源码与配置（约 100 KB）
powershell -ExecutionPolicy Bypass -File scripts\backup.ps1

# 连索引一起备（约 45 MB，压缩后）
powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 -IncludeIndex

# 输出到指定目录（例如网盘同步目录）
powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 -IncludeIndex -Dest 'D:\OneDrive\backup'
```

产物：`<Dest>\local-kb-<时间戳>.zip`，里面有 `local-kb/`（源码）、`profile/cordis.patch.yml`、`MANIFEST.txt`，带 `-IncludeIndex` 时多一个 `index/`。

## 推送代码到 Git 仓库

```powershell
$git = 'D:\DSH\tools\mingit\cmd\git.exe'   # 便携版 git；装了 Git for Windows 就直接用 git
& $git add -A
& $git commit -m "更新：扫描件 OCR / PDF 解析 / 侧边栏面板"
& $git push
```

## 从备份恢复

1. 源码：`git clone <仓库地址>` 到任意目录（或解压 zip 里的 `local-kb/`）；
2. 补 `tools/mutool.exe`（见 `tools/README.md`）；
3. 配置：把备份里的 `profile/cordis.patch.yml` 覆盖回 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，或在界面里重填；
4. 密钥：设置页重填 embedding / 重排 / OCR 的 API Key（会写回凭据库）；
5. 索引：有 `index/` 就把它里面的 `index.json`、`vectors.bin` 放回 `<root>\.dsh-kb\`；没有就点一次「重建索引」。

## 推到 GitHub（本机只能走 SSH）

- 仓库：`https://github.com/cairobin1102/dsh-local-kb`（私有）
- 本机 `github.com:443` 不通、`22` 通 → 一律走 SSH，不要用 HTTPS 远端。
- 便携版 git：`D:\DSH\tools\mingit\cmd\git.exe`（没有系统 git 时用它）
- 密钥与配置（已装好）：
  - 私钥 `%USERPROFILE%\.ssh\id_ed25519_github`（无口令，公钥已加到 GitHub）
  - 配置 `%USERPROFILE%\.ssh\config`，`Host github.com` 段落指定 `IdentityFile` / `IdentitiesOnly` / `StrictHostKeyChecking accept-new` / `BatchMode yes`
- **不要用 `GIT_SSH_COMMAND` 带参数**：Git for Windows 会绕 msys 的 `sh` 解析它，本机沙箱下报 `couldn't create signal pipe, Win32 error 5`。用 `GIT_SSH` 只给 `ssh.exe` 路径（脚本里已经这么设了）。

日常推送：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\push-github.ps1
# 指定别的仓库 / 只推不提交：
#   -Repo owner/name   -NoCommit
```

脚本做的事：设 remote → `git add -A` + 提交（有改动时）→ `GIT_SSH=ssh.exe` → `git push -u origin main`。

换机器恢复时，先按上面重建 `%USERPROFILE%\.ssh\config` 与私钥，再 `git clone git@github.com:cairobin1102/dsh-local-kb.git`。