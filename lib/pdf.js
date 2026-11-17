import { inflateSync } from 'node:zlib'

/**
 * 无依赖 PDF 文本提取。
 *
 * 只做「电子版 PDF」的文本层：解析对象、解压 FlateDecode 流、按 ToUnicode CMap
 * 把字形码翻回文字。扫描件（整页是图、没有文本层）会被识别出来并返回 scanned=true，
 * 真正的 OCR 需要渲染 + 识别引擎，不在本模块范围内。
 */

const MAGIC = '%PDF-'

export class PdfError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PdfError'
  }
}

export function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 5).toString('latin1') === MAGIC
}

/* ------------------------------ 词法/对象 ------------------------------ */

function unescapeLiteral(raw) {
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char !== '\\') {
      out += char
      continue
    }
    const next = raw[index + 1]
    index += 1
    if (next === undefined) break
    if (next === 'n') out += '\n'
    else if (next === 'r') out += '\r'
    else if (next === 't') out += '\t'
    else if (next === 'b') out += '\b'
    else if (next === 'f') out += '\f'
    else if (next === '0' || next === '1' || next === '2' || next === '3' || next === '4' || next === '5' || next === '6' || next === '7') {
      let digits = next
      for (let more = 0; more < 2; more += 1) {
        const candidate = raw[index + 1]
        if (candidate && candidate >= '0' && candidate <= '7') {
          digits += candidate
          index += 1
        } else break
      }
      out += String.fromCharCode(Number.parseInt(digits, 8))
    } else if (next === '\n') {
      // 续行，什么都不加
    } else if (next === '\r') {
      if (raw[index + 1] === '\n') index += 1
    } else out += next
  }
  return out
}

function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const padded = clean.length % 2 === 0 ? clean : `${clean}0`
  const bytes = []
  for (let index = 0; index < padded.length; index += 2) {
    bytes.push(Number.parseInt(padded.slice(index, index + 2), 16))
  }
  return bytes
}

/* ------------------------------ 文档解析 ------------------------------ */

class PdfDocument {
  constructor(buffer) {
    this.buffer = buffer
    this.latin = buffer.toString('latin1')
    this.objects = new Map()
    this.parseObjects()
    this.pageCache = null
  }

