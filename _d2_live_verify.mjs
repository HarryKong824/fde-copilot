/**
 * ③ 活验的**核账**：advance 之后，直接读磁盘真相（不信模型的自述）。
 * 只读。判据三条：
 *   ① state.yaml：current_phase 4→5 且 revision 48→49
 *   ② gate 链指纹**必须仍是** {len:15, sha256:53c06d23…}（全程没被动过）
 *   ③ phase.jsonl 新增了本轮记录（含 D2/D3 的 check-result 与那条 advance）
 */
import { readFileSync, statSync } from 'node:fs'
import { readStateSync } from './dsh-fde-phase/lib/state.js'
import { auditChainFingerprintSync } from './dsh-fde-phase/lib/check-d2.js'

const D = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/'
const ST = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory/state.yaml'

console.log('=== ① state.yaml ===')
console.log(readFileSync(ST, 'utf8').trim())
const st = readStateSync(ST)
console.log(
  `⇒ current_phase=${JSON.stringify(st.current_phase)}（期望 "5"）  revision=${st.revision}（期望 49）`
)

console.log('\n=== ② gate 链指纹（期望 {"len":15,"sha256":"53c06d23…"}）===')
console.log(JSON.stringify(auditChainFingerprintSync(D + 'gate.jsonl')))

console.log('\n=== ③ phase.jsonl 本轮尾部 ===')
const rows = readFileSync(D + 'phase.jsonl', 'utf8')
  .split('\n')
  .filter((l) => l.trim())
console.log('总行数 =', rows.length, ' 字节 =', statSync(D + 'phase.jsonl').size)
for (const l of rows.slice(-6)) {
  let r
  try {
    r = JSON.parse(l)
  } catch {
    console.log('  (坏行) ' + l.slice(0, 120))
    continue
  }
  console.log(
    `  #${r.seq} type=${r.type} check=${r.check ?? '-'} passed=${r.passed ?? '-'} decision=${r.decision ?? '-'} ` +
      `from=${r.from ?? '-'} to=${r.to ?? '-'} reason=${String(r.reason ?? '').slice(0, 46)}`
  )
}
