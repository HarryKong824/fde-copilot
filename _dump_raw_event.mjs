/** 打印指定会话某条 seq 事件的原始 JSON（只读，用于确认字段形状而不是猜）。 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'

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
  const j = await res.json()
  if (j.result && j.result.ok === false) throw new Error(method + ': ' + JSON.stringify(j.result.error))
  return j.result?.value
}

const sid = process.argv[2]
const wantSeq = Number(process.argv[3])
if (!sid || Number.isNaN(wantSeq)) {
  console.error('用法: node _dump_raw_event.mjs <sessionId> <seq>')
  process.exit(2)
}
const list = await rpc('session/list', { _request: {} })
const it = (list?.items ?? []).find((x) => (x.sessionId ?? x.id) === sid)
const page = await rpc('session/page', {
  request: { address: { kind: 'session', sessionId: sid }, throughSeq: it?.projections?.asOfSeq ?? 0 }
})
const hit = (page?.records ?? []).find((r) => Number((r.event ?? r)?.seq) === wantSeq)
const out = hit ? JSON.stringify(hit, null, 2) : '未找到 seq=' + wantSeq
writeFileSync('_dump_raw_event_out.txt', out + '\n', 'utf8')
console.log(out.slice(0, 3000))
