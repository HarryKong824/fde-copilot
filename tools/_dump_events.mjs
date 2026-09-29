/** 打印指定会话的事件序列（seq + type + 少量关键字段），用于追 Governor 生命周期（只读）。 */
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
  const body = JSON.stringify({ type: 'client-request', rpcId: 'e' + ++n, method, payload: { args: argsObj } })
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
  console.error('用法: node _dump_events.mjs <sessionId>')
  process.exit(2)
}
const list = await rpc('session/list', { _request: {} })
const it = (list?.items ?? []).find((x) => (x.sessionId ?? x.id) === sid)
const page = await rpc('session/page', {
  request: { address: { kind: 'session', sessionId: sid }, throughSeq: it?.projections?.asOfSeq ?? 0 }
})
const recs = page?.records ?? []
const L = []
L.push('session=' + sid + '  records=' + recs.length)
for (const r of recs) {
  const ev = r.event ?? r
  const t = ev.type ?? '?'
  let extra = ''
  if (t === 'request/header') {
    const tools = (ev.data?.header?.tools ?? []).map((x) => (typeof x === 'string' ? x : x?.name))
    extra = ' reason=' + JSON.stringify(ev.data?.reason) + ' n=' + tools.length + ' pwsh=' + (tools.includes('pwsh') ? 'IN' : 'out')
  } else if (t === 'tool/result') {
    const c = ev.data?.message?.content?.[0]
    extra = ' name=' + ev.data?.name + ' isError=' + (c?.isError ?? '?') + ' text=' + String(c?.text ?? '').slice(0, 160).replace(/\n/g, ' | ')
  } else if (t === 'tool/call') {
    const d = ev.data ?? {}
    extra = ' name=' + (d.name ?? '?') + ' args=' + JSON.stringify(d.arguments ?? d.args ?? {}).slice(0, 220)
  } else if (t === 'user/message') {
    extra = ' ' + JSON.stringify(ev.data?.content ?? '').slice(0, 160)
  } else if (t === 'assistant/message') {
    const txt = (ev.data?.message?.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('')
    extra = ' ' + txt.slice(0, 160).replace(/\n/g, ' | ')
  }
  L.push(String(ev.seq ?? r.seq ?? '?').padStart(6) + '  ' + t + extra)
}
const out = L.join('\n') + '\n'
writeFileSync('_dump_events_out.txt', out, 'utf8')
console.log(out)
