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

这台机器上 `github.com:443` 不通（TCP 连不上），但 `github.com:22` 通，所以用 **SSH** 而不是 HTTPS。

- 便携版 git：`D:\DSH\tools\mingit\cmd\git.exe`
- 专用密钥：`D:\DSH\.ssh\id_ed25519_github`（公钥 `id_ed25519_github.pub`）
- 已知主机：`D:\DSH\.ssh\known_hosts`

一次性准备：

1. 把公钥加到 GitHub：Settings → SSH and GPG keys → New SSH key（公钥内容见仓库提交记录 / 运行 `ssh-keygen -y -f D:\DSH\.ssh\id_ed25519_github` 打印）；
2. 在 GitHub 建一个**空**的私有仓库（不要勾 README / .gitignore / license），名字例如 `dsh-local-kb`。

推送：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\push-github.ps1 -Repo 你的用户名/dsh-local-kb
```

脚本会自动设 remote、提交未提交的改动、用 SSH 推 `main`。以后改完代码再跑一次即可（也可以只推不做提交：已经提交过的会直接 push）。