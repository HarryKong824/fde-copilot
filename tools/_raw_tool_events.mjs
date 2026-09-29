/**
 * 从会话 transcript 里**原样**取出 tool/call 与 tool/result 事件（不做任何转述）。
 * 用法：node _raw_tool_events.mjs <sessionId>
 * 输出：_raw_tool_events_out.txt
 */
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const BASE = 'http://127.0.0.1:3080'

let n = 0
async function rpc(method, argsObj) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `r${++n}`,
    method,
    payload: { args: argsObj }
  })
  const out = execFileSync(
    'curl',
    ['-s', '--max-time', '60', '-b', JAR, '-c', JAR, '-X', 'POST', `${BASE}/api/${method}`,
     '-H', 'Content-Type: application/json', '-d', body],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  const json = JSON.parse(out)
  if (json.result?.ok === false) throw new Error(`${method} 失败: ${JSON.stringify(json.result.error)}`)
  return json.result?.value
}

const sessionId = process.argv[2]
if (!sessionId) { console.error('用法: node _raw_tool_events.mjs <sessionId>'); process.exit(2) }

const list = await rpc('session/list', { _request: {} })
const it = (list?.items ?? []).find((x) => (x.sessionId ?? x.id) === sessionId)
const throughSeq = it?.projections?.asOfSeq ?? 0
const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq } })
const recs = page?.records ?? []

const lines = [`session=${sessionId} throughSeq=${throughSeq} records=${recs.length}`]
for (const r of recs) {
  const ev = r.event ?? r
  if (ev?.type === 'tool/call') {
    const d = ev.data ?? {}
    lines.push(`CALL name=${d.name} arguments=${JSON.stringify(d.arguments ?? d.args)}`)
  } else if (ev?.type === 'tool/result') {
    const d = ev.data ?? {}
    // 真实形态：data.message.content[0] 是 {type:'tool-result', isError, content:[{type:'text', text}]}
    const part = d.message?.content?.[0] ?? {}
    const text = part.content?.[0]?.text ?? part.text ?? d.text ?? ''
    lines.push(`RESULT isError=${JSON.stringify(part.isError ?? d.isError)}`)
    lines.push(`       text=${JSON.stringify(text)}`)
  }
}
writeFileSync('_raw_tool_events_out.txt', lines.join('\n') + '\n', 'utf8')
console.log(lines.join('\n'))
