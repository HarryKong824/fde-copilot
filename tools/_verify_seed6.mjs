/**
 * seed 后校验：用**部署同款**的 `readStateStrictSync` 读活体 state.yaml，
 * 并按方案 B 配置算出 phase 6 的期望名单（确认"受保护"这个判定真的成立）。
 * 附：活链基线复核（行数 / sha256 应仍是 36 行 / 29be539b…355d0 —— seed 不该碰审计链）。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { readStateStrictSync } from '../dsh-fde-phase/lib/state.js'
import { desiredDeny } from '../dsh-fde-phase/lib/restrict.js'

const P = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory/state.yaml'
const LIVE = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/phase.jsonl'

const s = readStateStrictSync(P)
console.log('严格读 ⇒', JSON.stringify(s))
console.log(
  'desiredDeny(方案B) ⇒',
  JSON.stringify(desiredDeny(s?.current_phase, { protectedPhases: ['4', '6', '10'], denyTools: ['pwsh'] }))
)

const b = readFileSync(LIVE)
const lines = b.toString('utf8').split('\n').filter((x) => x.trim()).length
console.log(`活链 ⇒ lines=${lines} bytes=${b.length} sha256=${createHash('sha256').update(b).digest('hex')}`)
