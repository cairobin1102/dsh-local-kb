import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { extractDocText } from './doc.js'
import { extractDocxText } from './docx.js'
import { extractPdfText, isPdfBuffer } from './pdf.js'

const OLE_MAGIC = 0xe011cfd0
const BINARY_EXTENSIONS = new Set(['.docx', '.doc', '.wps', '.pdf'])

/** Word files lie about their extension often enough that the magic number decides. */
function extractWordText(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32LE(0) === OLE_MAGIC) return extractDocText(buffer)
  return extractDocxText(buffer)
}

/** Compile one glob-ish pattern (`**`, `*`, literal text) into a case-insensitive RegExp. */
function toRegExp(pattern) {
  const source = String(pattern).trim().replace(/\\/g, '/')
  if (source === '') return null
  let out = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '*') {
      if (source[index + 1] === '*') {
        out += '.*'
        index += 1
        if (source[index + 1] === '/') index += 1
      } else {
        out += '[^/]*'
      }
      continue
    }
    out += '\\^$+.()|{}[]?'.includes(char) ? `\\${char}` : char
  }
  try {
    return new RegExp(`^${out}$`, 'i')
  } catch {
    return null
  }
}

export function createMatcher(patterns) {
  const rules = patterns.map(toRegExp).filter(Boolean)
  return (relativePath) => rules.some((rule) => rule.test(relativePath))
}

export function toRelative(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/')
}

/**
 * Walk the knowledge base and return the candidate text files, plus the ones skipped.
 * Directory entries are tested with a trailing slash so `**\/name/**` matches the folder itself.
 */
export async function scanFiles(root, options, signal) {
  const excluded = createMatcher(options.exclude)
  const extensions = new Set(options.extensions)
  const files = new Map()
  const skipped = []
  const unsupported = new Map()
  const stack = [{ absolute: root, relative: '' }]

  while (stack.length > 0) {
    if (signal?.aborted) throw new Error('索引构建已取消')
    const directory = stack.pop()
    let entries
    try {
      entries = await readdir(directory.absolute, { withFileTypes: true })
    } catch (error) {
      throw new Error(`无法读取目录 ${directory.absolute}：${error?.message ?? error}`)
    }

    for (const entry of entries) {
      const relative = directory.relative === '' ? entry.name : `${directory.relative}/${entry.name}`
      if (excluded(relative) || excluded(`${relative}/`)) continue
      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        stack.push({ absolute: path.join(directory.absolute, entry.name), relative })
        continue
      }
      if (!entry.isFile()) continue
      const extension = path.extname(entry.name).toLowerCase()
      if (!extensions.has(extension)) {
        unsupported.set(extension || '（无后缀）', (unsupported.get(extension || '（无后缀）') ?? 0) + 1)
        continue
      }

      const absolute = path.join(directory.absolute, entry.name)
      let info
      try {
        info = await stat(absolute)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      if (info.size === 0) continue
      if (info.size > options.maxFileBytes) {
        skipped.push({ path: relative, reason: `文件超过 maxFileBytes（${info.size} 字节）` })
        continue
      }

      files.set(relative, { size: info.size, mtimeMs: Math.round(info.mtimeMs) })
      if (files.size >= options.maxFiles) {
        skipped.push({ path: '', reason: `文件数达到 maxFiles（${options.maxFiles}），其余未索引` })
        break
      }
    }
  }

  const unsupportedList = [...unsupported]
    .map(([extension, count]) => ({ extension, count }))
    .sort((left, right) => right.count - left.count || left.extension.localeCompare(right.extension))
  return { files, skipped, unsupported: unsupportedList }
}

/** Read one file as UTF-8 text; refuse binary content instead of producing garbage chunks. */
export async function readTextFile(absolutePath, maxBytes) {
  const buffer = await readFile(absolutePath)
  if (buffer.length > maxBytes) throw new Error(`文件超过 maxFileBytes（${buffer.length} 字节）`)
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (probe.includes(0)) throw new Error('看起来是二进制文件，已跳过')
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
  return text
}

/**
 * Extract plain text from a supported source file; binary formats are unpacked, everything else read as UTF-8.
 *
 * `hooks.ocrText(absolutePath)` 可选：当 PDF 没有文本层（扫描件）而 OCR 又开了，就用它兜底。
 */
export async function readSourceText(absolutePath, extension, maxBytes, hooks = {}) {
  if (BINARY_EXTENSIONS.has(extension)) {
    const buffer = await readFile(absolutePath)
    if (buffer.length > maxBytes) throw new Error(`文件超过 maxFileBytes（${buffer.length} 字节）`)
    // 按文件头判断真实格式：把 PDF 改成 .docx（或反过来）的情况都见过。
    if (isPdfBuffer(buffer)) {
      try {
        return extractPdfText(buffer).text
      } catch (error) {
        if (error?.scanned && typeof hooks.ocrText === 'function') {
          return await hooks.ocrText(absolutePath)
        }
        throw error
      }
    }
    if (extension === '.pdf') {
      throw new Error('这个 .pdf 文件没有 %PDF- 文件头，可能不是真正的 PDF')
    }
    return extractWordText(buffer)
  }
  return readTextFile(absolutePath, maxBytes)
}
