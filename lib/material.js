/**
 * 素材包生成器（packet）：把「一句主题 + 一份提纲」变成按 金句 / 数据 / 政策表述 / 本地事例
 * 归集的卡片。它不生成内容，只做「换角度检索 → 去重 → 归集 → 补元数据」这一段机械活，
 * 每张卡片强制带 出处处（相对路径 + 行号）、年份、地域层级，避免引用外地经验或往年成绩。
 */

const CATEGORIES = ['quote', 'data', 'policy', 'case']
const CATEGORY_LABELS = { quote: '金句', data: '数据', policy: '政策表述', case: '本地事例', other: '其他' }

/** 提纲里出现这些词时，额外去对应目录做定向检索。 */
const ROUTES = [
  { test: /经济|产业|招商|项目|营商|金融|国资|外贸|消费|工业|企业/, prefix: '01-经济建设' },
  { test: /党建|干部|作风|廉政|组织|民主生活|党课|主题教|法治|改革|政治/, prefix: '02-政治建设' },
  { test: /文化|文旅|旅游|宣传|教育|科技|人才|文艺|体育|网评|理论|宣讲/, prefix: '03-文化建设' },
  { test: /乡村|民生|城市|安全|卫生|疫情|社会|保障|就业|养老|治理|防灾/, prefix: '04-社会建设' },
  { test: /生态|环保|环境|林业|水利|绿色|碳|排污|河长/, prefix: '05-生态文明' },
  { test: /总结|致辞|座谈|调研|汇报|务虚/, prefix: '06-其他综合性讲话' },
]

/** 四类素材各有习惯藏身处，先按类目定向前提召回一遍。 */
const SEED_QUERIES = [
  { query: '金句 排比 表述 强调', pathPrefix: '07-素材金句', mode: 'keyword' },
  { query: '政策 规划 意见 通知 部署', pathPrefix: '07-素材金句', mode: 'keyword' },
]

const PLANNING_YEARS = [
  ['十五五', 2026],
  ['十四五', 2021],
  ['十三五', 2016],
  ['十二五', 2011],
]

