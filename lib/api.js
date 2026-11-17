import { normalizeConfig } from './config.js'
import { createEmbedder } from './embed.js'
import { createReranker } from './rerank.js'

/**
 * HTTP surface used by the sidebar UI (`/api/local-kb/*`).
 *
 * `webServer`'s `resource` routes are GET-only in practice (a POST gets 405),
 * so this registers a plain `handler(req, res)` route: the transport adapter is
 * tiny and the whole logic lives in `invoke()`, which the tests call directly.
 */

export const PREFIX = '/api/local-kb'
const MAX_BODY_BYTES = 1024 * 1024

export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers?.host
  if (typeof host !== 'string') return false
  let url
  try {
    url = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === url.host
  } catch {
    return false
  }
}

function responseHeaders() {
  return {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, responseHeaders())
  res.end(JSON.stringify(body))
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

function pick(source, keys) {
  const out = {}
  if (!source || typeof source !== 'object') return out
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key]
  }
  return out
}

const EMBEDDING_FIELDS = ['provider', 'baseUrl', 'model', 'apiKeyEnv', 'batchSize', 'timeoutMs']
const RERANK_FIELDS = ['enabled', 'provider', 'baseUrl', 'model', 'apiKeyEnv', 'topN', 'candidates', 'timeoutMs']
const OCR_FIELDS = ['enabled', 'baseUrl', 'model', 'apiKeyEnv', 'dpi', 'maxPages', 'concurrency', 'timeoutMs', 'mutoolPath']

/** Merge a UI patch onto the running options and re-normalize. */
export function mergeConfig(options, patch) {
  const merged = {
    name: options.name,
    root: options.root,
    indexDir: options.indexDir,
    extensions: options.extensions,
    exclude: options.exclude,
    chunkSize: options.chunkSize,
    chunkOverlap: options.chunkOverlap,
    maxFileBytes: options.maxFileBytes,
    maxFiles: options.maxFiles,
    promptSection: options.promptSection,
    autoBuild: options.autoBuild,
    search: { ...options.search },
    embedding: { ...options.embedding },
    rerank: { ...options.rerank },
    ocr: { ...options.ocr },
  }
  if (typeof patch.name === 'string') merged.name = patch.name.trim()
  if (typeof patch.root === 'string') {
    const root = patch.root.trim()
    // A new root gets a new default index dir unless the caller pinned one.
    const oldDefault = options.root ? `${options.root.replace(/[\\/]+$/, '')}\\.dsh-kb` : ''
    if (root !== options.root && options.indexDir === oldDefault) merged.indexDir = ''
    merged.root = root
  }
  Object.assign(merged.embedding, pick(patch.embedding, EMBEDDING_FIELDS))
  Object.assign(merged.rerank, pick(patch.rerank, RERANK_FIELDS))
  Object.assign(merged.ocr, pick(patch.ocr, OCR_FIELDS))
  return normalizeConfig(merged)
}

export function configView(options) {
  return {
    name: options.name,
    root: options.root,
    indexDir: options.indexDir,
    extensions: options.extensions,
    chunkSize: options.chunkSize,
    chunkOverlap: options.chunkOverlap,
    autoBuild: options.autoBuild,
    promptSection: options.promptSection,
    topK: options.search.topK,
    minScore: options.search.minScore,
    snippetChars: options.search.snippetChars,
    embedding: {
      provider: options.embedding.provider,
      baseUrl: options.embedding.baseUrl,
      model: options.embedding.model,
      apiKeyEnv: options.embedding.apiKeyEnv,
      batchSize: options.embedding.batchSize,
      timeoutMs: options.embedding.timeoutMs,
    },
    rerank: {
      enabled: options.rerank.enabled,
      provider: options.rerank.provider,
      baseUrl: options.rerank.baseUrl,
      model: options.rerank.model,
      apiKeyEnv: options.rerank.apiKeyEnv,
      topN: options.rerank.topN,
      candidates: options.rerank.candidates,
      timeoutMs: options.rerank.timeoutMs,
    },
    ocr: {
      enabled: options.ocr.enabled,
      baseUrl: options.ocr.baseUrl,
      model: options.ocr.model,
      apiKeyEnv: options.ocr.apiKeyEnv,
      dpi: options.ocr.dpi,
      maxPages: options.ocr.maxPages,
      concurrency: options.ocr.concurrency,
      timeoutMs: options.ocr.timeoutMs,
      mutoolPath: options.ocr.mutoolPath,
    },
  }
}

