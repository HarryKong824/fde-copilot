/**
 * 探查 transcript 里 request/header 的真实结构（给 _assert_restrict_live.mjs 定字段名）。
 * 用法：node _peek_headers.mjs [sessionId]
 * 输出：_peek_headers_out.txt
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const BASE = 'http://127.0.0.1:3080'
let n = 0

/**
 * 从 curl 的 Netscape cookie jar 里拼 Cookie 头。
 * ⚠️ 不用 curl 子进程：本环境里 `spawnSync curl` 会 EBUSY（沙箱占用可执行文件）。
 * 本地 3080 要求带 `dsh-auth-*` cookie，否则回包体是明文 `unauthorized`（不是 JSON）。
 */
function cookieHeader() {
  if (!existsSync(JAR)) return ''
  const parts = []
  for (const raw of readFileSync(JAR, 'utf8').split('\n')) {
    let line = raw.trim()
    if (!line) continue
    // ⚠️ `#HttpOnly_` 前缀是 curl 给 HttpOnly cookie 打的标记，**不是注释行** ——
    // 直接按 `#` 开头跳过会把唯一那条 auth cookie 丢掉（实测表现为 len=0 → 401）。
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const cols = line.split('\t')
    if (cols.length < 7) continue
    parts.push(cols[5] + '=' + cols[6])
  }
  return parts.join('; ')
}

async function rpc(method, argsObj) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'r' + ++n,
    method,
    payload: { args: argsObj }
  })
  const res = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body
  })
  const text = await res.text()
  let j
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(method + ': 回包不是 JSON（多半缺 auth cookie）→ ' + text.slice(0, 120))
  }
  if (j.result?.ok === false) throw new Error(method + ': ' + JSON.stringify(j.result.error))
  return j.result?.value
}

const want = process.argv[2]
const list = await rpc('session/list', { _request: {} })
const items = list?.items ?? []
const it = (want ? items.find((x) => (x.sessionId ?? x.id) === want) : null) ?? items[0]
const sid = it?.sessionId ?? it?.id
const page = await rpc('session/page', {
  request: { address: { kind: 'session', sessionId: sid }, throughSeq: it?.projections?.asOfSeq ?? 0 }
})
const recs = page?.records ?? []
const L = []
L.push('session=' + sid + '  records=' + recs.length)
L.push('record[0] keys = ' + JSON.stringify(Object.keys(recs[0] ?? {})))

const types = {}
for (const r of recs) {
  const t = (r.event ?? r)?.type ?? '?'
  types[t] = (types[t] ?? 0) + 1
}
L.push('type 分布 = ' + JSON.stringify(types))

const hdrs = recs.filter((r) => (r.event ?? r)?.type === 'request/header')
L.push('request/header 条数 = ' + hdrs.length)
for (const h of hdrs.slice(0, 4)) {
  const ev = h.event ?? h
  const tools = ev.data?.header?.tools
  L.push('--- seq=' + String(h.seq ?? ev.seq ?? '?') + ' recordKeys=' + JSON.stringify(Object.keys(h)))
  L.push('    data keys = ' + JSON.stringify(Object.keys(ev.data ?? {})))
  L.push('    header keys = ' + JSON.stringify(Object.keys(ev.data?.header ?? {})))
  L.push('    reason = ' + JSON.stringify(ev.data?.reason))
  L.push('    tools isArray=' + Array.isArray(tools) + ' n=' + (tools?.length ?? '-'))
  L.push('    tools[0] = ' + JSON.stringify(tools?.[0]).slice(0, 260))
  L.push('    tool names = ' + JSON.stringify((tools ?? []).map((t) => t?.name ?? t).slice(0, 40)))
}

writeFileSync('_peek_headers_out.txt', L.join('\n') + '\n', 'utf8')
console.log(L.join('\n'))
process.exitCode = 0
