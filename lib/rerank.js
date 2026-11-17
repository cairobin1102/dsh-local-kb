/**
 * Reranking over a Cohere / Jina style endpoint.
 *
 *   POST {baseUrl}/rerank
 *   { model, query, documents: [string], top_n }
 *   → { results: [{ index, relevance_score }] }
 *
 * Endpoints that already end in `/rerank` are used as-is, so a full URL copied
 * from a provider console works too.
 */

export class RerankError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'RerankError'
    this.status = details.status
  }
}

function trimBaseUrl(baseUrl) {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '')
}

function endpoint(baseUrl) {
  const base = trimBaseUrl(baseUrl)
  return /\/rerank$/i.test(base) ? base : `${base}/rerank`
}

function pickScore(item) {
  if (typeof item?.relevance_score === 'number') return item.relevance_score
  if (typeof item?.score === 'number') return item.score
  return null
}

export function createReranker(rerank = {}, { resolveKey } = {}) {
  const baseUrl = trimBaseUrl(rerank.baseUrl)
  const model = String(rerank.model ?? '').trim()
  const enabled = Boolean(rerank.enabled) && baseUrl !== '' && model !== ''
  const timeoutMs = Number.isFinite(Number(rerank.timeoutMs))
    ? Math.min(600000, Math.max(1000, Math.trunc(Number(rerank.timeoutMs))))
    : 30000
  const candidates = Number.isFinite(Number(rerank.candidates))
    ? Math.min(100, Math.max(1, Math.trunc(Number(rerank.candidates))))
    : 24
  const topN = Number.isFinite(Number(rerank.topN))
    ? Math.min(30, Math.max(1, Math.trunc(Number(rerank.topN))))
    : 6

  async function requestKey() {
    if (typeof resolveKey !== 'function') return typeof rerank.apiKey === 'string' ? rerank.apiKey : ''
    try {
      return String((await resolveKey()) ?? '')
    } catch {
      return ''
    }
  }

  async function post(body, signal) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
    const forwardAbort = () => controller.abort(new Error('已取消'))
    if (signal) {
      if (signal.aborted) throw new RerankError('请求已取消')
      signal.addEventListener('abort', forwardAbort, { once: true })
    }
    const url = endpoint(baseUrl)
    try {
      const key = await requestKey()
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const raw = await response.text()
      if (!response.ok) {
        throw new RerankError(`${url} 返回 HTTP ${response.status}：${raw.slice(0, 300)}`, {
          status: response.status,
        })
      }
      try {
        return JSON.parse(raw)
      } catch {
        throw new RerankError(`${url} 返回的不是 JSON：${raw.slice(0, 200)}`)
      }
    } catch (error) {
      if (error instanceof RerankError) throw error
      throw new RerankError(`无法连接 ${url}：${error?.message ?? error}`)
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', forwardAbort)
    }
  }

  /**
   * Reorder `documents` by relevance to `query`.
   * Returns [{ index, score }] best first, at most `topN` rows.
   */
  async function rerankDocuments(query, documents, { topN: wanted, signal } = {}) {
    if (!enabled) throw new RerankError('重排未启用（rerank.enabled = false）')
    const texts = Array.isArray(documents) ? documents.map((item) => String(item ?? '')) : []
    if (texts.length === 0) return []
    const limit = Number.isFinite(Number(wanted)) ? Math.trunc(Number(wanted)) : topN
    const data = await post(
      { model, query: String(query ?? ''), documents: texts, top_n: Math.max(1, limit) },
      signal,
    )
    const rows = data?.results
    if (!Array.isArray(rows)) {
      throw new RerankError(`${endpoint(baseUrl)} 返回的结构无法识别（缺少 results 字段）`)
    }
    const parsed = []
    for (const row of rows) {
      const index = Number(row?.index)
      const score = pickScore(row)
      if (!Number.isInteger(index) || index < 0 || index >= texts.length || score === null) continue
      parsed.push({ index, score })
    }
    parsed.sort((left, right) => right.score - left.score || left.index - right.index)
    return parsed.slice(0, Math.max(1, limit))
  }

  async function probe({ signal } = {}) {
    if (!enabled) throw new RerankError('重排未启用：先填 baseUrl 与 model，并打开 enabled。')
    const started = Date.now()
    const rows = await rerankDocuments(
      '知识库连通性测试',
      ['这是一段用于测试重排接口的文本。', '今天天气不错。', '重排模型需要返回每个文档的相关度分数。'],
      { topN: 3, signal },
    )
    return {
      model,
      baseUrl,
      ms: Date.now() - started,
      rows: rows.map((row) => ({ index: row.index, score: Math.round(row.score * 10000) / 10000 })),
    }
  }

  return {
    enabled,
    model,
    baseUrl,
    candidates,
    topN,
    rerankDocuments,
    probe,
    describe: () => ({ enabled, provider: rerank.provider ?? 'cohere', model, baseUrl }),
  }
}
