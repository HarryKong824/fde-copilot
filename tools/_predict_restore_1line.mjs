/**
 * 【只读预演】1 行链的恢复行为 —— 给活验第 2 步一个**预期值**。
 *
 * 归档之后，活 `gate.jsonl` 只有 1 行（`seq=1` / `prevHash=GENESIS` / `hash=5d96efc5…`）。
 * DSH 启动时 `AuditChain` 构造会 `#restoreFromTail()` —— 这是**唯一一次**能从活体观察
 * "1 行链的恢复是否正确"的机会（0015 §6 第 2 步）。
 *
 * 本脚本在**临时目录**里复现同一形态，用**真 `AuditChain`** 跑一遍，给出：
 *   - 新实例恢复出的 `#seq` / `#head`
 *   - 再写一条时得到的 `seq` / `prevHash` 是否与起点记录相接
 *
 * 不碰任何活体文件。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { AuditChain } from '../dsh-fde-ontology-gate/lib/audit.js'
import { verifyAuditChainText } from '../dsh-fde-phase/lib/check-d2.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_predict_restore_1line_out.txt')
const lines = []
const say = (s) => lines.push(s)

const dir = mkdtempSync(join(tmpdir(), 'fde-1line-'))
const p = join(dir, 'gate.jsonl')

try {
  // ① 造一条"只有起点记录"的链（与活链同形态：用真实现写）
  writeFileSync(p, '', 'utf8')
  const w = new AuditChain(p)
  const r1 = await w.record({ event: 'chain-rotated', archivedTo: 'x', archivedLines: 79 })
  say('① 起点记录（真 AuditChain 写出）')
  say(`   persisted=${r1.persisted}  seq=${r1.seq}  hash=${String(r1.hash).slice(0, 12)}…`)

  // ② 模拟 DSH 重启：新实例从尾部恢复
  const w2 = new AuditChain(p)
  say('')
  // 注：公开 getter 是 `count`（= #seq）、`head`、`pending`，**没有** `seq` 这个名字。
  say('② 新实例从 1 行链恢复（= DSH 启动时的 #restoreFromTail）')
  say(`   count=${w2.count}  head=${String(w2.head).slice(0, 12)}…  pending=${w2.pending}`)

  // ③ 再写一条，看是否与起点记录相接
  const r2 = await w2.record({ tool: 'probe', decision: 'allow' })
  const text = readFileSync(p, 'utf8')
  const v = verifyAuditChainText(text)
  say('')
  say('③ 恢复之后再写一条（= 启动后第一次落审计）')
  say(`   seq=${r2.seq}  prevHash=${String(JSON.parse(text.split('\n')[1]).prevHash).slice(0, 12)}…`)
  say(`   ⇒ lineCount=${v.lineCount}  passed=${v.passed}  failures=${v.failures.length}`)
  say('')
  say('判读（活验时照这个对）：')
  say('   恢复正确 ⇒ ② 的 count=1、head=起点记录 hash；③ 的 seq=2 且 prevHash == 起点记录 hash；')
  say('   恢复错误 ⇒ ③ 的 seq=1（同号）或 prevHash=GENESIS（同父）⇒ 又是一条假断链，')
  say('   D2 会报 prevHash-mismatch / bad-seq ⇒ 应当立即停，不要启动第二次。')
} catch (e) {
  say(`失败：${e?.stack ?? e}`)
} finally {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(lines.join('\n'))
console.log(`\n[predict] 结果已写入 ${OUT}`)