const DATA_RE = /\d+(?:\.\d+)?\s*(?:%|％|万元|亿元|万人次|万|个|家|处|项|所|公里|亩|吨|人|台|套|座)/g
const POLICY_RE = /《[^》]{2,40}》|党中央|国务院|省委|省政府|市委|市政府|中办|国办|印发|实施意见|规划|条例|二十大|二十届|习近平|总书记/
const CASE_ACTION_RE = /建成|建设|打造|实施|开展|入选|获评|挂牌|推广|落地|开工|投产|投用|试点|示范|样板|典型|经验/
const QUOTE_MARK_RE = /[“"][^”"]{6,40}[”"]/

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function listOf(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const items = value.map((item) => normalizeText(item)).filter((item) => item !== '')
  return items.length > 0 ? items : fallback
}

/** 从文件名里认日期：`20141218_…`、`2016年2月14日_…`、`…20221104…`。 */
export function yearFromPath(filePath) {
  const name = String(filePath ?? '').split(/[\\/]/).pop() ?? ''
  // 8 位日期前缀（20141218_）没有分隔符，先单独认，否则 \b 匹配不到。
  const compact = /^((?:19|20)\d{2})(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?=[^\d]|$)/.exec(name)
  if (compact) return Number.parseInt(compact[1], 10)
  const dotted = /((?:19|20)\d{2})\s*(?:年|[._\-\s])/.exec(name)
  if (dotted) return Number.parseInt(dotted[1], 10)
  const plain = /\b((?:19|20)\d{2})\b/.exec(name)
  if (plain) return Number.parseInt(plain[1], 10)
  return null
}

/** 正文里的年份：取出现过的最大年份（讲话引用旧数据时以最新年份为准）。 */
export function yearFromText(textValue) {
  const years = []
  for (const match of String(textValue ?? '').matchAll(/((?:19|20)\d{2})\s*年/g)) {
    years.push(Number.parseInt(match[1], 10))
  }
  if (years.length > 0) return Math.max(...years)
  for (const [period, startYear] of PLANNING_YEARS) {
    if (String(textValue ?? '').includes(period)) return startYear
  }
  return null
}

/**
 * 年份：文件名优先（讲话日期最可靠），文件名没有再看正文，最后看规划期表述。
 * `source` 让调用方能区分「文档年份」与「正文提到的年份」。
 */
export function extractYear({ path, text }) {
  const fromPath = yearFromPath(path)
  if (fromPath !== null) return { value: fromPath, source: '文件名', label: `${fromPath} 年` }
  const fromText = yearFromText(text)
  if (fromText !== null) return { value: fromText, source: '正文', label: `${fromText} 年` }
  return { value: null, source: '未知', label: '年份未知' }
}

// regions.local 的第一项当作「本级市」，其余是下辖县区/园区，所以层级能自动认出来。
function levelOfLocalName(name, local) {
  if (/开发区|新区/.test(name)) return '园区'
  if (local.length > 0 && name === local[0]) return '市级'
  if (name.endsWith('市') || name.endsWith('县') || name.endsWith('区')) return '县区'
  return '县区'
}

function hitCount(haystack, needle) {
  if (needle === '') return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * 地域层级：先看路径（目录名/文件名通常写明是哪个县市），再看正文；本地地名与外地地名
 * 各自计票，正文里本地占多数才判本地，避免「本地讲话提了一句苏州」被整篇判成外地。
 */
export function extractRegion({ path, text }, regions = {}) {
  const local = listOf(regions.local, [])
  const foreign = listOf(regions.foreign, [])
  const pathPart = String(path ?? '')
  const body = String(text ?? '')
  const hay = `${pathPart}\n${body}`

  const pathLocal = []
  for (const name of local) {
    if (hitCount(pathPart, name) > 0) pathLocal.push(name)
  }
  if (pathLocal.length > 0) {
    const most = pathLocal.sort((a, b) => hitCount(pathPart, b) - hitCount(pathPart, a))[0]
    return { level: levelOfLocalName(most, local), name: most, foreign: false, basis: '路径' }
  }

  const pathForeign = foreign.filter((name) => hitCount(pathPart, name) > 0)
  if (pathForeign.length > 0) {
    return { level: '外地', name: pathForeign[0], foreign: true, basis: '路径' }
  }

  const localHits = local
    .map((name) => ({ name, count: hitCount(body, name) }))
    .filter((item) => item.count > 0)
  const foreignHits = foreign
    .map((name) => ({ name, count: hitCount(body, name) }))
    .filter((item) => item.count > 0)
  const localTotal = localHits.reduce((sum, item) => sum + item.count, 0)
  const foreignTotal = foreignHits.reduce((sum, item) => sum + item.count, 0)

  if (localTotal > 0 && localTotal >= foreignTotal) {
    const most = localHits.sort((a, b) => b.count - a.count)[0].name
    return { level: levelOfLocalName(most, local), name: most, foreign: false, basis: '正文' }
  }
  if (foreignTotal > 0) {
    const most = foreignHits.sort((a, b) => b.count - a.count)[0].name
    return { level: '外地', name: most, foreign: true, basis: '正文' }
  }
  if (/全市|全市上下|全市各级/.test(body) || /全市/.test(pathPart)) {
    return { level: '市级', name: '本级', foreign: false, basis: '表述' }
  }
  if (/全省|全省各级/.test(body)) {
    return { level: '省级', name: '本省', foreign: false, basis: '表述' }
  }
  if (/[\\/](?:市|县|区)?[^\\/]{0,6}(?:局|委|办|中心)[\\/]/.test(pathPart)) {
    return { level: '部门', name: '部门材料', foreign: false, basis: '路径' }
  }
  // 「乡镇」本身也以“镇”结尾，城乡/家乡/下乡这些词更常见，认名字时必须排除。
  const TOWN_STOP = /城乡|乡镇|家乡|故乡|老乡|下乡|返乡|回乡|异乡|他乡|水乡|两乡|各乡|镇村|乡村/
  const town = /([\u4e00-\u9fa5]{2,3}(?:镇|乡|街道))(?=[\s，。、；：）】「」的等中上和与及]|$)/.exec(hay)
  if (town && town[1]) {
    // 「霞浦县三沙镇」这种会把上级“县”一起吃进来，去掉开头的行政区划字。
    const name = town[1].replace(/^[县市区镇乡]+/, '')
    if (!TOWN_STOP.test(name)) return { level: '乡镇', name, foreign: false, basis: '正文' }
  }
  return { level: '未标注', name: '', foreign: false, basis: '无' }
}

/**
 * 四类归集：按信号打分，取最高分作为主类目，其余命中的类型作为标签保留。
 * 分数是相对比较用的，不对外展示。
 */
export function classifySnippet(textValue, { path = '' } = {}) {
  const body = String(textValue ?? '')
  const scores = { quote: 0, data: 0, policy: 0, case: 0 }

  const dataHits = body.match(DATA_RE)?.length ?? 0
  if (dataHits > 0) scores.data += Math.min(4, dataHits)
  if (/增长|下降|同比|环比|年均|位居|排名|占比|增长到|提高到|达到/.test(body)) scores.data += 1

  if (POLICY_RE.test(body)) scores.policy += 2
  if (/(?:按照|根据|落实).{0,12}(?:部署|要求|精神|安排)/.test(body)) scores.policy += 1

  if (/一是[\s\S]{0,80}二是/.test(body)) scores.quote += 2
  if (QUOTE_MARK_RE.test(body)) scores.quote += 1
  if (body.length <= 160 && /坚持|必须|既要|又要|不能|关键在|根本在/.test(body)) scores.quote += 1
  if (/素材金句|金句/.test(path)) scores.quote += 2

  if (CASE_ACTION_RE.test(body)) scores.case += 1
  if (/(?:福安|寿宁|宁德|蕉城|福鼎|霞浦|周宁|柘荣|屏南|古田)[\s\S]{0,40}(?:建成|建设|打造|入选|获评|推广|投产|投用)/.test(body)) {
    scores.case += 2
  }
  if (/(?:试\s*点|示范|样板|典型|经验做法|工作机制)/.test(body)) scores.case += 1

  const priority = ['data', 'case', 'policy', 'quote']
  let category = 'other'
  let best = 0
  for (const key of priority) {
    if (scores[key] > best) {
      best = scores[key]
      category = key
    }
  }
  const tags = CATEGORIES.filter((key) => scores[key] > 0 && key !== category).sort(
    (a, b) => scores[b] - scores[a],
  )
  return { category, tags, labels: [category, ...tags].map((key) => CATEGORY_LABELS[key]), scores }
}

/** 提纲拆条：按行拆，去掉「一、」「1.」「（一）」这类编号。 */
export function splitOutline(outline) {
  const source = Array.isArray(outline) ? outline.join('\n') : String(outline ?? '')
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^(?:[-*•]\s*|[（(][一二三四五六七八九十\d]+[）)]\s*|[一二三四五六七八九十]+[、.．]\s*|\d+[、.．)]\s*)/, '').trim())
    .filter((line) => line.length >= 2)
}

