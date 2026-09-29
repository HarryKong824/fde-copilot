/**
 * E4 影子模式（spec §12/§14）—— **真 SDK + 真数据**活验。
 * import **已安装副本**的 lib，好让它内部的 `@deepseek-ai/dsh-tools` 解析到真 SDK。
 *
 * 跑法：node _fde_e4_live.mjs   ｜ 报告：_fde_e4_live_out.txt
 *
 * ## 这一层验的是什么 / 不验什么（不许混）
 *
 * ✅ 验：① 真 `defineTool` 的严格 schema 校验**真的在跑**（含负向对照，见场景 2b）；
 *        ② 真 `HarnessError` 的 `code` 真的挂在错误对象上（桩环境证不了）；
 *        ③ 真审计链上的只读统计（实况打印）；
 *        ④ 真数据上走"拒绝"路径 —— 且**一个窗都不弹**、真链**一字未改**；
 *        ⑤ 临时链上走完整"批准"路径（含闸门 3 重读磁盘）；
 *        ⑥ 逃生方向 `to:'observe'` 无条件放行。
 * ❌ 不验：插件在 **DSH 进程内**注册成功（要重启后看 `pluginInventory/list` 的 fiberPhase）。
 *        —— 这是第四层之上的第五层，**没做**，README 里如实写。
 *
 * ## 🔴 零污染（硬约束 + 前后快照自证）
 *
 * - 场景 3 读**真链**，但写一律落在**临时链**（`cfg.auditPath` 与 `audit` 刻意分开）
 *   ⇒ 真链只读；收尾用快照**证明**一字未改。
 * - 场景 4/5 全程在 `mkdtempSync` 的临时目录，收尾整棵删除。
 * - ⚠️ 真链当前是 `mode: enforce` 在生效 —— 本脚本**不改任何配置**、不产施工单。
 */

import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '_fde_e4_live_out.txt')
const DEP = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/node_modules/dsh-fde-ontology-gate'
const SDKMOD = 'E:/DSH-desktop/DeepSeek Harness/data/node_modules/@deepseek-ai'
const lib = (f) => pathToFileURL(join(DEP, 'lib', f)).href

const { installShadowTools, SHADOW_STATUS, SHADOW_SWITCH } = await import(lib('shadow-tools.js'))
const {
  computeShadowStatsFromChain,
  enforceAttestation,
  readChainRecordsSync,
  listArchivedSegmentsSync,
  formatShadowStats,
  MODE_SWITCH
} = await import(lib('shadow-stats.js'))
const { AuditChain } = await import(lib('audit.js'))
// 真 SDK：工具抛的就是这个 HarnessError；`defineTool` 的负向对照也用它
const { HarnessError } = await import(pathToFileURL(join(SDKMOD, 'dsh-llm', 'lib', 'index.js')).href)
const { defineTool } = await import(pathToFileURL(join(SDKMOD, 'dsh-tools', 'lib', 'index.js')).href)

/** 真环境的链（`cordis.patch.yml` 的 auditPath，见本文件头注：只读）。 */
const REAL_CHAIN = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/gate.jsonl'

// ⚠️ 输出顺序 = **登记序**（不是完成序）：异步用例各自往自己的槽位写，收尾统一渲染。
const records = []
let passed = 0
let failed = 0
const pending = []

function section(t) {
  records.push({ header: t })
}
function info(t) {
  records.push({ info: t })
}
/**
 * 登记一条用例。⚠️ **注册即启动**（下面的 IIFE 立刻开跑）—— 所以用例之间是**并发**的。
 * 若后一条要读前一条写下的东西，必须 `await` 前一条返回的 promise（见场景 3/4/5）。
 * 第一版没 await，实测症状：读发生在写之前 ⇒ `.records` 是 undefined（TypeError）、
 * 或计数器还是 0 ⇒ **"弹窗次数=0"这条一度是假通过**（读的时候本来就没弹）。
 */
