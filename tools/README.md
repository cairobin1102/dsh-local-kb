# tools/

这个目录**不进 Git**（见仓库根目录 `.gitignore`），因为放的是两个大二进制：

| 文件 | 大小 | 用途 | 获取方式 |
| --- | --- | --- | --- |
| `mutool.exe` | 46 MB | 扫描件 PDF 渲染（OCR 用） | 解压 [mupdf-1.28.5-windows.zip](https://mupdf.com/releases) 里的 `mutool.exe` |
| `mupdf.zip` | 94 MB | 上面那个的原始压缩包 | 同上 |

## 为什么不在仓库里

- 46 MB 的 `mutool.exe` 会让每次 clone 都下载一遍，且它对代码没有版本意义；
- GitHub 单文件上限 100 MB，`mupdf.zip` 已接近上限。

## 恢复后怎么补

1. 下载 [MuPDF](https://mupdf.com/releases) 的 Windows 包（本项目实测 `mupdf-1.28.5-windows.zip`）；
2. 把里面的 `mutool.exe` 放到本目录；
3. 插件设置页的「mutool 路径」留空即可（默认用 `tools/mutool.exe` 或 PATH 里的 `mutool`）。

不需要 OCR 的话，这两个文件都不装也不影响文本层 PDF、Word、纯文本的索引与检索。
