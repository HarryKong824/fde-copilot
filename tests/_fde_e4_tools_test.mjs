// E4 工具套件：fde_shadow_status / fde_shadow_switch（dsh-fde-ontology-gate/lib/shadow-tools.js）。
//
// 直接调 `execute()`，用桩 ctx 提供 tools.register / approval / logger，
// 审计链用**真的** AuditChain 写进临时目录（不 mock 落盘 —— 落盘是判据的一部分）。
//
// 运行：node _fde_e4_tools_test.mjs  ｜ 产物：_fde_e4_tools_out.txt
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditChain } from '../dsh-fde-ontology-gate/lib/audit.js'
import { installShadowTools, SHADOW_STATUS, SHADOW_SWITCH } from '../dsh-fde-ontology-gate/lib/shadow-tools.js'
import { enforceAttestation, readChainRecords } from '../dsh-fde-ontology-gate/lib/shadow-stats.js'

// ───────────────────────── 槽位式输出（登记序 = 输出序） ─────────────────────────
const slots = []
const section = (title) => slots.push({ kind: 'section', title })
let failures = 0
function t(name, actual, expected, note = '') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  slots.push({ kind: 'assert', name, actual: a, expected: e, ok, note })
}

// ───────────────────────── 夹具 ─────────────────────────
const DAY = 86400000
const T0 = Date.parse('2026-09-01T00:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const roots = []
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'fde-e4-'))
  roots.push(d)
  return d
}

/**
 * 桩 ctx：记录注册的工具、记录每次 approval 请求、按脚本返回结论。
 * @param {string|Array<string>} approvals
 *   数组 ⇒ 按序返回，**用尽后返回 'unavailable'**（模拟"没人应答"）；
 *   字符串 ⇒ 每次都返回该结论（"全程同意/全程撤回"这类场景用它，
 *             传 `['allowed-once']` 只会让第二条起变成中止 —— 我第一版就栽在这）。
 */
function makeCtx(approvals = []) {
  const registered = []
  const asked = []
  let i = 0
  const ctx = {
    tools: { register: (def) => { registered.push(def); return () => {} } },
    logger: { info() {}, warn() {} },
    get: (n) =>
      n === 'approval'
        ? {
            request: async (req) => {
              asked.push(req)
              if (typeof approvals === 'string') return approvals
              return i < approvals.length ? approvals[i++] : 'unavailable'
            }
          }
        : undefined
  }
  return { ctx, registered, asked }
}

/** 用**真的** AuditChain 造一条链；ts 由调用方控制（entry 里的 ts 会覆盖自动值）。 */
async function buildChain(specs) {
  const path = join(tmpDir(), 'gate.jsonl')
  const chain = new AuditChain(path)
  for (const s of specs) {
    await chain.record({ tool: 'write', reason: '路径命中受保护区', ...s })
  }
  const read = await readChainRecords(path)
  return { path, records: read.records, chain }
}

/** n 条 shadow-deny，跨度 days 天（ts 升序） */
const shadowSpecs = (days, n) =>
  Array.from({ length: n }, (_, i) => ({
    decision: 'shadow-deny',
    ts: iso(T0 + (days * DAY * i) / Math.max(1, n - 1))
  }))

/** 取注册好的某个工具定义 */
const toolOf = (registered, name) => registered.find((d) => d.name === name)
const exec = { name: SHADOW_SWITCH, callId: 'c1', agent: { id: 'agent-1' } }

// ═══════════════════ §1 工具注册面 ═══════════════════
section('§1 注册面：两个工具都注册，且参数/output schema 形态合法')

{
  const { ctx, registered } = makeCtx()
  const { path } = await buildChain([])
  installShadowTools(ctx, { auditPath: path, maxConfirmPerCall: 50 }, new AuditChain(path))
  t('注册了两个影子模式工具', registered.map((d) => d.name).sort(), [SHADOW_STATUS, SHADOW_SWITCH].sort())
  const sw = toolOf(registered, SHADOW_SWITCH)
  t('fde_shadow_switch 的 to 参数是枚举 enforce/observe', sw.parameters.to.enum, ['enforce', 'observe'])
  t(
    'output.schema 根对象显式声明 additionalProperties:false（真 SDK 的硬要求）',
    sw.output.schema.additionalProperties,
    false
  )
}

