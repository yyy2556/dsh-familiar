/**
 * 离线自测：过去时线索、ended 过滤、纠正保底名额、衰减、命中统计、老数据迁移、维护报告。
 *
 * node test/recall.test.mjs
 */
import assert from 'node:assert/strict'
import {
  matchFacts,
  hasPastCue,
  pickCorrections,
  decayFactor,
  recordHit,
  migrateFact,
  buildMaintenanceReport,
  tokenize,
} from '../index.js'

let passed = 0
const cases = []
const test = (title, fn) => cases.push({ title, fn })

const DAY = 86400000
const fact = (id, text, createdAt, extra = {}) => ({ id, kind: 'fact', text, createdAt, ...extra })

// ---------------------------------------------------------------------------
// 过去时线索：误触发率
// ---------------------------------------------------------------------------

// 日常对话，**不是**在问过去的事
const EVERYDAY = [
  '现在把 Godot 进程全部停掉',
  '这个函数应该返回布尔值',
  '帮我看看这段 GDScript 为什么报错',
  '商店卡片的配色再调深一点',
  '并发不要超过 4 个',
  '磁盘空间不够了',
  '把这份报告导出成 PDF',
  '为什么这个测试挂了',
  '重启一下 DSH',
  '这个插件叫什么名字',
  '当时说好的配色是深绿',
  '那时候的版本号是 0.2',
]

// 明确在问过去的事
const ASKING_PAST = [
  '上次我们说的那个配色是什么',
  '之前定的并发上限是多少',
  '以前那个记忆插件是怎么做的',
  '你还记得当时得出的结论吗',
  '历史上我们试过哪些方案',
]

test('过去时线索：日常句子的误触发率可接受', () => {
  const fired = EVERYDAY.filter((text) => hasPastCue(text))
  const rate = fired.length / EVERYDAY.length
  console.log(`       → 日常句子 ${EVERYDAY.length} 句，误触发 ${fired.length} 句（${(rate * 100).toFixed(1)}%）`)
  for (const text of fired) console.log(`         误触发：${text}`)
  assert.ok(rate <= 0.25, `误触发率 ${(rate * 100).toFixed(1)}% 超过 25%`)
})

test('过去时线索：明确问过去的句子全部命中', () => {
  for (const text of ASKING_PAST) {
    assert.equal(hasPastCue(text), true, '漏了：' + text)
  }
})

// ---------------------------------------------------------------------------
// ended 的事实默认不注入
// ---------------------------------------------------------------------------

test('ended 的事实默认不出现，问过去时才出现', () => {
  const facts = [
    fact('live', '用户的并发上限是 4', 1000),
    fact('ended', '用户的并发上限是 2', 2000, { endedAt: 5000 }),
  ]
  const now = 1000
  const plain = matchFacts(facts, '用户的并发上限是多少', 5, { now })
  assert.deepEqual(plain.map((entry) => entry.fact.id), ['live'])

  const withPast = matchFacts(facts, '用户的并发上限原来是多少', 5, { now, pastCue: true })
  assert.deepEqual(withPast.map((entry) => entry.fact.id).sort(), ['ended', 'live'])
})

test('已归档的事实无论问不问过去都不出现', () => {
  const facts = [fact('gone', '用户的并发上限是 8', 1000, { archivedAt: 4000 })]
  assert.equal(matchFacts(facts, '用户的并发上限是多少', 5, { now: 1000, pastCue: true }).length, 0)
})

// ---------------------------------------------------------------------------
// 纠正类保底名额
// ---------------------------------------------------------------------------

test('保底名额：一个给证据最强的，一个给最近的', () => {
  const facts = [
    { ...fact('old-strong', '不要用 PowerShell 改源码', 100), kind: 'correction', proofCount: 9 },
    { ...fact('old-weak', '不要批量启动进程', 200), kind: 'correction', proofCount: 1 },
    { ...fact('new', '不要提交 .godot 目录', 300), kind: 'correction', proofCount: 1 },
  ]
  const picked = pickCorrections(facts, 2).map((entry) => entry.id)
  assert.ok(picked.includes('old-strong'), '应包含证据最强的：' + picked.join(','))
  assert.ok(picked.includes('new'), '应包含最近的，避免名额固化：' + picked.join(','))
  assert.equal(picked.length, 2)
})

test('保底名额：只要 1 个时给证据最强的', () => {
  const facts = [
    { ...fact('strong', '不要用 PowerShell 改源码', 100), kind: 'correction', proofCount: 9 },
    { ...fact('new', '不要提交 .godot 目录', 300), kind: 'correction', proofCount: 1 },
  ]
  assert.deepEqual(pickCorrections(facts, 1).map((entry) => entry.id), ['strong'])
})

test('保底名额：不算普通事实、不算归档的', () => {
  const facts = [
    fact('plain', '普通事实', 100),
    { ...fact('archived', '已归档的纠正', 200), kind: 'correction', archivedAt: 300 },
    { ...fact('ok', '有效纠正', 300), kind: 'correction' },
  ]
  assert.deepEqual(pickCorrections(facts, 2).map((entry) => entry.id), ['ok'])
})

