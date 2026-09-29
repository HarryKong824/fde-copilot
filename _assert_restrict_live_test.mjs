/**
 * 活体 restrict 断言器 · 离线回归套件（P1-11，第 18 套）
 *
 * 断言的是 `_assert_restrict_live.mjs` 的**判定逻辑本身**（`buildChecks` / `extractHeaders` /
 * `parseArgs`）—— 不是"它能连上 DSH"，而是**它对坏样本会说红**。
 *
 * 为什么要这一套（0027 §4 / §5.1）：
 *   - 0026 查出 8 个 header 观测脚本**全族 fail-open**；`_assert_restrict_live.mjs` 是第二批验收
 *     **唯一**的原文级判据，它自己不能被"没给参数 ⇒ 没检查"这类缺口架空。
 *   - P1-11 新加的三处（显式缺席判红 / 不传 baseline 也要有判据 / `--require` 只从参数进）
 *     **每一条都必须有一个能让它红的合成样本** —— 否则它就是"写了但没人验过"的断言。
 *
 * 纪律：套件必须能被证伪（`FDE_INVERT=1` ⇒ 必须变红）。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  isEntryModule,
  buildChecks,
  extractHeaders,
  parseArgs,
  toolsOf,
  diffTools,
  auditBeforeHeader,
  contaminationNotice,
  verdictLine,
  windowOf,
  FRESH_REASONS
} from './_assert_restrict_live.mjs'

const lines = []
let passed = 0
let failed = 0

function check(name, cond, detail) {
  if (cond) {
    passed++
    lines.push(`  ✅ ${name}`)
  } else {
    failed++
    lines.push(`  🔴 ${name}${detail === undefined ? '' : `  ← ${JSON.stringify(detail)}`}`)
  }
}

/** 断言"某条名字含 kw 的检查 **存在且为 false**"（判红必须真的挂在那条上，不是靠别的条带红） */
function checkRedNamed(r, kw) {
  const hit = r.checks.filter(([nm]) => nm.includes(kw))
  check(`存在名为「…${kw}…」的检查`, hit.length === 1, r.checks.map(([nm]) => nm))
  check(`「…${kw}…」这条**判红**`, hit.length === 1 && hit[0][1] === false, hit[0])
}
/** 断言"某条名字含 kw 的检查 **存在且为 true**" */
function checkGreenNamed(r, kw) {
  const hit = r.checks.filter(([nm]) => nm.includes(kw))
  check(`存在名为「…${kw}…」的检查`, hit.length === 1, r.checks.map(([nm]) => nm))
  check(`「…${kw}…」这条**判绿**`, hit.length === 1 && hit[0][1] === true, hit[0])
}

/**
 * 取某条具名检查的**布尔值**（找不到/不唯一 ⇒ `undefined`）。
 *
 * 🔴 P1-12 的同一条纪律：不许写 `r.checks.filter(...)[0][1]` ——
 * 那条 push 一旦被删（或被改名），`[0]` 是 `undefined` ⇒ `[1]` 抛 **TypeError**
 * ⇒ 整份报告一条都输出不了，**"崩溃"被当成了"判红"**。
 * （我 0030 这轮新写的 N 组就又写了一次，被 M12 变异打成崩溃才暴露 —— 说明这条只改了一半的地方。
 *  现在两处都走 helper，且 helper 返回 undefined 而不是抛。）
 */
function flagOf(r, kw) {
  const hit = r.checks.filter(([nm]) => nm.includes(kw))
  return hit.length === 1 ? hit[0][1] : undefined
}
/** 取某条具名检查的**名字**（找不到/不唯一 ⇒ `''`），理由同上 */
function nameOf(r, kw) {
  const hit = r.checks.filter(([nm]) => nm.includes(kw))
  return hit.length === 1 ? hit[0][0] : ''
}

// ── 夹具 ────────────────────────────────────────────────────────────────────
const h = (seq, reason, data) => ({ seq, reason, data })
const withTools = (seq, reason, names) =>
  h(seq, reason, { header: { tools: names.map((x) => ({ name: x })) }, reason })
const noToolsKey = (seq, reason) => h(seq, reason, { header: { config: { model: 'x' } }, reason })
const emptyTools = (seq, reason) => h(seq, reason, { header: { tools: [] }, reason })
const malformedTools = (seq, reason) => h(seq, reason, { header: { tools: 'oops' }, reason })

const FULL = ['read', 'write', 'pwsh', 'fde_phase_advance']

/** 分页视窗夹具（P1-16：`session/page` 只给最近 N 条，`hasMore:true` 表示还有更早的） */
const WIN = (firstSeq, hasMore = false) => ({ firstSeq, hasMore, records: 497 })

// ── 前置：被 import 的模块不得自作主张跑 RPC ─────────────────────────────────
lines.push('A 组 · 前置：import 不得触发 RPC（否则本套件一条断言都跑不到）')
check('isEntryModule() === false', isEntryModule() === false, isEntryModule())
check('buildChecks 对空输入不抛异常', (() => {
  try {
    buildChecks({ headers: [], expect: 'without' })
    return true
  } catch {
    return false
  }
})())

// ── P1-11 ①：显式缺席判红 ───────────────────────────────────────────────────
lines.push('')
lines.push('B 组 · P1-11① 显式缺席判红（原来只靠 "read 仍在" 间接捕获）')
{
  // 缺席：tools 键整个没有。老判据（hasRead）也会红 ⇒ 必须证明**新增那条自己会红**
  const r = buildChecks({ headers: [noToolsKey(1, 'initial')], expect: 'without' })
  checkRedNamed(r, 'tools 键**存在**')
  check('缺席 ⇒ 整组 HAS-FAIL', r.bad > 0, r.bad)
}
{
  // 空数组：`tools` 键在、长度 0 ⇒ 缺席检查**绿**，由另一条具名检查（read 仍在）判红
  // ⚠️ P1-12：这里原来写的是 `r.checks.find(...)[1] === true` —— 一旦那条 push 被删，
  // `find()` 返回 undefined ⇒ `[1]` 抛 TypeError ⇒ **整份报告一条都不输出**（用崩溃当判据）。
  // 现在全部走 checkGreenNamed/checkRedNamed（带 `hit.length === 1` 守卫，且顺带断言"该条存在"）。
  const r = buildChecks({ headers: [emptyTools(1, 'initial')], expect: 'without' })
  checkGreenNamed(r, 'tools 键**存在**')
  checkRedNamed(r, '清单没被整体搞空')
}
{
  // malformed：tools 不是数组 ⇒ malformed 那条红，缺席那条绿
  const r = buildChecks({ headers: [malformedTools(1, 'initial')], expect: 'without' })
  checkRedNamed(r, 'malformed')
  checkGreenNamed(r, 'tools 键**存在**')
  checkRedNamed(r, '清单没被整体搞空')
}
{
  // 反向：正常 header ⇒ 缺席那条绿（防止写成"永远红"）
  const r = buildChecks({ headers: [withTools(1, 'initial', FULL)], expect: 'with' })
  checkGreenNamed(r, 'tools 键**存在**')
}

