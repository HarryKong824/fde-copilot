/**
 * 只读预演：把**活链拷贝到临时文件**后，用新代码模拟「phase 6 下打开 `b0f5f60e`」会落什么 decision。
 *
 * 🔴 刻意不直接在活链文件上构造 `AuditChain` —— 构造函数会为"末行缺换行"补一个 `\n`，
 * 那是**写活体文件**。预演必须零副作用，所以一律先拷贝。
 *
 * 用法：node _predict_restored.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RestrictGovernor } from './dsh-fde-phase/lib/restrict.js'
import { AuditChain } from './dsh-fde-phase/lib/audit.js'
import { serializeState } from './dsh-fde-phase/lib/state.js'

const LIVE = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/phase.jsonl'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '_predict_restored_out.txt')
const lines = []

const tmp = mkdtempSync(join(tmpdir(), 'fde-predict-'))
const chainCopy = join(tmp, 'phase.jsonl')
copyFileSync(LIVE, chainCopy)

const audit = new AuditChain(chainCopy)
lines.push(`活链副本：${readFileSync(chainCopy, 'utf8').split('\n').filter((l) => l.trim()).length} 行`)
lines.push(`tailTruncated = ${audit.tailTruncated}（false ⇒ 窗口覆盖全链，索引可信）`)
lines.push('索引（含 appliedSeq = 最后一条 applied 的 seq，0005 §1.3）：')
for (const [id, e] of audit.latestRestrictByAgent()) {
  lines.push(
    `  ${id} → seq=${e.seq} decision=${e.decision} appliedSeq=${e.appliedSeq ?? 'null'} denied=${JSON.stringify(e.denied)}`
  )
}

// phase 6 的临时 projectRoot
const root = join(tmp, 'proj')
mkdirSync(join(root, 'memory'), { recursive: true })
writeFileSync(
  join(root, 'memory', 'state.yaml'),
  serializeState({
    schema_version: 1,
    current_phase: '6',
    phase_status: 'in_progress',
    ontology_version: 1,
    revision: 99,
    updated_at: new Date().toISOString()
  }),
  'utf8'
)

const g = new RestrictGovernor({
  cfg: { projectRoot: root, protectedPhases: ['4', '6', '10'], denyTools: ['pwsh'] },
  audit
})

const agent = {
  id: 'session-b0f5f60e-d406-497b-a584-c4ff4b67d400',
  get ctx() {
    return {
      tools: {
        restrict() {
          return () => {}
        }
      }
    }
  }
}
g.bind({ agents: { list: () => [agent] } })
const tally = await g.reconcile('6')
lines.push('')
lines.push(`reconcile 结果：${JSON.stringify(tally)}`)

// —— 第二次重启（同一个 agent）：验证 from **不链式**（守门人：仍指最初那条 applied）——
const audit2 = new AuditChain(chainCopy)
const g2 = new RestrictGovernor({
  cfg: { projectRoot: root, protectedPhases: ['4', '6', '10'], denyTools: ['pwsh'] },
  audit: audit2
})
g2.bind({ agents: { list: () => [agent] } })
await g2.reconcile('6')

const recs = readFileSync(chainCopy, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0)
  .map((l) => JSON.parse(l))
for (const r of recs.filter((r) => r.seq > 36)) {
  lines.push(
    `  新增 #${r.seq} ${r.decision} agent=${r.agent ?? '-'} from=${r.from === undefined ? '-' : r.from} denied=${JSON.stringify(r.denied ?? null)}`
  )
}
const restored = recs.filter((r) => r.decision === 'restrict-restored')
lines.push('')
lines.push(
  restored.length === 2 && restored[0].from === restored[1].from
    ? `✅ 不链式：两次重启的 restored 都 from=${restored[0].from}（指向同一条 applied）`
    : `❌ 链式或异常：${restored.map((r) => `#${r.seq} from=${r.from}`).join(' / ')}`
)

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(`[predict] 已写入 ${OUT}`)
console.log(lines.join('\n'))