  parseObjects() {
    const { latin } = this
    const pattern = /(^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g
    let match
    while ((match = pattern.exec(latin)) !== null) {
      const number = Number(match[2])
      const bodyStart = pattern.lastIndex
      const endObj = latin.indexOf('endobj', bodyStart)
      const end = endObj === -1 ? latin.length : endObj
      const body = latin.slice(bodyStart, end)
      const streamAt = body.search(/\bstream\r?\n?/)
      let dictText = body
      let streamStart = -1
      let streamEnd = -1
      if (streamAt !== -1) {
        dictText = body.slice(0, streamAt)
        const dataAt = bodyStart + streamAt
        const afterKeyword = dataAt + 'stream'.length
        let start = afterKeyword
        if (latin[start] === '\r') start += 1
        if (latin[start] === '\n') start += 1
        const stop = latin.indexOf('endstream', start)
        if (stop !== -1) {
          streamStart = start
          streamEnd = stop
        }
      }
      this.objects.set(number, { number, dictText, streamStart, streamEnd })
      pattern.lastIndex = end
    }
    if (this.objects.size === 0) throw new PdfError('这个 PDF 没有可解析的对象（可能损坏或加密）')
  }

  /** 解析 `12 0 R` 之类的引用。 */
  resolveRef(token) {
    const match = /^\s*(\d+)\s+\d+\s+R\s*$/.exec(String(token ?? ''))
    if (!match) return undefined
    return this.objects.get(Number(match[1]))
  }

  isRef(token) {
    return /^\s*\d+\s+\d+\s+R\s*$/.test(String(token ?? ''))
  }

  /** 取对象（或引用指向的对象）的字典文本。 */
  dictOf(token) {
    if (token && typeof token === 'object' && 'dictText' in token) return token.dictText
    const ref = this.resolveRef(token)
    if (ref) return ref.dictText
    return typeof token === 'string' ? token : ''
  }

  /** 解压对象的数据流（支持 FlateDecode，其它编码原样返回）。 */
  streamOf(token) {
    const object = typeof token === 'object' && token ? token : this.resolveRef(token)
    if (!object || object.streamStart < 0) return null
    const raw = this.buffer.subarray(object.streamStart, object.streamEnd)
    if (/\/Filter\s*\[\s*\/FlateDecode/.test(object.dictText) || /\/Filter\s*\/FlateDecode/.test(object.dictText)) {
      try {
        return inflateSync(raw)
      } catch {
        return null
      }
    }
    if (/\/Filter/.test(object.dictText)) return null
    return raw
  }

  streamText(token) {
    const data = this.streamOf(token)
    return data ? data.toString('latin1') : ''
  }

  /** 所有页面对象（按 /Pages 树顺序，退化时按对象号）。 */
  pages() {
    if (this.pageCache) return this.pageCache
    const pages = []
    for (const object of this.objects.values()) {
      if (/\/Type\s*\/Page\b/.test(object.dictText) && !/\/Type\s*\/Pages\b/.test(object.dictText)) {
        pages.push(object)
      }
    }
    pages.sort((left, right) => left.number - right.number)
    this.pageCache = pages
    return pages
  }

  /** 取页面字典里某个键的值 token（如 /Contents、/Resources）。 */
  pageEntry(page, key) {
    return dictValue(page.dictText, key)
  }
}

/** 从字典文本里取 key 的值（粗粒度，够用即可）。 */
function dictValue(dictText, key) {
  const text = dictText ?? ''
  // 先处理内联字典 << ... >>（要按括号配对取完整内容）
  const sub = new RegExp(`/${key}\\s*<<`).exec(text)
  if (sub) {
    const start = sub.index + sub[0].length - 2
    const end = matchBrackets(text, start)
    if (end > start) return text.slice(start, end + 1)
  }
  const pattern = new RegExp(`/${key}\\s*(\\[[^\\]]*\\]|<[^>]*>|\\d+\\s+\\d+\\s+R|/[^\\s/<>\\[\\]]+|\\d+(?:\\.\\d+)?|true|false)`)
  const match = pattern.exec(text)
  return match ? match[1].trim() : undefined
}

function matchBrackets(text, start) {
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (char === '<' && text[index + 1] === '<') {
      depth += 1
      index += 1
    } else if (char === '>' && text[index + 1] === '>') {
      depth -= 1
      index += 1
      if (depth === 0) return index
    }
  }
  return -1
}

/* ------------------------------ 字体与 CMap ------------------------------ */

function parseToUnicode(text) {
  const map = new Map()
  const charBlocks = text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []
  for (const block of charBlocks) {
    const pairs = block.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g) ?? []
    for (const pair of pairs) {
      const match = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/.exec(pair)
      if (!match) continue
      map.set(match[1].toUpperCase(), utf16be(match[2]))
    }
  }
  const rangeBlocks = text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []
  for (const block of rangeBlocks) {
    const lines = block.split(/(?=<\s*[0-9a-fA-F]{2})/)
    for (const line of lines) {
      const plain = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/.exec(line)
      if (plain) {
        const from = Number.parseInt(plain[1], 16)
        const to = Number.parseInt(plain[2], 16)
        const digits = plain[1].length
        const start = utf16be(plain[3])
        const base = start.codePointAt(0) ?? 0
        for (let code = from; code <= to && code - from < 4096; code += 1) {
          map.set(code.toString(16).toUpperCase().padStart(digits, '0'), String.fromCodePoint(base + (code - from)))
        }
        continue
      }
      const list = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/.exec(line)
      if (!list) continue
      const from = Number.parseInt(list[1], 16)
      const digits = list[1].length
      const items = list[3].match(/<([0-9a-fA-F]*)>/g) ?? []
      items.forEach((item, offset) => {
        const hex = item.slice(1, -1)
        map.set((from + offset).toString(16).toUpperCase().padStart(digits, '0'), utf16be(hex))
      })
    }
  }
  return map
}

function utf16be(hex) {
  let out = ''
  const bytes = hexToBytes(hex)
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    out += String.fromCharCode((bytes[index] << 8) | bytes[index + 1])
  }
  if (bytes.length === 1) out += String.fromCharCode(bytes[0])
  return out
}

/* ------------------------------ 内容流解释 ------------------------------ */

