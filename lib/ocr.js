import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * mutool is a child process of the host, and on Windows the host sandbox may only
 * let children write inside the session workspace. The index directory lives on
 * the knowledge-base drive, so a render there can fail with "Permission denied";
 * fall back to a scratch directory next to the plugin package (which is inside
 * the workspace) and remember the choice for later calls.
 */
const FALLBACK_WORK_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.ocr-work',
)
let preferredWorkRoot = ''

/**
 * 扫描件 PDF 的 OCR：用 mutool 把页面渲染成 PNG，再交给视觉模型转成文字。
 *
 * 这是「可选增强」：没有 mutool 或没有配视觉模型时，扫描件依旧只报“需要 OCR”，
 * 不会拖垮整个索引。
 */

export class OcrError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'OcrError'
    this.status = details.status
  }
}

const OCR_PROMPT =
  '请把这张图片里的文字完整转写出来：保留原有段落顺序和分行，不要加任何解释、评论或标题；' +
  '看不清的字用□代替，不要猜测。只输出转写结果。'

export const DEFAULT_OCR_MODEL = 'Qwen/Qwen3-VL-8B-Instruct'

function run(executable, args, { timeoutMs = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? '').trim().slice(0, 300)
          reject(new OcrError(`调用 ${path.basename(executable)} 失败：${detail || error.message}`))
          return
        }
        resolve(String(stdout ?? ''))
      },
    )
  })
}

/** 判断 mutool 是否可用：先试显式路径，再退回 PATH 上的 mutool。 */
export async function probeMutool(configuredPath) {
  const candidates = []
  if (configuredPath) candidates.push(configuredPath)
  candidates.push('mutool')
  for (const candidate of candidates) {
    try {
      const output = await run(candidate, ['-v'], { timeoutMs: 10000 })
      return { ok: true, path: candidate, version: output.split(/\r?\n/)[0].trim() }
    } catch {
      // 换下一个候选
    }
  }
  return {
    ok: false,
    path: '',
    version: '',
    error: configuredPath
      ? `找不到可用的 mutool（试过 ${configuredPath} 与 PATH）`
      : '找不到 mutool：请把 mutool.exe 放到 PATH，或在设置里填它的完整路径',
  }
}

function sortPages(files) {
  return files
    .filter((name) => /\.png$/i.test(name))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
}

