# 本地知识库（local-kb）

把本机的一个文件夹（Obsidian 库、笔记目录、项目文档目录）挂成知识库，让 AI 能检索并引用；同时提供一个侧边栏界面，用鼠标就能建索引、测接口、改配置。

## 它做什么

- 扫描 `root` 目录下的文件：纯文本（`.md` `.markdown` `.mdx` `.txt` `.rst` `.org` `.json` `.csv`）直接读；Word 文档（`.docx` `.doc` `.wps`）与 PDF（`.pdf`）用内置解析器取正文，按文件头而不是后缀判断真实格式，不依赖第三方库。
- 按 Markdown 标题分组、按字符窗口切块（保留原始行号），对每个片段调用 embedding 服务，向量写入 `<root>/.dsh-kb/`。
- 可选接一个**重排（rerank）**模型：先用向量/关键词召回一批候选，再交给重排模型按相关度重排，只留最相关的几条。
- 注册三个工具：
  - `kb_search`：语义检索（cosine 相似度），失败时自动退回本地关键词检索；返回文件相对路径、行号、标题、得分、摘要。
  - `kb_read`：按行读原文（`root` 内的文件；`.docx` 会先解包成文本），只能读库目录内的文件。
  - `kb_index`：`status` 查看索引状态，`rebuild` 重建（未变文件复用旧向量，只算新增/改动的片段），`probe` 只测一次 embedding 连通性、不重建索引。
- 检索前会用“文件数 + 大小 + mtime”判断索引是否过期，过期自动增量重建。
- 在系统提示里加一段简短说明，让模型知道有这套工具、目录在哪、引用要写路径与行号。

## 侧边栏界面

左侧栏会出现一个**知识库**图标（书本），点开是整页面板：

- 左列：库里的文件清单，带筛选框，每条显示文件名、目录、片段数；点一下在右侧看原文。
- 顶部：库名、根目录、状态标签（文件数 / 片段数 / 向量或关键词模式 / 重排模型 / 索引是否过期 / 未建索引 / 向量化失败原因）。
- 「检索」页：输入问题即时检索，可勾选是否走重排；结果卡片显示路径 + 行号 + 得分（启用重排时同时显示重排前的分数），命中词高亮。
- 「文档」页：按行渲染原文，可分页继续往下读。
- 「设置」页：改库名、根目录、embedding（`provider` / `baseUrl` / `model` / 批量 / 超时）、rerank（是否启用 / `baseUrl` / `model` / `topN` / 候选数），两个「测试接口」按钮分别验证 embedding 与重排连通性，「保存设置」把配置写回 profile 并让插件自动重载。

两个「测试接口」按钮测的是**表单里当前填的地址与密钥**（还没保存也能先测一测），测完再保存；保存后页面会自动等你到插件重载完成，再报「设置已生效」。万一写盘失败，页面会明确说「设置没有写入存储」并给出原因，不会假装成功。第一次装好还没填目录时，检索页会直接给一个「去『设置』填绝对路径」的按钮。

**密钥不进配置文件**：界面上填的 API Key 存进 DSH 凭据库（记录名 `local-kb/embedding`、`local-kb/rerank`），配置里只留这个记录名；也可以用 `apiKeyEnv` 指定环境变量。界面只显示掩码，留空即不修改。

## 配置

界面上保存即可；也可以直接改 profile 的 `cordis.patch.yml` 里 `id: local-kb` 行的 `config`：

```yaml
- id: local-kb
  name: 'dsh-local-kb'
  config:
    root: 'D:\notes'
    embedding:
      provider: ollama            # ollama | openai | none
      baseUrl: http://127.0.0.1:11434
      model: bge-m3
    rerank:
      enabled: true
      provider: cohere            # cohere | jina，协议相同
      baseUrl: https://api.jina.ai/v1
      model: jina-reranker-v2-base-multilingual
```

用 OpenAI 兼容接口时：

```yaml
    embedding:
      provider: openai
      baseUrl: https://api.openai.com/v1        # 到 /v1 为止，插件自己拼 /embeddings
      model: text-embedding-3-small
      apiKeyEnv: LOCAL_KB_API_KEY              # 推荐：从环境变量读密钥
      # apiKey: 'sk-...'                       # 或者直接写（会以明文留在配置里）
      # batchSize: 16                          # 每次请求带多少条片段
      # timeoutMs: 60000
```

`provider: none` 表示只做关键词检索，不需要任何外部服务。

**换 embedding 服务时**：`provider` + `model` 变了，索引里的旧向量会自动作废并全量重算；如果只换 `baseUrl`（同一模型换个网关），向量可以继续用。接完先跑 `kb_index`（`action=probe`）确认连通，再用 `action=rebuild` 生成向量。

### 重排协议

和 Cohere / Jina 一致：`POST {baseUrl}/rerank`（`baseUrl` 已以 `/rerank` 结尾时直接用它）

```json
{ "model": "jina-reranker-v2-base-multilingual", "query": "问题", "documents": ["片段1", "片段2"], "top_n": 6 }
```

响应取 `results: [{ index, relevance_score }]`（也接受 `score`），按分数降序、截断到 `topN`。请求带 `Authorization: Bearer <key>`（有密钥时）。重排挂了不影响检索：会退回原顺序，并在结果 `note` 里写明原因。

