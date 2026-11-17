import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createApi, mergeConfig } from '../lib/api.js'
import { normalizeConfig } from '../lib/config.js'
import { createKnowledgeBase } from '../lib/kb.js'
import { createReranker } from '../lib/rerank.js'
import { createSecretStore } from '../lib/secrets.js'
import { createSettings } from '../lib/settings.js'

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name}\n     ${error?.message ?? error}`)
  }
}

function fakeCredentials() {
  const map = new Map()
  return {
    map,
    async readRecord(key) {
      return map.get(key)
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(map.get(key))
      if (next === undefined) map.delete(key)
      else map.set(key, next)
      return next
    },
    async deleteRecord(key) {
      map.delete(key)
    },
  }
}

function mockFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body })
    const result = await handler({ url: String(url), body, headers: init.headers ?? {} })
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

function fakeResponse() {
  const res = {
    status: 0,
    headers: {},
    text: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(text) {
      res.text = typeof text === 'string' ? text : String(text ?? '')
    },
  }
  return res
}

function fakeRequest({ method = 'GET', url = '/api/local-kb/state', remoteAddress = '127.0.0.1', host = '127.0.0.1:57293', headers = {}, body, rawBody } = {}) {
  const chunks = rawBody !== undefined ? [Buffer.from(rawBody, 'utf8')] : body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    socket: { remoteAddress },
    headers: { host, ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

async function withTemp(prefix, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await test('rerank：按 Cohere/Jina 协议发请求，并把结果按分数降序返回', async () => {
  const mock = mockFetch(({ body }) => ({
    body: {
      results: [
        { index: 2, relevance_score: 0.91 },
        { index: 0, relevance_score: 0.42 },
        { index: 1, relevance_score: 0.11 },
      ],
      usage: { total_tokens: 10 },
      documents: body.documents.length,
    },
  }))
  try {
    const reranker = createReranker(
      { enabled: true, baseUrl: 'https://api.jina.ai/v1/', model: 'jina-reranker-v2', topN: 2 },
      { resolveKey: async () => 'sk-test' },
    )
    const rows = await reranker.rerankDocuments('查一下讲话', ['a', 'b', 'c'], { topN: 2 })
    assert.deepEqual(
      rows.map((row) => row.index),
      [2, 0],
    )
    assert.equal(mock.calls.length, 1)
    assert.equal(mock.calls[0].url, 'https://api.jina.ai/v1/rerank')
    assert.equal(mock.calls[0].body.model, 'jina-reranker-v2')
    assert.equal(mock.calls[0].body.top_n, 2)
    assert.equal(mock.calls[0].body.query, '查一下讲话')
    assert.deepEqual(mock.calls[0].body.documents, ['a', 'b', 'c'])
    assert.equal(mock.calls[0].headers.authorization, 'Bearer sk-test')
  } finally {
    mock.restore()
  }
})

await test('rerank：baseUrl 已带 /rerank 时原样使用；HTTP 失败抛出可读错误', async () => {
  const mock = mockFetch(() => ({ status: 401, body: { message: 'invalid api key' } }))
  try {
    const reranker = createReranker({ enabled: true, baseUrl: 'https://x.test/rerank', model: 'm' })
    await assert.rejects(() => reranker.rerankDocuments('q', ['a']), /HTTP 401.*invalid api key/s)
    assert.equal(mock.calls[0].url, 'https://x.test/rerank')
  } finally {
    mock.restore()
  }
})

await test('rerank：未启用的实例直接报错，不偷偷降级', async () => {
  const reranker = createReranker({ enabled: false, baseUrl: 'https://x.test', model: 'm' })
  assert.equal(reranker.enabled, false)
  await assert.rejects(() => reranker.rerankDocuments('q', ['a']), /重排未启用/)
})

await test('secrets：写入凭据库、按 secretName 读回、空值删除、环境变量优先于配置', async () => {
  const credentials = fakeCredentials()
  const store = createSecretStore(credentials)
  assert.equal(store.available, true)

  const name = await store.save('embedding', 'sk-embedding-123456')
  assert.equal(name, 'local-kb/embedding')
  assert.equal(credentials.map.get(name).kind, 'api-key')
  assert.equal(credentials.map.get(name).key, 'sk-embedding-123456')

  const readBack = await store.read('embedding', { secretName: name })
  assert.equal(readBack, 'sk-embedding-123456')

  const info = await store.describe('embedding', { secretName: name })
  assert.equal(info.configured, true)
  assert.equal(info.source, 'credential')
  assert.ok(!info.masked.includes('123456'))

  process.env.LOCAL_KB_TEST_KEY = 'from-env'
  try {
    assert.equal(await store.read('rerank', { apiKeyEnv: 'LOCAL_KB_TEST_KEY', apiKey: 'inline' }), 'from-env')
    assert.equal(await store.read('rerank', { apiKey: 'inline' }), 'inline')
    assert.equal(await store.read('rerank', {}), '')
  } finally {
    delete process.env.LOCAL_KB_TEST_KEY
  }

  await store.save('embedding', '')
  assert.equal(credentials.map.has(name), false)
})

await test('secrets：宿主没有凭据服务时保存给出明确指引', async () => {
  const store = createSecretStore(undefined)
  assert.equal(store.available, false)
  await assert.rejects(() => store.save('embedding', 'x'), /凭据服务/)
  const info = await store.describe('embedding', { apiKey: 'k' })
  assert.equal(info.writable, false)
  assert.equal(info.configured, true)
})

await test('mergeConfig：改 root 会同时换掉默认索引目录', () => {
  const options = normalizeConfig({ root: path.join('C:', 'notes'), embedding: { provider: 'none' } })
  assert.ok(options.indexDir.endsWith('.dsh-kb'))
  const next = mergeConfig(options, { root: path.join('D:', 'kb') })
  assert.equal(next.root, path.join('D:', 'kb'))
  assert.equal(next.indexDir, path.join('D:', 'kb', '.dsh-kb'))
  assert.equal(next.embedding.provider, 'none')
})

await test('mergeConfig：只改模型不会丢其他字段', () => {
  const options = normalizeConfig({
    root: 'C:\\kb',
    embedding: { provider: 'openai', baseUrl: 'https://api.x/v1', model: 'bge-m3' },
    rerank: { enabled: true, baseUrl: 'https://api.y/v1', model: 'r' },
  })
  const next = mergeConfig(options, { embedding: { model: 'text-embedding-3-large' } })
  assert.equal(next.embedding.model, 'text-embedding-3-large')
  assert.equal(next.embedding.baseUrl, 'https://api.x/v1')
  assert.equal(next.rerank.model, 'r')
  assert.equal(next.rerank.enabled, true)
})

await test('api：state / docs / search / read / 未知路由', async () => {
  await withTemp('dsh-kb-api-', async (dir) => {
    await mkdir(path.join(dir, 'sub'), { recursive: true })
    await writeFile(path.join(dir, 'a.md'), '# 讲话\n\n关于乡村振兴的部署。\n', 'utf8')
    await writeFile(path.join(dir, 'sub', 'b.md'), '# 会议\n\n乡村振兴年度任务。\n', 'utf8')

    const options = normalizeConfig({ root: dir, embedding: { provider: 'none' } })
    const kb = createKnowledgeBase(options)
    await kb.rebuild()
    const settings = { available: () => false, save: async () => ({}) }
    const api = createApi({
      ctx: { get: () => undefined },
      kb,
      secrets: createSecretStore(undefined),
      options,
      settings,
    })

    const state = (await api.invoke({ pathname: '/api/local-kb/state' })).body
    assert.equal(state.ok, true)
    assert.equal(state.status.files, 2)
    assert.equal(state.capabilities.configEditor, false)
    assert.equal(state.capabilities.secrets, false)

    const docs = (await api.invoke({ pathname: '/api/local-kb/docs' })).body
    assert.equal(docs.files.length, 2)
    assert.ok(docs.files.every((file) => Number.isInteger(file.chunks)))

    const search = (await api.invoke({ method: 'POST', pathname: '/api/local-kb/search', body: { query: '乡村振兴', limit: 5 } })).body
    assert.equal(search.ok, true)
    assert.equal(search.mode, 'keyword')
    assert.ok(search.results.length >= 1)
    assert.equal(search.results[0].text, undefined)

    const read = (await api.invoke({ method: 'POST', pathname: '/api/local-kb/read', body: { path: 'a.md' } })).body
    assert.equal(read.ok, true)
    assert.match(read.text, /乡村振兴/)

    const missing = await api.invoke({ pathname: '/api/local-kb/nope' })
    assert.equal(missing.status, 404)

    const settingsResponse = await api.invoke({
      method: 'POST',
      pathname: '/api/local-kb/settings',
      body: { config: { root: dir } },
    })
    assert.equal(settingsResponse.status, 400)
    assert.match(settingsResponse.body.error, /configEditor/)
  })
})

await test('api：保存设置会先回话再交给 configEditor，并把密钥写进凭据库', async () => {
  await withTemp('dsh-kb-save-', async (dir) => {
    const credentials = fakeCredentials()
    const options = normalizeConfig({ root: dir, embedding: { provider: 'none' } })
    const kb = createKnowledgeBase(options)
    let captured = null
    const settings = {
      available: () => true,
      save: async (next) => {
        captured = next
        return next
      },
    }
    const api = createApi({
      ctx: { get: () => undefined },
      kb,
      secrets: createSecretStore(credentials),
      options,
      settings,
    })
    const response = await api.invoke({
      method: 'POST',
      pathname: '/api/local-kb/settings',
      body: {
        config: {
          name: '讲话库',
          root: dir,
          embedding: { provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' },
          rerank: { enabled: true, baseUrl: 'https://api.jina.ai/v1', model: 'jina-reranker-v2' },
        },
        keys: { embedding: 'sk-embed-xxxx', rerank: 'sk-rerank-yyyy' },
      },
    })
    const body = response.body
    assert.equal(body.ok, true)
    assert.equal(body.restarting, true)
    assert.equal(body.applied.embedding.model, 'BAAI/bge-m3')
    assert.equal(body.keys.embedding, 'local-kb/embedding')
    assert.equal(credentials.map.get('local-kb/embedding').key, 'sk-embed-xxxx')
    assert.equal(credentials.map.get('local-kb/rerank').key, 'sk-rerank-yyyy')

    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.ok(captured, 'configEditor 应该收到一次写回')
    assert.equal(captured.name, '讲话库')
    assert.equal(captured.embedding.secretName, 'local-kb/embedding')
    assert.equal(captured.embedding.apiKey, '')
    assert.equal(captured.rerank.enabled, true)
  })
})

await test('api：HTTP 路由只接受回环请求，且能处理 POST', async () => {
  await withTemp('dsh-kb-loop-', async (dir) => {
    await writeFile(path.join(dir, 'a.md'), '# 讲话\n\n乡村振兴的部署。\n', 'utf8')
    const options = normalizeConfig({ root: dir, embedding: { provider: 'none' } })
    const kb = createKnowledgeBase(options)
    await kb.rebuild()
    const api = createApi({
      ctx: { get: () => undefined },
      kb,
      secrets: createSecretStore(undefined),
      options,
      settings: { available: () => false, save: async () => ({}) },
    })
    const route = api.route()
    assert.equal(route.kind, 'prefix')
    assert.equal(route.path, '/api/local-kb')

    const denied = fakeResponse()
    await route.handler(fakeRequest({ remoteAddress: '10.0.0.9' }), denied)
    assert.equal(denied.status, 403)
    assert.match(JSON.parse(denied.text).error, /回环/)

    const deniedOrigin = fakeResponse()
    await route.handler(fakeRequest({ headers: { origin: 'http://evil.example' } }), deniedOrigin)
    assert.equal(deniedOrigin.status, 403)

    const ok = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST', url: '/api/local-kb/search', body: { query: '乡村振兴' } }), ok)
    assert.equal(ok.status, 200)
    assert.equal(ok.headers['content-type'], 'application/json; charset=utf-8')
    const parsed = JSON.parse(ok.text)
    assert.equal(parsed.ok, true)
    assert.ok(parsed.results.length >= 1)

    const broken = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST', url: '/api/local-kb/search', rawBody: 'not json{' }), broken)
    assert.equal(broken.status, 400)
  })
})

await test('configEditor 写回：拿到当前配置做增量合并', async () => {
  let captured = null
  const ctx = {
    get: (name) =>
      name === 'configEditor'
        ? {
            edit: async (entry, change) => {
              captured = { entry, next: change({ root: 'C:\\old', embedding: { provider: 'none' } }, {}) }
            },
          }
        : undefined,
    fiber: { entry: { id: 'include:local-kb' } },
  }
  const settings = createSettings({ ctx })
  assert.equal(settings.available(), true)
  await settings.save({
    name: '库',
    root: 'D:\\new',
    embedding: { provider: 'openai', baseUrl: 'https://api.x/v1', model: 'm', secretName: 'local-kb/embedding' },
    rerank: { enabled: true, baseUrl: 'https://api.y/v1', model: 'r', secretName: 'local-kb/rerank' },
  })
  assert.equal(captured.entry.id, 'include:local-kb')
  assert.equal(captured.next.root, 'D:\\new')
  assert.equal(captured.next.name, '库')
  assert.equal(captured.next.embedding.secretName, 'local-kb/embedding')
  assert.equal(captured.next.rerank.enabled, true)
})

await test('检索链路：启用重排后结果按重排分数排序，mode 标注 +rerank', async () => {
  await withTemp('dsh-kb-rr-', async (dir) => {
    await writeFile(path.join(dir, 'x.md'), '# 甲\n\n乡村振兴第一段内容。\n', 'utf8')
    await writeFile(path.join(dir, 'y.md'), '# 乙\n\n乡村振兴第二段内容。\n', 'utf8')
    const mock = mockFetch(({ body }) => ({
      body: {
        results: body.documents.map((_, index) => ({
          index,
          relevance_score: index === 0 ? 0.2 : 0.95,
        })),
      },
    }))
    try {
      const options = normalizeConfig({
        root: dir,
        embedding: { provider: 'none' },
        rerank: { enabled: true, baseUrl: 'https://api.jina.ai/v1', model: 'jina-reranker-v2', topN: 2 },
      })
      const kb = createKnowledgeBase(options)
      await kb.rebuild()
      const result = await kb.search({ query: '乡村振兴', limit: 2 })
      assert.equal(result.mode, 'keyword+rerank')
      assert.equal(result.rerankModel, 'jina-reranker-v2')
      assert.equal(result.results.length, 2)
      assert.equal(result.results[0].score, 0.95)
      assert.ok(result.results[0].scoreBefore !== undefined)
      assert.equal(mock.calls.length, 1)

      const plain = await kb.search({ query: '乡村振兴', limit: 2, rerank: false })
      assert.equal(plain.mode, 'keyword')
      assert.equal(mock.calls.length, 1, 'rerank:false 不应该再调重排')
    } finally {
      mock.restore()
    }
  })
})

await test('检索链路：重排接口挂掉时降级为原顺序并说明原因', async () => {
  await withTemp('dsh-kb-rrerr-', async (dir) => {
    await writeFile(path.join(dir, 'x.md'), '# 甲\n\n乡村振兴内容。\n', 'utf8')
    const mock = mockFetch(() => ({ status: 500, body: { message: 'boom' } }))
    try {
      const options = normalizeConfig({
        root: dir,
        embedding: { provider: 'none' },
        rerank: { enabled: true, baseUrl: 'https://api.jina.ai/v1', model: 'r' },
      })
      const kb = createKnowledgeBase(options)
      await kb.rebuild()
      const result = await kb.search({ query: '乡村振兴', limit: 2 })
      assert.equal(result.mode, 'keyword')
      assert.match(result.note, /重排未生效/)
      assert.ok(result.results.length >= 1)
    } finally {
      mock.restore()
    }
  })
})

await test('api：没有配置目录时 state / docs 仍可用，并给出未配置状态', async () => {
  const options = normalizeConfig({})
  const kb = createKnowledgeBase(options)
  const api = createApi({
    ctx: { get: () => undefined },
    kb,
    secrets: createSecretStore(undefined),
    options,
    settings: { available: () => false, save: async () => ({}) },
  })
  const state = (await api.invoke({ pathname: '/api/local-kb/state' })).body
  assert.equal(state.ok, true)
  assert.equal(state.configured, false)
  assert.equal(state.status.configured, false)
  assert.equal(state.config.root, '')

  const docsResponse = await api.invoke({ pathname: '/api/local-kb/docs' })
  assert.equal(docsResponse.status, 200)
  assert.equal(docsResponse.body.ok, true)
  assert.equal(docsResponse.body.configured, false)
  assert.deepEqual(docsResponse.body.files, [])
})

await test('api：保存失败会通过下一次 /state 的 saveError 暴露，而不是假装成功', async () => {
  await withTemp('dsh-kb-saveerr-', async (dir) => {
    const options = normalizeConfig({ root: dir })
    const api = createApi({
      ctx: { get: () => undefined },
      kb: createKnowledgeBase(options),
      secrets: createSecretStore(fakeCredentials()),
      options,
      settings: {
        available: () => true,
        save: async () => {
          throw new Error('写配置失败：EACCES')
        },
      },
    })
    const saved = await api.invoke({
      method: 'POST',
      pathname: '/api/local-kb/settings',
      body: { config: { root: dir, name: '讲话库' }, keys: { embedding: 'sk-1' } },
    })
    assert.equal(saved.body.ok, true, '响应仍然是「已提交」——失败只能在之后被看到')
    await new Promise((resolve) => setTimeout(resolve, 120))

    const state = (await api.invoke({ pathname: '/api/local-kb/state' })).body
    assert.match(String(state.saveError), /EACCES/)
    assert.match(String(state.saveError), /密钥已写入凭据库/)
  })
})

await test('api：测试按钮用表单里未保存的配置与密钥，而不是已保存的那份', async () => {
  const mock = mockFetch(() => ({ body: { data: [{ embedding: [0.1, 0.2, 0.3] }] } }))
  try {
    const options = normalizeConfig({ root: '' , embedding: { provider: 'none' } })
    const api = createApi({
      ctx: { get: () => undefined },
      kb: createKnowledgeBase(options),
      secrets: createSecretStore(fakeCredentials()),
      options,
      settings: { available: () => true, save: async () => ({}) },
    })

    const disabled = (
      await api.invoke({
        method: 'POST',
        pathname: '/api/local-kb/index',
        body: { action: 'probe', config: { embedding: { provider: 'none' } } },
      })
    ).body
    assert.equal(disabled.ok, false)
    assert.match(disabled.error, /provider = none/)

    // 不带 config 的探活走已保存配置：同样是配置问题，应当回 400 而不是 500。
    const savedProbe = await api.invoke({
      method: 'POST',
      pathname: '/api/local-kb/index',
      body: { action: 'probe' },
    })
    assert.equal(savedProbe.status, 400)
    assert.equal(savedProbe.body.ok, false)
    assert.match(savedProbe.body.error, /未配置|未启用/)

    const probe = (
      await api.invoke({
        method: 'POST',
        pathname: '/api/local-kb/index',
        body: {
          action: 'probe',
          config: {
            root: 'D:\\draft',
            embedding: { provider: 'openai', baseUrl: 'https://draft.example/v1', model: 'draft-model' },
          },
          keys: { embedding: 'sk-draft' },
        },
      })
    ).body
    assert.equal(probe.ok, true)
    assert.equal(probe.dim, 3)
    assert.equal(probe.tested, 'form')
    assert.equal(probe.model, 'draft-model')
    assert.equal(mock.calls.length, 1)
    assert.equal(mock.calls[0].url, 'https://draft.example/v1/embeddings')
    assert.equal(mock.calls[0].headers.authorization, 'Bearer sk-draft')

    const noRerank = (
      await api.invoke({
        method: 'POST',
        pathname: '/api/local-kb/index',
        body: { action: 'probe-rerank', config: { rerank: { enabled: false } } },
      })
    ).body
    assert.equal(noRerank.ok, false)
    assert.match(noRerank.error, /重排未启用/)

    const noOcr = (
      await api.invoke({
        method: 'POST',
        pathname: '/api/local-kb/index',
        body: { action: 'probe-ocr', config: { ocr: { enabled: false } } },
      })
    ).body
    assert.equal(noOcr.ok, false)
    assert.match(noOcr.error, /OCR 未启用/)
  } finally {
    mock.restore()
  }
})

await test('api：OCR 密钥写进独立的凭据记录，配置里只留记录名', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'local-kb-ocr-ui-'))
  try {
    const credentials = fakeCredentials()
    const options = normalizeConfig({ root: dir })
    const api = createApi({
      ctx: { get: () => undefined },
      kb: createKnowledgeBase(options),
      secrets: createSecretStore(credentials),
      options,
      settings: { available: () => true, save: async () => ({}) },
    })
    const saved = (
      await api.invoke({
        method: 'POST',
        pathname: '/api/local-kb/settings',
        body: {
          config: { root: dir, ocr: { enabled: true, baseUrl: 'https://api.ocr/v1', model: 'vl-model' } },
          keys: { ocr: 'sk-ocr-zzzz' },
        },
      })
    ).body
    assert.equal(saved.ok, true)
    assert.equal(credentials.map.get('local-kb/ocr').key, 'sk-ocr-zzzz')
    assert.equal(saved.applied.ocr.enabled, true)
    assert.equal(saved.applied.ocr.model, 'vl-model')

    const state = (await api.invoke({ method: 'GET', pathname: '/api/local-kb/state' })).body
    assert.equal(state.keys.ocr.configured, true)
    assert.equal(state.keys.ocr.masked.includes('sk-'), true)
    // 配置要等 plugin 重启后才生效，这里只确认状态里带了 OCR 这一块。
    assert.equal(typeof state.config.ocr.model, 'string')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('embedding：网关 5xx 会重试并自动拆半，整批不会作废', async () => {
  const { createEmbedder } = await import('../lib/embed.js')
  const mock = mockFetch(({ body }) => {
    const texts = body.input
    if (texts.length > 2) return { status: 502, body: { error: 'bad gateway' } }
    return {
      status: 200,
      body: { data: texts.map((_text, index) => ({ index, embedding: [1, 0, index] })) },
    }
  })
  try {
    const embedder = createEmbedder({
      provider: 'openai',
      baseUrl: 'https://api.example/v1',
      model: 'm',
      apiKey: 'k',
      batchSize: 4,
      timeoutMs: 5000,
    })
    const vectors = await embedder.embed(['a', 'b', 'c', 'd', 'e'])
    assert.equal(vectors.length, 5)
    for (const vector of vectors) assert.equal(vector.length, 3)
    assert.ok(embedder.lastStats().split >= 1)
    // 4 条的那批：重试两次 502 → 拆成 2+2 成功；1 条的那批一次成功。
    assert.ok(mock.calls.length >= 4)
  } finally {
    mock.restore()
  }
})

console.log(`\n${passed}/${passed + failures.length} passed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error?.stack ?? failure.error}`)
  process.exit(1)
}
