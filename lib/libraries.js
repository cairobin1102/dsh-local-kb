import { createEmbedder } from './embed.js'
import { createKnowledgeBase } from './kb.js'
import { createReranker } from './rerank.js'

/**
 * Multi-folder layer: one `KnowledgeBase` per configured library, each with its
 * own root, index directory and vectors. The aggregator keeps the same method
 * surface the single-library engine had, plus an optional `library` argument
 * (`'all'` = every library).
 */

function normalizeId(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function createLibraries(options, hooks = {}) {
  const entries = new Map()

  function register(library) {
    const existing = entries.get(library.id)
    if (existing !== undefined) return existing.kb
    const kb = createKnowledgeBase(
      {
        ...options,
        name: library.name,
        root: library.root,
        indexDir: library.indexDir,
        libraries: undefined,
      },
      hooks,
    )
    entries.set(library.id, { library, kb })
    return kb
  }

  for (const library of options.libraries ?? []) register(library)

  function list() {
    return [...entries.values()].map(({ library }) => ({ ...library }))
  }

  function resolve(selector) {
    const key = normalizeId(selector)
    if (key !== '' && key !== 'all') {
      const byId = entries.get(key)
      if (byId !== undefined) return byId
      // Callers often only know the display name (the panel and the tools show
      // it), so a unique name or root is accepted as well.
      const lower = key.toLowerCase()
      const matched = list().filter(
        (library) => library.name.toLowerCase() === lower || library.root.toLowerCase() === lower,
      )
      if (matched.length === 1) return entries.get(matched[0].id)
      if (matched.length > 1) {
        throw new Error(
          `有 ${matched.length} 个知识库都叫「${key}」：${matched.map((library) => library.id).join('、')}。请改用库 id 指定。`,
        )
      }
      const known = list().map((library) => `${library.id}（${library.name}）`).join('、')
      throw new Error(`没有这个知识库：${key}。可用的知识库：${known || '（尚未配置）'}`)
    }
    const all = [...entries.values()]
    if (all.length === 0) {
      throw new Error('尚未配置知识库目录：请先在设置里添加一个本地文件夹。')
    }
    return all
  }

  function targets(selector) {
    const resolved = resolve(selector)
    return Array.isArray(resolved) ? resolved : [resolved]
  }

  function primary(selector) {
    return targets(selector)[0]
  }

  function mergedMode(modes) {
    const base = modes.some((mode) => String(mode).includes('semantic')) ? 'semantic' : 'keyword'
    return modes.some((mode) => String(mode).includes('rerank')) ? `${base}+rerank` : base
  }

  async function search({ library, query, limit, pathPrefix, mode, rerank, signal } = {}) {
    const list_ = targets(library)
    const wanted = Number.isInteger(limit) && limit > 0 ? limit : options.search.topK
    // Each library contributes its own candidate pool, so a merged search still
    // has enough material for the reranker to reorder across folders.
    const perLibrary = list_.length === 1 ? wanted : Math.max(wanted, Math.min(40, wanted * 2))
    const settled = await Promise.all(
      list_.map(async (entry) => {
        try {
          const result = await entry.kb.search({ query, limit: perLibrary, pathPrefix, mode, rerank, signal })
          return { entry, result }
        } catch (error) {
          return { entry, error }
        }
      }),
    )

    const items = []
    const notes = []
    const modes = []
    let total = 0
    let searched = 0
    for (const outcome of settled) {
      const { entry } = outcome
      if (outcome.error !== undefined) {
        notes.push(`${entry.library.name}：检索失败（${String(outcome.error?.message ?? outcome.error)}）`)
        continue
      }
      searched += 1
      const result = outcome.result
      total += result.total ?? 0
      modes.push(result.mode)
      if (result.note && list_.length > 1) notes.push(`${entry.library.name}：${result.note}`)
      else if (result.note && notes.length === 0) notes.push(result.note)
      for (const item of result.results ?? []) {
        items.push({ ...item, library: { id: entry.library.id, name: entry.library.name } })
      }
    }

    if (searched === 0 && notes.length > 0) {
      throw new Error(notes.join('；'))
    }
    items.sort((left, right) => Number(right.score) - Number(left.score))
    return {
      query,
      mode: modes.length === 0 ? 'empty' : mergedMode(modes),
      model: settled.find((outcome) => outcome.result?.model)?.result?.model ?? '',
      rerankModel: settled.find((outcome) => outcome.result?.rerankModel)?.result?.rerankModel ?? '',
      results: items.slice(0, wanted),
      total,
      libraries: list_.map((entry) => ({ id: entry.library.id, name: entry.library.name })),
      note: notes.length > 0 ? notes.join('；') : undefined,
    }
  }

  async function locate(filePath) {
    const wanted = String(filePath ?? '').replace(/\\/g, '/')
    const hits = []
    for (const entry of entries.values()) {
      try {
        const documents = await entry.kb.listDocuments()
        if ((documents.files ?? []).some((file) => String(file.path).replace(/\\/g, '/') === wanted)) {
          hits.push(entry)
        }
      } catch {
        // An unindexed library simply is not a match for this lookup.
      }
    }
    return hits
  }

  async function readDocument({ library, filePath, offset, limit } = {}) {
    const chosen = normalizeId(library) !== ''
    if (chosen) {
      const entry = primary(library)
      const result = await entry.kb.readDocument({ filePath, offset, limit })
      return { ...result, library: { id: entry.library.id, name: entry.library.name } }
    }
    const hits = await locate(filePath)
    if (hits.length > 1) {
      throw new Error(
        `多个知识库都有这个文件：${hits.map((entry) => `${entry.library.name}（${entry.library.id}）`).join('、')}。请用 library 指定一个，或先在 kb_search 结果里点开对应的那一条。`,
      )
    }
    const entry = hits[0] ?? primary(undefined)
    const result = await entry.kb.readDocument({ filePath, offset, limit })
    return { ...result, library: { id: entry.library.id, name: entry.library.name } }
  }

  async function status({ library } = {}) {
    const all = list()
    if (normalizeId(library) !== '') {
      const entry = primary(library)
      return { ...(await entry.kb.status()), library: entry.library }
    }
    if (all.length === 0) {
      return { configured: false, libraries: [], files: 0, chunks: 0, mode: 'empty' }
    }
    const libraries = []
    let files = 0
    let chunks = 0
    let dim = 0
    const modes = []
    for (const entry of entries.values()) {
      let entryStatus
      try {
        entryStatus = await entry.kb.status()
      } catch (error) {
        entryStatus = { configured: true, error: String(error?.message ?? error), indexed: false, files: 0, chunks: 0 }
      }
      libraries.push({ id: entry.library.id, name: entry.library.name, root: entry.library.root, ...entryStatus })
      files += entryStatus.files ?? 0
      chunks += entryStatus.chunks ?? 0
      dim = Math.max(dim, entryStatus.embedding?.dim ?? 0)
      modes.push(entryStatus.mode ?? 'empty')
    }
    const head = libraries[0] ?? {}
    return {
      ...head,
      configured: libraries.some((entry) => entry.configured !== false && entry.indexed !== false),
      libraries,
      files,
      chunks,
      mode: mergedMode(modes),
      embedding: { ...(head.embedding ?? {}), dim },
    }
  }

  async function listDocuments({ library } = {}) {
    const all = list()
    if (normalizeId(library) !== '') {
      const entry = primary(library)
      return { ...(await entry.kb.listDocuments()), library: entry.library }
    }
    if (all.length === 0) {
      return { configured: false, libraries: [], files: [] }
    }
    const libraries = []
    const files = []
    for (const entry of entries.values()) {
      let listing
      try {
        listing = await entry.kb.listDocuments()
      } catch (error) {
        listing = { configured: true, files: [], error: String(error?.message ?? error) }
      }
      libraries.push({
        id: entry.library.id,
        name: entry.library.name,
        root: entry.library.root,
        files: listing.files?.length ?? 0,
        stale: listing.stale,
        staleReason: listing.staleReason,
        error: listing.error,
      })
      for (const file of listing.files ?? []) {
        files.push({ ...file, library: { id: entry.library.id, name: entry.library.name } })
      }
    }
    files.sort((left, right) => String(left.path).localeCompare(String(right.path), 'zh-Hans-CN'))
    return { configured: true, libraries, files }
  }

  async function rebuild({ library, force } = {}) {
    const list_ = targets(library)
    const results = []
    for (const entry of list_) {
      const summary = await entry.kb.rebuild({ force: force === true })
      results.push({ id: entry.library.id, name: entry.library.name, ...summary })
    }
    if (results.length === 1) return results[0]
    return {
      libraries: results,
      fileCount: results.reduce((sum, item) => sum + (item.fileCount ?? 0), 0),
      chunkCount: results.reduce((sum, item) => sum + (item.chunkCount ?? 0), 0),
      durationMs: results.reduce((sum, item) => sum + (item.durationMs ?? 0), 0),
      mode: mergedMode(results.map((item) => item.mode)),
    }
  }

  async function probe({ library } = {}) {
    return primary(library).kb.probe()
  }

  async function probeRerank({ library } = {}) {
    return primary(library).kb.probeRerank()
  }

  async function probeOcr({ library, ...rest } = {}) {
    return primary(library).kb.probeOcr(rest)
  }

  function describeEmbedder() {
    const resolved =
      hooks.secrets !== undefined
        ? createEmbedder(options.embedding, { resolveKey: () => hooks.secrets.read('embedding', options.embedding) })
        : createEmbedder(options.embedding)
    return { enabled: resolved.enabled, provider: resolved.provider, model: resolved.model }
  }

  function describeRerank() {
    const resolved = createReranker(options.rerank, {})
    return { enabled: resolved.enabled, model: resolved.model }
  }

  function describeOcr() {
    return {
      enabled: options.ocr.enabled && options.ocr.baseUrl !== '' && options.ocr.model !== '',
      model: options.ocr.model,
      baseUrl: options.ocr.baseUrl,
    }
  }

  return {
    list,
    search,
    readDocument,
    status,
    listDocuments,
    rebuild,
    probe,
    probeRerank,
    probeOcr,
    describeEmbedder,
    describeRerank,
    describeOcr,
  }
}