// ═══════════════════ §2 fde_shadow_status（只读） ═══════════════════
section('§2 fde_shadow_status：只读查询，且"读不到链"不许说成"没有样本"')

{
  const { ctx, registered } = makeCtx()
  installShadowTools(ctx, { auditPath: '', maxConfirmPerCall: 50 }, new AuditChain(''))
  const st = toolOf(registered, SHADOW_STATUS)
  const out = await st.execute({ reason: '看一眼' }, { name: SHADOW_STATUS, callId: 's1' })
  t('auditPath 为空 ⇒ verdict=unreadable', out.verdict, 'unreadable')
  t('message 里点明是"读不到"而不是"没有预判"', out.message.includes('读不到') || out.message.includes('未落盘'), true)
  t('准确率展示为占位符（不是 0%）', out.accuracy.startsWith('—'), true)
}

{
  const { path, chain } = await buildChain(shadowSpecs(8, 3))
  const { ctx, registered } = makeCtx()
  installShadowTools(ctx, { auditPath: path, maxConfirmPerCall: 50 }, chain)
  const st = toolOf(registered, SHADOW_STATUS)
  const out = await st.execute({ reason: '看一眼' }, { name: SHADOW_STATUS, callId: 's2' })
  t('3 条样本 ⇒ total=3、pending=3、未 ready', [out.total, out.pending, out.ready], [3, 3, false])
  const after = await readChainRecords(path)
  t(
    '只读查询**也入链**（decision=allow，与 fde_ontology_read 同形态）',
    after.records.filter((r) => r.decision === 'allow' && r.tool === SHADOW_STATUS).length,
    1
  )
}

// ═══════════════════ §3 闸门顺序（本轮最要紧的性质） ═══════════════════
section('§3 闸门顺序：与用户回答无关的硬事实先判 —— 不达标时**一次窗都不弹**')

async function switchExpectCode(specs, approvals, args = { to: 'enforce', reason: 'r' }, cfgExtra = {}) {
  const { path, chain } = await buildChain(specs)
  const { ctx, registered, asked } = makeCtx(approvals)
  installShadowTools(ctx, { auditPath: path, maxConfirmPerCall: 50, ...cfgExtra }, chain)
  const sw = toolOf(registered, SHADOW_SWITCH)
  let code = null
  let msg = null
  let out = null
  try {
    out = await sw.execute(args, exec)
  } catch (e) {
    code = e.code ?? String(e.message)
    msg = String(e.message ?? '')
  }
  return { code, msg, out, asked, path, chain, registered, ctx }
}

{
  const r = await switchExpectCode(shadowSpecs(8, 2), [], { to: 'nope', reason: 'r' })
  t('to 非法 ⇒ SHADOW_BAD_ARG', r.code, 'SHADOW_BAD_ARG')
}

{
  // 链读不到（auditPath 指向不存在的文件）
  const { ctx, registered } = makeCtx()
  installShadowTools(ctx, { auditPath: join(tmpDir(), 'nope.jsonl'), maxConfirmPerCall: 50 }, new AuditChain(''))
  const sw = toolOf(registered, SHADOW_SWITCH)
  let code = null
  try {
    await sw.execute({ to: 'enforce', reason: 'r' }, exec)
  } catch (e) {
    code = e.code
  }
  t('链读不到 ⇒ SHADOW_STATS_UNAVAILABLE（**不是** NO_SAMPLES）', code, 'SHADOW_STATS_UNAVAILABLE')
}

{
  // ⚠️ 夹具要点：必须是"文件存在、但一条 shadow-deny 都没有"。
  //    传 `[]` 会让文件压根不被创建 ⇒ 先被 SHADOW_STATS_UNAVAILABLE 接住
  //    （那是**对**的：读不到 ≠ 没有样本），本用例就测不到 NO_SAMPLES 这一支。
  const r = await switchExpectCode([{ decision: 'allow', ts: iso(T0) }], 'allowed-once')
  t('链可读但 0 条 shadow-deny ⇒ SHADOW_NO_SAMPLES', r.code, 'SHADOW_NO_SAMPLES')
  t('0 条样本 ⇒ 一次窗都没弹（闸门先于逐条确认）', r.asked.length, 0)
}

