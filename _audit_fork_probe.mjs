/**
 * 离线验证：审计文件末行若是 check-result（无 seq），
 * 构造时 #restoreFromTail 会跳过它 → 链头落到上一条 →
 * 下一条新记录与那条 check-result 争抢同一个 prevHash（分叉）。
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
const DEPLOY = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/node_modules/dsh-fde-phase/lib'
const { AuditChain } = await import(`file:///${DEPLOY}/audit.js`)

const REAL = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/phase.jsonl'
const TMP = '_audit_fork_tmp.jsonl'
copyFileSync(REAL, TMP)

const lines = readFileSync(TMP, 'utf8').trim().split('\n').map((s) => JSON.parse(s))
const last = lines[lines.length - 1]
const prev = lines[lines.length - 2]

const chain = new AuditChain(TMP)
const r = await chain.record({ type: 'probe', note: 'fork test' })
const newLine = JSON.parse(readFileSync(TMP, 'utf8').trim().split('\n').pop())

const out = []
out.push(`末行(第${lines.length}条)   type=${last.type}  seq=${last.seq ?? '(无)'}  hash=${last.hash.slice(0, 16)}…`)
out.push(`           它的 prevHash  = ${last.prevHash.slice(0, 16)}…`)
out.push(`倒数第二行  type=${prev.type}  seq=${prev.seq}  hash=${prev.hash.slice(0, 16)}…`)
out.push('')
out.push(`新记录 seq=${newLine.seq}  prevHash=${newLine.prevHash.slice(0, 16)}…`)
out.push('')
const forked = newLine.prevHash === last.prevHash
out.push(`新记录 prevHash === 末行 prevHash ? ${forked ? '是 → 🔴 分叉：两条记录指向同一前驱' : '否'}`)
out.push(`新记录 prevHash === 末行 hash     ? ${newLine.prevHash === last.hash ? '是 → 正常接续' : '否 → 没接上末行'}`)
out.push(`新记录 seq=${newLine.seq}，但文件里已有 ${lines.length} 条 → seq 与行号错位`)
writeFileSync('_audit_fork_out.txt', out.join('\n') + '\n', 'utf8')