// ── P1-11 ②：不传 baseline 也要有判据 ───────────────────────────────────────
lines.push('')
lines.push('C 组 · P1-11② 不传 baselineSeq 时也必须有一条判据（原来整块被 if 包住）')
{
  // 坏样本：最后一条 reason='change'（中途变过），不传 baseline ⇒ 老版本这里**一条判据都没有**
  const r = buildChecks({
    headers: [withTools(1, 'initial', FULL), withTools(2, 'change', ['read', 'write'])],
    expect: 'without'
  })
  checkRedNamed(r, '未给 baseline')
  check('FRESH_REASONS 就是 {initial,resume}', JSON.stringify(FRESH_REASONS) === '["initial","resume"]', FRESH_REASONS)
}
{
  const r1 = buildChecks({ headers: [withTools(1, 'initial', ['read'])], expect: 'without' })
  const r2 = buildChecks({ headers: [withTools(1, 'resume', ['read'])], expect: 'without' })
  checkGreenNamed(r1, '未给 baseline')
  checkGreenNamed(r2, '未给 baseline')
}
{
  // 传了 baseline ⇒ 不该再出现"未给 baseline"那条（两条判据互斥，别叠在一起各说各话）
  const r = buildChecks({
    headers: [withTools(1, 'initial', FULL), withTools(2, 'change', ['read', 'write'])],
    expect: 'without',
    baselineSeq: 1
  })
  check('传 baseline ⇒ 不出现「未给 baseline」那条', r.checks.filter(([nm]) => nm.includes('未给 baseline')).length === 0)
}

// ── P1-11 ③：--require 只从参数进 ───────────────────────────────────────────
lines.push('')
lines.push('D 组 · P1-11③ --require 只从参数进，且**不许内置默认清单**')
{
  const r = buildChecks({ headers: [withTools(1, 'initial', ['pwsh'])], expect: 'with', require: ['read'] })
  checkRedNamed(r, '点名的必需工具都在')
}
{
  const r = buildChecks({ headers: [withTools(1, 'initial', FULL)], expect: 'with', require: ['read', 'write'] })
  checkGreenNamed(r, '点名的必需工具都在')
}
{
  // n=1 的专用会话（实测有 7 个）：不传 require 时**不得**因为"只有 1 个工具"判红。
  // 注意 expect/target 要自洽：这里断的是"没有 pwsh"，不是"有 pwsh"。
  const r = buildChecks({ headers: [withTools(1, 'initial', ['read'])], expect: 'without' })
  check(
    '不传 require ⇒ **一条 require 检查都不加**（无内置默认清单；那 7 个 n=1 专用会话会误报）',
    r.checks.filter(([nm]) => nm.includes('点名的必需工具')).length === 0 && r.hasRequireCheck === false,
    r.checks.map(([nm]) => nm)
  )
  check('不传 require ⇒ n=1 的会话仍判绿（不擅自发明阈值）', r.bad === 0, r.checks.filter(([, ok]) => !ok))
}
{
  const a = parseArgs(['sid', 'without', '', '', '--require=read,write'])
  check('parseArgs 能同时吃位置参数与 --require', a.require.join(',') === 'read,write' && a.baselineSeq === null, a)
  check('parseArgs 第 4 位空串 ⇒ target 回落 pwsh（不是空串）', a.target === 'pwsh', a.target)
  const b = parseArgs(['sid', 'with', '12', 'pwsh', '--require=a,b'])
  check(
    'parseArgs 完整形态',
    b.sid === 'sid' && b.expect === 'with' && b.baselineSeq === 12 && b.target === 'pwsh' && b.require.join(',') === 'a,b',
    b
  )
  const c = parseArgs(['sid', 'without'])
  check('parseArgs 不传 --require ⇒ require=[]', Array.isArray(c.require) && c.require.length === 0, c.require)
}

// ── 反向：假绿陷阱（这批是"看起来会过、其实不该过"的）────────────────────────
lines.push('')
lines.push('E 组 · 假绿陷阱（每条都必须红，否则本仪器就是 fail-open）')
{
  // 一条 header 都没有：老版本仍会"至少读到一条"红，但其余全绿；新版本缺席/malformed 也该红
  const r = buildChecks({ headers: [], expect: 'without' })
  checkRedNamed(r, '至少读到一条')
  checkRedNamed(r, 'tools 键**存在**')
  check('空 headers ⇒ 整组 HAS-FAIL（"没验过"不许判绿）', r.bad > 0, r.bad)
}
{
  // "从无到无"：baseline 那条本来就没有 pwsh ⇒ 反锁必须红（否则"天生没有"会被当成"被摘掉"）
  const r = buildChecks({
    headers: [withTools(1, 'initial', ['read', 'write']), withTools(2, 'change', ['read', 'write'])],
    expect: 'without',
    baselineSeq: 1
  })
  checkRedNamed(r, '反锁')
  check('「从无到无」整组 HAS-FAIL', r.bad > 0, r.bad)
}
{
  // 给了 baseline 但**没有新 header** ⇒ "清单压根没变"，必须红
  const r = buildChecks({
    headers: [withTools(1, 'initial', ['read', 'write'])],
    expect: 'without',
    baselineSeq: 1
  })
  checkRedNamed(r, '确实新增了 header')
}

// ── 正向：完整绿样本（防"写成永远红"）────────────────────────────────────────
lines.push('')
lines.push('F 组 · 完整绿样本（防反向 bug：写成永远红）')
{
  const r = buildChecks({
    headers: [withTools(1, 'initial', FULL), withTools(2, 'change', ['read', 'write', 'fde_phase_advance'])],
    expect: 'without',
    baselineSeq: 1,
    window: WIN(1)
  })
  check('判据 5 全绿（有→无 + change + 反锁）', r.bad === 0, r.checks.filter(([, ok]) => !ok))
}
{
  const r = buildChecks({
    headers: [withTools(1, 'initial', ['read', 'write']), withTools(2, 'change', FULL)],
    expect: 'with',
    baselineSeq: 1,
    window: WIN(1)
  })
  check('判据 4 全绿（无→有 + change）', r.bad === 0, r.checks.filter(([, ok]) => !ok))
}
{
  const r = buildChecks({ headers: [withTools(1, 'initial', ['read', 'write'])], expect: 'without' })
  check('判据 2 全绿（新开会话、无 pwsh）', r.bad === 0, r.checks.filter(([, ok]) => !ok))
}

