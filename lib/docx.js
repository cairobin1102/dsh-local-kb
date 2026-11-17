import { inflateRawSync } from 'node:zlib'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

function findEndOfCentralDirectory(buffer) {
  const minimum = 22
  const limit = Math.max(0, buffer.length - minimum - 0xffff)
  for (let offset = buffer.length - minimum; offset >= limit; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) return offset
  }
  return -1
}

function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new Error('不是有效的 ZIP/OOXML 文件（找不到目录结尾）')
  const total = buffer.readUInt16LE(eocd + 10)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (directoryOffset === 0xffffffff) throw new Error('不支持 ZIP64 格式的 docx')

  const entries = new Map()
  let offset = directoryOffset
  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.set(name, { method, compressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readZipEntry(buffer, entry) {
  const offset = entry.localOffset
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL) {
    throw new Error('docx 内容损坏（本地文件头无效）')
  }
  const nameLength = buffer.readUInt16LE(offset + 26)
  const extraLength = buffer.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const data = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method === 8) return inflateRawSync(data)
  throw new Error(`docx 使用了不支持的压缩方式（${entry.method}）`)
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_, decimal) => {
      const code = Number.parseInt(decimal, 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Turn DrawingML word-processing markup into plain text, one line per paragraph. */
function xmlToText(xml) {
  const normalized = xml
    .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:delText[\s\S]*?<\/w:delText>/g, '')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(normalized)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extract the visible text of a .docx. Dependency-free: read `word/document.xml`
 * out of the OOXML zip archive and strip the markup.
 */
export function extractDocxText(buffer) {
  // Legacy Word 97-2003 files are OLE2 compound documents; they are often renamed to .docx.
  if (buffer.length >= 8 && buffer.readUInt32LE(0) === 0xe011cfd0) {
    throw new Error('这是旧版 Word（.doc 二进制格式）改了后缀，不是真正的 .docx：请用 Word/WPS 另存为 .docx 后重新索引')
  }
  const entries = readZipEntries(buffer)
  const document = entries.get('word/document.xml')
  if (!document) throw new Error('docx 里没有 word/document.xml（文件可能损坏，或不是 Word 文档）')
  const xml = readZipEntry(buffer, document).toString('utf8')
  const text = xmlToText(xml)
  if (text === '') throw new Error('docx 正文为空')
  return text
}
