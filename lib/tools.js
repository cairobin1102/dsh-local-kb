function formatMode(result) {
  if (result.mode === 'semantic') return `语义检索 · ${result.model}`
  if (result.mode === 'keyword') return '关键词检索'
  return result.mode
}

function formatSearch(result) {
  const lines = []
  if (result.mode === 'empty') {
    lines.push(result.note ?? '索引为空。')
    return lines.join('\n')
  }
  lines.push(`本地知识库 · ${formatMode(result)} · 命中 ${result.results.length} 条 / 索引共 ${result.total} 片段`)
  if (result.note) lines.push(`说明：${result.note}`)
  if (result.results.length === 0) {
    lines.push('没有达到相关度阈值的片段：换更具体的关键词，或放宽 search.minScore。')
    return lines.join('\n')
  }
  result.results.forEach((item, index) => {
    const range = item.endLine >= item.startLine ? `L${item.startLine}-${item.endLine}` : `L${item.startLine}`
    const heading = item.heading ? ` · 标题「${item.heading}」` : ''
    lines.push('')
    lines.push(`${index + 1}. \`${item.path}\` ${range} · 得分 ${Number(item.score).toFixed(3)}${heading}`)
    lines.push(`   ${item.snippet.replace(/\n/g, ' ')}`)
  })
  lines.push('')
  lines.push('需要原文用 kb_read（path + offset/limit）。')
  return lines.join('\n')
}

function formatRead(result) {
  const header = `\`${result.path}\` · 第 ${result.offset}-${result.offset + result.text.split('\n').length - 1} 行 / 共 ${result.totalLines} 行`
  const tail = result.truncated ? '\n…（还有后续内容，用 offset 继续读）' : ''
  return `${header}\n\n${result.text}${tail}`
}

function formatStatus(status) {
  const lines = [
    `知识库目录：${status.root}`,
    `索引目录：${status.indexDir}`,
  ]
  if (!status.indexed) {
    lines.push('索引：尚未建立')
    lines.push(`向量检索：${status.embedding.enabled ? `${status.embedding.provider} / ${status.embedding.model}` : '未启用'}`)
    lines.push(status.note)
    return lines.join('\n')
  }
  lines.push(`索引：${status.files} 个文件 / ${status.chunks} 个片段 · 建立于 ${status.builtAt}（${status.durationMs} ms）`)
  lines.push(
    status.mode === 'semantic'
      ? `向量检索：${status.embedding.indexedWithProvider} / ${status.embedding.indexedWith} · ${status.embedding.dim} 维`
      : `向量检索：未生效（当前为关键词检索）· 配置: ${status.embedding.provider} / ${status.embedding.model}`,
  )
  if (status.embeddingError) lines.push(`上次向量化错误：${status.embeddingError}`)
  if (status.effective) {
    const effective = status.effective
    lines.push(
      `检索参数：topK=${effective.topK} minScore=${effective.minScore} chunkSize=${effective.chunkSize} overlap=${effective.chunkOverlap} autoBuild=${effective.autoBuild} 后缀=${effective.extensions.join(' ')}`,
    )
  }
  lines.push(`索引新鲜度：${status.stale ? `已过期（${status.staleReason}），下次 kb_search 或 kb_index 会重建` : '最新'}`)
  if (status.lastErrors?.length) {
    lines.push('最近跳过的文件：')
    for (const item of status.lastErrors.slice(0, 10)) lines.push(`- ${item.path}：${item.error}`)
  }
  if (status.lastSkipped?.length) {
    lines.push('最近未索引项：')
    for (const item of status.lastSkipped.slice(0, 10)) {
      lines.push(`- ${item.path || '（目录整体）'}：${item.reason}`)
    }
  }
  if (status.lastUnsupported?.length) {
    lines.push('未支持的格式（未索引）：')
    for (const item of status.lastUnsupported.slice(0, 10)) {
      lines.push(`- ${item.extension} × ${item.count}`)
    }
  }
  return lines.join('\n')
}

