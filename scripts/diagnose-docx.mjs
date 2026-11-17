import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { extractDocxText } from '../lib/docx.js'

const root = 'F:\\领导讲话知识库'

function walk(directory, collected = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.dsh-kb') continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(absolute, collected)
    else if (entry.name.toLowerCase().endsWith('.docx')) collected.push(absolute)
  }
  return collected
}

function magic(buffer) {
  const head = buffer.subarray(0, 8)
  const hex = [...head].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
  const ascii = [...head].map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join('')
  return `${hex} | ${ascii}`
}

/** Independent central-directory dump, to separate "not a zip" from "zip without document.xml". */
function zipNames(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 0xffff); offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue
    const total = buffer.readUInt16LE(offset + 10)
    let position = buffer.readUInt32LE(offset + 16)
    const names = []
    for (let index = 0; index < total; index += 1) {
      if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== 0x02014b50) break
      const nameLength = buffer.readUInt16LE(position + 28)
      const extraLength = buffer.readUInt16LE(position + 30)
      const commentLength = buffer.readUInt16LE(position + 32)
      names.push(buffer.toString('utf8', position + 46, position + 46 + nameLength))
      position += 46 + nameLength + extraLength + commentLength
    }
    return names
  }
  return null
}

const all = walk(root)
const failures = []
for (const file of all) {
  const buffer = readFileSync(file)
  try {
    extractDocxText(buffer)
  } catch (error) {
    failures.push({ file, buffer, message: String(error.message) })
  }
}

console.log(`docx 总数 ${all.length}，失败 ${failures.length}`)
const kinds = new Map()
for (const item of failures) {
  const key = item.message
  kinds.set(key, (kinds.get(key) ?? 0) + 1)
}
console.log('失败类型：')
for (const [message, count] of kinds) console.log(`  ${count} × ${message}`)

for (const item of failures.slice(0, 40)) {
  const names = zipNames(item.buffer)
  console.log('---')
  console.log('路径：', path.relative(root, item.file))
  console.log('大小：', (item.buffer.length / 1024).toFixed(0), 'KB | 魔数：', magic(item.buffer))
  console.log('错误：', item.message)
  console.log('zip 条目：', names === null ? '不是 zip' : `${names.length} 个${names.some((name) => name.includes('document')) ? '，含 document 相关' : ''}`)
  if (names) console.log('  前 8 项：', names.slice(0, 8).join(' | '))
}