// ── extractHeaders / toolsOf ────────────────────────────────────────────────
lines.push('')
lines.push('G 组 · 抽取与取名（原文级证据不能在中途被改形）')
{
  const recs = [
    { seq: 1, event: { type: 'user/message', data: { content: 'hi' } } },
    { seq: 2, event: { type: 'request/header', data: { header: { tools: [{ name: 'read' }] }, reason: 'initial' } } },
    // reason 在 **data 里面**（RPC 原文形状：`{type, data:{header, reason}}`）
    { seq: 3, event: { type: 'request/header', data: { header: { tools: ['pwsh'] }, reason: 'change' } } }
  ]
  const hs = extractHeaders(recs)
  check('只抽 request/header（3 条记录 ⇒ 2 条）', hs.length === 2, hs.length)
  check('嵌套 {event:{...}} 也能取到', hs[0].seq === 2 && hs[1].seq === 3, hs.map((x) => x.seq))
  check('tools 支持 [{name}] 与裸字符串两种形状', toolsOf(hs[0]).join() === 'read' && toolsOf(hs[1]).join() === 'pwsh', [
    toolsOf(hs[0]),
    toolsOf(hs[1])
  ])
  check('reason 保留（新判据要读它）', hs[0].reason === 'initial' && hs[1].reason === 'change', hs.map((x) => x.reason))
  check('缺席的 header 抽出来 toolsOf ⇒ []（不抛）', toolsOf({ data: { header: {} } }).length === 0)
}

// ── P2-15：端到端（穿过 extractHeaders → buildChecks）───────────────────────
lines.push('')
lines.push('H 组 · 端到端：`extractHeaders` → `buildChecks`（防"信息在管道中途被压平"）')
{
  // 真形状（reason 在 data 里）+ tools 键缺席 ⇒ 走完整条管道后必须仍判缺席红。
  // 这条能抓住 M7'：若 extractHeaders 把缺席压成 `tools: []`（只留算好的、不留 data），
  // 缺席检查会变绿 ⇒ 本条红。
  const recs = [
    { seq: 2, event: { type: 'request/header', data: { header: { config: { model: 'x' } }, reason: 'initial' } } }
  ]
  checkRedNamed(buildChecks({ headers: extractHeaders(recs), expect: 'without' }), 'tools 键**存在**')
}
{
  // 反向：真形状 + 正常 header ⇒ 走完整条管道后判绿（防写成永远红）
  const recs = [
    {
      seq: 2,
      event: { type: 'request/header', data: { header: { tools: [{ name: 'read' }, { name: 'write' }] }, reason: 'initial' } }
    }
  ]
  const r = buildChecks({ headers: extractHeaders(recs), expect: 'without', target: 'pwsh' })
  check('端到端绿样本（抽 → 判）', r.bad === 0, r.checks.filter(([, ok]) => !ok))
}
{
  // 端到端 + reason：新判据（②）也必须在管道末端仍读得到 reason
  const recs = [
    { seq: 1, event: { type: 'request/header', data: { header: { tools: [{ name: 'read' }] }, reason: 'initial' } } },
    { seq: 2, event: { type: 'request/header', data: { header: { tools: [{ name: 'read' }] }, reason: 'change' } } }
  ]
  checkRedNamed(buildChecks({ headers: extractHeaders(recs), expect: 'without' }), '未给 baseline')
}

// ── P1-16：分页视窗截断（"没读到" ≠ "天生没有"）─────────────────────────────
lines.push('')
lines.push('I 组 · P1-16 分页视窗截断（`session/page` 只给最近 N 条，回包自带 `hasMore`）')
{
  // 实测：`843e3bee` 磁盘 14 条 header，RPC 只给 12 条（hasMore=true、首条 seq=4409、丢的是最早两条）
  // ⇒ 若 baseline 落在视窗外，"反锁"会拿不到 baseline 那条 ⇒ 判成"从无到无" ⇒ **假红**（或更糟的假绿）
  const r = buildChecks({
    headers: [withTools(9000, 'change', ['read', 'write'])],
    expect: 'without',
    baselineSeq: 1374,
    window: WIN(4409, true)
  })
  checkRedNamed(r, 'baseline（seq=1374）在视窗内')
}
{
  const r = buildChecks({
    headers: [withTools(4741, 'initial', FULL), withTools(5000, 'change', ['read', 'write'])],
    expect: 'without',
    baselineSeq: 4741,
    window: WIN(4409, true)
  })
  checkGreenNamed(r, 'baseline（seq=4741）在视窗内')
}
{
  // fail-closed：**不传视窗信息** ⇒ 不许静默放过（否则调用方一忘，这条保护就没了）
  const r = buildChecks({
    headers: [withTools(1, 'initial', FULL), withTools(2, 'change', ['read', 'write'])],
    expect: 'without',
    baselineSeq: 1
  })
  checkRedNamed(r, 'baseline（seq=1）在视窗内')
}
{
  // 首条 seq 未知（视窗里一条记录都没有）⇒ 同样不许判绿
  const r = buildChecks({ headers: [], expect: 'without', baselineSeq: 1, window: WIN(null, true) })
  checkRedNamed(r, 'baseline（seq=1）在视窗内')
}
{
  // 不传 baseline ⇒ 不出现视窗那条（判据 2 不依赖"完整历史"）
  const r = buildChecks({ headers: [withTools(1, 'initial', ['read'])], expect: 'without', window: WIN(4409, true) })
  check(
    '不传 baseline ⇒ 不出现视窗那条（不误伤判据 2）',
    r.checks.filter(([nm]) => nm.includes('在视窗内')).length === 0,
    r.checks.map(([nm]) => nm)
  )
}

