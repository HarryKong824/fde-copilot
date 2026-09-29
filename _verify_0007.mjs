/**
 * 0007 独立复核：
 *  A. 活链现状（Claude 称 10:37:30 重启后零新增 ⇒ 应仍 43 行 / 3fbd9514…a7cd2632）
 *  B. 索引层直证：带限制的 agent 有哪些、最后一条 decision 是什么（§3 静默点的原料）
 *  C. 代码路径核对：want 为空时 sync() 走哪个分支、会不会落任何东西
 */
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditChain } from './dsh-fde-phase/lib/audit.js'
import { desiredDeny } from './dsh-fde-phase/lib/restrict.js'

const CHAIN = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/phase.jsonl'
const OUT = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18/_verify_0007_out.txt'
const L = []
const log = (s) => {
  L.push(s)
  console.log(s)
}
const sha = (b) => createHash('sha256').update(b).digest('hex')

// ---- A. 活链现状 ----
const cb = readFileSync(CHAIN)
const lines = cb.toString('utf8').split('\n').filter((x) => x.trim())
log(`[A] 活链 lines=${lines.length} bytes=${cb.length} sha256=${sha(cb)}`)
log(`[A] 与收尾复核值（43 / 18971 / 3fbd9514…a7cd2632）比较 ⇒ ${lines.length === 43 && cb.length === 18971 && sha(cb).startsWith('3fbd9514') ? '一致 ✅（重启后零新增成立）' : '🔴 有变化'}`)

const recs = lines.map((l) => JSON.parse(l))
const lastTs = recs[recs.length - 1].ts
log(`[A] 末条 ts=${lastTs}（收尾 seed=02:33:59，Claude 称重启=10:37:30）`)
const afterRestart = recs.filter((r) => r.ts > '2026-09-26T02:33:59')
log(`[A] 收尾之后新增记录数 = ${afterRestart.length} ⇒ ${afterRestart.length === 0 ? '零新增 ✅（与 §2.1 一致）' : '🔴 ' + afterRestart.map((r) => `#${r.seq} ${r.decision}`).join(', ')}`)
const lifted = recs.filter((r) => r.decision === 'restrict-lifted')
log(`[A] 全链 lifted 条数 = ${lifted.length}（${lifted.map((r) => '#' + r.seq).join(',')}）`)

// ---- B. 索引层直证（在副本上，避免构造函数补 \n 写活体）----
const tmp = mkdtempSync(join(tmpdir(), 'fde-0007-'))
const copy = join(tmp, 'phase.jsonl')
copyFileSync(CHAIN, copy)
const audit = new AuditChain(copy)
log(`[B] tailTruncated=${audit.tailTruncated}（false ⇒ 窗口覆盖全链，索引完备）`)
const idx = audit.latestRestrictByAgent()
log(`[B] 索引条目数 = ${idx.size}`)
for (const [id, e] of idx) {
  log(`[B]   ${id.slice(0, 20)}… seq=${e.seq} decision=${e.decision} appliedSeq=${e.appliedSeq ?? '-'} denied=${JSON.stringify(e.denied)}`)
}
const carrying = [...idx.entries()].filter(([, e]) => e.decision === 'restrict-applied' || e.decision === 'restrict-restored')
log(`[B] 「链上最后一条 = 带限制」的 agent 数 = ${carrying.length} ⇒ ${carrying.map(([k]) => k.slice(0, 8)).join(', ')}`)

// ---- C. 代码路径 ----
log(`[C] desiredDeny('11', 方案B) = ${JSON.stringify(desiredDeny('11', { protectedPhases: ['4', '6', '10'], denyTools: ['pwsh'] }))}（应 []）`)

writeFileSync(OUT, L.join('\n') + '\n', 'utf8')
