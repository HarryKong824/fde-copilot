/**
 * C1 活验第二步：真实调用 fde_ontology_write 验证「手动降级被拒」。
 * 用例：写 effect:deny 规则（自动判 L1）+ 请求 level:L0 → 预期 LEVEL_DOWNGRADE_DENIED，
 *      且 ontologyRoot 里 logic.yaml **不落盘**。
 * 副作用：一条 deny 审计进 gate.jsonl（不写文件）。
 * 用法：node _c1_live_drive.mjs
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const BASE = 'http://127.0.0.1:3080'
const ONTOLOGY_ROOT = 'E:/ontologyRoot'
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

async function readRecords(sid, throughSeq) {
  const v = await rpc('session/page', { request: { address: { kind: 'session', sessionId: sid }, throughSeq } })
  return v?.records ?? []
}

async function waitSettle(sid, maxMs = 240000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const s = await asOfSeq(sid)
    const recs = await readRecords(sid, s)
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
  await rpc('session/cancel', { request: { sessionId: sid } }).catch(() => {})
  return await asOfSeq(sid)
}

const L = []
const log = (s) => { L.push(s); console.log(s) }

// 记录活验前的 ontologyRoot 里 logic.yaml 是否存在
const preExists = existsSync(ONTOLOGY_ROOT + '/logic.yaml')
log('[前置] E:/ontologyRoot/logic.yaml 存在 = ' + preExists)

const created = await rpc('session/create', { request: { cwd: 'E:\\DSH-workspace', agentPreset: 'standard' } })
const sid = created?.sessionId ?? created?.id ?? created?.session?.sessionId
log('[会话] ' + sid)
if (!sid) { log('创建失败: ' + JSON.stringify(created)); process.exit(1) }

const prompt = [
  '请调用 fde_ontology_write 工具一次，参数如下，请原样传入（这是受控门禁测试）：',
  '',
  'path = "logic.yaml"',
  'content = "rules:\\n  - id: r_deny_probe\\n    effect: deny\\n    reason: 探针\\n    condition: {\\">\\": [{\\"var\\": \\"treatment.score\\"}, 100]}"',
  'source = "model"',
  'confidence = 80',
  'reason = "C1 活验：验证手动降级被拒"',
  'level = "L0"',
  '',
  '直接调用，不要读文件、不要探索、不要做任何其他操作。调用后把工具返回的结果（成功或失败）原样告诉我。'
].join('\n')

await rpc('session/prompt', { request: { sessionId: sid, requestId: 'req-' + Date.now(), mode: 'queue', content: [{ type: 'text', text: prompt }] } })
const seq = await waitSettle(sid)
log('[回合结束] asOfSeq=' + seq)

const records = await readRecords(sid, seq)
const calls = []
const results = []
for (const r of records) {
  const ev = r.event ?? r
  if (ev.type === 'tool/call') {
    const d = ev.data ?? {}
    if ((d.name ?? '') === 'fde_ontology_write') calls.push(d.arguments ?? d.args)
  } else if (ev.type === 'tool/result') {
    const d = ev.data ?? {}
    if ((d.name ?? '') === 'fde_ontology_write') results.push(d)
  }
}

log('[调用次数] ' + calls.length)
for (const c of calls) log('  call args = ' + JSON.stringify(c))

log('[结果条数] ' + results.length)
for (const d of results) {
  log('  === tool/result 完整结构 ===')
  log('  ' + JSON.stringify(d).slice(0, 2000))
}

// 判据
let verdict = 'FAIL'
if (results.length === 0) {
  log('✗ 没有 fde_ontology_write 的 tool/result（模型可能未调用）')
} else {
  const d = results[results.length - 1]
  const c0 = d?.message?.content?.[0]
  const isError = c0?.isError ?? false
  const text = String(c0?.text ?? c0?.content?.[0]?.text ?? JSON.stringify(d))
  log('--- 判据 ---')
  log('isError = ' + isError)
  log('正文 = ' + text.slice(0, 300))
  const hasDowngrade = text.includes('LEVEL_DOWNGRADE_DENIED') || text.includes('拒绝降级')
  log('含 LEVEL_DOWNGRADE_DENIED/拒绝降级 = ' + hasDowngrade)
  const postExists = existsSync(ONTOLOGY_ROOT + '/logic.yaml')
  log('logic.yaml 落盘 = ' + postExists)
  if (isError && hasDowngrade && !postExists) {
    verdict = 'PASS'
    log('RESULT: PASS（降级被拒 + 未落盘）')
  } else {
    log('RESULT: FAIL')
  }
}

writeFileSync('_c1_live_out.txt', L.join('\n') + '\n', 'utf8')
console.log('[已写 _c1_live_out.txt]  verdict=' + verdict)
