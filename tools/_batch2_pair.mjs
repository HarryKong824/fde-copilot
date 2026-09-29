/**
 * 判据 5 的 A/B 组**时间配对**核对（0035 §4.2）。
 *
 * 为什么不用 `seq` 配对（0029 §4 的结论，这里把它落成可执行断言）：
 *   header.seq 是**会话事件序号**（到 73），审计 seq 是**那条链自己的行号**（到 15）
 *   ⇒ 两者是不同命名空间，`header.seq > audit.seq` **恒真、系统性偏绿**
 *   （枚举 238 组：seq 判据放行 232 组，是时间判据的 3.3 倍）。
 *
 * 用法：node _batch2_pair.mjs <sessionId> <headerSeqOfChange> [--narrow-batch]
 *   - <headerSeqOfChange> = 那条 reason:"change" 的 header 的 seq（B 的第二次请求）
 *   - --narrow-batch      = 把「同一毫秒 + 同 phase + 同 decision」的 restrict 视为**同一次 reconcile 批次**，
 *                           不判为"另一个挂点"。⚠️ 这是**更强的主张**（默认关）：
 *                           reconcile 一次会对所有 agent 各写一条，它们在时间上无法分辨；
 *                           把它们排除，等于假设"同一个 reconciler 里的多条不是别的挂点干的"。
 *                           而这份假设**本来该由 `trigger` 字段承担**（本部署代码没写 trigger，见 0035-reply 缺口条）。
 *
 * 断言：
 *   ① 该 header 的 `time`（epoch ms）**晚于** A 组那条 restrict 审计的 `ts`（ISO 8601）
 *      ——防的是「清单先变、挂点后跑」；
 *   ② 按时间排序后，两者之间**没有别的** restrict 审计
 *      ——防的是「另一个挂点替它完成」；
 *   ③ A 组那条 restrict 的 `phase` 与当时阶段一致、且是 `restrict-applied`。
 *
 * ⚠️ 只读：不写 dsh-home 下任何文件，不启停任何东西。
 * 退出码：0 = 全过；1 = 有失败。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PHASE_AUDIT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/phase.jsonl'

const [sid, changeSeqRaw] = process.argv.slice(2)
const narrowBatch = process.argv.includes('--narrow-batch')
const changeSeq = Number(changeSeqRaw)
if (!sid || !Number.isFinite(changeSeq)) {
  console.log('用法: node _batch2_pair.mjs <sessionId> <changeHeaderSeq>')
  process.exit(2)
}

const out = []
let failures = 0
const log = (s) => out.push(s)
function expect(name, ok, extra = '') {
  if (ok) log(`  ✓ ${name}`)
  else {
    failures++
    log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`)
  }
}

// ── 读 phase.jsonl（哈希链，不做重放；重放由 _replay_phase_audit.mjs 负责） ──
const rows = readFileSync(PHASE_AUDIT, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l))
const restricts = rows
  .filter((r) => r.type === 'restrict' && r.agent === sid)
  .map((r) => ({ ...r, epoch: Date.parse(r.ts) }))
  .sort((a, b) => a.epoch - b.epoch)

log(`== A 组观测量（phase.jsonl 里 agent=${sid} 的 restrict 记录）==`)
log(`   共 ${restricts.length} 条`)
for (const r of restricts) log(`   seq=${r.seq} epoch=${r.epoch} ts=${r.ts} phase=${r.phase} decision=${r.decision} denied=${JSON.stringify(r.denied)} skipped=${JSON.stringify(r.skipped)}`)

// ── 从磁盘 transcript 取 header（与 RPC 同源的开磁盘法，见 _cc_transcript_dump.mjs） ──
import { zstdDecompressSync } from 'node:zlib'
import { existsSync } from 'node:fs'

const ROOTS = [
  'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--',
  'C:/Users/DELL/DSH/sessions/--C-Users-DELL--'
]
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
let file = null
for (const root of ROOTS) {
  const p = `${root}/${sid}/session.jsonl.zstd`
  if (existsSync(p)) {
    file = p
    break
  }
}
if (!file) {
  log(`  ✗ 找不到该会话的 transcript（roots 都没命中）`)
  writeFileSync('_batch2_pair_out.txt', out.join('\n') + '\n', 'utf8')
  console.log(out.join('\n'))
  process.exit(1)
}

function readEvents(p) {
  const buf = readFileSync(p)
  const offs = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offs.push(i)
    i++
  }
  const parts = []
  for (const o of offs) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(o)))
    } catch {}
  }
  return Buffer.concat(parts)
    .toString('utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

const headers = readEvents(file)
  .filter((e) => e?.type === 'request/header')
  .map((e) => ({
    seq: e.seq ?? null,
    time: typeof e.time === 'number' ? e.time : Date.parse(e.time),
    reason: e.data?.reason ?? null
  }))
  .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

log('')
log('== B 组观测量（transcript 里的 request/header）==')
log(`   transcript = ${file}`)
for (const h of headers) log(`   seq=${h.seq} time=${JSON.stringify(h.time)} reason=${JSON.stringify(h.reason)}`)

const change = headers.find((h) => h.seq === changeSeq)
log('')
log('== 配对断言 ==')
expect(`找到 seq=${changeSeq} 的 header`, Boolean(change), `实际 seq 列表 ${JSON.stringify(headers.map((h) => h.seq))}`)
expect(`该 header 的 reason === "change"`, change?.reason === 'change', `实际 ${JSON.stringify(change?.reason)}`)

// A 组那条 = 时间轴上离 change header 最近、且不晚于它的 restrict 审计
const before = restricts.filter((r) => change && r.epoch <= change.time)
const mine = before.length ? before[before.length - 1] : null
expect(`A 组有一条不晚于 change header 的 restrict 审计`, Boolean(mine), `restricts=${restricts.length} 条，均晚于 header`)
if (mine) {
  log(`   ⇒ A 组干活的那条：seq=${mine.seq} ts=${mine.ts} (epoch=${mine.epoch})`)
  log(`   ⇒ B 组被观测的那条：seq=${change?.seq} time=${change?.time} (${new Date(change.time).toISOString()})`)
  expect('① change header 的 time **晚于** A 组审计的 ts（清单先变 ⇒ 归因不成立）', mine.epoch < change.time, `audit=${mine.epoch} header=${change.time} 差=${change.time - mine.epoch}ms`)
  expect('③ 该 restrict 是 restrict-applied 且 phase=10', mine.decision === 'restrict-applied' && String(mine.phase) === '10', `decision=${mine.decision} phase=${mine.phase}`)
  // ② 中间没有别的 restrict（不限 agent：另一个挂点若替它写，也会出现在这一段里）
  const allRestricts = rows.filter((r) => r.type === 'restrict').map((r) => ({ seq: r.seq, epoch: Date.parse(r.ts), agent: r.agent, phase: r.phase, decision: r.decision }))
  // 「同一次调用批次」的定义（不引入毫秒阈值这类魔法数）：
  // audit 链里从 mine 起**连续相邻的 type:'restrict' 行** —— reconcile 一次就是这么逐个 agent 写的。
  // ⚠️ 弱点如实写在回执里：两个不同挂点各写一条且恰好相邻，也会被当成同批次 ⇒
  //    这本来该由 `trigger` 字段区分（本部署代码没写 trigger ⇒ 无法分辨，见 0035-reply 缺口条）。
  const idxOf = (seq) => rows.findIndex((r) => r.seq === seq)
  const i0 = idxOf(mine.seq)
  const batchSeqs = new Set()
  for (let k = i0; k < rows.length && rows[k].type === 'restrict'; k++) batchSeqs.add(rows[k].seq)
  const sameBatch = (r) => batchSeqs.has(r.seq)
  const betweenRaw = allRestricts.filter((r) => r.epoch > mine.epoch && r.epoch < change.time)
  const between = narrowBatch ? betweenRaw.filter((r) => !sameBatch(r)) : betweenRaw
  log(`   ℹ️   mine(seq=${mine.seq}) 所属批次 = ${JSON.stringify([...batchSeqs])}（连续相邻 restrict 行）`)
  log(
    `   ℹ️  中间候选 ${betweenRaw.length} 条${narrowBatch ? `，其中同批次 ${betweenRaw.length - between.length} 条被 --narrow-batch 排除` : '（严格口径：一条都不排除）'}`
  )
  if (narrowBatch && betweenRaw.length !== between.length) log(`      被排除：${JSON.stringify(betweenRaw.filter(sameBatch))}`)
  expect(narrowBatch ? '② 两者之间没有**别的批次**的 restrict 审计（--narrow-batch：更强主张）' : '② 两者之间没有别的 restrict 审计（另一个挂点没替它完成）', between.length === 0, JSON.stringify(between))
  // 反向也查一遍：change header 之后到窗口结束前有没有新的 restrict（有则说明归因可能落到后一条）
  const after = allRestricts.filter((r) => r.epoch >= change.time && r.seq !== mine.seq)
  log(`   ℹ️  change header 之后（含同时）的 restrict 审计：${JSON.stringify(after)}（空 = 归因唯一）`)
}

log('')
log(failures === 0 ? 'PAIR OK（0 失败）' : `PAIR FAILED（${failures} 失败）`)
writeFileSync('_batch2_pair_out.txt', out.join('\n') + '\n', 'utf8')
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
