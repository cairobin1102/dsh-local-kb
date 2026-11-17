import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { normalizeConfig } from '../lib/config.js'
import { createKnowledgeBase } from '../lib/kb.js'
import { chunkText } from '../lib/chunk.js'
import { extractDocxText } from '../lib/docx.js'
import { createToolDefinitions } from '../lib/tools.js'

const results = []
function check(name, fn) {
  results.push({ name, fn })
}

/** Deterministic bag-of-words embedding so the vector path can be exercised without a model. */
function fakeVector(text) {
  const dim = 32
  const vector = new Array(dim).fill(0)
  for (const token of String(text).toLowerCase().matchAll(/[a-z0-9]{2,}|[\u3400-\u9fff]/g)) {
    const key = token[0]
    let hash = 2166136261
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    vector[Math.abs(hash) % dim] += 1
  }
  if (vector.every((value) => value === 0)) vector[0] = 1
  return vector
}

async function startFakeOllama() {
  let embedCalls = 0
  let embedTexts = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      if (request.url === '/api/embed') {
        const payload = JSON.parse(body || '{}')
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input]
        embedCalls += 1
        embedTexts += inputs.length
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ model: payload.model, embeddings: inputs.map(fakeVector) }))
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stats: () => ({ embedCalls, embedTexts }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Minimal ZIP writer: enough to produce a real .docx the extractor must unpack. */
function crc32(buffer) {
  let table = crc32.table
  if (!table) {
    table = new Int32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      table[index] = value
    }
    crc32.table = table
  }
  let crc = -1
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function buildZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const compressed = deflateRawSync(data)
    const crc = crc32(data)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, compressed)

    const header = Buffer.alloc(46 + name.length)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(8, 10)
    header.writeUInt32LE(0, 12)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(compressed.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(offset, 42)
    name.copy(header, 46)
    central.push(header)

    offset += local.length + compressed.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, directory, end])
}

function buildDocx(paragraphs) {
  const body = paragraphs
    .map((paragraph) => {
      const runs = String(paragraph)
        .split('\t')
        .map((segment) => `<w:r><w:t xml:space="preserve">${segment}</w:t></w:r>`)
        .join('<w:r><w:tab/></w:r>')
      return `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${runs}</w:p>`
    })
    .join('')
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  return buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    { name: 'word/document.xml', data: xml },
  ])
}

async function makeKnowledgeBase(root) {
  await mkdir(path.join(root, 'guides'), { recursive: true })
  await mkdir(path.join(root, 'notes'), { recursive: true })
  await writeFile(
    path.join(root, 'guides', 'rag.md'),
    ['# 向量检索入门', '', '向量检索把文本映射成向量，再用余弦相似度排序。', '', '## 索引构建', '', '先把文档切块，再逐块计算 embedding，最后写入向量库。'].join('\n'),
  )
  await writeFile(
    path.join(root, 'notes', 'cooking.txt'),
    ['红烧肉的做法：先把五花肉切块焯水，再炒糖色。', '', '最后小火慢炖四十分钟。'].join('\n'),
  )
  await writeFile(
    path.join(root, 'notes', 'meeting.md'),
    ['# 周会纪要', '', '下周三评审登录流程，负责人是小王。'].join('\n'),
  )
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.md'), '# 不应被索引')
}

function makeOptions(root, overrides = {}) {
  return normalizeConfig({ root, ...overrides })
}

check('chunkText 保留行号并切出有重叠的片段', () => {
  const text = ['# 标题', ...Array.from({ length: 60 }, (_, index) => `第 ${index} 行内容，用来凑长度。`)].join('\n')
  const chunks = chunkText(text, { path: 'a.md', chunkSize: 300, chunkOverlap: 60 })
  assert.ok(chunks.length > 1, '应当切出多个片段')
  assert.equal(chunks[0].startLine, 1)
  assert.ok(chunks[0].heading.length > 0)
  for (let index = 1; index < chunks.length; index += 1) {
    assert.ok(chunks[index].startLine <= chunks[index - 1].endLine, '片段之间应当有重叠或相邻')
  }
  assert.ok(chunks.every((chunk) => chunk.text.trim() !== ''))
})

