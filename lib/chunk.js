const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/
const MAX_CHUNK_CHARS = 6000

/**
 * Split one document into retrievable chunks that keep their original line numbers.
 * Markdown headings start a new chunk group; long groups slide with a character overlap.
 */
export function chunkText(text, { path: filePath, chunkSize, chunkOverlap }) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const chunks = []
  let heading = ''
  let buffer = []
  let bufferChars = 0
  let fresh = false

  const emit = () => {
    if (!fresh || buffer.length === 0) return
    const content = buffer.map((line) => line.text).join('\n')
    if (content.trim() === '') return
    chunks.push({
      path: filePath,
      heading,
      startLine: buffer[0].number,
      endLine: buffer[buffer.length - 1].number,
      text: content.length > MAX_CHUNK_CHARS ? content.slice(0, MAX_CHUNK_CHARS) : content,
    })
  }

  const flush = (dropCarry) => {
    emit()
    fresh = false
    if (dropCarry || chunkOverlap <= 0) {
      buffer = []
      bufferChars = 0
      return
    }
    const carry = []
    let carryChars = 0
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      const length = buffer[index].text.length + 1
      if (carryChars + length > chunkOverlap) break
      carry.unshift(buffer[index])
      carryChars += length
    }
    // A carry that equals the whole buffer would re-emit the same text forever.
    if (carry.length >= buffer.length) {
      carry.shift()
      carryChars = carry.reduce((total, line) => total + line.text.length + 1, 0)
    }
    buffer = carry
    bufferChars = carryChars
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const number = index + 1
    const match = HEADING.exec(line)

    if (match) {
      flush(true)
      heading = match[1].trim()
      buffer.push({ number, text: line })
      bufferChars += line.length + 1
      fresh = true
      continue
    }

    // A single pathological line would otherwise become one oversized chunk.
    if (line.length > chunkSize * 4) {
      flush(true)
      for (let offset = 0; offset < line.length; offset += chunkSize) {
        chunks.push({
          path: filePath,
          heading,
          startLine: number,
          endLine: number,
          text: line.slice(offset, offset + chunkSize),
        })
      }
      continue
    }

    buffer.push({ number, text: line })
    bufferChars += line.length + 1
    fresh = true
    if (bufferChars >= chunkSize) flush(false)
  }

  flush(true)
  return chunks
}