export function createApi({ ctx, kb, secrets, options, settings }) {
  // A failed save happens after the response was already sent, so remember it
  // and let the next /state poll tell the page the truth.
  let saveError = null

  function logger() {
    return ctx.get('logger') ?? null
  }

  async function stateBody() {
    let status
    try {
      status = await kb.status()
    } catch (error) {
      status = { configured: false, root: options.root, error: String(error?.message ?? error) }
    }
    return {
      ok: true,
      configured: status.configured !== false,
      saveError,
      status,
      config: configView(options),
      keys: {
        embedding: await secrets.describe('embedding', options.embedding),
        rerank: await secrets.describe('rerank', options.rerank),
        ocr: await secrets.describe('ocr', options.ocr),
      },
      capabilities: {
        secrets: secrets.available,
        configEditor: settings.available(),
        rerank: kb.describeRerank().enabled,
        semantic: kb.describeEmbedder().enabled,
        ocr: kb.describeOcr().enabled,
      },
    }
  }

  function probeOptions(body) {
    const patch = body?.config && typeof body.config === 'object' ? body.config : {}
    return mergeConfig(options, patch)
  }

  function keyOverride(body, slot) {
    const value = body?.keys?.[slot]
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  /** Test the endpoints typed in the settings form, not just the saved ones. */
  async function probeEmbedding(body) {
    const next = probeOptions(body)
    if (next.embedding.provider === 'none') {
      return { ok: false, error: '当前未启用向量检索（embedding.provider = none）：先把服务类型改成 openai 或 ollama。' }
    }
    const provided = keyOverride(body, 'embedding')
    const embedder = createEmbedder(next.embedding, {
      resolveKey: async () => provided ?? (await secrets.read('embedding', next.embedding)),
    })
    const started = Date.now()
    try {
      const [vector] = await embedder.embed(['本地知识库向量连通性测试'])
      let indexed = 0
      let indexedDim = 0
      try {
        const current = await kb.status()
        indexed = current.chunks ?? 0
        indexedDim = current.embedding?.dim ?? 0
      } catch {
        // No index yet: the probe result is still meaningful.
      }
      return {
        ok: true,
        provider: embedder.provider,
        model: embedder.model,
        baseUrl: next.embedding.baseUrl,
        dim: vector.length,
        ms: Date.now() - started,
        indexed,
        indexedDim,
        tested: provided === undefined ? 'saved' : 'form',
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  async function probeRerankWith(body) {
    const next = probeOptions(body)
    const provided = keyOverride(body, 'rerank')
    const reranker = createReranker(next.rerank, {
      resolveKey: async () => provided ?? (await secrets.read('rerank', next.rerank)),
    })
    if (!reranker.enabled) {
      return { ok: false, error: '重排未启用：先填 baseUrl 与 model，并打开「启用重排」。' }
    }
    try {
      const info = await reranker.probe()
      return { ok: true, ...info, tested: provided === undefined ? 'saved' : 'form' }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  async function probeOcrWith(body) {
    const next = probeOptions(body)
    if (!next.ocr.enabled) {
      return { ok: false, error: '扫描件 OCR 未启用：先打开「扫描件 OCR」并填好视觉模型的地址与模型名。' }
    }
    const provided = keyOverride(body, 'ocr')
    try {
      const result = await kb.probeOcr({
        ocr: next.ocr,
        resolveKey: async () => provided ?? (await secrets.read('ocr', next.ocr)),
      })
      return { ...result, tested: provided === undefined ? 'saved' : 'form' }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  async function searchBody(body) {
    const result = await kb.search({
      query: body.query,
      limit: body.limit,
      pathPrefix: body.pathPrefix,
      mode: body.mode,
      rerank: body.rerank,
    })
    return { ok: true, ...result }
  }

  async function indexBody(body) {
    const action = String(body.action ?? 'status')
    if (action === 'rebuild') {
      return { ok: true, action, ...(await kb.rebuild({ force: Boolean(body.force) })) }
    }
    if (action === 'probe') {
      if (body.config || body.keys) return { ok: true, action, ...(await probeEmbedding(body)) }
      try {
        return { ok: true, action, ...(await kb.probe()) }
      } catch (error) {
        return { ok: false, action, error: String(error?.message ?? error) }
      }
    }
    if (action === 'probe-rerank') {
      if (body.config || body.keys) return { ok: true, action, ...(await probeRerankWith(body)) }
      try {
        return { ok: true, action, ...(await kb.probeRerank()) }
      } catch (error) {
        return { ok: false, action, error: String(error?.message ?? error) }
      }
    }
    if (action === 'probe-ocr') {
      if (body.config || body.keys) return { ok: true, action, ...(await probeOcrWith(body)) }
      try {
        return { ok: true, action, ...(await kb.probeOcr()) }
      } catch (error) {
        return { ok: false, action, error: String(error?.message ?? error) }
      }
    }
    if (action === 'status') {
      return { ok: true, action, status: await kb.status() }
    }
    return { ok: false, error: `未知的索引操作：${action}` }
  }

  async function readBodyRequest(body) {
    const result = await kb.readDocument({
      filePath: body.path,
      offset: Number(body.offset) || 1,
      limit: Number(body.limit) || 400,
    })
    return { ok: true, ...result }
  }

  async function docsBody() {
    if (!options.root) {
      return { ok: true, configured: false, root: '', files: [], stale: true, staleReason: '尚未配置知识库目录' }
    }
    return { ok: true, configured: true, ...(await kb.listDocuments()) }
  }

  async function settingsBody(body) {
    const patch = body.config && typeof body.config === 'object' ? body.config : body
    const next = mergeConfig(options, patch)
    if (next.root === '') {
      return { ok: false, error: '知识库目录不能为空：请在设置里填写文件夹的绝对路径。' }
    }

    const keys = body.keys && typeof body.keys === 'object' ? body.keys : {}
    const saved = {}
    if (typeof keys.embedding === 'string' || keys.embedding === null) {
      saved.embedding = await secrets.save('embedding', String(keys.embedding ?? ''))
      next.embedding.secretName = saved.embedding
    }
    if (typeof keys.rerank === 'string' || keys.rerank === null) {
      saved.rerank = await secrets.save('rerank', String(keys.rerank ?? ''))
      next.rerank.secretName = saved.rerank
    }
    if (typeof keys.ocr === 'string' || keys.ocr === null) {
      saved.ocr = await secrets.save('ocr', String(keys.ocr ?? ''))
      next.ocr.secretName = saved.ocr
    }

    if (!settings.available()) {
      return {
        ok: false,
        error: '当前宿主没有配置编辑服务（configEditor），无法保存：请直接编辑 profile 的 cordis.patch.yml。',
      }
    }

    // Answer first: saving reloads this plugin and tears the route down.
    saveError = null
    const keyed = Object.keys(saved).length > 0
    setTimeout(() => {
      settings.save(next).catch((error) => {
        const message = String(error?.message ?? error)
        saveError = keyed
          ? `${message}（密钥已写入凭据库，其余设置没有保存）`
          : message
        const log = logger()
        log?.warn?.(`[local-kb] 保存设置失败：${message}`)
      })
    }, 50)

    return {
      ok: true,
      saved: true,
      restarting: true,
      applied: {
        name: next.name,
        root: next.root,
        embedding: { provider: next.embedding.provider, model: next.embedding.model },
        rerank: { enabled: next.rerank.enabled, model: next.rerank.model },
        ocr: { enabled: next.ocr.enabled, model: next.ocr.model },
      },
      keys: { embedding: saved.embedding ?? null, rerank: saved.rerank ?? null, ocr: saved.ocr ?? null },
      note: '设置已写入 profile 配置，插件正在重启；页面会在大约 2 秒后自动恢复。',
    }
  }

  /** Transport-agnostic request handling: `{status, body}`. */
  async function invoke({ method = 'GET', pathname = '/', body = {} }) {
    try {
      const route = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length).replace(/\/+$/, '') : pathname
      const verb = String(method).toUpperCase()
      if (verb === 'GET' && (route === '' || route === '/state')) return { status: 200, body: await stateBody() }
      if (verb === 'GET' && (route === '/docs' || route === '/documents')) {
        return { status: 200, body: await docsBody() }
      }
      if (verb === 'POST' && route === '/search') return { status: 200, body: await searchBody(body) }
      if (verb === 'POST' && route === '/index') {
        const result = await indexBody(body)
        return { status: result.ok ? 200 : 400, body: result }
      }
      if (verb === 'POST' && route === '/read') return { status: 200, body: await readBodyRequest(body) }
      if (verb === 'POST' && route === '/settings') {
        const result = await settingsBody(body)
        return { status: result.ok ? 200 : 400, body: result }
      }
      return { status: 404, body: { ok: false, error: `未知路由：${verb} ${pathname}` } }
    } catch (error) {
      const status = Number(error?.status) || 500
      return { status, body: { ok: false, error: String(error?.message ?? error) } }
    }
  }

  function route() {
    return {
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: '仅允许本机回环请求访问本地知识库。' })
          return
        }
        const method = String(req.method ?? 'GET').toUpperCase()
        const url = new URL(req.url ?? '/', 'http://localhost')
        let body = {}
        if (method === 'POST') {
          const parsed = await readJsonBody(req)
          if (parsed === undefined) {
            writeJson(res, 400, { ok: false, error: '请求体不是合法 JSON，或超过 1MB 上限。' })
            return
          }
          body = parsed
        }
        const result = await invoke({ method, pathname: url.pathname, body })
        writeJson(res, result.status, result.body)
      },
    }
  }

  return { invoke, route }
}
