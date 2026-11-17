import path from 'node:path'

const DEFAULT_EXTENSIONS = [
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.rst',
  '.org',
  '.json',
  '.csv',
  '.docx',
  '.doc',
  '.wps',
  '.pdf',
]

const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.obsidian/**',
  '**/.trash/**',
  '**/.dsh-kb/**',
  '**/~$*',
]

const DEFAULTS = {
  name: '',
  root: '',
  indexDir: '',
  extensions: DEFAULT_EXTENSIONS,
  exclude: DEFAULT_EXCLUDE,
  chunkSize: 900,
  chunkOverlap: 150,
  maxFileBytes: 32 * 1024 * 1024,
  maxFiles: 20000,
  promptSection: true,
  autoBuild: true,
  search: { topK: 8, minScore: 0.2, snippetChars: 600 },
  embedding: {
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'bge-m3',
    apiKey: '',
    apiKeyEnv: '',
    secretName: '',
    batchSize: 16,
    timeoutMs: 60000,
  },
  rerank: {
    enabled: false,
    provider: 'cohere',
    baseUrl: '',
    model: '',
    apiKey: '',
    apiKeyEnv: '',
    secretName: '',
    topN: 6,
    candidates: 24,
    timeoutMs: 30000,
  },
  ocr: {
    enabled: false,
    baseUrl: '',
    model: 'Qwen/Qwen3-VL-8B-Instruct',
    apiKey: '',
    apiKeyEnv: '',
    secretName: '',
    dpi: 150,
    maxPages: 40,
    concurrency: 2,
    timeoutMs: 180000,
    mutoolPath: '',
  },
}

function oneOf(value, allowed, fallback) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return allowed.includes(text) ? text : fallback
}

function integer(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function list(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const items = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item !== '')
  return items.length > 0 ? items : fallback
}

/** Normalize the loader row config into the shape the engine expects. */
export function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const search = config.search && typeof config.search === 'object' ? config.search : {}
  const embedding = config.embedding && typeof config.embedding === 'object' ? config.embedding : {}
  const rerank = config.rerank && typeof config.rerank === 'object' ? config.rerank : {}
  const ocr = config.ocr && typeof config.ocr === 'object' ? config.ocr : {}

  const root = text(config.root, DEFAULTS.root)
  const extensions = list(config.extensions, DEFAULT_EXTENSIONS).map((extension) => {
    const lower = extension.toLowerCase()
    return lower.startsWith('.') ? lower : `.${lower}`
  })
  const provider = oneOf(embedding.provider, ['ollama', 'openai', 'none'], DEFAULTS.embedding.provider)

  return {
    name: text(config.name, root ? path.basename(root) : DEFAULTS.name),
    root,
    indexDir: text(config.indexDir, root ? path.join(root, '.dsh-kb') : ''),
    extensions,
    exclude: list(config.exclude, DEFAULT_EXCLUDE),
    chunkSize: integer(config.chunkSize, DEFAULTS.chunkSize, 200, 4000),
    chunkOverlap: integer(config.chunkOverlap, DEFAULTS.chunkOverlap, 0, 1200),
    maxFileBytes: integer(config.maxFileBytes, DEFAULTS.maxFileBytes, 1024, 64 * 1024 * 1024),
    maxFiles: integer(config.maxFiles, DEFAULTS.maxFiles, 1, 200000),
    promptSection: boolean(config.promptSection, DEFAULTS.promptSection),
    autoBuild: boolean(config.autoBuild, DEFAULTS.autoBuild),
    search: {
      topK: integer(search.topK, DEFAULTS.search.topK, 1, 30),
      minScore: Number.isFinite(Number(search.minScore))
        ? Math.min(1, Math.max(0, Number(search.minScore)))
        : DEFAULTS.search.minScore,
      snippetChars: integer(search.snippetChars, DEFAULTS.search.snippetChars, 80, 4000),
    },
    embedding: {
      provider,
      baseUrl: text(embedding.baseUrl, DEFAULTS.embedding.baseUrl),
      model: text(embedding.model, DEFAULTS.embedding.model),
      apiKey: typeof embedding.apiKey === 'string' ? embedding.apiKey : '',
      apiKeyEnv: typeof embedding.apiKeyEnv === 'string' ? embedding.apiKeyEnv.trim() : '',
      secretName: typeof embedding.secretName === 'string' ? embedding.secretName.trim() : '',
      batchSize: integer(embedding.batchSize, DEFAULTS.embedding.batchSize, 1, 128),
      timeoutMs: integer(embedding.timeoutMs, DEFAULTS.embedding.timeoutMs, 1000, 600000),
    },
    rerank: {
      enabled: boolean(rerank.enabled, DEFAULTS.rerank.enabled),
      provider: oneOf(rerank.provider, ['cohere', 'jina'], DEFAULTS.rerank.provider),
      baseUrl: typeof rerank.baseUrl === 'string' ? rerank.baseUrl.trim() : '',
      model: typeof rerank.model === 'string' ? rerank.model.trim() : '',
      apiKey: typeof rerank.apiKey === 'string' ? rerank.apiKey : '',
      apiKeyEnv: typeof rerank.apiKeyEnv === 'string' ? rerank.apiKeyEnv.trim() : '',
      secretName: typeof rerank.secretName === 'string' ? rerank.secretName.trim() : '',
      topN: integer(rerank.topN, DEFAULTS.rerank.topN, 1, 30),
      candidates: integer(rerank.candidates, DEFAULTS.rerank.candidates, 1, 100),
      timeoutMs: integer(rerank.timeoutMs, DEFAULTS.rerank.timeoutMs, 1000, 600000),
    },
    ocr: {
      enabled: boolean(ocr.enabled, DEFAULTS.ocr.enabled),
      baseUrl: typeof ocr.baseUrl === 'string' ? ocr.baseUrl.trim() : '',
      model: text(ocr.model, DEFAULTS.ocr.model),
      apiKey: typeof ocr.apiKey === 'string' ? ocr.apiKey : '',
      apiKeyEnv: typeof ocr.apiKeyEnv === 'string' ? ocr.apiKeyEnv.trim() : '',
      secretName: typeof ocr.secretName === 'string' ? ocr.secretName.trim() : '',
      dpi: integer(ocr.dpi, DEFAULTS.ocr.dpi, 72, 300),
      maxPages: integer(ocr.maxPages, DEFAULTS.ocr.maxPages, 1, 500),
      concurrency: integer(ocr.concurrency, DEFAULTS.ocr.concurrency, 1, 8),
      timeoutMs: integer(ocr.timeoutMs, DEFAULTS.ocr.timeoutMs, 5000, 600000),
      mutoolPath: typeof ocr.mutoolPath === 'string' ? ocr.mutoolPath.trim() : '',
    },
  }
}

export const CONFIG_HINT =
  '本地知识库未配置：请在当前 profile 的 cordis.patch.yml 里给 id: local-kb 的行设置 config.root（知识库文件夹的绝对路径），例如 root: \'D:\\\\notes\'，保存后重启会话再试。'
