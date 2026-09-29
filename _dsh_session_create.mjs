/**
 * 新建一个 DSH 会话（让它**载入进程**，`running=true`），供活验驱动用。
 *
 * 为什么需要它：`session/prompt` 只对**在进程内**的会话有效，否则报 `session/not-found`。
 * 而会话是懒加载的 —— 桌面端打开某个会话时它才进进程。本脚本用 RPC 直接 create，
 * 省掉"请用户点一下 UI"这一步（用户 2026-09-28 明确要求：能自动化的别烦他）。
 *
 * 端点依据：`@deepseek-ai/dsh-api-remotes/lib/client.js:8156`
 *   method=session/create，parameters[{name:'request', wire:'request'}]
 *   schema（client.js:7466）：{ workspaceId?, cwd?, sessionId?, agentPreset? }
 * 用法：node _dsh_session_create.mjs [cwd] [agentPreset]
 */
import { readFileSync } from 'node:fs'

const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const BASE = 'http://127.0.0.1:3080'

function cookieHeader(path) {
  const raw = readFileSync(path, 'utf8')
  const out = []
  for (let line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const f = line.split('\t')
    if (f.length < 7) continue
    out.push(`${f[5]}=${f[6]}`)
  }
  if (!out.length) throw new Error('cookie jar 里没解析出任何 cookie')
  return out.join('; ')
}

async function rpc(method, args) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(JAR) },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rc1', method, payload: { args } })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  const j = JSON.parse(text)
  if (j.result?.ok === false) throw new Error(`${method} 失败: ${JSON.stringify(j.result.error).slice(0, 500)}`)
  return j.result?.value
}

const cwd = process.argv[2] ?? 'E:\\DSH-workspace'
const agentPreset = process.argv[3] ?? 'standard'
console.log('=== session/create 试探 ===')
for (const key of ['request', '_request']) {
  try {
    const v = await rpc('session/create', { [key]: { cwd, agentPreset } })
    console.log(`✅ args.${key} ⇒ ${JSON.stringify(v)}`)
    console.log(`SESSION_ID=${v?.sessionId ?? ''}`)
    process.exit(0)
  } catch (e) {
    console.log(`❌ args.${key} ⇒ ${e.message}`)
  }
}
console.error('两种参数名都失败')
process.exit(1)