function tokenizeContent(content) {
  const tokens = []
  let index = 0
  const length = content.length
  while (index < length) {
    const char = content[index]
    if (char === '%') {
      while (index < length && content[index] !== '\n' && content[index] !== '\r') index += 1
      continue
    }
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f' || char === '\0') {
      index += 1
      continue
    }
    if (char === '(') {
      let depth = 1
      let end = index + 1
      for (; end < length; end += 1) {
        const current = content[end]
        if (current === '\\') {
          end += 1
          continue
        }
        if (current === '(') depth += 1
        else if (current === ')') {
          depth -= 1
          if (depth === 0) break
        }
      }
      tokens.push({ type: 'string', value: unescapeLiteral(content.slice(index + 1, end)), bytes: null })
      index = end + 1
      continue
    }
    if (char === '<' && content[index + 1] === '<') {
      // 内联字典：跳过
      const end = matchBrackets(content, index)
      index = end === -1 ? index + 2 : end + 1
      continue
    }
    if (char === '<') {
      const end = content.indexOf('>', index)
      const hex = end === -1 ? '' : content.slice(index + 1, end)
      tokens.push({ type: 'string', value: null, bytes: hexToBytes(hex) })
      index = end === -1 ? length : end + 1
      continue
    }
    if (char === '[' || char === ']') {
      tokens.push({ type: char })
      index += 1
      continue
    }
    if (char === '/') {
      let end = index + 1
      while (end < length && !/[\s/<>\[\]()%]/.test(content[end])) end += 1
      tokens.push({ type: 'name', value: content.slice(index + 1, end) })
      index = end
      continue
    }
    // 数字或操作符
    let end = index
    while (end < length && !/[\s/<>\[\]()%]/.test(content[end])) end += 1
    const word = content.slice(index, end)
    index = end === index ? index + 1 : end
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(word)) tokens.push({ type: 'number', value: Number(word) })
    else if (word === 'BI') {
      // 内联图片：跳到 EI
      const ei = content.indexOf('EI', index)
      index = ei === -1 ? length : ei + 2
    } else tokens.push({ type: 'op', value: word })
  }
  return tokens
}

function applyMatrix(matrix, x, y) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  }
}

function translateMatrix(matrix, tx, ty) {
  return [matrix[0], matrix[1], matrix[2], matrix[3], tx * matrix[0] + ty * matrix[2] + matrix[4], tx * matrix[1] + ty * matrix[3] + matrix[5]]
}

function decodeString(token, font) {
  if (token.type === 'string' && token.value !== null) return token.value
  const bytes = token.bytes ?? []
  let out = ''
  const step = font.twoByte ? 2 : 1
  for (let index = 0; index < bytes.length; index += step) {
    const code = step === 2 ? (bytes[index] << 8) | (bytes[index + 1] ?? 0) : bytes[index]
    const hex = code.toString(16).toUpperCase().padStart(step === 2 ? 4 : 2, '0')
    const mapped = font.toUnicode.get(hex)
    if (mapped !== undefined) out += mapped
    else if (!font.twoByte) out += String.fromCharCode(code)
  }
  return out
}

