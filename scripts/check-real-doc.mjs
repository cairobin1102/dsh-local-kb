import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { extractDocText } from '../lib/doc.js'
import { extractDocxText } from '../lib/docx.js'

const OLE_MAGIC = 0xe011cfd0
const root = 'F:\\领导讲话知识库'

function walk(directory, collected = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.dsh-kb') continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(absolute, collected)
    else if (/\.(docx|doc|wps)$/i.test(entry.name)) collected.push(absolute)
  }
  return collected
}

const all = walk(root).filter((file) => {
  const buffer = readFileSync(file)
  return buffer.length >= 4 && buffer.readUInt32LE(0) === OLE_MAGIC
})

console.log(`OLE2 二进制 Word 文档：${all.length} 个`)
const failures = []
const extracted = []
for (const file of all) {
  const started = Date.now()
  try {
    const text = extractDocText(readFileSync(file))
    extracted.push({ file, text, ms: Date.now() - started })
  } catch (error) {
    failures.push({ file, message: String(error.message) })
  }
}

const cjk = (text) => (text.match(/[\u3400-\u9fff]/g) ?? []).length
const totalChars = extracted.reduce((sum, item) => sum + item.text.length, 0)
console.log(`成功 ${extracted.length}，失败 ${failures.length}，共 ${totalChars} 字，平均 ${Math.round(totalChars / Math.max(1, extracted.length))} 字/篇`)
console.log(`平均耗时 ${Math.round(extracted.reduce((sum, item) => sum + item.ms, 0) / Math.max(1, extracted.length))} ms`)

const thin = extracted.filter((item) => item.text.length < 100 || cjk(item.text) < 20)
console.log(`可疑（少于 100 字或汉字少于 20）：${thin.length}`)
for (const item of thin.slice(0, 10)) {
  console.log('  -', path.relative(root, item.file), item.text.length, '字 /', cjk(item.text), '汉字')
}

if (failures.length > 0) {
  console.log('失败明细：')
  for (const item of failures) console.log('  -', path.relative(root, item.file), '::', item.message)
}

console.log('\n抽样：')
for (const item of extracted.filter((_, index) => index % Math.max(1, Math.floor(extracted.length / 4)) === 0).slice(0, 5)) {
  console.log('---')
  console.log(path.relative(root, item.file), `(${item.text.length} 字)`)
  console.log(item.text.slice(0, 180).replace(/\n/g, ' ⏎ '))
}
