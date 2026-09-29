/**
 * DSH 会话控制器仪器（Claude Code 活验用）。
 *   node _dsh_session_ctl.mjs list                  ← 只读：列会话，确认 id / 状态
 *   node _dsh_session_ctl.mjs send <sessionId> <文本>  ← 发一条消息（触发 preStep ⇒ 工具清单重算）
 *
 * 端点：sessionController / namespace=session / method=list|prompt
 * 依据：@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.js:964（session/prompt）
 *      同 lib/types/types.d.ts:285（SessionPromptRequest）
 * ⚠️ cookie jar 内容绝不打印（只用于构造 Cookie 头）。
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

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

let n = 0
async function rpc(method, args) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(JAR) },
    body: JSON.stringify({ type: 'client-request', rpcId: `r${++n}`, method, payload: { args } })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  let j
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(`回包不是 JSON: ${text.slice(0, 300)}`)
  }
  if (j.result?.ok === false) throw new Error(`${method} 失败: ${JSON.stringify(j.result.error).slice(0, 400)}`)
  return j.result?.value
}

const [cmd, arg1, arg2] = process.argv.slice(2)

if (cmd === 'list') {
  console.log('=== session/list 全部参数组合试探（只读）===')
  for (const args of [{}, { request: {} }, { _request: {} }]) {
    const label = JSON.stringify(args)
    try {
      const v = await rpc('session/list', args)
      const items = v?.sessions ?? v?.entries ?? v?.items ?? (Array.isArray(v) ? v : null)
      console.log(`✅ args=${label} ⇒ 顶层键 ${JSON.stringify(Object.keys(v ?? {}))}`)
      if (items) {
        console.log(`   共 ${items.length} 个会话：`)
        for (const s of items) {
          const id = s.sessionId ?? s.id
          const hit = String(id ?? '').startsWith('b0f5f60e') ? '  ⬅ 目标' : ''
          console.log(`   ${id}  cwd=${s.cwd ?? s.workspacePath ?? '-'}  ${s.title ?? s.name ?? ''}${hit}`)
        }
      } else {
        console.log('   原始值:', JSON.stringify(v).slice(0, 600))
      }
      break
    } catch (e) {
      console.log(`❌ args=${label} ⇒ ${e.message}`)
    }
  }
} else if (cmd === 'send') {
  const sessionId = arg1
  const text = arg2 ?? 'ok'
  if (!sessionId) throw new Error('用法: node _dsh_session_ctl.mjs send <sessionId> <文本>')
  const request = {
    requestId: randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }]
  }
  console.log(`=== 发消息 ===`)
  console.log(`sessionId=${sessionId}`)
  console.log(`文本=${JSON.stringify(text)}  requestId=${request.requestId}`)
  // 参数名在真 SDK 里不统一（request / _request），两个都试
  for (const key of ['request', '_request']) {
    try {
      const v = await rpc('session/prompt', { [key]: request })
      console.log(`✅ 用 args.${key} 发送成功 ⇒ ${JSON.stringify(v)}`)
      process.exit(0)
    } catch (e) {
      console.log(`❌ args.${key} ⇒ ${e.message}`)
    }
  }
  process.exitCode = 1
} else {
  console.log('用法: node _dsh_session_ctl.mjs list | send <sessionId> <文本>')
}
