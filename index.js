/**
 * dsh-familiar —— 跨会话长期记忆（DSH Host 插件）。
 *
 * 设计取向（对应这份插件的三条硬要求）：
 *  1. 不在对话开始就灌大量上下文 —— 常驻的只有：一小段静态策略 + 一份很短的画像。
 *  2. 话题沾边的检索是**静默**的 —— 走 `agent/pre-step` 追加一条折叠 notice 消息，
 *     没命中就一条都不加；命中时总预算按字符硬上限截断。
 *  3. 细节靠**原文**而不是摘要 —— 证据一律通过 `ctx.sessionQuery` 从真实历史消息里取，
 *     工具 `memory_expand` 还能把命中的原始上下文整段捞出来。
 *
 * 关键依赖：
 *  - `ctx.sessionQuery`：现成的全库会话检索（listSessions / readTitle / filterEvents /
 *    searchEvents / readEvent）。本插件不自己建索引，只在它上面做「会话卡」粗筛。
 *  - `ctx.tools`：注册 memory_recall / memory_expand / memory_remember / memory_forget / memory_list。
 *  - `ctx.systemPrompt`（可选）：注册一段**静态**策略 + 一份**静态快照**的画像，
 *    静态文本对提示缓存友好。
 *
 * 存储（可读、可 git、可手改）：
 *  <memoryDir>/profile.md    长期画像（常驻注入，硬上限 profileMaxChars）
 *  <memoryDir>/facts.jsonl   模型判定值得记的事实（按需检索，不常驻）
 *  <memoryDir>/sessions.json 会话卡索引（派生缓存，可随时重建）
 *  <memoryDir>/debug.log     诊断日志（debug=true 时写）
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Cordis 插件名（诊断里可见）。 */
const name = 'remember'
/** 缺任一必需服务时本行等待而不是报错。 */
const inject = ['tools', 'sessionQuery']

const PLUGIN_TAG = 'remember'
/** 注入消息的来源标签：缺了它，注入内容在历史里会被当成用户提示渲染。 */
const PLUGIN_SOURCE = Object.freeze({ kind: PLUGIN_TAG })
const NOTICE_SUMMARY_MAX = 120

/** 会话卡的派生缓存版本；字段或折叠语义变化时 +1。 */
const INDEX_VERSION = 1
const CARD_MAX_TOKENS = 28
const CARD_TEXT_BUDGET = 6000

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const Config = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: true },
    autoInject: { type: 'boolean', default: true },
    injectMode: { type: 'string', enum: ['auto', 'notice', 'off'], default: 'auto' },
    injectBudgetChars: { type: 'number', default: 1100 },
    cardScoreThreshold: { type: 'number', default: 0.3 },
    indexLimit: { type: 'number', default: 400 },
    profileMaxChars: { type: 'number', default: 500 },
    injectMaxFacts: { type: 'number', default: 4 },
    injectCorrectionSlots: { type: 'number', default: 2 },
    maintainThreshold: { type: 'number', default: 120 },
    autoConsolidate: { type: 'boolean', default: true },
    indexTtlMs: { type: 'number', default: 300000 },
    maxEvidenceSessions: { type: 'number', default: 2 },
    maxSnippetsPerSession: { type: 'number', default: 3 },
    snippetChars: { type: 'number', default: 200 },
    debug: { type: 'boolean', default: false },
    memoryDir: { type: 'string', default: '' },
  },
}

function normalize(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const num = (value, fallback) => (Number.isFinite(value) ? Number(value) : fallback)
  const dir = typeof raw.memoryDir === 'string' && raw.memoryDir.trim() !== '' ? raw.memoryDir.trim() : defaultMemoryDir()
  return {
    enabled: raw.enabled !== false,
    autoInject: raw.autoInject !== false,
    injectMode: raw.injectMode === 'notice' || raw.injectMode === 'off' ? raw.injectMode : 'auto',
    injectBudgetChars: Math.max(200, num(raw.injectBudgetChars, 1100)),
    cardScoreThreshold: num(raw.cardScoreThreshold, 0.3),
    indexLimit: Math.max(1, Math.floor(num(raw.indexLimit, 400))),
    profileMaxChars: Math.max(0, Math.floor(num(raw.profileMaxChars, 500))),
    injectMaxFacts: Math.max(1, Math.floor(num(raw.injectMaxFacts, 4))),
    injectCorrectionSlots: Math.max(0, Math.floor(num(raw.injectCorrectionSlots, 2))),
    maintainThreshold: Math.max(20, Math.floor(num(raw.maintainThreshold, 120))),
    autoConsolidate: raw.autoConsolidate !== false,
    indexTtlMs: Math.max(10000, num(raw.indexTtlMs, 300000)),
    maxEvidenceSessions: Math.max(1, Math.floor(num(raw.maxEvidenceSessions, 2))),
    maxSnippetsPerSession: Math.max(1, Math.floor(num(raw.maxSnippetsPerSession, 3))),
    snippetChars: Math.max(40, Math.floor(num(raw.snippetChars, 200))),
    debug: raw.debug === true,
    autoExtract: raw.autoExtract !== false,
    extractProvider: typeof raw.extractProvider === 'string' ? raw.extractProvider.trim() : '',
    extractModel: typeof raw.extractModel === 'string' ? raw.extractModel.trim() : '',
    extractMaxChars: Math.max(1000, Math.floor(num(raw.extractMaxChars, 6000))),
    extractMaxFacts: Math.max(1, Math.floor(num(raw.extractMaxFacts, 3))),
    memoryDir: dir,
  }
}

/** 记忆目录：优先 profile 目录，其次 ~/.dsh。 */
function defaultMemoryDir() {
  const profileDir = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR : ''
  const base = profileDir !== '' ? profileDir : path.join(os.homedir(), '.dsh')
  return path.join(base, 'memory')
}

// ---------------------------------------------------------------------------
// 极简工具函数
// ---------------------------------------------------------------------------

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function truncate(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return value.slice(0, Math.max(0, max - 1)) + '…'
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 当地时间 `YYYY-MM-DD`，用于注入文本可读性。 */
function dayOf(timestamp) {
  const value = Number.isFinite(timestamp) ? timestamp : Date.now()
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知日期'
  const pad = (input) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
const LATIN_TOKEN = /[a-z0-9][a-z0-9_.+#-]{1,}/g
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'that', 'this', 'with', 'you', 'your', 'have', 'has',
  'not', 'but', 'can', 'will', 'would', 'should', 'from', 'they', 'them', 'then', 'than', 'there',
  'what', 'when', 'where', 'which', 'how', 'why', 'all', 'any', 'our', 'out', 'get', 'got', 'just',
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '和', '就', '都', '也', '很', '有', '会',
  '这', '那', '个', '不', '要', '吗', '呢', '吧', '啊', '把', '被', '给', '对', '从', '到', '一个',
])

/** 中英混合的粗分词：英文/数字保留整词，中文按二元组（bigram）切。 */
function tokenize(text) {
  const value = String(text ?? '').toLowerCase()
  const tokens = new Map()
  const bump = (token, weight) => {
    if (token.length < 2 && !/^[0-9]$/.test(token)) return
    const current = tokens.get(token) ?? 0
    tokens.set(token, current + weight)
  }
  for (const match of value.matchAll(LATIN_TOKEN)) {
    const token = match[0].replace(/[.+#-]+$/, '')
    if (token.length < 2 || STOPWORDS.has(token)) continue
    bump(token, 1)
  }
  for (const run of value.matchAll(CJK_RUN)) {
    const chars = run[0]
    if (chars.length === 1) continue
    for (let index = 0; index + 1 < chars.length; index += 1) {
      const bigram = chars.slice(index, index + 2)
      if (STOPWORDS.has(bigram)) continue
      bump(bigram, 0.6)
    }
  }
  return tokens
}

function topTokens(text, limit) {
  const counts = tokenize(text)
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([token]) => token)
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

function createStore(config, log) {
  const dir = config.memoryDir
  const files = {
    profile: path.join(dir, 'profile.md'),
    facts: path.join(dir, 'facts.jsonl'),
    index: path.join(dir, 'sessions.json'),
    debug: path.join(dir, 'debug.log'),
  }
  let ready = false

  function ensureReady() {
    if (ready) return true
    try {
      fs.mkdirSync(dir, { recursive: true })
      ready = true
      return true
    } catch (error) {
      log('ensure-dir-failed', { message: String(error?.message ?? error) })
      return false
    }
  }

  function readProfile() {
    if (!ensureReady()) return ''
    try {
      return fs.readFileSync(files.profile, 'utf8')
    } catch {
      return ''
    }
  }

  function writeProfile(text) {
    if (!ensureReady()) return false
    try {
      fs.writeFileSync(files.profile, text, 'utf8')
      return true
    } catch (error) {
      log('write-profile-failed', { message: String(error?.message ?? error) })
      return false
    }
  }

  /** 画像正文（去掉注释行），用于注入。 */
  function profileText() {
    const raw = readProfile()
    if (raw.trim() === '') return ''
    return raw
      .split(/\r?\n/)
      .filter((line) => !/^\s*<!--/.test(line))
      .join('\n')
      .trim()
  }

  function appendProfileLine(line) {
    const current = readProfile()
    const next = current.trim() === '' ? `# 长期画像\n\n- ${line}\n` : `${current.replace(/\s*$/, '')}\n- ${line}\n`
    writeProfile(next)
    return next
  }

  function readFacts() {
    if (!ensureReady()) return []
    try {
      const raw = fs.readFileSync(files.facts, 'utf8')
      const facts = []
      for (const line of raw.split(/\r?\n/)) {
        if (line.trim() === '') continue
        try {
          const parsed = JSON.parse(line)
          if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') facts.push(migrateFact(parsed))
        } catch {
          // 手改坏了就跳过这一行，不影响其它记忆
        }
      }
      return facts
    } catch {
      return []
    }
  }

  function appendFact(fact) {
    if (!ensureReady()) return false
    try {
      fs.appendFileSync(files.facts, JSON.stringify(fact) + '\n', 'utf8')
      return true
    } catch (error) {
      log('append-fact-failed', { message: String(error?.message ?? error) })
      return false
    }
  }

  function rewriteFacts(facts) {
    if (!ensureReady()) return false
    try {
      fs.writeFileSync(files.facts, facts.map((fact) => JSON.stringify(fact)).join('\n') + (facts.length > 0 ? '\n' : ''), 'utf8')
      return true
    } catch (error) {
      log('rewrite-facts-failed', { message: String(error?.message ?? error) })
      return false
    }
  }

  function readIndex() {
    if (!ensureReady()) return null
    try {
      const raw = fs.readFileSync(files.index, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || parsed.version !== INDEX_VERSION || typeof parsed.cards !== 'object') return null
      return parsed
    } catch {
      return null
    }
  }

  function writeIndex(index) {
    if (!ensureReady()) return false
    try {
      fs.writeFileSync(files.index, JSON.stringify(index), 'utf8')
      return true
    } catch (error) {
      log('write-index-failed', { message: String(error?.message ?? error) })
      return false
    }
  }

  return {
    dir,
    files,
    profileText,
    appendProfileLine,
    readProfile,
    readFacts,
    appendFact,
    rewriteFacts,
    readIndex,
    writeIndex,
    saveExtractMarks(marks) {
      if (!ensureReady()) return false
      try {
        fs.writeFileSync(path.join(dir, 'extract.json'), JSON.stringify(marks ?? {}), 'utf8')
        return true
      } catch {
        return false
      }
    },
    readExtractMarks() {
      if (!ensureReady()) return {}
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'extract.json'), 'utf8'))
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch {
        return {}
      }
    },
    log,
  }
}

