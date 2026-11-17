const OLE_MAGIC = 0xe011cfd0
const ENDOFCHAIN = 0xfffffffe
const FREESECT = 0xffffffff
const MAXREGSECT = 0xfffffffa

function sectorBase(sector, sectorSize) {
  return (sector + 1) * sectorSize
}

/** Minimal OLE2 compound-document reader: just enough to reach the Word streams. */
function openCompoundFile(buffer) {
  if (buffer.length < 512 || buffer.readUInt32LE(0) !== OLE_MAGIC) {
    throw new Error('不是 OLE2 复合文档')
  }
  const sectorSize = 1 << buffer.readUInt16LE(0x1e)
  const miniSectorSize = 1 << buffer.readUInt16LE(0x20)
  const fatSectorCount = buffer.readUInt32LE(0x2c)
  const firstDirectorySector = buffer.readUInt32LE(0x30)
  const miniCutoff = buffer.readUInt32LE(0x38)
  const firstMiniFatSector = buffer.readUInt32LE(0x3c)
  const firstDifatSector = buffer.readUInt32LE(0x44)

  const difat = []
  for (let index = 0; index < 109; index += 1) difat.push(buffer.readUInt32LE(0x4c + index * 4))
  let difatSector = firstDifatSector
  for (let guard = 0; difatSector < MAXREGSECT && guard < 4096; guard += 1) {
    const base = sectorBase(difatSector, sectorSize)
    if (base + 4 > buffer.length) break
    const slots = sectorSize / 4
    for (let index = 0; index < slots - 1; index += 1) {
      if (base + (index + 1) * 4 > buffer.length) break
      difat.push(buffer.readUInt32LE(base + index * 4))
    }
    difatSector = buffer.readUInt32LE(base + (slots - 1) * 4)
  }

  const fat = []
  for (let index = 0; index < fatSectorCount; index += 1) {
    const sector = difat[index]
    if (sector === undefined || sector >= MAXREGSECT) continue
    const base = sectorBase(sector, sectorSize)
    if (base + 4 > buffer.length) break
    for (let slot = 0; slot < sectorSize / 4; slot += 1) {
      if (base + (slot + 1) * 4 > buffer.length) break
      fat.push(buffer.readUInt32LE(base + slot * 4))
    }
  }

  function readChain(start, size) {
    const chunks = []
    let sector = start
    for (let guard = 0; sector < MAXREGSECT && sector < fat.length && guard < 100000; guard += 1) {
      const base = sectorBase(sector, sectorSize)
      chunks.push(buffer.subarray(base, Math.min(base + sectorSize, buffer.length)))
      sector = fat[sector]
    }
    const joined = Buffer.concat(chunks)
    return size === undefined ? joined : joined.subarray(0, size)
  }

  const entries = []
  let directorySector = firstDirectorySector
  for (let guard = 0; directorySector < MAXREGSECT && directorySector < fat.length && guard < 4096; guard += 1) {
    const base = sectorBase(directorySector, sectorSize)
    for (let index = 0; index < sectorSize / 128; index += 1) {
      const at = base + index * 128
      if (at + 128 > buffer.length) break
      const nameBytes = buffer.readUInt16LE(at + 0x40)
      const name = nameBytes > 2 ? buffer.toString('utf16le', at, at + nameBytes - 2) : ''
      entries.push({
        name,
        type: buffer.readUInt8(at + 0x42),
        startSector: buffer.readUInt32LE(at + 0x74),
        size: buffer.readUInt32LE(at + 0x78),
      })
    }
    directorySector = fat[directorySector]
  }

  const root = entries.find((entry) => entry.type === 5)
  const miniStream = root ? readChain(root.startSector, root.size) : Buffer.alloc(0)
  const miniFat = []
  if (firstMiniFatSector < MAXREGSECT) {
    const raw = readChain(firstMiniFatSector)
    for (let offset = 0; offset + 4 <= raw.length; offset += 4) miniFat.push(raw.readUInt32LE(offset))
  }

  function readMiniChain(start, size) {
    const chunks = []
    let sector = start
    for (let guard = 0; sector < MAXREGSECT && sector < miniFat.length && guard < 100000; guard += 1) {
      const base = sector * miniSectorSize
      chunks.push(miniStream.subarray(base, Math.min(base + miniSectorSize, miniStream.length)))
      sector = miniFat[sector]
    }
    return Buffer.concat(chunks).subarray(0, size)
  }

  const streams = new Map()
  for (const entry of entries) {
    if (entry.type !== 2 || entry.name === '') continue
    try {
      streams.set(
        entry.name,
        entry.size < miniCutoff && entry.startSector !== ENDOFCHAIN
          ? readMiniChain(entry.startSector, entry.size)
          : readChain(entry.startSector, entry.size),
      )
    } catch {
      // A damaged stream must not stop the others from being read.
    }
  }

  return { streams }
}

