import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const INDEX_VERSION = 1

async function writeAtomic(filePath, data) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, filePath)
}

/** Index files: `index.json` (meta + chunks) and `vectors.bin` (Float32 rows, normalized). */
export function createStore(indexDir) {
  const indexPath = path.join(indexDir, 'index.json')
  const vectorsPath = path.join(indexDir, 'vectors.bin')

  async function read() {
    let raw
    try {
      raw = await readFile(indexPath, 'utf8')
    } catch {
      return null
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (parsed?.version !== INDEX_VERSION || !Array.isArray(parsed.chunks) || !parsed.meta) return null

    const dim = Number(parsed.meta?.embedding?.dim) || 0
    let vectors = null
    if (dim > 0 && parsed.chunks.length > 0) {
      try {
        const buffer = await readFile(vectorsPath)
        const expected = parsed.chunks.length * dim * 4
        if (buffer.byteLength === expected) {
          const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
          vectors = new Float32Array(bytes)
        }
      } catch {
        vectors = null
      }
    }
    return {
      meta: parsed.meta,
      chunks: parsed.chunks,
      vectors,
      dim: vectors ? dim : 0,
    }
  }

  async function write({ meta, chunks, vectors, dim }) {
    await mkdir(indexDir, { recursive: true })
    await writeAtomic(indexPath, JSON.stringify({ version: INDEX_VERSION, meta, chunks }))
    if (vectors && dim > 0 && chunks.length > 0) {
      const bytes = Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)
      await writeAtomic(vectorsPath, bytes)
    } else {
      await unlink(vectorsPath).catch(() => {})
    }
  }

  return { paths: { indexPath, vectorsPath }, read, write, version: INDEX_VERSION }
}