// ---------------------------------------------------------------------------
// 会话卡索引
// ---------------------------------------------------------------------------

/**
 * 建/刷新会话卡索引。
 *
 * 卡片的用途只有一个：让「这次要不要检索、检索哪个会话」变成纯本地计算。
 * 卡本身不进上下文，只在命中后作为一行标题出现。
 */
async function refreshIndex(ctx, config, store, log, options = {}) {
  const sessionQuery = ctx.sessionQuery
  if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return null

  const existing = store.readIndex() ?? { version: INDEX_VERSION, updatedAt: 0, cards: {} }
  const cards = { ...existing.cards }
  const deadline = Date.now() + (options.budgetMs ?? 2500)

  let records = []
  try {
    records = await sessionQuery.listSessions()
  } catch (error) {
    log('list-sessions-failed', { message: String(error?.message ?? error) })
    return existing
  }

  records.sort((left, right) => (right?.header?.createdAt ?? 0) - (left?.header?.createdAt ?? 0))
  const slice = records.slice(0, config.indexLimit)
  let built = 0

  for (const record of slice) {
    if (Date.now() > deadline) break
    const id = record?.header?.id
    if (typeof id !== 'string' || id === '') continue
    const createdAt = Number(record?.header?.createdAt ?? 0)
    const cached = cards[id]
    const fresh = cached !== undefined && cached.createdAt === createdAt && record.live !== true
    if (fresh) continue

    try {
      const card = await buildCard(sessionQuery, id, createdAt, record?.header?.cwd)
      if (card === null) continue
      cards[id] = card
      built += 1
    } catch (error) {
      log('build-card-failed', { sessionId: id, message: String(error?.message ?? error) })
    }
  }

  // 清掉超出 indexLimit 的老卡，避免文件无限增长
  const keep = new Set(slice.map((record) => record?.header?.id).filter((id) => typeof id === 'string'))
  for (const id of Object.keys(cards)) {
    if (!keep.has(id)) delete cards[id]
  }

  const next = { version: INDEX_VERSION, updatedAt: Date.now(), cards }
  store.writeIndex(next)
  log('index-refreshed', { sessions: slice.length, built, cards: Object.keys(cards).length })
  return next
}

/** 宿主/其它插件塞进 user 角色的样板文本，不该当记忆线索。 */
const BOILERPLATE_PREFIXES = [
  'The approval policy changed',
  'Current runtime context',
  'Current DSH file policy',
  'You are a helpful AI assistant',
  '<system-reminder>',
  'GODOT ENGINE PATH',
  'GODOT LAUNCH CHANNEL',
  'GODOT INSTANCE OWNERSHIP',
  'GODOT DEBUGGER',
]

function isBoilerplate(text) {
  const value = oneLine(text)
  if (value === '') return true
  return BOILERPLATE_PREFIXES.some((prefix) => value.startsWith(prefix))
}

/** 从首条消息里削出一个可读标题（去掉 markdown 记号、路径、括号里的长说明）。 */
function deriveTitle(text) {
  const firstLine = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? ''
  const cleaned = firstLine
    .replace(/^[#>\-*\s]+/, '')
    .replace(/[`*_]+/g, '')
    .replace(/[（(][^)）]{20,}[)）]/g, '')
    .trim()
  return truncate(cleaned === '' ? '(无标题)' : cleaned, 32)
}

/**
 * 主召回通道：直接用宿主自带的全库 FTS（`searchSessions`）。
 *
 * 这是命中率最高的一条路——宿主自己的分词与排序比插件在会话卡上做的关键词打分强得多。
 * 返回的 `bestMatch.snippet` 就是原文片段，不用再二次检索。
 */
async function searchHistory(ctx, query, limit, log, state) {
  if (state?.searchDisabled === true) return []
  const sessionQuery = ctx.sessionQuery
  if (!sessionQuery || typeof sessionQuery.searchSessions !== 'function') return []
  try {
    const page = await sessionQuery.searchSessions({ query: truncate(oneLine(query), 300), limit })
    const items = Array.isArray(page?.items) ? page.items : []
    const out = []
    for (const item of items) {
      const id = item?.header?.id
      if (typeof id !== 'string' || id === '') continue
      let title = ''
      if (typeof sessionQuery.readTitle === 'function') {
        try {
          const snapshot = await sessionQuery.readTitle(id)
          if (snapshot && typeof snapshot.title === 'string') title = oneLine(snapshot.title)
        } catch {
          title = ''
        }
      }
      out.push({
        sessionId: id,
        title: title === '' ? '(无标题)' : truncate(title, 40),
        createdAt: Number(item?.header?.createdAt ?? 0),
        snippet: truncate(oneLine(item?.bestMatch?.snippet ?? ''), 200),
        seq: item?.bestMatch?.seq,
      })
    }
    log('search-sessions', { limit, hits: out.length, top: out[0]?.sessionId ?? null })
    return out
  } catch (error) {
    const message = String(error?.message ?? error)
    // 该部署把索引关掉了：一次性记住，之后不再重复尝试
    if (state !== undefined && /disabled/i.test(message)) state.searchDisabled = true
    log('search-sessions-failed', { message })
    return []
  }
}

/** 为一个会话造卡：标题 + 用户消息抽出的关键词 + 少量样本。 */
async function buildCard(sessionQuery, sessionId, createdAt, cwd = undefined) {
  let title = ''
  if (typeof sessionQuery.readTitle === 'function') {
    try {
      const snapshot = await sessionQuery.readTitle(sessionId)
      if (snapshot && typeof snapshot.title === 'string') title = oneLine(snapshot.title)
    } catch {
      title = ''
    }
  }

  let texts = []
  if (typeof sessionQuery.filterEvents === 'function') {
    try {
      const docs = await sessionQuery.filterEvents(sessionId, [{ kind: 'type', values: ['user/message'] }])
      texts = Array.isArray(docs)
        ? docs
            .map((doc) => oneLine(doc?.text ?? ''))
            .filter((text) => text.length > 0 && !isBoilerplate(text))
            .slice(0, 40)
        : []
    } catch {
      texts = []
    }
  }

  if (title === '' && texts.length === 0) return null
  const corpus = (title + '\n' + texts.join('\n')).slice(0, CARD_TEXT_BUDGET)
  // 样本取**最后**两条用户消息：越靠后越接近这次会话真正的诉求与结论。
  // 首条消息往往是那段很长的任务简报，当记忆线索几乎没用。
  const sampleSource = texts.slice(-2)
  return {
    id: sessionId,
    title: title === '' ? deriveTitle(texts[0] ?? '(无标题)') : title,
    tokens: topTokens(corpus, CARD_MAX_TOKENS),
    sample: truncate(sampleSource.join(' / '), 240),
    cwd: typeof cwd === 'string' ? cwd : undefined,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    msgCount: texts.length,
    recallCount: 0,
    lastRecallAt: 0,
  }
}

// ---------------------------------------------------------------------------
// 检索打分
// ---------------------------------------------------------------------------

const RECENT_WINDOW_DAYS = 45
/** 明确指向"回忆过去"的说法：出现即认为值得检索。 */
const RECALL_CUES = [
  '记得', '记不记得', '还记得', '上次', '上回', '之前', '以前', '先前', '曾经', '早先',
  '我们讨论过', '我们说过', '你说过', '我说过', '提过', '聊过', '继续上次', '接着上次',
  '历史项目', '我的身份', '我的偏好', '我的习惯', '根据我', '按我的', '我的情况',
  'remember', 'last time', 'previously', 'we discussed', 'you said', 'earlier', 'recall',
]

function hasRecallCue(text) {
  const value = String(text ?? '').toLowerCase()
  if (value === '') return false
  return RECALL_CUES.some((cue) => value.includes(cue.toLowerCase()))
}

function scoreCards(cards, queryTokens, now) {
  const querySize = Math.max(1, queryTokens.size)
  const scored = []
  for (const card of Object.values(cards)) {
    if (!card || !Array.isArray(card.tokens)) continue
    let overlap = 0
    for (const token of card.tokens) {
      const weight = queryTokens.get(token)
      if (weight === undefined) continue
      overlap += weight > 0 ? 1 : 0
    }
    if (overlap === 0) continue
    const ageDays = Math.max(0, (now - (card.createdAt || 0)) / 86400000)
    const recency = Math.exp(-ageDays / RECENT_WINDOW_DAYS)
    const recallBoost = Math.min(1, (card.recallCount || 0) / 5)
    const score = 0.72 * (overlap / Math.sqrt(querySize)) + 0.18 * recency + 0.10 * recallBoost
    scored.push({ card, score, overlap })
  }
  scored.sort((left, right) => right.score - left.score)
  return scored
}

/**
 * 从一个会话里捞原文证据。
 *
 * 这里刻意**不依赖 FTS 索引**：某些部署把 session-query 索引设成 openAt:"never"，
 * 检索接口会直接报 "session search is disabled"。改用逐条扫描的 `filterEvents`
 * （provider-independent 的语义文档扫描），在候选会话内部做字面匹配，中文同样可用。
 */
async function collectEvidence(sessionQuery, card, rawQuery, config, log) {
  const snippets = []
  if (!sessionQuery || typeof sessionQuery.filterEvents !== 'function') return snippets

  // 取几个最有区分度的查询词做字面匹配
  const tokens = [...tokenize(rawQuery).keys()].filter((token) => token.length >= 2).slice(0, 8)
  if (tokens.length === 0) {
    if (typeof card?.sample === 'string' && card.sample !== '') {
      snippets.push({ text: truncate(card.sample, config.snippetChars) })
    }
    return snippets
  }

  try {
    const docs = await sessionQuery.filterEvents(card.id, [
      { kind: 'type', values: ['user/message', 'assistant/message'] },
    ])
    const ranked = []
    for (const doc of Array.isArray(docs) ? docs : []) {
      const text = oneLine(doc?.text ?? '')
      if (text === '' || isToolish(text)) continue
      const lower = text.toLowerCase()
      let hits = 0
      for (const token of tokens) {
        if (lower.includes(token)) hits += 1
      }
      if (hits === 0) continue
      ranked.push({ text, seq: doc?.seq, hits })
    }
    ranked.sort((left, right) => right.hits - left.hits)
    for (const item of ranked.slice(0, config.maxSnippetsPerSession)) {
      snippets.push({ text: truncate(item.text, config.snippetChars), seq: item.seq })
    }
    log('evidence-scan', { sessionId: card.id, docs: Array.isArray(docs) ? docs.length : 0, hits: ranked.length })
  } catch (error) {
    log('evidence-scan-failed', { sessionId: card.id, message: String(error?.message ?? error) })
  }

  if (snippets.length === 0 && typeof card?.sample === 'string' && card.sample !== '') {
    snippets.push({ text: truncate(card.sample, config.snippetChars) })
  }
  return snippets
}

/** 组装注入文本：标题一行 + 片段若干，总长受 injectBudgetChars 硬约束。 */
function composeInjection(profile, matches, config) {
  const lines = []
  const profileText = truncate(oneLine(profile), Math.min(config.profileMaxChars, 320))
  if (profileText !== '') lines.push('用户画像：' + profileText)
  if (matches.length > 0) {
    lines.push('可能相关的历史（自动召回，未命中就忽略）：')
    let index = 0
    for (const match of matches) {
      index += 1
      lines.push(`${index}. ${dayOf(match.card.createdAt)}｜${truncate(match.card.title, 48)}`)
      for (const snippet of match.snippets.slice(0, config.maxSnippetsPerSession)) {
        const where = snippet.seq === undefined ? '' : `（#${snippet.seq}）`
        lines.push(`   - ${snippet.text}${where}`)
      }
    }
  }
  if (lines.length === 0) return ''
  const text = lines.join('\n')
  return text.length <= config.injectBudgetChars ? text : truncate(text, config.injectBudgetChars)
}

const SYSTEM_SECTION = `## 长期记忆（跨会话）

你有跨会话长期记忆，通过工具读写，不要凭空断定"我记得"。

**写入**（memory_remember）
- 值得记：用户身份/角色、语言与语气偏好、长期项目与其关键决策、被用户纠正过的做法、跨会话复用的约定。
- 不值得记：一次性的临时状态、随口一句话、你自己的猜测、能从当前上下文直接看到的东西。
- 用户明确说"记住"时优先写入。写入用陈述句，一句话一件事。

**召回**（memory_recall / memory_expand）
- 当问题涉及过去的事、"上次/之前/继续"、用户偏好或身份，且你不确定时，先 memory_recall。
- 需要具体细节（原话、数值、路径、错误码、当时的结论）时，用 memory_expand 取原始上下文，不要用摘要脑补。
- 每轮可能已自动注入少量历史片段。够用就直接用，不要重复检索；不够再调工具。
- 用户没要求回忆时，不要主动展示记忆内容，也不要描述检索过程。

**底线**
- 区分三件事：自动注入的片段（有来源）、你检索到的原文、你的推断。第三条不能说成事实。
- 记忆可能过时。用过时信息前，先按当前对话确认。`

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function textResult(text) {
  return [{ type: 'text', text }]
}

function jsonOutput(schemaDescription) {
  return {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', description: '本次调用是否成功。' },
        summary: { type: 'string', description: schemaDescription },
        data: { description: '结构化结果，视工具而定。' },
      },
      required: ['ok'],
    },
    render(_args, value) {
      const summary = typeof value?.summary === 'string' ? value.summary : JSON.stringify(value)
      return textResult(summary)
    },
  }
}