// ── P1-17：窗口污染（第三种结果：不是红也不是绿）────────────────────────────
lines.push('')
lines.push('J 组 · P1-17 窗口污染：新 header 是 `resume` ⇒ 判"污染"，不许判过也不许判红')
{
  // 真数据依据（`843e3bee` 磁盘全量）：`seq=1374 reason="resume" n=31 pwsh=out` ——
  // **清单变化不只伴随 change，也伴随 resume**（重启/重载会话同样会写一条 header）。
  // ⇒ 这条是 P1-17 的**主角样本**：目标确实没了，但没 change ⇒ 既不能绿也不能红。
  const r = buildChecks({
    headers: [withTools(10, 'initial', FULL), withTools(1374, 'resume', ['read', 'write', 'fde_phase_advance'])],
    expect: 'without',
    baselineSeq: 10,
    window: WIN(10)
  })
  check('污染样本：`contaminated` 非空（先断言非空，再断言内容）', typeof r.contaminated === 'string' && r.contaminated.length > 0, r.contaminated)
  check('污染 ⇒ verdict === "contaminated"（第三种结果）', r.verdict === 'contaminated', r.verdict)
  check(
    '污染 ⇒ **不把"必须有 change"算成红**（红会误导归因到"restrict 没生效"）',
    r.checks.filter(([nm]) => nm.includes('reason:"change"')).length === 0,
    r.checks.map(([nm]) => nm)
  )
  check('污染 ⇒ bad === 0（它**不是**红，是"无从归因"）', r.bad === 0, r.checks.filter(([, ok]) => !ok))
  check('污染文案点名了成因（resume / 重启）', /resume/.test(r.contaminated) && /重启/.test(r.contaminated), r.contaminated)
}
{
  // 反向：新 header 里有 change ⇒ 不污染，正常走断言
  const r = buildChecks({
    headers: [withTools(10, 'initial', FULL), withTools(500, 'change', ['read', 'write', 'fde_phase_advance'])],
    expect: 'without',
    baselineSeq: 10,
    window: WIN(10)
  })
  check('有 change ⇒ 不污染', r.verdict !== 'contaminated' && r.contaminated === null, r.contaminated)
  checkGreenNamed(r, 'reason:"change"')
}
{
  // 边界：**一条新 header 都没有** ⇒ 不是污染，是"清单压根没变" ⇒ 该红就红
  const r = buildChecks({ headers: [withTools(10, 'initial', ['read'])], expect: 'without', baselineSeq: 10, window: WIN(10) })
  check('无新 header ⇒ **不**判污染（那是"没变"，不是"变了但成因不明"）', r.contaminated === null, r.contaminated)
  checkRedNamed(r, '确实新增了 header')
}
{
  // 混合：既有 resume 又有 change ⇒ 有 change 就够了，不污染
  const r = buildChecks({
    headers: [
      withTools(10, 'initial', FULL),
      withTools(200, 'resume', FULL),
      withTools(500, 'change', ['read', 'write', 'fde_phase_advance'])
    ],
    expect: 'without',
    baselineSeq: 10,
    window: WIN(10)
  })
  check(
    'resume + change 混合 ⇒ **不**判污染（有 change 就够）',
    r.contaminated === null && r.verdict !== 'contaminated',
    { contaminated: r.contaminated, verdict: r.verdict, bad: r.bad }
  )
  checkGreenNamed(r, 'reason:"change"')
}
{
  // 混合 + 每条都没 target ⇒ 完整绿（防"只要出现 resume 就永远判污染"的反向 bug）
  const r = buildChecks({
    headers: [
      withTools(10, 'initial', FULL),
      withTools(200, 'resume', ['read', 'write', 'fde_phase_advance']),
      withTools(500, 'change', ['read', 'write', 'fde_phase_advance'])
    ],
    expect: 'without',
    baselineSeq: 10,
    window: WIN(10)
  })
  check('混合但"每条都没有 target" ⇒ 判绿（污染判定不是一刀切）', r.verdict === 'pass', r.verdict)
}
{
  // `with` 分支（判据 4）同样要受污染保护：重启后工具"回来"了也不能算数
  const r = buildChecks({
    headers: [withTools(10, 'initial', ['read', 'write']), withTools(200, 'resume', FULL)],
    expect: 'with',
    baselineSeq: 10,
    window: WIN(10)
  })
  check('判据 4 也会被重启污染（不是 only without 分支的事）', r.verdict === 'contaminated', r.verdict)
}

// ── P1-18：逐名 diff（默认只作信息，`--strict-diff` 才成断言）────────────────
lines.push('')
lines.push('K 组 · P1-18 逐名 diff：n 差 1 不够，还要"**只有**目标工具变"')
{
  const base = withTools(10, 'initial', FULL)
  const last = withTools(500, 'change', ['read', 'write', 'fde_phase_advance'])
  const d = diffTools(base, last)
  check('diff 算得出来（先断言非空）', d !== null, d)
  check('n 4 → 3', d && d.nFrom === 4 && d.nTo === 3, d)
  check('移除恰好 [pwsh]、新增为空', d && d.removed.join() === 'pwsh' && d.added.length === 0, d)
}
{
  // 🔴 不许把"缺席/非数组"压成 [] —— 那会算出"什么都没变"的假象（与 M7 同一个坑）
  check('tools 缺席 ⇒ diffTools 返回 null（不许冒充"没变动"）', diffTools(noToolsKey(10, 'initial'), withTools(500, 'change', FULL)) === null)
  check('tools 非数组 ⇒ 同样 null', diffTools(malformedTools(10, 'initial'), withTools(500, 'change', FULL)) === null)
  check('没 baseline ⇒ null', diffTools(undefined, withTools(500, 'change', FULL)) === null)
}
{
  // 默认（不传 strictDiff）⇒ **不加**这条断言（不擅自发明判据，与 P1-11③ 同一条纪律）
  const r = buildChecks({
    headers: [withTools(10, 'initial', FULL), withTools(500, 'change', ['read', 'write', 'fde_phase_advance'])],
    expect: 'without',
    baselineSeq: 10,
    window: WIN(10)
  })
  check(
    '默认 ⇒ 不加「逐名 diff」断言（只作信息）',
    r.checks.filter(([nm]) => nm.includes('逐名 diff')).length === 0,
    r.checks.map(([nm]) => nm)
  )
  check('默认 ⇒ diff 仍然算出来了（信息照给）', r.diff !== null && r.diff.removed.join() === 'pwsh', r.diff)
}
{
  // 开 --strict-diff：只有目标变 ⇒ 绿
  const r = buildChecks({
    headers: [withTools(10, 'initial', FULL), withTools(500, 'change', ['read', 'write', 'fde_phase_advance'])],
    expect: 'without',
    baselineSeq: 10,
    window: WIN(10),
    strictDiff: true
  })
  checkGreenNamed(r, '逐名 diff')
}
{
  // 🔴 开 --strict-diff 的**主角坏样本**：n 也差 1，但消失的是**别的**工具
  // （"另一个机制恰好摘掉同样数量的别的工具" ⇒ 只看 n 差 1 会假绿，这正是 P1-18 要挡的）
  const r = buildChecks({
    headers: [withTools(10, 'initial', FULL), withTools(500, 'change', ['read', 'pwsh', 'fde_phase_advance'])],
    expect: 'without',
    baselineSeq: 10,
    window: WIN(10),
    strictDiff: true
  })
  // ⚠️ P1-12 反模式第 4 次：`r.diff` 在算出不来时是 **null**（缺席 ⇒ null，不许压成 []），
  // 裸取 `.nFrom` 会 TypeError ⇒ 整份报告一条不输出。**先断言非 null，再取字段。**
  check(
    '先断言 diff **算得出来**（null ⇒ 缺席/读不到，不许当成 0）',
    r.diff !== null && typeof r.diff === 'object',
    r.diff
  )
  check('该样本 n 也是 4→3（先确认它"只看 n 会假绿"）', r.diff?.nFrom === 4 && r.diff?.nTo === 3, r.diff)
  checkRedNamed(r, '逐名 diff')
}
{
  // fail-closed：开了 --strict-diff 却算不出 diff ⇒ 判红，不许静默放过
  const r = buildChecks({
    headers: [noToolsKey(10, 'initial'), withTools(500, 'change', ['read'])],
    expect: 'without',
    baselineSeq: 10,
    window: WIN(10),
    strictDiff: true
  })
  checkRedNamed(r, '--strict-diff 要求逐名 diff')
}
{
  // `with` 分支：期望的是"新增 [target]、移除 []"
  const r = buildChecks({
    headers: [withTools(10, 'initial', ['read', 'write']), withTools(500, 'change', ['read', 'write', 'pwsh'])],
    expect: 'with',
    baselineSeq: 10,
    window: WIN(10),
    strictDiff: true
  })
  checkGreenNamed(r, '逐名 diff')
}

