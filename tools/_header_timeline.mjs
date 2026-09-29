/**
 * 列某会话 transcript 里 **request/header** 的时间线。
 *
 * 用途：判「某两次 restrict-applied 之间到底有没有重启」—— 重启后首条 header 的
 *      `reason` 是 `resume`（清单未变则不追加 header，所以 resume 是最硬的痕迹）。
 *
 * 用法：node _header_timeline.mjs [sessionId 前缀=b0f5f60e] [--all]
 *   --all  连同非 header 的事件类型计数一起打印
 * 输出：_header_timeline_out.txt（同时打屏）
 *
 * ⚠️ 多帧 zstd：按魔数 28B52FFD 切帧逐帧解（单帧解压只给第 1 行）。
 * ⚠️ 事件时间字段是 `time`（epoch ms），不是 `ts`。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const PREFIX = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'b0f5f60e'
const showAll = process.argv.includes('--all')

const dir = readdirSync(ROOT).find((d) => d.includes(PREFIX))
if (!dir) throw new Error(`找不到 ${PREFIX}*`)
const buf = readFileSync(`${ROOT}/${dir}/session.jsonl.zstd`)
const offs = []
let i = 0
while ((i = buf.indexOf(MAGIC, i)) !== -1) {
  offs.push(i)
  i++
}
const parts = []
for (const off of offs) {
  try {
    parts.push(zstdDecompressSync(buf.subarray(off)))
  } catch {}
}
const lines = Buffer.concat(parts)
  .toString('utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim())

const L = []
L.push(`会话目录 ${dir}`)
L.push(`总行数 ${lines.length}   帧数 ${offs.length}`)
L.push('')

const hdrs = []
const types = {}
for (const l of lines) {
  let e
  try {
    e = JSON.parse(l)
  } catch {
    continue
  }
  const t = e.type ?? '(无)'
  types[t] = (types[t] ?? 0) + 1
  if (t !== 'request/header') continue
  const d = e.data ?? {}
  const tools = d.header?.tools ?? []
  const names = tools.map((x) => x?.name ?? x).sort()
  hdrs.push({
    seq: e.seq ?? d.seq,
    time: e.time ?? d.time,
    reason: d.reason,
    n: tools.length,
    sig: createHash('sha1').update(JSON.stringify(names)).digest('hex').slice(0, 8),
    names
  })
}

L.push(`request/header 条数 = ${hdrs.length}`)
L.push('')
L.push('      seq   time(UTC)                  reason          n   名单指纹')
L.push('  ' + '─'.repeat(72))
for (const h of hdrs) {
  const ts = h.time ? new Date(h.time).toISOString().replace('T', ' ').slice(0, 23) : '(无 time)'
  L.push(`  ${String(h.seq ?? '?').padStart(7)}   ${ts}   ${String(h.reason ?? '?').padEnd(13)} ${String(h.n).padStart(3)}   ${h.sig}`)
}

// 相邻两条 header 的名单差（谁消失了 / 谁新增了）
L.push('')
L.push('相邻 header 名单变化：')
for (let k = 1; k < hdrs.length; k++) {
  const a = new Set(hdrs[k - 1].names)
  const b = new Set(hdrs[k].names)
  const gone = [...a].filter((x) => !b.has(x))
  const add = [...b].filter((x) => !a.has(x))
  if (!gone.length && !add.length) {
    L.push(`  seq ${hdrs[k - 1].seq} → ${hdrs[k].seq}   名单完全相同（仅重发）`)
  } else {
    L.push(`  seq ${hdrs[k - 1].seq} → ${hdrs[k].seq}   −${JSON.stringify(gone)}  +${JSON.stringify(add)}`)
  }
}

if (showAll) {
  L.push('')
  L.push('事件类型分布：')
  for (const [t, c] of Object.entries(types).sort((a, b) => b[1] - a[1])) L.push(`  ${String(c).padStart(6)}  ${t}`)
}

writeFileSync('_header_timeline_out.txt', L.join('\n') + '\n', 'utf8')
console.log(L.join('\n'))
