/**
 * 只读探针：pluginInventory/list ⇒ 四个 FDE 插件的 fiberPhase / failed / enabled。
 *
 *   node _dsh_plugin_inventory.mjs
 *
 * 用途（2026-09-29）：验「三插件改 `import { HarnessError } from '@deepseek-ai/dsh-llm'`
 * 后，真 DSH 进程能否解析该模块」。判据：插件仍在且 fiberPhase=active —— 若具名 import
 * 解析失败，插件会 failed（模块加载期抛错，工具不会注册）。
 *
 * ⚠️ 只读，无副作用。cookie jar 内容绝不打印。
 * 依据：@deepseek-ai/dsh-api-remotes/lib/client.js（endpoint 清单）；
 *       记忆 dsh-live-rpc-probe-recipe（args:{} ⇒ result.value.entries[]）。
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

const WANT = ['dsh-fde-ontology-gate', 'dsh-fde-dsl', 'dsh-fde-phase', 'dsh-fde-memory']

let v = null
let usedArgs = null
for (const args of [{}, { request: {} }, { _request: {} }]) {
  try {
    v = await rpc('pluginInventory/list', args)
    usedArgs = args
    break
  } catch (e) {
    console.log(`❌ args=${JSON.stringify(args)} ⇒ ${e.message}`)
  }
}
if (!v) throw new Error('三种参数形态都没打通 pluginInventory/list')

const entries = v?.entries ?? v?.plugins ?? (Array.isArray(v) ? v : null)
if (!entries) {
  console.log('原始值（无 entries 键）:', JSON.stringify(v).slice(0, 800))
  process.exit(1)
}

console.log(`args=${JSON.stringify(usedArgs)}  共 ${entries.length} 个插件`)
console.log('')
const found = new Set()
for (const e of entries) {
  const name = e.moduleName ?? e.name ?? e.id
  if (!WANT.includes(name)) continue
  found.add(name)
  console.log(
    `${name.padEnd(26)} fiberPhase=${String(e.fiberPhase ?? e.phase ?? '-').padEnd(10)} ` +
      `failed=${e.failed ?? e.failedCount ?? '-'}  enabled=${e.enabled}`
  )
}
console.log('')
const missing = WANT.filter((x) => !found.has(x))
console.log(missing.length ? `⚠️ 缺席：${missing.join(', ')}` : '四个 FDE 插件全部在清单里')
process.exitCode = missing.length ? 1 : 0