// ── P1-13：配对按**时间**（seq 是不同命名空间 ⇒ 恒真 ⇒ 系统性偏绿）──────────
lines.push('')
lines.push('L 组 · P1-13 配对原语：审计 `ts` vs header `time`（两侧类型不同，都要归一）')
{
  // 真数据（本轮实测）：审计 `gate.jsonl` seq=15 ts="2026-09-27T02:19:49.946Z" ⇒ 1790475589946
  //                    header `843e3bee` seq=22579 time=1790475588701
  // ⇒ **审计晚于 header** ⇒ 该比较为 false ⇒ 证明它不是"恒真"（放一条真反例在这，防止它退化成偏绿）
  check('真值：审计晚于 header ⇒ false（有反例 ⇒ 不恒真）', auditBeforeHeader(1790475589946, 1790475588701) === false)
  check('真值反号 ⇒ true（两侧可交换 ⇒ 不是常量）', auditBeforeHeader(1790475588701, 1790475589946) === true)
}
{
  // 实测形状：审计是 **ISO 字符串**，header 是 **epoch 毫秒 number**
  // ⚠️ 两个真值都取自本轮实测：`phase.jsonl` seq=2 ts="2026-09-27T01:56:17.523Z" ⇒ 1790474177523；
  //    header `843e3bee` seq=22579 time=1790475588701。**前者确实早于后者**（差 1412 s）。
  const ts = '2026-09-27T01:56:17.523Z'
  const time = 1790475588701
  check('审计侧 ISO 字符串可解析（先断言非空/有限，再断言比较）', Number.isFinite(Date.parse(ts)), Date.parse(ts))
  check('ISO ts 早于 epoch ms ⇒ true', auditBeforeHeader(ts, time) === true, [Date.parse(ts), time])
  check('反号 ⇒ false', auditBeforeHeader(time, ts) === false)
  // 🔴 单位/类型不匹配：把 epoch ms 当成**字符串**给审计侧 ⇒ Date.parse 解析不了 ⇒ 必须判 false（fail-closed）
  check('审计侧给数字字符串 ⇒ false（不许拿 NaN 静默变绿）', auditBeforeHeader(String(time), time) === false, Date.parse(String(time)))
}
{
  // fail-closed：任一侧不可解析 ⇒ false
  check('ts 为 undefined ⇒ false', auditBeforeHeader(undefined, 1790425633884) === false)
  check('time 为 undefined ⇒ false', auditBeforeHeader('2026-09-27T01:56:17.523Z', undefined) === false)
  check('两侧都垃圾 ⇒ false', auditBeforeHeader('not-a-date', NaN) === false)
  check('time 为 null ⇒ false', auditBeforeHeader('2026-09-27T01:56:17.523Z', null) === false)
}
{
  // extractHeaders 必须把 `time` 一起带过来 —— 否则配对无从计算（P1-13 的前置）
  const recs = [{ seq: 2, event: { type: 'request/header', time: 1790425633884, data: { header: { tools: ['read'] }, reason: 'change' } } }]
  const hs = extractHeaders(recs)
  check('抽到 1 条（先断言非空）', hs.length === 1, hs.length)
  check('`time` 被保留（epoch ms number）', hs[0]?.time === 1790425633884, hs[0]?.time)
  check('`time` 缺省 ⇒ null（不是 undefined 也不是 0）', extractHeaders([{ seq: 3, event: { type: 'request/header', data: { header: { tools: [] }, reason: 'x' } } }])[0]?.time === null)
}