check('未配置 root 时报出可读的配置指引', async () => {
  const kb = createKnowledgeBase(normalizeConfig({}))
  await assert.rejects(() => kb.search({ query: 'x' }), /cordis\.patch\.yml/)
})

check('关键词模式：可检索、可读取、拦截目录逃逸', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-lkb-'))
  try {
    await makeKnowledgeBase(root)
    const kb = createKnowledgeBase(makeOptions(root, { embedding: { provider: 'none' } }))
    const summary = await kb.rebuild()
    assert.equal(summary.fileCount, 3, `应索引 3 个文件，实际 ${summary.fileCount}`)
    assert.ok(summary.chunkCount >= 3)
    assert.equal(summary.mode, 'keyword')

    const chinese = await kb.search({ query: '余弦相似度' })
    assert.equal(chinese.mode, 'keyword')
    assert.equal(chinese.results[0].path, 'guides/rag.md')
    for (const item of chinese.results) {
      assert.ok(item.score > 0 && item.score < 1, `关键词得分应落在 (0,1)，实际 ${item.score}`)
    }

    const english = await kb.search({ query: 'embedding' })
    assert.equal(english.results[0].path, 'guides/rag.md')

    const scoped = await kb.search({ query: '焯水 糖色', path_prefix: 'notes/' })
    assert.equal(scoped.results[0].path, 'notes/cooking.txt')

    // 没有任何共同片段（含中文二元组）时不应返回结果。
    const missing = await kb.search({ query: '量子纠缠与退相干' })
    assert.equal(missing.results.length, 0)
    // 只共享「计算」一个二元组时得分明显偏低，不会伪装成满分命中。
    const weak = await kb.search({ query: '量子计算' })
    for (const item of weak.results) assert.ok(item.score < 0.35, `弱命中得分应偏低，实际 ${item.score}`)

    const document = await kb.readDocument({ filePath: 'guides/rag.md', limit: 2 })
    assert.equal(document.totalLines, 7)
    assert.ok(document.text.startsWith('# 向量检索入门'))
    assert.equal(document.truncated, true)

    await assert.rejects(() => kb.readDocument({ filePath: '../secret.txt' }), /只能读取知识库目录内/)

    const status = await kb.status()
    assert.equal(status.indexed, true)
    assert.equal(status.stale, false)
    assert.equal(status.chunks, summary.chunkCount)
    assert.equal(status.embedding.enabled, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

check('语义模式：走 /api/embed，命中正确文件，并复用未变文件的向量', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-lkb-'))
  const service = await startFakeOllama()
  try {
    await makeKnowledgeBase(root)
    const options = makeOptions(root, {
      embedding: { provider: 'ollama', baseUrl: service.baseUrl, model: 'fake-embed' },
    })
    const kb = createKnowledgeBase(options)

    const first = await kb.rebuild()
    assert.equal(first.mode, 'semantic')
    assert.equal(first.embedding.dim, 32)
    assert.equal(first.embeddedChunks, first.chunkCount)
    assert.equal(first.reusedVectors, 0)

    const semantic = await kb.search({ query: 'embedding 向量' })
    assert.equal(semantic.mode, 'semantic')
    assert.equal(semantic.results[0].path, 'guides/rag.md')
    assert.ok(semantic.results[0].score > 0)

    const before = service.stats()
    await writeFile(path.join(root, 'notes', 'meeting.md'), '# 周会纪要\n\n下周评审登录流程，负责人是小王。\n新增一条：周四联调。')
    const second = await kb.rebuild()
    const after = service.stats()
    assert.equal(second.mode, 'semantic')
    assert.ok(second.reusedVectors > 0, '未变文件的向量应当复用')
    assert.ok(second.embeddedChunks < second.chunkCount, '不应重算全部片段')
    assert.equal(after.embedCalls - before.embedCalls < second.chunkCount, true, '增量重建的请求量应小于全量')
    assert.ok(after.embedTexts - before.embedTexts <= second.chunkCount)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

check('embedding 服务挂掉时退回关键词检索并说明原因', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-lkb-'))
  const service = await startFakeOllama()
  try {
    await makeKnowledgeBase(root)
    const kb = createKnowledgeBase(
      makeOptions(root, {
        embedding: { provider: 'ollama', baseUrl: service.baseUrl, model: 'fake-embed' },
      }),
    )
    await kb.rebuild()
    await service.close()

    const fallback = await kb.search({ query: '余弦相似度' })
    assert.equal(fallback.mode, 'keyword')
    assert.match(fallback.note ?? '', /向量检索不可用/)
    assert.equal(fallback.results[0].path, 'guides/rag.md')

    await assert.rejects(() => kb.search({ query: '余弦相似度', mode: 'semantic' }), /无法连接|HTTP/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

check('embedding 不可用时仍能建出关键词索引并记录原因', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-lkb-'))
  try {
    await makeKnowledgeBase(root)
    const kb = createKnowledgeBase(
      makeOptions(root, {
        embedding: { provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'nope', timeoutMs: 2000 },
      }),
    )
    const summary = await kb.rebuild()
    assert.equal(summary.mode, 'keyword')
    assert.ok(summary.embeddingError, '应当记录向量化失败原因')
    const status = await kb.status()
    assert.match(status.embeddingError ?? '', /无法连接/)
    const search = await kb.search({ query: '周会' })
    assert.equal(search.results[0].path, 'notes/meeting.md')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

check('配置归一化：默认值、非法值收敛、indexDir 跟随 root', () => {
  const options = normalizeConfig({
    root: 'D:\\notes',
    chunkSize: 5,
    chunkOverlap: 99999,
    search: { topK: 100, minScore: '0.4' },
    embedding: { provider: 'CLAUDE' },
    exclude: ['**/tmp/**'],
    extensions: ['md', '.TXT'],
  })
  assert.equal(options.root, 'D:\\notes')
  assert.equal(options.chunkSize, 200)
  assert.equal(options.chunkOverlap, 1200)
  assert.equal(options.search.topK, 30)
  assert.equal(options.search.minScore, 0.4)
  assert.equal(options.embedding.provider, 'ollama')
  assert.deepEqual(options.exclude, ['**/tmp/**'])
  assert.deepEqual(options.extensions, ['.md', '.txt'])
  assert.equal(options.indexDir, path.join('D:\\notes', '.dsh-kb'))
  assert.equal(normalizeConfig({}).root, '')
})

check('工具定义：三个工具、schema 合法、错误信息可读', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-lkb-'))
  try {
    await makeKnowledgeBase(root)
    const kb = createKnowledgeBase(makeOptions(root, { embedding: { provider: 'none' } }))
    const definitions = createToolDefinitions(kb)
    assert.deepEqual(
      definitions.map((definition) => definition.name),
      ['kb_search', 'kb_read', 'kb_index'],
    )
    for (const definition of definitions) {
      assert.equal(typeof definition.description, 'string')
      assert.equal(definition.parameters.type, 'object')
      assert.equal(definition.parameters.additionalProperties, false)
      assert.equal(typeof definition.execute, 'function')
      assert.equal(definition.output.schema.type, 'string')
    }

    const search = definitions.find((definition) => definition.name === 'kb_search')
    const searchText = await search.execute({ query: '切块' }, {})
    assert.match(searchText, /本地知识库/)
    assert.match(searchText, /guides\/rag\.md/)

    const index = definitions.find((definition) => definition.name === 'kb_index')
    const rebuildText = await index.execute({ action: 'rebuild' }, {})
    assert.match(rebuildText, /已重建索引/)
    const statusText = await index.execute({ action: 'status' }, {})
    assert.match(statusText, /知识库目录/)
    assert.match(statusText, /关键词检索/)

    const read = definitions.find((definition) => definition.name === 'kb_read')
    const readText = await read.execute({ path: 'guides/rag.md', limit: 3 }, {})
    assert.match(readText, /第 1-3 行 \/ 共 7 行/)

    for (const definition of definitions) {
      const text = definition.output.render({}, await definition.execute(
        definition.name === 'kb_read' ? { path: 'guides/rag.md' } : definition.name === 'kb_index' ? { action: 'status' } : { query: '向量' },
        {},
      ))
      assert.equal(text[0].type, 'text')
      assert.ok(text[0].text.length > 0)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

check('apply：注册三个工具、按配置加/不加提示词段落，并能随 effect 卸载', async () => {
  const { apply } = await import('../lib/index.js')

  function fakeContext({ withPrompt = true } = {}) {
    const tools = []
    const sections = []
    const cleanups = []
    const ctx = {
      tools: {
        register(definition) {
          tools.push(definition)
          return () => {
            const index = tools.indexOf(definition)
            if (index >= 0) tools.splice(index, 1)
          }
        },
      },
      get(name) {
        if (name !== 'systemPrompt' || !withPrompt) return undefined
        return {
          section(definition) {
            sections.push(definition)
            return () => sections.splice(sections.indexOf(definition), 1)
          },
        }
      },
      effect(callback) {
        const cleanup = callback()
        cleanups.push(cleanup)
        return () => cleanup?.()
      },
    }
    return {
      ctx,
      tools,
      sections,
      dispose() {
        while (cleanups.length > 0) cleanups.pop()?.()
      },
    }
  }

  const configured = fakeContext()
  apply(configured.ctx, { root: 'D:\\notes', embedding: { provider: 'none' } })
  assert.deepEqual(configured.tools.map((tool) => tool.name), ['kb_search', 'kb_read', 'kb_index'])
  assert.equal(configured.sections.length, 1)
  assert.equal(configured.sections[0].name, 'local-kb')
  assert.equal(configured.sections[0].order, 260)
  assert.match(configured.sections[0].text, /D:\\notes/)
  configured.dispose()
  assert.equal(configured.tools.length, 0)
  assert.equal(configured.sections.length, 0)

  const bare = fakeContext()
  apply(bare.ctx, {})
  assert.equal(bare.tools.length, 3)
  assert.equal(bare.sections.length, 0)

  const noPrompt = fakeContext()
  apply(noPrompt.ctx, { root: 'D:\\notes', promptSection: false })
  assert.equal(noPrompt.sections.length, 0)
})

check('索引目录自身永远不会被当成知识库文件；删除文件后条目消失', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-lkb-'))
  try {
    await makeKnowledgeBase(root)
    const kb = createKnowledgeBase(makeOptions(root, { embedding: { provider: 'none' } }))
    const first = await kb.rebuild()
    const second = await kb.rebuild()
    assert.equal(first.fileCount, 3)
    assert.equal(second.fileCount, 3, '第二次重建不应把 .dsh-kb 里的索引文件算进来')
    const status = await kb.status()
    assert.deepEqual(
      status.indexFiles ? Object.keys(status.indexFiles).sort() : [],
      ['indexPath', 'vectorsPath'],
    )
    const indexed = await kb.search({ query: 'index.json vectors' })
    assert.ok(indexed.results.every((item) => !item.path.includes('.dsh-kb')), '索引文件不应出现在检索结果里')

    await rm(path.join(root, 'notes', 'cooking.txt'))
    const third = await kb.rebuild()
    assert.equal(third.fileCount, 2)
    const gone = await kb.search({ query: '焯水 糖色' })
    assert.ok(gone.results.every((item) => item.path !== 'notes/cooking.txt'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

check('docx：解包取正文、还原实体与制表符、可索引可读取', async () => {
  const docx = buildDocx([
    '第一段：坚持以人民为中心，推动高质量发展。',
    '第二段\t带一个制表符',
    '第三段：&#x4e2d;&#25991;实体与 &amp; 符号',
  ])
  const text = extractDocxText(docx)
  assert.match(text, /坚持以人民为中心/)
  assert.match(text, /第二段\t带一个制表符/)
  assert.match(text, /第三段：中文实体与 & 符号/)
  assert.equal(text.split('\n').length, 3)
  assert.throws(() => extractDocxText(Buffer.from('not a zip')), /不是有效的 ZIP/)
  // 旧版 .doc 改了后缀：明确报出原因，而不是含糊的“找不到目录结尾”。
  const fakeOle = Buffer.alloc(16)
  fakeOle.writeUInt32LE(0xe011cfd0, 0)
  assert.throws(() => extractDocxText(fakeOle), /旧版 Word（\.doc 二进制格式）改了后缀/)

  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-lkb-'))
  try {
    await writeFile(path.join(root, '讲话.docx'), docx)
    // 真实 .docx 被改名成 .doc 时，按文件头判断仍应能解析。
    await writeFile(path.join(root, '伪装.doc'), docx)
    await writeFile(path.join(root, '坏文件.doc'), 'dummy')
    await writeFile(path.join(root, '表格.xlsx'), 'dummy')
    const kb = createKnowledgeBase(makeOptions(root, { embedding: { provider: 'none' } }))
    const summary = await kb.rebuild()
    assert.equal(summary.fileCount, 2, 'docx 与被改名的 doc 都应被索引')
    assert.deepEqual(summary.unsupported, [{ extension: '.xlsx', count: 1 }])
    assert.ok(
      summary.errors.some((item) => item.path === '坏文件.doc'),
      '坏的 doc 应当记录错误而不是静默丢弃',
    )

    const found = await kb.search({ query: '人民为中心' })
    assert.ok(found.results.some((item) => item.path.endsWith('.doc')))

    const read = await kb.readDocument({ filePath: '讲话.docx' })
    assert.equal(read.totalLines, 3)
    assert.match(read.text, /坚持以人民为中心/)
    assert.doesNotMatch(read.text, /<w:t/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

check('doc：非 OLE2 内容给出可读错误，不会静默返回空文本', async () => {
  const { extractDocText } = await import('../lib/doc.js')
  assert.throws(() => extractDocText(Buffer.from('this is not a compound file')), /不是 OLE2 复合文档/)
  const ole = Buffer.alloc(512)
  ole.writeUInt32LE(0xe011cfd0, 0)
  ole.writeUInt16LE(9, 0x1e)
  ole.writeUInt16LE(6, 0x20)
  assert.throws(() => extractDocText(ole), /没有 WordDocument 流|Word 文档头无效/)
})

check('probe：只测 embedding 连通性，不动索引；未启用/连不上时给出可读原因', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-lkb-'))
  const service = await startFakeOllama()
  try {
    await makeKnowledgeBase(root)

    const keywordOnly = createKnowledgeBase(makeOptions(root, { embedding: { provider: 'none' } }))
    await assert.rejects(() => keywordOnly.probe(), /未启用向量检索/)

    const semantic = createKnowledgeBase(
      makeOptions(root, { embedding: { provider: 'ollama', baseUrl: service.baseUrl, model: 'fake-embed' } }),
    )
    const result = await semantic.probe()
    assert.equal(result.provider, 'ollama')
    assert.equal(result.model, 'fake-embed')
    assert.equal(result.dim, 32)
    assert.equal(result.indexed, 0, 'probe 不应顺手建索引')
    assert.ok(Number.isFinite(result.ms))

    const broken = createKnowledgeBase(
      makeOptions(root, { embedding: { provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'nope', timeoutMs: 1500 } }),
    )
    await assert.rejects(() => broken.probe(), /无法连接/)

    const definitions = createToolDefinitions(semantic)
    const indexTool = definitions.find((definition) => definition.name === 'kb_index')
    const probeText = await indexTool.execute({ action: 'probe' }, {})
    assert.match(probeText, /embedding 连通正常/)
    assert.match(probeText, /32 维/)
    assert.match(probeText, /当前索引没有向量/)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

let failed = 0
for (const { name, fn } of results) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(error?.stack ?? error)
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
