/**
 * _fde_e5_test.mjs —— spec v3 §14 六项验证指标（E5）离线回归
 *
 * 覆盖：
 *   A. 红线：无数据 ⇒ insufficient-data + value null，**绝不报 0%**；总判决不把 no-data 当 ok
 *   B. ① deny 修复率（proxy：分子窄、弱配对、只读通道不算修复、时间方向、绕过优先）
 *   C. ② break-glass 分类（三类边界、未知分类、gate 镜像不重复计数）
 *   D. ③ 变更触发率（分母 = Phase 段数、L2 不计、**无 level 的写入不静默丢**、Phase 4 缺席）
 *   E. ④ ask 跳过率（rejected 不是跳过、write-failed 单列、边界 30%）
 *   F. ⑤ Phase 停留时长（严格配对、跳号丢弃、chainTail 不计入、**无配对报无数据不是 0**）
 *   G. ⑥ 影子准确率（转调 shadow-stats，不重算）
 *   H. 工具层：`fde_metrics` 的输出 schema（字符串型 value 是"无数据"能表达的前提）
 *   I. 跨包字面量对拍：cordis.patch.yml 的 phaseAuditPath == phase 的 auditPath
 *
 * 🔴 本文件的**最重要**一条纪律：A2/A7 是**双向**的 ——
 *    既断言"真报告里没有假的 0"，也断言"我用来判红的那把尺子本身能判红"
 *    （合成一个 value=0 的坏样本喂给它，不红就 exit 1）。
 *    只做前者等于"不崩就是通过"，那只排除了假阳性、不提供真阳性。
 *
 * 退出码 0 = 全绿；1 = 有失败。
 */

import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const mUrl = pathToFileURL(ROOT + '/dsh-fde-ontology-gate/lib/metrics.js').href
const mtUrl = pathToFileURL(ROOT + '/dsh-fde-ontology-gate/lib/metrics-tools.js').href

const M = await import(mUrl)
const MT = await import(mtUrl)

let PASS = 0
const FAIL = []

/**
 * 崩溃兜底：**不许让崩溃变成"没有结论"**。
 *
 * 🔴 本项目既有纪律：崩溃不是判据，而且"崩一次会让整份报告消失"。
 *    本套件是**顺序执行**的顶层语句 ⇒ 一次抛错会跳过其后所有断言（第一版实测就是如此：
 *    F2 处抛 TypeError，G/H/I 三组一条都没跑，读者只看到一段栈）。
 *    `rowOf()` 已消除**已知**的裸取下标点，但"没有别的崩点"这句话我不敢断言
 *    ⇒ 这里至少保证：即便崩了，也以 **非 0 退出**结束并打印已跑到的进度，
 *      而不是留下一个"看不出结论"的进程。
 *    ⚠️ 已知弱点：本兜底**不会**让后续断言继续跑（模块体已展开完）。要彻底解决得把各
 *      分组包成独立函数逐个 try/catch —— 那是下一步的改进，不假装现在已经做到了。
 */
process.on('uncaughtException', (e) => {
  console.log('\n!!! 套件在断言中途抛错（其后断言未执行）!!!')
  console.log('  已跑 ' + PASS + ' 条断言，崩溃：' + String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '))
  process.exit(1)
})

function ok(name, cond, detail) {
  if (cond) {
    PASS++
    console.log('  OK   ' + name + (detail !== undefined ? '  ⇒ ' + detail : ''))
  } else {
    FAIL.push(name)
    console.log('  FAIL ' + name + (detail !== undefined ? '  ⇒ ' + detail : ''))
  }
}

/** 值相等（JSON 比较，避免引用/浮点噪声）。 */
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(name, a === e, a === e ? a : `实际 ${a} ≠ 期望 ${e}`)
}

/** 浮点近似（比值/天数）。 */
function near(name, actual, expected, eps = 1e-9) {
  const good = typeof actual === 'number' && Math.abs(actual - expected) < eps
  ok(name, good, `${actual} ≈ ${expected}?`)
}

/**
 * 取 perPhase 里的某一行 —— **找不到返回 null，不裸取下标**。
 *
 * 🔴 本项目既有纪律：裸 `.find(...).xxx` 一旦取不到就抛错，而抛错会让**整份报告消失**
 *    （第一版本文件在 F2 处正是这么崩的：后面的测试一条都没跑，读者只看到一段栈）。
 *    崩溃**不是判据**（它只证明这一行跑不了，不证明被测代码对错），
 *    而且它把"这条断言失败"升级成"这次运行没有结论"。
 *    故：先断言该行存在，再断言它的值。
 */
