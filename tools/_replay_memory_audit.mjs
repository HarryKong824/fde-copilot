/**
 * 0077 §6.2 判据：memory 审计链完整性重放（只读）。
 *
 * 逐行校验 <projectRoot>/memory/audit/events.jsonl：
 *   ① seq 单调递增且**无重号**（1..N，允许从任意起点续接，但必须连续）
 *   ② 每条的 `hash` 必须 == linkHash(prevHash, 去掉 prevHash/hash 后的 record)
 *      ⚠️ 保留 seq —— audit.js record() 计算 hash 时 record 含 seq+ts（键顺序 seq, ts, …），
 *         去掉 prevHash/hash 即可，不能再去 seq，否则 hash 不符
 *   ③ 每条的 `prevHash` 必须 == 上一条的 `hash`（首条的 prevHash 必须是 GENESIS 全零）
 *
 * ⚠️ 0077 §2.3③：绝不能用「session 事件 seq 连续」判完整性 —— 事件 seq 有缺口是常态。
 *    本链用**自己的** prevHash + hash 链判（seq 是 AuditChain 维护的 1..N，非 session 事件 seq）。
 *
 * 用法: node _replay_memory_audit.mjs [路径]
 * 默认: E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory/audit/events.jsonl
 * 输出: _replay_memory_audit_out.txt；exit 0=链完整，1=发现问题。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'

const P =
  process.argv[2] ??
  'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory/audit/events.jsonl'

const GENESIS = '0'.repeat(64)

function linkHash(prevHash, record) {
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(JSON.stringify(record))
    .digest('hex')
}

const L = []
let bad = 0

if (!existsSync(P)) {
  L.push('文件不存在 = ' + P)
  L.push('')
  L.push('RESULT: NO-FILE')
  const out = L.join('\n') + '\n'
  writeFileSync('_replay_memory_audit_out.txt', out, 'utf8')
  console.log(out)
  process.exit(1)
}

const raw = readFileSync(P, 'utf8')
const lines = raw.split('\n').filter((l) => l.trim() !== '')

let prevHash = GENESIS
let expectSeq = null
const seenSeq = new Set()

L.push('文件 = ' + P)
L.push('行数 = ' + lines.length)

lines.forEach((line, idx) => {
  const rowNo = idx + 1
  let row
  try {
    row = JSON.parse(line)
  } catch (e) {
    bad += 1
    L.push('FAIL line ' + rowNo + ' 不是合法 JSON: ' + String(e.message ?? e))
    return
  }
  const seq = row.seq
  if (typeof seq !== 'number' || !Number.isInteger(seq)) {
    bad += 1
    L.push('FAIL line ' + rowNo + ' 缺 seq 或 seq 非整数（会导致重启恢复跳过末行 ⇒ 分叉）')
  } else {
    if (expectSeq === null) expectSeq = seq
    else if (seq !== expectSeq) {
      bad += 1
      L.push('FAIL line ' + rowNo + ' seq 不连续：实际 ' + seq + '，期望 ' + expectSeq)
    }
    if (seenSeq.has(seq)) {
      bad += 1
      L.push('FAIL line ' + rowNo + ' seq 重号：' + seq)
    }
    seenSeq.add(seq)
    expectSeq = seq + 1
  }

  // ⚠️ 保留 seq：去掉 prevHash/hash 即可（键顺序 seq, ts, …，与 record() 计算 hash 时一致）
  const { prevHash: prev, hash, ...record } = row
  if (prev !== prevHash) {
    bad += 1
    L.push('FAIL line ' + rowNo + ' prevHash 断链：记录里 ' + String(prev).slice(0, 12) + ' ≠ 期望 ' + prevHash.slice(0, 12))
  }
  const calc = linkHash(prevHash, record)
  if (calc !== hash) {
    bad += 1
    L.push('FAIL line ' + rowNo + ' hash 不符：算出 ' + calc.slice(0, 12) + ' ≠ 落盘 ' + String(hash).slice(0, 12))
  }
  prevHash = String(hash ?? prevHash)
})

// 事件类型分布（供人工核对「assistant/chunk 已被过滤」）
const kinds = {}
for (const l of lines) {
  try {
    const r = JSON.parse(l)
    const k = r.kind ?? '(无 kind)'
    kinds[k] = (kinds[k] ?? 0) + 1
  } catch {
    // 残行：跳过
  }
}
L.push('')
L.push('kind 分布 = ' + JSON.stringify(kinds))
if (kinds['assistant/chunk'] !== undefined) {
  bad += 1
  L.push('FAIL 落盘出现 assistant/chunk（token 级流式不该采集）')
}

L.push('')
L.push('断链 ' + bad + ' 处')
L.push('RESULT: ' + (bad === 0 ? 'CHAIN-INTACT' : 'CHAIN-BROKEN'))

const out = L.join('\n') + '\n'
writeFileSync('_replay_memory_audit_out.txt', out, 'utf8')
console.log(out)
process.exitCode = bad === 0 ? 0 : 1
