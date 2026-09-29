/**
 * 逐名 diff 一个会话最后两条 request/header 的工具清单（只读）。
 * 用法：node _header_diff.mjs [sessionId 前缀=b0f5f60e]
 * ⚠️ 多帧 zstd：按魔数 28B52FFD 切帧逐帧解。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const PREFIX = process.argv[2] ?? 'b0f5f60e'

// 定位会话文件（不自己算 projectKey）
let file = null
for (const proj of readdirSync(ROOT)) {
  let subs
  try {
    subs = readdirSync(`${ROOT}/${proj}`)
  } catch {
    continue
  }
  for (const sid of subs) {
    // ⚠️ 目录名是 `session-<uuid>`，用 includes 不用 startsWith
    if (sid.includes(PREFIX)) file = `${ROOT}/${proj}/${sid}/session.jsonl.zstd`
  }
}
if (!file) throw new Error(`找不到 ${PREFIX}* 的 transcript`)
console.log(`transcript: ${file}`)

const buf = readFileSync(file)
const offs = []
let i = 0
while ((i = buf.indexOf(MAGIC, i)) !== -1) {
  offs.push(i)
  i++
}
const parts = []
let bad = 0
for (const off of offs) {
  try {
    parts.push(zstdDecompressSync(buf.subarray(off)))
  } catch {
    bad++
  }
}
const text = Buffer.concat(parts).toString('utf8')
console.log(`帧=${offs.length} 坏帧=${bad}`)

// 收集所有 header 事件
const heads = []
for (const line of text.split(/\r?\n/)) {
  if (!line.trim()) continue
  let e
  try {
    e = JSON.parse(line)
  } catch {
    continue
  }
  if (e.type !== 'request/header') continue
  // ⚠️ 查看器行为（非判红）：无 tools 键 / 非数组的 header 被 `continue` 掉 ⇒ 不进 heads，
  //    本脚本的用途是"对比两个都有工具的 header"，故这是有意的。
  //    ⇒ 别拿本脚本判"工具面在不在"，那要用 `_tool_surface_check.mjs`。
  const tools = e.header?.tools ?? e.data?.header?.tools ?? e.payload?.header?.tools
  if (!Array.isArray(tools)) continue
  const names = tools.map((t) => t?.name ?? t?.function?.name).filter(Boolean)
  heads.push({ seq: e.seq ?? e.data?.seq, reason: e.reason ?? e.data?.reason, names })
}
if (heads.length < 2) throw new Error(`header 不足 2 条（${heads.length}）`)

const [a, b] = heads.slice(-2)
const sa = new Set(a.names)
const sb = new Set(b.names)
const gone = [...sa].filter((x) => !sb.has(x))
const added = [...sb].filter((x) => !sa.has(x))
const same = [...sa].filter((x) => sb.has(x))

console.log('')
console.log(`前: seq=${a.seq} reason=${a.reason} n=${a.names.length}`)
console.log(`后: seq=${b.seq} reason=${b.reason} n=${b.names.length}`)
console.log('')
console.log(`🔻 消失 (${gone.length}): ${JSON.stringify(gone)}`)
console.log(`🔺 新增 (${added.length}): ${JSON.stringify(added)}`)
console.log(`＝ 不变 (${same.length})`)
console.log('')
console.log(`算术校验: ${a.names.length} ${added.length ? '+' + added.length : ''} ${gone.length ? '-' + gone.length : ''} = ${a.names.length + added.length - gone.length}  (实际 ${b.names.length})`)
console.log(
  `断言: 消失集合恰为 ["pwsh"] ⇒ ${JSON.stringify(gone) === '["pwsh"]' ? '✅ 成立' : '🔴 不成立'}`
)
console.log(`断言: read 仍在且未被摘 ⇒ ${sb.has('read') ? '✅ 成立' : '🔴 不成立'}`)