// ---------------------------------------------------------------------------
// 画像的行级编辑（唯一子串定位 + 容量契约）
// ---------------------------------------------------------------------------

/** 画像正文长度：去掉注释行与标题行，只算真正会被注入的内容。 */
function profileBodyText(raw) {
  return String(raw ?? '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*<!--/.test(line))
    .filter((line) => !/^\s*#\s/.test(line))
    .join('\n')
    .trim()
}

/** 画像里的条目行（`- xxx`），用来在超限报错时全量回吐。 */
function profileEntries(raw) {
  const hits = []
  String(raw ?? '').split(/\r?\n/).forEach((line, index) => {
    if (/^\s*[-*]\s+\S/.test(line)) hits.push({ index, line })
  })
  return hits
}

function renderLineHits(hits) {
  return hits.map((hit) => `  ${hit.index + 1}. ${truncate(oneLine(hit.line), 80)}`).join('\n')
}

/**
 * 容量检查：只对「这批操作全部应用之后」的正文长度判定一次。
 *
 * 这条契约的意义在于：模型可以一次调用里先删后加，
 * 而不是被"先加会被拒、先删又不知道删多少"卡在原地反复试。
 */
function profileCapacity(nextText, limit) {
  const body = profileBodyText(nextText)
  const used = body.length
  if (limit <= 0 || used <= limit) return { ok: true, used, limit }
  return { ok: false, used, limit, over: used - limit }
}

/**
 * 在画像上做一次行级编辑。
 *
 * 只认**唯一**子串：0 命中报错、多命中报错并列出候选 —— 绝不"命中多少删多少"。
 * 也没有"整文件替换"这种操作：整条覆盖会把同一行里的其它独立信息一起抹掉，
 * 所以更新粒度只能是"行内唯一的一段"。
 */
function applyProfileOps(raw, operations) {
  const lines = String(raw ?? '').split(/\r?\n/)
  const applied = []
  for (const operation of operations) {
    const op = typeof operation?.op === 'string' ? operation.op : 'add'
    const text = oneLine(operation?.text ?? '')
    if (op === 'add') {
      if (text === '') continue
      lines.push('- ' + text)
      applied.push('add')
      continue
    }
    if (op !== 'remove' && op !== 'patch') {
      return { error: '未知操作「' + op + '」，只支持 add / remove / patch。' }
    }
    const needle = oneLine(operation?.find ?? (op === 'remove' ? operation?.text : ''))
    if (needle === '') return { error: op + ' 需要 find（定位文字）。' }
    const hits = []
    lines.forEach((line, index) => {
      if (line.includes(needle)) hits.push({ index, line })
    })
    if (hits.length === 0) return { error: '画像里没有包含「' + truncate(needle, 40) + '」的行。' }
    if (hits.length > 1) {
      return {
        error: '「' + truncate(needle, 40) + '」命中 ' + hits.length + ' 行，请给出更长、唯一的一段：\n' + renderLineHits(hits),
      }
    }
    if (op === 'remove') {
      lines.splice(hits[0].index, 1)
    } else {
      if (text === '') return { error: 'patch 需要 text（替换后的文字）。' }
      lines[hits[0].index] = hits[0].line.replace(needle, text)
    }
    applied.push(op)
  }
  return { text: lines.join('\n'), applied }
}

function registerTools(ctx, config, store, state, log) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'memory_recall',
    description: '检索跨会话长期记忆：先按会话卡粗筛，再从真实历史消息里取原文片段。用于回忆过去的项目、决定、偏好或细节。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要回忆的内容，用自然语言描述即可（会做全文检索）。' },
        detail: { type: 'string', enum: ['brief', 'normal', 'deep'], description: 'brief=只要命中概要；normal=片段；deep=片段+原始上下文。默认 normal。' },
        limit: { type: 'number', description: '最多返回几个会话，默认 3。' },
      },
      required: ['query'],
    },
    output: jsonOutput('人类可读的召回摘要。'),
    timeoutMs: 30000,
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query === '') return { ok: false, summary: '缺少 query。' }
      const detail = args?.detail === 'brief' || args?.detail === 'deep' ? args.detail : 'normal'
      const limit = Math.max(1, Math.min(6, Math.floor(Number(args?.limit) || 3)))

      const index = store.readIndex()
      const cards = index?.cards ?? {}
      const found = await searchHistory(ctx, query, limit, log, state)
      const matched = []

      if (found.length > 0) {
        for (const hit of found) {
          let snippets = hit.snippet === '' ? [] : [{ text: hit.snippet, seq: hit.seq }]
          if (detail !== 'brief') {
            const more = await collectEvidence(ctx.sessionQuery, { id: hit.sessionId, sample: hit.snippet }, query, config, log)
            for (const snippet of more) {
              if (!snippets.some((existing) => existing.text === snippet.text)) snippets.push(snippet)
            }
          }
          const item = {
            sessionId: hit.sessionId,
            title: hit.title,
            date: dayOf(hit.createdAt),
            snippets,
          }
          if (detail === 'deep') item.expand = await expandSession(ctx, hit.sessionId, snippets, config, log)
          matched.push(item)
        }
      } else {
        const scored = scoreCards(cards, tokenize(query), Date.now()).slice(0, limit)
        for (const entry of scored) {
          const snippets = await collectEvidence(ctx.sessionQuery, entry.card, query, config, log)
          const item = {
            sessionId: entry.card.id,
            title: entry.card.title,
            date: dayOf(entry.card.createdAt),
            score: Number(entry.score.toFixed(3)),
            messageCount: entry.card.msgCount ?? 0,
            snippets,
          }
          if (detail === 'deep') item.expand = await expandSession(ctx, entry.card.id, snippets, config, log)
          matched.push(item)
          entry.card.recallCount = (entry.card.recallCount || 0) + 1
          entry.card.lastRecallAt = Date.now()
        }
        if (index) store.writeIndex(index)
      }

      const factHits = matchFacts(store.readFacts(), query, config.injectMaxFacts)
      if (matched.length === 0 && factHits.length === 0) {
        return { ok: true, summary: '没有找到相关的历史记录。', data: { matched: [], facts: [] } }
      }

      const lines = []
      if (factHits.length > 0) lines.push(renderFactBlock(factHits, 900))
      if (matched.length > 0) {
        lines.push('历史会话命中 ' + matched.length + ' 个：')
        for (const item of matched) {
          const count = Number.isFinite(item.messageCount) && item.messageCount > 0 ? `，${item.messageCount} 条用户消息` : ''
          lines.push(`- ${item.date}｜${item.title}（${item.sessionId}${count}）`)
          for (const snippet of item.snippets) lines.push('    ' + snippet.text)
        }
      }
      return { ok: true, summary: lines.join('\n'), data: { matched } }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'memory_expand',
    description: '把某次历史会话里的一条消息展开成原始上下文（前后若干条原话）。用于回忆具体细节，避免用摘要脑补。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id（memory_recall 结果里的 sessionId）。' },
        seq: { type: 'number', description: '消息序号；省略时取该会话最后一条消息。' },
        before: { type: 'number', description: '向前取几条，默认 4。' },
        after: { type: 'number', description: '向后取几条，默认 4。' },
      },
      required: ['sessionId'],
    },
    output: jsonOutput('取回的原始上下文。'),
    timeoutMs: 30000,
    async execute(args) {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
      if (sessionId === '') return { ok: false, summary: '缺少 sessionId。' }
      const before = Math.max(0, Math.min(20, Math.floor(Number(args?.before ?? 4))))
      const after = Math.max(0, Math.min(20, Math.floor(Number(args?.after ?? 4))))
      let seq = Number.isFinite(Number(args?.seq)) ? Math.floor(Number(args.seq)) : undefined
      const query = ctx.sessionQuery
      if (!query || typeof query.readEvent !== 'function') {
        return { ok: false, summary: '当前宿主没有提供 sessionQuery.readEvent。' }
      }
      try {
        if (seq === undefined) {
          const events = typeof query.listEvents === 'function' ? await query.listEvents(sessionId) : []
          const last = Array.isArray(events) && events.length > 0 ? events[events.length - 1] : undefined
          seq = Number.isFinite(Number(last?.seq)) ? Math.floor(Number(last.seq)) : 0
        }
        const window = await query.readEvent({ sessionId, seq, before, after })
        const rendered = renderEventWindow(window)
        return { ok: true, summary: rendered, data: { sessionId, seq, raw: window } }
      } catch (error) {
        log('expand-failed', { sessionId, message: String(error?.message ?? error) })
        return { ok: false, summary: '展开失败：' + String(error?.message ?? error) }
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'memory_remember',
    description: '写入跨会话长期记忆。kind=profile 写入常驻画像（用户身份、语言语气偏好）；kind=fact 写入按需检索的事实（项目细节、决定、约定）。画像有字符上限，满了用 operations 一次做「删旧的 + 加新的」。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一句话一件事，陈述句。' },
        kind: { type: 'string', enum: ['profile', 'fact'], description: '默认 profile。' },
        category: { type: 'string', enum: ['fact', 'correction', 'preference', 'project', 'environment'], description: 'kind=fact 时的分类，默认 fact。correction 会进保底注入名额。' },
        source: { type: 'string', enum: ['user', 'inferred'], description: 'kind=fact 时：这条是用户明确说的(user)还是你自己的归纳(inferred)，默认 user。' },
        operations: {
          type: 'array',
          description: '批量编辑画像。上限只在这批操作全部应用之后检查一次，所以可以一边删旧的、一边加新的。',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add', 'remove', 'patch'], description: 'add 追加一行；remove 删掉唯一命中的那一行；patch 替换唯一命中的那一段。' },
              text: { type: 'string', description: 'add / patch 要写入的新文字。' },
              find: { type: 'string', description: 'remove / patch 的定位文字，必须唯一命中一行。' },
            },
            required: ['op'],
          },
        },
      },
    },
    output: jsonOutput('写入结果。'),
    timeoutMs: 15000,
    async execute(args) {
      const kind = args?.kind === 'fact' ? 'fact' : 'profile'
      const id = randomUUID()
      const createdAt = Date.now()

      if (kind === 'profile') {
        const operations = Array.isArray(args?.operations) ? args.operations : []
        const single = oneLine(args?.text ?? '')
        const batch = operations.length > 0 ? operations : (single === '' ? [] : [{ op: 'add', text: single }])
        if (batch.length === 0) return { ok: false, summary: '缺少 text 或 operations。' }

        const raw = store.readProfile()
        const edited = applyProfileOps(raw, batch)
        if (edited.error !== undefined) return { ok: false, summary: edited.error }

        const limit = config.profileMaxChars
        const capacity = profileCapacity(edited.text, limit)
        // 容量契约：超限时把当前条目全量回吐，并点名还差多少 —— 一次就要腾够
        if (!capacity.ok) {
          const entries = profileEntries(raw).map((hit) => hit.line).join('\n')
          return {
            ok: false,
            summary: '画像会超出上限 ' + capacity.over + ' 字符（' + capacity.used + '/' + capacity.limit + '）。'
              + '请用**一次** memory_remember 调用，在 operations 里同时 remove 或 patch 掉旧条目、再 add 新条目 —— '
              + '上限只在这批操作全部应用之后检查一次。\n当前条目：\n' + entries,
            data: { exceeded: capacity.over, usage: { used: capacity.used, limit: capacity.limit }, entries: profileEntries(raw) },
          }
        }
        const body = profileBodyText(edited.text)

        store.writeProfile(edited.text)
        state.profileCache = store.profileText()
        // 主动写入是明确意图，立刻刷新快照（手改文件则要等新会话）
        state.profileSnapshot = state.profileCache
        return {
          ok: true,
          summary: '已写入画像（' + body.length + '/' + limit + '，用了 ' + edited.applied.length + ' 个操作）',
          data: { kind, usage: { used: body.length, limit }, applied: edited.applied },
        }
      }

      const text = oneLine(args?.text ?? '')
      if (text === '') return { ok: false, summary: 'kind=fact 需要 text。' }
      const category = FACT_KINDS.has(args?.category) ? args.category : 'fact'
      const subject = FACT_SOURCES.has(args?.source) ? args.source : 'user'
      const ok = store.appendFact({
        id,
        kind: category,
        source: subject,
        text: truncate(text, 400),
        createdAt,
        origin: 'memory_remember',
        proofCount: 1,
        hitCount: 0,
      })
      return { ok, summary: ok ? '已记下（' + category + '）：' + truncate(text, 80) : '写入失败，检查记忆目录权限。', data: { id, kind: category, source: subject } }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'memory_list',
    description: '查看当前长期记忆的内容（画像、事实条数、会话卡列表），用于自查记住了什么。',
    parameters: { type: 'object', properties: {} },
    output: jsonOutput('记忆清单。'),
    timeoutMs: 20000,
    async execute() {
      const profile = store.profileText()
      const facts = store.readFacts()
      const index = store.readIndex() ?? { cards: {} }
      const cards = Object.values(index.cards).sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
      const lines = []
      lines.push('记忆目录：' + store.dir)
      lines.push('画像：' + (profile === '' ? '(空)' : truncate(profile.replace(/\n/g, ' / '), 300)))
      const live = facts.filter((fact) => !isDormant(fact))
      const byKind = {}
      for (const fact of live) {
        const key = fact.kind ?? 'fact'
        byKind[key] = (byKind[key] ?? 0) + 1
      }
      lines.push('事实：' + live.length + ' 条（' + Object.entries(byKind).map(([key, count]) => key + ' ' + count).join('，') + '）'
        + (facts.length > live.length ? '，已归档/作废 ' + (facts.length - live.length) + ' 条' : ''))
      // 反复被纠正的条目：建议固化成画像条目，但由调用方决定，不自动写
      const promote = live.filter((fact) => fact.kind === 'correction' && Number(fact.proofCount ?? 1) >= 2)
      if (promote.length > 0) {
        lines.push('建议固化进画像（已被反复确认 ' + promote.length + ' 条，用 memory_remember kind=profile）：')
        for (const fact of promote.slice(0, 5)) lines.push('  - ×' + Number(fact.proofCount ?? 1) + '｜' + truncate(oneLine(fact.text), 70))
      }
      lines.push('会话卡：' + cards.length + ' 个')
      for (const card of cards.slice(0, 10)) {
        lines.push(`  - ${dayOf(card.createdAt)}｜${truncate(card.title, 50)}`)
      }
      return {
        ok: true,
        summary: lines.join('\n'),
        data: { dir: store.dir, profile, facts, cards: cards.slice(0, 50) },
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'memory_forget',
    description: '删除一条长期记忆。传 id 删除事实；传 text 从画像里删掉唯一命中「text」的那一行 —— 多命中会报错并列出候选，不会一次删多行。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '事实 id（memory_list 可见）。' },
        text: { type: 'string', description: '要删掉的画像片段，必须唯一命中一行。' },
      },
    },
    output: jsonOutput('删除结果。'),
    timeoutMs: 15000,
    async execute(args) {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      if (id !== '') {
        const facts = store.readFacts()
        const next = facts.filter((fact) => fact.id !== id)
        if (next.length === facts.length) return { ok: false, summary: '没有这个 id 的事实。' }
        store.rewriteFacts(next)
        return { ok: true, summary: '已删除事实 ' + id }
      }
      if (text !== '') {
        const raw = store.readProfile()
        const edited = applyProfileOps(raw, [{ op: 'remove', text }])
        if (edited.error !== undefined) return { ok: false, summary: edited.error }
        store.writeProfile(edited.text)
        state.profileCache = store.profileText()
        state.profileSnapshot = state.profileCache
        return { ok: true, summary: '已从画像删除包含「' + truncate(text, 40) + '」的那一行' }
      }
      return { ok: false, summary: '需要 id 或 text。' }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'memory_maintain',
    description: '生成记忆库维护报告（疑似重复 / 长期没命中 / 超长条目 / 已归档）。默认只出报告不改数据；apply=true 才把长期没命中的事实标记归档（只降权，不删除）。',
    parameters: {
      type: 'object',
      properties: {
        apply: { type: 'boolean', description: '默认 false（dry-run）。true 时把 ≥180 天从未被话题命中、且证据薄弱的事实标记 archivedAt。' },
      },
    },
    output: jsonOutput('维护结果。'),
    timeoutMs: 30000,
    async execute(args) {
      const facts = store.readFacts()
      const report = writeMaintenanceReport(store, facts, Date.now(), log)
      const lines = [
        '维护报告：' + path.join(store.dir, 'maintenance.md'),
        '事实 ' + facts.length + ' 条｜疑似重复 ' + report.duplicates.length + ' 对｜长期没命中 ' + report.stale.length
          + ' 条｜超长 ' + report.oversized.length + ' 条｜已归档 ' + report.archived.length + ' 条',
      ]
      if (args?.apply !== true) {
        lines.push('（dry-run：没有改动任何数据。确认后再传 apply: true 归档。）')
        return { ok: true, summary: lines.join('\n'), data: { duplicates: report.duplicates.length, stale: report.stale.length, applied: 0 } }
      }
      const targets = new Set(report.stale.map((entry) => entry.fact.id))
      if (targets.size === 0) {
        lines.push('没有需要归档的条目。')
        return { ok: true, summary: lines.join('\n'), data: { applied: 0 } }
      }
      const now = Date.now()
      store.rewriteFacts(facts.map((fact) => (targets.has(fact.id) ? { ...fact, archivedAt: now } : fact)))
      lines.push('已归档 ' + targets.size + ' 条（只降权，不删除，仍保留在 facts.jsonl）。')
      return { ok: true, summary: lines.join('\n'), data: { applied: targets.size, ids: [...targets] } }
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载期忽略
      }
    }
  }
}