/** Word stores paragraph marks, cells and breaks as control characters. */
function cleanWordText(raw) {
  let text = String(raw ?? '')
    .replace(/\x13[\s\S]*?\x14/g, '')
    .replace(/[\x00-\x06\x08\x0e\x0f\x10-\x12\x16-\x1f]/g, '')
    .replace(/[\x07\r\x0b\x0c]/g, '\n')
    .replace(/\x1e/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return text
}

/** Read a Word 97-2003 piece table and decode the referenced text runs. */
function readPieceTable(word, table) {
  const fcClx = word.readUInt32LE(0x01a2)
  const lcbClx = word.readUInt32LE(0x01a6)
  if (lcbClx === 0 || fcClx + lcbClx > table.length) return null

  const clx = table.subarray(fcClx, fcClx + lcbClx)
  let offset = 0
  let pieces = null
  while (offset < clx.length) {
    const kind = clx.readUInt8(offset)
    if (kind === 0x01) {
      const length = clx.readUInt16LE(offset + 1)
      offset += 3 + length
      continue
    }
    if (kind === 0x02) {
      const length = clx.readUInt32LE(offset + 1)
      pieces = clx.subarray(offset + 5, offset + 5 + length)
      break
    }
    break
  }
  if (!pieces || pieces.length < 12) return null

  const count = Math.floor((pieces.length - 4) / 12)
  const limits = []
  for (let index = 0; index <= count; index += 1) limits.push(pieces.readUInt32LE(index * 4))

  let text = ''
  const pcdStart = 4 * (count + 1)
  for (let index = 0; index < count; index += 1) {
    const characters = limits[index + 1] - limits[index]
    if (characters <= 0) continue
    const pcd = pcdStart + index * 8
    if (pcd + 8 > pieces.length) break
    const rawFc = pieces.readUInt32LE(pcd + 2)
    if ((rawFc & 0x40000000) !== 0) {
      const fc = (rawFc & 0x3fffffff) >> 1
      text += word.toString('latin1', fc, Math.min(fc + characters, word.length))
    } else {
      text += word.toString('utf16le', Math.min(rawFc, word.length), Math.min(rawFc + characters * 2, word.length))
    }
  }
  return text
}

/**
 * Extract text from a legacy Word binary document (.doc, and .wps files that wrap one).
 * Dependency-free: read the OLE2 streams, follow the FIB piece table, decode the runs.
 */
export function extractDocText(buffer) {
  const { streams } = openCompoundFile(buffer)
  const word = streams.get('WordDocument')
  if (!word) throw new Error('OLE2 文档里没有 WordDocument 流（可能是 Excel 表格或其他格式）')
  if (word.length < 0x200 || word.readUInt16LE(0) !== 0xa5ec) {
    throw new Error('Word 文档头无效（可能不是 Word 97-2003 格式）')
  }

  const flags = word.readUInt16LE(0x0a)
  const tableName = (flags & 0x0200) !== 0 ? '1Table' : '0Table'
  const table = streams.get(tableName) ?? streams.get('0Table') ?? streams.get('1Table')
  if (!table) throw new Error('Word 文档缺少表格流，无法读取正文')

  const pieceText = readPieceTable(word, table)
  if (pieceText === null) throw new Error('Word 文档没有可用片段表（可能是 Word 95 及更早格式）')

  const text = cleanWordText(pieceText)
  if (text === '') throw new Error('Word 文档正文为空')
  return text
}
