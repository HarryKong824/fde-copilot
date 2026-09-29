/**
 * Claude Code 的独立校验器（一次性，只读）—— 逐行重算 hash，验"记录内容是否与其 hash 相符"。
 *
 * ⚠️ 刻意**不 import 任何生产代码、也不复用 WorkBuddy 的探针**：
 * 算法由我从 `lib/audit.js:28-33` 读出后独立实现 ——
 * 否则就是"用被测实现验被测数据"，等于自证。
 *
 *   linkHash(prevHash, record) = sha256(prevHash + '\n' + JSON.stringify(record))
 *   其中 record = 行对象去掉 prevHash / hash 两个字段（保持其余键的插入顺序）
 *
 * 跑法：node _cc_indep_hash_verify.mjs <链路径> [<链路径> ...]
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const GENESIS = '0'.repeat(64)

function linkHash(prevHash, record) {
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(JSON.stringify(record))
    .digest('hex')
}

function verify(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    return { path, error: String(e?.message ?? e) }
  }
  const lines = text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)

  let ok = 0
  const bad = []
  const seqIssues = []

  lines.forEach((raw, i) => {
    let rec
    try {
      rec = JSON.parse(raw)
    } catch {
      bad.push({ line: i + 1, why: 'unparseable' })
      return
    }
    const { prevHash, hash, ...rest } = rec
    const want = linkHash(prevHash, rest)
    if (want === hash) ok++
    else bad.push({ line: i + 1, want: want.slice(0, 16), got: String(hash).slice(0, 16) })

    // 顺带记 seq 与 prevHash 接续情况（与内容重算是两件事，分开报）
    if (i === 0 && prevHash !== GENESIS) seqIssues.push(`首条 prevHash != GENESIS`)
  })

  return { path, lines: lines.length, ok, bad, seqIssues }
}

const paths = process.argv.slice(2)
if (paths.length === 0) {
  console.error('用法：node _cc_indep_hash_verify.mjs <链路径> [...]')
  process.exit(2)
}

let allOk = true
for (const p of paths) {
  const r = verify(p)
  if (r.error) {
    console.log(`\n${p}\n  ✗ 读不到：${r.error}`)
    allOk = false
    continue
  }
  const pass = r.bad.length === 0
  console.log(`\n${p}`)
  console.log(`  行数 = ${r.lines}`)
  console.log(`  内容重算通过 = ${r.ok} / ${r.lines}`)
  console.log(`  不匹配 = ${r.bad.length}`)
  for (const b of r.bad.slice(0, 10)) console.log(`    ${JSON.stringify(b)}`)
  if (r.seqIssues.length) console.log(`  ⚠️ ${r.seqIssues.join('; ')}`)
  console.log(`  ⇒ ${pass ? '全部相符' : '存在内容与 hash 不符的行'}`)
  if (!pass) allOk = false
}

console.log(`\n[cc-indep] ${allOk ? 'PASS' : 'FAIL'}`)
process.exitCode = allOk ? 0 : 1
