/**
 * 独立重放活体审计链（只读，绝不写）。
 * 判据 6 复核：0 断链 / 0 缺 seq / 0 重号。
 * 用法：node _audit_replay.mjs
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const P = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/phase.jsonl'
const GENESIS = '0'.repeat(64)

// 逐字复刻 audit.js:33-38
function linkHash(prevHash, record) {
  return createHash('sha256').update(prevHash).update('\n').update(JSON.stringify(record)).digest('hex')
}

const raw = readFileSync(P, 'utf8')
const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '')
const out = []
let head = GENESIS
let breakChain = 0
let seqGap = 0
let dupSeq = 0
const seen = new Set()

lines.forEach((line, i) => {
  const n = i + 1
  let e
  try {
    e = JSON.parse(line)
  } catch (err) {
    out.push(`🔴 第 ${n} 行不是合法 JSON: ${err.message}`)
    breakChain++
    return
  }
  const { prevHash, hash, ...record } = e

  if (prevHash !== head) {
    out.push(`🔴 第 ${n} 行断链: prevHash=${String(prevHash).slice(0, 12)}… 期望=${head.slice(0, 12)}…`)
    breakChain++
  }
  const want = linkHash(prevHash, record)
  if (want !== hash) {
    out.push(`🔴 第 ${n} 行 hash 不符: 实=${String(hash).slice(0, 12)}… 算=${want.slice(0, 12)}…`)
    breakChain++
  }
  if (record.seq !== n) {
    out.push(`🔴 第 ${n} 行 seq 不连续: seq=${record.seq}`)
    if (seen.has(record.seq)) dupSeq++
    else seqGap++
  }
  seen.add(record.seq)
  head = hash
})

out.push('')
out.push(`行数=${lines.length}  断链/坏行=${breakChain}  缺号或错位=${seqGap}  重号=${dupSeq}`)
out.push(`末行 hash=${head.slice(0, 16)}…`)

// 顺带把链条里跟 restrict / 锁 / 阶段有关的行抽出来（只抽字段，不打印 reason 全文）
const interesting = []
lines.forEach((line, i) => {
  const e = JSON.parse(line)
  const tag = e.type ?? e.tool ?? e.decision ?? ''
  const s = JSON.stringify(e)
  if (/restrict|lock|session-|phase/i.test(s)) {
    interesting.push(
      `#${e.seq} ${e.ts ?? ''} type=${e.type ?? '-'} tool=${e.tool ?? '-'} decision=${e.decision ?? '-'} ` +
        `phase=${e.phase ?? '-'} agent=${String(e.agent ?? e.agentId ?? '-').slice(0, 12)} ` +
        `from=${e.from ?? '-'} to=${e.to ?? '-'} names=${JSON.stringify(e.names ?? e.skipped ?? undefined)}`
    )
  }
})
out.push('')
out.push('=== 与 restrict/phase/lock/session 相关的行 ===')
out.push(...interesting)

const txt = out.join('\n') + '\n'
console.log(txt)