其余可选项（都可省略）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `name` | `root` 的文件夹名 | 界面与状态里显示的库名 |
| `indexDir` | `<root>/.dsh-kb` | 索引存放目录 |
| `extensions` | 见上 | 参与索引的后缀 |
| `exclude` | `node_modules`、`.git`、`.obsidian`、`.trash`、`.dsh-kb`、`~$*` | 排除规则，支持 `**` 与 `*` |
| `chunkSize` / `chunkOverlap` | 900 / 150 | 切块字符数与重叠 |
| `maxFileBytes` / `maxFiles` | 32 MiB / 20000 | 单文件与总量上限 |
| `autoBuild` | `true` | 检索时发现索引过期是否自动重建 |
| `promptSection` | `true` | 是否在系统提示里加入说明 |
| `search.topK` | 8 | 默认返回条数 |
| `search.minScore` | 0.2 | 相关度门槛：语义为 cosine，关键词为覆盖率×词频加成经饱和映射后的得分（都在 0–1，越大越相关） |
| `search.snippetChars` | 600 | 摘要长度 |
| `embedding.batchSize` / `timeoutMs` | 16 / 60000 | 批量与超时 |
| `rerank.candidates` / `topN` | 24 / 6 | 送进重排的候选数 / 最终保留条数 |
| `rerank.timeoutMs` | 30000 | 重排请求超时 |
| `ocr.enabled` | `false` | 打开扫描件 OCR（只对没有文本层的 PDF 生效） |
| `ocr.model` / `ocr.baseUrl` | `Qwen/Qwen3-VL-8B-Instruct` / 空 | 视觉模型与 OpenAI 兼容地址（填到 `/v1`） |
| `ocr.dpi` / `ocr.maxPages` / `ocr.concurrency` | 150 / 40 / 2 | 渲染精度、单篇最多页数、并发识别数 |
| `ocr.mutoolPath` | 空（用 PATH 里的 `mutool`） | mutool 可执行文件路径 |
| `ocr.timeoutMs` | 180000 | 单页识别超时 |

### 扫描件 OCR（可选）

有些 PDF 整页是图片，没有文本层，`lib/pdf.js` 提取不到字。打开 `ocr.enabled` 后，这类 PDF 会走：

1. `mutool draw` 按 `ocr.dpi` 把页面渲染成 PNG（默认只渲染前 `maxPages` 页）；
2. 每页转 base64，发 `POST {baseUrl}/chat/completions`，让视觉模型按「完整转写、保留段落顺序」的要求输出文字；
3. 按页拼接、写进索引；结果按「文件指纹 + dpi + 模型」缓存在 `<indexDir>/ocr/`，同一个文件重建索引不会重复花钱。

需要本机有 [MuPDF](https://mupdf.com/) 的 `mutool`（Windows 版单个 `mutool.exe` 即可；本仓库自带一份在 `tools/mutool.exe`，来源 `mupdf-1.28.5-windows.zip`）。有文本层的 PDF 仍然走文本层，不会触发 OCR。实测单页约 7 秒（150 dpi、`Qwen/Qwen3-VL-8B-Instruct`）。

## 本地面板用的 HTTP 接口

界面通过这些接口工作，都是回环地址、只接受本机请求（非回环 403）：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/local-kb/state` | 索引状态、当前配置、密钥配置情况、能力开关 |
| `GET /api/local-kb/docs` | 文件清单（路径、大小、mtime、片段数） |
| `POST /api/local-kb/search` | `{query, limit, pathPrefix, mode, rerank}` |
| `POST /api/local-kb/index` | `{action: status\|rebuild\|probe\|probe-rerank\|probe-ocr, force}` |
| `POST /api/local-kb/read` | `{path, offset, limit}` |
| `POST /api/local-kb/settings` | `{config, keys}`，先回话再写配置并重载插件 |

## 依赖与限制

- embedding 需要外部服务（Ollama 或 OpenAI 兼容端点）。没有服务时插件照常工作，只是走关键词检索，并在结果里说明原因。
- 重排是可选的；不配也能用（此时就是向量或关键词的原始排序）。
- 支持的格式：纯文本 + Word（`.docx`、`.doc`、`.wps`）+ PDF（`.pdf`，取文本层）。**不解析** `.xls/.xlsx` 以及扫描件/图片型 PDF——后者没有文本层，会在重建结果与 `kb_index status` 里带上“需要 OCR”的原因列出，不会被静默忽略。
- PDF 只做文本层：能解析对象、解压 FlateDecode、按 ToUnicode 还原字形码，支持多页与复合字体；扫描件（整页是图）需要 OCR，本插件没有内置 OCR，也不会假装读到了内容。
- Word 只取正文：`.docx` 的表格单元格单独成行，页眉页脚、脚注、批注、图片不索引；`.doc/.wps` 走 OLE2 片段表，正文完整，编号列表的自动编号不保留。
- 索引重建时会整体重写 `index.json`（片段）与 `vectors.bin`（向量），未变文件的向量与片段在内存里复用、不重新请求 embedding。实测 952 个 docx / 57MB 首次建索引 11.3 秒，只加几个文件时增量重建 0.17 秒（26 页 PDF 增量入库 1.7 秒）。
- 中文关键词兜底用的是字符二元组，个别弱相关查询可能命中共享字词；需要精度时用语义检索。