function check(name, fn) {
  const i = records.push({ name, ok: null, err: null, notes: [] }) - 1
  const note = (s) => records[i].notes.push(s)
  const p = (async () => {
    try {
      await fn(note)
      records[i].ok = true
      passed += 1
    } catch (e) {
      records[i].ok = false
      records[i].err = e && e.message ? e.message : String(e)
      failed += 1
    }
  })()
  pending.push(p)
  return p
}
function assert(c, m) {
  if (!c) throw new Error(m || '断言失败')
}
function assertEq(a, e, m) {
  const x = JSON.stringify(a)
  const y = JSON.stringify(e)
  if (x !== y) throw new Error(`${m || '不相等'}：期望 ${y}，实际 ${x}`)
}

/** 真链快照：字节数 + SHA-256（比 size:mtime 更强 —— mtime 可被伪造/回避）。 */
function chainStamp(p) {
  if (!existsSync(p)) return '(不存在)'
  const b = readFileSync(p)
  return `${b.length}B sha256=${createHash('sha256').update(b).digest('hex').slice(0, 16)}`
}

/** 桩 ctx：`asked` 记录**弹了几次窗**（闸门顺序的核心证据）。 */
function makeCtx(outcomes) {
  const tools = {}
  const asked = []
  return {
    tools,
    asked,
    ctx: {
      tools: { register: (def) => ((tools[def.name] = def), () => {}) },
      approval: {
        async ask(exec, reason) {
          asked.push(reason)
          if (Array.isArray(outcomes)) return outcomes.length ? outcomes.shift() : 'unavailable'
          return outcomes
        }
      },
      logger: { info: () => {}, warn: () => {} }
    }
  }
}

const DAY = 86400000
const T0 = Date.UTC(2026, 7, 1) // 2026-08-01

/**
 * 造一条"达标"链：7 条 shadow-deny 跨 **8 天**、全部被逐条确认、准确率 6/7 ≈ 85.7%。
 * @param {string} p 链路径
 * @param {{agree:number, total:number, spanDays:number}} spec
 */
async function buildChain(p, spec) {
  const audit = new AuditChain(p)
  const seqs = []
  for (let i = 0; i < spec.total; i++) {
    const ts = new Date(T0 + (i * spec.spanDays * DAY) / (spec.total - 1)).toISOString()
    const r = await audit.record({
      tool: 'fde_ontology_write',
      decision: 'shadow-deny',
      reason: '活验合成样本（enforce 会拦、observe 只记）',
      paths: ['E:/ontologyRoot/actions.yaml'],
      ts
    })
    seqs.push(r.seq)
  }
  for (let i = 0; i < spec.total; i++) {
    await audit.record({
      tool: SHADOW_SWITCH,
      decision: 'shadow-judged',
      refSeq: seqs[i],
      verdict: i < spec.agree ? 'agree' : 'disagree',
      outcome: i < spec.agree ? 'allowed-once' : 'rejected',
      srcTool: 'fde_ontology_write',
      srcReason: '活验合成样本',
      reason: '活验'
    })
  }
  return { audit, seqs }
}

// ================================================================ 场景 1
info('== E4 影子模式（spec §12/§14）· 真 SDK + 真数据活验 ==')
info(`  真链 = ${REAL_CHAIN}`)
section('[场景 1：真链上的只读统计（实况观察，不改任何东西）]')

const realBefore = chainStamp(REAL_CHAIN)
const realStats = await computeShadowStatsFromChain(REAL_CHAIN)
const realArch = listArchivedSegmentsSync(REAL_CHAIN)
info(`  链快照 = ${realBefore}`)
info(`  统计：verdict=${realStats.verdict} 样本=${realStats.total} 已确认=${realStats.rated}（同意 ${realStats.agree} / 反对 ${realStats.disagree}）`)
info(`        跨度=${realStats.spanDays} 天 准确率=${realStats.accuracyPct === null ? '—（无已确认样本）' : realStats.accuracyPct.toFixed(1) + '%'}`)
info(`  归档段（同目录 <链名>.日期，**不自动合并**）：${realArch.files.length ? realArch.files.join(', ') : '无'}`)
info(`  → ${formatShadowStats(realStats).split('\n')[0]}`)

// ================================================================ 场景 2
section('[场景 2：真 SDK 的 defineTool 构造（含负向对照）]')

