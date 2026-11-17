import assert from 'node:assert/strict'
import {
  buildPacket,
  buildQueries,
  classifySnippet,
  dedupeCards,
  extractRegion,
  extractYear,
  groupCards,
  splitOutline,
} from '../lib/material.js'
import { normalizeConfig } from '../lib/config.js'
import { createToolDefinitions } from '../lib/tools.js'

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name}\n     ${error?.message ?? error}`)
  }
}

const REGIONS = {
  local: ['宁德市', '福安市', '寿宁县', '蕉城区'],
  foreign: ['苏州市', '苏州', '泰州', '江苏'],
}

const OPTIONS = normalizeConfig({ root: 'F:\\库', embedding: { provider: 'none' } })

await test('年份：文件名优先，其次正文最大年份，最后规划期，都认不出就标未知', () => {
  assert.deepEqual(extractYear({ path: '01-经济建设/20141218_在全市大会上的讲话.docx', text: '2019年' }), {
    value: 2014,
    source: '文件名',
    label: '2014 年',
  })
  const fromText = extractYear({ path: '2022年全市海洋经济大会讲话.docx', text: '2016年…2019年…' })
  assert.equal(fromText.value, 2022)
  assert.equal(fromText.source, '文件名')

  const noName = extractYear({ path: '讲话汇编/某次讲话.docx', text: '2018年全市完成投资' })
  assert.equal(noName.value, 2018)
  assert.equal(noName.source, '正文')

  const period = extractYear({ path: '规划.docx', text: '锚定“十五五”目标' })
  assert.equal(period.value, 2026)

  const unknown = extractYear({ path: '讲话.docx', text: '没有提到年份' })
  assert.equal(unknown.value, null)
  assert.equal(unknown.source, '未知')
})

await test('地域：路径优先；正文里本地占多数才算本地；外地的标 foreign', () => {
  const pathLocal = extractRegion({ path: '04-社会建设/乡村振兴/2019_福安市…讲话.docx', text: '' }, REGIONS)
  assert.equal(pathLocal.foreign, false)
  assert.equal(pathLocal.level, '县区')
  assert.equal(pathLocal.name, '福安市')

  const pathForeign = extractRegion({ path: '01-经济建设/20221011_在调度苏州市产业链…讲话.docx', text: '' }, REGIONS)
  assert.equal(pathForeign.foreign, true)
  assert.equal(pathForeign.level, '外地')

  const textLocalWins = extractRegion(
    { path: '某讲话.docx', text: '寿宁县的做法很好，苏州也有类似经验，但寿宁县更扎实，寿宁县还入选试点。' },
    REGIONS,
  )
  assert.equal(textLocalWins.foreign, false)
  assert.equal(textLocalWins.name, '寿宁县')

  const textForeignOnly = extractRegion({ path: '某讲话.docx', text: '泰州创客峰会的经验值得学习' }, REGIONS)
  assert.equal(textForeignOnly.foreign, true)

  const cityLevel = extractRegion({ path: '全市经济工作会议/讲话.docx', text: '全市上下要抓落实' }, REGIONS)
  assert.equal(cityLevel.level, '市级')
  assert.equal(cityLevel.foreign, false)

  const unmarked = extractRegion({ path: '某讲话.docx', text: '要狠抓工作落实' }, REGIONS)
  assert.equal(unmarked.level, '未标注')

  // 「乡镇」「城乡」这类词不能被当成乡镇名。
  const townWord = extractRegion({ path: '某讲话.docx', text: '兼顾，城乡融合发展的乡镇一级也要动起来' }, REGIONS)
  assert.notEqual(townWord.level, '乡镇')
  const realTown = extractRegion({ path: '某讲话.docx', text: '霞浦县三沙镇的做法值得推广，' }, REGIONS)
  assert.equal(realTown.level, '乡镇')
  assert.equal(realTown.name, '三沙镇')
})

await test('四类归集：数据 / 政策表述 / 金句 / 本地事例，主类目取信号最强的那个', () => {
  assert.equal(
    classifySnippet('全市规上工业产值达到1200亿元，同比增长8.5%，位居全省前列').category,
    'data',
  )
  assert.equal(
    classifySnippet('按照《福建省文化和旅游发展“十四五”规划》的部署要求，抓好落实').category,
    'policy',
  )
  assert.equal(
    classifySnippet('一是要坚持规划引领，二是要坚持项目带动，三是要坚持群众主体').category,
    'quote',
  )
  assert.equal(
    classifySnippet('福安市入选全国乡村旅游重点村，建成美丽乡村示范点12个').category,
    'case',
  )
  assert.equal(classifySnippet('今天天气不错').category, 'other')
  assert.ok(classifySnippet('福安市建成示范点12个').tags.length >= 0)
})

await test('提纲拆条：去掉「一、」「1.」「（一）」这类编号，忽略过短行', () => {
  const points = splitOutline('一、文旅融合的现状\n2. 存在的主要问题\n（三）下一步举措\n\n好')
  assert.deepEqual(points, ['文旅融合的现状', '存在的主要问题', '下一步举措'])
})

await test('查询编排：主题与每条提纲都走语义+关键词，能定向的再加 path_prefix，且同一查询不重复', () => {
  const queries = buildQueries({ topic: '文旅融合', points: ['乡村振兴的产业支撑', '营商环境'] })
  const modes = queries.filter((item) => item.query === '文旅融合').map((item) => `${item.mode}|${item.pathPrefix}`)
  assert.ok(modes.includes('semantic|'))
  assert.ok(modes.includes('keyword|'))
  // 提纲点「营商环境」能定向到经济目录；主题「文旅融合」应定向到文化目录。
  const prefixes = queries.filter((item) => item.pathPrefix !== '').map((item) => item.pathPrefix)
  assert.ok(prefixes.includes('01-经济建设'))
  assert.ok(prefixes.includes('03-文化建设'))

  const keys = queries.map((item) => `${item.mode}|${item.pathPrefix}|${item.query}`)
  assert.equal(new Set(keys).size, keys.length)
})

await test('去重：同一文件 ±6 行只留分数最高的一条，跨文件不误删', () => {
  const cards = [
    { path: 'a.docx', startLine: 10, score: 0.6, library: { id: 'l1' } },
    { path: 'a.docx', startLine: 14, score: 0.9, library: { id: 'l1' } },
    { path: 'a.docx', startLine: 40, score: 0.5, library: { id: 'l1' } },
    { path: 'b.docx', startLine: 11, score: 0.7, library: { id: 'l1' } },
  ]
  const kept = dedupeCards(cards)
  assert.equal(kept.length, 3)
  assert.ok(kept.some((card) => card.path === 'a.docx' && card.startLine === 14))
  assert.ok(!kept.some((card) => card.path === 'a.docx' && card.startLine === 10))
})

await test('分类上限：每类最多 maxPerCategory 张，其余进不了结果集', () => {
  const cards = Array.from({ length: 5 }, (_, index) => ({
    category: 'data',
    path: `d${index}.docx`,
    startLine: 1,
  }))
  const grouped = groupCards(cards, 3)
  assert.equal(grouped.groups.data.length, 3)
})

await test('buildPacket：三通道并发检索、四类归集，卡片带路径/行号/年份/地域', async () => {
  const calls = []
  const kb = {
    async search({ query, mode, pathPrefix }) {
      calls.push({ query, mode, pathPrefix })
      return {
        mode: mode === 'semantic' ? 'semantic' : 'keyword',
        total: 1,
        results: [
          {
            path: '01-经济建设/20221011_在调度苏州市产业链…讲话.docx',
            heading: '20221011',
            startLine: 5,
            endLine: 9,
            snippet: '苏州市规上工业产值达到1200亿元，同比增长8.5%',
            score: 0.83,
            library: { id: 'lib-1', name: '领导讲话知识库' },
          },
          {
            path: '04-社会建设/乡村振兴/2019_福安市…讲话.docx',
            heading: '',
            startLine: 20,
            endLine: 22,
            snippet: '福安市入选全国乡村旅游重点村，建成示范点12个',
            score: 0.77,
            library: { id: 'lib-1', name: '领导讲话知识库' },
          },
        ],
      }
    },
  }

  const packet = await buildPacket({
    kb,
    options: OPTIONS,
    topic: '文旅融合与乡村振兴',
    outline: '一、产业支撑\n二、品牌建设',
    perChannel: 6,
  })

  assert.equal(packet.ok, true)
  assert.ok(packet.queries.length >= 4)
  assert.ok(calls.every((call) => call.mode === 'semantic' || call.mode === 'keyword'))
  assert.ok(packet.stats.candidates > 0)
  assert.ok(packet.stats.foreign >= 1, '苏州材料应被标成外地')

  const all = Object.values(packet.groups).flat()
  assert.ok(all.length > 0)
  for (const card of all) {
    assert.equal(typeof card.path, 'string')
    assert.equal(typeof card.startLine, 'number')
    assert.ok(card.year && 'value' in card.year && 'source' in card.year)
    assert.ok(card.region && typeof card.region.level === 'string')
  }
  const foreign = all.find((card) => card.region.foreign)
  assert.equal(foreign.region.name, '苏州市')
  assert.equal(foreign.year.value, 2022)
  assert.equal(foreign.year.source, '文件名')
})

await test('buildPacket：既没主题也没提纲时报可读错误', async () => {
  await assert.rejects(
    () => buildPacket({ kb: { async search() {} }, options: OPTIONS, topic: '  ', outline: '' }),
    /缺少检索内容/,
  )
})

await test('kb_packet 工具：输出带年份、地域与核对提示', async () => {
  const kb = {
    async search() {
      return {
        mode: 'semantic',
        total: 1,
        results: [
          {
            path: '04-社会建设/乡村振兴/2019_福安市…讲话.docx',
            startLine: 12,
            endLine: 14,
            snippet: '福安市入选全国乡村旅游重点村，建成示范点12个',
            score: 0.9,
            library: { id: 'lib-1', name: '领导讲话知识库' },
          },
          {
            path: '讲话汇编/某次讲话.docx',
            startLine: 3,
            endLine: 3,
            snippet: '要坚持规划引领',
            score: 0.4,
            library: { id: 'lib-1', name: '领导讲话知识库' },
          },
        ],
      }
    },
  }
  const definitions = createToolDefinitions(kb, OPTIONS)
  const packetTool = definitions.find((definition) => definition.name === 'kb_packet')
  assert.ok(packetTool)
  const text = await packetTool.execute({ topic: '乡村振兴' }, {})
  assert.match(text, /素材包/)
  assert.match(text, /2019 年（文件名）/)
  assert.match(text, /县区·福安市/)
  assert.match(text, /年份未知/)
  assert.match(text, /kb_read/)
})

console.log(`\n${passed}/${passed + failures.length} passed`)
if (failures.length > 0) process.exitCode = 1
