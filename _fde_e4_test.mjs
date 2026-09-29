// E4 离线套件：影子模式统计（dsh-fde-ontology-gate/lib/shadow-stats.js）。
//
// 只测**纯函数** computeShadowStats —— 它是裁决的全部逻辑，边界可穷举。
// 两个 IO helper（readChainRecords / listArchivedSegments）在活验层用真链测。
//
// 运行：node _fde_e4_test.mjs
// 结果：_fde_e4_out.txt（非空 + 含 RESULT 行 —— 见 README §10.4 的两个形状纪律）
//
// 🔴 形状纪律（本轮沿用 E3 固化的两条）：
//   ① **登记序 = 输出序**：每条用例先占槽位、再写结论；渲染在最后统一做。
//      这样将来加 async 用例时，结论不会先于断言落盘（E3 第一版就栽在这上面）。
//   ② `out.txt` 必须**非空且含 RESULT 行** —— 0 字节的 out.txt 会被读成"跑过了"。
import { writeFileSync } from 'node:fs'
import {
  computeShadowStats,
  ADMIT_PCT,
  OVERTURN_PCT,
  WINDOW_MS
} from './dsh-fde-ontology-gate/lib/shadow-stats.js'

// ───────────────────────── 槽位式输出 ─────────────────────────
const slots = []
const section = (title) => slots.push({ kind: 'section', title })
const info = (text) => slots.push({ kind: 'info', text })
let failures = 0

/**
 * 登记一条断言（**先占槽位**，结论写在槽位里 —— 渲染时才读）。
 * @param {string} name
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} [note]
 */
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

let seq = 0
/** 造一条 shadow-deny */
const sd = (tsMs, extra = {}) => ({
  seq: ++seq,
  ts: iso(tsMs),
  decision: 'shadow-deny',
  tool: 'write',
  reason: '路径命中受保护区',
  ...extra
})
/** 造一条 shadow-judged */
const jd = (refSeq, verdict, extra = {}) => ({
  seq: ++seq,
  ts: iso(T0 + 8 * DAY),
  decision: 'shadow-judged',
  refSeq,
  verdict,
  reason: '逐条确认',
  ...extra
})
/** n 条 shadow-deny + 对应 n 条 agree 标注（完全自洽的达标形状） */
function spanFixture(days, n, verdict = 'agree') {
  const recs = []
  for (let i = 0; i < n; i++) {
    const r = sd(T0 + (days * DAY * i) / Math.max(1, n - 1))
    recs.push(r)
    recs.push(jd(r.seq, verdict))
  }
  return recs
}

// ═══════════════════ §1 缺席分档（三层，最易漏的是第三层） ═══════════════════
section('§1 缺席分档：读不到 / 真的空 / 有坏行 —— 三者不许压成同一个结论')

const sRead = computeShadowStats([], { readError: '审计链文件不存在：X', chainPath: 'X' })
t('链读不到 ⇒ verdict=unreadable（**不是** no-data）', sRead.verdict, 'unreadable')
t('链读不到 ⇒ 不 ready', sRead.ready, false)
t(
  '链读不到 ⇒ blocker 里带出原文（读者才知道是读不到、不是没有样本）',
  sRead.blockers.some((b) => b.includes('审计链文件不存在')),
  true
)

const sEmpty = computeShadowStats([], { chainPath: 'Y' })
t('链可读但为空 ⇒ verdict=no-data', sEmpty.verdict, 'no-data')
t('无样本时准确率是 null（**不是 0** —— 0 会被读成"准确率 0%"）', sEmpty.accuracyPct, null)
t('无样本 ⇒ 不 ready + 有 blocker', [sEmpty.ready, sEmpty.blockers.length > 0], [false, true])

const sBad = computeShadowStats(spanFixture(8, 3), { badLines: 2 })
t('有坏行 ⇒ 不 ready（坏行让样本静默变少）', sBad.ready, false)
t('有坏行 ⇒ blocker 报出条数', sBad.blockers.some((b) => b.includes('2 行无法解析')), true)

// ═══════════════════ §2 时间窗：恰 7 天必须算过，6.99 天不算 ═══════════════════
section('§2 窗口：spec §12 的"连续 7 天"按最早→最晚的跨度落地')