/** 工具调用被渲染成的文本（如 `write {"content":...}`），不该当记忆片段。 */
const TOOLISH = /^(write|edit|read|bash|pwsh|grep|glob|todo_write|todo|task|schedule_create|subagent|team_task|godot_[a-z_]+|apply_patch)\s*[{(]/
/** 工具调用的 JSON 载荷，即使前面还有一句说明也要整条丢掉。 */
const TOOLPAYLOAD = /\{"(content|file_path|command|old_string|new_string|code|prompt|todos|path|pattern|query|sessionId)":/

function isToolish(text) {
  const value = oneLine(text)
  return TOOLISH.test(value) || TOOLPAYLOAD.test(value)
}

// ---------------------------------------------------------------------------
// 事实的分类与权重
//
// kind  ：事实属于哪一类（用于同分类候选召回、保底名额、面板分组）
// source：这条是用户明确说的，还是模型自己归纳/推断的
// origin：写入路径（自动抽取 / 工具写入），和"谁说的"是两件事，别混用
// ---------------------------------------------------------------------------

const FACT_KINDS = new Set(['fact', 'correction', 'preference', 'project', 'environment'])
const FACT_SOURCES = new Set(['user', 'inferred'])
/** 老数据没有 kind 字段，靠文本特征把纠正类认回来。 */
const CORRECTION_HINT = /曾被用户纠正|用户纠正过|纠正[:：]|不要再/

/**
 * 老数据迁移（只读时修正，不动磁盘）：
 *  - 没有 kind / kind 非法 → 按文本特征判定 correction，否则 fact
 *  - source 曾是"写入路径"（auto-extract / memory_remember）→ 挪到 origin，source 归为 user
 *  - 补齐 proofCount / hitCount
 */
function migrateFact(fact) {
  if (typeof fact.kind !== 'string' || !FACT_KINDS.has(fact.kind)) {
    fact.kind = CORRECTION_HINT.test(oneLine(fact.text ?? '')) ? 'correction' : 'fact'
  } else if (fact.kind === 'fact' && CORRECTION_HINT.test(oneLine(fact.text ?? ''))) {
    // 老数据统一是 kind:'fact'：靠文本特征把纠正类补认回来（幂等）
    fact.kind = 'correction'
  }
  if (!FACT_SOURCES.has(fact.source)) {
    if (typeof fact.source === 'string' && fact.origin === undefined) fact.origin = fact.source
    fact.source = 'user'
  }
  if (!Number.isFinite(Number(fact.proofCount))) fact.proofCount = 1
  if (!Number.isFinite(Number(fact.hitCount))) fact.hitCount = 0
  return fact
}

/** 事实的时间显示：只给记录日期，不算"距今几天"（差值由模型按当前时间自己判断）。 */
function factDate(fact) {
  return dayOf(Number(fact?.createdAt ?? 0))
}

/**
 * 过去时线索：只有出现这些词，才允许把 ended 的事实捞出来。
 *
 * 刻意收窄 —— 「当时」「那时候」在日常对话里很常见，容易误触发，
 * 所以单独列出来并配了误触发测试（test/past-cue.test.mjs）。
 */
const PAST_CUES = [
  '上次', '上一次', '之前', '以前', '曾经', '当时', '那时候', '那时', '当年',
  '过去', '历史', '旧的', '老版本', '原来是', '记得', 'used to', 'last time', 'previously',
]

function hasPastCue(text) {
  const value = String(text ?? '').toLowerCase()
  if (value === '') return false
  for (const cue of PAST_CUES) {
    if (value.includes(cue)) return true
  }
  return false
}

/** 事实的"最近一次真正被用到"的时间：没有命中记录就退回创建时间。 */
function lastActivityOf(fact) {
  const hit = Number(fact?.lastHitAt ?? 0)
  if (hit > 0) return hit
  return Number(fact?.updatedAt ?? fact?.createdAt ?? 0)
}

/**
 * 长期没被命中的事实只降权，不删除。
 *
 * 90 天未命中 ×0.8，180 天 ×0.6 —— 降权只影响排序，
 * 归档（archivedAt）才是完全不参与匹配，但依然留在文件里。
 */
function decayFactor(fact, now = Date.now()) {
  const anchor = lastActivityOf(fact)
  if (anchor <= 0) return 1
  const days = (now - anchor) / 86400000
  if (days >= 180) return 0.6
  if (days >= 90) return 0.8
  return 1
}

/** 已归档 / 已作废的事实不参与任何自动注入。 */
function isDormant(fact) {
  return fact?.superseded === true || Number(fact?.archivedAt ?? 0) > 0
}

/**
 * 本地关键词匹配已确认事实。
 *
 * 零成本一层：纯内存计算，不查库、不调模型。至少命中 2 个词才算数，避免噪音。
 * 返回 { fact, overlap, score }，score 归一化到 [0,1] 并乘上衰减因子。
 *
 * ended 的事实默认不出现 —— 除非调用方判定这轮确实在问过去的事（options.pastCue）。
 */
function matchFacts(facts, query, limit, options = {}) {
  if (!Array.isArray(facts) || facts.length === 0) return []
  const queryTokens = tokenize(query)
  if (queryTokens.size === 0) return []
  const pastCue = options.pastCue === true
  const now = options.now ?? Date.now()
  const scored = []
  for (const fact of facts) {
    const text = oneLine(fact?.text ?? '')
    if (text === '' || isDormant(fact)) continue
    if (Number(fact?.endedAt ?? 0) > 0 && !pastCue) continue
    let overlap = 0
    for (const token of tokenize(text).keys()) {
      if (queryTokens.has(token)) overlap += 1
    }
    if (overlap < 2) continue
    const score = (overlap / Math.max(1, queryTokens.size)) * decayFactor(fact, now)
    scored.push({ fact, overlap, score })
  }
  scored.sort((left, right) =>
    right.score - left.score ||
    (Number(right.fact.createdAt ?? 0) - Number(left.fact.createdAt ?? 0)))
  return scored.slice(0, Math.max(1, limit))
}

/**
 * 纠正类的保底名额。
 *
 * 只按 proofCount 降序会**固化**：老纠正永远占着名额，新出现的纠正
 * （proofCount 还是 1）永远轮不到。所以名额一分两半：
 * 一半给证据最强的，一半给最近更新过的，剩下的名额再按证据强度补。
 * 保底名额不要求话题匹配。
 */
function pickCorrections(facts, slots) {
  const limit = Math.max(0, Math.floor(Number(slots) || 0))
  if (!Array.isArray(facts) || limit === 0) return []
  const pool = facts.filter((fact) =>
    fact?.kind === 'correction' &&
    oneLine(fact?.text ?? '') !== '' &&
    !isDormant(fact))
  if (pool.length === 0) return []

  const picked = []
  const push = (fact) => {
    if (fact === undefined || picked.includes(fact) || picked.length >= limit) return
    picked.push(fact)
  }
  const byProof = [...pool].sort((left, right) => Number(right.proofCount ?? 1) - Number(left.proofCount ?? 1))
  const byRecent = [...pool].sort((left, right) => lastActivityOf(right) - lastActivityOf(left))

  if (limit === 1) {
    push(byProof[0])
    return picked
  }
  push(byProof[0])
  push(byRecent[0])
  for (const fact of byProof) push(fact)
  return picked
}

/** 事实注入的两个档位：摘要档先让所有候选进场，全文档再按分数买。 */
const FACT_TIER_SHORT = 56
const FACT_TIER_FULL = 200
const FACT_HEADER = '已确认的长期事实（带记录日期）：'

function factLine(fact, chars) {
  return `- [${factDate(fact)}] ${truncate(oneLine(fact.text), chars)}`
}

/**
 * 分层预算填充。
 *
 * 抄 OpenViking 的结论：相关度分数挤在一个窄带里，
 * 所以「把全部预算花在第一名上」是坏赌注 —— 先广度铺摘要档，再按分数升档。
 * 预算不足时停在当前档，不截断半句。
 */
function selectFactLines(entries, budget) {
  if (!Array.isArray(entries) || entries.length === 0) return []
  const alive = entries.filter((entry) => oneLine(entry?.fact?.text ?? '') !== '')
  if (alive.length === 0) return []

  const levels = alive.map(() => 0)
  const lineAt = (index) => factLine(alive[index].fact, levels[index] === 0 ? FACT_TIER_SHORT : FACT_TIER_FULL)
  const total = (count) => {
    let sum = FACT_HEADER.length + 1
    for (let index = 0; index < count; index += 1) sum += lineAt(index).length + 1
    return sum
  }

  // 第一步：全部用摘要档，超预算就从分数最低的开始丢
  let count = alive.length
  while (count > 1 && total(count) > budget) count -= 1
  // 第二步：按分数顺序（entries 已排序）逐个升到全文档，升不动就留在摘要档
  for (let index = 0; index < count; index += 1) {
    levels[index] = 1
    if (total(count) > budget) levels[index] = 0
  }
  // 极端情况：连一条摘要档都放不下，就截这一条
  if (total(count) > budget) {
    const only = truncate(lineAt(0), Math.max(24, budget - FACT_HEADER.length - 2))
    return [FACT_HEADER, only]
  }

  const lines = [FACT_HEADER]
  for (let index = 0; index < count; index += 1) lines.push(lineAt(index))
  return lines
}

/** 把命中事实渲染成一小段注入文本（超出 budget 时按档位降级，不硬切）。 */
function renderFactBlock(entries, budget = 480) {
  const lines = selectFactLines(entries, budget)
  return lines.length === 0 ? '' : lines.join('\n')
}

/** 把 readEvent 的窗口渲染成可读文本（只取模型可见的文本块）。 */
function renderEventWindow(window) {
  const events = Array.isArray(window?.events) ? window.events : []
  const lines = []
  for (const event of events) {
    const type = event?.type
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const message = event?.data?.message ?? event?.data
    const blocks = Array.isArray(message?.content) ? message.content : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text === '') continue
    const role = type === 'user/message' ? '用户' : '助手'
    lines.push(`[${role}#${event?.seq}] ${truncate(oneLine(text), 400)}`)
  }
  return lines.length > 0 ? lines.join('\n') : '(该位置没有可读的对话文本)'
}

/** deep 模式下顺带展开一条上下文。 */
async function expandSession(ctx, sessionId, snippets, config, log) {
  const query = ctx.sessionQuery
  if (!query || typeof query.readEvent !== 'function') return undefined
  const seq = snippets.find((snippet) => Number.isFinite(Number(snippet.seq)))?.seq
  if (!Number.isFinite(Number(seq))) return undefined
  try {
    const window = await query.readEvent({ sessionId, seq: Number(seq), before: 3, after: 3 })
    return renderEventWindow(window)
  } catch (error) {
    log('deep-expand-failed', { sessionId, message: String(error?.message ?? error) })
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 后台异步抽取（回合结束后，用一次廉价模型调用把值得长期记的事实抽出来）
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM = '你是一个记忆抽取器，不负责聊天。只输出抽取结果，不要解释、不要客套、不要编号。'

function buildExtractPrompt(transcript, maxFacts) {
  return [
    '从下面这段对话里，抽取**最多 ' + maxFacts + ' 条**值得长期记住的事实。',
    '',
    '只抽这些类型：用户身份/角色、语言与语气偏好、长期项目与其关键决策、被用户纠正过的做法、跨会话复用的约定。',
    '不要抽：一次性的任务状态、临时数字、过程性寒暄、对助手说过的话的复述。',
    '',
    '输出格式：每行一条，三个字段用竖线 `|` 分隔：分类|来源|陈述句',
    '分类只能是：fact（普通事实）、correction（用户纠正过的做法）、preference（用户偏好）、project（长期项目）、environment（环境与工具约定）',
    '来源只能是：user（用户明确说过的）、inferred（你自己的归纳或推断）',
    '',
    '例子：',
    'project|user|用户在维护一个用 Rust 写的网关心跳服务',
    'correction|user|不要用 PowerShell 的 Set-Content 改写源码文件',
    'preference|user|用户偏好先定要求再写代码',
    '',
    '陈述句要求：一句话一件事，不要编号、不要前缀。',
    '如果没有任何值得记的，只输出：NONE',
    '',
    '对话片段：',
    '"""',
    transcript,
    '"""',
  ].join('\n')
}

/**
 * 解析抽取结果，返回 [{ text, kind, source }]。
 *
 * 容忍模型不守格式：没有前缀的行按 fact|inferred 处理，
 * 但绝不猜它是 correction —— 纠正类走保底注入，误判代价高。
 */
function parseExtracted(text, maxFacts) {
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim()
    if (line === '' || /^NONE$/i.test(line)) continue

    let kind = 'fact'
    let source = 'inferred'
    const tagged = line.match(/^(?:(fact|correction|preference|project|environment)\s*[|｜]\s*)?(?:(user|inferred)\s*[|｜]\s*)?(.+)$/i)
    if (tagged !== null) {
      if (tagged[1] !== undefined) kind = tagged[1].toLowerCase()
      if (tagged[2] !== undefined) source = tagged[2].toLowerCase()
      line = tagged[3].trim()
    }
    line = line.replace(/^["「『]|["」』]$/g, '').trim()
    if (line === '') continue
    // 太短 = 半句；太长 = 模型跑题；以逗号/连接词结尾 = 被截断
    if (line.length < 6 || line.length > 200) continue
    if (/[,，、:：;；]$/.test(line)) continue
    if (/[的和与在对把从是为]$/.test(line)) continue
    if (/^(用户|助手|系统)?(要求|说|问|表示|提到|提到过|希望)$/.test(line)) continue
    if (!FACT_KINDS.has(kind)) kind = 'fact'
    if (!FACT_SOURCES.has(source)) source = 'inferred'
    out.push({ text: line, kind, source })
    if (out.length >= maxFacts) break
  }
  return out
}

// ---------------------------------------------------------------------------
// 事实合并（consolidation）
//
// 抄 hindsight 的协议 + OpenViking 的安全边界：
//  - 候选生成（token 重叠）只负责"值得让模型看一眼"，判断一律交给模型；
//  - 相似/同主题**不构成同一身份的证据**；
//  - 改写旧事实前必须先确认旧文本里没有别的独立信息会被丢掉。
// 日期比较放在代码侧做（新事实一定更晚），不让模型算天数 —— hindsight 实测这条能显著提高判定准确率。
// ---------------------------------------------------------------------------

const CONSOLIDATE_SYSTEM = '你是长期记忆库的整理器，不负责聊天。只输出规定格式的判断结果，不要解释、不要客套、不要代码块。'
const CONSOLIDATE_EFFECTS = new Set(['unrelated', 'repeats', 'changes', 'ends'])

/** 事实 id 的短前缀：给模型看的编号，解析时再映射回真 id。 */
function shortId(id) {
  return String(id ?? '').slice(0, 8)
}

/**
 * 候选生成：为每条新事实挑出最像的几条已有事实。
 *
 * 这一步只是**召回候选**，不是判断。阈值故意放松（共享 2 个 token 就算），
 * 因为漏掉候选等于让模型看不见该合并的对象，而多给几条只是多花一点 prompt。
 */
function candidatePool(candidates, existing, perCandidate = 5, maxPool = 16, sameKind = 2) {
  const picked = new Map()
  const bodiesOf = (candidate) => oneLine(typeof candidate === 'string' ? candidate : candidate?.text ?? '')
  candidates.forEach((candidate) => {
    const body = bodiesOf(candidate)
    const tokens = tokenize(body)
    if (tokens.size === 0) return
    const scored = []
    for (const fact of existing) {
      if (isDormant(fact)) continue
      const text = oneLine(fact?.text ?? '')
      if (text === '') continue
      let shared = 0
      for (const token of tokenize(text).keys()) {
        if (tokens.has(token)) shared += 1
      }
      if (shared >= 2) scored.push({ fact, shared })
    }
    scored.sort((left, right) => right.shared - left.shared)
    for (const entry of scored.slice(0, perCandidate)) {
      if (!picked.has(entry.fact.id)) picked.set(entry.fact.id, entry.fact)
    }

    // 同分类补充：字面不重叠但属于同一类，也可能是同一件事的不同说法。
    // 只补最近更新的几条，避免把整个分类都塞进 prompt。
    const kind = typeof candidate === 'string' ? 'fact' : (candidate?.kind ?? 'fact')
    if (sameKind > 0) {
      const same = existing
        .filter((fact) => fact?.kind === kind && !isDormant(fact) && !picked.has(fact.id) && oneLine(fact?.text ?? '') !== '')
        .sort((left, right) => lastActivityOf(right) - lastActivityOf(left))
        .slice(0, sameKind)
      for (const fact of same) picked.set(fact.id, fact)
    }
  })
  return [...picked.values()].slice(0, maxPool)
}

function buildConsolidatePrompt(candidates, pool) {
  const lines = [
    '你是长期记忆库的整理器。给你一批「新事实」和记忆库里「已有的事实」，逐条判断每条新事实该怎么落。',
    '',
    '规则：',
    '1. 字面相似、主题相近、分类相同，只说明它值得看一眼，**不证明它们说的是同一件事**。',
    '2. 一条事实只讲一个主体的一件事。两条事实即使都提到同一个项目或同一个用户，只要讲的是不同的事，就是两条独立记忆。',
    '3. 只有确实在讲同一主体的同一属性时，才允许合并或改写。',
    '4. 改写已有事实之前，先确认旧文本里没有别的独立信息会被丢掉；有的话，把多余的独立信息另立一条新事实，不要整条覆盖。',
    '5. 新事实的记录时间都晚于已有事实。判断新旧只看语义和日期数字，不要计算"距今多少天"。',
    '6. 新事实如果只是把旧事实说得更具体（旧的范围更大），算 changes，不是 repeats。',
    '',
    '每条新事实输出一行 JSON（不要数组、不要代码块、不要多余文字）：',
    '{"i":序号,"effect":"unrelated|repeats|changes|ends","target":"已有事实的编号或 null","text":"最终要写入的文本","reason":"不超过 20 字"}',
    '',
    '- unrelated：和已有事实无关 → 作为新记忆写入（text 就是这条新事实本身）',
    '- repeats：已有事实已经说过同样的事 → 只加强证据，不新增记录（text 可留空）',
    '- changes：新事实是同一属性的新取值 → 用它改写 target 那条',
    '- ends：新事实表明某事已经结束或不再成立 → 用过去时改写 target，并标记结束',
    '',
    '新事实：',
  ]
  candidates.forEach((candidate, index) => {
    const body = oneLine(typeof candidate === 'string' ? candidate : candidate?.text ?? '')
    const kind = typeof candidate === 'string' ? 'fact' : (candidate?.kind ?? 'fact')
    lines.push(`[${index}] (${kind}) ${body}`)
  })
  lines.push('', '已有事实：')
  if (pool.length === 0) lines.push('（无）')
  else for (const fact of pool) lines.push(`[${shortId(fact.id)}] (${fact.kind ?? 'fact'}) ${factDate(fact)}｜${oneLine(fact.text)}`)
  return lines.join('\n')
}

/** 解析模型输出：一行一个 JSON；认不出的行、指向不明的 target 一律丢弃（宁可退回追加）。 */
function parseConsolidation(output, candidates, pool) {
  const byShortId = new Map()
  for (const fact of pool) byShortId.set(shortId(fact.id), fact)
  const decisions = new Map()
  for (const raw of String(output ?? '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    if (!line.startsWith('{')) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const index = Number(parsed?.i)
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue
    const effect = typeof parsed?.effect === 'string' ? parsed.effect.trim().toLowerCase() : ''
    if (!CONSOLIDATE_EFFECTS.has(effect)) continue
    let target
    if (effect !== 'unrelated') {
      const key = typeof parsed?.target === 'string' ? parsed.target.trim().slice(0, 8) : ''
      target = byShortId.get(key)
      if (target === undefined) continue
    }
    const text = typeof parsed?.text === 'string' ? oneLine(parsed.text) : ''
    decisions.set(index, { effect, target, text, reason: truncate(oneLine(parsed?.reason ?? ''), 40) })
  }
  return decisions
}

/**
 * 把判定落到数据上。
 *
 * 约定：`createdAt` 永远是首次记录时间，改写只更新 `updatedAt` 并把旧值压进 `history`。
 * `proofCount` 记录被反复确认的次数（hindsight 的 proof_count），重复不产生新记录。
 */
function applyConsolidation(facts, candidates, decisions, sessionId) {
  const byId = new Map(facts.map((fact) => [fact.id, fact]))
  const now = Date.now()
  const stats = { added: 0, changed: 0, ended: 0, reinforced: 0 }

  const reinforce = (fact) => {
    fact.proofCount = Number(fact.proofCount ?? 1) + 1
    fact.lastConfirmedAt = now
    stats.reinforced += 1
  }

  candidates.forEach((raw, index) => {
    const candidate = typeof raw === 'string'
      ? { text: raw, kind: 'fact', source: 'inferred' }
      : { kind: 'fact', source: 'inferred', ...raw }
    const decision = decisions.get(index)
    const decided = typeof decision?.text === 'string' && decision.text !== '' ? decision.text : candidate.text
    const body = truncate(oneLine(decided), 400)
    if (decision === undefined || decision.effect === 'unrelated') {
      if (body === '') return
      const twin = [...byId.values()].find((fact) => !isDormant(fact) && oneLine(fact.text ?? '') === body)
      if (twin !== undefined) {
        reinforce(twin)
        return
      }
      const fact = {
        id: randomUUID(),
        kind: FACT_KINDS.has(candidate.kind) ? candidate.kind : 'fact',
        source: FACT_SOURCES.has(candidate.source) ? candidate.source : 'inferred',
        text: body,
        createdAt: now,
        origin: 'auto-extract',
        proofCount: 1,
        hitCount: 0,
        ...(sessionId === undefined ? {} : { sessionId }),
      }
      byId.set(fact.id, fact)
      stats.added += 1
      return
    }

    const target = decision.target
    if (decision.effect === 'repeats') {
      reinforce(target)
      return
    }

    // changes / ends：改写原文，旧值留档
    const previous = oneLine(target.text ?? '')
    if (body === '' || body === previous) {
      reinforce(target)
      return
    }
    const history = Array.isArray(target.history) ? target.history : []
    history.push({ text: previous, at: Number(target.updatedAt ?? target.createdAt ?? now) })
    if (history.length > 12) history.splice(0, history.length - 12)
    target.history = history
    target.text = body
    target.updatedAt = now
    if (decision.effect === 'ends') {
      target.endedAt = now
      stats.ended += 1
    } else {
      stats.changed += 1
    }
  })

  return { stats, facts: [...byId.values()] }
}

/**
 * 合并一批新抽取出的事实。
 *
 * 没有候选时**不调模型**（纯本地追加）；模型不可用以至调用失败时降级为精确字符串去重。
 * 返回 stats，`added` 是真正新增的条数。
 */
async function consolidateFacts(ctx, config, store, state, log, candidates, sessionId) {
  const existing = store.readFacts()
  const pool = candidatePool(candidates, existing)
  log('consolidate-plan', { candidates: candidates.length, pool: pool.length })

  if (pool.length === 0) {
    const applied = applyConsolidation(existing, candidates, new Map(), sessionId)
    store.rewriteFacts(applied.facts)
    return applied.stats
  }

  const route = resolveExtractModel(ctx, config)
  const llm = ctx.get('llm')
  if (route === null || !llm || typeof llm.stream !== 'function') {
    log('consolidate-skip', { reason: 'no-model-route' })
    return null
  }

  let output = ''
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      system: CONSOLIDATE_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildConsolidatePrompt(candidates, pool) }] }],
      maxTokens: Math.min(900, 160 + candidates.length * 90 + pool.length * 10),
      temperature: 0,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
      if (chunk?.type === 'finish') break
    }
  } catch (error) {
    log('consolidate-call-failed', { message: String(error?.message ?? error) })
    return null
  }

  const decisions = parseConsolidation(output, candidates, pool)
  if (decisions.size === 0) {
    log('consolidate-unparsed', { chars: output.length, preview: truncate(oneLine(output), 120) })
    return null
  }

  const applied = applyConsolidation(existing, candidates, decisions, sessionId)
  store.rewriteFacts(applied.facts)
  log('consolidate-applied', { ...applied.stats, decided: decisions.size })
  return applied.stats
}

