/**
 * C2「调用层」活验 —— 补上 0090 里 C2 行唯一的 ⚠️ 未验项。
 *
 * 要验的：**模型在真进程里实际调一次 `fde_change_close`**（此前只验到"注册层"：
 * 逐名 diff 里它是新增项）。注册层只能证明"工具挂上去了"，证明不了"调下去会走到哪"。
 *
 * 期望（真数据实况，见 `_fde_c2_live_out.txt` 场景 4）：当前 gate 链最新一条 allow 无 `level`
 * ⇒ 判 `CHANGE_NO_LEVEL`，**fail-closed 拒绝**，不改业务状态，只在链上留痕。
 * ⇒ 这是**只读效果**的活验：最坏结果是"被拒绝 + 多一条如实留痕"，不是"业务状态被推进"。
 *
 * ⚠️ 路径**不是猜的**：`fde-state` 下只有 `memory/`、`experiments/`、`SCHEMA_VERSION`；
 *    gate/phase 两条链在 **`<dsh-home>\fde-audit\`**（见 `profiles/web/cordis.patch.yml` 的
 *    `auditPath` / `phaseAuditPath`）。第一版按 `fde-state/phase/...` 猜 ⇒ 三个文件全报"不存在"。
 *
 * 用法：
 *   node _c2_live_drive.mjs baseline   # 取改前基线
 *   node _c2_live_drive.mjs drive      # 真的让模型调一次
 *   node _c2_live_drive.mjs verify     # 与基线对拍
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const HERE = import.meta.dirname
const DSH_HOME = 'E:\\DSH-desktop\\DeepSeek Harness\\data\\dsh-home'
const BASE_FILE = join(HERE, '_c2_pre_baseline.json')
const OUT = join(HERE, '_c2_live_drive_out.txt')

/** 要看的文件：三条链（append-only）＋ 两个业务状态文件（必须零变更）。 */
const CHAINS = [
  ['gate 链', join(DSH_HOME, 'fde-audit', 'gate.jsonl')],
  ['phase 链', join(DSH_HOME, 'fde-audit', 'phase.jsonl')],
  ['memory 链', join(DSH_HOME, 'fde-state', 'memory', 'audit', 'events.jsonl')]
]
const STATES = [
  ['阶段状态 memory/state.yaml', join(DSH_HOME, 'fde-state', 'memory', 'state.yaml')],
  ['break-glass 记录', join(DSH_HOME, 'fde-state', 'memory', 'break-glass.json')]
]

function readRows(p) {
  if (!existsSync(p)) return { exists: false, rows: [], bad: 0, maxSeq: null, sha: null, bytes: 0 }
  const b = readFileSync(p)
  const rows = []
  let bad = 0
  for (const l of b.toString('utf8').split('\n')) {
    if (!l.trim()) continue
    try { rows.push(JSON.parse(l)) } catch { bad++ }
  }
  // ⚠️ 取 maxSeq 必须**全量**求，不能用最后一行 —— 落盘序 ≠ seq 序（今天实测踩过）。
  let maxSeq = null
  for (const r of rows) if (typeof r.seq === 'number' && (maxSeq === null || r.seq > maxSeq)) maxSeq = r.seq
  return { exists: true, rows, bad, maxSeq, sha: createHash('sha256').update(b).digest('hex').slice(0, 16), bytes: b.length }
}
function snapFile(p) {
  if (!existsSync(p)) return { exists: false, sha: null, bytes: 0 }
  const b = readFileSync(p)
  return { exists: true, sha: createHash('sha256').update(b).digest('hex').slice(0, 16), bytes: b.length }
}

const cmd = process.argv[2] ?? 'baseline'

