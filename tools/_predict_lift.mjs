/**
 * 第五批预演：在**活链副本**上跑 phase 11 的 reconcile，预测下次 DSH 启动会落什么。
 *
 * ⚠️ 必须在副本上跑：`new AuditChain()` 会给"末行缺换行"的文件补 `\n` ⇒ 等于写活体。
 * 跑完会校验活链 sha256 未变。
 */
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AuditChain } from '../dsh-fde-phase/lib/audit.js'
import { RestrictGovernor, desiredDeny } from '../dsh-fde-phase/lib/restrict.js'

const CHAIN = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/phase.jsonl'
const OUT = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18/_predict_lift_out.txt'

const L = []
const log = (s) => {
  L.push(s)
  console.log(s)
}
const sha = (b) => createHash('sha256').update(b).digest('hex')

const liveBefore = readFileSync(CHAIN)
log(`活链（跑前）bytes=${liveBefore.length} sha256=${sha(liveBefore)}`)

const tmp = mkdtempSync(join(tmpdir(), 'fde-lift-'))
const copy = join(tmp, 'phase.jsonl')
copyFileSync(CHAIN, copy)

const cfg = {
  projectRoot: 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state',
  protectedPhases: ['4', '6', '10'],
  denyTools: ['pwsh']
}
log(`desiredDeny('11', 方案B) = ${JSON.stringify(desiredDeny('11', cfg))}（应 []）`)

const audit = new AuditChain(copy)
log(`tailTruncated=${audit.tailTruncated}`)
const idx = audit.latestRestrictByAgent()
log(`索引条目 ${idx.size} 个：`)
for (const [id, e] of idx) log(`  ${id.slice(0, 28)}… seq=${e.seq} decision=${e.decision} denied=${JSON.stringify(e.denied)}`)

// 假 agent（只为提供 id 与 ctx.tools.restrict 桩；phase 11 ⇒ 不会真的挂）
function fake(id) {
  return { id, ctx: { tools: { restrict: () => () => {} } } }
}
const agents = [...idx.keys()].map((id) => fake(id))

const g = new RestrictGovernor({ cfg, audit })
g.bind({ agents: { list: () => agents } })
const tally = await g.reconcile('11')
log(`reconcile('11') ⇒ ${JSON.stringify(tally)}`)

const recs = readFileSync(copy, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0)
  .map((l) => JSON.parse(l))
log(`副本链 ${recs.length} 行（活链 ${liveBefore.toString('utf8').split('\n').filter((x) => x.trim()).length} 行）`)
for (const r of recs.filter((r) => r.seq > 43)) {
  log(`  新增 #${r.seq} ${r.decision} agent=${(r.agent ?? '-').slice(0, 20)}… via=${r.via ?? '-'} from=${r.from ?? '-'} denied=${JSON.stringify(r.denied ?? null)}`)
}

// 第二次（模拟再启一次）⇒ 幂等：不该再落
const audit2 = new AuditChain(copy)
const g2 = new RestrictGovernor({ cfg, audit: audit2 })
g2.bind({ agents: { list: () => agents } })
const tally2 = await g2.reconcile('11')
log(`第二次 reconcile('11') ⇒ ${JSON.stringify(tally2)}  ← lifted 应为 0（幂等）`)

const liveAfter = readFileSync(CHAIN)
log(`活链（跑后）bytes=${liveAfter.length} sha256=${sha(liveAfter)}`)
log(`活链零副作用 ⇒ ${sha(liveAfter) === sha(liveBefore) ? 'YES ✅' : '🔴 NO'}`)

writeFileSync(OUT, L.join('\n') + '\n', 'utf8')