function pageFonts(document, page) {
  const fonts = new Map()
  let resourcesToken = document.pageEntry(page, 'Resources')
  if (document.isRef(resourcesToken)) resourcesToken = document.resolveRef(resourcesToken)
  const resources = document.dictOf(resourcesToken)
  let fontToken = dictValue(resources, 'Font')
  if (document.isRef(fontToken)) fontToken = document.resolveRef(fontToken)
  const fontDict = document.dictOf(fontToken)
  if (!fontDict) return fonts
  const pattern = /\/([A-Za-z0-9_.+#-]+)\s+(\d+)\s+\d+\s+R/g
  let match
  while ((match = pattern.exec(fontDict)) !== null) {
    const fontObject = document.objects.get(Number(match[2]))
    if (!fontObject) continue
    const subtypeMatch = /\/Subtype\s*\/([A-Za-z0-9]+)/.exec(fontObject.dictText)
    const encodingMatch = /\/Encoding\s*\/([A-Za-z0-9-]+)/.exec(fontObject.dictText)
    const twoByte = /Type0/.test(subtypeMatch?.[1] ?? '') || /Identity-[HV]/.test(encodingMatch?.[1] ?? '')
    const toUnicodeToken = dictValue(fontObject.dictText, 'ToUnicode')
    const toUnicode = toUnicodeToken ? parseToUnicode(document.streamText(toUnicodeToken)) : new Map()
    fonts.set(match[1], { twoByte, toUnicode })
  }
  return fonts
}

function pageContent(document, page) {
  let contents = document.pageEntry(page, 'Contents')
  if (!contents) return ''
  if (contents.startsWith('[')) {
    const refs = contents.match(/\d+\s+\d+\s+R/g) ?? []
    return refs.map((ref) => document.streamText(ref)).join('\n')
  }
  return document.streamText(contents)
}

function extractPageText(document, page) {
  const fonts = pageFonts(document, page)
  const tokens = tokenizeContent(pageContent(document, page))
  const out = []
  let matrix = [1, 0, 0, 1, 0, 0]
  let lineMatrix = matrix
  let leading = 0
  let fontSize = 1
  let font = { twoByte: false, toUnicode: new Map() }
  let lastX = 0
  let lastY = 0
  let shown = false
  const stack = []

  const advance = (text) => {
    if (!text) return
    const position = applyMatrix(matrix, 0, 0)
    if (shown) {
      if (Math.abs(position.y - lastY) > Math.max(fontSize * 0.5, 0.5)) out.push('\n')
      else if (position.x - lastX > fontSize * 0.3) out.push(' ')
    }
    out.push(text)
    lastX = position.x
    lastY = position.y
    shown = true
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type === 'op') {
      switch (token.value) {
        case 'q':
          stack.push({ matrix, lineMatrix, leading, fontSize, font })
          break
        case 'Q': {
          const saved = stack.pop()
          if (saved) ({ matrix, lineMatrix, leading, fontSize, font } = saved)
          break
        }
        case 'BT':
          matrix = [1, 0, 0, 1, 0, 0]
          lineMatrix = matrix
          break
        case 'ET':
          shown = true
          break
        case 'Tm': {
          const values = tokens.slice(index - 6, index).map((item) => item.value)
          if (values.length === 6 && values.every((value) => typeof value === 'number')) {
            matrix = values
            lineMatrix = values
          }
          break
        }
        case 'Td':
        case 'TD': {
          const ty = tokens[index - 1]?.value
          const tx = tokens[index - 2]?.value
          if (typeof tx === 'number' && typeof ty === 'number') {
            lineMatrix = translateMatrix(lineMatrix, tx, ty)
            matrix = lineMatrix
            if (token.value === 'TD') leading = -ty
          }
          break
        }
        case 'T*':
          lineMatrix = translateMatrix(lineMatrix, 0, -leading)
          matrix = lineMatrix
          break
        case 'TL':
          if (typeof tokens[index - 1]?.value === 'number') leading = tokens[index - 1].value
          break
        case 'Tf': {
          const name = tokens[index - 2]?.value
          const size = tokens[index - 1]?.value
          if (typeof size === 'number') fontSize = Math.abs(size) || 1
          if (typeof name === 'string' && fonts.has(name)) font = fonts.get(name)
          break
        }
        case 'Tj':
          advance(decodeString(tokens[index - 1], font))
          break
        case "'": {
          if (leading) {
            lineMatrix = translateMatrix(lineMatrix, 0, -leading)
            matrix = lineMatrix
          }
          out.push('\n')
          advance(decodeString(tokens[index - 1], font))
          break
        }
        case '"': {
          if (leading) {
            lineMatrix = translateMatrix(lineMatrix, 0, -leading)
            matrix = lineMatrix
          }
          out.push('\n')
          advance(decodeString(tokens[index - 1], font))
          break
        }
        case 'TJ': {
          // 收集 [ ... ] 里的字符串
          let depth = 0
          for (let cursor = index; cursor >= 0; cursor -= 1) {
            const item = tokens[cursor]
            if (item.type === ']') depth += 1
            else if (item.type === '[') {
              depth -= 1
              if (depth === 0) {
                for (let inner = cursor + 1; inner < index; inner += 1) {
                  if (tokens[inner].type === 'string') advance(decodeString(tokens[inner], font))
                }
                break
              }
            }
          }
          break
        }
        default:
          break
      }
    }
  }
  return out.join('')
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 提取 PDF 文本。
 * @returns {{ text: string, pages: number, scannedPages: number, scanned: boolean }}
 */
export function extractPdfText(buffer) {
  if (!isPdfBuffer(buffer)) throw new PdfError('这不是有效的 PDF 文件（缺少 %PDF- 文件头）')
  const document = new PdfDocument(buffer)
  const pages = document.pages()
  if (pages.length === 0) throw new PdfError('这个 PDF 里没有找到页面对象')
  const parts = []
  let blankPages = 0
  let visibleChars = 0
  for (const page of pages) {
    const text = extractPageText(document, page).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    const chars = text.replace(/\s/g, '').length
    if (chars < 20) blankPages += 1
    visibleChars += chars
    if (text) parts.push(text)
  }
  const text = parts.join('\n\n')
  const scanned = visibleChars < pages.length * 3
  if (scanned) {
    const error = new PdfError(
      `这个 PDF 的 ${pages.length} 页几乎没有文本层（扫描件/图片版，只读到 ${visibleChars} 个字），需要 OCR 才能索引。`,
    )
    error.scanned = true
    error.pageCount = pages.length
    throw error
  }
  return { text, pages: pages.length, scannedPages: blankPages, scanned }
}
