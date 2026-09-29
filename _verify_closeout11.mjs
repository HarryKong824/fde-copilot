/**
 * 第四批收尾校验：用**部署代码**（不是我手写的解析）读 state.yaml，
 * 确认 phase 11 不在受保护名单 ⇒ 期望 deny 为空；并复核活链基线未被动过。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readStateStrictSync } from './dsh-fde-phase/lib/state.js'
import { desiredDeny } from './dsh-fde-phase/lib/restrict.js'

const P = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory/state.yaml'
const CHAIN = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/phase.jsonl'
const OUT = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18/_verify_closeout11_out.txt'

const L = []
const log = (s) => {
  L.push(s)
  console.log(s)
}
const sha = (b) => createHash('sha256').update(b).digest('hex')

const s = readStateStrictSync(P)
log(`readStateStrictSync ⇒ ${JSON.stringify(s)}`)
log(`current_phase === '11' ⇒ ${s?.current_phase === '11' ? 'YES ✅' : '🔴 NO'}`)

// 方案 B 就是部署默认值（config DEFAULTS），这里显式写出以免隐式依赖
const cfgB = { protectedPhases: ['4', '6', '10'], denyTools: ['pwsh'] }
const want = desiredDeny(s.current_phase, cfgB)
log(`desiredDeny(phase=${s.current_phase}, 方案B) ⇒ ${JSON.stringify(want)}`)
log(`期望名单为空（11 非受保护）⇒ ${want.length === 0 ? 'YES ✅' : '🔴 NO：' + JSON.stringify(want)}`)

// 对照：窗口内 phase 6 时应当非空（证明判定逻辑本身没坏，只是阶段变了）
log(`对照 desiredDeny(phase='6', 方案B) ⇒ ${JSON.stringify(desiredDeny('6', cfgB))}（应为 ["pwsh"]）`)

const raw = readFileSync(P, 'utf8')
log(`state.yaml bytes=${Buffer.byteLength(raw)} sha256=${sha(raw)}`)

const cb = readFileSync(CHAIN)
const lines = cb.toString('utf8').split('\n').filter((x) => x.trim())
log(`活链 lines=${lines.length} bytes=${cb.length} sha256=${sha(cb)}`)
log(`活链基线（第四批复核值 43 / 18971 / 3fbd9514…a7cd2632）⇒ ${lines.length === 43 && cb.length === 18971 ? '未变 ✅' : '🔴 有变化'}`)

const recs = lines.map((l) => JSON.parse(l))
const last = recs[recs.length - 1]
log(`末条 #${last.seq} ${last.decision} agent=${last.agent ?? '-'} from=${last.from ?? '-'} ts=${last.ts}`)
const restrictCount = recs.filter((r) => r.type === 'restrict').length
log(`restrict 类决策条数 = ${restrictCount}`)
const kinds = {}
for (const r of recs.filter((r) => r.type === 'restrict')) kinds[r.decision] = (kinds[r.decision] ?? 0) + 1
log(`按 decision 分布 ⇒ ${JSON.stringify(kinds)}`)

writeFileSync(OUT, L.join('\n') + '\n', 'utf8')
