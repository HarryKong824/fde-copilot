/**
 * 【只读探针】逐行**重算** gate 审计链上每条记录的 hash，看它是否与其内容相符。
 *
 * ## 为什么要有这个东西
 * `check-d2.js` 的判据② 只验 `hash` 是不是 64 位十六进制，**从不重算**（0014 §3）。
 * ⇒ 把中间某条记录的**内容**改掉、`hash` 字段照抄，四条判据全过，`passed: true`。
 *
 * 本探针补上这一刀，**一次性的、离线的、只读的** —— 它不改 `check-d2.js`，
 * 也不参与任何门禁判定，只回答两个问题：
 *
 *   1. **历史上这套重算方法成不成立？**（若算法或 record 结构曾变过，
 *      合法的老行会被算成不匹配 ⇒ 贸然把它搬进运行时会让 D2 永久变红，等于"死门禁"）
 *   2. **这条链上的内容，有没有被改过？**
 *
 * ## 方法（与写链时完全同形态，不另发明）
 * 写链（`dsh-fde-ontology-gate/lib/audit.js:156-158`）：
 *   record = { seq, ts, ...rest }                      ← 不含 prevHash / hash
 *   hash   = sha256(prevHash + '\n' + JSON.stringify(record))
 *   落盘行 = JSON.stringify({ ...record, prevHash, hash })
 *
 * 重算：解析行 ⇒ **删掉 prevHash / hash 两个键**（其余键保持行里的字面顺序）
 *      ⇒ 按同一公式算 ⇒ 与行内的 hash 比对。
 *
 * 零副作用：只读 `gate.jsonl`，不写任何被插件持有的文件。
 *
 * 用法：node _probe_content_hash.mjs [链路径]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHAIN =
  process.argv[2] ?? 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/gate.jsonl'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '_probe_content_hash_out.txt')
const lines = []
const say = (s) => lines.push(s)

/** 按写链时的公式重算一条记录的 hash（record = 去掉 prevHash/hash 的行对象）。 */
function recomputeHash(prevHash, row) {
  const record = { ...row }
  delete record.prevHash
  delete record.hash
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(JSON.stringify(record))
    .digest('hex')
}

try {
  const raw = readFileSync(CHAIN, 'utf8')
  const rows = raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  say('== 内容级重算探针（只读） ==')
  say(`链：${CHAIN}`)
  say(`行数：${rows.length}`)
  say('')

  let ok = 0
  const bad = []
  rows.forEach((line, i) => {
    const no = i + 1
    let row
    try {
      row = JSON.parse(line)
    } catch {
      bad.push({ no, why: 'unparseable' })
      return
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      bad.push({ no, why: 'not-an-object' })
      return
    }
    const prevHash = typeof row.prevHash === 'string' ? row.prevHash : ''
    const got = recomputeHash(prevHash, row)
    if (got === row.hash) ok += 1
    else bad.push({ no, why: 'hash-mismatch', want: String(row.hash).slice(0, 12), got: got.slice(0, 12), ts: row.ts })
  })

  say(`重算通过：${ok} / ${rows.length}`)
  say(`不匹配：${bad.length}`)
  if (bad.length > 0) {
    say('')
    say('明细（前 20 条）：')
    for (const b of bad.slice(0, 20)) {
      say(`  行 ${b.no}  ${b.why}  ${b.ts ?? ''}  行内=${b.want ?? '-'}  重算=${b.got ?? '-'}`)
    }
  }
  say('')
  say('判读：')
  say('  - 全部通过 ⇒ 这套重算方法在历史上成立 ⇒ 把它搬进运行时是安全的；')
  say('    且可证明——本链每条记录的内容都与其 hash 相符（结构性重放一致）。')
  say('  - 有不匹配 ⇒ 先查是"算法/结构曾变更"还是"内容真被改过"，')
  say('    **在搞清楚之前，绝不能把这一刀搬进运行时**（否则合法老行会把 D2 打红 ⇒ 死门禁）。')
} catch (e) {
  say(`失败：${e?.stack ?? e}`)
}

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(lines.join('\n'))
console.log(`\n[probe] 结果已写入 ${OUT}`)
