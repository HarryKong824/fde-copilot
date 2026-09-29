// 二诊：行序 ≠ seq 序，那么「按 seq 重放」是否完全接得上？
// 这一步是决定性的：接得上 ⇒ 我的重算口径错（仪器错）；仍接不上 ⇒ 链真坏（实现错）。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname
const EVENTS = 'E:\\DSH-desktop\\DeepSeek Harness\\data\\dsh-home\\fde-state\\memory\\audit\\events.jsonl'
if (!existsSync(EVENTS)) { console.log('没有 events.jsonl'); process.exit(1) }

const rows = readFileSync(EVENTS, 'utf8').split('\n').filter((l) => l.trim())
  .map((l, i) => ({ lineNo: i + 1, j: JSON.parse(l) }))

// 1) seq 的完整性：重号？缺号？
const seqs = rows.map((r) => r.j.seq)
const uniq = new Set(seqs)
const dup = seqs.filter((s, i) => seqs.indexOf(s) !== i)
const maxSeq = Math.max(...seqs)
const minSeq = Math.min(...seqs)
console.log(`行数 ${rows.length}，seq 范围 ${minSeq}..${maxSeq}，去重后 ${uniq.size}`)
console.log(`重号：${dup.length ? dup.join(',') : '无'}`)
const missing = []
for (let s = minSeq; s <= maxSeq; s++) if (!uniq.has(s)) missing.push(s)
console.log(`缺号：${missing.length ? missing.slice(0, 20).join(',') + (missing.length > 20 ? ` …共${missing.length}` : '') : '无'}`)

// 2) 行序与 seq 序的错位处
const outOfOrder = []
for (let i = 1; i < rows.length; i++) {
  if (rows[i].j.seq < rows[i - 1].j.seq) outOfOrder.push(i + 1)
}
console.log(`\n行序与 seq 序不一致的行号（该行 seq 比前一行小）：${outOfOrder.length ? outOfOrder.join(', ') : '无'}`)

// 3) 按 seq 升序重放
const audit = await import('file://' + join(HERE, 'dsh-fde-memory', 'lib', 'audit.js').replace(/\\/g, '/'))
const sorted = [...rows].sort((a, b) => a.j.seq - b.j.seq)
let head = audit.GENESIS
let broken = 0, mismatch = 0
const badAt = []
for (const r of sorted) {
  const { prevHash, hash, ...record } = r.j
  const linkOK = prevHash === head
  const hashOK = audit.linkHash(head, record) === hash
  if (!linkOK) { broken++; badAt.push(`seq=${r.j.seq}(line ${r.lineNo}) 断链`) }
  if (!hashOK) { mismatch++; badAt.push(`seq=${r.j.seq}(line ${r.lineNo}) 哈希不符`) }
  head = hash
}
console.log(`\n【按 seq 重放】共 ${sorted.length} 条：断链 ${broken}，哈希不符 ${mismatch}`)
console.log(`链尾 head = ${head}`)
console.log(`文件最后一行（按落盘顺序）的 hash = ${rows[rows.length - 1].j.hash}`)
console.log(`⇒ head 与末行 hash ${head === rows[rows.length - 1].j.hash ? '一致' : '**不一致**'}`)
if (badAt.length) console.log('坏点：\n  ' + badAt.join('\n  '))

// 4) 按**落盘顺序**重放（我第一版的口径），只为了复现那 3 处
let h2 = audit.GENESIS, b2 = 0
for (const r of rows) {
  const { prevHash, hash, ...record } = r.j
  if (prevHash !== h2 || audit.linkHash(h2, record) !== hash) b2++
  h2 = hash
}
console.log(`\n【按落盘顺序重放】坏 ${b2} 行（即 live 命令报的那 3 处）`)
