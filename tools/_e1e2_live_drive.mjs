/**
 * 第五层活验：驱动活体会话调用 E1（`fde-break-glass`）与 E2（`fde_experiment_*`）的工具。
 *
 * 用法：node _e1e2_live_drive.mjs <sessionId 前缀>
 *
 * ⚠️ 本脚本**不改任何源码、不改配置**。它只做两件事：发一条消息 + 读（transcript / 链 / 磁盘）。
 *
 * 🔴 纪律（本项目既有，逐条对应踩过的坑）：
 *  ① **等"新"事件前先取基线**：`--sid` 续会话时旧回合的 tool/result 还在记录里，
 *     不取基线就会把**上一轮的**交差当成本轮结果（形状与"模型没调工具"完全一样）。
 *  ② **别用 tail 的观感**：`tool/result` 的条数按 `seq > baselineSeq` 全量算。
 *  ③ 结果**从 transcript 取**，不靠模型自述 —— 模型可能转述错。
 *  ④ 不做任何断言判定以外的副作用；不碰 state.yaml。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const BASE = 'http://127.0.0.1:3080'
const SESS_ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions'
const AUDIT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit'
const EXP_DIR = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/experiments'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const prefix = process.argv[2]
if (!prefix) { console.error('用法: node _e1e2_live_drive.mjs <sessionId 或前缀>'); process.exit(2) }
// 🔴 `SessionId` 是带 `session-` 前缀的 branded 类型，且**必须是完整 uuid** ——
//    传截断的前缀只会得到 `session "session-xxxx" not found`，看起来像"会话没载入"，
//    实际是 id 不完整。（第一次踩：传 `6d723845` ⇒ `session-6d723845` ⇒ 假 not-found。）
const sessionId = prefix.startsWith('session-') ? prefix : `session-${prefix}`
if (!/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) {
  console.error(`sessionId 不是完整 uuid：${sessionId}`)
  process.exit(2)
}

// ───────────────────────────────────────────── 读工具
function cookieHeader(path) {
  const raw = readFileSync(path, 'utf8')
  const out = []
  for (let line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const f = line.split('\t')
    if (f.length < 7) continue
    out.push(`${f[5]}=${f[6]}`)
  }
  if (!out.length) throw new Error('cookie jar 里没解析出任何 cookie')
  return out.join('; ')
}
let rpcN = 0
async function rpc(method, args) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(JAR) },
    body: JSON.stringify({ type: 'client-request', rpcId: `r${++rpcN}`, method, payload: { args } })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  const j = JSON.parse(text)
  if (j.result?.ok === false) throw new Error(`${method} 失败: ${JSON.stringify(j.result.error).slice(0, 400)}`)
  return j.result?.value
}

function transcriptOf(p) {
  const hits = []
  for (const proj of readdirSync(SESS_ROOT)) {
    let subs; try { subs = readdirSync(`${SESS_ROOT}/${proj}`) } catch { continue }
    for (const sid of subs) if (sid.includes(p)) hits.push(`${SESS_ROOT}/${proj}/${sid}/session.jsonl.zstd`)
  }
  if (!hits.length) throw new Error(`找不到 ${p} 的 transcript`)
  if (hits.length > 1) throw new Error(`${p} 命中 ${hits.length} 个 transcript: ${hits.join(' / ')}`)
  return hits[0]
}
function recsOf(file) {
  const buf = readFileSync(file)
  const offs = []; let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i++ }
  const parts = []
  for (const off of offs) { try { parts.push(zstdDecompressSync(buf.subarray(off))) } catch { /* 坏帧不静默：下面计数 */ } }
  const lines = Buffer.concat(parts).toString('utf8').split(/\r?\n/).filter((l) => l.trim())
  const recs = []; let bad = 0
  for (const l of lines) { try { recs.push(JSON.parse(l)) } catch { bad++ } }
  return { recs, frames: offs.length, bad }
}
function chainLines(f) {
  if (!existsSync(f)) return 0
  return readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length
}
function expListing() {
  if (!existsSync(EXP_DIR)) return '<沙箱目录不存在>'
  const out = []
  const walk = (d, base) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`
      const rel = base ? `${base}/${e.name}` : e.name
      if (e.isDirectory()) walk(p, rel)
      else out.push(`${rel} (${statSync(p).size} 字节)`)
    }
  }
  walk(EXP_DIR, '')
  return out.length ? out.join('\n      ') : '<空>'
}

const out = []
const p = (s) => { out.push(s); console.log(s) }

// ───────────────────────────────────────────── ① 基线（先取！）
const TFILE = transcriptOf(prefix)
const before = recsOf(TFILE)
const baseSeq = before.recs.reduce((m, r) => Math.max(m, Number(r.seq ?? 0)), 0)
const baseRes = before.recs.filter((r) => r.type === 'tool/result').length
const baseCalls = before.recs.filter((r) => r.type === 'tool/call').length
const phaseLines0 = chainLines(`${AUDIT}/phase.jsonl`)
const gateLines0 = chainLines(`${AUDIT}/gate.jsonl`)

p(`会话 transcript: ${TFILE}`)
p(`帧 ${before.frames} / 行 ${before.recs.length} / 坏行 ${before.bad}`)
p(`═══ 基线 ═══`)
p(`  transcript 最大 seq = ${baseSeq}`)
p(`  tool/call 基线 = ${baseCalls}   tool/result 基线 = ${baseRes}`)
p(`  phase.jsonl 行数 = ${phaseLines0}   gate.jsonl 行数 = ${gateLines0}`)
p(`  沙箱基线: ${expListing()}`)

// ───────────────────────────────────────────── ② 发消息
const PROMPT = `【授权活验任务 · 请严格照做：不要改写参数、不要跳过任何一步】

按顺序调用下面 5 个工具，每次只调一个，参数**原样**传进去（其中第 4、5 步是刻意构造的反例）。全部调完后，把每次调用的**返回原文**逐条贴出来（不要总结、不要美化）。

1) fde_experiment_list —— 无参数
2) fde_experiment_write —— name="live-e2-check.md", content="E2 活验：探索沙箱写入"
3) fde_experiment_read —— name="live-e2-check.md"
4) fde_experiment_read —— name="../escape-attempt.md"   ← 刻意越界用例
5) fde-break-glass —— deny_id="D1", reason="E1 活验：确认未在拦的门禁会被拒（预防性砸玻璃）", category="scope_edge"   ← 刻意用例

