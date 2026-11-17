export class EmbeddingError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'EmbeddingError'
    this.status = details.status
  }
}

export function normalizeVector(values) {
  if (!Array.isArray(values) || values.length === 0) return null
  let sum = 0
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    sum += value * value
  }
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm) || norm === 0) return null
  const vector = new Float32Array(values.length)
  for (let index = 0; index < values.length; index += 1) vector[index] = values[index] / norm
  return vector
}

function trimBaseUrl(baseUrl) {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '')
}

async function postJson(url, { body, headers, timeoutMs, signal }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
  const forwardAbort = () => controller.abort(new Error('已取消'))
  if (signal) {
    if (signal.aborted) throw new EmbeddingError('请求已取消')
    signal.addEventListener('abort', forwardAbort, { once: true })
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await response.text()
    if (!response.ok) {
      throw new EmbeddingError(`${url} 返回 HTTP ${response.status}：${raw.slice(0, 300)}`, {
        status: response.status,
      })
    }
    try {
      return JSON.parse(raw)
    } catch {
      throw new EmbeddingError(`${url} 返回的不是 JSON：${raw.slice(0, 200)}`)
    }
  } catch (error) {
    if (error instanceof EmbeddingError) throw error
    throw new EmbeddingError(`无法连接 ${url}：${error?.message ?? error}`)
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', forwardAbort)
  }
}

function resolveApiKey(embedding) {
  const envName = embedding.apiKeyEnv
  if (envName) {
    const fromEnv = process.env[envName]
    if (!fromEnv) {
      throw new EmbeddingError(
        `环境变量 ${envName} 未设置：请在启动 DeepSeek Harness 的环境里填写该变量，或改用 embedding.apiKey。`,
      )
    }
    return fromEnv
  }
  return embedding.apiKey || ''
}

async function ollamaEmbed(embedding, texts, signal) {
  const baseUrl = trimBaseUrl(embedding.baseUrl)
  try {
    const data = await postJson(`${baseUrl}/api/embed`, {
      body: { model: embedding.model, input: texts },
      timeoutMs: embedding.timeoutMs,
      signal,
    })
    if (Array.isArray(data?.embeddings)) return data.embeddings
    if (texts.length === 1 && Array.isArray(data?.embedding)) return [data.embedding]
    throw new EmbeddingError('Ollama /api/embed 返回的结构无法识别（缺少 embeddings 字段）')
  } catch (error) {
    // Older Ollama builds only expose the legacy single-prompt endpoint.
    if (error instanceof EmbeddingError && (error.status === 404 || error.status === 405)) {
      const vectors = []
      for (const prompt of texts) {
        const data = await postJson(`${baseUrl}/api/embeddings`, {
          body: { model: embedding.model, prompt },
          timeoutMs: embedding.timeoutMs,
          signal,
        })
        if (!Array.isArray(data?.embedding)) {
          throw new EmbeddingError('Ollama /api/embeddings 返回的结构无法识别（缺少 embedding 字段）')
        }
        vectors.push(data.embedding)
      }
      return vectors
    }
    throw error
  }
}

async function openAiEmbed(embedding, texts, signal, resolveKey) {
  const baseUrl = trimBaseUrl(embedding.baseUrl)
  const apiKey =
    typeof resolveKey === 'function' ? String((await resolveKey()) ?? '') : resolveApiKey(embedding)
  const data = await postJson(`${baseUrl}/embeddings`, {
    body: { model: embedding.model, input: texts },
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    timeoutMs: embedding.timeoutMs,
    signal,
  })
  const rows = data?.data
  if (!Array.isArray(rows)) {
    throw new EmbeddingError(`${baseUrl}/embeddings 返回的结构无法识别（缺少 data 字段）`)
  }
  const sorted = [...rows].sort((left, right) => (left?.index ?? 0) - (right?.index ?? 0))
  return sorted.map((row) => row?.embedding)
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 400

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createEmbedder(embedding, hooks = {}) {
  const enabled = embedding.provider !== 'none'
  const resolveKey = typeof hooks.resolveKey === 'function' ? hooks.resolveKey : undefined

  const describe = () => ({
    enabled,
    provider: embedding.provider,
    model: embedding.model,
    baseUrl: enabled ? trimBaseUrl(embedding.baseUrl) : '',
    key: enabled ? `${embedding.provider}:${embedding.model}` : '',
  })

  const request = (batch, signal) =>
    embedding.provider === 'openai'
      ? openAiEmbed(embedding, batch, signal, resolveKey)
      : ollamaEmbed(embedding, batch, signal)

  async function embedBatch(batch, signal, stats) {
    let attempt = 0
    for (;;) {
      try {
        const raw = await request(batch, signal)
        if (!Array.isArray(raw) || raw.length !== batch.length) {
          throw new EmbeddingError(
            `embedding 服务返回了 ${raw?.length ?? 0} 条向量，期望 ${batch.length} 条`,
          )
        }
        stats.batches += 1
        return raw
      } catch (error) {
        const status = Number(error?.status) || 0
        const retryable = RETRYABLE_STATUS.has(status)
        if (retryable && attempt + 1 < MAX_ATTEMPTS) {
          attempt += 1
          await delay(RETRY_DELAY_MS * attempt)
          continue
        }
        // 服务端拒绝整批（网关 5xx / 413）时拆半再来：慢一点，但不会让整次重建白跑。
        if (batch.length > 1 && (retryable || status === 413)) {
          stats.split += 1
          const mid = Math.ceil(batch.length / 2)
          const left = await embedBatch(batch.slice(0, mid), signal, stats)
          const right = await embedBatch(batch.slice(mid), signal, stats)
          return [...left, ...right]
        }
        throw error
      }
    }
  }

  const lastStats = { batches: 0, split: 0 }

  async function embed(texts, signal) {
    if (!enabled) throw new EmbeddingError('未启用向量检索（embedding.provider = none）')
    if (!Array.isArray(texts) || texts.length === 0) return []
    const vectors = []
    const stats = { batches: 0, split: 0 }
    for (let offset = 0; offset < texts.length; offset += embedding.batchSize) {
      const batch = texts.slice(offset, offset + embedding.batchSize)
      const raw = await embedBatch(batch, signal, stats)
      for (const item of raw) {
        const vector = normalizeVector(item)
        if (!vector) throw new EmbeddingError('embedding 服务返回了空向量或非法数值')
        vectors.push(vector)
      }
    }
    lastStats.split = stats.split
    lastStats.batches = stats.batches
    return vectors
  }

  return { ...describe(), embed, describe, lastStats: () => ({ ...lastStats }) }
}