t('恰 7 天 ⇒ windowOk', computeShadowStats(spanFixture(7, 3)).windowOk, true)
t(
  '6.99 天 ⇒ windowOk=false（边界不许四舍五入蒙过去）',
  computeShadowStats([sd(T0), sd(T0 + 7 * DAY - 1000)]).windowOk,
  false
)
t('单条样本 ⇒ 跨度为 0 ⇒ 不达标', computeShadowStats([sd(T0)]).windowOk, false)
t('WINDOW_MS 常量 = 7×24h（判据与常量同源，改一个必须改另一个）', WINDOW_MS, 604800000)

// ═══════════════════ §3 两个阈值的边界（80 严格大于 / 70 严格小于） ═══════════════════
section(`§3 阈值边界：准入 >${ADMIT_PCT}%（严格）与推翻 <${OVERTURN_PCT}%（严格）是**两个数**`)

// 恰 80% 要 8/10 这种整比，用 mixFixture 直接构造（spanFixture 只能造全 agree）
function mixFixture(days, agreeN, disagreeN) {
  const recs = []
  const total = agreeN + disagreeN
  for (let i = 0; i < total; i++) {
    const r = sd(T0 + (days * DAY * i) / Math.max(1, total - 1))
    recs.push(r)
    recs.push(jd(r.seq, i < agreeN ? 'agree' : 'disagree'))
  }
  return recs
}

const sExact80 = computeShadowStats(mixFixture(8, 8, 2))
t('恰 80%（8/10）⇒ accuracyPct = 80', sExact80.accuracyPct, 80)
t(`恰 ${ADMIT_PCT}% ⇒ admitOk=false（spec 写的是"**>** 80%"）`, sExact80.admitOk, false)
t('恰 80% ⇒ 在灰区：不 ready 但**不** overturn（门禁没坏，只是不够切）', [sExact80.verdict, sExact80.overturn], ['not-ready', false])

const s81 = computeShadowStats(mixFixture(8, 17, 4))
t('81%（17/21）⇒ admitOk=true', s81.admitOk, true)
t('81% + 跨度够 + 全标注 ⇒ ready', s81.verdict, 'ready')

const sExact70 = computeShadowStats(mixFixture(8, 7, 3))
t('恰 70%（7/10）⇒ overturn=false（spec 写的是"**<** 70%"）', sExact70.overturn, false)

const s69 = computeShadowStats(mixFixture(8, 9, 4))
t('69.2%（9/13）⇒ overturn=true', s69.overturn, true)
t('被推翻 ⇒ verdict=overturn（与 not-ready 分开：这不是"再攒点数据"）', s69.verdict, 'overturn')
t(
  '被推翻 ⇒ blocker 明说"门禁不成熟"（spec §14 的原话，不是"样本不够"）',
  s69.blockers.some((b) => b.includes('门禁还不成熟')),
  true
)

// ═══════════════════ §4 标注的四种坏形状 ═══════════════════
section('§4 标注：未标注 / 指空 / 重复 / 残缺 —— 每一种都不许静默')

const r1 = sd(T0)
const r2 = sd(T0 + 8 * DAY)
const sPending = computeShadowStats([r1, r2, jd(r1.seq, 'agree')])
t('有未标注项 ⇒ pending 正确', sPending.pending, 1)
t('有未标注项 ⇒ 不 ready（spec §12：须逐条确认**所有**历史项）', sPending.ready, false)
t(
  '未标注 ⇒ blocker 写出"尚有 N 项未逐条确认"',
  sPending.blockers.some((b) => b.includes('尚有 1 项未逐条确认')),
  true
)

const sOrphan = computeShadowStats([r1, r2, jd(r1.seq, 'agree'), jd(r2.seq, 'agree'), jd(9999, 'agree')])
t('标注指向不存在的样本 ⇒ orphanJudged 计数', sOrphan.anomalies >= 1, true)
t('指空的标注**不**计入分子（认同数仍是 2）', sOrphan.agree, 2)
t('指空的标注 ⇒ blocker', sOrphan.blockers.some((b) => b.includes('指向不存在的 shadow-deny')), true)

const sDup = computeShadowStats([r1, r2, jd(r1.seq, 'agree'), jd(r1.seq, 'disagree'), jd(r2.seq, 'agree')])
t('同一条被标两次 ⇒ 取**第一条**（append-only，既成结论不许改判）', [sDup.agree, sDup.disagree], [2, 0])
t('重复标注 ⇒ blocker 报出', sDup.blockers.some((b) => b.includes('重复确认')), true)