function rowOf(rows, phase) {
  return rows.find((r) => String(r.phase) === String(phase)) ?? null
}

const T0 = Date.parse('2026-09-20T00:00:00.000Z')
const H = 3600000
const DAY = 86400000
const iso = (ms) => new Date(ms).toISOString()

/** 门禁链记录（gate.jsonl 的行）。 */
const g = (o) => ({ seq: 1, ts: iso(T0), tool: 'pwsh', ...o })
/** phase 链记录（phase.jsonl 的行）。 */
const p = (o) => ({ seq: 1, ts: iso(T0), ...o })
/** 一条推进记录。 */
const adv = (from, to, ms) => p({ type: 'phase-advance', from, to, ts: iso(T0 + ms) })

// ─────────────────────────────────────────────────────────────────────
console.log('\n[A. 红线：无数据不许报 0%]')

const empty = M.computeAllMetrics({ gateRecords: [], phaseRecords: [], shadowStats: {} })
eq('A1 空输入 ⇒ 六项 id 齐全', empty.metrics.map((m) => m.id), M.METRIC_IDS)
ok(
  'A1b 六项全部 insufficient-data 且 value === null',
  empty.metrics.every((m) => m.verdict === 'insufficient-data' && m.value === null),
  empty.metrics.map((m) => `${m.id}=${m.verdict}/${m.value}`).join(' ')
)
// 🔴 核心红线。这一条与 B2/D2 是**对照**：那两处 value 真的等于 0 —— 因为那里
//    **有**可判样本（分母 > 0）且真值就是 0。所以本断言写成"无可判样本时不许是 0"，
//    而不是"任何情况都不许是 0"（后者会把正确的 0 也判红 ⇒ 逼着人去改坏它）。
ok(
  'A2 ★红线 无样本的六项 value **都不为 0**（是 null）',
  empty.metrics.every((m) => m.value !== 0),
  empty.metrics.filter((m) => m.value === 0).map((m) => m.id).join(',') || '无一项为 0'
)
eq('A3 空输入总判决 = no-data，不是 ok', empty.verdict, 'no-data')
ok('A4 六项 note 均非空（口径必须写出来）', empty.metrics.every((m) => typeof m.note === 'string' && m.note.length > 20))
ok('A5 六项 overturnWhen 均非空', empty.metrics.every((m) => typeof m.overturnWhen === 'string' && m.overturnWhen.length > 5))
eq('A6 空输入无 warnings', empty.warnings, [])

// —— A7：**判红的那把尺子本身必须能判红**（合成坏样本）——
console.log('  -- A7 自检：合成坏样本必须判红 --')
/**
 * 红线检查器：报告里有没有"没有样本却报了一个数"的项。
 * 判据**双向**：无样本 ⇒ value 必须 null；有样本 ⇒ value 必须是数。
 * @returns {string[]} 违规描述
 */
function violNoFakeZero(report) {
  const out = []
  for (const m of report?.metrics ?? []) {
    if (m.verdict === 'insufficient-data' && m.value !== null) {
      out.push(`${m.id}: verdict=insufficient-data 却给了 value=${m.value}`)
    }
    if (m.verdict !== 'insufficient-data' && m.value === null) {
      out.push(`${m.id}: verdict=${m.verdict} 却没有 value`)
    }
  }
  return out
}
eq('A7a 真报告 ⇒ 红线检查器判绿（违规 0）', violNoFakeZero(empty), [])
const badSample = {
  metrics: [
    { id: 'x', verdict: 'insufficient-data', value: 0, numerator: 0, denominator: 0, note: '', overturnWhen: '' }
  ]
}
ok(
  'A7b ★ 坏样本（0 样本却报 0%）⇒ 检查器判红（不红即本套件自身失效）',
  violNoFakeZero(badSample).length === 1,
  JSON.stringify(violNoFakeZero(badSample))
)
const badSample2 = { metrics: [{ id: 'y', verdict: 'ok', value: null }] }
ok('A7c ★ 反向坏样本（有判决却无值）⇒ 检查器同样判红', violNoFakeZero(badSample2).length === 1)

