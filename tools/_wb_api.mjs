/**
 * 摸清 WorkBuddy(CodeBuddy) Remote Control 的接口与鉴权方式（**只做只读 GET**）。
 * ticket 是凭据，本脚本只把它用于构造请求头，**不打印**。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'

const HOME = 'C:/Users/DELL/.workbuddy'

// 活跃会话 endpoint
const cands = []
for (const f of readdirSync(`${HOME}/sessions`)) {
  if (!f.endsWith('.json')) continue
  try {
    const j = JSON.parse(readFileSync(`${HOME}/sessions/${f}`, 'utf8'))
    if (j.endpoint) cands.push(j)
  } catch {}
}
cands.sort((a, b) => (b.lastHeartbeat ?? 0) - (a.lastHeartbeat ?? 0))
const meta = cands[0]
const BASE = meta.endpoint

// IPC ticket（不打印值）
let ticket = null
try {
  const w = JSON.parse(readFileSync(`${HOME}/wbipc/endpoint.json`, 'utf8'))
  ticket = w.ticket
  console.log(`wbipc: endpoint=${w.endpoint}  ticket=${ticket ? `已读到(${ticket.length}字符，不显示)` : '无'}`)
} catch (e) {
  console.log('wbipc/endpoint.json 读不到:', e.message)
}

// 试几种候选鉴权头
const HEADER_VARIANTS = [
  ['(无)', {}],
  ['Authorization: Bearer', { Authorization: `Bearer ${ticket}` }],
  ['X-Ticket', { 'X-Ticket': ticket }],
  ['X-Workbuddy-Ticket', { 'X-Workbuddy-Ticket': ticket }],
  ['Cookie: wbipc', { Cookie: `wbipc=${ticket}` }],
  ['X-Auth-Token', { 'X-Auth-Token': ticket }]
]

// 先拿根页面（无需鉴权），从中挖接口线索
console.log('\n=== GET / （挖前端线索）===')
try {
  const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(5000) })
  const html = await r.text()
  console.log(`status=${r.status} 长度=${html.length}`)
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1])
  console.log('script src:', JSON.stringify(scripts))
  const apis = [...new Set([...html.matchAll(/["'`](\/api\/[A-Za-z0-9_\-/]+)["'`]/g)].map((m) => m[1]))]
  console.log('页面内出现的 /api 路径:', JSON.stringify(apis.slice(0, 30)))
  const inline = html.match(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g) ?? []
  console.log('内联脚本数:', inline.length)
  for (const s of inline.slice(0, 4)) {
    const body = s.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')
    console.log('  --- 内联片段 ---')
    console.log('  ' + body.slice(0, 700).replace(/\n/g, '\n  '))
  }
} catch (e) {
  console.log('GET / 失败:', e.message)
}

// 逐个试鉴权头，看 /api/version 是否放行
console.log('\n=== 试鉴权头 → GET /api/version ===')
for (const [name, hdrs] of HEADER_VARIANTS) {
  if (name !== '(无)' && !ticket) continue
  try {
    const r = await fetch(`${BASE}/api/version`, { headers: hdrs, signal: AbortSignal.timeout(5000) })
    const t = await r.text()
    console.log(`${String(r.status).padEnd(4)} ${name.padEnd(22)} ${JSON.stringify(t.slice(0, 140))}`)
  } catch (e) {
    console.log(`ERR  ${name.padEnd(22)} ${e.message}`)
  }
}