被拒绝的那几步，请把错误原文一字不改地贴出来。`

const request = { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: PROMPT }] }
p('')
p(`═══ 发送（sessionId=${sessionId}）═══`)
let sent = null
for (const key of ['request', '_request']) {
  try { sent = await rpc('session/prompt', { [key]: request }); p(`  ✅ args.${key} 发送成功 ⇒ ${JSON.stringify(sent).slice(0, 200)}`); break }
  catch (e) { p(`  ❌ args.${key} ⇒ ${e.message}`) }
}
if (sent === null) { console.error('发送失败，终止'); process.exit(1) }

// ───────────────────────────────────────────── ③ 轮询新事件
p('')
p('═══ 等待新回合（按 seq > 基线 判"新"）═══')
const DEADLINE = Date.now() + 180_000
let fresh = []
while (Date.now() < DEADLINE) {
  await new Promise((r) => setTimeout(r, 3000))
  let cur
  try { cur = recsOf(TFILE) } catch { continue }
  fresh = cur.recs.filter((r) => Number(r.seq ?? 0) > baseSeq)
  const done = fresh.filter((r) => r.type === 'turn/end').length
  const res = fresh.filter((r) => r.type === 'tool/result').length
  process.stdout.write(`\r  已 ${Math.round((180_000 - (DEADLINE - Date.now())) / 1000)}s：新记录 ${fresh.length} 条、tool/result ${res} 条、turn/end ${done}`)
  if (done >= 1 && res >= 5) break
  if (done >= 1 && Date.now() > DEADLINE - 150_000 && res > 0) { await new Promise((r) => setTimeout(r, 4000)); break }
}
p('')

// ───────────────────────────────────────────── ④ 打结果
const calls = fresh.filter((r) => r.type === 'tool/call')
const results = fresh.filter((r) => r.type === 'tool/result')
p('')
p(`═══ 新 tool/call ${calls.length} 条 / 新 tool/result ${results.length} 条 ═══`)
for (const c of calls) {
  p(`  ▶ #${c.seq} ${c.data?.name}  参数=${c.data?.arguments}`)
}
p('')
for (const r of results) {
  const cid = r.data?.message?.source?.callId
  const call = calls.find((c) => c.data?.callId === cid)
  const blocks = r.data?.message?.content ?? []
  const texts = []
  for (const b of blocks) for (const c of (b.content ?? [])) if (c.type === 'text') texts.push(c.text)
  const isErr = blocks.some((b) => b.isError === true) || /^Error:/m.test(texts.join('\n'))
  p(`  ◀ #${r.seq} ${call?.data?.name ?? cid}  ${isErr ? '🔴 拒绝/错误' : '✅ 成功'}`)
  p('     ' + texts.join('\n     ').slice(0, 900).replace(/\n/g, '\n     '))
  p('')
}

// ───────────────────────────────────────────── ⑤ 磁盘侧证
const phaseLines1 = chainLines(`${AUDIT}/phase.jsonl`)
const gateLines1 = chainLines(`${AUDIT}/gate.jsonl`)
p('═══ 磁盘侧证 ═══')
p(`  phase.jsonl 行数 ${phaseLines0} → ${phaseLines1}（Δ${phaseLines1 - phaseLines0}）`)
p(`  gate.jsonl  行数 ${gateLines0} → ${gateLines1}（Δ${gateLines1 - gateLines0}）`)
p(`  沙箱现在: ${expListing()}`)

const { writeFileSync } = await import('node:fs')
writeFileSync('_e1e2_live_out.txt', out.join('\n') + '\n', 'utf8')
console.log('\n结果已写入 _e1e2_live_out.txt')
