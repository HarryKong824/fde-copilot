/**
 * 第五层活验：**跨会话逐名 diff 工具面**。
 *
 * 为什么要跨会话：`request/header` 只在**清单发生变化**时追加。重启后新建的会话只有
 * 一条 `initial`，同会话里没有第二条可比 —— 而判据要的正是"重启前 vs 重启后"。
 * ⇒ 取【旧会话（重启前写的最后一条 header）】与【新会话（重启后的 initial）】对拍。
 *
 * 用法：node _e5_header_diff.mjs <旧会话id前缀> <新会话id前缀>
 *
 * ⚠️ 多帧 zstd：按魔数 28B52FFD 切帧逐帧解（单帧解压只给第 1 行）。
 * ⚠️ 不许"读不到就跳过"：任一册读不到 header、或 tools 不是数组 ⇒ **exit 1 并明说**。
 *    缺席第三层（整条记录缺席）最容易被压成一行"读起来像通过"的文字。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const [oldPrefix, newPrefix] = process.argv.slice(2)
if (!oldPrefix || !newPrefix) {
  console.error('用法: node _e5_header_diff.mjs <旧会话id前缀> <新会话id前缀>')
  process.exit(2)
}

/** 定位 transcript（目录名是 `session-<uuid>`，用 includes 不用 startsWith）。 */
function transcriptOf(prefix) {
  const hits = []
  for (const proj of readdirSync(ROOT)) {
    let subs
    try {
      subs = readdirSync(`${ROOT}/${proj}`)
    } catch {
      continue
    }
    for (const sid of subs) if (sid.includes(prefix)) hits.push(`${ROOT}/${proj}/${sid}/session.jsonl.zstd`)
  }
  if (hits.length === 0) throw new Error(`找不到 ${prefix} 的 transcript`)
  if (hits.length > 1) throw new Error(`${prefix} 命中 ${hits.length} 个 transcript：${hits.join(' / ')}`)
  return hits[0]
}

/** 解多帧 zstd → 全部行（坏帧单独计数，不静默吞）。 */
function linesOf(file) {
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
  return { text: Buffer.concat(parts).toString('utf8'), frames: offs.length, bad }
}

/**
 * 取**最后一条** `request/header` 的完整工具名单。
 * @returns {{seq:*, reason:*, names:string[]}}
 */
function lastHeader(file) {
  const { text, frames, bad } = linesOf(file)
  let last = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type !== 'request/header') continue
    const tools = e.header?.tools ?? e.data?.header?.tools ?? e.payload?.header?.tools
    if (!Array.isArray(tools)) continue
    const names = tools.map((t) => t?.name ?? t?.function?.name).filter(Boolean)
    last = {
      seq: e.seq ?? e.data?.seq ?? null,
      reason: e.reason ?? e.data?.reason ?? null,
      time: typeof e.time === 'number' ? new Date(e.time).toISOString() : null,
      names
    }
  }
  if (!last) throw new Error(`帧=${frames} 坏帧=${bad}，但**一条 request/header 都没有**（不是"没变化"，是读不到）`)
  return last
}

const out = []
const p = (s) => {
  out.push(s)
  console.log(s)
}

const fOld = transcriptOf(oldPrefix)
const fNew = transcriptOf(newPrefix)
p(`旧册 ${fOld}`)
p(`新册 ${fNew}`)

const a = lastHeader(fOld)
const b = lastHeader(fNew)

const sa = new Set(a.names)
const sb = new Set(b.names)
const gone = [...sa].filter((x) => !sb.has(x))
const added = [...sb].filter((x) => !sa.has(x))
const same = [...sa].filter((x) => sb.has(x))

p('')
p(`前（重启前）: seq=${a.seq} reason=${a.reason} time=${a.time} n=${a.names.length}`)
p(`后（重启后）: seq=${b.seq} reason=${b.reason} time=${b.time} n=${b.names.length}`)
p('')
p(`🔻 消失 (${gone.length}): ${JSON.stringify(gone, null, 0)}`)
p(`🔺 新增 (${added.length}): ${JSON.stringify(added, null, 0)}`)
p(`＝ 不变 (${same.length})`)
p('')
p(`算术校验: ${a.names.length} + ${added.length} - ${gone.length} = ${a.names.length + added.length - gone.length}  (实际 ${b.names.length})`)

// ── 判据（双向：必须含 X + 必须不含 Y）────────────────────────────────
const MUST_HAVE = ['fde-break-glass', 'fde_experiment_write', 'fde_experiment_read', 'fde_experiment_list', 'fde_metrics']
const checks = []
for (const t of MUST_HAVE) checks.push([`必须含 ${t}`, sb.has(t)])
// 当前 current_phase=10 属受保护 Phase ⇒ restrict 应已摘掉 pwsh
checks.push(['必须不含 pwsh（current_phase=10 是受保护 Phase）', !sb.has('pwsh')])
checks.push(['必须仍含 read（摘 pwsh 不该连坐）', sb.has('read')])
checks.push(['算术守恒（前 + 新增 - 消失 == 后）', a.names.length + added.length - gone.length === b.names.length])
// ⚠️ 这一条**曾经写错**：初版抄了第二批的期望「消失集合恰为 ["pwsh"]」，实测红。
//    红的原因不是实现坏了，是**两端同口径**：基线会话建于 2026-09-29（当时已是 Phase 10），
//    它本来就不含 pwsh ⇒ 没有 pwsh 可摘。⇒ 正确判据 = 「消失为空」**且**「基线本就不含 pwsh」，
//    两条合起来才排除"pwsh 这次被摘了"这个解释。
//    （教训：期望写错会伪装成"实现有缺陷"，诱使人去改坏正确实现。）
checks.push(['消失集合必须为空（两端同在 Phase 10，无人被摘）', gone.length === 0])
checks.push(['基线（重启前）本就含 read 且不含 pwsh ⇒ 两端同口径', sa.has('read') && !sa.has('pwsh')])

p('')
let allOk = true
for (const [label, ok] of checks) {
  if (!ok) allOk = false
  p(`  ${ok ? '✅' : '🔴'} ${label}`)
}
p('')
p(`RESULT: ${allOk ? 'PASS' : 'FAIL'}`)

writeFileSync('_e5_header_diff_out.txt', out.join('\n') + '\n', 'utf8')
process.exitCode = allOk ? 0 : 1
