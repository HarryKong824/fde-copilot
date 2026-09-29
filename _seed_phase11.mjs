/**
 * 第三批收尾 seed：state.yaml 从 phase "6" 回到业务真实阶段 "11"。
 * 只改 current_phase / revision / updated_at 三行，其余字段一字不动；改前备份。
 * 用法：node _seed_phase11.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'

const P = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory/state.yaml'
const SNAP = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18/_snapshots'
const before = readFileSync(P, 'utf8')

mkdirSync(SNAP, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const bak = `${SNAP}/state.yaml.phase6-rev29.${stamp}`
copyFileSync(P, bak)
console.log(`备份 → ${bak}`)

const after = before
  .replace(/^current_phase:.*$/m, 'current_phase: "11"')
  .replace(/^revision:.*$/m, 'revision: 30')
  .replace(/^updated_at:.*$/m, `updated_at: "${new Date().toISOString()}"`)

const a = before.split(/\r?\n/)
const b = after.split(/\r?\n/)
const diff = []
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) diff.push(`  - ${a[i] ?? '(无)'}\n  + ${b[i] ?? '(无)'}`)
}
console.log(`差异行数: ${diff.length}（应恰好 3）`)
console.log(diff.join('\n'))

writeFileSync(P, after)
console.log('已写入 state.yaml')