/** 解析抽取用的模型路由：显式配置优先，否则用当前默认模型。 */
function resolveExtractModel(ctx, config) {
  if (config.extractProvider !== '' && config.extractModel !== '') {
    return { provider: config.extractProvider, model: config.extractModel, source: 'config' }
  }
  const service = ctx.get('agentDefaultModel')
  const selection = typeof service?.currentSelection === 'function' ? service.currentSelection() : undefined
  if (!selection || typeof selection !== 'object') return null
  const provider = selection.provider ?? selection.providerId
  const model = selection.model ?? selection.modelId
  if (typeof provider !== 'string' || model === undefined || model === null || String(model) === '') return null
  return { provider, model: String(model), source: 'default' }
}

/**
 * 抽取一次。对外只返回写入条数，任何异常都吞掉 —— 记忆抽取永远不能影响主对话。
 */
async function extractFacts(ctx, config, store, state, log, sessionId, signal) {
  const llm = ctx.get('llm')
  const sessionQuery = ctx.sessionQuery
  if (!llm || typeof llm.stream !== 'function' || !sessionQuery) return 0

  const route = resolveExtractModel(ctx, config)
  if (route === null) {
    log('extract-skip', { reason: 'no-model-route' })
    return 0
  }

  const marks = state.extractMarks ?? (state.extractMarks = store.readExtractMarks())
  const lastSeq = Number(marks[sessionId] ?? 0)

  let docs = []
  try {
    docs = await sessionQuery.filterEvents(sessionId, [
      { kind: 'type', values: ['user/message', 'assistant/message'] },
    ])
  } catch (error) {
    log('extract-read-failed', { message: String(error?.message ?? error) })
    return 0
  }

  const fresh = (Array.isArray(docs) ? docs : [])
    .filter((doc) => Number(doc?.seq ?? 0) > lastSeq)
    .map((doc) => ({ seq: Number(doc?.seq ?? 0), text: oneLine(doc?.text ?? '') }))
    .filter((doc) => doc.text !== '' && !isToolish(doc.text) && !isBoilerplate(doc.text))
  if (fresh.length === 0) return 0

  const maxSeq = fresh.reduce((acc, doc) => Math.max(acc, doc.seq), lastSeq)
  const joined = fresh.map((doc) => doc.text).join('\n')
  const transcript = truncate(joined.slice(-config.extractMaxChars * 2), config.extractMaxChars)
  if (transcript.length < 80) {
    marks[sessionId] = maxSeq
    return 0
  }

  let output = ''
  try {
    const options = {
      provider: route.provider,
      model: route.model,
      system: EXTRACT_SYSTEM,
      messages: [
        { role: 'user', content: [{ type: 'text', text: buildExtractPrompt(transcript, config.extractMaxFacts) }] },
      ],
      maxTokens: 400,
      temperature: 0,
    }
    if (signal !== undefined) options.signal = signal
    for await (const chunk of llm.stream(options)) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
      if (chunk?.type === 'finish') break
    }
  } catch (error) {
    log('extract-call-failed', { message: String(error?.message ?? error) })
    return 0
  }

  marks[sessionId] = maxSeq
  store.saveExtractMarks(marks)

  const candidates = parseExtracted(output, config.extractMaxFacts)
  if (candidates.length === 0) {
    log('extract-empty', { model: route.model, source: route.source })
    return 0
  }

  // 落库前先过合并：重复→加强证据，新值→改写旧条，无关→新增
  let stats = null
  if (config.autoConsolidate) {
    try {
      stats = await consolidateFacts(ctx, config, store, state, log, candidates, sessionId)
    } catch (error) {
      log('consolidate-failed', { message: String(error?.message ?? error) })
    }
  }

  if (stats === null) {
    // 降级路径：只做精确字符串去重（合并不可用时仍然不能写重复行）
    const existing = new Set(store.readFacts().map((fact) => oneLine(fact.text ?? '')))
    let written = 0
    for (const candidate of candidates) {
      const body = truncate(oneLine(candidate?.text ?? ''), 400)
      if (body === '' || existing.has(body)) continue
      const ok = store.appendFact({
        id: randomUUID(),
        kind: FACT_KINDS.has(candidate?.kind) ? candidate.kind : 'fact',
        source: FACT_SOURCES.has(candidate?.source) ? candidate.source : 'inferred',
        text: body,
        createdAt: Date.now(),
        origin: 'auto-extract',
        proofCount: 1,
        hitCount: 0,
        sessionId,
      })
      if (ok) {
        written += 1
        existing.add(body)
      }
    }
    stats = { added: written, changed: 0, ended: 0, reinforced: 0 }
  }

  log('extract-written', {
    model: route.model,
    source: route.source,
    candidates: candidates.length,
    added: stats.added,
    changed: stats.changed,
    ended: stats.ended,
    reinforced: stats.reinforced,
  })
  return stats.added
}