function routeFor(textValue) {
  for (const route of ROUTES) {
    if (route.test.test(textValue)) return route.prefix
  }
  return ''
}

/**
 * 三条通道的查询编排：语义（全面）、关键词（精确）、path_prefix（定向到领域目录）。
 * 同一查询只发一次，避免语义与关键词通道重复召回同一批片段。
 */
export function buildQueries({ topic, points, maxPoints = 6 }) {
  const queries = []
  const seen = new Set()
  const push = (query, mode, pathPrefix = '') => {
    const text = normalizeText(query)
    if (text.length < 2) return
    const key = `${mode}|${pathPrefix}|${text}`
    if (seen.has(key)) return
    seen.add(key)
    queries.push({ query: text, mode, pathPrefix })
  }

  const base = normalizeText(topic)
  if (base !== '') {
    push(base, 'semantic')
    push(base, 'keyword')
    const prefix = routeFor(base)
    if (prefix !== '') push(base, 'keyword', prefix)
  }

  for (const point of points.slice(0, Math.max(0, maxPoints))) {
    push(point, 'semantic')
    push(point, 'keyword')
    const prefix = routeFor(point)
    if (prefix !== '') push(point, 'keyword', prefix)
  }

  for (const seed of SEED_QUERIES) {
    push(seed.query, seed.mode, seed.pathPrefix)
  }

  return queries
}