{
  const r = await switchExpectCode(shadowSpecs(3, 2), ['allowed-once'])
  t('跨度 3 天 < 7 天 ⇒ SHADOW_WINDOW_TOO_SHORT', r.code, 'SHADOW_WINDOW_TOO_SHORT')
  t('🔴 跨度不足 ⇒ **弹窗次数为 0**（否则会让人以为"多答几次就能切"）', r.asked.length, 0)
}

{
  // ⚠️ 夹具要点：异常必须**只**打在"异常"这一支上。
  //    第一版我拿 `shadowSpecs(8,2)` 把其中一条 ts 弄坏 ⇒ 只剩 1 个有效时间 ⇒ 跨度 0
  //    ⇒ 先被 SHADOW_WINDOW_TOO_SHORT 接住（那也是**对**的：窗口闸门先于异常闸门）。
  //    这里让两条有效 ts 跨满 8 天，再额外加一条坏 ts 的样本。
  const specs = [
    { decision: 'shadow-deny', ts: iso(T0) },
    { decision: 'shadow-deny', ts: iso(T0 + 8 * DAY) },
    { decision: 'shadow-deny', ts: 'not-a-date' }
  ]
  const r = await switchExpectCode(specs, 'allowed-once')
  t('跨度够但链有异常形状 ⇒ SHADOW_CHAIN_ANOMALIES', r.code, 'SHADOW_CHAIN_ANOMALIES')
  t('异常路径也不弹窗', r.asked.length, 0)
}

// ═══════════════════ §4 R2 逐条确认 ═══════════════════
section('§4 逐条确认：一次一条、结论必须明确、中止时已确认的保留')

{
  const r = await switchExpectCode(shadowSpecs(8, 3), ['allowed-once', 'rejected', 'allowed-once'])
  t('2 同意 / 1 反对 ⇒ 准确率 66.7% 触发 §14 推翻线', r.code, 'SHADOW_NOT_READY')
  t('三条各弹一次窗（不可批量）', r.asked.length, 3)
  const recs = (await readChainRecords(r.path)).records
  const judged = recs.filter((x) => x.decision === 'shadow-judged')
  t('三条确认都落到链上（重读磁盘口径）', judged.length, 3)
  t(
    '确认记录带 outcome 原文（可追溯 approval 的真实回应）',
    judged.map((j) => j.outcome),
    ['allowed-once', 'rejected', 'allowed-once']
  )
  t(
    '未通过 ⇒ 仍写一条 approved:false 的 mode-switch（拒绝也必须留痕）',
    recs.filter((x) => x.decision === 'mode-switch' && x.to === 'enforce' && x.approved === false).length,
    1
  )
}

{
  // 全同意、跨度够 ⇒ 批准
  const r = await switchExpectCode(shadowSpecs(8, 3), 'allowed-once')
  t('全部同意 + 跨度够 ⇒ 批准', [r.code, r.out?.approved, r.out?.needsRestart], [null, true, true])
  t('返回的准确率是 100.0%', r.out.accuracy, '100.0%')
  const recs = (await readChainRecords(r.path)).records
  const approvedRec = recs.find((x) => x.decision === 'mode-switch' && x.to === 'enforce' && x.approved === true)
  t('批准记录写进链', Boolean(approvedRec), true)
  t(
    '批准记录带统计快照（读者可复算当时凭什么批的）',
    [approvedRec.total, approvedRec.agree, approvedRec.disagree, approvedRec.accuracyPct],
    [3, 3, 0, 100]
  )
  t(
    '批准后 attestation 认得它',
    enforceAttestation(recs).attested,
    true
  )
}

{
  // 幂等：已确认过的不再重复问
  const { path, chain } = await buildChain(shadowSpecs(8, 3))
  const first = makeCtx('allowed-once')
  installShadowTools(first.ctx, { auditPath: path, maxConfirmPerCall: 50 }, chain)
  await toolOf(first.registered, SHADOW_SWITCH).execute({ to: 'enforce', reason: 'r' }, exec)
  t('第一次调用弹 3 次窗', first.asked.length, 3)
  const second = makeCtx('allowed-once')
  installShadowTools(second.ctx, { auditPath: path, maxConfirmPerCall: 50 }, chain)
  const out2 = await toolOf(second.registered, SHADOW_SWITCH).execute({ to: 'enforce', reason: 'r' }, exec)
  t('重复调用 ⇒ 0 次弹窗（已确认的项不再问）', second.asked.length, 0)
  t('重复调用直接批准', out2.approved, true)
}

