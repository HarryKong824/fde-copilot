import { readFileSync, existsSync } from 'node:fs'
const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
function cookieHeader() {
  if (!existsSync(JAR)) return 'NO-JAR'
  const parts = []
  for (const raw of readFileSync(JAR, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const cols = line.split('\t')
    if (cols.length < 7) continue
    parts.push(cols[5].replace(/^#HttpOnly_/, '') + '=' + cols[6])
  }
  return parts.join('; ')
}
const ck = cookieHeader()
console.log('COOKIE=' + ck.slice(0, 60) + '...len=' + ck.length)
const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: { _request: {} } } })
const res = await fetch('http://127.0.0.1:3080/api/session/list', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body })
const text = await res.text()
console.log('STATUS=' + res.status)
console.log('HDRS=' + JSON.stringify(Object.fromEntries(res.headers)))
console.log('BODY=' + text.slice(0, 200))
