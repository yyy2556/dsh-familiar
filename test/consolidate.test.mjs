/**
 * 离线自测：合并协议 + 分层预算填充。
 *
 * 不依赖宿主，直接 `node test/consolidate.test.mjs`。
 */
import assert from 'node:assert/strict'
import {
  matchFacts,
  selectFactLines,
  renderFactBlock,
  candidatePool,
  parseConsolidation,
  applyConsolidation,
  findNearDuplicate,
  parseExtracted,
} from '../index.js'

let passed = 0
const cases = []
function test(title, fn) {
  cases.push({ title, fn })
}

const fact = (id, text, createdAt, extra = {}) => ({ id, kind: 'fact', text, createdAt, ...extra })

// ---------------------------------------------------------------------------
// 分层预算填充
// ---------------------------------------------------------------------------

test('预算充足时全部升到全文档', () => {
  const long = '事实甲'.repeat(60)
  const entries = [
    { fact: fact('a', long, 1), score: 1 },
    { fact: fact('b', long, 2), score: 0.8 },
  ]
  const lines = selectFactLines(entries, 5000)
  assert.equal(lines.length, 3)
  assert.ok(!lines[1].endsWith('…') && lines[1].length > 170, '应该已经是全文档档')
})

test('预算紧张时只铺摘要档，总长受控且不硬切半句', () => {
  const long = '事实甲'.repeat(60)
  const entries = [
    { fact: fact('a', long, 1), score: 1 },
    { fact: fact('b', long, 2), score: 0.8 },
    { fact: fact('c', long, 3), score: 0.6 },
  ]
  const lines = selectFactLines(entries, 200)
  const text = lines.join('\n')
  const body = lines.slice(1)
  assert.ok(body.length >= 1)
  assert.ok(text.length <= 200, `总长应受控，实际 ${text.length}`)
  assert.ok(body.length < 3 || body.some((line) => line.endsWith('…')), '装不下时应降档而不是硬切')
  for (const line of body) {
    assert.ok(line.startsWith('- [') || line.startsWith('- '), '每行都应是完整条目')
  }
})

test('分数高的先升级（低分留摘要档）', () => {
  const long = '这是一条很长的事实，用来吃掉预算，'.repeat(8)
  const entries = [
    { fact: fact('high', long + 'HIGH', 1), score: 1 },
    { fact: fact('low', long + 'LOW', 2), score: 0.1 },
  ]
  const lines = selectFactLines(entries, 260)
  const body = lines.slice(1)
  assert.ok(body.length >= 1)
  // 高分那条要么拿全文，要么两条都只拿摘要；绝不允许低分拿全文而高分被砍掉
  if (body.length === 2) {
    assert.ok(body[0].length >= body[1].length, '高分条目不应比低分条目短')
  }
})

test('renderFactBlock 空输入返回空串', () => {
  assert.equal(renderFactBlock([], 500), '')
  assert.equal(renderFactBlock([{ fact: fact('a', '   ', 1) }], 500), '')
})

// ---------------------------------------------------------------------------
// 候选生成
// ---------------------------------------------------------------------------

test('候选生成：共享 2 个 token 才入选', () => {
  const existing = [
    fact('ab_ui', 'UI 视觉令牌集中在 ab_ui_tokens.gd，是唯一样式来源。', 1),
    fact('acme', '用户长期开发 Godot 项目 acme-service。', 2),
  ]
  const pool = candidatePool(['UI 主题的唯一样式来源是 ab_ui_tokens.gd'], existing, 5, 16, 0)
  assert.deepEqual(pool.map((entry) => entry.id), ['ab_ui'])
})

test('候选生成：完全不相干的候选不产生候选', () => {
  const existing = [fact('x', '用户偏好中文交流。', 1)]
  assert.equal(candidatePool(['Godot 的 3D 光照参数'], existing, 5, 16, 0).length, 0)
})

