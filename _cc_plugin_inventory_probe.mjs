/**
 * 独立探针（Claude Code 自写，不用 WorkBuddy 的 _alive.mjs）：
 * 核「判据 1：三个 fde 插件全 fiberPhase==="active"、failed:0」。
 * 只读；cookie jar 内容绝不打印。
 */
const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'

import { readFileSync } from 'node:fs'

function cookieHeader(path) {
  const out = []
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) {
      if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
      else continue
    }
    const c = line.split('\t')
    if (c.length < 7) continue
    out.push(`${c[5]}=${c[6]}`)
  }
  if (out.length === 0) throw new Error('cookie jar 里没解析出任何 cookie')
  return out.join('; ')
}

let n = 0
async function rpc(method, args) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(JAR) },
    body: JSON.stringify({ type: 'client-request', rpcId: `cc${++n}`, method, payload: { args } }),
  })
  const text = await res.text()
  let j
  try { j = JSON.parse(text) } catch { throw new Error(`${method}: 回包不是 JSON → ${text.slice(0, 120)}`) }
  return j
}

// 🔴 2026-09-28 修：payload.args 必须是 **plain object** —— 传 `[]` 会报
//    "exactly one plain-object args field"（记忆 dsh-live-rpc-probe-recipe 里记的正是这个坑，
//    而我这个探针自己犯了）。
const j = await rpc('pluginInventory/list', {})
// 找条目数组（不同版本字段名可能不同 ⇒ 显式列出我试过的键，不猜）
// 🔴 2026-09-28 修：实测数据在 **result.value.entries[]**（不在 result 顶层）。
const cands = ['items', 'plugins', 'entries', 'records', 'list']
let items = null
for (const k of cands) if (Array.isArray(j?.result?.value?.[k])) { items = j.result.value[k]; break }
for (const k of cands) if (!items && Array.isArray(j?.result?.[k])) { items = j.result[k]; break }
if (!items && Array.isArray(j?.result?.result?.items)) items = j.result.result.items
if (!items && Array.isArray(j?.result)) items = j.result

if (!items) {
  console.log('🔴 没找到条目数组。顶层键 =', JSON.stringify(Object.keys(j ?? {})))
  console.log('   result 键 =', JSON.stringify(Object.keys(j?.result ?? {})))
  process.exit(1)
}

console.log(`条目总数 = ${items.length}`)
const nameOf = (p) => p?.moduleName ?? p?.name ?? p?.id ?? p?.pluginId ?? '?'
const phaseOf = (p) => p?.fiberPhase ?? p?.state ?? p?.phase ?? null

const fde = items.filter((p) => String(nameOf(p)).startsWith('dsh-fde-'))
for (const p of fde) console.log(`  ${nameOf(p)}: fiberPhase=${JSON.stringify(phaseOf(p))} enabled=${JSON.stringify(p?.enabled ?? null)} failed=${JSON.stringify(p?.failed ?? null)}`)

const nonActive = items.filter((p) => phaseOf(p) !== 'active' && phaseOf(p) !== undefined && phaseOf(p) !== null)
console.log(`fiberPhase 非 active 的条目：${nonActive.length}`)
for (const p of nonActive.slice(0, 10)) console.log(`   · ${nameOf(p)} → ${JSON.stringify(phaseOf(p))}`)

// 判据：**逐个点名**期望的 fde 插件都 active 且 failed 为 0/缺省。
// 🔴 2026-09-28 修：原判据硬写 `fde.length === 3` —— 用户拍板加入第 4 个插件
//    （dsh-fde-memory）后它会**恒红**（"3 个"是当时的快照，不是规则）⇒ 改成点名名单。
const EXPECT = ['dsh-fde-ontology-gate', 'dsh-fde-dsl', 'dsh-fde-phase', 'dsh-fde-memory']
const byName = new Map(fde.map((p) => [String(nameOf(p)), p]))
const missing = EXPECT.filter((e) => !byName.has(e))
const bad = EXPECT.filter((e) => byName.has(e) && (phaseOf(byName.get(e)) !== 'active' || (typeof byName.get(e)?.failed === 'number' && byName.get(e).failed > 0)))
for (const e of missing) console.log(`🔴 缺席：${e}`)
for (const e of bad) console.log(`🔴 异常：${e} → fiberPhase=${JSON.stringify(phaseOf(byName.get(e)))} failed=${JSON.stringify(byName.get(e)?.failed)}`)
console.log(missing.length === 0 && bad.length === 0 ? `✅ 判据通过（${EXPECT.length} 个 fde 插件全部 active）` : `🔴 判据未通过（缺席 ${missing.length}，异常 ${bad.length}）`)
process.exit(missing.length === 0 && bad.length === 0 ? 0 : 1)
