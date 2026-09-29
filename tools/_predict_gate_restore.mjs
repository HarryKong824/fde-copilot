// 用改动后的 gate 代码读**活链**（只读，不写）：确认恢复结果与改动前一致。
import { AuditChain } from '../dsh-fde-ontology-gate/lib/audit.js'
import { readFileSync } from 'node:fs'

const OUT = './_predict_gate_restore_out.txt'
const L = []
const p = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/gate.jsonl'

const raw = readFileSync(p, 'utf8')
const ls = raw
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  })
  .filter(Boolean)

const last = ls[ls.length - 1]
const maxSeq = ls.reduce((m, l) => (Number.isInteger(l.seq) && l.seq > m ? l.seq : m), 0)
const lastSeqOk = Number.isInteger(last.seq) && last.seq > 0
const lastHashOk = typeof last.hash === 'string' && /^[0-9a-f]{64}$/.test(last.hash)

const c = new AuditChain(p) // ← 只读构造：只跑 #restoreFromTail

L.push('# 活 gate.jsonl 在改动后代码下的恢复结果（只读预演）')
L.push('')
L.push(`文件：${p}`)
L.push(`解析出记录行数：${ls.length}`)
L.push(`磁盘末行：seq=${last.seq}  hash 合法=${lastHashOk}  seq 为整数且 >0=${lastSeqOk}`)
L.push(`窗口内最大 seq：${maxSeq}`)
L.push('')
L.push(`改动后代码恢复 ⇒ count=${c.count}  head=${c.head}`)
L.push(`是否取到磁盘末行作链头：${c.head === last.hash ? 'YES' : 'NO'}`)
L.push(`count 是否等于窗口内最大 seq：${c.count === maxSeq ? 'YES' : 'NO'}`)
L.push('')
L.push(
  lastHashOk && lastSeqOk
    ? '结论：末行同时具备合法 hash 与整型 seq ⇒ **两遍取的结果与原单遍取完全相同** ⇒ 活体上零行为差异（不需要重启活验）。'
    : '结论：末行不满足旧实现的判据 ⇒ **改动前会被跳过** ⇒ 活体上存在真实差异，需要停机评估。'
)

console.log(L.join('\n'))
try {
  ;(await import('node:fs')).writeFileSync(OUT, L.join('\n') + '\n', 'utf8')
} catch {}