// ---------------------------------------------------------------------------
// 静默注入
// ---------------------------------------------------------------------------

function createNoticeMessage(text, summary) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { ...PLUGIN_SOURCE, form: 'notice', summary: truncate(oneLine(summary), NOTICE_SUMMARY_MAX) },
  })
}

/** 取本步真正的用户输入文本（认领的消息里最后一条）。 */
function claimedUserText(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const blocks = Array.isArray(message?.content) ? message.content : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return ''
}

/**
 * 自动召回：只在"话题沾边"时注入，没命中就什么都不做。
 *
 * 判定刻意做得便宜：先看有没有明确的回忆指代，再看会话卡命中了几个词。
 * 任一条件成立才去取证据；取不到证据就不注入 —— 宁缺毋滥。
 */
// ---------------------------------------------------------------------------
// 命中统计 / 维护报告
// ---------------------------------------------------------------------------

/** 记录一次"话题命中"。保底注入不算 —— 否则那些事实永远降不了权。 */
function recordHit(state, id) {
  if (typeof id !== 'string' || id === '') return
  const hits = state.hits ?? (state.hits = new Map())
  hits.set(id, (hits.get(id) ?? 0) + 1)
}

/**
 * 把攒下的命中写回 facts.jsonl。
 *
 * 刻意不在每轮写盘：命中统计是锦上添花，不值一次全文件重写。
 */
