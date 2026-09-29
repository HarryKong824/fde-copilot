import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
const P = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory/state.yaml'
const before = readFileSync(P, 'utf8')
mkdirSync('_snapshots', { recursive: true })
writeFileSync('_snapshots/state.yaml.phase11-rev28.bak', before, 'utf8')

const now = new Date().toISOString()
const KEYS = ['current_phase', 'revision', 'updated_at']
const VALS = { current_phase: '"6"', revision: '29', updated_at: `"${now}"` }

const lines = before.split(/\r?\n/)
const out = []
const seen = {}
for (const line of lines) {
  const m = line.match(/^(\s*)([A-Za-z_]+)\s*:(.*)$/)
  if (m && KEYS.includes(m[2])) {
    out.push(`${m[1]}${m[2]}: ${VALS[m[2]]}`)
    seen[m[2]] = true
  } else {
    out.push(line)
  }
}
const missing = KEYS.filter((k) => !seen[k])
if (missing.length) throw new Error('以下键在原文件里没找到，拒绝 blind-write: ' + missing.join(','))
const after = out.join('\n')
writeFileSync(P, after, 'utf8')

const L = []
L.push('=== seed 前 ===')
L.push(before.trimEnd())
L.push('')
L.push('=== seed 后 ===')
L.push(after.trimEnd())
L.push('')
L.push('=== 差异行（应为恰好 3 行） ===')
const b = before.split(/\r?\n/), a = after.split(/\r?\n/)
b.forEach((l, i) => { if (l !== a[i]) L.push(`  - ${l}\n  + ${a[i]}`) })
L.push(`行数 前=${b.length} 后=${a.length}`)
L.push(`备份: _snapshots/state.yaml.phase11-rev28.bak`)
console.log(L.join('\n'))
