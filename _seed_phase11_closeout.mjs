/**
 * 第四批收尾 seed：state.yaml 从验证窗口的 phase "6" / rev31 回到业务真实阶段 "11" / rev32。
 * 只改 current_phase / revision / updated_at 三行，其余字段一字不动；改前备份 + 写后回读校验。
 * 用法：node _seed_phase11_closeout.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const P = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory/state.yaml'
const DIR = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory'
const SNAP = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18/_snapshots'
const OUT = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18/_seed_phase11_closeout_out.txt'

const lines = []
const log = (s) => {
  lines.push(s)
  console.log(s)
}

// ---- 0. 前置：目录下不得有锁文件（DSH 运行时持有单写者锁）----
const { readdirSync } = await import('node:fs')
const dirEntries = readdirSync(DIR)
const locks = dirEntries.filter((n) => /\.lock$/i.test(n) || n === 'state.yaml.lock')
log(`目录下条目: ${JSON.stringify(dirEntries)}`)
log(`锁文件: ${locks.length === 0 ? '无 ✅（DSH 已关，安全可写）' : `🔴 ${locks.join(',')} ⇒ 中止`}`)
if (locks.length > 0) {
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
  process.exit(2)
}

const before = readFileSync(P, 'utf8')
const sha = (s) => createHash('sha256').update(s).digest('hex')
log(`改前 bytes=${Buffer.byteLength(before)} sha256=${sha(before)}`)

// ---- 1. 备份 ----
mkdirSync(SNAP, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const bak = `${SNAP}/state.yaml.phase6-rev31.${stamp}`
copyFileSync(P, bak)
log(`备份 → ${bak}`)

// ---- 2. 只改三行 ----
const now = new Date().toISOString()
const after = before
  .replace(/^current_phase:.*$/m, 'current_phase: "11"')
  .replace(/^revision:.*$/m, 'revision: 32')
  .replace(/^updated_at:.*$/m, `updated_at: "${now}"`)

const a = before.split(/\r?\n/)
const b = after.split(/\r?\n/)
const diff = []
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) diff.push(`  L${i + 1} - ${a[i] ?? '(无)'}\n       + ${b[i] ?? '(无)'}`)
}
log(`差异行数: ${diff.length}（应恰好 3）`)
log(diff.join('\n'))
log(`行数: ${a.length} → ${b.length}`)

// ---- 3. 写入 ----
writeFileSync(P, after, 'utf8')
log('已写入 state.yaml')

// ---- 4. 写后回读校验（不只在内存里拼字符串）----
const reread = readFileSync(P, 'utf8')
log(`改后 bytes=${Buffer.byteLength(reread)} sha256=${sha(reread)}`)
log(`写后回读一致: ${reread === after ? 'YES ✅' : '🔴 NO'}`)
log('--- state.yaml（磁盘实际内容）---')
log(reread)

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
