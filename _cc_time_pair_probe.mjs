/**
 * Claude Code 独立核证 WorkBuddy 0029-reply §1.2 —— 他声称"把真值代进去算了"。
 *
 * 要独立回答（不采信他的数字，全部自己从磁盘重算）：
 *   ① `843e3bee` 每条 header 的 time 是多少（epoch ms）？
 *   ② gate.jsonl / phase.jsonl 每条审计的 ts 是多少、Date.parse 后是多少？
 *   ③ `audit.ts < header.time` 到底**会不会红**（有反例）还是恒真？—— 他给的那两个具体数是否存在？
 *   ④ `header.seq > audit.seq` 是否恒真（我认账的那条错判据）？
 *
 * 自检：两个数（他报的 vs 我算的）对拍；比较式的**反例集**必须被打印出来，不能只说"有/没有"。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const SESS = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--'
const AUD = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// ── 磁盘全量 header
function diskHeaders() {
  const dir = readdirSync(SESS).find((d) => d.includes('843e3bee'))
  const buf = readFileSync(`${SESS}/${dir}/session.jsonl.zstd`)
  const offs = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i++ }
  const parts = []
  for (const o of offs) { try { parts.push(zstdDecompressSync(buf.subarray(o))) } catch {} }
  const evs = []
  for (const l of Buffer.concat(parts).toString('utf8').split(/\r?\n/)) {
    if (!l.trim()) continue
    try { evs.push(JSON.parse(l)) } catch {}
  }
  const hs = []
  for (const r of evs) {
    const ev = r?.event ?? r
    if (ev?.type !== 'request/header') continue
    const t = ev?.data?.header?.tools
    hs.push({
      seq: ev.seq, reason: ev?.data?.reason ?? null, time: ev?.time ?? null,
      n: Array.isArray(t) ? t.length : 'ABSENT',
      pwsh: Array.isArray(t) ? (t.some((x) => (x?.name ?? x) === 'pwsh') ? 'IN' : 'out') : '?'
    })
  }
  return { dir, hs }
}

// ── 审计链
function auditRows(f) {
  const rows = []
  for (const l of readFileSync(`${AUD}/${f}`, 'utf8').trim().split(/\r?\n/)) {
    if (!l.trim()) continue
    const j = JSON.parse(l)
    rows.push({ seq: j.seq, type: j.type ?? null, decision: j.decision ?? null, ts: j.ts, hasTime: 'time' in j, parsed: Date.parse(j.ts) })
  }
  return rows
}

const d = diskHeaders()
console.log(`磁盘 ${d.dir}：request/header = ${d.hs.length}`)
console.log('  seq        reason    time(epoch ms)    n     pwsh')
for (const h of d.hs) {
  console.log(`  ${String(h.seq).padEnd(10)} ${String(h.reason).padEnd(9)} ${String(h.time).padEnd(17)} ${String(h.n).padEnd(5)} ${h.pwsh}`)
}

const gate = auditRows('gate.jsonl')
const phase = auditRows('phase.jsonl')
for (const [nm, rows] of [['gate.jsonl', gate], ['phase.jsonl', phase]]) {
  console.log(`\n审计 ${nm}：${rows.length} 行`)
  for (const r of rows) {
    console.log(`  seq=${String(r.seq).padEnd(3)} ts=${r.ts}  Date.parse=${r.parsed}  顶层有 time 键? ${r.hasTime}  type=${r.type} decision=${r.decision}`)
  }
}

// ── ③ 他 §1.2 报的两个数，逐字复算
const A15 = gate[gate.length - 1]
const h22579 = d.hs.find((h) => h.seq === 22579)
console.log(`\n=== 他 §1.2 报的数，我复算 ===`)
console.log(`  他报 audit.ts(1790475589946) / 我算 ${A15.parsed}  ⇒ ${A15.parsed === 1790475589946 ? '✅ 一致' : '🔴 不一致'}`)
console.log(`  他报 header seq=22579 time(1790475588701) / 我算 ${h22579?.time}  ⇒ ${h22579?.time === 1790475588701 ? '✅ 一致' : '🔴 不一致'}`)
console.log(`  audit.ts < header.time ? ${A15.parsed < h22579.time}  ← 他说 false（反例）`)

// ── ④ 枚举全部 (审计行 × header) 组合，看两个判据各自的反例数
const allAudit = [...gate, ...phase]
let timeTrue = 0, timeFalse = 0
const timeFalseEx = []
for (const a of allAudit) for (const h of d.hs) {
  if (a.parsed < h.time) timeTrue++
  else { timeFalse++; if (timeFalseEx.length < 4) timeFalseEx.push(`audit(${a.ts}) ${a.parsed} ≮ header seq=${h.seq} ${h.time}`) }
}
let seqTrue = 0, seqFalse = 0
for (const a of allAudit) for (const h of d.hs) { if (h.seq > a.seq) seqTrue++; else seqFalse++ }

console.log(`\n=== 判据有效性（枚举 ${allAudit.length} 审计行 × ${d.hs.length} header = ${allAudit.length * d.hs.length} 组）===`)
console.log(`  [时间] audit.ts < header.time ：真 ${timeTrue} / 假 ${timeFalse}  ⇒ ${timeFalse > 0 ? '✅ 有反例、会红' : '🔴 恒真'}`)
console.log(`         反例样例：${timeFalseEx.join('  |  ') || '（无）'}`)
console.log(`  [seq ] header.seq > audit.seq：真 ${seqTrue} / 假 ${seqFalse}  ⇒ ${seqFalse > 0 ? '✅ 有反例' : '🔴 恒真（我认账的那条错判据）'}`)

// ── 他 §3/§4/§5 引用的三组数，复算
console.log(`\n=== 他引用的其它数 ===`)
const h22578 = d.hs.find((h) => h.seq === 22578)
console.log(`  §4.2 baseline=22578：存在该 header? ${!!h22578}；新增(>22578)=${d.hs.filter((h) => h.seq > 22578).length} 条，reason=${d.hs.filter((h) => h.seq > 22578).map((h) => h.reason).join(',')}`)
const h5377 = d.hs.find((h) => h.seq === 5377)
console.log(`  §5   baseline=5377：存在? ${!!h5377}（n=${h5377?.n} pwsh=${h5377?.pwsh}）；last seq=22579（n=${h22579?.n} pwsh=${h22579?.pwsh}）⇒ 期望 -[] +[pwsh]`)
console.log(`  §7.2 他报 header time=1790475588701 / 我算 ${h22579?.time} ⇒ 差 ${h22579 ? Math.round((h22579.time - gate[gate.length - 2].parsed) / 1000) : '?'} s（他报 1412 s）`)
