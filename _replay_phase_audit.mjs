/**
 * 判据 6：审计链完整性重放（只读）。
 *
 * 逐行校验 `phase.jsonl`：
 *   ① seq 单调递增且**无重号**（1..N，允许从任意起点续接，但必须连续）
 *   ② 每条的 `hash` 必须 == linkHash(prevHash, 去掉 prevHash/hash 后的 record)
 *   ③ 每条的 `prevHash` 必须 == 上一条的 `hash`（首条的 prevHash 必须是 GENESIS 全零）
 *   ④ type:'restrict' 的记录齐全（decision 序列可查）
 *
 * 用法: node _replay_phase_audit.mjs [路径]
 * 输出: _replay_phase_audit_out.txt；exit 0=链完整，1=发现问题。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const P =
  process.argv[2] ??
  'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/phase.jsonl'

const GENESIS = '0'.repeat(64)

function linkHash(prevHash, record) {
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(JSON.stringify(record))
    .digest('hex')
}

const raw = readFileSync(P, 'utf8')
const lines = raw.split('\n').filter((l) => l.trim() !== '')

const L = []
let bad = 0
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

// restrict 记录明细
// 0055 修补 ①：坏 JSON 行 ⇒ 返回 null 跳过（不阻断报告）；与 :42-51 的容错同型
const restrictRows = lines
  .map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter((r) => r && r.type === 'restrict')
L.push('')
L.push('type:restrict 记录 = ' + restrictRows.length + ' 条')

// 0053 §2 改动 ① + 0055 修补 ② + 0057 §1 收紧：trigger 分布由仪器产出，且加交叉验证
//   A = 所有行里带 trigger 的条数（来源 1：遍历 `all`，含非 restrict 行）
//   B = type:restrict 行里带 trigger 的条数（来源 2：用 `:85-87` 已构造的 `restrictRows`）
//   ⚠️ 0057 §1：B 不再从 `all` 里 filter，改用 `restrictRows` —— 两条构造路径独立
//   （若 restrictRows 的 type 过滤出问题，B 会偏而 A 不会 ⇒ 交叉验证才有意义）。
//   trigger 按设计只应出现在 restrict 行 ⇒ A == B；A > B 说明非 restrict 行也带 trigger（异常写链路径）。
//   （0055 §3 C30：原来的 "合计 == 行数 − 无字段条数" 是恒真式，不是检查器）
{
  const all = lines.map((l) => { try { return JSON.parse(l) } catch { return null } })
  const trig = {}
  let withTrigger = 0
  for (const r of all) {
    if (!r) continue
    if (r.trigger !== undefined && r.trigger !== null) {
      trig[r.trigger] = (trig[r.trigger] ?? 0) + 1
      withTrigger += 1
    }
  }
  const restrictWithTrigger = restrictRows.filter((r) => r.trigger != null).length
  const triggerCrossOk = withTrigger === restrictWithTrigger
  L.push('trigger 分布 = ' + JSON.stringify(trig) + '   合计 ' + withTrigger + ' 条')
  L.push(
    'trigger 交叉验证：所有行带 trigger ' + withTrigger + ' == restrict 行带 trigger ' + restrictWithTrigger +
    '（' + (triggerCrossOk ? 'PASS' : 'FAIL') + '）'
  )
  if (!triggerCrossOk) bad += 1
}
for (const r of restrictRows) {
  L.push(
    '  #' + r.seq + ' ' + String(r.decision).padEnd(22) +
      ' phase=' + String(r.phase) +
      ' denied=' + JSON.stringify(r.denied ?? []) +
      ' skipped=' + JSON.stringify(r.skipped ?? []) +
      ' agent=' + String(r.agent ?? '').slice(0, 22)
  )
}

L.push('')
L.push('断链 ' + bad + ' 处')
L.push('RESULT: ' + (bad === 0 ? 'CHAIN-INTACT' : 'CHAIN-BROKEN'))

const out = L.join('\n') + '\n'
writeFileSync('_replay_phase_audit_out.txt', out, 'utf8')
console.log(out)
process.exitCode = bad === 0 ? 0 : 1
