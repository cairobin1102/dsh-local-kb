import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { libraryId, normalizeConfig } from '../lib/config.js'
import { createLibraries } from '../lib/libraries.js'

const results = []
function check(name, fn) {
  results.push({ name, fn })
}

function pass(name) {
  console.log(`ok   ${name}`)
}

async function withTemp(prefix, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function twoLibraries(alpha, beta) {
  return normalizeConfig({
    embedding: { provider: 'none' },
    libraries: [
      { name: '甲库', root: alpha },
      { name: '乙库', root: beta },
    ],
  })
}

check('libraries：配置里每个文件夹各自成库，id 稳定且默认索引目录在库根下', () => {
  const alpha = path.join('C:', 'kb-alpha')
  const beta = path.join('C:', 'kb-beta')
  const options = twoLibraries(alpha, beta)
  assert.equal(options.libraries.length, 2)
  assert.equal(options.libraries[0].name, '甲库')
  assert.equal(options.libraries[0].indexDir, path.join(alpha, '.dsh-kb'))
  assert.equal(options.libraries[0].id, libraryId(alpha))
  assert.equal(options.libraries[1].id, libraryId(beta))
  // Legacy single-folder fields still resolve to the first library.
  assert.equal(options.root, alpha)
})

check('libraries：重复添加同一个文件夹会被去重，旧的 root 字段也当作一条库', () => {
  const same = path.join('C:', 'kb-same')
  const options = normalizeConfig({ root: same, libraries: [{ name: '重复', root: `${same}\\` }] })
  assert.equal(options.libraries.length, 1)
})

check('libraries：status / listDocuments 会聚合所有库并标出库名', async () => {
  await withTemp('dsh-kb-libs-', async (base) => {
    const alpha = path.join(base, 'alpha')
    const beta = path.join(base, 'beta')
    await mkdir(alpha, { recursive: true })
    await mkdir(beta, { recursive: true })
    await writeFile(path.join(alpha, 'a.md'), '# 甲\n\n乡村振兴的第一份材料。\n', 'utf8')
    await writeFile(path.join(beta, 'b.md'), '# 乙\n\n乡村振兴的第二份材料。\n', 'utf8')

    const libraries = createLibraries(twoLibraries(alpha, beta))
    await libraries.rebuild()

    const status = await libraries.status()
    assert.equal(status.libraries.length, 2)
    assert.equal(status.files, 2)
    assert.ok(status.chunks >= 2)
    assert.deepEqual(
      status.libraries.map((item) => item.name).sort(),
      ['乙库', '甲库'],
    )

    const docs = await libraries.listDocuments()
    assert.equal(docs.files.length, 2)
    assert.ok(docs.files.every((file) => file.library?.name))
    assert.equal(docs.libraries.length, 2)

    const one = await libraries.status({ library: '甲库' })
    assert.equal(one.library.name, '甲库')
    assert.equal(one.files, 1)

    // The id is accepted as well, and an unknown selector says what is available.
    assert.equal((await libraries.status({ library: libraryId(beta) })).library.name, '乙库')
    await assert.rejects(() => libraries.status({ library: '不存在的库' }), /没有这个知识库/)
  })
})

check('libraries：检索跨库合并，可按库名筛，读取同名文件时要求指定库', async () => {
  await withTemp('dsh-kb-libs-search-', async (base) => {
    const alpha = path.join(base, 'alpha')
    const beta = path.join(base, 'beta')
    await mkdir(alpha, { recursive: true })
    await mkdir(beta, { recursive: true })
    await writeFile(path.join(alpha, '讲话.md'), '# 甲\n\n乡村振兴要抓好干部培训。\n', 'utf8')
    await writeFile(path.join(beta, '讲话.md'), '# 乙\n\n乡村振兴要抓好产业项目。\n', 'utf8')

    const libraries = createLibraries(twoLibraries(alpha, beta))
    await libraries.rebuild()

    const merged = await libraries.search({ query: '乡村振兴', limit: 5 })
    assert.equal(merged.libraries.length, 2)
    assert.equal(merged.results.length, 2)
    assert.ok(merged.results.every((item) => item.library?.id))
    assert.ok(merged.results.every((item) => item.library?.name))

    const scoped = await libraries.search({ library: '甲库', query: '乡村振兴', limit: 5 })
    assert.equal(scoped.results.length, 1)
    assert.equal(scoped.results[0].library.name, '甲库')

    await assert.rejects(() => libraries.readDocument({ filePath: '讲话.md' }), /多个知识库都有这个文件/)
    const read = await libraries.readDocument({ library: '乙库', filePath: '讲话.md' })
    assert.match(read.text, /产业项目/)
    assert.equal(read.library.name, '乙库')
  })
})

check('libraries：没有配置任何文件夹时给出可操作的提示，不会崩', async () => {
  const libraries = createLibraries(normalizeConfig({ embedding: { provider: 'none' } }))
  const status = await libraries.status()
  assert.equal(status.configured, false)
  assert.deepEqual(status.libraries, [])
  await assert.rejects(() => libraries.search({ query: '任意' }), /尚未配置知识库目录/)
  await assert.rejects(() => libraries.rebuild(), /尚未配置知识库目录/)
})

let failed = 0
for (const { name, fn } of results) {
  try {
    await fn()
    pass(name)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exitCode = 1