test('保底名额：slots=0 时返回空', () => {
  const facts = [{ ...fact('c', '有效纠正', 100), kind: 'correction' }]
  assert.equal(pickCorrections(facts, 0).length, 0)
})

// ---------------------------------------------------------------------------
// 衰减与命中统计
// ---------------------------------------------------------------------------

test('长期没命中只降权，不消失', () => {
  const now = 1000 * DAY
  assert.equal(decayFactor({ lastHitAt: now - 10 * DAY }, now), 1)
  assert.equal(decayFactor({ lastHitAt: now - 100 * DAY }, now), 0.8)
  assert.equal(decayFactor({ lastHitAt: now - 200 * DAY }, now), 0.6)
  assert.equal(decayFactor({ createdAt: now - 400 * DAY }, now), 0.6, '从没命中过就按创建时间算')
})

test('衰减只影响排序，不改变是否能被匹配到', () => {
  const now = 400 * DAY
  const facts = [
    fact('fresh', '用户的并发上限是 4', now - 1 * DAY),
    fact('stale', '用户的并发上限是 6', now - 300 * DAY),
  ]
  const hits = matchFacts(facts, '用户的并发上限是多少', 5, { now })
  assert.equal(hits.length, 2, '两条都该被匹配到')
  assert.equal(hits[0].fact.id, 'fresh', '新的应排在前面')
})

test('recordHit 只累加，不写盘', () => {
  const state = {}
  recordHit(state, 'a')
  recordHit(state, 'a')
  recordHit(state, 'b')
  assert.equal(state.hits.get('a'), 2)
  assert.equal(state.hits.get('b'), 1)
})

// ---------------------------------------------------------------------------
// 老数据迁移
// ---------------------------------------------------------------------------

test('迁移：旧 source 挪到 origin，纠正类靠文本特征认回来', () => {
  const migrated = migrateFact({
    id: 'x',
    text: '曾被用户纠正：不要用 PowerShell 的 Set-Content 改写源码文件。',
    source: 'auto-extract',
    createdAt: 1,
  })
  assert.equal(migrated.kind, 'correction')
  assert.equal(migrated.source, 'user')
  assert.equal(migrated.origin, 'auto-extract')
  assert.equal(migrated.proofCount, 1)
  assert.equal(migrated.hitCount, 0)
})

test('迁移：普通事实不会被误判成纠正', () => {
  const migrated = migrateFact({ id: 'y', text: '用户的长期项目是 acme-service。', source: 'memory_remember', createdAt: 1 })
  assert.equal(migrated.kind, 'fact')
  assert.equal(migrated.source, 'user')
})

// ---------------------------------------------------------------------------
// 维护报告
// ---------------------------------------------------------------------------

test('维护报告：认出重复、长期没命中、超长，且不改数据', () => {
  const now = 400 * DAY
  const facts = [
    fact('a', '项目的 UI 视觉令牌集中在 ab_ui_tokens.gd，是唯一样式来源。', now - 300 * DAY),
    fact('b', '项目的 UI 视觉令牌集中在 ab_ui_tokens.gd，是唯一来源。', now - 300 * DAY),
    { ...fact('c', '不要用 PowerShell 改源码。', now - 300 * DAY), kind: 'correction' },
    fact('d', '长'.repeat(320), now - 1 * DAY),
  ]
  const before = JSON.stringify(facts)
  const report = buildMaintenanceReport(facts, now)
  assert.equal(JSON.stringify(facts), before, '报告不能改动传入的数据')
  assert.ok(report.duplicates.length >= 1, '应认出重复对')
  assert.ok(report.stale.some((entry) => entry.fact.id === 'c'), '应认出长期没命中的')
  assert.ok(report.oversized.some((entry) => entry.id === 'd'), '应认出超长条目')
  assert.ok(report.markdown.includes('dry-run'))
})

test('维护报告：已归档的不进入重复/长期没命中检查', () => {
  const now = 400 * DAY
  const facts = [{ ...fact('gone', '不要用 PowerShell 改源码。', now - 300 * DAY), archivedAt: 1 }]
  const report = buildMaintenanceReport(facts, now)
  assert.equal(report.stale.length, 0)
  assert.equal(report.archived.length, 1)
  assert.equal(report.checked, 0)
})

// ---------------------------------------------------------------------------
// 回归：分词器仍按预期工作
// ---------------------------------------------------------------------------

test('tokenize 对中文出 bigram', () => {
  const tokens = tokenize('记忆插件')
  assert.ok(tokens.has('记忆') || tokens.has('忆插'))
})

async function main() {
  for (const { title, fn } of cases) {
    try {
      await fn()
      passed += 1
      console.log('  ok   ' + title)
    } catch (error) {
      console.log('  FAIL ' + title)
      console.log('       ' + String(error?.message ?? error))
      process.exitCode = 1
    }
  }
  console.log(`\n${passed}/${cases.length} passed`)
}

main()
