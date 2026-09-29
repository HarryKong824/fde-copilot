/** E5 勘察：全量 parse 两条真链，统计 record 形状分布（不截断、不用 tail 的观感）。 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit'
for (const f of readdirSync(DIR)) {
  const p = join(DIR, f)
  const raw = readFileSync(p, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim())
  const recs = []
  const bad = []
  for (const l of lines) { try { recs.push(JSON.parse(l)) } catch { bad.push(l.slice(0, 60)) } }
  console.log(`\n=== ${f} ===  行 ${lines.length} / 可解析 ${recs.length} / 坏行 ${bad.length} / ${raw.length} 字节`)
  const byKey = (k) => {
    const m = new Map()
    for (const r of recs) { const v = r[k] === undefined ? '<缺席>' : String(r[k]); m.set(v, (m.get(v) || 0) + 1) }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }
  for (const k of ['decision', 'type']) console.log(`  ${k}: ${JSON.stringify(byKey(k))}`)
  // 所有出现过的字段名 + 出现次数（只列前 30）
  const ks = new Map()
  for (const r of recs) for (const k of Object.keys(r)) ks.set(k, (ks.get(k) || 0) + 1)
  console.log(`  字段 keys: ${[...ks.entries()].sort((a,b)=>b[1]-a[1]).slice(0,30).map(([k,v])=>`${k}(${v})`).join(' ')}`)
}