test('候选生成：同分类补充（字面不重叠也能进候选池）', () => {
  const existing = [
    { ...fact('c1', '不要用 PowerShell 改源码文件。', 100), kind: 'correction' },
    { ...fact('c2', '不要批量启动 Godot 进程。', 200), kind: 'correction' },
    { ...fact('p1', '用户的长期项目是 acme。', 300), kind: 'project' },
  ]
  const pool = candidatePool([{ text: '别用 Set-Content 覆盖文件', kind: 'correction' }], existing)
  const ids = pool.map((entry) => entry.id)
  assert.ok(ids.includes('c1') || ids.includes('c2'), '同分类应进入候选：' + ids.join(','))
  assert.ok(ids.includes('c2'), '最近更新的同分类条目应被带上')
})

test('候选生成：同分类补充会跳过已归档的条目', () => {
  const existing = [
    { ...fact('c1', '不要用 PowerShell 改源码文件。', 100), kind: 'correction', archivedAt: 1 },
    { ...fact('c2', '不要批量启动 Godot 进程。', 200), kind: 'correction' },
  ]
  const pool = candidatePool([{ text: '别用 Set-Content 覆盖文件', kind: 'correction' }], existing)
  assert.ok(!pool.some((entry) => entry.id === 'c1'), '已归档的不该作为候选')
})

// ---------------------------------------------------------------------------
// 解析合并判定
// ---------------------------------------------------------------------------

test('解析：正常的四类判定', () => {
  const pool = [fact('7d0ffeb5-0000-0000-0000-000000000000', '旧文本', 1)]
  const candidates = ['新事实一', '新事实二', '新事实三']
  const output = [
    '{"i":0,"effect":"unrelated","target":null,"text":"新事实一","reason":"无关"}',
    '```json',
    '{"i":1,"effect":"changes","target":"7d0ffeb5","text":"改写后","reason":"新值"}',
    '```',
    '{"i":2,"effect":"repeats","target":"7d0ffeb5","reason":"重复"}',
  ].join('\n')
  const decisions = parseConsolidation(output, candidates, pool)
  assert.equal(decisions.size, 3)
  assert.equal(decisions.get(0).effect, 'unrelated')
  assert.equal(decisions.get(1).target.id, '7d0ffeb5-0000-0000-0000-000000000000')
  assert.equal(decisions.get(2).effect, 'repeats')
})

test('解析：非法输入一律丢弃（含 target 指向不明）', () => {
  const pool = [fact('aaaaaaaa-0000', '旧', 1)]
  const candidates = ['甲', '乙']
  const output = [
    '这不是 JSON',
    '{"i":0,"effect":"changes","target":"ffffffff","text":"x"}', // target 不存在
    '{"i":9,"effect":"unrelated","text":"越界"}',                // 序号越界
    '{"i":1,"effect":"瞎写","target":"aaaaaaaa"}',               // effect 非法
  ].join('\n')
  assert.equal(parseConsolidation(output, candidates, pool).size, 0)
})

// ---------------------------------------------------------------------------
// 落库
// ---------------------------------------------------------------------------

test('repeats 不新增记录，只加强证据', () => {
  const existing = [fact('aaaaaaaa-1111', '用户偏好中文交流。', 100, { proofCount: 1 })]
  const decisions = new Map([[0, { effect: 'repeats', target: existing[0], text: '', reason: '' }]])
  const { stats, facts } = applyConsolidation(existing, ['用户偏好用中文交流'], decisions, 's1')
  assert.equal(facts.length, 1)
  assert.equal(stats.reinforced, 1)
  assert.equal(facts[0].proofCount, 2)
  assert.ok(facts[0].lastConfirmedAt > 0)
  assert.equal(facts[0].text, '用户偏好中文交流。', '原文不应被改动')
})

test('changes 改写正文、保留旧值、createdAt 不动', () => {
  const existing = [fact('aaaaaaaa-2222', '插件版本是 0.1.0。', 100)]
  const decisions = new Map([[0, { effect: 'changes', target: existing[0], text: '插件版本是 0.3.0。', reason: '' }]])
  const { stats, facts } = applyConsolidation(existing, ['插件版本升到 0.3.0'], decisions)
  assert.equal(facts.length, 1)
  assert.equal(stats.changed, 1)
  assert.equal(facts[0].text, '插件版本是 0.3.0。')
  assert.equal(facts[0].createdAt, 100, 'createdAt 必须是首次记录时间')
  assert.ok(facts[0].updatedAt > 0)
  assert.equal(facts[0].history.length, 1)
  assert.equal(facts[0].history[0].text, '插件版本是 0.1.0。')
})

