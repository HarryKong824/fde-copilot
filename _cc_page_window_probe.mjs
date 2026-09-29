/**
 * Claude Code 独立核证：`session/page` 的**视窗截断**（WorkBuddy 0028-reply §6 的 P1-16）。
 *
 * 要独立回答三件事（不采信他的输出）：
 *   ① RPC 回包到底有没有 `hasMore`？records 多少条？首/末 seq 各是多少？
 *   ② 磁盘全量里 `843e3bee` 有几条 `request/header`？RPC 给了几条？差集是哪些 seq？
 *   ③ 两条链的时间字段各是什么（header 的 `time` vs 审计的 `ts`）—— §7.2 的更正要用。
 *
 * 自检：磁盘全量与 RPC 视窗都独立取；差集用**集合运算**算，不手抄。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const SESS = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const BASE = 'http://127.0.0.1:3080'
const SID = 'session-843e3bee-68f9-4405-b34b-b9a849f07da0'
let n = 0

function cookieHeader() {
  if (!existsSync(JAR)) return ''
  const parts = []
  for (const raw of readFileSync(JAR, 'utf8').split('\n')) {
    let line = raw.trim()
    if (!line) continue
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const c = line.split('\t')
    if (c.length < 7) continue
    parts.push(`${c[5]}=${c[6]}`)
  }
  return parts.join('; ')
}

async function rpc(method, args) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body: JSON.stringify({ type: 'client-request', rpcId: `pw${++n}`, method, payload: { args } })
  })
  const t = await res.text()
  let j
  try {
    j = JSON.parse(t)
  } catch {
    throw new Error(`${method}: 非 JSON（多半缺 auth cookie）→ ${t.slice(0, 120)}`)
  }
  if (j.result?.ok === false) throw new Error(`${method}: ${JSON.stringify(j.result.error)}`)
  return j.result?.value
}

function diskHeaders() {
  const dir = readdirSync(SESS).find((d) => d.includes('843e3bee'))
  const buf = readFileSync(`${SESS}/${dir}/session.jsonl.zstd`)
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
  const events = []
  for (const l of Buffer.concat(parts).toString('utf8').split(/\r?\n/)) {
    if (!l.trim()) continue
    try {
      events.push(JSON.parse(l))
    } catch {}
  }
  const hs = []
  for (const r of events) {
    const ev = r?.event ?? r
    if (ev?.type !== 'request/header') continue
    const t = ev?.data?.header?.tools
    hs.push({
      seq: ev?.seq ?? null,
      reason: ev?.data?.reason ?? null,
      time: ev?.time ?? null,
      n: Array.isArray(t) ? t.length : 'ABSENT',
      pwsh: Array.isArray(t) ? (t.some((x) => (x?.name ?? x) === 'pwsh') ? 'IN' : 'out') : '?'
    })
  }
  return { dir, events: events.length, hs }
}

const main = async () => {
  // ── 磁盘全量（独立）
  const d = diskHeaders()
  console.log(`磁盘：${d.dir}  事件=${d.events}  request/header=${d.hs.length}`)
  console.log('  seq        reason    time(epoch ms)      n    pwsh')
  for (const h of d.hs) {
    console.log(`  ${String(h.seq).padEnd(10)} ${String(h.reason).padEnd(9)} ${String(h.time).padEnd(19)} ${String(h.n).padEnd(4)} ${h.pwsh}`)
  }
  let flips = 0
  for (let i = 1; i < d.hs.length; i++) if (d.hs[i - 1].pwsh === 'IN' && d.hs[i].pwsh === 'out') flips++
  console.log(`  ⇒ IN→out 自发消失 = ${flips} 次`)

  // ── RPC 视窗
  const list = await rpc('session/list', { _request: {} })
  const it = (list?.items ?? []).find((x) => (x.sessionId ?? x.id) === SID)
  const asOf = it?.projections?.asOfSeq ?? 0
  const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: SID }, throughSeq: asOf } })

  console.log(`\nRPC：session/page throughSeq=${asOf}`)
  console.log(`  回包顶层键 = ${JSON.stringify(Object.keys(page ?? {}))}`)
  console.log(`  hasMore = ${JSON.stringify(page?.hasMore)}   total = ${JSON.stringify(page?.total)}`)
  const recs = page?.records ?? []
  console.log(`  records = ${recs.length}`)
  const seqs = recs.map((r) => (r?.event ?? r)?.seq).filter((x) => typeof x === 'number')
  console.log(`  首条 seq = ${seqs[0]}   末条 seq = ${seqs[seqs.length - 1]}`)
  console.log(`  末条 seq === asOfSeq ? ${seqs[seqs.length - 1] === asOf}`)

  const rpcHs = []
  for (const r of recs) {
    const ev = r?.event ?? r
    if (ev?.type !== 'request/header') continue
    rpcHs.push(ev?.seq ?? null)
  }
  console.log(`  RPC 视窗内 request/header = ${rpcHs.length} 条: ${rpcHs.join(', ')}`)

  const diskSeq = new Set(d.hs.map((h) => h.seq))
  const rpcSeq = new Set(rpcHs)
  const missing = [...diskSeq].filter((s) => !rpcSeq.has(s))
  console.log(`\n差集（磁盘有、RPC 视窗没有）= ${missing.length} 条: ${missing.join(', ')}`)
  console.log(`⇒ ${missing.length > 0 ? '🔴 视窗截断成立' : '✅ 无视窗截断'}`)

  // ── §7.2 的时间字段核对：审计链
  const AUD = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit'
  for (const f of ['gate.jsonl', 'phase.jsonl']) {
    const raw = readFileSync(`${AUD}/${f}`, 'utf8').trim().split(/\r?\n/)
    const last = JSON.parse(raw[raw.length - 1])
    console.log(`\n审计 ${f}: 行数=${raw.length}  末条 seq=${last.seq}  ts=${JSON.stringify(last.ts)}  time=${JSON.stringify(last.time)}`)
  }
  console.log(`\n⇒ header 用 time(epoch ms) / 审计用 ts(ISO) —— 两个命名空间的 seq 数值范围：header 最大 ${Math.max(...d.hs.map((h) => h.seq))}，审计 ${15}/${2}`)
}

main().catch((e) => {
  console.error('🔴', e?.message ?? e)
  process.exitCode = 1
})
