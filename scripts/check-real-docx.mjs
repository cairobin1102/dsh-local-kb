import { readFileSync, readdirSync, statSync } from 'node:fs'
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

const all = walk(root)
console.log('docx 总数：', all.length)
const picks = [all[0], all[Math.floor(all.length / 2)], all[all.length - 1]]

for (const file of picks) {
  const started = Date.now()
  const text = extractDocxText(readFileSync(file))
  const elapsed = Date.now() - started
  const bytes = statSync(file).size
  console.log('---')
  console.log(`文件 ${(bytes / 1024).toFixed(0)} KB -> 正文 ${text.length} 字 / ${text.split('\n').length} 行，用时 ${elapsed} ms`)
  console.log('路径：', path.relative(root, file))
  console.log('前 160 字：', text.slice(0, 160).replace(/\n/g, ' ⏎ '))
  console.log('含 XML 残留：', /<w:|xmlns|w:pPr/.test(text), '| 含替换字符：', text.includes('\uFFFD'))
}