// ─────────────────────────────────────────────────────────────────────
console.log('\n[B. ① deny 修复率]')

const b1 = M.computeDenyFixRate([
  { decision: 'deny', tool: 'pwsh' }, // 无 ts
  { decision: 'deny', tool: 'write' } // 无 ts
])
eq('B1 两条 deny 均缺 ts ⇒ insufficient-data', [b1.verdict, b1.value, b1.buckets.undated], [
  'insufficient-data',
  null,
  2
])

const b2 = M.computeDenyFixRate([
  g({ ts: iso(T0), decision: 'deny', tool: 'pwsh' }),
  g({ ts: iso(T0 + H), decision: 'deny', tool: 'write' })
])
// ⚠️ 这里的 0 是**合法**的 0：分母 2 > 0，真值就是"两条都没修" ⇒ 触发推翻。
//    与 A2 对照读：**有可判样本的 0 必须报 0**，否则那条断言会被改成"永不报 0"而失去意义。
eq('B2 有样本、真值 0 ⇒ 报 0 并 overturn（与 A2 对照）', [b2.value, b2.verdict, b2.denominator], [0, 'overturn', 2])
ok('B2b 两条都无 denyId ⇒ weaklyPaired 记账', b2.buckets.weaklyPaired === 2)

const b3 = M.computeDenyFixRate([
  g({ ts: iso(T0), decision: 'deny', tool: 'pwsh', denyId: 'GATE-PATH' }),
  g({ ts: iso(T0 + H), decision: 'allow', tool: 'fde_ontology_write' })
])
eq('B3 deny 之后有合法写 ⇒ 修复 1 条', [b3.value, b3.numerator, b3.denominator], [1, 1, 1])

const b4 = M.computeDenyFixRate([
  g({ ts: iso(T0), decision: 'deny', tool: 'pwsh', denyId: 'GATE-PATH' }),
  g({ ts: iso(T0 + H), decision: 'allow', tool: 'fde_ontology_read' })
])
ok('B4 ★反向 只读通道的 allow **不算**修复（仍 0）', b4.numerator === 0 && b4.value === 0, `fixed=${b4.numerator}`)

const b5 = M.computeDenyFixRate([
  g({ ts: iso(T0 + H), decision: 'deny', tool: 'pwsh', denyId: 'GATE-PATH' }),
  g({ ts: iso(T0), decision: 'allow', tool: 'fde_ontology_write' }) // 更早
])
ok('B5 ★反向 allow 在 deny **之前** ⇒ 不算修复（时间方向）', b5.numerator === 0, `fixed=${b5.numerator}`)

const b6 = M.computeDenyFixRate([
  g({ ts: iso(T0), decision: 'deny', tool: 'pwsh', denyId: 'GATE-PATH' }),
  g({ ts: iso(T0 + H), decision: 'allow', tool: 'fde_ontology_write' }),
  g({ ts: iso(T0 + 2 * H), type: 'break-glass-bypass', denyId: 'GATE-PATH', tool: 'pwsh' })
])
ok(
  'B6 ★ 同一条 deny 既被绕过又有后续写 ⇒ **优先算绕过**（conservative）',
  b6.buckets.bypassed === 1 && b6.numerator === 0,
  `bypassed=${b6.buckets.bypassed} fixed=${b6.numerator}`
)

const b7 = M.computeDenyFixRate([
  g({ ts: iso(T0 + H), decision: 'deny', tool: 'pwsh', denyId: 'GATE-PATH' }),
  g({ ts: iso(T0), type: 'break-glass-bypass', denyId: 'GATE-PATH', tool: 'pwsh' }) // 更早
])
ok('B7 ★反向 bypass 在 deny 之前 ⇒ 不算绕过', b7.buckets.bypassed === 0, `bypassed=${b7.buckets.bypassed}`)

// ─────────────────────────────────────────────────────────────────────
console.log('\n[C. ② break-glass 分类统计]')

const c1 = M.computeBreakGlassCategories([])
eq('C1 无 break-glass ⇒ insufficient-data', [c1.verdict, c1.value], ['insufficient-data', null])

