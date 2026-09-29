/** E5 勘察：按 type/decision 分组打印一条样本，看清每个指标的数据源长什么样。 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const DIR = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit'
const WANT = {
  'phase.jsonl': ['phase-advance', 'phase-advance-d4-ask', 'phase-advance-d5pre-ask', 'check-result', 'check-skipped'],
  'phase.jsonl.archived-2026-09-26': ['phase-advance', 'lock', 'check-skipped'],
  'gate.jsonl': null,
  'gate.jsonl.2026-09-26T10-18-10-793Z': null
}
for (const f of readdirSync(DIR)) {
  if (!(f in WANT)) continue
  const recs = readFileSync(join(DIR, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  console.log(`\n########## ${f} ##########`)
  const groups = new Map()
  for (const r of recs) {
    const key = WANT[f] ? String(r.type) : String(r.decision)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  for (const [k, v] of groups) {
    if (WANT[f] && !WANT[f].includes(k)) continue
    const sample = { ...v[0] }
    for (const kk of ['prevHash', 'hash']) if (sample[kk]) sample[kk] = sample[kk].slice(0, 8) + '…'
    console.log(`\n--- ${k} ×${v.length} ---`)
    console.log(JSON.stringify(sample, null, 1))
  }
}