test('ends 标记结束时间', () => {
  const existing = [fact('aaaaaaaa-3333', '项目在开发中。', 100)]
  const decisions = new Map([[0, { effect: 'ends', target: existing[0], text: '项目已停止开发。', reason: '' }]])
  const { stats, facts } = applyConsolidation(existing, ['项目停了'], decisions)
  assert.equal(stats.ended, 1)
  assert.ok(facts[0].endedAt > 0)
  assert.equal(facts[0].text, '项目已停止开发。')
})

test('unrelated 新增，且同文不再重复写入', () => {
  const existing = [fact('aaaaaaaa-4444', '已有的一条。', 100)]
  const decisions = new Map([
    [0, { effect: 'unrelated', target: undefined, text: '全新的一条。', reason: '' }],
    [1, { effect: 'unrelated', target: undefined, text: '已有的一条。', reason: '' }],
  ])
  const { stats, facts } = applyConsolidation(existing, ['全新的一条。', '已有的一条。'], decisions, 's1')
  assert.equal(stats.added, 1)
  assert.equal(stats.reinforced, 1, '词面完全相同的应变加强而不是新增')
  assert.equal(facts.length, 2)
})

test('模型漏判（无判定）时按原文追加，不丢候选', () => {
  const { stats, facts } = applyConsolidation([], ['一条没被判定的事实'], new Map(), 's1')
  assert.equal(stats.added, 1)
  assert.equal(facts[0].text, '一条没被判定的事实')
  assert.equal(facts[0].proofCount, 1)
  assert.equal(facts[0].sessionId, 's1')
})

test('history 有上限，不会无限膨胀', () => {
  const existing = [fact('aaaaaaaa-5555', 'v0', 100, {
    history: Array.from({ length: 12 }, (_, i) => ({ text: `v${i}`, at: i })),
  })]
  const decisions = new Map([[0, { effect: 'changes', target: existing[0], text: 'v13', reason: '' }]])
  const { facts } = applyConsolidation(existing, ['改成 v13'], decisions)
  assert.equal(facts[0].history.length, 12)
  assert.equal(facts[0].history.at(-1).text, 'v0')
})

// ---------------------------------------------------------------------------
// 现有打分（回归）
// ---------------------------------------------------------------------------

test('matchFacts 至少命中两个词才算数', () => {
  const facts = [
    fact('a', '用户偏好先定要求再写代码。', 100),
    fact('b', 'Godot 项目使用 4.6.2 版本。', 200),
  ]
  assert.equal(matchFacts(facts, '代码', 4).length, 0, '只命中一个词不应通过')
  assert.equal(matchFacts(facts, '用户偏好写代码', 4).length, 1)
  assert.equal(matchFacts(facts, '用户偏好写代码', 4)[0].score > 0, true)
})

// ---------------------------------------------------------------------------
// 本地近似去重（合并模型不可用时的兜底）
// ---------------------------------------------------------------------------

test('findNearDuplicate：同一件事换种说法能认出来', () => {
  const existing = [
    fact('a', '用户在向 awesome-dsh-plugin 仓库投稿自家的 dsh-familiar 记忆插件（PR #18173）', 100),
    fact('b', '用户使用中文交流', 200),
  ]
  const twin = findNearDuplicate('用户在向 awesome-dsh-plugin 仓库投稿自家的 dsh-familiar 记忆插件，PR #18173', existing)
  assert.equal(twin?.id, 'a')
})

test('findNearDuplicate：不同的事不会被误合并', () => {
  const existing = [
    fact('a', '用户使用中文交流', 100),
    fact('b', '用户长期开发植物大战僵尸二创的 Godot 游戏', 200),
  ]
  assert.equal(findNearDuplicate('用户的 GitHub 用户名是 yyy2556', existing), undefined)
  assert.equal(findNearDuplicate('不要用 PowerShell 的 Set-Content 改写源码文件', existing), undefined)
})