/** 同一文件相邻行算重复：保留分数最高的那条。 */
export function dedupeCards(cards, { sameFileWindow = 6 } = {}) {
  const kept = []
  const sorted = [...cards].sort((a, b) => b.score - a.score)
  for (const card of sorted) {
    const duplicate = kept.some(
      (other) =>
        other.library?.id === card.library?.id &&
        other.path === card.path &&
        Math.abs(other.startLine - card.startLine) <= sameFileWindow,
    )
    if (!duplicate) kept.push(card)
  }
  return kept
}

export function groupCards(cards, maxPerCategory = 12) {
  const groups = { quote: [], data: [], policy: [], case: [], other: [] }
  for (const card of cards) {
    const key = CATEGORIES.includes(card.category) ? card.category : 'other'
    if (groups[key].length < maxPerCategory) groups[key].push(card)
  }
  const labels = { ...CATEGORY_LABELS }
  return { groups, labels }
}

/**
 * 生成素材包。kb 只需提供 `search({query, mode, pathPrefix, library, limit, rerank})`。
 */
export async function buildPacket({
  kb,
  options = {},
  topic = '',
  outline = '',
  library = '',
  points,
  perChannel = 8,
  maxCards = 80,
  maxPerCategory = 12,
  signal,
}) {
  const started = Date.now()
  const outlinePoints = points ?? splitOutline(outline)
  const pointList = outlinePoints.filter((point) => normalizeText(point) !== '')
  if (normalizeText(topic) === '' && pointList.length === 0) {
    throw Object.assign(new Error('缺少检索内容：请填一句主题，或贴一段提纲（每条一行）。'), { status: 400 })
  }
  const queries = buildQueries({ topic, points: pointList, maxPoints: options.points ?? 6 })

  const regions = {
    local: listOf(options.regions?.local, []),
    foreign: listOf(options.regions?.foreign, []),
  }

  const settled = await Promise.all(
    queries.map(async (item) => {
      try {
        const result = await kb.search({
          query: item.query,
          mode: item.mode,
          pathPrefix: item.pathPrefix,
          library,
          limit: perChannel,
          rerank: true,
          signal,
        })
        return { item, result }
      } catch (error) {
        return { item, error }
      }
    }),
  )

  const cards = []
  const failures = []
  const channelHit = { semantic: 0, keyword: 0, prefix: 0 }
  for (const { item, result, error } of settled) {
    if (error) {
      failures.push(`${item.mode}${item.pathPrefix ? `·${item.pathPrefix}` : ''}「${item.query}」：${String(error?.message ?? error)}`)
      continue
    }
    for (const hit of result?.results ?? []) {
      const year = extractYear({ path: hit.path, text: hit.snippet })
      const region = extractRegion({ path: hit.path, text: hit.snippet }, regions)
      const classified = classifySnippet(hit.snippet, { path: hit.path })
      const channel = item.pathPrefix ? 'prefix' : item.mode === 'semantic' ? 'semantic' : 'keyword'
      channelHit[channel] += 1
      cards.push({
        id: `${hit.library?.id ?? ''}:${hit.path}:${hit.startLine}`,
        library: hit.library ?? null,
        path: hit.path,
        heading: hit.heading ?? '',
        startLine: hit.startLine,
        endLine: hit.endLine ?? hit.startLine,
        snippet: hit.snippet,
        score: hit.score,
        category: classified.category,
        tags: classified.tags,
        labels: classified.labels,
        year,
        region,
        channel,
        via: { query: item.query, mode: item.mode, pathPrefix: item.pathPrefix },
      })
    }
  }

  const unique = dedupeCards(cards)
  const grouped = groupCards(unique, maxPerCategory)
  const counts = Object.fromEntries(
    Object.entries(grouped.groups).map(([key, list_]) => [key, list_.length]),
  )
  const total = Object.values(grouped.groups).reduce((sum, list_) => sum + list_.length, 0)

  return {
    ok: true,
    topic: normalizeText(topic),
    points: pointList,
    library: library || 'all',
    queries,
    failures,
    channelHit,
    stats: {
      searched: queries.length,
      candidates: cards.length,
      unique: unique.length,
      kept: Math.min(total, maxCards),
      byCategory: counts,
      foreign: unique.filter((card) => card.region?.foreign).length,
      unknownYear: unique.filter((card) => card.year?.value === null).length,
      duplicatesRemoved: cards.length - unique.length,
    },
    ...grouped,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  }
}

export const PACKET_CATEGORIES = CATEGORIES
export { CATEGORY_LABELS }