check('两个工具经真 defineTool 构造成功（output.schema 全过严格校验）', async (note) => {
  const { ctx, tools } = makeCtx('allowed-once')
  const dispose = installShadowTools(ctx, { auditPath: REAL_CHAIN, maxConfirmPerCall: 50 }, null)
  assertEq(Object.keys(tools).sort(), [SHADOW_STATUS, SHADOW_SWITCH].sort(), '注册的工具名')
  assert(typeof dispose === 'function', 'installShadowTools 应返回注销器')
  assert(typeof tools[SHADOW_STATUS].execute === 'function', 'status.execute 应是函数')
  assert(typeof tools[SHADOW_SWITCH].execute === 'function', 'switch.execute 应是函数')
  note('真实严格校验通过的两个 schema：status 的 12 个属性、switch 的 9 个属性（每个 object 节点都写了 additionalProperties）')
})

check('负向对照：同一份 schema 去掉 additionalProperties ⇒ 真 SDK 必须抛（证明校验真在跑）', async (note) => {
  let threw = null
  try {
    defineTool({
      name: 'fde_e4_live_negative_control',
      description: '负向对照：故意漏写 additionalProperties',
      parameters: { reason: { type: 'string', required: true, description: '理由' } },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean', required: true } } } },
      async execute() {
        return { ok: true }
      }
    })
  } catch (e) {
    threw = e
  }
  assert(threw, '缺 additionalProperties 竟然构造成功 ⇒ 「场景 2 构造成功」这句话没有信息量（桩也会成功）')
  note(`真 SDK 拒绝理由：${String(threw.message).split('\n')[0].slice(0, 120)}`)
  note('⇒ 证明上面的"构造成功"是真校验通过，不是"校验不存在"')
})

// ================================================================ 场景 3
section('[场景 3：真数据上的**拒绝**路径（读真链、写临时链 ⇒ 真链只读）]')

const tmpReadOnly = mkdtempSync(join(tmpdir(), 'e4live-reject-'))
const sink = new AuditChain(join(tmpReadOnly, 'sink.jsonl')) // 写入落点：临时
const { ctx: rejCtx, tools: rejTools, asked: rejAsked } = makeCtx('allowed-once')
installShadowTools(rejCtx, { auditPath: REAL_CHAIN, maxConfirmPerCall: 50 }, sink)

const pRej = check('真数据上切 enforce 被拒，且错误是**真 HarnessError**（code 真挂在对象上）', async (note) => {
  let threw = null
  try {
    await rejTools[SHADOW_SWITCH].execute({ to: 'enforce', reason: 'E4 活验：真数据上应被拒' }, { callId: 'e4-live-rej' })
  } catch (e) {
    threw = e
  }
  assert(threw, '真数据上竟然批准了切 enforce —— 这与"影子期样本不足"的实况矛盾，必须查')
  assert(threw instanceof HarnessError, `抛的不是真 HarnessError，实际 ${threw.constructor?.name}`)
  assert(typeof threw.code === 'string' && threw.code.startsWith('SHADOW_'), `code 应是 SHADOW_*，实际 ${threw.code}`)
  note(`真 HarnessError：instanceof ✓、code="${threw.code}"`)
  note(`文案首行：${String(threw.message).split('\n')[0].slice(0, 100)}`)
})

check('🔴 被拒时**弹窗次数 = 0**（闸门顺序：与用户回答无关的硬事实先判）', async (note) => {
  await pRej // ⚠️ 必须等——否则读到的是"还没开始问"的空数组，这条会**恒真**
  assertEq(rejAsked.length, 0, '不该弹出任何逐条确认窗')
  note('理由：真环境影子期样本不足 ⇒ 先被闸门 1/3 接住 ⇒ 一次窗都不弹')
  note('若反过来（先逐条后裁决），FDE 会先答完所有历史项、再被告知"跨度不够"—— 白打扰，且让人以为"多答几次就能切"')
})

check('拒绝**也留痕**：临时链上有一条 mode-switch approved:false（含 code）', async (note) => {
  await pRej
  const recs = readChainRecordsSync(join(tmpReadOnly, 'sink.jsonl')).records
  const ms = recs.filter((r) => r.decision === MODE_SWITCH)
  assertEq(ms.length, 1, '恰好一条模式切换记录')
  assertEq([ms[0].to, ms[0].approved], ['enforce', false], '必须是"切 enforce 被拒"')
  assert(typeof ms[0].code === 'string', '拒绝必须带错误码')
  note(`落链：seq=${ms[0].seq} to=${ms[0].to} approved=${ms[0].approved} code=${ms[0].code}`)
})