const mkBg = (cats) => cats.map((c, i) => p({ type: 'break-glass', category: c, ts: iso(T0 + i * H) }))
const c2 = M.computeBreakGlassCategories(mkBg(['deny_defect', 'scope_edge', 'scope_edge', 'scope_edge', 'scope_edge']))
near('C2 1/5 = 20% ⇒ value 0.2', c2.value, 0.2)
ok('C2b ★边界 恰好 20% **不**触发推翻（spec 写的是 > 20%）', c2.verdict === 'ok', c2.verdict)

const c3 = M.computeBreakGlassCategories(mkBg(['deny_defect', 'evasion']))
near('C3 1/2 = 50% ⇒ value 0.5', c3.value, 0.5)
eq('C3b 50% > 20% ⇒ overturn', c3.verdict, 'overturn')

const c4 = M.computeBreakGlassCategories(mkBg(['deny_defect', 'evasion', 'wat']))
ok(
  'C4 ★未知 category 进 unknown 桶且**不计入**三类分母',
  c4.buckets.unknown === 1 && c4.denominator === 2 && c4.sample === 3,
  `unknown=${c4.buckets.unknown} den=${c4.denominator} sample=${c4.sample}`
)

const c5 = M.computeBreakGlassCategories(mkBg(['evasion']), {
  gateRecords: [g({ type: 'break-glass', category: 'deny_defect' })]
})
ok(
  'C5 ★gate 链的同事件镜像**不计入**（否则重复计数）',
  c5.denominator === 1 && c5.buckets.gateMirrorRecords === 1 && c5.value === 0,
  `den=${c5.denominator} mirror=${c5.buckets.gateMirrorRecords}`
)

// ─────────────────────────────────────────────────────────────────────
console.log('\n[D. ③ 变更触发率]')

const NOW = T0 + 100 * DAY
const d1 = M.computeChangeRate([], [], { now: NOW })
eq('D1 无 phase-advance ⇒ insufficient-data', [d1.verdict, d1.value], ['insufficient-data', null])

// 3→4 之后停在 4；变更落在 3→4 之间 ⇒ 归 Phase 3
// ⚠️ 参数是**相对 T0 的偏移**（与 `adv` 一致）。第一版写成绝对毫秒 ⇒ 写入落在 1970 年、
//    既不属任何 Phase 段也不报错 ⇒ 断言"Phase 4 有 5 条"失败，而失败原因看起来像实现有 bug。
const writeL1 = (ms, level) =>
  g({ ts: iso(T0 + ms), decision: 'allow', tool: 'fde_ontology_write', level, operation: 'update' })
const d2 = M.computeChangeRate([], [adv('3', '4', DAY)], { now: NOW })
ok(
  'D2 ★ 有 Phase 段但零变更 ⇒ 报 0 + ok（**不是** insufficient-data；分母是 Phase 段数）',
  d2.value === 0 && d2.verdict === 'ok' && d2.denominator === 2,
  `value=${d2.value} verdict=${d2.verdict} den=${d2.denominator}`
)

const phase4Recs = [adv('3', '4', 0), adv('4', '5', 40 * DAY)]
const mkPhase4Writes = (n) =>
  Array.from({ length: n }, (_, i) => writeL1(DAY + i * H, 'L1')) // 全落在 Phase 4 段内
const d3a = M.computeChangeRate(mkPhase4Writes(5), phase4Recs, { now: NOW })
ok('D3 ★边界 Phase 4 恰好 5 次 ⇒ **不**推翻（spec 写的是 > 5）', d3a.verdict === 'ok' && d3a.buckets.phase4L0L1 === 5, `verdict=${d3a.verdict} p4=${d3a.buckets.phase4L0L1}`)
const d3b = M.computeChangeRate(mkPhase4Writes(6), phase4Recs, { now: NOW })
eq('D3b Phase 4 六次 ⇒ overturn', [d3b.verdict, d3b.overturnHit], ['overturn', true])

const d4 = M.computeChangeRate(
  [writeL1(DAY + H, 'L2'), writeL1(DAY + 2 * H, 'L1')],
  phase4Recs,
  { now: NOW }
)
ok(
  'D4 ★L2 不计入 L0+L1（只进 l2 桶）',
  d4.buckets.l0l1Total === 1 && d4.buckets.l2Total === 1,
  `l0l1=${d4.buckets.l0l1Total} l2=${d4.buckets.l2Total}`
)

