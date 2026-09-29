/**
 * 只读：按 zstd 帧解某个会话的 transcript，列 type 分布 + 找指定日期的事件。
 * 用法：node _b0_events.mjs <会话目录名> [日期前缀 如 2026-09-25]
 *
 * ⚠️ transcript 是多帧 zstd 追加；整文件解/流式解都只出第一帧（见 _header_evidence.mjs 顶部注释）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const dir = process.argv[2]
const dayPat = process.argv[3] ?? '2026-09-25'

const buf = readFileSync(ROOT + '/' + dir + '/session.jsonl.zstd')
const offs = []
let i = 0
while ((i = buf.indexOf(MAGIC, i)) !== -1) {
  offs.push(i)
  i++
}
const parts = []
let bad = 0
for (const o of offs) {
  try {
    parts.push(zstdDecompressSync(buf.subarray(o)))
  } catch {
    bad++
  }
}
const evs = Buffer.concat(parts)
  .toString('utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim() !== '')
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter(Boolean)

const L = []
L.push('会话 ' + dir)
L.push('  zstd 帧=' + offs.length + ' 坏帧=' + bad + ' 事件=' + evs.length)

const c = {}
for (const e of evs) {
  const t = e.type ?? '(无type)'
  c[t] = (c[t] ?? 0) + 1
}
L.push('  type 分布 = ' + JSON.stringify(c))

// 时间戳字段在不同事件里位置不一，全部统一抓一遍
function tsOf(e) {
  for (const k of ['ts', 'timestamp', 'at', 'time']) {
    if (typeof e[k] === 'string') return e[k]
  }
  return null
}
const withTs = evs.map((e) => ({ e, t: tsOf(e) })).filter((x) => x.t)
withTs.sort((a, b) => String(a.t).localeCompare(String(b.t)))
L.push('  带顶层时间戳的事件 = ' + withTs.length)
if (withTs.length) {
  L.push('    最早 ' + withTs[0].t)
  L.push('    最晚 ' + withTs[withTs.length - 1].t)
  const recent = withTs.filter((x) => String(x.t).startsWith(dayPat))
  L.push('    ' + dayPat + ' 的事件 = ' + recent.length)
  for (const x of recent.slice(0, 20)) {
    L.push('      ' + x.t + '  type=' + (x.e.type ?? '-'))
  }
}

// 退而求其次：全文串匹配（有些事件时间戳嵌在深层字段）
const dayHits = evs.filter((e) => JSON.stringify(e).indexOf(dayPat) !== -1)
L.push('  全文含 ' + dayPat + ' 的事件 = ' + dayHits.length)

for (const e of evs) {
  if (e.type === 'request/header') {
    const tools = e.header?.tools ?? e.data?.header?.tools ?? []
    const names = Array.isArray(tools) ? tools.map((t) => t?.name ?? t) : []
    L.push(
      '  header seq=' + e.seq + ' reason=' + JSON.stringify(e.reason ?? e.data?.reason) +
        ' n=' + names.length + ' pwsh=' + names.includes('pwsh')
    )
  }
}

writeFileSync('_b0_events_out.txt', L.join('\n') + '\n', 'utf8')
console.log(L.join('\n'))