function flushHits(store, state, log) {
  const hits = state.hits
  if (!(hits instanceof Map) || hits.size === 0) return 0
  const facts = store.readFacts()
  const now = Date.now()
  let touched = 0
  for (const fact of facts) {
    const count = hits.get(fact.id)
    if (count === undefined) continue
    fact.hitCount = Number(fact.hitCount ?? 0) + count
    fact.lastHitAt = now
    touched += 1
  }
  hits.clear()
  if (touched > 0) store.rewriteFacts(facts)
  log('hits-flushed', { facts: touched })
  return touched
}

/** 多久没被用过算"长期没命中"（只降权，不删除）。 */
const STALE_DAYS = 180

/**
 * 生成维护报告。**只出报告，不改数据** —— 归档要人显式确认。
 *
 * 报告内容：疑似重复（字面 Jaccard ≥ 0.5）、长期没命中、超长条目、已归档。
 */
function buildMaintenanceReport(facts, now = Date.now()) {
  const alive = (Array.isArray(facts) ? facts : []).filter((fact) => !isDormant(fact) && oneLine(fact?.text ?? '') !== '')
  const tokens = alive.map((fact) => tokenize(oneLine(fact.text)))
  const stale = []
  const oversized = []
  const duplicates = []

  alive.forEach((fact, index) => {
    if (oneLine(fact.text).length > 300) oversized.push(fact)
    const days = Math.round((now - lastActivityOf(fact)) / 86400000)
    if (Number(fact.hitCount ?? 0) === 0 && days >= STALE_DAYS) stale.push({ fact, days })
    for (let other = index + 1; other < alive.length; other += 1) {
      const left = tokens[index]
      const right = tokens[other]
      if (left.size === 0 || right.size === 0) continue
      let shared = 0
      for (const token of left.keys()) if (right.has(token)) shared += 1
      const union = left.size + right.size - shared
      if (union > 0 && shared / union >= 0.5) duplicates.push({ a: fact, b: alive[other], jaccard: shared / union })
    }
  })

  const archived = (Array.isArray(facts) ? facts : []).filter((fact) => Number(fact?.archivedAt ?? 0) > 0)
  const markdown = [
    '# 记忆库维护报告（dry-run，未改动任何数据）',
    '',
    `生成时间：${dayOf(now)}　事实总数：${facts.length}　参与检查：${alive.length}　已归档：${archived.length}`,
    '',
    `## 疑似重复（${duplicates.length} 对）`,
    ...duplicates.slice(0, 30).map((pair) =>
      `- ${pair.jaccard.toFixed(2)}｜${shortId(pair.a.id)} ${truncate(oneLine(pair.a.text), 50)}\n  ${shortId(pair.b.id)} ${truncate(oneLine(pair.b.text), 50)}`),
    duplicates.length === 0 ? '- （无）' : '',
    '',
    `## 长期没命中（${stale.length} 条，≥${STALE_DAYS} 天且从未被话题命中）`,
    ...stale.sort((left, right) => right.days - left.days).slice(0, 40)
      .map((entry) => `- ${entry.days} 天｜${shortId(entry.fact.id)} ${truncate(oneLine(entry.fact.text), 70)}`),
    stale.length === 0 ? '- （无）' : '',
    '',
    `## 超长条目（${oversized.length} 条，>300 字，建议拆成多条）`,
    ...oversized.slice(0, 20).map((fact) => `- ${shortId(fact.id)} ${oneLine(fact.text).length} 字｜${truncate(oneLine(fact.text), 60)}`),
    oversized.length === 0 ? '- （无）' : '',
    '',
    '## 已归档（不参与注入与匹配，但保留在 facts.jsonl）',
    ...archived.slice(0, 20).map((fact) => `- ${shortId(fact.id)} ${dayOf(Number(fact.archivedAt))}｜${truncate(oneLine(fact.text), 60)}`),
    archived.length === 0 ? '- （无）' : '',
    '',
    '> 归档请显式调用 `memory_maintain` 并传 `apply: true`；本报告本身不会改动数据。',
  ].filter((line) => line !== '').join('\n')

  return { markdown, duplicates, stale, oversized, archived, checked: alive.length }
}

/** 写维护报告到记忆目录（dry-run）。 */
function writeMaintenanceReport(store, facts, now, log) {
  const report = buildMaintenanceReport(facts, now)
  try {
    fs.writeFileSync(path.join(store.dir, 'maintenance.md'), report.markdown, 'utf8')
    log('maintenance-written', {
      duplicates: report.duplicates.length,
      stale: report.stale.length,
      oversized: report.oversized.length,
      archived: report.archived.length,
    })
  } catch (error) {
    log('maintenance-failed', { message: String(error?.message ?? error) })
  }
  return report
}