// 无 level 字段（真链 seq 4/5 的形态）
const noLevelRec = g({ ts: iso(DAY + 3 * H), decision: 'allow', tool: 'fde_ontology_write', operation: 'update' })
const d5 = M.computeChangeRate([noLevelRec], phase4Recs, { now: NOW })
ok(
  'D5 ★★ 无 level 的写入**不静默丢**：单列 noLevel、不计入、note 给出上界',
  d5.buckets.noLevelTotal === 1 &&
    d5.buckets.l0l1Total === 0 &&
    d5.confidence === 'proxy' &&
    d5.note.includes('下界'),
  `noLevel=${d5.buckets.noLevelTotal} l0l1=${d5.buckets.l0l1Total} conf=${d5.confidence}`
)

const d6 = M.computeChangeRate(mkPhase4Writes(2), [adv('10', '11', 0)], { now: NOW })
ok(
  'D6 ★ Phase 4 缺席 ⇒ phase4L0L1 === null 且 note 写明"未被评估"',
  d6.buckets.phase4L0L1 === null && d6.note.includes('未被评估') && d6.verdict !== 'overturn',
  `p4=${d6.buckets.phase4L0L1} verdict=${d6.verdict}`
)

const d7 = M.computeChangeRate(
  [g({ ts: iso(DAY + H), decision: 'deny', tool: 'fde_ontology_write', level: 'L0' })],
  phase4Recs,
  { now: NOW }
)
ok('D7 ★反向 被拒的降级尝试（deny）不计入', d7.buckets.l0l1Total === 0, `l0l1=${d7.buckets.l0l1Total}`)

// ─────────────────────────────────────────────────────────────────────
console.log('\n[E. ④ ask 跳过率]')

const e1 = M.computeAskSkipRate([])
eq('E1 无 ask ⇒ insufficient-data', [e1.verdict, e1.value], ['insufficient-data', null])

const mkAsk = (outcome, i = 0) => p({ type: 'phase-advance-d4-ask', outcome, ts: iso(T0 + i * H) })
const e2 = M.computeAskSkipRate([mkAsk('degraded', 0), mkAsk('confirmed', 1), mkAsk('rejected', 2)])
near('E2 1 degraded / 3 ⇒ value 1/3', e2.value, 1 / 3)
ok(
  'E2b ★ rejected **不算跳过**（它是有效结论）且仍在分母里',
  e2.numerator === 1 && e2.denominator === 3 && e2.buckets.effective === 2,
  `num=${e2.numerator} den=${e2.denominator} eff=${e2.buckets.effective}`
)

const e3 = M.computeAskSkipRate([mkAsk('write-failed', 0), mkAsk('confirmed', 1)])
ok(
  'E3 ★ write-failed 单列（既非跳过也非有效）且**在分母里**',
  e3.buckets.other === 1 && e3.denominator === 2 && e3.numerator === 0 && e3.value === 0,
  `other=${e3.buckets.other} den=${e3.denominator} value=${e3.value}`
)

// 边界：spec 写的是 `> 30%`，所以恰好 30% **不许**推翻。
const askN = (skip, total) => [
  ...Array.from({ length: skip }, (_, i) => mkAsk('degraded', i)),
  ...Array.from({ length: total - skip }, (_, i) => mkAsk('confirmed', skip + i))
]
const e4a = M.computeAskSkipRate(askN(3, 10))
near('E4a 3/10 = 30% ⇒ value 0.3', e4a.value, 0.3)
eq('E4b ★边界 恰好 30% **不**推翻', [e4a.verdict, e4a.overturnHit], ['ok', false])
const e4c = M.computeAskSkipRate(askN(4, 10))
near('E4c 4/10 = 40% ⇒ value 0.4', e4c.value, 0.4)
eq('E4d 40% > 30% ⇒ overturn', [e4c.verdict, e4c.overturnHit], ['overturn', true])

// ─────────────────────────────────────────────────────────────────────
console.log('\n[F. ⑤ Phase 停留时长]')

const f1 = M.computePhaseDwell([])
eq('F1 无 advance ⇒ insufficient-data', [f1.verdict, f1.value], ['insufficient-data', null])

