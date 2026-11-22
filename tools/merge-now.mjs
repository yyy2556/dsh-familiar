/**
 * 一次性整理工具：把现有 facts.jsonl 整体过一遍合并协议。
 *
 *   node tools/merge-now.mjs prompt [输出文件]     生成合并 prompt（建议传输出文件，避免 shell 把编码搞成 UTF-16）
 *   node tools/merge-now.mjs apply <decisions.jsonl>   把模型输出落到 facts.jsonl
 *   node tools/merge-now.mjs plan <plan.json>      按显式人工计划去重（最可控）
 *
 * apply / plan 都会先备份成 facts.jsonl.bak-<时间戳>，再整体重写。
 *
 * 注意：prompt / apply 假设候选是「库里还没有的新事实」。整理**全库**请用 plan ——
 * 把库内每条都当候选时，候选池会包含它自己，模型会把每条都判成「和自己重复」（踩过这个坑）。
 *
 * plan 文件格式（id 可以只写前 8 位）：
 * {
 *   "merge": [{ "keep": "7d0ffeb5", "fold": ["4bc23d7e"], "text": "合并后的正文（可省略，省略则沿用 keep 的正文）" }],
 *   "patch": [{ "id": "7c622dd4", "text": "修正后的正文" }],
 *   "drop":  ["9ec8dbc5"]
 * }
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  candidatePool,
  parseConsolidation,
  applyConsolidation,
  buildConsolidatePrompt,
} from '../index.js'

const dir = process.env.REMEMBER_DIR
  ?? (process.env.DSH_PROFILE_DIR ? path.join(process.env.DSH_PROFILE_DIR, 'memory') : path.join(os.homedir(), '.dsh', 'memory'))
const factsFile = path.join(dir, 'facts.jsonl')

const oneLineOf = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

function readFacts() {
  if (!fs.existsSync(factsFile)) return []
  const out = []
  for (const line of fs.readFileSync(factsFile, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed.id === 'string') out.push(parsed)
    } catch {
      // 坏行跳过
    }
  }
  return out
}

const mode = process.argv[2] ?? 'prompt'
const facts = readFacts()
if (facts.length === 0) {
  console.error('没有事实可整理：' + factsFile)
  process.exit(1)
}

if (mode === 'prompt') {
  // 每条事实都当成"新事实"过一遍：候选池是全库，但**排除它自己**
  const candidates = facts.map((fact) => String(fact.text ?? ''))
  const pool = facts
  const body = buildConsolidatePrompt(candidates, pool)
  const outFile = process.argv[3]
  if (outFile) {
    fs.writeFileSync(outFile, body, 'utf8')
    console.error(`# 已写入 ${outFile}（UTF-8，${body.length} 字符）`)
  } else {
    console.log(body)
  }
  process.exit(0)
}

if (mode === 'plan') {
  const file = process.argv[3]
  if (!file || !fs.existsSync(file)) {
    console.error('用法：node tools/merge-now.mjs plan <plan.json>')
    process.exit(1)
  }
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'))
  const byPrefix = new Map()
  for (const fact of facts) byPrefix.set(fact.id.slice(0, 8), fact)
  const lookup = (prefix, where) => {
    const fact = byPrefix.get(String(prefix).slice(0, 8))
    if (fact === undefined) throw new Error(`${where}: 找不到 id ${prefix}`)
    return fact
  }

  const now = Date.now()
  const removed = new Set()
  const merged = []

  for (const entry of plan.merge ?? []) {
    const keep = lookup(entry.keep, 'merge.keep')
    const folded = (entry.fold ?? []).map((prefix) => lookup(prefix, 'merge.fold'))
    const history = Array.isArray(keep.history) ? keep.history : []
    let proof = Number(keep.proofCount ?? 1)
    for (const other of folded) {
      if (other.id === keep.id) continue
      if (removed.has(other.id)) continue
      if (oneLineOf(other.text) !== oneLineOf(keep.text)) {
        history.push({ text: oneLineOf(other.text), at: Number(other.createdAt ?? now) })
      }
      proof += Number(other.proofCount ?? 1)
      removed.add(other.id)
    }
    keep.history = history.slice(-12)
    keep.proofCount = proof
    if (typeof entry.text === 'string' && entry.text.trim() !== '') keep.text = entry.text.trim()
    keep.updatedAt = now
    merged.push({ keep: keep.id.slice(0, 8), folded: folded.map((fact) => fact.id.slice(0, 8)) })
  }

  for (const entry of plan.patch ?? []) {
    const fact = lookup(entry.id, 'patch.id')
    if (typeof entry.text !== 'string' || entry.text.trim() === '') continue
    fact.text = entry.text.trim()
    fact.updatedAt = now
  }

  const dropped = []
  for (const prefix of plan.drop ?? []) {
    const fact = lookup(prefix, 'drop')
    removed.add(fact.id)
    dropped.push(fact.id.slice(0, 8))
  }

  const next = facts.filter((fact) => !removed.has(fact.id))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(factsFile, `${factsFile}.bak-${stamp}`)
  fs.writeFileSync(factsFile, next.map((fact) => JSON.stringify(fact)).join('\n') + '\n', 'utf8')
  console.log(JSON.stringify({
    before: facts.length,
    after: next.length,
    merged,
    dropped,
    backup: `${factsFile}.bak-${stamp}`,
  }, null, 2))
  process.exit(0)
}

if (mode === 'apply') {
  const file = process.argv[3]
  if (!file || !fs.existsSync(file)) {
    console.error('用法：node tools/merge-now.mjs apply <decisions.jsonl>')
    process.exit(1)
  }
  const output = fs.readFileSync(file, 'utf8')
  const candidates = facts.map((fact) => String(fact.text ?? ''))
  const pool = facts
  const decisions = parseConsolidation(output, candidates, pool)
  console.error(`解析到 ${decisions.size}/${candidates.length} 条判定`)
  if (decisions.size === 0) {
    console.error('一条都没解析出来，放弃写入')
    process.exit(1)
  }
  const before = facts.length
  const applied = applyConsolidation(facts, candidates, decisions, undefined)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(factsFile, `${factsFile}.bak-${stamp}`)
  fs.writeFileSync(factsFile, applied.facts.map((fact) => JSON.stringify(fact)).join('\n') + '\n', 'utf8')
  console.log(JSON.stringify({
    before,
    after: applied.facts.length,
    ...applied.stats,
    backup: `${factsFile}.bak-${stamp}`,
  }, null, 2))
  process.exit(0)
}

console.error('未知模式：' + mode)
process.exit(1)