function formatRebuild(summary) {
  const lines = [
    `已重建索引：${summary.fileCount} 个文件 / ${summary.chunkCount} 个片段（${summary.durationMs} ms）`,
    `检索模式：${summary.mode === 'semantic' ? `语义（${summary.embedding.provider} / ${summary.embedding.model}，${summary.embedding.dim} 维）` : '关键词'}`,
  ]
  if (summary.mode === 'semantic') {
    lines.push(`向量：新算 ${summary.embeddedChunks} 条，复用 ${summary.reusedVectors} 条；未变文件 ${summary.reusedFiles} 个`)
  }
  if (summary.embeddingError) lines.push(`向量化失败（已保留关键词检索）：${summary.embeddingError}`)
  if (summary.errors?.length) {
    lines.push('跳过的文件：')
    for (const item of summary.errors.slice(0, 10)) lines.push(`- ${item.path}：${item.error}`)
  }
  if (summary.skipped?.length) {
    lines.push('未索引项：')
    for (const item of summary.skipped.slice(0, 10)) lines.push(`- ${item.path || '（目录整体）'}：${item.reason}`)
  }
  if (summary.unsupported?.length) {
    const ignored = summary.unsupported.map((item) => `${item.extension}×${item.count}`).join('、')
    lines.push(`未支持的格式（未索引）：${ignored}。需要的话先转成 .md/.txt，或把它们导出为 .docx。`)
  }
  return lines.join('\n')
}

function formatProbe(result) {
  const lines = [
    `embedding 连通正常：${result.provider} / ${result.model} · ${result.dim} 维 · 单条耗时 ${result.ms} ms`,
    `服务地址：${result.baseUrl}`,
  ]
  if (result.indexedDim > 0 && result.indexedDim !== result.dim) {
    lines.push(`注意：现有索引是 ${result.indexedDim} 维，与当前模型不一致，需要 kb_index（action=rebuild）重建。`)
  } else if (result.indexedDim === 0) {
    lines.push('当前索引没有向量：执行 kb_index（action=rebuild）后才会走语义检索。')
  }
  return lines.join('\n')
}

const textOutput = {
  schema: { type: 'string' },
  render(args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  },
}

export function createToolDefinitions(kb) {
  return [
    {
      name: 'kb_search',
      description:
        '在本地知识库（外挂的本地文件夹）里检索相关片段，返回文件相对路径、行号、标题和摘要。回答涉及该目录资料的问题前先用它；命中不够时换关键词再试，不要凭猜测作答。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要查找的内容，用自然语言或关键词描述（中文、英文都可以）',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 30,
            description: '返回条数，默认取插件配置 search.topK',
          },
          path_prefix: {
            type: 'string',
            description: '只在相对路径以此开头的文件里检索，例如 projects/ 或 notes/rag',
          },
          mode: {
            type: 'string',
            enum: ['auto', 'semantic', 'keyword'],
            description: 'auto 优先语义、失败退回关键词；semantic 失败直接报错；keyword 只用关键词',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: textOutput,
      timeoutMs: 120000,
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {}
        const result = await kb.search({
          query: input.query,
          limit: input.limit,
          pathPrefix: input.path_prefix,
          mode: input.mode === 'semantic' || input.mode === 'keyword' ? input.mode : 'auto',
        })
        return formatSearch(result)
      },
    },
    {
      name: 'kb_read',
      description:
        '读取本地知识库里一个文件的原文（按行分页）。kb_search 只给片段，需要上下文、完整章节或核对原文时用它。只能读知识库目录内的文件。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对知识库根目录的路径，kb_search 结果里给出的那个',
          },
          offset: {
            type: 'integer',
            minimum: 1,
            description: '起始行号（从 1 开始），默认 1',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 2000,
            description: '读取行数，默认 200',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: textOutput,
      timeoutMs: 30000,
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {}
        return formatRead(
          await kb.readDocument({ filePath: input.path, offset: input.offset, limit: input.limit }),
        )
      },
    },
    {
      name: 'kb_index',
      description:
        '查看本地知识库索引状态，或重建索引。状态包含目录、文件与片段数、向量模型、索引是否过期、上次失败原因；重建会在文件变动后重新切块并向量化（未变文件自动复用）。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'rebuild', 'probe'],
            description:
              'status 只看状态；rebuild 重新建立索引；probe 只测一次 embedding 连通性（不重建索引，接完 API 先跑它）',
          },
          force: {
            type: 'boolean',
            description: 'rebuild 时忽略缓存、全部重算（更换 embedding 模型或怀疑索引损坏时用）',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: textOutput,
      timeoutMs: 600000,
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {}
        if (input.action === 'rebuild') {
          return formatRebuild(await kb.rebuild({ force: input.force === true }))
        }
        if (input.action === 'probe') {
          return formatProbe(await kb.probe())
        }
        return formatStatus(await kb.status())
      },
    },
  ]
}
