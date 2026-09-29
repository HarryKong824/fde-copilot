/** 打印指定会话每条 request/header 的 reason 与完整工具清单（只读）。 */
import { readFileSync, existsSync } from 'node:fs'

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
  const body = JSON.stringify({ type: 'client-request', rpcId: 't' + ++n, method, payload: { args: argsObj } })
  const res = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body
  })
  const j = await res.json()
  if (j.result && j.result.ok === false) throw new Error(method + ': ' + JSON.stringify(j.result.error))
  return j.result?.value
}

const sid = process.argv[2]
if (!sid) {
  console.error('用法: node _peek_tools.mjs <sessionId>')
  process.exit(2)
}

const list = await rpc('session/list', { _request: {} })
const it = (list?.items ?? []).find((x) => (x.sessionId ?? x.id) === sid)
if (!it) {
  console.error('找不到会话 ' + sid)
  process.exit(2)
}
const page = await rpc('session/page', {
  request: { address: { kind: 'session', sessionId: sid }, throughSeq: it?.projections?.asOfSeq ?? 0 }
})
const recs = page?.records ?? []
const hdrs = recs.filter((r) => (r.event ?? r)?.type === 'request/header')
const L = []
L.push('session=' + sid + '  header 条数=' + hdrs.length)
for (const r of hdrs) {
  const ev = r.event ?? r
  const tools = (ev.data?.header?.tools ?? []).map((t) => (typeof t === 'string' ? t : t?.name))
  L.push('  seq=' + ev.seq + ' reason=' + JSON.stringify(ev.data?.reason) + ' n=' + tools.length)
  L.push('  tools = ' + JSON.stringify(tools))
}
const out = L.join('\n') + '\n'
await import('node:fs').then((fs) => fs.writeFileSync('_peek_tools_out.txt', out, 'utf8'))
console.log(out)
