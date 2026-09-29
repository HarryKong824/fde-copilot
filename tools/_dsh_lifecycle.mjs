/**
 * 列 DSH transcript 里的「生命周期类」事件时间线。
 *
 * 用途：判某个时间窗内**发生过几次会话初始化 / 重启**。
 *      `request/header` 只在工具清单变化时追加，所以「清单没变的重启」在 header 时间线上
 *      **完全不可见** —— 必须靠这些每次初始化都写一遍的事件来数次数：
 *      `session` / `session/end-seed` / `sandbox/mode` / `approval/policy` / `permission/preset`。
 *
 * 用法：node _dsh_lifecycle.mjs [会话前缀=b0f5f60e] [起=ISO] [止=ISO]
 *   例：node _dsh_lifecycle.mjs b0f5f60e 2026-09-25T13:20 2026-09-25T13:50
 * 输出：_dsh_lifecycle_out.txt（同时打屏）
 *
 * ⚠️ 多帧 zstd：按魔数 28B52FFD 切帧逐帧解。事件时间字段是 `time`（epoch ms）。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const args = process.argv.slice(2)
const PREFIX = args[0] && !args[0].includes(':') ? args[0] : 'b0f5f60e'
const t1 = args.find((a) => a.includes(':')) ? Date.parse(args.find((a) => a.includes(':'))) : 0
const t2 = args.filter((a) => a.includes(':')).length > 1 ? Date.parse(args.filter((a) => a.includes(':'))[1]) : Infinity

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

// 每次会话初始化都会写的、以及能标示生命周期的类型
const LIFE = new Set([
  'session',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'agent-preset/selected',
  'sandbox/mode',
  'approval/policy',
  'permission/preset',
  'turn/start',
  'turn/end',
  'request/header',
  'request/context',
  'command/run',
  'command/done',
  'agent/inbox/spliced',
  'user/message'
])

const clip = (s, n = 150) => {
  const t = String(s ?? '').replace(/\r?\n/g, ' ⏎ ').replace(/\s+/g, ' ')
  return t.length > n ? t.slice(0, n) + ' …' : t
}

const evs = []
for (const l of lines) {
  let e
  try {
    e = JSON.parse(l)
  } catch {
    continue
  }
  const t = e.type ?? ''
  if (!LIFE.has(t)) continue
  const time = e.time ?? e.data?.time
  if (time && (time < t1 || time > t2)) continue
  const d = e.data ?? {}
  let extra = ''
  if (t === 'request/header') extra = `reason=${d.reason} n=${d.header?.tools?.length ?? '?'}`
  else if (t === 'user/message') extra = clip(typeof d.content === 'string' ? d.content : JSON.stringify(d.content))
  else if (t === 'session/end-seed') extra = clip(JSON.stringify(d))
  else if (t === 'agent/inbox/spliced') extra = clip(JSON.stringify(d))
  else if (t === 'turn/start' || t === 'turn/end') extra = clip(JSON.stringify(d))
  else if (t === 'command/run' || t === 'command/done') extra = clip(JSON.stringify(d))
  evs.push({ time, seq: e.seq ?? d.seq, t, extra })
}
evs.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))

const L = []
L.push(`会话 ${dir}`)
L.push(`生命周期事件 ${evs.length} 条` + (t1 || t2 < Infinity ? `（窗口 ${new Date(t1).toISOString()} ~ ${t2 === Infinity ? '∞' : new Date(t2).toISOString()}）` : ''))
L.push('')
L.push('  time(UTC)                  seq      type                     摘要')
L.push('  ' + '─'.repeat(96))
for (const e of evs) {
  const ts = e.time ? new Date(e.time).toISOString().replace('T', ' ').slice(0, 23) : '(无 time)'
  L.push(`  ${ts}  ${String(e.seq ?? '?').padStart(7)}  ${e.t.padEnd(24)} ${e.extra}`)
}

writeFileSync('_dsh_lifecycle_out.txt', L.join('\n') + '\n', 'utf8')
console.log(L.join('\n'))