if (cmd === 'baseline') {
  const o = { chains: {}, states: {} }
  for (const [name, p] of CHAINS) o.chains[name] = readRows(p)
  for (const [name, p] of STATES) o.states[name] = snapFile(p)
  writeFileSync(BASE_FILE, JSON.stringify(o), 'utf8')
  for (const [name, p] of CHAINS) { const s = o.chains[name]; console.log(`${name}: exists=${s.exists} 行=${s.rows.length} maxSeq=${s.maxSeq} 坏行=${s.bad}`) }
  for (const [name, p] of STATES) console.log(`${name}: ${JSON.stringify(o.states[name])}`)
  console.log(`\n[c2-live] 基线已落 ${BASE_FILE}`)
} else if (cmd === 'drive') {
  // 如实 reason：**不编业务理由**（占位符纪律见 no-fake-reason-for-audited-state-advance）。
  const prompt =
    '请只做一件事：直接调用 `fde_change_close` 工具一次，参数 `reason` 填这个字符串（原样）：' +
    '活验：验证 C2 变更闭环工具的调用层接线（预期 fail-closed 拒绝，不改业务状态）。' +
    '不要先读文件、不要先解释、不要调用任何其它工具。拿到工具返回后，用一句话原样转述返回的错误信息与错误码。'
  const out = execFileSync('node', [join(HERE, '_live_drive.mjs'), '--new', prompt], {
    cwd: HERE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  })
  appendFileSync(OUT, `\n########## ${new Date().toISOString()} cmd=drive ##########\n${out}\n`, 'utf8')
  console.log(out)
} else if (cmd === 'verify') {
  const before = JSON.parse(readFileSync(BASE_FILE, 'utf8'))
  const log = []
  const say = (s) => { log.push(s); console.log(s) }
  let bad = 0
  const ok = (n, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e)
    say(`${A === E ? 'PASS' : 'FAIL'} ${n}${A === E ? '' : `\n   实际 ${A}\n   期望 ${E}`}`)
    if (A !== E) bad++
  }

  say('── 业务状态：必须**零变更**（这才是"没被推进"的证据）')
  for (const [name, p] of STATES) {
    const b = before.states[name] ?? { exists: false, sha: null }
    const a = snapFile(p)
    if (!b.exists && !a.exists) { say(`--  ${name}: 前后都不存在（无信息量）`); continue }
    ok(`${name} sha 未变`, a.sha, b.sha)
  }

  say('\n── 三条链：报告增量，并扫**新增行**里有没有"成功/放行"类记录')
  for (const [name, p] of CHAINS) {
    const b = before.chains[name] ?? { exists: false, rows: [], maxSeq: null }
    const a = readRows(p)
    if (!a.exists) { say(`--  ${name}: 不存在（无信息量）`); continue }
    const added = b.maxSeq === null ? a.rows : a.rows.filter((r) => typeof r.seq === 'number' && r.seq > b.maxSeq)
    say(`    ${name}: maxSeq ${b.maxSeq} → ${a.maxSeq}，新增 ${added.length} 条（坏行 ${a.bad}）`)
    for (const r of added.slice(0, 8)) {
      // ⚠️ 字段名是 `outcome`（**不是** `code`）—— 第一版凭印象写 `r.code`，于是这条最关键的
      //    判据数据在输出里静默成了空串。凭印象写标识符 = C32 那一类：**不报错、只是错**。
      say(`      seq=${r.seq} type=${r.type ?? r.kind ?? '?'} ${r.decision ? `decision=${r.decision}` : ''} ${r.outcome ? `outcome=${r.outcome}` : ''} ${String(r.reason ?? r.detail ?? '').slice(0, 90)}`)
    }
    // 判据**双向**：必须**不含**放行类；且必须**含**那条"拒得对"的记录。
    const successes = added.filter((r) => r.decision === 'allow' || r.ok === true || r.type === 'change-closed')
    if (added.length) ok(`${name} 新增行里**没有**"放行/闭环成功"类记录（fail-closed 生效）`, successes.length, 0)
    const denied = added.filter((r) => r.type === 'change-close-denied')
    if (denied.length) {
      ok(`${name} 恰好 1 条 change-close-denied（工具确实被拒）`, denied.length, 1)
      ok(`${name} 且拒的理由是 no-level（= 离线期望的 CHANGE_NO_LEVEL，**拒得对**）`, denied[0].outcome, 'no-level')
      ok(`${name} 且带 callId（与真实工具调用挂钩，不是凭空写的）`, typeof denied[0].callId === 'string' && denied[0].callId.length > 0, true)
    }
  }

  say(`\n[c2-live verify] 失败 ${bad}`)
  appendFileSync(OUT, `\n########## ${new Date().toISOString()} cmd=verify ##########\n${log.join('\n')}\n`, 'utf8')
  process.exitCode = bad > 0 ? 1 : 0
} else {
  console.error('用法: baseline | drive | verify')
  process.exit(2)
}