// 🔴 配对算的是"**被离开**的那个 Phase"：`1→2` 之后 `2→3` ⇒ 结束的是 **Phase 2**（5 天）。
//    Phase 1 的进入时刻在链外 ⇒ 它的停留**判不出来**，不该出现在表里。
//    （第一版期望写成 Phase 1 ⇒ 裸取下标崩掉，见 rowOf 的注释。）
const f2 = M.computePhaseDwell([adv('1', '2', 0), adv('2', '3', 5 * DAY)], { now: T0 + 6 * DAY })
ok('F2a 表里有 Phase 2', rowOf(f2.buckets.perPhase, '2') !== null, JSON.stringify(f2.buckets.perPhase.map((r) => r.phase)))
near('F2b 连续推进 ⇒ **Phase 2** 停留 5 天', rowOf(f2.buckets.perPhase, '2')?.avgDays, 5)
ok('F2c Phase 1 的进入时刻在链外 ⇒ 不出现在表里（不臆造）', rowOf(f2.buckets.perPhase, '1') === null)

// ★ 核心：Phase 1–4 无可配对段 ⇒ 必须 insufficient-data，而不是"0 天 ⇒ ok"
const f3 = M.computePhaseDwell([adv('6', '7', 0), adv('9', '10', 5 * DAY)], { now: T0 + 6 * DAY })
ok(
  'F3 ★★ Phase 1–4 无可配对段 ⇒ insufficient-data（**不是 0 天 + ok** —— 那是恒真判据）',
  f3.verdict === 'insufficient-data' && f3.value === null,
  `verdict=${f3.verdict} value=${f3.value}`
)
ok('F3b 跳号段被丢弃并计数', f3.buckets.unpaired === 1, `unpaired=${f3.buckets.unpaired}`)

const f4a = M.computePhaseDwell([adv('1', '2', 0), adv('2', '3', 15 * DAY)], { now: T0 + 16 * DAY })
eq('F4 ★边界 Phase 1–4 合计恰好 15 天 ⇒ 不推翻', f4a.verdict, 'ok')
const f4b = M.computePhaseDwell([adv('1', '2', 0), adv('2', '3', 15.1 * DAY)], { now: T0 + 16 * DAY })
eq('F4b 15.1 天 ⇒ overturn', f4b.verdict, 'overturn')

const f5 = M.computePhaseDwell([adv('1', '2', 0), adv('2', '3', 2 * DAY)], { now: T0 + 9 * DAY })
// ⚠️ 先断言"这个字段存在且是对象"**再**取属性 —— 只写 `!== null` 挡不住 `undefined`
//    （`undefined !== null` 为真 ⇒ `undefined.phase` 抛 TypeError ⇒ 整份报告消失，
//     与"断言抓住了"看起来都是"没通过"）。这条是变异 M21 实测抓出来的：重命名字段后
//     本套件原本是**崩溃**而不是断言红。
ok(
  'F5 ★ chainTail 单列且**不计入**平均（链尾 Phase 3）',
  typeof f5.buckets.chainTail === 'object' &&
    f5.buckets.chainTail !== null &&
    f5.buckets.chainTail.phase === '3' &&
    f5.buckets.perPhase.every((r) => r.phase !== '3'),
  JSON.stringify(f5.buckets.chainTail)
)
// ★★ 这一条钉的是**命名即断言**：字段名若叫 inProgress，就是在断言"现在正处在这个阶段"，
//    而本函数只读链、读不到 state.yaml（实测本机链尾 Phase 3 而 state.yaml Phase 10）。
//    双向判据：必须**不含**旧名 + 必须**含**权威声明。少了任一半都拦不住改名回头。
ok(
  'F5b ★★ 链尾字段**必须不叫** inProgress，且 note 必须声明它不是权威（含"权威是 state.yaml"）',
  f5.buckets.inProgress === undefined &&
    typeof f5.note === 'string' &&
    f5.note.includes('权威是 state.yaml') &&
    f5.note.includes('这不是'),
  `旧名残留=${f5.buckets.inProgress !== undefined} note=${typeof f5.note === 'string' ? f5.note.slice(0, 200) : f5.note}`
)

// ─────────────────────────────────────────────────────────────────────
console.log('\n[G. ⑥ 影子准确率（转调，不重算）]')

const g1 = M.shadowAccuracyMetric({})
eq('G1 空 stats ⇒ insufficient-data', [g1.verdict, g1.value], ['insufficient-data', null])

const g2 = M.shadowAccuracyMetric({ agree: 6, disagree: 4, rated: 10, accuracyPct: 60, overturn: true, verdict: 'overturn' })
eq('G2 60% < 70% ⇒ overturn', [g2.value, g2.verdict, g2.overturnHit], [60, 'overturn', true])

