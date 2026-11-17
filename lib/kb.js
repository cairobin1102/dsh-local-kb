import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { chunkText } from './chunk.js'
import { createEmbedder, EmbeddingError } from './embed.js'
import { ocrPdf } from './ocr.js'
import { createReranker } from './rerank.js'
import { readSourceText, scanFiles } from './scan.js'
import { createStore } from './store.js'
import { CONFIG_HINT } from './config.js'

const INDEX_CHECK_INTERVAL_MS = 4000
const MAX_REPORTED = 20

function hashText(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

function round(value) {
  return Math.round(value * 10000) / 10000
}

function tokenize(text) {
  const lower = String(text ?? '').toLowerCase()
  const tokens = []
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9_+#.-]*/g)) {
    if (match[0].length >= 2) tokens.push(match[0])
  }
  for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.push(run)
    else for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

function buildLexicalIndex(chunks) {
  const documentFrequency = new Map()
  const rows = chunks.map((chunk) => {
    const counts = new Map()
    for (const token of tokenize(`${chunk.heading ?? ''}\n${chunk.text}`)) {
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
    for (const token of counts.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
    return { counts, length: Math.max(1, chunk.text.length), heading: (chunk.heading ?? '').toLowerCase() }
  })
  return { documentFrequency, rows, total: chunks.length }
}

function snippetAround(text, query, size) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (source.length <= size) return source
  const terms = query
    .toLowerCase()
    .split(/[\s,，。;；:：!?！？]+/)
    .filter((term) => term.length >= 2)
  let start = 0
  const lower = source.toLowerCase()
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found >= 0) {
      start = Math.max(0, found - Math.floor(size / 3))
      break
    }
  }
  start = Math.min(Math.max(0, start), Math.max(0, source.length - size))
  const end = Math.min(source.length, start + size)
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`
}

export function createKnowledgeBase(options, hooks = {}) {
  const store = createStore(options.indexDir)
  const secrets = hooks.secrets ?? null
  const embedder = createEmbedder(options.embedding, {
    resolveKey: secrets ? () => secrets.read('embedding', options.embedding) : undefined,
  })
  const reranker = createReranker(options.rerank, {
    resolveKey: secrets ? () => secrets.read('rerank', options.rerank) : undefined,
  })
  const state = { index: null, pending: null, lastCheckAt: 0 }
  const ocrOptions = options.ocr ?? null
  const ocrCacheDir = options.indexDir ? path.join(options.indexDir, 'ocr') : ''
  const ocrStats = { files: 0, pages: 0, cachedFiles: 0, ms: 0 }

  /** 扫描件的兜底：把 PDF 交给 mutool + 视觉模型转成文字（结果按文件指纹缓存）。 */
  async function ocrText(absolutePath, relative, info, signal) {
    if (!ocrOptions?.enabled) {
      throw new Error('这个 PDF 没有文本层（扫描件），需要在设置里打开「扫描件 OCR」才能索引。')
    }
    const result = await ocrPdf({
      pdfPath: absolutePath,
      relativePath: relative,
      size: info?.size ?? 0,
      mtimeMs: info?.mtimeMs ?? 0,
      options: ocrOptions,
      cacheDir: ocrCacheDir,
      resolveKey: secrets ? () => secrets.read('ocr', ocrOptions) : undefined,
      signal,
    })
    ocrStats.files += 1
    ocrStats.pages += result.pages
    ocrStats.ms += result.ms
    if (result.cached) ocrStats.cachedFiles += 1
    return result.text
  }

  function assertReady() {
    if (!options.root) throw new Error(CONFIG_HINT)
  }

  async function loadIndex() {
    if (state.index) return state.index
    state.index = await store.read()
    return state.index
  }

  async function checkStale() {
    const index = await loadIndex()
    if (!index) return { stale: true, reason: '尚未建立索引' }
    if (path.resolve(index.meta.root ?? '') !== path.resolve(options.root)) {
      return { stale: true, reason: '知识库目录已变更' }
    }
    const { files } = await scanFiles(options.root, options)
    const previous = new Map((index.meta.files ?? []).map((file) => [file.path, file]))
    if (previous.size !== files.size) return { stale: true, reason: '文件数量变化' }
    for (const [relative, info] of files) {
      const recorded = previous.get(relative)
      if (!recorded) return { stale: true, reason: '新增文件' }
      if (recorded.size !== info.size || recorded.mtimeMs !== info.mtimeMs) {
        return { stale: true, reason: '文件内容变化' }
      }
    }
    return { stale: false, reason: '' }
  }

  async function rebuildNow({ force = false, signal } = {}) {
    assertReady()
    const startedAt = Date.now()
    const { files, skipped, unsupported } = await scanFiles(options.root, options, signal)
    const previous = force ? null : await loadIndex()

    const previousFiles = new Map((previous?.meta?.files ?? []).map((file) => [file.path, file]))
    const previousChunks = new Map()
    for (const chunk of previous?.chunks ?? []) {
      const list = previousChunks.get(chunk.path)
      if (list) list.push(chunk)
      else previousChunks.set(chunk.path, [chunk])
    }

    const embeddingKey = embedder.key
    const canReuseVectors =
      Boolean(previous?.vectors) &&
      previous.dim > 0 &&
      previous.meta?.embedding?.key === embeddingKey

    const reusableVectors = new Map()
    if (canReuseVectors) {
      for (let row = 0; row < previous.chunks.length; row += 1) {
        const chunk = previous.chunks[row]
        if (!chunk?.h) continue
        reusableVectors.set(
          `${chunk.path}\u0000${chunk.h}`,
          previous.vectors.subarray(row * previous.dim, (row + 1) * previous.dim),
        )
      }
    }

    const chunks = []
    const fileEntries = []
    const errors = []
    let reusedFiles = 0
    ocrStats.files = 0
    ocrStats.pages = 0
    ocrStats.cachedFiles = 0
    ocrStats.ms = 0

    for (const [relative, info] of [...files].sort((left, right) => (left[0] < right[0] ? -1 : 1))) {
      const recorded = previousFiles.get(relative)
      const unchanged =
        recorded &&
        recorded.size === info.size &&
        recorded.mtimeMs === info.mtimeMs &&
        Number.isFinite(recorded.chunkCount)

      let fileChunks = null
      if (unchanged && previousChunks.has(relative)) {
        fileChunks = previousChunks.get(relative)
      } else if (unchanged && recorded.chunkCount === 0) {
        fileChunks = []
      }

      if (fileChunks === null) {
        const absolute = path.join(options.root, ...relative.split('/'))
        const extension = path.extname(relative).toLowerCase()
        try {
          const text = await readSourceText(absolute, extension, options.maxFileBytes, {
            ocrText: ocrOptions?.enabled
              ? (target) => ocrText(target, relative, info, signal)
              : undefined,
          })
          fileChunks = chunkText(text, {
            path: relative,
            chunkSize: options.chunkSize,
            chunkOverlap: options.chunkOverlap,
          })
        } catch (error) {
          if (errors.length < MAX_REPORTED) errors.push({ path: relative, error: String(error?.message ?? error) })
          continue
        }
      } else {
        reusedFiles += 1
      }

      for (const chunk of fileChunks) {
        chunks.push({ ...chunk, h: hashText(chunk.text) })
      }
      fileEntries.push({
        path: relative,
        size: info.size,
        mtimeMs: info.mtimeMs,
        chunkCount: fileChunks.length,
      })
    }

    let vectors = null
    let dim = canReuseVectors ? previous.dim : 0
    let embeddingError = null
    let embeddedChunks = 0
    let reusedVectors = 0

    if (embedder.enabled && chunks.length > 0) {
      const reused = new Array(chunks.length)
      if (canReuseVectors) {
        for (let row = 0; row < chunks.length; row += 1) {
          const vector = reusableVectors.get(`${chunks[row].path}\u0000${chunks[row].h}`)
          if (vector && vector.length === dim) {
            reused[row] = vector
            reusedVectors += 1
          }
        }
      }
      const missing = []
      for (let row = 0; row < chunks.length; row += 1) if (!reused[row]) missing.push(row)

      try {
        if (missing.length > 0) {
          const texts = missing.map((row) => chunks[row].text)
          const embedded = await embedder.embed(texts, signal)
          dim = embedded[0]?.length ?? 0
          if (dim === 0) throw new EmbeddingError('embedding 服务返回空向量')
          for (let index = 0; index < missing.length; index += 1) {
            const vector = embedded[index]
            if (vector.length !== dim) {
              throw new EmbeddingError(`embedding 维度不一致：${vector.length} != ${dim}`)
            }
            reused[missing[index]] = vector
          }
          embeddedChunks = missing.length
        }
        vectors = new Float32Array(chunks.length * dim)
        for (let row = 0; row < chunks.length; row += 1) {
          const vector = reused[row]
          if (!vector) throw new EmbeddingError('存在没有向量的片段')
          vectors.set(vector, row * dim)
        }
      } catch (error) {
        vectors = null
        dim = 0
        embeddedChunks = 0
        reusedVectors = 0
        embeddingError =
          error instanceof EmbeddingError
            ? error.message
            : `向量化失败：${error?.message ?? error}`
      }
    }

    const meta = {
      version: store.version,
      root: options.root,
      indexDir: options.indexDir,
      builtAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      embedding: {
        provider: embedder.provider,
        model: embedder.model,
        key: embedder.key,
        dim,
      },
      embeddingError,
      embeddingSplits: typeof embedder.lastStats === 'function' ? embedder.lastStats().split : 0,
      files: fileEntries,
      fileCount: fileEntries.length,
      chunkCount: chunks.length,
      chunkSize: options.chunkSize,
      chunkOverlap: options.chunkOverlap,
      reusedFiles,
      embeddedChunks,
      reusedVectors,
      errors: errors.slice(0, MAX_REPORTED),
      skipped: skipped.slice(0, MAX_REPORTED),
      unsupported: unsupported.slice(0, 12),
      ocr: { ...ocrStats },
    }

    await store.write({ meta, chunks, vectors, dim })
    state.index = { meta, chunks, vectors, dim, lexical: null }
    state.lastCheckAt = Date.now()

    return {
      ...meta,
      mode: dim > 0 ? 'semantic' : 'keyword',
    }
  }

  function rebuild(settings = {}) {
    if (state.pending) return state.pending
    state.pending = rebuildNow(settings).finally(() => {
      state.pending = null
    })
    return state.pending
  }

  async function ensureFresh({ signal, autoBuild = options.autoBuild } = {}) {
    assertReady()
    if (state.pending) return state.pending
    const now = Date.now()
    if (state.index && now - state.lastCheckAt < INDEX_CHECK_INTERVAL_MS) return state.index
    const { stale, reason } = await checkStale()
    if (!stale) {
      state.lastCheckAt = now
      return loadIndex()
    }
    if (!autoBuild) {
      throw new Error(`索引未就绪（${reason}）：请先调用 kb_index（action=rebuild）。`)
    }
    return rebuild({ signal })
  }

  function lexicalSearch(index, query, { limit, pathPrefix }) {
    if (!index.lexical) index.lexical = buildLexicalIndex(index.chunks)
    const { documentFrequency, rows, total } = index.lexical
    const queryTokens = [...new Set(tokenize(query))]
    if (queryTokens.length === 0) return []

    const idf = new Map()
    let idfTotal = 0
    for (const token of queryTokens) {
      const frequency = documentFrequency.get(token) ?? 0
      const weight = Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5))
      idf.set(token, weight)
      idfTotal += weight
    }
    if (idfTotal <= 0) return []

    const scored = []
    for (let row = 0; row < rows.length; row += 1) {
      const chunk = index.chunks[row]
      if (pathPrefix && !chunk.path.toLowerCase().startsWith(pathPrefix.toLowerCase())) continue
      const entry = rows[row]
      let matchedWeight = 0
      let termFrequency = 0
      let headingHit = false
      for (const token of queryTokens) {
        const count = entry.counts.get(token)
        if (!count) continue
        matchedWeight += idf.get(token) ?? 0
        termFrequency += count
        if (entry.heading.includes(token)) headingHit = true
      }
      if (matchedWeight <= 0) continue
      // Coverage: the share of the query's own weight this chunk explains, plus a small
      // bonus for repetition and heading hits. The saturating map keeps the score in 0..1
      // without flattening strong matches onto the same value, so ranking stays meaningful.
      const coverage = matchedWeight / idfTotal
      const bonus = 1 + 0.15 * Math.log(termFrequency) + (headingHit ? 0.1 : 0)
      const raw = coverage * bonus
      scored.push({ row, score: raw / (1 + raw) })
    }
    if (scored.length === 0) return []
    return scored
      .sort((left, right) => right.score - left.score || left.row - right.row)
      .slice(0, limit)
  }

  function keywordCandidates(index, text, wanted, prefix) {
    return lexicalSearch(index, text, { limit: wanted, pathPrefix: prefix })
      .filter((item) => item.score >= options.search.minScore)
      .map((item) => {
        const chunk = index.chunks[item.row]
        return {
          path: chunk.path,
          heading: chunk.heading ?? '',
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          score: round(item.score),
          snippet: snippetAround(chunk.text, text, options.search.snippetChars),
          text: chunk.text,
        }
      })
  }

  function stripText(candidate) {
    const { text: _ignored, ...rest } = candidate
    return rest
  }

  /** How many candidates to pull before reranking. */
  function poolSize(wanted) {
    return reranker.enabled ? Math.max(wanted, reranker.candidates) : wanted
  }

  async function finishCandidates(candidates, { text, wanted, baseMode, extra = {}, signal }) {
    const plain = () => ({
      mode: baseMode,
      query: text,
      ...extra,
      results: candidates.slice(0, wanted).map(stripText),
    })
    if (!reranker.enabled || candidates.length === 0) return plain()
    try {
      const order = await reranker.rerankDocuments(
        text,
        candidates.map((candidate) => candidate.text),
        { topN: wanted, signal },
      )
      const results = []
      for (const row of order) {
        const candidate = candidates[row.index]
        if (!candidate) continue
        results.push({ ...stripText(candidate), score: round(row.score), scoreBefore: candidate.score })
      }
      return {
        mode: `${baseMode}+rerank`,
        query: text,
        ...extra,
        rerankModel: reranker.model,
        results,
      }
    } catch (error) {
      return {
        ...plain(),
        note: `重排未生效，已按${baseMode === 'semantic' ? '向量' : '关键词'}顺序返回：${error?.message ?? error}`,
      }
    }
  }

  async function search({ query, limit, pathPrefix = '', mode = 'auto', rerank, signal } = {}) {
    assertReady()
    const text = String(query ?? '').trim()
    if (text === '') throw new Error('query 不能为空')
    const wanted = Math.min(30, Math.max(1, Number(limit) || options.search.topK))
    const prefix = String(pathPrefix ?? '').trim()
    const pool = poolSize(wanted)
    const rerankAllowed = rerank !== false

    await ensureFresh({ signal })
    const index = state.index
    if (!index || index.chunks.length === 0) {
      return {
        mode: 'empty',
        query: text,
        note: '知识库索引为空：目录里没有可索引的文本文件，或索引还没建立。可调用 kb_index（action=rebuild）查看原因。',
        results: [],
      }
    }

    const semanticReady = index.dim > 0 && embedder.enabled
    if (mode !== 'keyword' && semanticReady) {
      try {
        const [queryVector] = await embedder.embed([text], signal)
        if (!queryVector || queryVector.length !== index.dim) {
          throw new EmbeddingError(`查询向量维度不一致（${queryVector?.length ?? 0} != ${index.dim}）`)
        }
        const scored = []
        for (let row = 0; row < index.chunks.length; row += 1) {
          const chunk = index.chunks[row]
          if (prefix && !chunk.path.toLowerCase().startsWith(prefix.toLowerCase())) continue
          let dot = 0
          const base = row * index.dim
          for (let column = 0; column < index.dim; column += 1) {
            dot += index.vectors[base + column] * queryVector[column]
          }
          scored.push({ row, score: dot })
        }
        const candidates = scored
          .sort((left, right) => right.score - left.score || left.row - right.row)
          .slice(0, pool)
          .filter((item) => item.score >= options.search.minScore)
          .map((item) => {
            const chunk = index.chunks[item.row]
            return {
              path: chunk.path,
              heading: chunk.heading ?? '',
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              score: round(item.score),
              snippet: snippetAround(chunk.text, text, options.search.snippetChars),
              text: chunk.text,
            }
          })
        if (rerankAllowed) {
          return await finishCandidates(candidates, {
            text,
            wanted,
            baseMode: 'semantic',
            extra: { model: embedder.model, total: index.chunks.length },
            signal,
          })
        }
        return {
          mode: 'semantic',
          query: text,
          model: embedder.model,
          total: index.chunks.length,
          results: candidates.slice(0, wanted).map(stripText),
        }
      } catch (error) {
        if (mode === 'semantic') throw error
        const fallback = keywordCandidates(index, text, pool, prefix)
        if (rerankAllowed) {
          return await finishCandidates(fallback, {
            text,
            wanted,
            baseMode: 'keyword',
            extra: { total: index.chunks.length, note: `向量检索不可用，已退回关键词检索：${error?.message ?? error}` },
            signal,
          })
        }
        return {
          mode: 'keyword',
          query: text,
          total: index.chunks.length,
          note: `向量检索不可用，已退回关键词检索：${error?.message ?? error}`,
          results: fallback.slice(0, wanted).map(stripText),
        }
      }
    }

    const keywordNote = !embedder.enabled
      ? '未启用向量检索（embedding.provider = none），本次用关键词检索。'
      : !semanticReady
        ? '索引里没有向量（embedding 未成功），本次用关键词检索。'
        : ''
    const candidates = keywordCandidates(index, text, pool, prefix)
    if (rerankAllowed) {
      return await finishCandidates(candidates, {
        text,
        wanted,
        baseMode: 'keyword',
        extra: { total: index.chunks.length, note: keywordNote },
        signal,
      })
    }
    return {
      mode: 'keyword',
      query: text,
      total: index.chunks.length,
      note: keywordNote,
      results: candidates.slice(0, wanted).map(stripText),
    }
  }

  async function readDocument({ filePath, offset = 1, limit = 200 } = {}) {
    assertReady()
    const requested = String(filePath ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
    if (requested === '') throw new Error('path 不能为空（相对知识库根目录的路径）')
    const rootResolved = path.resolve(options.root)
    const absolute = path.resolve(rootResolved, requested)
    if (absolute !== rootResolved && !absolute.startsWith(`${rootResolved}${path.sep}`)) {
      throw new Error(`只能读取知识库目录内的文件：${requested}`)
    }
    const info = await stat(absolute).catch(() => null)
    if (!info?.isFile()) throw new Error(`文件不存在：${requested}`)
    if (info.size > options.maxFileBytes) throw new Error(`文件超过 maxFileBytes：${requested}`)
    const extension = path.extname(requested).toLowerCase()
    const text = (
      await readSourceText(absolute, extension, options.maxFileBytes, {
        ocrText: ocrOptions?.enabled
          ? (target) => ocrText(target, requested, info, undefined)
          : undefined,
      })
    )
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
    const lines = text.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const start = Math.min(lines.length, Math.max(1, Number(offset) || 1))
    const count = Math.min(2000, Math.max(1, Number(limit) || 200))
    const slice = lines.slice(start - 1, start - 1 + count)
    return {
      path: requested,
      totalLines: lines.length,
      offset: start,
      limit: count,
      truncated: start - 1 + slice.length < lines.length,
      text: slice.join('\n'),
    }
  }

  async function status() {
    assertReady()
    const index = await loadIndex()
    if (!index) {
      return {
        configured: true,
        root: options.root,
        indexDir: options.indexDir,
        indexed: false,
        embedding: {
          enabled: embedder.enabled,
          provider: embedder.provider,
          model: embedder.model,
          baseUrl: options.embedding.baseUrl,
          dim: 0,
        },
        note: '还没有索引文件：首次 kb_search 会自动建立，或调用 kb_index（action=rebuild）。',
      }
    }
    let stale = { stale: true, reason: '' }
    try {
      stale = await checkStale()
    } catch (error) {
      stale = { stale: true, reason: String(error?.message ?? error) }
    }
    return {
      configured: true,
      name: options.name,
      root: options.root,
      indexDir: options.indexDir,
      indexed: true,
      builtAt: index.meta.builtAt,
      durationMs: index.meta.durationMs,
      mode: index.dim > 0 ? 'semantic' : 'keyword',
      effective: {
        extensions: options.extensions,
        excludeCount: options.exclude.length,
        chunkSize: options.chunkSize,
        chunkOverlap: options.chunkOverlap,
        maxFileBytes: options.maxFileBytes,
        maxFiles: options.maxFiles,
        autoBuild: options.autoBuild,
        promptSection: options.promptSection,
        topK: options.search.topK,
        minScore: options.search.minScore,
      },
      embedding: {
        enabled: embedder.enabled,
        provider: embedder.provider,
        model: embedder.model,
        baseUrl: options.embedding.baseUrl,
        dim: index.dim,
        indexedWith: index.meta.embedding?.model,
        indexedWithProvider: index.meta.embedding?.provider,
      },
      embeddingError: index.meta.embeddingError ?? null,
      rerank: { ...reranker.describe(), topN: reranker.topN, candidates: reranker.candidates },
      ocr: {
        enabled: Boolean(ocrOptions?.enabled),
        model: ocrOptions?.model ?? '',
        baseUrl: ocrOptions?.baseUrl ?? '',
        dpi: ocrOptions?.dpi ?? 0,
        maxPages: ocrOptions?.maxPages ?? 0,
        files: index.meta.ocr?.files ?? 0,
        pages: index.meta.ocr?.pages ?? 0,
      },
      files: index.meta.fileCount ?? 0,
      chunks: index.chunks.length,
      stale: stale.stale,
      staleReason: stale.reason,
      lastErrors: index.meta.errors ?? [],
      lastSkipped: index.meta.skipped ?? [],
      lastUnsupported: index.meta.unsupported ?? [],
      indexFiles: store.paths,
    }
  }

  async function probe({ signal } = {}) {
    assertReady()
    if (!embedder.enabled) {
      throw new Error('当前未启用向量检索（embedding.provider = none）：先把 provider 改成 openai 或 ollama。')
    }
    const started = Date.now()
    const [vector] = await embedder.embed(['本地知识库向量连通性测试'], signal)
    return {
      provider: embedder.provider,
      model: embedder.model,
      baseUrl: options.embedding.baseUrl,
      dim: vector.length,
      ms: Date.now() - started,
      indexed: state.index?.chunks.length ?? 0,
      indexedDim: state.index?.dim ?? 0,
    }
  }

  async function probeRerank({ signal } = {}) {
    if (!reranker.enabled) {
      throw new Error('重排未启用：先把 rerank.enabled 打开，并填好 baseUrl 与 model。')
    }
    const info = await reranker.probe({ signal })
    return { ...info, indexed: state.index?.chunks.length ?? 0 }
  }

  /** OCR 探活：把 root 里第一个 PDF 的第 1 页渲染 + 识别一次，返回字数与耗时。 */
  async function probeOcr({ signal, ocr, resolveKey } = {}) {
    assertReady()
    const settings = ocr ?? ocrOptions
    if (!settings?.enabled) {
      throw new Error('扫描件 OCR 未启用：先打开 ocr.enabled 并配好视觉模型的地址与模型名。')
    }
    const { files } = await scanFiles(options.root, options, signal)
    const target = [...files.keys()].find((relative) => relative.toLowerCase().endsWith('.pdf'))
    if (!target) throw new Error('知识库目录里没有 PDF 文件，无法测试 OCR')
    const absolute = path.join(options.root, ...target.split('/'))
    const info = files.get(target)
    const started = Date.now()
    const single = { ...settings, maxPages: 1 }
    const result = await ocrPdf({
      pdfPath: absolute,
      relativePath: `${target}#probe`,
      size: info?.size ?? 0,
      mtimeMs: 0,
      options: single,
      cacheDir: ocrCacheDir,
      skipCache: true,
      resolveKey:
        resolveKey ??
        (secrets ? () => secrets.read('ocr', settings) : undefined),
      signal,
    })
    return {
      ok: true,
      sample: target,
      pages: result.pages,
      chars: result.text.length,
      preview: result.text.slice(0, 160),
      model: result.model,
      ms: Date.now() - started,
    }
  }

  async function listDocuments() {
    assertReady()
    const index = await loadIndex()
    if (!index) {
      return { name: options.name, root: options.root, builtAt: null, stale: true, staleReason: '尚未建立索引', files: [] }
    }
    let stale = { stale: false, reason: '' }
    try {
      stale = await checkStale()
    } catch (error) {
      stale = { stale: true, reason: String(error?.message ?? error) }
    }
    return {
      name: index.meta.name ?? options.name,
      root: options.root,
      builtAt: index.meta.builtAt ?? null,
      durationMs: index.meta.durationMs ?? 0,
      mode: index.dim > 0 ? 'semantic' : 'keyword',
      stale: stale.stale,
      staleReason: stale.reason,
      files: (index.meta.files ?? []).map((file) => ({
        path: file.path,
        size: file.size,
        mtimeMs: file.mtimeMs,
        chunks: file.chunkCount ?? 0,
      })),
    }
  }

  return {
    options,
    search,
    readDocument,
    listDocuments,
    status,
    rebuild,
    ensureFresh,
    assertReady,
    probe,
    probeRerank,
    probeOcr,
    describeEmbedder: () => embedder.describe(),
    describeRerank: () => ({ ...reranker.describe(), topN: reranker.topN, candidates: reranker.candidates }),
    describeOcr: () => ({
      enabled: Boolean(ocrOptions?.enabled),
      model: ocrOptions?.model ?? '',
      baseUrl: ocrOptions?.baseUrl ?? '',
      dpi: ocrOptions?.dpi ?? 0,
      maxPages: ocrOptions?.maxPages ?? 0,
    }),
  }
}
