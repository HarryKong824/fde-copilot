import { readFileSync, existsSync, writeFileSync } from 'node:fs'
const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
function cookieHeader() {
  if (!existsSync(JAR)) return ''
  const parts = []
  for (const raw of readFileSync(JAR, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#HttpOnly_') === false && line.startsWith('#')) continue
    const cols = line.split('\t')
    if (cols.length < 7) continue
    parts.push(cols[5].replace(/^#HttpOnly_/, '') + '=' + cols[6])
  }
  return parts.join('; ')
}
const ck = cookieHeader()
const BASE = 'http://127.0.0.1:3080'
let n = 0
async function rpc(method, argsObj) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'p' + ++n, method, payload: { args: argsObj } })
  const res = await fetch(BASE + '/api/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body
  })
  const j = await res.json()
  if (j.result?.ok === false) throw new Error(method + ': ' + JSON.stringify(j.result.error))
  return j.result?.value
}
const L = []
const list = await rpc('session/list', { _request: {} })
const items = list?.items ?? []
L.push(`sessions = ${items.length}`)
for (const it of items) {
  L.push(`--- ${it.sessionId ?? it.id} running=${it.running} asOfSeq=${it?.projections?.asOfSeq} updatedAt=${it.updatedAt ?? it.createdAt ?? '?'} title=${JSON.stringify(it.title ?? '')}`)
}
writeFileSync('_peek_sessions_out.txt', L.join('\n') + '\n', 'utf8')
console.log(L.join('\n'))