/** 用 mutool 把一个 PDF 的前 maxPages 页渲染成 PNG，返回文件路径数组。 */
export async function renderPdf({
  mutoolPath,
  pdfPath,
  dpi = 150,
  maxPages = 40,
  timeoutMs = 180000,
  workRoot = '',
  signal,
}) {
  if (!Number.isFinite(maxPages) || maxPages < 1) throw new OcrError('ocr.maxPages 至少为 1')
  // The host process is sandboxed: os.tmpdir() may be refused, so prefer the
  // index directory (known writable) and only fall back to the OS temp folder.
  let base = workRoot
  if (base) {
    await mkdir(base, { recursive: true }).catch(() => {})
  }
  let workDir
  try {
    workDir = await mkdtemp(path.join(base || os.tmpdir(), 'dsh-local-kb-ocr-'))
  } catch (error) {
    if (!base) throw error
    workDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-local-kb-ocr-'))
  }
  const pattern = path.join(workDir, 'page-%04d.png')
  const args = ['draw', '-q', '-r', String(Math.max(72, Math.min(300, dpi))), '-o', pattern, pdfPath]
  // mutool 的页范围是 1 起，闭区间；先按上限渲染，超出部分由调用方截断。
  args.push(`1-${Math.max(1, maxPages)}`)
  try {
    await run(mutoolPath, args, { timeoutMs, signal })
    const files = sortPages(await readdir(workDir))
    if (files.length === 0) throw new OcrError('mutool 没有渲染出任何页面（PDF 可能损坏或加密）')
    return { workDir, pages: files.slice(0, maxPages).map((name) => path.join(workDir, name)) }
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function visionOnce({ baseUrl, apiKey, model, dataUrl, timeoutMs = 180000, signal }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
  const body = {
    model,
    temperature: 0,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: OCR_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
  const forwardAbort = () => controller.abort(new Error('已取消'))
  if (signal) {
    if (signal.aborted) throw new OcrError('OCR 已取消')
    signal.addEventListener('abort', forwardAbort, { once: true })
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await response.text()
    if (!response.ok) {
      throw new OcrError(`${url} 返回 HTTP ${response.status}：${raw.slice(0, 300)}`, {
        status: response.status,
      })
    }
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      throw new OcrError(`${url} 返回的不是 JSON：${raw.slice(0, 200)}`)
    }
    const content = data?.choices?.[0]?.message?.content
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : ''
    if (!text.trim()) throw new OcrError('视觉模型返回了空文本')
    return { text: text.trim(), usage: data?.usage ?? null }
  } catch (error) {
    if (error instanceof OcrError) throw error
    throw new OcrError(`无法连接 ${url}：${error?.message ?? error}`)
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', forwardAbort)
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** 缓存键：路径 + 大小 + mtime + 模型 + dpi，任一变化就重新识别。 */
export function ocrCacheKey({ relativePath, size, mtimeMs, model, dpi }) {
  return createHash('sha1')
    .update(`${relativePath}\u0000${size}\u0000${Math.round(mtimeMs)}\u0000${model}\u0000${dpi}`)
    .digest('hex')
    .slice(0, 24)
}

export async function readCachedOcr(cacheDir, key) {
  if (!cacheDir) return null
  try {
    const raw = await readFile(path.join(cacheDir, `${key}.json`), 'utf8')
    const data = JSON.parse(raw)
    return typeof data?.text === 'string' ? data : null
  } catch {
    return null
  }
}

async function writeCachedOcr(cacheDir, key, payload) {
  if (!cacheDir) return
  try {
    await mkdir(cacheDir, { recursive: true })
    await writeFile(path.join(cacheDir, `${key}.json`), JSON.stringify(payload), 'utf8')
  } catch {
    // 缓存写失败不影响主流程
  }
}

/**
 * 对一个扫描件 PDF 做 OCR。
 * @returns {{ text: string, pages: number, ms: number, model: string, cached: boolean }}
 */
export async function ocrPdf({
  pdfPath,
  relativePath = path.basename(pdfPath),
  size = 0,
  mtimeMs = 0,
  options,
  resolveKey,
  cacheDir,
  skipCache = false,
  signal,
}) {
  const model = options.model || DEFAULT_OCR_MODEL
  const key = ocrCacheKey({ relativePath, size, mtimeMs, model, dpi: options.dpi })
  const cached = skipCache ? null : await readCachedOcr(cacheDir, key)
  if (cached) return { text: cached.text, pages: cached.pages ?? 0, ms: 0, model, cached: true }

  const mutool = await probeMutool(options.mutoolPath)
  if (!mutool.ok) throw new OcrError(mutool.error)

  const baseUrl = options.baseUrl || ''
  if (!baseUrl) throw new OcrError('没有配置 OCR 的接口地址（ocr.baseUrl 为空）')
  const apiKey =
    typeof resolveKey === 'function' ? String((await resolveKey()) ?? '') : String(options.apiKey ?? '')

  const startedAt = Date.now()
  const renderArgs = {
    mutoolPath: mutool.path,
    pdfPath,
    dpi: options.dpi,
    maxPages: options.maxPages,
    timeoutMs: options.timeoutMs,
    signal,
  }
  const rendered = await renderPdf({
    ...renderArgs,
    workRoot: preferredWorkRoot || cacheDir,
  }).catch(async (error) => {
    const message = String(error?.message ?? error)
    if (preferredWorkRoot || !/Permission denied|cannot open file|拒绝访问/i.test(message)) throw error
    preferredWorkRoot = FALLBACK_WORK_ROOT
    return renderPdf({ ...renderArgs, workRoot: preferredWorkRoot })
  })
  try {
    const texts = await mapLimit(rendered.pages, options.concurrency, async (pngPath) => {
      const png = await readFile(pngPath)
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`
      const result = await visionOnce({
        baseUrl,
        apiKey,
        model,
        dataUrl,
        timeoutMs: options.timeoutMs,
        signal,
      })
      return result.text
    })
    const text = texts.join('\n\n').trim()
    if (!text) throw new OcrError('OCR 没有识别出任何文字')
    const payload = { text, pages: texts.length, model, at: new Date().toISOString() }
    await writeCachedOcr(cacheDir, key, payload)
    return { text, pages: texts.length, ms: Date.now() - startedAt, model, cached: false }
  } finally {
    await rm(rendered.workDir, { recursive: true, force: true }).catch(() => {})
  }
}