// ── P1-19：两方向共用（原来 `with` 半边没有视窗 fail-closed、也没有反锁）──────────
lines.push('')
lines.push('N 组 · P1-19 与方向无关的 baseline 判据必须**两个方向都有**（`with` 半边原是裸奔）')
{
  // 🔴 主角红例（0030 §1 实测）：`with` + baseline 落在 RPC 视窗外
  // 实测命令：`… with 10` ⇒ **通过 7/7 / ALL-PASS / exit=0**（而 `without 10` 同 baseline ⇒ 4 FAIL / exit=1）
  const r = buildChecks({
    headers: [withTools(9000, 'change', FULL)],
    expect: 'with',
    baselineSeq: 1374,
    window: WIN(4409, true)
  })
  checkRedNamed(r, 'baseline（seq=1374）在视窗内')
  check('`with` 方向现在也会红了（不再是 ALL-PASS）', r.bad > 0 && r.verdict === 'fail', r.verdict)
}
{
  // 0053 §2 改动 ② 后：`base === undefined` 时反锁**红**（无对象可反），不再是绿。
  // 原来 `with` 的 `!has(undefined, target)` = true 是 bug —— baseline 缺席时反锁不应"通过"。
  // 现在视窗检查和反锁检查都红，两条各自独立判红（不互相依赖）。
  const r = buildChecks({
    headers: [withTools(9000, 'change', FULL)],
    expect: 'with',
    baselineSeq: 1374,
    window: WIN(4409, true)
  })
  checkRedNamed(r, '反锁')
  // ⚠️ 用 flagOf（找不到 ⇒ undefined），**不许** `[0][1]` —— 见 flagOf 的注释（P1-12）
  const lock = flagOf(r, '反锁')
  const win = flagOf(r, '在视窗内')
  check('`with` 半边：反锁**红**、视窗**红** ⇒ 两条各自独立判红（0053 改动 ② 后）', lock === false && win === false, {
    lock,
    win
  })
}
{
  // 反向：`with` + baseline 在视窗内 ⇒ 全绿（防写成永远红）
  const r = buildChecks({
    headers: [withTools(4741, 'initial', ['read', 'write']), withTools(5000, 'change', FULL)],
    expect: 'with',
    baselineSeq: 4741,
    window: WIN(4409, true)
  })
  checkGreenNamed(r, 'baseline（seq=4741）在视窗内')
  check('`with` 完整绿样本（无→有 + change + 视窗内）', r.bad === 0 && r.verdict === 'pass', r.verdict)
}
{
  // 反锁按方向取反：`with` ⇒ baseline 里**没有** target 才对；baseline 里**有** ⇒ "天生就有"，红
  const r = buildChecks({
    headers: [withTools(4741, 'initial', FULL), withTools(5000, 'change', FULL)],
    expect: 'with',
    baselineSeq: 4741,
    window: WIN(4409, true)
  })
  checkRedNamed(r, '反锁')
  const lockName = nameOf(r, '反锁')
  // 0053 改动 ② 后文案：`🔴 baseline 那条 header（seq<=N）里**有** pwsh（反锁要求"没有" ⇒ 判红）`
  check('`with` 的反锁文案含"**有**"且要求"没有"（判红语义）', lockName.includes('**有**') && lockName.includes('要求\"没有\"'), lockName)
}
{
  // 结构断言：给了 baseline ⇒ **两个方向**都必须各有 1 条「确实新增」/「在视窗内」/「反锁」
  // （这一条直接防"只写一半" —— P1-19 的形状就是"同一段逻辑只落在 if 的一个分支里"）
  for (const kw of ['确实新增了 header', '在视窗内', '反锁']) {
    const a = buildChecks({
      headers: [withTools(4741, 'initial', ['read', 'write']), withTools(5000, 'change', FULL)],
      expect: 'with',
      baselineSeq: 4741,
      window: WIN(4409)
    })
    const b = buildChecks({
      headers: [withTools(4741, 'initial', FULL), withTools(5000, 'change', ['read', 'write'])],
      expect: 'without',
      baselineSeq: 4741,
      window: WIN(4409)
    })
    const na = a.checks.filter(([nm]) => nm.includes(kw)).length
    const nb = b.checks.filter(([nm]) => nm.includes(kw)).length
    check(`「…${kw}…」两个方向各有且仅有 1 条（with=${na} / without=${nb}）`, na === 1 && nb === 1, [na, nb])
  }
}
{
  // 不传 baseline ⇒ 两个方向都不出现这三条（不误伤判据 2/4 的无 baseline 形态）
  for (const ex of ['with', 'without']) {
    const r = buildChecks({ headers: [withTools(1, 'initial', FULL)], expect: ex, window: WIN(1) })
    check(
      `不传 baseline（${ex}）⇒ 不出现「新增/视窗/反锁」三条`,
      r.checks.filter(([nm]) => nm.includes('确实新增了 header') || nm.includes('在视窗内') || nm.includes('反锁'))
        .length === 0,
      r.checks.map(([nm]) => nm)
    )
  }
}

lines.push('')
lines.push('O 组 · P2-18 **污染吞红**（0031 §2：`with 22578` 是 `通过 7/8` 却只报 CONTAMINATED）')
{
  // 真数据形状：`with` + baseline 里**有** target（反锁 ⇒ 红）+ 新增全是 resume（⇒ 污染）
  const red1 = buildChecks({
    headers: [withTools(4741, 'initial', FULL), withTools(5000, 'resume', FULL)],
    expect: 'with',
    baselineSeq: 4741,
    window: WIN(4409)
  })
  check('夹具自证：污染**且**有红（这正是被吞掉的那个组合）', red1.contaminated !== null && red1.bad > 0, {
    contaminated: red1.contaminated,
    bad: red1.bad
  })
  check('夹具自证：verdict 仍是 contaminated（**不是** fail）⇒ 红确实走不到退出码', red1.verdict === 'contaminated')

  const n1 = contaminationNotice(red1.checks, red1.bad)
  // ⚠️ 不许写 `n1[0].includes(…)`：M14（提示恒空）会让 `n1[0]` 变 undefined ⇒ TypeError ⇒
  // 整份报告一条不输出（**崩溃红伪装成结果**，P1-12 那条反模式的第三次复现）。一律用 join 取值。
  const joined1 = n1.join('\n')
  check(`bad=${red1.bad} ⇒ 提示行数 = 1（标题）+ ${red1.bad}（逐条名字）`, n1.length === 1 + red1.bad, n1)
  check(`提示里写明了条数「还有 ${red1.bad} 条红」`, joined1.includes(`还有 ${red1.bad} 条红`), n1)
  check('提示里**逐条列出了红的名字**（不是只报个数）', n1.length === 1 + red1.bad && n1.slice(1).every((l) => l.startsWith('      · ')), n1)
  check(
    '列出的名字里含「反锁」（0031 §2 实测被吞的那条）',
    n1.slice(1).some((l) => l.includes('反锁')),
    n1
  )
  check('提示写明「污染不解释它们」⇒ 不许被当成"重做就行"', joined1.includes('污染不解释它们'), n1)
}
{
  // 干净污染样本（bad=0）：不许打扰 ⇒ 空数组
  const clean = buildChecks({
    headers: [withTools(4741, 'initial', ['read', 'write']), withTools(5000, 'resume', FULL)],
    expect: 'with',
    baselineSeq: 4741,
    window: WIN(4409)
  })
  check('夹具自证：污染但**无**红', clean.contaminated !== null && clean.bad === 0, {
    contaminated: clean.contaminated,
    bad: clean.bad
  })
  check('bad=0 ⇒ 提示行**为空**（不加噪声）', contaminationNotice(clean.checks, clean.bad).length === 0)
  check('bad=0 ⇒ RESULT 行**不带**红条数后缀', !verdictLine(clean.verdict, clean.bad).includes('条红'))
}
{
  // 多条红：条数必须**等于** bad，不能只报 1 条
  const red2 = buildChecks({
    headers: [withTools(4741, 'initial', FULL), withTools(5000, 'resume', FULL)],
    expect: 'without',
    baselineSeq: 4741,
    window: WIN(4409)
  })
  check('夹具自证：污染 + 多条红', red2.contaminated !== null && red2.bad === 2, { bad: red2.bad })
  const n2 = contaminationNotice(red2.checks, red2.bad)
  check('bad=2 ⇒ 列出 2 条名字（不许只列第一条）', n2.length === 3 && n2.join('\n').includes('还有 2 条红'), n2)
  check('两条名字互不相同', new Set(n2.slice(1)).size === 2, n2.slice(1))
}
{
  // RESULT 行本身也要带条数（防"只 grep ^RESULT"的人 —— 0031 §5 第 14 次那个动作）
  check('contaminated + bad>0 ⇒ RESULT 带「另含 N 条红」', verdictLine('contaminated', 2) === 'RESULT: WINDOW-CONTAMINATED（另含 2 条红，见上）', verdictLine('contaminated', 2))
  check('contaminated + bad=0 ⇒ RESULT 就是 WINDOW-CONTAMINATED', verdictLine('contaminated', 0) === 'RESULT: WINDOW-CONTAMINATED')
  check('pass ⇒ ALL-PASS', verdictLine('pass', 0) === 'RESULT: ALL-PASS')
  check('fail ⇒ HAS-FAIL 且**不带**后缀（红已经体现在 HAS-FAIL 上）', verdictLine('fail', 3) === 'RESULT: HAS-FAIL', verdictLine('fail', 3))
}