check('真链一字未改（前后 SHA-256 相同）—— 零污染的**证明**而非声称', async (note) => {
  assertEq(chainStamp(REAL_CHAIN), realBefore, '真链被改动了')
  note(`前后同为 ${chainStamp(REAL_CHAIN)}；写入全部落在临时链 ${join(tmpReadOnly, 'sink.jsonl')}`)
})

// ================================================================ 场景 4
section('[场景 4：合成达标链上的完整**批准**路径（闸门 3 重读磁盘）]')

const tmpOk = mkdtempSync(join(tmpdir(), 'e4live-approve-'))
const okChain = join(tmpOk, 'gate.jsonl')
await buildChain(okChain, { agree: 6, total: 7, spanDays: 8 })

check('合成链的统计口径达标（verdict=ready，准确率 85.7% > 80%、跨度 8 天 ≥ 7 天）', async (note) => {
  const s = await computeShadowStatsFromChain(okChain)
  assertEq(s.verdict, 'ready', 'verdict')
  assertEq([s.total, s.rated, s.agree, s.disagree, s.pending], [7, 7, 6, 1, 0], '统计量')
  assert(s.spanDays >= 7, `跨度应 ≥7 天，实际 ${s.spanDays}`)
  assert(s.accuracyPct > 80, `准确率应 >80%，实际 ${s.accuracyPct}`)
  note(`总 ${s.total} 条、已确认 ${s.rated}（同意 ${s.agree} / 反对 ${s.disagree}）、跨度 ${s.spanDays} 天、准确率 ${s.accuracyPct.toFixed(1)}%`)
  note('⚠️ 因为全部已确认，闸门 2 走"0 条待确认"分支 ⇒ 本场景**不覆盖**弹窗；弹窗由离线工具套件覆盖')
})

const pApprove = check('切 enforce 批准：真 HarnessError 未抛、返回值 approved=true、needsRestart=true', async (note) => {
  // 生产形态：读源与写入落点是**同一个文件**（cfg.auditPath 就是 audit 的路径）
  const audit = new AuditChain(okChain)
  const { ctx, tools, asked } = makeCtx('allowed-once')
  installShadowTools(ctx, { auditPath: okChain, maxConfirmPerCall: 50 }, audit)
  const v = await tools[SHADOW_SWITCH].execute({ to: 'enforce', reason: 'E4 活验：合成链达标' }, { callId: 'e4-live-ok' })
  assertEq([v.to, v.approved, v.needsRestart], ['enforce', true, true], '返回三元组')
  assertEq(asked.length, 0, '无待确认项 ⇒ 不该弹窗')
  note(`返回：to=${v.to} approved=${v.approved} needsRestart=${v.needsRestart} 准确率=${v.accuracy} 跨度=${v.spanDays} 天`)
  note('⚠️ needsRestart=true 是**如实**的：模式是 apply 期读的配置，工具只能裁决与留痕')
})

check('落链：mode-switch to=enforce approved=true（带统计快照）', async (note) => {
  await pApprove
  const recs = readChainRecordsSync(okChain).records
  const ms = recs.filter((r) => r.decision === MODE_SWITCH)
  assertEq(ms.length, 1, '恰好一条模式切换记录')
  assertEq([ms[0].to, ms[0].approved], ['enforce', true], '必须是"切 enforce 批准"')
  for (const k of ['total', 'agree', 'disagree', 'accuracyPct', 'spanDays', 'oldestTs', 'newestTs', 'chainPath']) {
    assert(ms[0][k] !== undefined, `批准记录应带统计快照字段 ${k}`)
  }
  note(`落链：seq=${ms[0].seq} 快照 total=${ms[0].total} agree=${ms[0].agree} disagree=${ms[0].disagree} accuracyPct=${ms[0].accuracyPct} spanDays=${ms[0].spanDays}`)
})

