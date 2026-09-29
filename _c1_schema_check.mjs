/**
 * C1 活验第一步：读真实会话 request/header，dump `fde_ontology_write` 完整 schema。
 * 判据：parameters 里有 level（enum L0/L1/L2）+ output.schema 里有 level。
 * 零副作用（只读 header，不调工具、不写 ontology）。
 * 用法：node _c1_schema_check.mjs
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const BASE = 'http://127.0.0.1:3080'
let n = 0

function cookieHeader() {
  if (!existsSync(JAR)) return ''
  const parts = []
  for (const raw of readFileSync(JAR, 'utf8').split('\n')) {
    let line = raw.trim()
    if (!line) continue
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const cols = line.split('\t')
    if (cols.length < 7) continue
    parts.push(cols[5] + '=' + cols[6])
  }
  return parts.join('; ')
}

async function rpc(method, argsObj) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'r' + ++n, method, payload: { args: argsObj } })
  const res = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body
  })
  const text = await res.text()
  let j
  try { j = JSON.parse(text) } catch { throw new Error(method + ' 非 JSON: ' + text.slice(0, 200)) }
  if (j.result?.ok === false) throw new Error(method + ': ' + JSON.stringify(j.result.error))
  return j.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function asOfSeq(sid) {
  const v = await rpc('session/list', { _request: {} })
  const items = v?.items ?? []
  const it = items.find((x) => (x.sessionId ?? x.id) === sid)
  return it?.projections?.asOfSeq ?? 0
}

async function waitSettle(sid, maxMs = 120000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const s = await asOfSeq(sid)
    const recs = await (await rpc('session/page', { request: { address: { kind: 'session', sessionId: sid }, throughSeq: s } }))?.records ?? []
    let lastFinish = null
    let lastStepEnd = 0
    for (const r of recs) {
      const ev = r.event ?? r
      if (ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'finish') lastFinish = ev.data.chunk
      if (ev.type === 'step/end') lastStepEnd++
    }
    if (lastFinish && lastStepEnd > 0 && lastFinish.reason?.kind !== 'tool-calls') return s
    await sleep(4000)
  }
  return await asOfSeq(sid)
}

const L = []
const log = (s) => { L.push(s); console.log(s) }

const created = await rpc('session/create', { request: { cwd: 'E:\\DSH-workspace', agentPreset: 'standard' } })
const sid = created?.sessionId ?? created?.id ?? created?.session?.sessionId
log('[会话] ' + sid)
if (!sid) { log('创建失败: ' + JSON.stringify(created)); process.exit(1) }

await rpc('session/prompt', { request: { sessionId: sid, requestId: 'req-' + Date.now(), mode: 'queue', content: [{ type: 'text', text: '你好' }] } })
const seq = await waitSettle(sid)
log('[回合结束] asOfSeq=' + seq)

const records = await (await rpc('session/page', { request: { address: { kind: 'session', sessionId: sid }, throughSeq: seq } }))?.records ?? []
const hdrs = records.filter((r) => (r.event ?? r)?.type === 'request/header')
log('[request/header 条数] ' + hdrs.length)

let found = null
for (const h of hdrs) {
  const ev = h.event ?? h
  const tools = ev.data?.header?.tools ?? []
  const t = tools.find((x) => (x?.name ?? x?.function?.name) === 'fde_ontology_write')
  if (t) { found = t; break }
}

if (!found) {
  log('✗ 未在 request/header 里找到 fde_ontology_write')
} else {
  log('=== fde_ontology_write 完整定义 ===')
  log(JSON.stringify(found, null, 2))
  const params = found.parameters ?? found.input_schema ?? found.inputSchema ?? {}
  const hasLevelParam = JSON.stringify(params).includes('level') && JSON.stringify(params).includes('L2')
  const outSchema = JSON.stringify(found.output ?? found.output_schema ?? {})
  const hasLevelOut = outSchema.includes('level')
  log('--- 判据 ---')
  log('parameters 含 level + L2 enum: ' + hasLevelParam)
  log('output 含 level: ' + hasLevelOut)
  log(hasLevelParam && hasLevelOut ? 'RESULT: PASS' : 'RESULT: FAIL')
}

writeFileSync('_c1_schema_out.txt', L.join('\n') + '\n', 'utf8')
console.log('[已写 _c1_schema_out.txt]')