// ── Q 组 · P2-20 视窗派生（原来在 `main()` 里 ⇒ 变异 M23 实测 147/0 全绿，测不到）
// 它是 P1-16 那条 fail-closed 判据的**唯一数据来源** ⇒ 数据源不可测 = 判据不可信。
lines.push('')
lines.push('Q 组 · 视窗派生 `windowOf`（P1-16 判据的数据源，必须可测）')
{
  const rec = (seq) => ({ event: { seq, type: 'request/header' } })
  const w = windowOf({ records: [rec(10), rec(20), rec(30)], hasMore: true })
  check('records 原样透出（下游 extractHeaders 要用）', w.recs.length === 3, w.recs.length)
  check('firstSeq = 首条 seq（P1-16 判据就靠它）', w.firstSeq === 10, w.firstSeq)
  check('lastSeq = 末条 seq', w.lastSeq === 30, w.lastSeq)
  check('records = 条数', w.records === 3, w.records)
  check('hasMore=true 时透出 true', w.hasMore === true, w.hasMore)
}
{
  // fail-closed 那一侧：空载荷 ⇒ firstSeq=null（⇒ buildChecks 的视窗检查必红，不许静默）
  const w = windowOf({ records: [], hasMore: false })
  check('空 records ⇒ firstSeq=null（不许 undefined / 0 冒充）', w.firstSeq === null, w.firstSeq)
  check('空 records ⇒ records=0', w.records === 0, w.records)
  check('hasMore=false ⇒ false', w.hasMore === false, w.hasMore)
}
{
  // 缺席 page（RPC 失败）⇒ 不许抛，且给"未知"形状（null / 0 / false）
  const w = windowOf(undefined)
  check('page 缺席 ⇒ 不抛，recs=[]', Array.isArray(w.recs) && w.recs.length === 0, w.recs)
  check('page 缺席 ⇒ firstSeq=null', w.firstSeq === null, w.firstSeq)
  check('page 缺席 ⇒ hasMore=false（不许 undefined）', w.hasMore === false, w.hasMore)
}
{
  // hasMore 必须严格 === true：回包里可能是 1 / "true" ⇒ 一律当**未知**，不许当"没截断"
  check('hasMore=1 ⇒ false（非严格 true 一律当未知，偏保守）', windowOf({ records: [], hasMore: 1 }).hasMore === false)
  check('hasMore="true" ⇒ false（同上）', windowOf({ records: [], hasMore: 'true' }).hasMore === false)
  check('hasMore 缺席 ⇒ false', windowOf({ records: [] }).hasMore === false)
}
{
  // 🔴 端到端：recs 恒空 ⇒ headers 恒空 ⇒ buildChecks 必红（"读不到"不许当"没有"）
  const w = windowOf({ records: [], hasMore: false })
  const r = buildChecks({ headers: extractHeaders(w.recs), expect: 'without', baselineSeq: 5, window: w })
  check('空视窗 ⇒ 整组必红（"至少读到一条"那条必须红）', r.bad > 0 && flagOf(r, '至少读到一条') === false, {
    bad: r.bad,
    那条: flagOf(r, '至少读到一条')
  })
}

// ================================================================ TO 组：终点也得钉（--through）
lines.push('## TO 组：锚有两端，--through 钉终点')

/**
 * 🔴 为什么用具名**动态** import 拿这批新导出（而不是加到顶部那条静态 import）：
 * 静态 import 一个还不存在的具名导出 ⇒ 整个文件在**链接期**就炸，
 * 看起来像"环境坏了"，读的人分不清是"功能还没实现"还是"我跑坏了"。
 * 动态 import 拿到 `undefined` ⇒ 红条带名字，这才是"改前红"该有的样子。
 */
const NEW_API = await import('./_assert_restrict_live.mjs')
const endpointOf = NEW_API.endpointOf


/**
 * 只给 baseline 时终点 = "最后一条"（=30）⇒ `without` 必然判红 —— 这正是 0037 的 C21 形状。
 * 给了 `--through=20` ⇒ 终点钉在 20 ⇒ 绿。
 */
const TO_HEADERS = [
  withTools(10, 'initial', FULL),
  withTools(20, 'change', ['read', 'write', 'fde_phase_advance']),
  withTools(30, 'change', FULL)
]

check('🔴 只给 baseline ⇒ 终点漂移（构造出的坏样本本身必须先红，否则这组白写）', (() => {
  const r = buildChecks({ headers: TO_HEADERS, expect: 'without', baselineSeq: 10, window: WIN(10) })
  return r.bad > 0
})(), TO_HEADERS.map((x) => x.seq))

check('🔴 给了 --through=20 ⇒ 同一批数据转绿（证明终点真的被钉住，不是"最后一条"）', (() => {
  const r = buildChecks({ headers: TO_HEADERS, expect: 'without', baselineSeq: 10, window: WIN(10), throughSeq: 20 })
  return r.verdict === 'pass' && r.bad === 0
})(), buildChecks({ headers: TO_HEADERS, expect: 'without', baselineSeq: 10, window: WIN(10), throughSeq: 20 }).checks)

check('🔴 --through 晚于最后一条 ⇒ **判红** fail-closed（不许悄悄退化成"最后一条"）', (() => {
  const r = buildChecks({ headers: TO_HEADERS, expect: 'without', baselineSeq: 10, window: WIN(10), throughSeq: 999 })
  // 0043 §9 改动 ①（Trae 2026-09-27）：原断言 `.length === 1` 是字符串长度恒 false；
  // 上一版（0042）改成 `.length > 0` 只验"检查存在" ⇒ M2 假绿（fail-closed 检查改恒绿仍能通过）。
  // 现按 0043 §3 的正确模式：**既验存在、又验判红** —— `.some(([nm,ok]) => nm.includes('终点锚') && ok===false)`
  // （与 :51/:57 的 checkRedNamed 同语义；保持 176 条断言不变）
  return r.bad > 0 && r.checks.some(([nm, ok]) => nm.includes('终点锚') && ok === false)
})(), null)