{
  const r = await switchExpectCode(shadowSpecs(8, 3), ['allowed-once']) // 第 2 次起 unavailable
  t('approval=unavailable ⇒ SHADOW_CONFIRM_ABORTED（拿不到结论就停在 observe）', r.code, 'SHADOW_CONFIRM_ABORTED')
  const recs = (await readChainRecords(r.path)).records
  t('中止前已确认的 1 条**保留在链上**（append-only，下次从断点续）', recs.filter((x) => x.decision === 'shadow-judged').length, 1)
}

{
  const r = await switchExpectCode(shadowSpecs(8, 3), ['allowed-once', 'cancelled'])
  t('approval=cancelled ⇒ 同样中止', r.code, 'SHADOW_CONFIRM_ABORTED')
}

{
  const r = await switchExpectCode(shadowSpecs(8, 5), 'allowed-once', { to: 'enforce', reason: 'r' }, { maxConfirmPerCall: 2 })
  t('达单次上限 ⇒ SHADOW_CONFIRM_BATCH_LIMIT', r.code, 'SHADOW_CONFIRM_BATCH_LIMIT')
  t('上限是"未完成"不是"跳过"：弹窗数 = 上限', r.asked.length, 2)
  // ⚠️ 这条**不许**写成 `/…/.test(msg) || true`（恒真式 = 一行打印，永远不会红）。
  //    C30 的形态就是这个：写完 `X == Y` 型判据要立刻问"能不能构造出 X ≠ Y 的合法状态"。
  t('拒绝信息里写明还剩 3 条未确认（可复算）', /仍有 3 条未确认/.test(r.msg), true)
  t('拒绝信息里点明上限值本身', /maxConfirmPerCall=2/.test(r.msg), true)
  const recs = (await readChainRecords(r.path)).records
  t('达上限时已确认的 2 条落链', recs.filter((x) => x.decision === 'shadow-judged').length, 2)
}

// ═══════════════════ §5 切回 observe（无门） ═══════════════════
section('§5 切回 observe：逃生方向不设门（spec §12「切换后仍可随时切回 observe」）')

{
  // 故意用"零样本 + 不达标"的链，观察方向仍应无条件批准
  const r = await switchExpectCode([], [], { to: 'observe', reason: '门禁误伤，先撤' })
  t('零样本也能切回 observe（不设门）', [r.code, r.out?.approved], [null, true])
  t('切回 observe 不弹窗', r.asked.length, 0)
  const recs = (await readChainRecords(r.path)).records
  const rec = recs.find((x) => x.decision === 'mode-switch')
  t('记录 to=observe 且 approved=true', [rec.to, rec.approved], ['observe', true])
}

{
  // 批准 enforce 之后再切回 observe ⇒ 旧批准必须失效
  const { path, chain } = await buildChain(shadowSpecs(8, 3))
  const c1 = makeCtx('allowed-once')
  installShadowTools(c1.ctx, { auditPath: path, maxConfirmPerCall: 50 }, chain)
  await toolOf(c1.registered, SHADOW_SWITCH).execute({ to: 'enforce', reason: 'r' }, exec)
  const c2 = makeCtx([])
  installShadowTools(c2.ctx, { auditPath: path, maxConfirmPerCall: 50 }, chain)
  await toolOf(c2.registered, SHADOW_SWITCH).execute({ to: 'observe', reason: '撤' }, exec)
  const att = enforceAttestation((await readChainRecords(path)).records)
  t(
    '🔴 批准 enforce 后又切回 observe ⇒ 旧批准失效（why=observe，不是 attested）',
    [att.attested, att.why],
    [false, 'observe']
  )
}

// ═══════════════════ §6 enforceAttestation 的三种"无凭据"要分开 ═══════════════════
section('§6 attestation：三种"不是批准"的情形要在 why 上分开（运维动作不同）')

