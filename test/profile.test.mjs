/**
 * 离线自测：画像的行级编辑（唯一子串定位）与容量契约。
 *
 * node test/profile.test.mjs
 */
import assert from 'node:assert/strict'
import { applyProfileOps, profileBodyText, profileCapacity } from '../index.js'

let passed = 0
const cases = []
const test = (title, fn) => cases.push({ title, fn })

const PROFILE = [
  '# 长期画像',
  '',
  '<!-- 手改即时可见，但会话内是冻结快照 -->',
  '- 用户在 Linux 和 Windows 上工作',
  '- 用户在 Linux 上跑服务',
  '- 用户偏好中文交流',
  '',
].join('\n')

// ---------------------------------------------------------------------------
// 唯一子串定位
// ---------------------------------------------------------------------------

test('remove 唯一命中：只删那一行', () => {
  const out = applyProfileOps(PROFILE, [{ op: 'remove', text: '偏好中文交流' }])
  assert.equal(out.error, undefined)
  assert.ok(!out.text.includes('偏好中文交流'))
  assert.ok(out.text.includes('在 Linux 上跑服务'), '不该误删其它行')
})

test('remove 多命中：报错并列出候选，一行都不删', () => {
  const out = applyProfileOps(PROFILE, [{ op: 'remove', text: 'Linux' }])
  assert.ok(out.error !== undefined)
  assert.ok(out.error.includes('命中 2 行'), out.error)
  assert.ok(out.error.includes('在 Linux 上跑服务'), '应列出候选行')
  assert.equal(out.text, undefined, '失败时不能返回改好的文本')
})

test('remove 零命中：报错', () => {
  const out = applyProfileOps(PROFILE, [{ op: 'remove', text: '不存在的条目' }])
  assert.ok(out.error !== undefined && out.error.includes('没有包含'))
})

test('patch 唯一命中：行内替换，同行其它内容保留', () => {
  const out = applyProfileOps(PROFILE, [{ op: 'patch', find: '偏好中文交流', text: '偏好简体中文，语气直接' }])
  assert.equal(out.error, undefined)
  assert.ok(out.text.includes('- 用户偏好简体中文，语气直接'))
  assert.ok(out.text.includes('在 Linux 和 Windows 上工作'))
})

test('patch 多命中：拒绝执行', () => {
  const out = applyProfileOps(PROFILE, [{ op: 'patch', find: 'Linux', text: 'macOS' }])
  assert.ok(out.error !== undefined && out.error.includes('命中 2 行'))
})

test('patch 缺 text：报错而不是把命中段抹掉', () => {
  const out = applyProfileOps(PROFILE, [{ op: 'patch', find: '偏好中文交流' }])
  assert.ok(out.error !== undefined)
})

test('add 追加成条目行', () => {
  const out = applyProfileOps(PROFILE, [{ op: 'add', text: '用户用 Godot 4.6.2' }])
  assert.ok(out.text.includes('- 用户用 Godot 4.6.2'))
  assert.equal(out.applied.length, 1)
})

test('未知 op 一律拒绝', () => {
  const out = applyProfileOps(PROFILE, [{ op: 'replace', text: 'x' }])
  assert.ok(out.error !== undefined && out.error.includes('未知操作'))
})

test('一批操作按顺序生效', () => {
  const out = applyProfileOps(PROFILE, [
    { op: 'remove', text: '偏好中文交流' },
    { op: 'add', text: '用户偏好中文' },
  ])
  assert.equal(out.error, undefined)
  assert.ok(!out.text.includes('偏好中文交流'))
  assert.ok(out.text.includes('- 用户偏好中文'))
})

// ---------------------------------------------------------------------------
// 容量契约
// ---------------------------------------------------------------------------

test('正文长度不算标题行和注释行', () => {
  const body = profileBodyText(PROFILE)
  assert.ok(!body.includes('# 长期画像'))
  assert.ok(!body.includes('<!--'))
  assert.equal(body, ['- 用户在 Linux 和 Windows 上工作', '- 用户在 Linux 上跑服务', '- 用户偏好中文交流'].join('\n'))
})

test('超限时给出超出了多少', () => {
  const capacity = profileCapacity(PROFILE, 40)
  assert.equal(capacity.ok, false)
  assert.equal(capacity.over, profileBodyText(PROFILE).length - 40)
})

test('同一批里先删后加就能装下（上限只看最终结果）', () => {
  const limit = profileBodyText(PROFILE).length
  const out = applyProfileOps(PROFILE, [
    { op: 'remove', text: '偏好中文交流' },
    { op: 'add', text: '用户偏好中文' },
  ])
  const capacity = profileCapacity(out.text, limit)
  assert.equal(capacity.ok, true, '先删后加后不应超限')
})

test('limit=0 视为不限制', () => {
  assert.equal(profileCapacity(PROFILE, 0).ok, true)
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
