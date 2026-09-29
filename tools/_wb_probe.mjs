/**
 * 只读探测 WorkBuddy 本机 HTTP 接口（**只发 GET，不做任何写操作**）。
 * endpoint 从 C:\Users\DELL\.workbuddy\wbipc\endpoint.json 与 sessions/<pid>.json 读。
 */
import { readFileSync, readdirSync } from 'node:fs'

const HOME = 'C:/Users/DELL/.workbuddy'

// 取当前活跃会话的 endpoint
let base = null
let sid = null
const sdir = `${HOME}/sessions`
const cands = []
for (const f of readdirSync(sdir)) {
  if (!f.endsWith('.json')) continue
  try {
    const j = JSON.parse(readFileSync(`${sdir}/${f}`, 'utf8'))
    if (j.endpoint) cands.push(j)
  } catch {}
}
cands.sort((a, b) => (b.lastHeartbeat ?? 0) - (a.lastHeartbeat ?? 0))
if (cands[0]) {
  base = cands[0].endpoint
  sid = cands[0].sessionId
  console.log(`活跃会话: pid=${cands[0].pid} sessionId=${sid}`)
  console.log(`  cwd=${cands[0].cwd}`)
  console.log(`  version=${cands[0].version} kind=${cands[0].kind} mode=${cands[0].mode}`)
  console.log(`  心跳=${new Date(cands[0].lastHeartbeat).toISOString()}`)
  console.log(`  endpoint=${base}`)
} else {
  console.log('没有带 endpoint 的会话元数据')
  process.exit(0)
}
console.log('')

const paths = [
  '/',
  '/health',
  '/version',
  '/docs',
  '/openapi.json',
  '/api',
  '/api/health',
  '/api/version',
  '/api/session',
  '/api/sessions',
  '/api/status',
  '/status'
]
for (const p of paths) {
  const u = base + p
  try {
    const r = await fetch(u, { method: 'GET', signal: AbortSignal.timeout(4000) })
    const t = await r.text()
    console.log(`${String(r.status).padEnd(4)} ${p.padEnd(16)} ${JSON.stringify(t.slice(0, 200))}`)
  } catch (e) {
    console.log(`ERR  ${p.padEnd(16)} ${e.message}`)
  }
}