// 转调证明：传一个"不可能由本模块算出来"的值，看它是否原样透传
const g3 = M.shadowAccuracyMetric({ agree: 99, disagree: 1, rated: 100, accuracyPct: 99, overturn: false, verdict: 'ready' })
eq('G3 ★ value 原样来自 shadow-stats（证明是转调不是重算）', [g3.value, g3.verdict], [99, 'ok'])
ok('G3b note 里点明权威实现在 shadow-stats.js', g3.note.includes('shadow-stats.js'))

// ─────────────────────────────────────────────────────────────────────
console.log('\n[H. 工具层 fde_metrics]')

eq('H1 工具名常量', MT.METRICS, 'fde_metrics')

let captured = null
const stubCtx = {
  logger: { info() {}, warn() {} },
  tools: {
    register(def) {
      captured = def
      return () => {}
    }
  }
}
const tmp = mkdtempSync(join(tmpdir(), 'fde-e5-'))
const cfg = { auditPath: join(tmp, 'gate.jsonl'), phaseAuditPath: join(tmp, 'phase.jsonl') }
MT.installMetricsTools(stubCtx, cfg, { record: async () => ({ seq: 1 }) })
// 同 F5：先断言存在再取属性（`undefined !== null` 为真 ⇒ 裸取会崩掉整份报告）
ok('H2 注册了且只注册了一个工具', typeof captured === 'object' && captured !== null && captured.name === 'fde_metrics', captured?.name)

const props = captured?.output?.schema?.properties ?? {}
ok(
  'H3 ★ value/numerator/denominator 都是 **string**（"无数据"要能表达，number 装不下 null）',
  props.metrics?.items?.properties?.value?.type === 'string' &&
    props.metrics?.items?.properties?.numerator?.type === 'string' &&
    props.metrics?.items?.properties?.denominator?.type === 'string',
  JSON.stringify(Object.keys(props.metrics?.items?.properties ?? {}))
)
ok(
  'H3b 每个 object 节点都写了 additionalProperties（真 DSL 硬要求，缺即 defineTool 抛错）',
  captured.output.schema.additionalProperties === false &&
    props.metrics?.items?.additionalProperties === false,
  `root=${captured.output.schema.additionalProperties} items=${props.metrics?.items?.additionalProperties}`
)

// 空目录 ⇒ 全 insufficient-data，工具**不崩**、也不报 0%
const out = await captured.execute({ reason: '离线自测' }, { callId: 'c1' })
ok(
  'H4 ★ 工具在空链上返回 no-data（不崩、不报 0%）',
  out.verdict === 'no-data' && out.metrics.every((m) => m.value === '—' && m.verdict === 'insufficient-data'),
  `verdict=${out.verdict} values=${out.metrics.map((m) => m.value).join(',')}`
)
ok('H5 message 里没有人话形式的 0.0%（红线在呈现层也成立）', !out.message.includes('0.0%'), out.message.split('\n')[1] ?? '')

// ─────────────────────────────────────────────────────────────────────
console.log('\n[I. 跨包字面量对拍：phaseAuditPath ↔ phase 的 auditPath]')

const yml = readFileSync('E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/cordis.patch.yml', 'utf8')
const gatePhasePath = /phaseAuditPath:\s*'([^']+)'/.exec(yml)?.[1]
// phase 的 auditPath（在 dsh-fde-phase 条目下）—— 文件里只有一处 `auditPath:` 指向 phase.jsonl
const phaseAuditPath = /auditPath:\s*'([^']*phase\.jsonl)'/.exec(yml)?.[1]
ok('I1 gate 的 phaseAuditPath 已配置', typeof gatePhasePath === 'string' && gatePhasePath.length > 0, gatePhasePath)
eq('I2 ★ 它与 phase 的 auditPath 指向**同一个文件**（两处字面量，跨插件不 import）', gatePhasePath, phaseAuditPath)

// ─────────────────────────────────────────────────────────────────────
rmSync(tmp, { recursive: true, force: true })

console.log('\n=== 总结 ===')
console.log('PASS ' + PASS + ' / FAIL ' + FAIL.length)
if (FAIL.length > 0) {
  console.log('FAILED:')
  for (const f of FAIL) console.log('  - ' + f)
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
