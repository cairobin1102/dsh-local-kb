import { readFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'

const file = process.argv[2]
if (!file) {
  console.error('用法: node scripts/inspect-pdf.mjs <file.pdf>')
  process.exit(1)
}

const buffer = await readFile(file)
const latin = buffer.toString('latin1')

function count(pattern) {
  return (latin.match(pattern) ?? []).length
}

console.log(`文件: ${file}`)
console.log(`大小: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`)
console.log(`版本头: ${latin.slice(0, 9).trim()}`)
console.log(`对象数(/obj): ${count(/\d+\s+\d+\s+obj/g)}`)
console.log(`/Type /Page: ${count(/\/Type\s*\/Page[^s]/g)}`)
console.log(`/Type /Pages: ${count(/\/Type\s*\/Pages/g)}`)
console.log(`/Font: ${count(/\/Font/g)}`)
console.log(`/ToUnicode: ${count(/\/ToUnicode/g)}`)
console.log(`/Image: ${count(/\/Subtype\s*\/Image/g)}`)
console.log(`DCTDecode(JPEG): ${count(/DCTDecode/g)}`)
console.log(`JBIG2Decode: ${count(/JBIG2Decode/g)}`)
console.log(`CCITTFaxDecode: ${count(/CCITTFaxDecode/g)}`)
console.log(`/ObjStm: ${count(/\/Type\s*\/ObjStm/g)}`)
console.log(`/Encrypt: ${count(/\/Encrypt/g)}`)

// 解压所有 Flate 流，统计文本操作符
let streams = 0
let inflated = 0
let failures = 0
let textOps = 0
let sample = []
let index = 0
for (;;) {
  const start = latin.indexOf('stream', index)
  if (start === -1) break
  const dictStart = latin.lastIndexOf('<<', start)
  const dict = latin.slice(dictStart, start)
  let dataStart = start + 'stream'.length
  if (latin[dataStart] === '\r') dataStart += 1
  if (latin[dataStart] === '\n') dataStart += 1
  const end = latin.indexOf('endstream', dataStart)
  if (end === -1) break
  const raw = buffer.subarray(dataStart, end)
  streams += 1
  index = end + 'endstream'.length
  if (!/FlateDecode/.test(dict)) continue
  try {
    const text = inflateSync(raw).toString('latin1')
    inflated += 1
    const ops = (text.match(/\b(Tj|TJ|'|")\b/g) ?? []).length
    textOps += ops
    if (ops > 0 && sample.length < 3) {
      const bt = text.indexOf('BT')
      sample.push(text.slice(bt, bt + 400).replace(/\s+/g, ' '))
    }
  } catch {
    failures += 1
  }
}

console.log(`stream 总数: ${streams}，Flate 解压成功: ${inflated}，失败: ${failures}`)
console.log(`文本操作符(Tj/TJ/'/") 合计: ${textOps}`)
for (const [i, s] of sample.entries()) console.log(`\n样例 ${i + 1}: ${s}`)