{
  // 链上**有记录但没有模式切换**（比"空文件"更真实：空文件压根不存在）
  const { records } = await buildChain([{ decision: 'allow', ts: iso(T0) }])
  const a = enforceAttestation(records)
  t('链上有记录但从无模式切换 ⇒ why=none', [a.attested, a.why], [false, 'none'])
}
{
  const { records } = await buildChain([{ decision: 'mode-switch', to: 'enforce', approved: false, ts: iso(T0) }])
  const a = enforceAttestation(records)
  t('最后一次是**被拒**的 enforce ⇒ why=rejected', [a.attested, a.why], [false, 'rejected'])
}
{
  const { records } = await buildChain([
    { decision: 'mode-switch', to: 'enforce', approved: true, ts: iso(T0) },
    { decision: 'mode-switch', to: 'enforce', approved: false, ts: iso(T0 + DAY) }
  ])
  const a = enforceAttestation(records)
  t('批准在前、被拒在后 ⇒ 按**最后一条**判 ⇒ why=rejected', [a.attested, a.why], [false, 'rejected'])
}
{
  // 🔴 读不到链时 `records` 是 **undefined**（不是 `[]`）—— 判据函数不许崩。
  //    这条断言是实测出来的：本套件第一版就在 `buildChain([])`（空数组 ⇒ 文件没被创建）上
  //    TypeError 崩掉，整份报告消失。生产代码已加 Array.isArray 防御。
  //
  // ⚠️ "不许崩"必须写成**显式断言**，不能让被测代码把整个套件带走：
  //    第一版直接 `enforceAttestation(undefined)` ⇒ 变异 M9（去掉防御）让**套件崩溃**，
  //    而崩溃在变异集里算 INVALID（**不是证据**，与"断言红"分开数）⇒ M9 无法被判为抓住。
  //    包一层 try 之后，"崩了"变成一个**具名断言失败**（RED），这才是可用的证据。
  let a = null
  let threw = null
  try {
    a = enforceAttestation(undefined)
  } catch (e) {
    threw = String(e?.name ?? e)
  }
  t(
    'records=undefined ⇒ 不崩，判为无凭据（why=none）',
    threw === null ? [a.attested, a.why] : `THREW:${threw}`,
    [false, 'none']
  )
}

// ═══════════════════ §7 真链文件里的坏行（补 M8 暴露的覆盖缺口） ═══════════════════
section('§7 parseChainText：坏行必须计数 —— 这条是**变异测试逼出来的**，本套件原先是空白')

{
  // 🔴 来路：变异 M8 把 `parseChainText` 里的 `badLines++` 去掉，**两个套件都没红**。
  //    根因不是断言弱，是**没人跑过那个函数** —— stats 套件是把 `badLines` 当**入参**传进去的
  //    （`computeShadowStats(recs, {badLines: 2})`），从没走过真实解析路径。
  //    这正是本项目"判据的数据源若不可测，这条判据的最坏情况就从来没被真跑过"的形态。
  //    修法只有一个方向：**真往链文件里写一行坏行**，再从工具那一端看它有没有被报出来。
  const { path, chain } = await buildChain([{ decision: 'allow', ts: iso(T0) }])
  appendFileSync(path, '{ 这一行不是合法 JSON\n', 'utf8')
  const { ctx, registered } = makeCtx()
  installShadowTools(ctx, { auditPath: path, maxConfirmPerCall: 50 }, chain)
  const out = await toolOf(registered, SHADOW_STATUS).execute({ reason: '看一眼' }, { name: SHADOW_STATUS, callId: 's3' })
  t('链上有坏行 ⇒ 客户端能看见"1 行无法解析"', out.blockers.some((b) => b.includes('1 行无法解析')), true)
}

// FDE_INVERT=1 ⇒ 真注入一条注定失败的断言（退出码与 out.txt 同时变红，产物自洽）
if (process.env.FDE_INVERT === '1') {
  t('[INVERT] 故意失败以验证退出码敏感', 'invert', 'not-invert')
}

// ───────────────────────── 渲染（登记序 = 输出序） ─────────────────────────
const out = []
for (const s of slots) {
  if (s.kind === 'section') out.push('', s.title)
  else {
    out.push(`  ${s.ok ? '✅' : '❌'} ${s.name}`)
    if (!s.ok) out.push(`      actual   = ${s.actual}`, `      expected = ${s.expected}`)
  }
}
const total = slots.filter((s) => s.kind === 'assert').length
out.push('', `RESULT: PASS ${total - failures} / FAIL ${failures}（共 ${total} 条断言）`)

// 清理临时目录（链都是 tmp 造的，不留垃圾）
for (const d of roots) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}

const text = out.join('\n') + '\n'
writeFileSync('_fde_e4_tools_out.txt', text, 'utf8')
process.stdout.write(text)
process.exitCode = failures > 0 ? 1 : 0