check('闸门 3 之后 enforceAttestation 认出凭据（apply 期检查的同一函数）', async (note) => {
  await pApprove
  const { records: recs } = readChainRecordsSync(okChain)
  const att = enforceAttestation(recs)
  assertEq([att.attested, att.why], [true, 'approved'], '凭据判定')
  note(`why=${att.why}：切 enforce 有链上批准记录 ⇒ apply 期不会记 mode-switch-unattested`)
})

// ================================================================ 场景 5
section('[场景 5：逃生方向（enforce ⇒ observe）**无条件**放行]')

check('零样本的链上也能切回 observe（往回走不设门，避免单向棘轮）', async (note) => {
  const empty = join(tmpOk, 'empty.jsonl')
  const audit = new AuditChain(empty)
  const { ctx, tools, asked } = makeCtx('unavailable') // 🔴 连 approval 都拿不到结论
  installShadowTools(ctx, { auditPath: empty, maxConfirmPerCall: 50 }, audit)
  const v = await tools[SHADOW_SWITCH].execute({ to: 'observe', reason: 'E4 活验：逃生方向' }, { callId: 'e4-live-esc' })
  assertEq([v.to, v.approved], ['observe', true], '返回二元组')
  assertEq(asked.length, 0, '逃生方向不该问任何人')
  const ms = readChainRecordsSync(empty).records.filter((r) => r.decision === MODE_SWITCH)
  assertEq([ms[0].to, ms[0].approved], ['observe', true], '落链')
  note('approval 返回 unavailable 也照样放行 ⇒ 证明这条路**不经过任何门**')
  note('理由（spec §12「切换后仍可随时切回 observe」）：给"往回走"设门 = 把门禁变成单向棘轮，而门禁失效时人必须能撤')
})

check('批准后又切回 observe ⇒ 旧批准**失效**（enforceAttestation 取最后一条）', async (note) => {
  await pApprove
  const { records: recs } = readChainRecordsSync(okChain)
  const esc = new AuditChain(okChain)
  await esc.record({ tool: SHADOW_SWITCH, decision: MODE_SWITCH, to: 'observe', approved: true, reason: 'E4 活验：切回' })
  const after = enforceAttestation(readChainRecordsSync(okChain).records)
  assertEq([after.attested, after.why], [false, 'observe'], '切回后旧批准必须失效')
  assert(recs.filter((r) => r.decision === MODE_SWITCH && r.to === 'enforce').length === 1, '链上那条批准仍在（append-only，不被改写）')
  note('链上两条模式切换（先 enforce 批准、后 observe）⇒ 判定按**最后一条** ⇒ why=observe')
  note('这条是"配置被手改绕过流程"的兜底：改了配置但链上没有对应的最新批准 ⇒ apply 期记 mode-switch-unattested')
})

// ================================================================ 收尾
await Promise.all(pending)

// 清理临时目录（真链不碰）
for (const d of [tmpReadOnly, tmpOk]) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}
const tmpGone = !existsSync(tmpReadOnly) && !existsSync(tmpOk)

const out = []
for (const r of records) {
  if (r.info !== undefined) {
    out.push(r.info)
    continue
  }
  if (r.header !== undefined) {
    out.push(r.header)
    continue
  }
  if (r.ok === null) {
    out.push(`  ! ${r.name}  （未完成：异步用例没被 await）`)
    continue
  }
  out.push(`  ${r.ok ? '✓' : '✗'} ${r.name}`)
  for (const n of r.notes) out.push(`      · ${n}`)
  if (!r.ok) out.push(`      ${r.err}`)
}
out.push('')
out.push(`真链收尾快照 = ${chainStamp(REAL_CHAIN)}`)
out.push(`真链未变 = ${chainStamp(REAL_CHAIN) === realBefore}`)
out.push(`临时目录已清理 = ${tmpGone}`)
if (chainStamp(REAL_CHAIN) !== realBefore || !tmpGone) failed += 1
out.push('')
out.push(`PASS ${passed} / FAIL ${failed}`)
out.push('RESULT: ' + (failed === 0 ? 'PASS' : 'FAIL'))
writeFileSync(OUT, out.join('\n') + '\n', 'utf8')
console.log(`[e4-live] ${passed} passed / ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
