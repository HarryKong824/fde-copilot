/**
 * 对活体 tool/result 原文断言锁文案（模型转述一律不采信）。
 * 用法：node _assert_lock_msg.mjs <sessionId> <true|false>   ← 期望的 parseable
 * 输出：_assert_lock_msg_out.txt
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
  const j = JSON.parse(out)
  if (j.result?.ok === false) throw new Error(`${method}: ${JSON.stringify(j.result.error)}`)
  return j.result?.value
}

const sid = process.argv[2]
const expectParseable = process.argv[3] !== 'false'
if (!sid) { console.error('用法: node _assert_lock_msg.mjs <sessionId> <true|false>'); process.exit(2) }

const list = await rpc('session/list', { _request: {} })
const it = (list?.items ?? []).find((x) => (x.sessionId ?? x.id) === sid)
const page = await rpc('session/page', {
  request: { address: { kind: 'session', sessionId: sid }, throughSeq: it?.projections?.asOfSeq ?? 0 }
})

let text = null
let isError = null
for (const r of page?.records ?? []) {
  const ev = r.event ?? r
  if (ev?.type !== 'tool/result') continue
  const part = ev.data?.message?.content?.[0] ?? {}
  text = part.content?.[0]?.text ?? ''
  isError = part.isError ?? null
}

const L = []
L.push(`session=${sid}  期望 parseable=${expectParseable}`)
L.push(`isError=${JSON.stringify(isError)}`)
L.push(`TEXT=${JSON.stringify(text)}`)
L.push('--- 断言 ---')
const checks = expectParseable
  ? [
      ['isError 为 true', isError === true],
      ['含「未过期」', !!text && text.includes('未过期')],
      ['含持有者 pid', !!text && /持有者 pid=\d+/.test(text)],
      ['含审计号', !!text && /审计 #\d+/.test(text)],
      ['不得出现「不可解析」', !!text && !text.includes('不可解析')]
    ]
  : [
      ['isError 为 true', isError === true],
      ['含「不可解析」', !!text && text.includes('不可解析')],
      ['**不含**「未过期」', !!text && !text.includes('未过期')],
      ['含删锁路径 .state.lock', !!text && text.includes('.state.lock')],
      ['含审计号', !!text && /审计 #\d+/.test(text)],
      ['无半截句（不含「持有者 pid=」）', !!text && !text.includes('持有者 pid=')]
    ]
for (const [name, ok] of checks) L.push(`${ok ? 'OK  ' : 'FAIL'} ${name}`)
const bad = checks.filter(([, ok]) => !ok).length
L.push(`通过 ${checks.length - bad}/${checks.length}`)
L.push(`RESULT: ${bad === 0 ? 'ALL-PASS' : 'HAS-FAIL'}`)
writeFileSync('_assert_lock_msg_out.txt', L.join('\n') + '\n', 'utf8')
console.log(L.join('\n'))
process.exitCode = bad === 0 ? 0 : 1