test('findNearDuplicate：已归档/作废的事实不参与比较', () => {
  const existing = [fact('a', '旧版本地双人模式是废案，不需要制作', 100, { archivedAt: 500 })]
  assert.equal(findNearDuplicate('旧版本地双人模式是废案，不需要制作', existing), undefined)
})

test('applyConsolidation 降级路径：近似重复只加强证据，不新增', () => {
  const existing = [fact('a', 'DSH 客户端模块 client.js 中注册的 id 必须等于 package name，改包名时必须同步改 client id', 100, { proofCount: 1 })]
  const { stats, facts } = applyConsolidation(existing, ['DSH 客户端模块 client.js 中注册的 id 必须等于 package name，改包名时要同步改 client id'], new Map())
  assert.equal(facts.length, 1, '近似重复不应新增记录')
  assert.equal(stats.reinforced, 1)
  assert.equal(facts[0].proofCount, 2)
})

test('findNearDuplicate：短事实不能吞掉包含新细节的长事实', () => {
  const existing = [fact('a', '用户是23级暖通专业学生', 100)]
  assert.equal(findNearDuplicate('用户是23级暖通专业学生，正在做供热课程设计', existing), undefined)
})

test('findNearDuplicate：版本号和其它数值变化不算重复', () => {
  const existing = [fact('a', '插件版本是0.4.0', 100)]
  assert.equal(findNearDuplicate('插件版本是0.4.1', existing), undefined)
  assert.equal(findNearDuplicate('用户现在用Windows 10', [fact('b', '用户现在用Windows 11', 100)]), undefined)
})

test('findNearDuplicate：只匹配同类别事实', () => {
  const existing = [fact('a', '用户偏好先定要求再写代码', 100, { kind: 'preference' })]
  assert.equal(findNearDuplicate('用户偏好先定要求再写代码', existing, 'correction'), undefined)
})

test('applyConsolidation：模型明确判 unrelated 时新增而不是被启发式吞掉', () => {
  const existing = [fact('a', '用户是23级暖通专业学生', 100)]
  const decisions = new Map([[0, { effect: 'unrelated', target: undefined, text: '用户是23级暖通专业学生，正在做供热课程设计', reason: '' }]])
  const { stats, facts } = applyConsolidation(existing, ['用户是23级暖通专业学生，正在做供热课程设计'], decisions)
  assert.equal(facts.length, 2)
  assert.equal(stats.added, 1)
})

test('applyConsolidation：未判定时高度近似文本只加强证据', () => {
  const existing = [fact('a', 'DSH 客户端模块 client.js 中注册的 id 必须等于 package name，改包名时必须同步改 client id', 100, { proofCount: 1 })]
  const { stats, facts } = applyConsolidation(existing, ['DSH 客户端模块 client.js 中注册的 id 必须等于 package name，改包名时要同步改 client id'], new Map())
  assert.equal(facts.length, 1)
  assert.equal(stats.reinforced, 1)
  assert.equal(facts[0].proofCount, 2)
})

test('applyConsolidation：过期候选被跳过，不覆盖并发手动修改', () => {
  const existing = [fact('a', '新版本事实已经由用户手动写入', 200)]
  const decisions = new Map([[0, { effect: 'changes', target: fact('a', '旧版本事实', 100), text: '模型根据旧快照生成的内容', reason: '' }]])
  const { stats, facts } = applyConsolidation(existing, ['旧版本事实'], decisions, undefined, new Set([0]))
  assert.equal(facts.length, 1)
  assert.equal(facts[0].text, '新版本事实已经由用户手动写入')
  assert.equal(stats.changed, 0)
  assert.equal(stats.added, 0)
})

test('applyConsolidation：无关的事实照常新增', () => {
  const existing = [fact('a', '用户使用中文交流', 100)]
  const { stats, facts } = applyConsolidation(existing, ['用户的 GitHub 用户名是 yyy2556'], new Map())
  assert.equal(facts.length, 2)
  assert.equal(stats.added, 1)
})

test('parseExtracted：字段名当正文的输出会被丢弃', () => {
  assert.equal(parseExtracted('inferred', 3).length, 0)
  assert.equal(parseExtracted('模型测试回复', 3).length, 0)
  assert.equal(parseExtracted('fact|user|用户使用中文交流', 3).length, 1)
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