const sMal = computeShadowStats([r1, jd(r1.seq, 'maybe')])
t('verdict 非法（不是 agree/disagree）⇒ 计为残缺', sMal.blockers.some((b) => b.includes('verdict 非法')), true)
t('残缺标注 ⇒ 不 ready', sMal.ready, false)

// ═══════════════════ §5 不变量：ready ⟺ 无 blocker ═══════════════════
section('§5 不变量：ready 与 blockers 的关系必须双向成立')

const readyCase = computeShadowStats(spanFixture(8, 3))
t('达标用例确实 ready（否则下面两条不变量是空转）', readyCase.verdict, 'ready')
t('ready ⇒ blockers 为空', readyCase.blockers.length, 0)
t(
  'ready ⇒ 仍有 warnings（归档/最大间隔这类"须知"不阻断但必须可见）',
  readyCase.warnings.length > 0,
  true
)
t(
  'warnings 里明说"未校验中间空档"（不假装实现了"连续"）',
  readyCase.warnings.some((w) => w.includes('未校验中间是否')),
  true
)

// 全量用例的通用不变量：verdict !== ready ⇒ blockers 非空（不许出现"默默不 ready"）
const all = [sRead, sEmpty, sBad, sExact80, s81, sExact70, s69, sPending, sOrphan, sDup, sMal, readyCase]
t(
  '通用：所有 verdict !== ready 的用例，blockers 都非空（不许"默默不 ready"）',
  all.filter((s) => s.verdict !== 'ready').every((s) => s.blockers.length > 0),
  true
)
t(
  '通用：所有 ready 的用例，blockers 都为空',
  all.filter((s) => s.verdict === 'ready').every((s) => s.blockers.length === 0),
  true
)

// ═══════════════════ §6 缺字段的样本（缺席第三层） ═══════════════════
section('§6 样本自身缺字段：缺 ts / 缺 seq / seq 重号')

const sUndated = computeShadowStats([
  { seq: 1, decision: 'shadow-deny', tool: 'w' },
  { seq: 2, ts: iso(T0), decision: 'shadow-deny', tool: 'w' }
])
t('缺 ts ⇒ 不进窗口，且计为未标注日期', sUndated.blockers.some((b) => b.includes('缺 / 坏 ts')), true)

const sUnseqed = computeShadowStats([{ ts: iso(T0), decision: 'shadow-deny', tool: 'w' }])
t('缺 seq ⇒ 无法被逐条确认 ⇒ blocker', sUnseqed.blockers.some((b) => b.includes('缺 seq')), true)

const sDupSeq = computeShadowStats([sd(T0, { seq: 7 }), sd(T0 + 8 * DAY, { seq: 7 })])
t('seq 重号 ⇒ blocker', sDupSeq.blockers.some((b) => b.includes('seq 重号')), true)

// FDE_INVERT=1 ⇒ 真注入一条**注定失败**的断言，让退出码与 out.txt **同时**变红。
// ⚠️ 不许只改退出码、不改产物：那会留下"文件写全过、退出码却是 1"的自相矛盾产物，
//    读者没法判断是套件坏了还是环境坏了。（E3 套件采用同一形态：INVERT ⇒ 计数里多一条 FAIL。）
if (process.env.FDE_INVERT === '1') {
  t('[INVERT] 故意失败以验证退出码敏感', 'invert', 'not-invert')
}

// ───────────────────────── 渲染（登记序 = 输出序） ─────────────────────────
const out = []
for (const s of slots) {
  if (s.kind === 'section') out.push('', s.title)
  else if (s.kind === 'info') out.push('  · ' + s.text)
  else {
    out.push(`  ${s.ok ? '✅' : '❌'} ${s.name}`)
    if (!s.ok) out.push(`      actual   = ${s.actual}`, `      expected = ${s.expected}`)
  }
}
const total = slots.filter((s) => s.kind === 'assert').length
out.push('', `RESULT: PASS ${total - failures} / FAIL ${failures}（共 ${total} 条断言）`)

const text = out.join('\n') + '\n'
writeFileSync('_fde_e4_out.txt', text, 'utf8')
process.stdout.write(text)

process.exitCode = failures > 0 ? 1 : 0