check('🔴 --through 之内一条 header 都没有 ⇒ 判红（而不是拿空集去验）', (() => {
  const r = buildChecks({ headers: TO_HEADERS, expect: 'without', baselineSeq: 10, window: WIN(10), throughSeq: 5 })
  // 0043 §9 改动 ②：加具名约束 —— throughSeq=5 ⇒ endpoint=null ⇒ 同一条「终点锚」检查必须判红
  // （M2 假绿场景：把 fail-closed 检查改恒绿，靠旁路 r.bad>0 仍能通过 ⇒ 必须具名约束）
  return r.bad > 0 && r.checks.some(([nm, ok]) => nm.includes('终点锚') && ok === false)
})(), null)

check('🔴 不给 --through 时，终点标签必须**当场写清它是时点性的**（规矩 9）', (() => {
  const e = endpointOf({ headers: TO_HEADERS, throughSeq: null })
  return e.pinned === false && String(e.label).includes('时点性')
})(), null)

check('🔴 给了 --through 时标签 pins 到该 seq', (() => {
  const e = endpointOf({ headers: TO_HEADERS, throughSeq: 20 })
  return e.pinned === true && e.seq === 20 && String(e.label).includes('20')
})(), null)

check('🔴 parseArgs 认得 --through=<seq>（且 MISSING ⇒ null，不是 0）', (() => {
  const a = parseArgs(['sid-x', 'without', '10', 'pwsh', '--through=20'])
  const b = parseArgs(['sid-x', 'without'])
  return a.throughSeq === 20 && b.throughSeq === null
})(), parseArgs(['sid-x', 'without', '10', 'pwsh', '--through=20']).throughSeq)

// ================================================================ OF 组：离线路径（--offline）
lines.push('## OF 组：判据仪器必须有离线路径（DSH 一停就不能核 = 白做）')

const { readTranscriptFile, findSessionDirs, pageFromOffline } = NEW_API

check('🔴 readTranscriptFile：单帧能读出全部事件', (() => {
  const dir = mkZstdSession([{ seq: 1, type: 'x', data: {} }, { seq: 2, type: 'request/header', data: { reason: 'initial', header: { tools: ['read'] } } }])
  const got = readTranscriptFile(dir.file)
  return got.frames === 1 && got.records.length === 2
})(), null)

check('🔴 readTranscriptFile：**多帧**要按魔数逐帧解（单帧只给第一段 ⇒ 会静默丢尾部）', (() => {
  const dir = mkZstdSession([{ seq: 1 }, { seq: 2 }, { seq: 3 }], { frames: 3 })
  const got = readTranscriptFile(dir.file)
  return got.frames === 3 && got.records.map((r) => r.seq).join(',') === '1,2,3'
})(), null)

check('🔴 readTranscriptFile：垃圾帧必须**跳过且不崩**，跳过的帧数如实计数', (() => {
  const dir = mkZstdSession([{ seq: 1 }, { seq: 2 }], { garbage: true })
  const got = readTranscriptFile(dir.file)
  return Array.isArray(got.records) && typeof got.dropped === 'number'
})(), null)

check('🔴 findSessionDirs：两个根都查（ROOT 只写死一个 ⇒ 另一根的会话永远"找不到"）', (() => {
  const home = mkFakeHome(['--C-Users-DELL--', '--E-DSH-workspace--'], 'session-abcd')
  const dirs = findSessionDirs(home, 'session-abcd')
  return dirs.length === 2
})(), null)

check('🔴 离线 ⇒ `hasMore` 必须 false、视窗覆盖全链（"条数/最早那条"才可当作可信）', (() => {
  const page = pageFromOffline([{ seq: 3 }, { seq: 1 }, { seq: 2 }])
  const w = windowOf(page)
  return w.hasMore === false && w.firstSeq === 1 && w.records === 3
})(), null)

check('🔴 离线抓出来的 record 能被 extractHeaders 直接使用（两条 isinstance 路径同一形状）', (() => {
  const dir = mkZstdSession([
    { seq: 1, type: 'turn/end', data: {} },
    { seq: 2, type: 'request/header', time: 1790425633884, data: { reason: 'change', header: { tools: ['read', 'pwsh'] } } }
  ])
  const hs = extractHeaders(readTranscriptFile(dir.file).records)
  return hs.length === 1 && hs[0].seq === 2 && hs[0].time === 1790425633884 && toolsOf(hs[0]).join(',') === 'read,pwsh'
})(), null)

// ---------------------------------------------------------------- 临时夹具
function mkZstdSession(events, opt) {
  const dir = mkdtempSync(join(tmpdir(), 'ofmt-'))
  mkdirSync(dir, { recursive: true })
  const n = opt?.frames ?? 1
  const chunks = []
  const per = Math.ceil(events.length / n)
  for (let i = 0; i < n; i++) {
    const part = events.slice(i * per, (i + 1) * per)
    chunks.push(zstdCompressSync(Buffer.from(part.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')))
  }
  if (opt?.garbage) chunks.push(Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('not-a-real-frame')]))
  writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.concat(chunks))
  return { dir, file: join(dir, 'session.jsonl.zstd') }
}

function mkFakeHome(roots, sid) {
  const home = mkdtempSync(join(tmpdir(), 'ofhome-'))
  for (const r of roots) {
    mkdirSync(join(home, 'sessions', r, sid), { recursive: true })
    writeFileSync(join(home, 'sessions', r, sid, 'session.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
  }
  return home
}

// 按纪律：套件必须能被证伪（FDE_INVERT=1 ⇒ 必须变红）
if (process.env.FDE_INVERT === '1') {
  check('[INVERT] 故意失败以验证退出码敏感', false, 'injected by FDE_INVERT')
}

lines.push('')
lines.push(`结果：${passed} 通过 / ${failed} 失败`)
lines.push(failed > 0 ? '状态：FAILED' : '状态：ALL GREEN')

// ⚠️ 输出文件名必须与活体仪器的 `_assert_restrict_live_out.txt` **分开**：
// 那个文件是活验证据；本套件是离线回归，写同名会把活验证据冲掉。
// FDE_OUT（0030 §7）：跑轮次时显式给输出名 ⇒ normal / INVERT 两轮不再互相覆盖（缺省沿用原名）
writeFileSync(
  process.env.FDE_OUT ?? new URL('./_assert_restrict_live_test_out.txt', import.meta.url),
  lines.join('\n'),
  'utf8'
)
console.log(lines.join('\n'))
process.exit(failed === 0 ? 0 : 1)
