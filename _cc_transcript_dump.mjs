/**
 * Claude Code 的 transcript 字段探针（一次性，只读）。
 *
 * 用途：把某个事件类型的**完整 data** 打出来 —— `_dsh_lifecycle.mjs` 为了看时间线做了 clip，
 * 而判 "preset 到底是什么" 需要看不截断的原值。
 *
 * 用法：node _cc_transcript_dump.mjs <会话前缀> [事件类型1,事件类型2,...]
 *   例：node _cc_transcript_dump.mjs 3cfe006e permission/preset,sandbox/mode,request/header
 *
 * ⚠️ 多帧 zstd：按魔数 28B52FFD 切帧逐帧解（单帧解压只给第一段）。
 *
 * ⚠️ 这是**查看器，不是判红仪器**：零工具时走 else 打一行 `header keys=[…]` 后正常退出 0
 * （0026 §4.2 由 Claude 自己核出）⇒ 它既不崩也不判红，要靠人先知道"没有 tools 键 = 零工具"。
 * ⇒ 要判红请用 `_tool_surface_check.mjs`（缺席判红 + 自带可证伪样本 + 退出码敏感）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const prefix = process.argv[2]
const want = new Set((process.argv[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
if (!prefix) throw new Error('用法: node _cc_transcript_dump.mjs <会话前缀> [事件类型,...]')

const dir = readdirSync(ROOT).find((d) => d.includes(prefix))
if (!dir) throw new Error(`找不到 ${prefix}*`)

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
const lines = Buffer.concat(parts).toString('utf8').split(/\r?\n/).filter((l) => l.trim())

console.log(`会话 ${dir}`)
console.log(`帧数 ${offs.length} / 行数 ${lines.length}`)
console.log(`筛选类型 ${want.size ? [...want].join(', ') : '(全部)'}`)
console.log()

let hit = 0
for (const l of lines) {
  let e
  try {
    e = JSON.parse(l)
  } catch {
    continue
  }
  const t = e.type ?? ''
  if (want.size && !want.has(t)) continue
  hit++
  const ts = e.time ? new Date(e.time).toISOString() : '(无 time)'
  console.log(`── ${ts}  seq=${e.seq ?? '?'}  ${t}`)
  const d = e.data ?? {}
  // 对 request/header 只摘要打工具名单（名单可能很长），其余整份打印
  if (t === 'request/header') {
    const tools = d.header?.tools ?? d.tools ?? null
    console.log(`   reason=${d.reason}`)
    if (Array.isArray(tools)) {
      console.log(`   工具数=${tools.length}`)
      tools.forEach((x) => console.log(`     - ${x?.name ?? x?.function?.name ?? JSON.stringify(x).slice(0, 80)}`))
    } else {
      console.log(`   header keys=${JSON.stringify(Object.keys(d.header ?? d))}`)
    }
  } else {
    console.log(`   ${JSON.stringify(d).slice(0, 1200)}`)
  }
  console.log()
}
console.log(`命中 ${hit} 条`)