async function autoRecall(payload, ctx, config, store, state, log) {
  const agent = payload?.agent
  const session = agent?.session
  const query = claimedUserText(payload)
  if (query === '') return null
  if (state.lastInjected?.get(session) === query) return null

  const cue = hasRecallCue(query)
  const pastCue = hasPastCue(query)
  const index = state.index ?? store.readIndex()
  const cards = index?.cards ?? {}
  const queryTokens = tokenize(query)
  const scored = Object.keys(cards).length > 0 ? scoreCards(cards, queryTokens, Date.now()) : []
  const hits = scored.filter((entry) => entry.score >= config.cardScoreThreshold)
  const strong = hits.slice(0, config.maxEvidenceSessions)

  // 已确认事实是最便宜的一层：本地关键词匹配，不查库、不调模型
  const facts = store.readFacts()
  const factHits = matchFacts(facts, query, config.injectMaxFacts, { pastCue })

  // 纠错类是保底名额：不要求话题匹配，但每会话只提醒一次（同样的句子每轮重复纯噪音）
  const shown = state.correctionsShown ?? (state.correctionsShown = new Set())
  const guaranteed = pickCorrections(facts, config.injectCorrectionSlots)
    .filter((fact) => !shown.has(fact.id))
  for (const fact of guaranteed) shown.add(fact.id)

  // 保底注入**不算命中** —— 否则它们每轮都"命中"，永远触发不了降权
  for (const entry of factHits) recordHit(state, entry.fact.id)

  const entries = [
    ...guaranteed.map((fact) => ({ fact, score: 1, guaranteed: true })),
    ...factHits
      .filter((entry) => !guaranteed.includes(entry.fact))
      .map((entry) => ({ fact: entry.fact, score: entry.score })),
  ]

  if (strong.length === 0 && !cue && entries.length === 0) {
    log('auto-recall-skip', { reason: 'no-hit', tokens: queryTokens.size, sessions: Object.keys(cards).length })
    return null
  }

  // 主通道：直接用宿主的全库 FTS
  const found = await searchHistory(ctx, query, config.maxEvidenceSessions, log, state)
  const matches = []
  for (const hit of found) {
    if (hit.snippet === '') continue
    matches.push({
      card: { id: hit.sessionId, title: hit.title, createdAt: hit.createdAt },
      score: 1,
      snippets: [{ text: hit.snippet, seq: hit.seq }],
    })
  }
  // 兜底：FTS 没结果时退回会话卡关键词命中（中文分词不理想时仍能捞到）
  if (matches.length === 0) {
    for (const entry of strong) {
      const snippets = await collectEvidence(ctx.sessionQuery, entry.card, query, config, log)
      if (snippets.length === 0) continue
      matches.push({ card: entry.card, score: entry.score, snippets })
    }
  }

  // 画像已经常驻在系统提示里，自动召回只补"已确认事实 + 历史片段"
  // 预算按档位分配：事实最多占一半，剩下的给历史片段，最后兜底不硬切半句
  const factBudget = Math.max(160, Math.floor(config.injectBudgetChars * 0.5))
  const factText = renderFactBlock(entries, factBudget)
  const remain = Math.max(0, config.injectBudgetChars - (factText === '' ? 0 : factText.length + 1))
  const history = remain > 120 ? composeInjection('', matches, { ...config, injectBudgetChars: remain }) : ''
  const text = [factText, history].filter((part) => part !== '').join('\n')
  if (text === '') return null

  state.lastInjected = state.lastInjected ?? new WeakMap()
  if (session !== null && typeof session === 'object') state.lastInjected.set(session, query)
  for (const match of matches) {
    match.card.recallCount = (match.card.recallCount || 0) + 1
    match.card.lastRecallAt = Date.now()
  }
  if (index) store.writeIndex(index)

  log('auto-recall-inject', {
    cue,
    pastCue,
    guaranteed: guaranteed.length,
    facts: factHits.length,
    matches: matches.length,
    score: matches[0] ? Number(matches[0].score.toFixed(3)) : 0,
    chars: text.length,
  })
  return { text, summary: '记忆：已召回 ' + matches.length + ' 段相关历史' }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const cfg = normalize(config)
  if (!cfg.enabled) return

  const logs = []
  const log = (event, detail) => {
    if (!cfg.debug) return
    const line = JSON.stringify({ t: new Date().toISOString(), event, ...(detail ?? {}) })
    logs.push(line)
    if (logs.length > 200) logs.shift()
    try {
      const file = path.join(cfg.memoryDir, 'debug.log')
      if (logs.length === 1) {
        fs.mkdirSync(cfg.memoryDir, { recursive: true })
        fs.writeFileSync(file, '', 'utf8')
      }
      fs.appendFileSync(file, line + '\n', 'utf8')
    } catch {
      // 日志失败绝不影响主流程
    }
  }

  const store = createStore(cfg, log)
  const state = {
    index: null,
    profileCache: '',
    profileSnapshot: undefined,
    profileSession: undefined,
    lastInjected: new WeakMap(),
    indexBuild: null,
    hits: new Map(),
    correctionsShown: new Set(),
    lastMaintainCount: 0,
  }

  /**
   * 画像快照：会话内冻结，新会话才重载。
   *
   * 抄 hermes 的做法 —— 画像在会话开始渲进 system prompt 后就不再变动，
   * 手改 profile.md 只写盘不进 prompt，这样 prompt 前缀缓存不会被反复打断。
   * 例外：memory_remember 主动写入时直接刷新（那是明确意图，不是后台漂移）。
   */
  const profileForPrompt = () => {
    if (typeof state.profileSnapshot === 'string') return state.profileSnapshot
    state.profileSnapshot = store.profileText()
    return state.profileSnapshot
  }
  const syncProfileSession = (session) => {
    if (session === undefined) return
    if (state.profileSession === session) return
    state.profileSession = session
    state.profileSnapshot = store.profileText()
    log('profile-snapshot', { chars: state.profileSnapshot.length })
  }

  log('plugin-start', { dir: cfg.memoryDir, injectMode: cfg.injectMode, profileChars: store.profileText().length })

  // 静态策略段：内容固定 → 对提示缓存友好
  // 注意：systemPrompt 不在 inject 里，必须用 ctx.get() 拿，直接 ctx.systemPrompt 会抛。
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    systemPrompt.section({ name: 'remember:policy', order: 9400, text: SYSTEM_SECTION })
    // 画像常驻：走会话内冻结的快照（新会话重载），手改 profile.md 不会打断提示缓存
    systemPrompt.section({
      name: 'remember:profile',
      order: 9410,
      text: () => {
        const text = profileForPrompt()
        if (text === '') return ''
        const body = truncate(text.replace(/\s+\n/g, '\n'), cfg.profileMaxChars)
        // 标题里直接给出占用比例：让模型自己判断还剩多少预算（抄 hermes）
        const limit = cfg.profileMaxChars
        const used = body.length
        const usage = limit > 0 ? Math.round((used / limit) * 100) + '% — ' + used + '/' + limit + ' chars' : used + ' chars'
        return '## 用户长期画像（跨会话）[' + usage + ']\n\n' + body
      },
    })
  }

  // 记忆工具
  const disposeTools = registerTools(ctx, cfg, store, state, log)

  // 给客户端面板提供一个只读数据接口（本地回环，只读）。
  //
  // 坑：不能在挂载时用 ctx.get('webServer')。webServer 由 web-runtime 行异步挂载，
  // 本插件先于它就绪，挂载时读到的永远是 undefined，注册被静默跳过 —— 面板就 404。
  // 正确姿势是 ctx.inject(['webServer'], cb)：服务就绪后才跑回调，插件其余部分不被它阻塞。
  const memorySnapshot = async () => {
    const facts = store.readFacts().slice().sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
    const indexNow = store.readIndex() ?? { cards: {} }
    const cards = Object.values(indexNow.cards)
      .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
      .slice(0, 120)
    const body = JSON.stringify({
      dir: store.dir,
      generatedAt: Date.now(),
      profile: store.profileText(),
      facts: facts.map((fact) => ({
        id: fact.id,
        text: fact.text,
        createdAt: Number(fact.createdAt ?? 0),
        updatedAt: Number(fact.updatedAt ?? 0),
        endedAt: Number(fact.endedAt ?? 0),
        proofCount: Number(fact.proofCount ?? 1),
        history: Array.isArray(fact.history) ? fact.history.length : 0,
        source: fact.source ?? '',
      })),
      sessions: cards.map((card) => ({
        id: card.id,
        title: card.title,
        createdAt: Number(card.createdAt ?? 0),
        msgCount: card.msgCount ?? 0,
      })),
    })
    return new Response(body, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const registerMemoryRoute = (hostCtx) => {
    const server = hostCtx?.webServer
    if (!server || typeof server.register !== 'function') {
      log('web-route-skip', { reason: 'no-webServer' })
      return
    }
    try {
      const dispose = server.register({
        kind: 'exact',
        path: '/remember/memory.json',
        resource: memorySnapshot,
      })
      if (typeof hostCtx.effect === 'function') hostCtx.effect(() => dispose)
      log('web-route-registered', { path: '/remember/memory.json' })
    } catch (error) {
      log('web-route-failed', { message: String(error?.message ?? error) })
    }
  }

  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerMemoryRoute)
  else registerMemoryRoute(ctx)

  // 后台抽取：回合收尾时跑一次，fire-and-forget；同一会话同时只跑一个。
  // 刻意不传 turn 的 signal —— 抽取要在这一轮结束之后继续跑，不能被收尾取消。
  state.extractMarks = store.readExtractMarks()
  if (cfg.autoExtract && typeof ctx.on === 'function') {
    const inFlight = new Set()
    ctx.on('agent/turn-stopping', (payload) => {
      const agent = payload?.agent
      const session = agent?.session
      syncProfileSession(session)
      // 先把攒下的命中落盘，再让抽取去读文件 —— 抽取会整体重写 facts.jsonl
      try {
        flushHits(store, state, log)
      } catch (error) {
        log('hits-flush-failed', { message: String(error?.message ?? error) })
      }
      // 事实攒到一定规模才出维护报告（dry-run，不改数据）
      try {
        const total = store.readFacts().length
        if (total >= cfg.maintainThreshold && total - state.lastMaintainCount >= 20) {
          state.lastMaintainCount = total
          writeMaintenanceReport(store, store.readFacts(), Date.now(), log)
        }
      } catch (error) {
        log('maintenance-trigger-failed', { message: String(error?.message ?? error) })
      }
      const sessionId = typeof session === 'string'
        ? session
        : (typeof session?.id === 'string' ? session.id : undefined)
      if (sessionId === undefined || inFlight.has(sessionId)) return
      inFlight.add(sessionId)
      setImmediate(() => {
        extractFacts(ctx, cfg, store, state, log, sessionId, undefined)
          .catch((error) => log('extract-failed', { message: String(error?.message ?? error) }))
          .finally(() => inFlight.delete(sessionId))
      })
    })
  }

  // 启动即预热索引（后台，不阻塞）
  state.profileCache = store.profileText()
  state.index = store.readIndex()
  state.indexBuild = refreshIndex(ctx, cfg, store, log, { budgetMs: 3000 })
    .then((index) => {
      if (index) state.index = index
      return index
    })
    .catch((error) => {
      log('index-preheat-failed', { message: String(error?.message ?? error) })
      return null
    })

  // 自检：确认宿主全库 FTS 这条通道真的可用（结果只写日志，不影响对话）
  if (cfg.debug) {
    Promise.resolve()
      .then(() => searchHistory(ctx, '记忆 插件 设计 长期', 3, log, state))
      .then((hits) => log('selfcheck-search', { hits: hits.length, titles: hits.map((hit) => hit.title) }))
      .catch((error) => log('selfcheck-failed', { message: String(error?.message ?? error) }))

    // 端到端自检：卡片路由 → 会话内逐条扫描取原文
    Promise.resolve()
      .then(() => state.indexBuild)
      .then(async () => {
        const probe = '记忆 插件 长期 检索 设计'
        const cards = store.readIndex()?.cards ?? {}
        const scored = scoreCards(cards, tokenize(probe), Date.now()).slice(0, 2)
        const report = []
        for (const entry of scored) {
          const snippets = await collectEvidence(ctx.sessionQuery, entry.card, probe, cfg, log)
          report.push({
            title: entry.card.title,
            score: Number(entry.score.toFixed(3)),
            snippets: snippets.map((snippet) => truncate(snippet.text, 70)),
          })
        }
        log('selfcheck-cards', { cards: Object.keys(cards).length, matched: report.length, report })
      })
      .catch((error) => log('selfcheck-cards-failed', { message: String(error?.message ?? error) }))
  }

  if (typeof ctx.on === 'function' && cfg.autoInject && cfg.injectMode !== 'off') {
    ctx.on('agent/pre-step', async (payload, next) => {
      syncProfileSession(payload?.agent?.session)
      const decision = await next()
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
      if (payload?.signal?.aborted === true) return decision
      try {
        // 索引过期就顺手刷新（有 TTL，且刷新本身有预算）
        const index = state.index
        if (index === null || Date.now() - (index.updatedAt ?? 0) > cfg.indexTtlMs) {
          state.indexBuild = refreshIndex(ctx, cfg, store, log, { budgetMs: 1500 })
            .then((next_) => {
              if (next_) state.index = next_
              return next_
            })
            .catch(() => null)
        }
        const recalled = await autoRecall(payload, ctx, cfg, store, state, log)
        if (recalled === null) return decision
        const notice = createNoticeMessage(recalled.text, recalled.summary)
        const claimed = Array.isArray(payload?.messages) ? payload.messages : []
        const messages = Array.isArray(decision.messages) ? decision.messages : []
        const index_ = messages.findLastIndex((message) => claimed.includes(message))
        const merged = index_ < 0
          ? [...messages, notice]
          : [...messages.slice(0, index_ + 1), notice, ...messages.slice(index_ + 1)]
        return { ...decision, messages: merged }
      } catch (error) {
        log('pre-step-failed', { message: String(error?.message ?? error) })
        return decision
      }
    })
  }

  const cleanup = () => {
    log('plugin-stop')
    try {
      disposeTools()
    } catch {
      // 忽略卸载期错误
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  return cleanup
}

// 注意：这里不导出 Config —— 配置走 cordis.patch.yml + normalize() 的宽松归一化，
// 避免不同 Harness 版本的 Config 校验器对 schema 形态有额外要求。
export {
  apply,
  inject,
  name,
  normalize,
  tokenize,
  scoreCards,
  composeInjection,
  hasRecallCue,
  // 以下给离线自测用（宿主不消费）
  matchFacts,
  renderFactBlock,
  selectFactLines,
  candidatePool,
  parseConsolidation,
  applyConsolidation,
  buildConsolidatePrompt,
  buildExtractPrompt,
  parseExtracted,
  applyProfileOps,
  profileBodyText,
  profileCapacity,
  hasPastCue,
  pickCorrections,
  decayFactor,
  migrateFact,
  buildMaintenanceReport,
  recordHit,
}
