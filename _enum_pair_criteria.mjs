/**
 * 配对判据的**定量**比较（P2-16）：把「按时间」与「按 seq」两个判据在同一批组合上各跑一遍，
 * 数出各自放行了多少组 —— "系统性偏绿"要能说到数字，不能只说"恒真"。
 *
 * 组合 = 每条审计记录 × 每条 `request/header`（不是"真实配对"，是**全集**，用来量放行率）。
 *
 * 用法：node _enum_pair_criteria.mjs [sessionPrefix]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const PREFIX = process.argv[2] ?? '843e3bee'
const SESSION_ROOTS = [
  'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--',
  'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--C-Users-DELL--'
]
const AUDIT_DIR = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// ── header 侧（磁盘全量，不经 RPC ⇒ 不受分页视窗截断影响）
let headers = []
let dirUsed = ''
for (const R of SESSION_ROOTS) {
  let dirs = []
  try {
    dirs = readdirSync(R)
  } catch {
    continue
  }
  const d = dirs.find((x) => x.includes(PREFIX))
  if (!d) continue
  dirUsed = `${R}/${d}`
  const buf = readFileSync(`${dirUsed}/session.jsonl.zstd`)
  const offs = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offs.push(i)
    i++
  }
  const parts = []
  for (const o of offs) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(o)))
    } catch {}
  }
  const ev = []
  for (const l of Buffer.concat(parts).toString('utf8').split(/\r?\n/)) {
    if (!l.trim()) continue
    try {
      ev.push(JSON.parse(l))
    } catch {}
  }
  headers = ev
    .filter((e) => (e?.event?.type ?? e?.type) === 'request/header')
    .map((e) => {
      const x = e?.event ?? e
      return { seq: x.seq, time: typeof x.time === 'number' ? x.time : null, reason: x.data?.reason ?? null }
    })
  break
}

// ── 审计侧（两条链，全量）
const audits = []
for (const f of ['gate.jsonl', 'phase.jsonl']) {
  const lines = readFileSync(`${AUDIT_DIR}/${f}`, 'utf8').split('\n').filter((l) => l.trim())
  for (const l of lines) {
    const r = JSON.parse(l)
    audits.push({ chain: f, seq: r.seq, ts: r.ts, time: r.time, hasTimeKey: Object.prototype.hasOwnProperty.call(r, 'time') })
  }
}

if (headers.length === 0 || audits.length === 0) {
  console.error('取不到 header 或审计 ⇒ 不许拿 0 组当结论')
  process.exit(2)
}

let tTrue = 0
let sTrue = 0
const sFalseCases = []
for (const a of audits) {
  const at = Date.parse(a.ts)
  for (const h of headers) {
    const byTime = Number.isFinite(at) && h.time !== null && at < h.time
    const bySeq = h.seq > a.seq
    if (byTime) tTrue++
    if (bySeq) sTrue++
    else sFalseCases.push(`header.seq=${h.seq} vs ${a.chain}#${a.seq}`)
  }
}

const total = audits.length * headers.length
console.log(`会话目录 = ${dirUsed}`)
console.log(`审计行 = ${audits.length}（gate ${audits.filter((a) => a.chain === 'gate.jsonl').length} + phase ${audits.filter((a) => a.chain === 'phase.jsonl').length}）`)
console.log(`header  = ${headers.length}（磁盘全量）`)
console.log(`组合总数 = ${total}`)
console.log('')
console.log(`[时间] audit.ts < header.time  ⇒ 真 ${tTrue} / 假 ${total - tTrue}   （${((tTrue / total) * 100).toFixed(1)}%）`)
console.log(`[seq ] header.seq > audit.seq  ⇒ 真 ${sTrue} / 假 ${total - sTrue}   （${((sTrue / total) * 100).toFixed(1)}%）`)
console.log(`⇒ seq 判据比时间判据多放行 ${sTrue - tTrue} 组（${(sTrue / Math.max(tTrue, 1)).toFixed(1)}×）`)
console.log('')
console.log(`审计记录 time 键存在性：${audits.filter((a) => a.hasTimeKey).length} / ${audits.length} 有（⇒ 别用 time）`)
console.log('')
console.log(`seq 判据为假的组合（${sFalseCases.length} 组）：`)
for (const c of sFalseCases.slice(0, 20)) console.log(`  ${c}`)
if (sFalseCases.length > 20) console.log(`  …另 ${sFalseCases.length - 20} 组`)
