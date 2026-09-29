/**
 * 最小存活性 + 插件装载检查（node fetch + 自解析 cookie jar，不经 curl）。
 * 用法：node _alive.mjs
 * 注意：cookie jar 内容**绝不打印**（只用于构造 Cookie 头）。
 */
import { readFileSync } from 'node:fs'

const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const BASE = 'http://127.0.0.1:3080'

/** Netscape cookie jar → Cookie 头。⚠️ `#HttpOnly_` 行是**正常 cookie**，剥前缀但必须保留。 */
function cookieHeader(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`cookie jar 读不到: ${path} (${e.message})`)
  }
  const out = []
  for (let line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const f = line.split('\t')
    if (f.length < 7) continue
    out.push(`${f[5]}=${f[6]}`)
  }
  if (out.length === 0) throw new Error('cookie jar 里没解析出任何 cookie')
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
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  let j
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(`回包不是 JSON（可能没通过鉴权）: ${text.slice(0, 200)}`)
  }
  if (j.result?.ok === false) throw new Error(`${method} 失败: ${JSON.stringify(j.result.error).slice(0, 300)}`)
  return j.result?.value
}

console.log('=== 存活性 ===')
const inv = await rpc('pluginInventory/list', {})
const items = inv?.entries ?? []
console.log(`pluginInventory/list 通了，条目 ${items.length} 个`)

console.log('=== fde 系插件装载状态 ===')
for (const it of items) {
  const name = it.moduleName ?? it.entryId ?? '(无名)'
  if (!/fde|dsh-tools/.test(String(name))) continue
  console.log(`  ${name}: fiberPhase=${JSON.stringify(it.fiberPhase)} enabled=${JSON.stringify(it.enabled)}`)
}
const bad = items.filter((it) => it.fiberPhase === 'failed' || it.fiberPhase === 'error')
console.log(`fiberPhase 非 active 的条目：${bad.length}`)
if (bad.length) console.log(JSON.stringify(bad.map((b) => [b.moduleName, b.fiberPhase])))
