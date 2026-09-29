/**
 * 第四批活体验证窗口 seed：state.yaml 从业务真实阶段 "11" 回到受保护阶段 "6"。
 *
 * 🔴 纪律：只改 current_phase / revision / updated_at 三行，其余字段一字不动；改前备份 + 前后 sha256。
 * 前置：DSH 必须已关闭（目录下不得有锁文件 / 写者）。
 *
 * 用法：node _seed_phase6_window.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const P = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory/state.yaml'
const SNAP = join(HERE, '_snapshots')
const OUT = join(HERE, '_seed_phase6_window_out.txt')

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const before = readFileSync(P, 'utf8')
const beforeSha = sha(before)

mkdirSync(SNAP, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const bak = join(SNAP, `state.yaml.phase11-rev30.${stamp}`)
copyFileSync(P, bak)

const now = new Date().toISOString()
const KEYS = ['current_phase', 'revision', 'updated_at']
const VALS = { current_phase: '"6"', revision: '31', updated_at: `"${now}"` }

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
const afterSha = sha(Buffer.from(after, 'utf8'))
writeFileSync(P, after, 'utf8')

// —— 写后回读校验（不能只信内存里的字符串）——
const verify = readFileSync(P, 'utf8')
const L = []
L.push(`备份 → ${bak}`)
L.push(`sha256  前 = ${beforeSha}（${Buffer.byteLength(before)}B）`)
L.push(`sha256  后 = ${afterSha}（${Buffer.byteLength(after)}B）`)
L.push(`回读一致 = ${sha(verify) === afterSha ? 'YES' : 'NO ❌'}`)
L.push('')
L.push('=== seed 前 ===')
L.push(before.trimEnd())
L.push('=== seed 后 ===')
L.push(verify.trimEnd())
L.push('')
L.push('=== 差异行（必须恰好 3 行） ===')
const a = before.split(/\r?\n/)
const b = verify.split(/\r?\n/)
let n = 0
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) {
    n += 1
    L.push(`  - ${a[i] ?? '(无)'}`)
    L.push(`  + ${b[i] ?? '(无)'}`)
  }
}
L.push(`差异行数 = ${n} ${n === 3 ? '✅' : '❌ 不是 3 ⇒ 多改了字段'}`)
L.push(`行数 前=${a.length} 后=${b.length}`)

writeFileSync(OUT, L.join('\n') + '\n', 'utf8')
console.log(L.join('\n'))
