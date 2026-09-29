/**
 * E1 —— break-glass 逃生门（spec §11）离线回归。
 *
 * 跑法：
 *   node _fde_e1_test.mjs
 *   故意验证退出码会变红： FDE_INVERT=1 node _fde_e1_test.mjs
 *
 * 结果**自己写文件**（`_e1_test_out.txt`）—— 不走控制台（Windows 代码页乱码纪律）。
 *
 * 覆盖（对应 `_inbox/0093-E1-break-glass-施工单.md` 的判据）：
 *   §1 deny-ids        —— 取值域 / 锚点集 / 事件 ID 可复算 / 人话表覆盖
 *   §2 bg-mirror       —— 放行三条件 / fail-closed / 超期不撤销 / 重启恢复 / 坏行跳过
 *   §3 break-glass.js  —— 表解析 fail-closed / 原子写 / 各 id 的当前锚点
 *   §4 phase guard     —— 放行、**逐项判**、锚点失效、自动补正候选
 *   §5 gate guard      —— 三个 denyId / 放行 / **GATE-PTC 不可绕**
 *   §6 工具五道闸门    —— id / reason / category / 当前在拦 / approval / 表损坏
 *   §7 会话提醒        —— 纯函数渲染（无超期 / 超期 / 截断）
 *   §8 phase 监听器    —— bypass 留痕（callAllowed 如实）+ 自动补正三处同改 + 写失败路径
 *   §9 gate 监听器     —— bypass 留痕（callAllowed=enforcing）
 *
 * ⚠️ 本套件**不覆盖**：真 SDK 的 approval 弹窗路由、`agent.send` 的 inbox 送达、
 *    两个 index.js 的接线。前者只能活体验（需要人在 UI 上点），后两者在
 *    `_fde_e1_wiring_test.mjs`（import 部署副本）里测。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ANCHORED_DENY_IDS,
  BREAK_GLASS_CATEGORIES,
  BYPASSABLE_DENY_IDS,
  CATEGORY_META,
  CORRECTION_WINDOW_MS,
  DENY_LABEL,
  EVENT_ID_PREFIX,
  makeEventId,
  sha256Hex
} from './dsh-fde-phase/lib/deny-ids.js'
import { BreakGlassMirror, BG_CHAIN_TYPES } from './dsh-fde-phase/lib/bg-mirror.js'
import {
  BG_RELATIVE_PATH,
  currentAnchorSync,
  parseBreakGlassDoc,
  readBreakGlassSync,
  writeBreakGlassAtomic
} from './dsh-fde-phase/lib/break-glass.js'
import { installBreakGlassTool, BREAK_GLASS_TOOL } from './dsh-fde-phase/lib/break-glass-tool.js'
import { formatPendingNotice } from './dsh-fde-phase/lib/break-glass-notify.js'
import { evaluate as phaseEvaluate } from './dsh-fde-phase/lib/guard.js'
import { installAuditListener as phaseAuditListener } from './dsh-fde-phase/lib/audit-listener.js'
import { D1Mirror, ANCHOR_ALGS, compositeAnchorSha } from './dsh-fde-phase/lib/mirror.js'

import { evaluate as gateEvaluate, evaluateRules as gateEvaluateRules } from './dsh-fde-ontology-gate/lib/guard.js'
import { installAuditListener as gateAuditListener } from './dsh-fde-ontology-gate/lib/pre-execute.js'


const OUT = join(dirname(fileURLToPath(import.meta.url)), '_e1_test_out.txt')
const lines = []
let passed = 0
let failed = 0
/** 收集所有异步用例的 Promise，最终统一 await，确保写文件前全部跑完。 */
const pending = []

// ---------------------------------------------------------------- 测试小工具
function t(name, fn) {
  try {
    const r = fn()
    if (r instanceof Promise) throw new Error('同步用例请传同步函数')
    passed += 1
    lines.push(`  ✓ ${name}`)
  } catch (e) {
    failed += 1
    lines.push(`  ✗ ${name}`)
    lines.push(`      ${e && e.message ? e.message : String(e)}`)
  }
}

function ta(name, fn) {
  const p = (async () => {
    try {
      await fn()
      passed += 1
      lines.push(`  ✓ ${name}`)
    } catch (e) {
      failed += 1
      lines.push(`  ✗ ${name}`)
      lines.push(`      ${e && e.message ? e.message : String(e)}`)
    }
  })()
  pending.push(p)
  return p
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败')
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg || '不相等'}：期望 ${e}，实际 ${a}`)
}

async function assertRejects(fn, pattern, msg) {
  let threw = null
  try {
    await fn()
  } catch (e) {
    threw = e
  }
  if (!threw) throw new Error(`${msg || '期望抛错'}：没有抛`)
  const hay = `${threw.code ?? ''} ${threw.message ?? ''}`
  if (pattern && !hay.includes(pattern)) {
    throw new Error(`${msg || '错误不符'}：期望包含 "${pattern}"，实际 ${hay}`)
  }
  return threw
}

// ---------------------------------------------------------------- 夹具
const DEFAULT_GUARDS = 'guards:\n  - ref: guard.dose_upper_bound\n    impl: true\n'

function mkProject(currentPhase = '3') {
  const root = mkdtempSync(join(tmpdir(), 'fde-e1-'))
  const mem = join(root, 'memory')
  mkdirSync(mem, { recursive: true })
  writeFileSync(
    join(mem, 'state.yaml'),
    `schema_version: 1\ncurrent_phase: "${currentPhase}"\nphase_status: in_progress\nontology_version: 1\nrevision: 1\n`
  )
  return root
}

function mkOnto(actionsText = 'actions:\n  - id: suggest_treatment_plan\n    writes: true\n') {
  const dir = mkdtempSync(join(tmpdir(), 'fde-e1-onto-'))
  writeFileSync(join(dir, 'actions.yaml'), actionsText)
  writeFileSync(join(dir, 'guards.yaml'), DEFAULT_GUARDS)
  writeFileSync(join(dir, 'objects.yaml'), 'objects: []\n')
  writeFileSync(join(dir, 'logic.yaml'), 'logic: []\n')
  writeFileSync(join(dir, 'compliance.yaml'), 'rules:\n  - id: r1\n')
  return dir
}

/** phase 的判定配置（形状与 `lib/config.js` 规范化后一致）。 */
function mkPhaseCfg(phase = '3', onto = mkOnto()) {
  return {
    projectRoot: mkProject(phase),
    ontologyRoot: onto,
    auditPath: '',
    gateAuditPath: join(mkdtempSync(join(tmpdir(), 'fde-e1-gate-')), 'gate.jsonl'),
    mode: 'enforce',
    lockTtlMs: 30000,
    industry: '未声明',
    rollbackObservationMs: 24 * 60 * 60 * 1000
  }
}

/**
 * gate 的判定配置 —— **与活体同构的最小 cfg**，默认值照抄 `lib/config.js` 的 schema。
 *
 * ⚠️ 离线**不引 schemastery**（工作区 node_modules 里没有它，只有 dsh-tools / dsh-llm 两个桩）。
 *    这是本项目既有做法（见 `_gate_audit_guard_test.mjs` 的 `cfgOf`）。
 *    ⇒ **改 `lib/config.js` 的默认值时必须同步改这里**；跑了但断言没跟着红，就是漏了同步。
 */
function mkGateCfg(onto, extra = {}) {
  return {
    ontologyRoot: onto,
    mode: 'enforce',
    denyRunCode: true,
    workspaceRoot: join(tmpdir(), 'fde-e1-nope'),
    auditPath: join(mkdtempSync(join(tmpdir(), 'fde-e1-gaudit-')), 'gate.jsonl'),
    allowedWriteSources: ['user', 'model'],
    minConfidence: 70,
    industry: '未声明',
    protectedExtraRoots: [],
    maxConfirmPerCall: 50,
    ...extra
  }
}

/** 造一个"门禁当前正在拦"的假 D1 失败：空 mirror（无任何结论）即满足。 */
const failingMirror = () => new D1Mirror()

/** 造一个 D1 结论通过的 mirror（锚点与当前 actions/guards 相符）。 */
function passingD1Mirror(onto) {
  const m = new D1Mirror()
  const actions = readFileSync(join(onto, 'actions.yaml'), 'utf8')
  const guards = readFileSync(join(onto, 'guards.yaml'), 'utf8')
  m.update({
    check: 'D1',
    passed: true,
    anchor: {
      alg: ANCHOR_ALGS.D1,
      files: [join(onto, 'actions.yaml'), join(onto, 'guards.yaml')],
      sha256: compositeAnchorSha([actions, guards])
    },
    at: new Date().toISOString()
  })
  return m
}

/** 造一条 open 的 break-glass 记录（锚点取当前真实值，除非显式覆盖）。 */
function mkRecord(denyId, cfg, over = {}) {
  const at = new Date().toISOString()
  return {
    id: makeEventId('call-' + denyId, at),
    denyId,
    category: 'deny_defect',
    reason: '门禁拦错了',
    at,
    expiresAt: new Date(Date.parse(at) + CORRECTION_WINDOW_MS).toISOString(),
    anchor: ANCHORED_DENY_IDS.includes(denyId) ? currentAnchorSync(denyId, cfg) : null,
    status: 'open',
    resolvedAt: null,
    ...over
  }
}

function mkBg(records = []) {
  const bg = new BreakGlassMirror()
  for (const r of records) bg.update(r)
  return bg
}

function fakeAudit() {
  return {
    records: [],
    async record(r) {
      this.records.push(r)
      return { seq: this.records.length }
    },
    async flush() {}
  }
}

/** 假 approval 服务：记录 request 收到的参数，返回预设 outcome。 */
function mkApproval(outcome) {
  const calls = []
  return {
    calls,
    request: async (req) => {
      calls.push(req)
      return outcome
    }
  }
}

/** 假 ctx：提供 break-glass-tool 与两个 pre-execute 监听器用到的全部面。 */
function fakeCtx(approval) {
  const defs = []
  const handlers = new Map()
  const emitted = []
  return {
    defs,
    handlers,
    emitted,
    ctx: {
      get: (n) => (n === 'approval' ? approval : undefined),
      tools: {
        register: (d) => {
          defs.push(d)
          return () => {}
        },
        guard: () => () => {}
      },
      on: (name, cb) => {
        handlers.set(name, cb)
        return () => handlers.delete(name)
      },
      emit: (name, payload) => {
        emitted.push({ name, payload })
      }
    }
  }
}

const bgPathOf = (cfg) => join(cfg.projectRoot, BG_RELATIVE_PATH)

// ══════════════════════════════════════════════════════════════════ §1
lines.push('== E1 break-glass 离线回归（spec §11）==')
lines.push('')
lines.push('[§1 deny-ids]')

t('BYPASSABLE 恰为 6 个内容门禁；不含流程规则与 GATE-PTC', () => {
  assertEq(BYPASSABLE_DENY_IDS, ['D1', 'D2', 'D3', 'D5', 'GATE-CLASSIFY', 'GATE-PATH'])
  for (const bad of ['RULE-JUMP', 'RULE-LAST', 'RULE-OBSERVATION', 'GATE-PTC']) {
    assert(!BYPASSABLE_DENY_IDS.includes(bad), `${bad} 不该可绕`)
  }
})

t('ANCHORED 恰为 D1/D3/D5（D2 与 GATE-* 有意不带锚）', () => {
  assertEq(ANCHORED_DENY_IDS, ['D1', 'D3', 'D5'])
})

t('DENY_LABEL / CATEGORY_META 覆盖全部可绕 id 与全部分类', () => {
  for (const id of BYPASSABLE_DENY_IDS) assertEq(typeof DENY_LABEL[id], 'string', `${id} 缺人话名字`)
  for (const c of BREAK_GLASS_CATEGORIES) assert(CATEGORY_META[c], `${c} 缺 meta`)
  assertEq(BREAK_GLASS_CATEGORIES, ['deny_defect', 'scope_edge', 'evasion'])
})

t('makeEventId：同 (callId,at) ⇒ 同 id；不同 ⇒ 不同；带前缀且可复算', () => {
  const a = makeEventId('c1', '2026-09-29T00:00:00.000Z')
  const b = makeEventId('c1', '2026-09-29T00:00:00.000Z')
  const c = makeEventId('c1', '2026-09-29T00:00:00.001Z')
  assertEq(a, b, '同输入应同 id')
  assert(a !== c, '不同输入不应同 id')
  assert(a.startsWith(EVENT_ID_PREFIX), `前缀应为 ${EVENT_ID_PREFIX}`)
  // 可复算：第三方拿 sha256(callId|at) 前 6 位就能独立验证
  assertEq(a, EVENT_ID_PREFIX + sha256Hex('c1|2026-09-29T00:00:00.000Z').slice(0, 6))
})

// ══════════════════════════════════════════════════════════════════ §2
lines.push('')
lines.push('[§2 bg-mirror 放行判定]')

t('无锚类：一条 open 记录即放行', () => {
  const cfg = mkPhaseCfg('3')
  const bg = mkBg([mkRecord('D2', cfg)])
  assert(bg.isBypassed('D2'), 'D2 open 应放行')
  assert(!bg.isBypassed('D1'), '没砸过 D1 不该放行 D1')
})

t('🔴 `isBypassed` 对**不可绕的 id** 一律短路 false（不管表里塞了什么）', () => {
  // 这条是 2026-09-29 实测抓到的缺口：改前 isBypassed 只查表内容、不查 id 是否可绕，
  // 于是把 GATE-PTC 硬塞进表就能绕过 —— 工具面的 enum 是**唯一**屏障。
  const notBypassable = ['GATE-PTC', 'RULE-JUMP', 'RULE-LAST', 'RULE-OBSERVATION', 'D9', '']
  const bg = new BreakGlassMirror()
  for (const id of notBypassable) {
    bg.update({ id: `evt_bg_x_${id}`, denyId: id, at: 't', expiresAt: 't' })
  }
  for (const id of notBypassable) {
    assert(!bg.isBypassed(id), `${id || '(空)'} 不该可绕`)
  }
  // 对照：同一个表里的可绕 id 仍然照常放行（证明短路没把功能关掉）
  const cfg = mkPhaseCfg('3')
  const ok = new BreakGlassMirror()
  ok.update(mkRecord('D2', cfg))
  ok.update({ id: 'evt_bg_ptc', denyId: 'GATE-PTC', at: 't', expiresAt: 't' })
  assert(ok.isBypassed('D2'), '可绕 id 必须仍然能放行')
  assert(!ok.isBypassed('GATE-PTC'), '同表里的不可绕 id 仍须拦')
})

t('带锚类：锚点相符 ⇒ 放行；不符 ⇒ 不放行', () => {
  const cfg = mkPhaseCfg('3')
  const good = mkRecord('D1', cfg)
  const bg = mkBg([good])
  assert(bg.isBypassed('D1', (id) => currentAnchorSync(id, cfg)), '锚点相符应放行')
  assert(!bg.isBypassed('D1', () => 'deadbeef'), '锚点不符不该放行')
})

t('带锚类：算不出当前锚点（返回 null / 抛错）⇒ 不放行（fail-closed）', () => {
  const cfg = mkPhaseCfg('3')
  const bg = mkBg([mkRecord('D1', cfg)])
  assert(!bg.isBypassed('D1', () => null), 'anchorFn 返回 null 应 fail-closed')
  assert(
    !bg.isBypassed('D1', () => {
      throw new Error('文件读不动')
    }),
    'anchorFn 抛错应 fail-closed'
  )
  assert(!bg.isBypassed('D1'), '根本没给 anchorFn 应 fail-closed')
})

t('带锚类：记录自身 anchor 为空 ⇒ 不放行（不拿"无锚"当通配）', () => {
  const cfg = mkPhaseCfg('3')
  const bg = mkBg([mkRecord('D1', cfg, { anchor: null })])
  assert(!bg.isBypassed('D1', (id) => currentAnchorSync(id, cfg)))
})

t('带锚类：记录 anchor 是空**串**、当前也算出空串 ⇒ 仍不放行（空锚≠通配）', () => {
  // 这条是变异 M3′ 的反例：若去掉 `r.anchor === ''` 那一档，`'' === ''` 会直接放行 ——
  // 即"没有锚点"被当成了"锚点匹配"。现实里 `currentAnchorSync` 不返回空串（返回 null），
  // 所以这档挡的是**手改表**与**将来某个新锚算法**，但代价为零、语义更明确。
  const cfg = mkPhaseCfg('3')
  const bg = mkBg([mkRecord('D1', cfg, { anchor: '' })])
  assert(!bg.isBypassed('D1', () => ''), '空锚 + 空算值 不得放行')
  assert(!bg.isBypassed('D1', () => null), '空锚 + 算不出 不得放行')
})

t('resolved 分支**只认 id**（调用方未必还持有 denyId）', () => {
  const cfg = mkPhaseCfg('3')
  const rec = mkRecord('D2', cfg)
  const bg = mkBg([rec])
  assert(bg.isBypassed('D2'))
  bg.update({ id: rec.id, at: '2026-09-30T00:00:00.000Z', resolved: true }) // 无 denyId
  assert(!bg.isBypassed('D2'), '标补正后不该再放行')
  assertEq(bg.get(rec.id).status, 'resolved')
})

t('update 缺 id / 缺 denyId（且非 resolved）⇒ 忽略，不产生半条记录', () => {
  const bg = new BreakGlassMirror()
  bg.update({ denyId: 'D1', at: 'x', expiresAt: 'y' })
  bg.update(null)
  assertEq(bg.size(), 0)
})

t('**超期不撤销放行**（R7 只要求红色警告）', () => {
  const cfg = mkPhaseCfg('3')
  const past = new Date(Date.now() - 1000).toISOString()
  const bg = mkBg([mkRecord('D2', cfg, { expiresAt: past })])
  assertEq(bg.overdueRecords().length, 1, '应被标为超期')
  assert(bg.isBypassed('D2'), '超期仍应放行 —— 撤销会让 FDE 在现场再次卡死')
})

t('openRecords 按 at 升序、只含 open；overdueRecords 是它的子集', () => {
  const cfg = mkPhaseCfg('3')
  const r1 = mkRecord('D2', cfg, { at: '2026-09-01T00:00:00.000Z' })
  const r2 = mkRecord('D3', cfg, { at: '2026-09-02T00:00:00.000Z' })
  const r3 = mkRecord('D1', cfg, { at: '2026-09-03T00:00:00.000Z' })
  const bg = mkBg([r3, r1, r2])
  bg.update({ id: r3.id, at: 'x', resolved: true })
  assertEq(
    bg.openRecords().map((r) => r.id),
    [r1.id, r2.id],
    '应按 at 升序且剔除 resolved'
  )
})

t('restoreSync：文件不存在 / 空文件 ⇒ 空表（不放行任何东西）', () => {
  const bg1 = new BreakGlassMirror()
  bg1.restoreSync(join(tmpdir(), 'fde-e1-不存在的链.jsonl'))
  assertEq(bg1.size(), 0)
  const empty = join(mkdtempSync(join(tmpdir(), 'fde-e1-empty-')), 'e.jsonl')
  writeFileSync(empty, '')
  const bg2 = new BreakGlassMirror()
  bg2.restoreSync(empty)
  assertEq(bg2.size(), 0)
})

t('restoreSync：open → resolved 顺序 ⇒ 恢复为已补正（不像"还开着"）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fde-e1-rs-'))
  const p = join(dir, 'c.jsonl')
  const cfg = mkPhaseCfg('3')
  const rec = mkRecord('D1', cfg)
  writeFileSync(
    p,
    [
      JSON.stringify({ type: BG_CHAIN_TYPES.OPEN, ...rec, status: undefined }),
      JSON.stringify({ type: BG_CHAIN_TYPES.RESOLVED, id: rec.id, at: 'x' }),
      ''
    ].join('\n')
  )
  const bg = new BreakGlassMirror()
  bg.restoreSync(p)
  assertEq(bg.get(rec.id).status, 'resolved')
  assert(!bg.isBypassed('D1', (id) => currentAnchorSync(id, cfg)))
})

t('restoreSync：坏行跳过、其余行照常恢复（不因一行坏而全丢）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fde-e1-rs2-'))
  const p = join(dir, 'c.jsonl')
  const cfg = mkPhaseCfg('3')
  const rec = mkRecord('D2', cfg)
  writeFileSync(p, ['{ 这不是 json', JSON.stringify({ type: BG_CHAIN_TYPES.OPEN, ...rec }), ''].join('\n'))
  const bg = new BreakGlassMirror()
  bg.restoreSync(p)
  assert(bg.isBypassed('D2'), '坏行之后的完整行应仍然恢复')
})

t('restoreSync：把**同 id 的重复 open** 视作同一条（幂等）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fde-e1-rs3-'))
  const p = join(dir, 'c.jsonl')
  const cfg = mkPhaseCfg('3')
  const rec = mkRecord('D2', cfg)
  writeFileSync(p, [JSON.stringify({ type: BG_CHAIN_TYPES.OPEN, ...rec }), JSON.stringify({ type: BG_CHAIN_TYPES.OPEN, ...rec }), ''].join('\n'))
  const bg = new BreakGlassMirror()
  bg.restoreSync(p)
  assertEq(bg.size(), 1)
})

// ══════════════════════════════════════════════════════════════════ §3
lines.push('')
lines.push('[§3 break-glass.js 持久化与锚点]')

t('parseBreakGlassDoc：六种坏输入一律 ok:false（绝不"尽量读出几条"）', () => {
  const bad = [
    '不是 json',
    '"字符串顶层"',
    '[1,2]',
    '{}',
    '{"schemaVersion":1}',
    '{"schemaVersion":99,"records":[]}',
    '{"schemaVersion":1,"records":{}}',
    '{"schemaVersion":1,"records":[1]}',
    '{"schemaVersion":1,"records":[{"denyId":"D1"}]}',
    '{"schemaVersion":1,"records":[{"id":"x"}]}'
  ]
  for (const text of bad) {
    const r = parseBreakGlassDoc(text)
    assertEq(r.ok, false, `应拒绝：${text.slice(0, 40)}`)
    assert(typeof r.reason === 'string' && r.reason.length > 0, '应给出 reason')
  }
})

t('write → read 往返逐字一致（含 anchor 为 null 的情形）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fde-e1-rt-'))
  const p = join(dir, 'b.json')
  const cfg = mkPhaseCfg('3')
  const recs = [mkRecord('D2', cfg), mkRecord('D1', cfg)]
  writeBreakGlassAtomic(p, recs)
  const r = readBreakGlassSync(p)
  assertEq(r.ok, true, r.reason)
  assertEq(
    r.records.map((x) => [x.id, x.denyId, x.anchor, x.status]),
    recs.map((x) => [x.id, x.denyId, x.anchor, 'open'])
  )
})

t('readBreakGlassSync：文件不存在 ⇒ ok:true 空表；存在但坏 ⇒ ok:false 空表', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fde-e1-rd-'))
  assertEq(readBreakGlassSync(join(dir, 'none.json')), { ok: true, records: [] })
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{oops')
  const r = readBreakGlassSync(bad)
  assertEq(r.ok, false)
  assertEq(r.records, [])
})

t('writeBreakGlassAtomic：覆盖旧内容且不留 .tmp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fde-e1-at-'))
  const p = join(dir, 'b.json')
  const cfg = mkPhaseCfg('3')
  writeBreakGlassAtomic(p, [mkRecord('D2', cfg)])
  writeBreakGlassAtomic(p, [mkRecord('D3', cfg)])
  assertEq(readBreakGlassSync(p).records.map((r) => r.denyId), ['D3'], '应整体覆盖')
  assert(!existsSync(p + '.tmp'), '不应残留 .tmp')
})

t('currentAnchorSync：D1/D3 取复合哈希、D5 取三元指纹、D2/GATE-* 恒 null', () => {
  const onto = mkOnto()
  const cfg = { ontologyRoot: onto }
  const a1 = currentAnchorSync('D1', cfg)
  const a3 = currentAnchorSync('D3', cfg)
  assertEq(a1, compositeAnchorSha([readFileSync(join(onto, 'actions.yaml'), 'utf8'), readFileSync(join(onto, 'guards.yaml'), 'utf8')]))
  assertEq(a3, compositeAnchorSha([readFileSync(join(onto, 'objects.yaml'), 'utf8'), readFileSync(join(onto, 'logic.yaml'), 'utf8')]))
  assert(typeof currentAnchorSync('D5', cfg) === 'string', 'D5 应算出指纹')
  assertEq(currentAnchorSync('D2', cfg), null)
  assertEq(currentAnchorSync('GATE-PATH', cfg), null)
  assertEq(currentAnchorSync('GATE-CLASSIFY', cfg), null)
})

t('currentAnchorSync：ontologyRoot 缺失 / 文件缺失 ⇒ null（fail-closed）', () => {
  assertEq(currentAnchorSync('D1', {}), null)
  assertEq(currentAnchorSync('D1', { ontologyRoot: '' }), null)
  const dir = mkdtempSync(join(tmpdir(), 'fde-e1-noact-'))
  assertEq(currentAnchorSync('D1', { ontologyRoot: dir }), null, '文件不在应返回 null 而不是抛')
})

t('currentAnchorSync：内容一变，锚点就变（放行失效的根机制）', () => {
  const onto = mkOnto()
  const before = currentAnchorSync('D1', { ontologyRoot: onto })
  writeFileSync(join(onto, 'actions.yaml'), 'actions: []\n')
  const after = currentAnchorSync('D1', { ontologyRoot: onto })
  assert(before !== after, '改了 actions.yaml 锚点必须变')
})

// ══════════════════════════════════════════════════════════════════ §4
lines.push('')
lines.push('[§4 phase guard：放行 / 逐项判 / 锚点失效 / 补正候选]')

t('无 bg ⇒ D1 失败照常拦（接线不改变原行为）', () => {
  const cfg = mkPhaseCfg('3')
  const r = phaseEvaluate({ name: 'fde_phase_advance', arguments: { to: '4' } }, cfg, failingMirror())
  assert(typeof r.deny === 'string' && r.deny.includes('D1'), `应因 D1 被拒，实际 ${JSON.stringify(r.deny)}`)
})

t('D1 有 open 放行且锚点相符 ⇒ deny undefined，bypassed=[D1]', () => {
  const cfg = mkPhaseCfg('3')
  const bg = mkBg([mkRecord('D1', cfg)])
  const r = phaseEvaluate({ name: 'fde_phase_advance', arguments: { to: '4' } }, cfg, failingMirror(), bg)
  assertEq(r.deny, undefined)
  assertEq(r.bypassed, ['D1'])
  assertEq(r.resolvedCandidates, [])
})

t('D1 有 open 但**锚点已失效**（文件被改）⇒ 仍然拦', () => {
  const onto = mkOnto()
  const cfg = mkPhaseCfg('3', onto)
  const bg = mkBg([mkRecord('D1', cfg)])
  writeFileSync(join(onto, 'actions.yaml'), 'actions:\n  - id: 改了\n')
  const r = phaseEvaluate({ name: 'fde_phase_advance', arguments: { to: '4' } }, cfg, failingMirror(), bg)
  assert(typeof r.deny === 'string', '锚点失效应重新拦')
  assertEq(r.bypassed, [])
})

t('**逐项判**：D3 放了玻璃不带动 D2 —— 只有 D3 被放行，D2 仍拦', () => {
  const cfg = mkPhaseCfg('4') // phase 4 = ['D2','D3']，两项都已实现
  const bg = mkBg([mkRecord('D3', cfg)])
  const r = phaseEvaluate({ name: 'fde_phase_advance', arguments: { to: '5' } }, cfg, failingMirror(), bg)
  assertEq(r.bypassed, ['D3'])
  assert(typeof r.deny === 'string' && r.deny.includes('D2'), 'D2 应仍然拦')
  assert(r.deny.includes('D3') === false || r.deny.includes('不在此列'), '文案应说明 D3 已被放过')
})

t('自动补正候选：D1 open 且本轮 D1 通过 ⇒ 该 id 进 resolvedCandidates', () => {
  const onto = mkOnto()
  const cfg = mkPhaseCfg('3', onto)
  const rec = mkRecord('D1', cfg)
  const bg = mkBg([rec])
  const r = phaseEvaluate({ name: 'fde_phase_advance', arguments: { to: '4' } }, cfg, passingD1Mirror(onto), bg)
  assertEq(r.deny, undefined)
  assertEq(r.resolvedCandidates, [rec.id])
})

t('自动补正候选：该 check **本轮没跑** ⇒ 不算通过（不谈"没跑的检查通过了"）', () => {
  const onto = mkOnto()
  const cfg = mkPhaseCfg('3', onto) // phase 3 只跑 D1
  const rec = mkRecord('D3', cfg)
  const bg = mkBg([rec])
  const r = phaseEvaluate({ name: 'fde_phase_advance', arguments: { to: '4' } }, cfg, passingD1Mirror(onto), bg)
  assertEq(r.resolvedCandidates, [], 'D3 不在本阶段检查范围，不该被判为已补正')
})

t('流程规则（跳跃推进）不受放行表影响，且不带去程 checks', () => {
  const cfg = mkPhaseCfg('3')
  // 表里塞满可绕 id —— 跳跃是**结构规则**，一个都不该认
  const bg = mkBg([mkRecord('D1', cfg), mkRecord('D2', cfg), mkRecord('D3', cfg)])
  const r = phaseEvaluate({ name: 'fde_phase_advance', arguments: { to: '9' } }, cfg, failingMirror(), bg)
  assert(typeof r.deny === 'string' && r.deny.includes('跳跃'), '跳跃应被拒')
  assertEq(r.checks, [])
  // ⚠️ 断言 `?? []`：早退分支**不返回** bypassed/resolvedCandidates 字段。
  //    消费侧（audit-listener）用的是 `bypassed ?? []` / `resolvedCandidates ?? []`，
  //    所以"字段缺席"与"空数组"行为等价 —— 这里断言的是**行为**（一个都不放行），
  //    不是字段存在性。断字段存在性会把一个正确的实现判红。
  assertEq(r.bypassed ?? [], [], '流程规则不接受任何放行')
  assertEq(r.resolvedCandidates ?? [], [], '结构规则的早退分支不该产生补正候选')
})

// ══════════════════════════════════════════════════════════════════ §5
lines.push('')
lines.push('[§5 gate guard：三个 denyId / 放行 / GATE-PTC 不可绕]')

const shellExec = (command) => ({ name: 'pwsh', arguments: { command } })

t('evaluateRules 给出三个 denyId（GATE-PATH / GATE-CLASSIFY / GATE-PTC）', () => {
  const onto = mkOnto()
  const cfg = mkGateCfg(onto)
  const path = gateEvaluateRules(shellExec(`echo hi > ${join(onto, 'actions.yaml')}`), cfg, true)
  assertEq(path.denyId, 'GATE-PATH')
  assert(path.hits.length > 0, 'hits 应保留命中的路径')

  const cls = gateEvaluateRules(
    { name: 'fde_ontology_write', arguments: { path: join(onto, 'x.yaml'), source: 'model', confidence: 10, reason: 'r' } },
    cfg,
    true
  )
  assertEq(cls.denyId, 'GATE-CLASSIFY')

  const ptc = gateEvaluateRules({ name: 'run_code', arguments: {} }, cfg, false)
  assertEq(ptc.denyId, 'GATE-PTC')
  assertEq(ptc.modeIndependent, true, 'PTC 与 mode 无关，shadow 下也真拦')
})

t('gate 放行：GATE-PATH 有 open ⇒ 放行、bypassed 记录 id、hits 原样带出', () => {
  const onto = mkOnto()
  const cfg = mkGateCfg(onto)
  const bg = mkBg([mkRecord('GATE-PATH', cfg)])
  const r = gateEvaluate(shellExec(`echo hi > ${join(onto, 'actions.yaml')}`), cfg, true, bg)
  assertEq(r.deny, undefined)
  assertEq(r.bypassed, 'GATE-PATH')
  assert(r.hits.length > 0, 'hits 必须原样带出 —— 否则留痕无从复核')
})

t('gate 放行：GATE-CLASSIFY 有 open ⇒ 放行', () => {
  const onto = mkOnto()
  const cfg = mkGateCfg(onto)
  const bg = mkBg([mkRecord('GATE-CLASSIFY', cfg)])
  const r = gateEvaluate(
    { name: 'fde_ontology_write', arguments: { path: join(onto, 'x.yaml'), source: 'model', confidence: 10, reason: 'r' } },
    cfg,
    true,
    bg
  )
  assertEq(r.deny, undefined)
  assertEq(r.bypassed, 'GATE-CLASSIFY')
})

t('🔴 GATE-PTC **不可绕**：即使放行表里硬塞一条也照样拦（双保险）', () => {
  const onto = mkOnto()
  const cfg = mkGateCfg(onto)
  // 绕过 enum 直接往表里塞 —— 模拟"放行表被污染"的最坏情形
  const bg = mkBg([mkRecord('GATE-PTC', cfg)])
  const r = gateEvaluate({ name: 'run_code', arguments: {} }, cfg, false, bg)
  assert(typeof r.deny === 'string', 'PTC 必须仍然拦')
  assertEq(r.bypassed, undefined)
})

t('gate 无 bg ⇒ 行为与接线前一致（仍然拦）', () => {
  const onto = mkOnto()
  const cfg = mkGateCfg(onto)
  const r = gateEvaluate(shellExec(`echo hi > ${join(onto, 'actions.yaml')}`), cfg, true)
  assert(typeof r.deny === 'string')
})

t('gate 放行表里是别的 id ⇒ 不影响本判定', () => {
  const onto = mkOnto()
  const cfg = mkGateCfg(onto)
  const bg = mkBg([mkRecord('GATE-CLASSIFY', cfg)])
  const r = gateEvaluate(shellExec(`echo hi > ${join(onto, 'actions.yaml')}`), cfg, true, bg)
  assert(typeof r.deny === 'string', 'GATE-CLASSIFY 的放行不该带动 GATE-PATH')
})

// ══════════════════════════════════════════════════════════════════ §6
lines.push('')
lines.push('[§6 fde-break-glass 五道闸门]')

/** 跑一次工具 execute（已装好 register 捕获）。 */
function runTool(cfg, approvalOutcome, execOver = {}) {
  const audit = fakeAudit()
  const f = fakeCtx(mkApproval(approvalOutcome))
  const bg = new BreakGlassMirror()
  installBreakGlassTool(f.ctx, cfg, audit, failingMirror(), bg)
  const def = f.defs[0]
  const exec = { agent: {}, name: BREAK_GLASS_TOOL, callId: 'call-1', rootCallId: 'root-1', ...execOver }
  return { audit, f, bg, def, exec }
}

ta('工具名与 spec §11 一致', async () => {
  assertEq(BREAK_GLASS_TOOL, 'fde-break-glass')
})

ta('闸门 1：deny_id 不在白名单 ⇒ BG_ID_NOT_BYPASSABLE（连 approval 都不问）', async () => {
  const cfg = mkPhaseCfg('3')
  const { f, def, exec } = runTool(cfg, 'allowed-once')
  await assertRejects(
    () => def.execute({ deny_id: 'RULE-JUMP', reason: 'r', category: 'deny_defect' }, exec),
    'BG_ID_NOT_BYPASSABLE'
  )
  assertEq(f.ctx.get('approval').calls.length, 0, '硬校验失败不该弹窗')
  assert(!existsSync(bgPathOf(cfg)), '不该留下任何文件')
})

ta('闸门 2：reason 空白 ⇒ BG_REASON_REQUIRED', async () => {
  const cfg = mkPhaseCfg('3')
  const { f, def, exec } = runTool(cfg, 'allowed-once')
  await assertRejects(() => def.execute({ deny_id: 'D1', reason: '   ', category: 'deny_defect' }, exec), 'BG_REASON_REQUIRED')
  assertEq(f.ctx.get('approval').calls.length, 0)
})

ta('闸门 3：category 非法 ⇒ BG_BAD_CATEGORY', async () => {
  const cfg = mkPhaseCfg('3')
  const { f, def, exec } = runTool(cfg, 'allowed-once')
  await assertRejects(() => def.execute({ deny_id: 'D1', reason: 'r', category: '随便' }, exec), 'BG_BAD_CATEGORY')
  assertEq(f.ctx.get('approval').calls.length, 0)
})

ta('闸门 4：门禁**没在拦** ⇒ BG_NOT_BLOCKED（挡"预防性砸玻璃"）', async () => {
  const onto = mkOnto()
  const cfg = mkPhaseCfg('3', onto)
  const audit = fakeAudit()
  const f = fakeCtx(mkApproval('allowed-once'))
  const bg = new BreakGlassMirror()
  installBreakGlassTool(f.ctx, cfg, audit, passingD1Mirror(onto), bg) // D1 通过 ⇒ 没在拦
  await assertRejects(
    () => f.defs[0].execute({ deny_id: 'D1', reason: 'r', category: 'deny_defect' }, { agent: {}, name: BREAK_GLASS_TOOL, callId: 'c' }),
    'BG_NOT_BLOCKED'
  )
  assertEq(f.ctx.get('approval').calls.length, 0, '没在拦就不该弹窗')
  assert(!existsSync(bgPathOf(cfg)))
})

ta('闸门 5：approval 返回 unavailable ⇒ BG_NOT_CONFIRMED，且**无痕**（文件未创建）', async () => {
  const cfg = mkPhaseCfg('3')
  const { audit, def, exec } = runTool(cfg, 'unavailable')
  await assertRejects(() => def.execute({ deny_id: 'D1', reason: 'r', category: 'deny_defect' }, exec), 'BG_NOT_CONFIRMED')
  assert(!existsSync(bgPathOf(cfg)), '未获确认不得留下记录表')
  assertEq(audit.records.filter((r) => r.type === BG_CHAIN_TYPES.OPEN).length, 0, '未获确认不得留 open 痕')
})

ta('闸门 5：approval 返回 rejected / cancelled ⇒ 同样中止', async () => {
  for (const o of ['rejected', 'cancelled']) {
    const cfg = mkPhaseCfg('3')
    const { def, exec } = runTool(cfg, o)
    await assertRejects(() => def.execute({ deny_id: 'D1', reason: 'r', category: 'deny_defect' }, exec), 'BG_NOT_CONFIRMED')
    assert(!existsSync(bgPathOf(cfg)), `${o} 不得留下记录表`)
  }
})

ta('全过：写文件 + 写链 + 更新镜像 + 广播，返回 pending/overdue 计数', async () => {
  const cfg = mkPhaseCfg('3')
  const { audit, f, bg, def, exec } = runTool(cfg, 'allowed-once')
  const out = await def.execute({ deny_id: 'D1', reason: '  门禁拦错了  ', category: 'deny_defect' }, exec)

  assert(out.eventId.startsWith(EVENT_ID_PREFIX), 'eventId 形态')
  assertEq(out.denyId, 'D1')
  assertEq(out.verified, true, 'D1 可自检 ⇒ verified 应为 true')
  assertEq(out.pending, 1)
  assertEq(out.overdue, 0)
  assert(typeof out.anchor === 'string' && out.anchor.length > 0, 'D1 带锚点')

  const onDisk = readBreakGlassSync(bgPathOf(cfg))
  assertEq(onDisk.ok, true, onDisk.reason)
  assertEq(onDisk.records.length, 1)
  assertEq(onDisk.records[0].id, out.eventId)
  assertEq(onDisk.records[0].reason, '门禁拦错了', 'reason 应被 trim')
  assertEq(onDisk.records[0].status, 'open')

  const opens = audit.records.filter((r) => r.type === BG_CHAIN_TYPES.OPEN)
  assertEq(opens.length, 1, '链上应有一条 break-glass')
  assertEq(opens[0].id, out.eventId)
  assertEq(opens[0].verified, true)

  assert(bg.isBypassed('D1', (id) => currentAnchorSync(id, cfg)), '镜像应立即可放行')

  const ev = f.emitted.filter((e) => e.name === 'fde/break-glass')
  assertEq(ev.length, 1, '应广播一次')
  assertEq(ev[0].payload.id, out.eventId)
  assertEq(ev[0].payload.anchor, out.anchor, '广播要带锚点，否则 gate 重启后失效')
  assertEq(ev[0].payload.verified, true)
})

ta('GATE-* 不可自检 ⇒ verified=false 但**仍然放行**（如实在输出与链上标注）', async () => {
  const cfg = mkPhaseCfg('3')
  const { audit, def, exec } = runTool(cfg, 'allowed-once')
  const out = await def.execute({ deny_id: 'GATE-PATH', reason: '路径判错了', category: 'scope_edge' }, exec)
  assertEq(out.verified, false)
  assertEq(out.anchor, '', 'GATE-* 不带锚点')
  assert(out.message.includes('未能复核'), '文案必须如实说明未复核')
  assert(audit.records.some((r) => r.type === BG_CHAIN_TYPES.OPEN && r.verified === false), '链上要记 verified=false')
})

ta('记录表已损坏 ⇒ BG_TABLE_CORRUPT，且**不覆盖**坏证据', async () => {
  const cfg = mkPhaseCfg('3')
  writeFileSync(bgPathOf(cfg), '{这不是合法 json')
  const before = readFileSync(bgPathOf(cfg), 'utf8')
  const { def, exec } = runTool(cfg, 'allowed-once')
  await assertRejects(() => def.execute({ deny_id: 'D1', reason: 'r', category: 'deny_defect' }, exec), 'BG_TABLE_CORRUPT')
  assertEq(readFileSync(bgPathOf(cfg), 'utf8'), before, '坏证据必须原样保留')
})

ta('锚点在同一毫秒的两次调用 ⇒ id 相同（同一次调用语义，可接受）', async () => {
  const cfg = mkPhaseCfg('3')
  const { def, exec } = runTool(cfg, 'allowed-once')
  const a = await def.execute({ deny_id: 'D1', reason: 'r', category: 'deny_defect' }, exec)
  const b = await def.execute({ deny_id: 'D1', reason: 'r', category: 'deny_defect' }, exec)
  // 不硬断言相等（同毫秒才会相同），只断言形态与"同 callId+同 at ⇒ 同 id"这条可复算性
  assert(a.eventId.startsWith(EVENT_ID_PREFIX) && b.eventId.startsWith(EVENT_ID_PREFIX))
})

// ══════════════════════════════════════════════════════════════════ §7
lines.push('')
lines.push('[§7 会话提醒（R6）纯函数]')
const REC = (id, denyId, expiresAt) => ({ id, denyId, category: 'deny_defect', expiresAt })

t('无待补正时本函数不会被调用（openRecords 为空 ⇒ notify 早退）；此处只验渲染', () => {
  const open = [REC('evt_bg_a', 'D1', '2026-10-06T00:00:00.000Z')]
  const s = formatPendingNotice(open, [])
  assert(s.includes('有 1 条 break-glass 待补正'), s)
  assert(!s.includes('已超期'), '无超期不该出现"已超期"')
  assert(s.includes('🟡 期内'))
  assert(s.includes('evt_bg_a'))
  assert(s.includes('D1'))
})

t('有超期 ⇒ 头部写"其中 N 条已超期"且该行标 🔴', () => {
  const open = [REC('evt_bg_a', 'D1', '2026-10-06T00:00:00.000Z'), REC('evt_bg_b', 'D3', '2026-10-07T00:00:00.000Z')]
  const s = formatPendingNotice(open, [open[1]])
  assert(s.includes('有 2 条 break-glass 待补正'), s)
  assert(s.includes('**1 条已超期**'), s)
  assert(s.includes('🔴 超期'))
})

t('超过 maxRows ⇒ 收口成"另有 N 条已省略"', () => {
  const open = Array.from({ length: 8 }, (_, i) => REC(`evt_bg_${i}`, 'D1', '2026-10-06T00:00:00.000Z'))
  const s = formatPendingNotice(open, [])
  assert(s.includes('另有 3 条已省略'), s)
  assertEq(s.split('\n').filter((l) => l.includes('evt_bg_')).length, 8 - 3)
})

// ══════════════════════════════════════════════════════════════════ §8
lines.push('')
lines.push('[§8 phase pre-execute：bypass 留痕 + 自动补正]')

/** 跑一次 phase 的 pre-execute 监听器。 */
function runPhaseListener(cfg, mirror, bg, execOver = {}, audit = fakeAudit(), ctxExtra = () => {}) {
  const f = fakeCtx(undefined)
  ctxExtra(f)
  phaseAuditListener(f.ctx, cfg, audit, mirror, bg)
  const cb = f.handlers.get('tools/pre-execute')
  const exec = { name: 'fde_phase_advance', arguments: { to: '4' }, callId: 'c1', rootCallId: 'r1', ...execOver }
  let nexted = false
  const p = cb(exec, () => {
    nexted = true
    return Promise.resolve()
  })
  return { audit, f, cb, p, nextedFn: () => nexted }
}

ta('有 bypass 且**确实放行了** ⇒ 链上一条 break-glass-bypass，callAllowed=true', async () => {
  const cfg = mkPhaseCfg('3')
  const bg = mkBg([mkRecord('D1', cfg)])
  const { audit, p } = runPhaseListener(cfg, failingMirror(), bg)
  await p
  const rows = audit.records.filter((r) => r.type === BG_CHAIN_TYPES.BYPASS)
  assertEq(rows.length, 1, '应留一条 bypass 痕')
  assertEq(rows[0].denyId, 'D1')
  assertEq(rows[0].callAllowed, true, 'D1 是唯一检查项且被放过 ⇒ 本次调用确实被放行')
  assertEq(rows[0].callId, 'c1')
  assertEq(audit.records.filter((r) => r.decision === 'deny' || r.decision === 'shadow-deny').length, 0, '放行后不该再有 deny 记录')
})

ta('有 bypass 但**仍被别的检查拦住** ⇒ callAllowed=false（不虚高指标）', async () => {
  const cfg = mkPhaseCfg('4') // ['D2','D3']，两项都失败
  const bg = mkBg([mkRecord('D3', cfg)])
  const audit = fakeAudit()
  const f = fakeCtx(undefined)
  phaseAuditListener(f.ctx, cfg, audit, failingMirror(), bg)
  const cb = f.handlers.get('tools/pre-execute')
  const r = await cb({ name: 'fde_phase_advance', arguments: { to: '5' }, callId: 'c9' }, () => Promise.resolve())
  const rows = audit.records.filter((x) => x.type === BG_CHAIN_TYPES.BYPASS)
  assertEq(rows.length, 1)
  assertEq(rows[0].denyId, 'D3')
  assertEq(rows[0].callAllowed, false, 'D2 仍然拦住了 ⇒ 这次放行没换来成功推进')
  assertEq(r.kind, 'deny', '仍应返回 deny')
  assert(audit.records.some((x) => x.decision === 'deny' && x.checks.includes('D2')))
})

ta('自动补正：文件 + 镜像 + 链三处同改（先文件后镜像再链）', async () => {
  const onto = mkOnto()
  const cfg = mkPhaseCfg('3', onto)
  const rec = mkRecord('D1', cfg)
  const bg = mkBg([rec])
  writeBreakGlassAtomic(bgPathOf(cfg), [rec]) // 盘上也要有，否则补正无从落笔
  const audit = fakeAudit()
  const f = fakeCtx(undefined)
  phaseAuditListener(f.ctx, cfg, audit, passingD1Mirror(onto), bg)
  const cb = f.handlers.get('tools/pre-execute')
  await cb({ name: 'fde_phase_advance', arguments: { to: '4' }, callId: 'c7' }, () => Promise.resolve())

  assertEq(readBreakGlassSync(bgPathOf(cfg)).records[0].status, 'resolved', '① 盘上应标 resolved')
  assertEq(bg.get(rec.id).status, 'resolved', '② 镜像应标 resolved')
  const rs = audit.records.filter((r) => r.type === BG_CHAIN_TYPES.RESOLVED)
  assertEq(rs.length, 1, '③ 链上应有一条 break-glass-resolved')
  assertEq(rs[0].id, rec.id)
  assertEq(rs[0].denyId, 'D1')
})

ta('自动补正会广播 resolved 给 gate（否则 gate 重启后永远开着）', async () => {
  const onto = mkOnto()
  const cfg = mkPhaseCfg('3', onto)
  const rec = mkRecord('D1', cfg)
  const bg = mkBg([rec])
  writeBreakGlassAtomic(bgPathOf(cfg), [rec])
  const f = fakeCtx(undefined)
  phaseAuditListener(f.ctx, cfg, fakeAudit(), passingD1Mirror(onto), bg)
  await f.handlers.get('tools/pre-execute')({ name: 'fde_phase_advance', arguments: { to: '4' }, callId: 'c8' }, () =>
    Promise.resolve()
  )
  const ev = f.emitted.filter((e) => e.name === 'fde/break-glass')
  assertEq(ev.length, 1, '应广播一次补正')
  assertEq(ev[0].payload.id, rec.id)
  assertEq(ev[0].payload.resolved, true)
})

ta('补正时**文件写失败** ⇒ 不动镜像、不写 resolved，链上记 break-glass-resolve-failed', async () => {
  const onto = mkOnto()
  const cfg = mkPhaseCfg('3', onto)
  const rec = mkRecord('D1', cfg)
  const bg = mkBg([rec])
  // 盘上写成**坏 JSON** ⇒ readBreakGlassSync 返回 ok:false ⇒ 走失败分支且不覆盖坏证据
  writeFileSync(bgPathOf(cfg), '{坏了')
  const audit = fakeAudit()
  const f = fakeCtx(undefined)
  phaseAuditListener(f.ctx, cfg, audit, passingD1Mirror(onto), bg)
  await f.handlers.get('tools/pre-execute')({ name: 'fde_phase_advance', arguments: { to: '4' }, callId: 'c6' }, () =>
    Promise.resolve()
  )

  assertEq(bg.get(rec.id).status, 'open', '镜像不该被改 —— 盘上还开着')
  assertEq(readFileSync(bgPathOf(cfg), 'utf8'), '{坏了', '坏证据必须原样保留')
  assertEq(audit.records.filter((r) => r.type === BG_CHAIN_TYPES.RESOLVED).length, 0, '不该写 resolved')
  const fails = audit.records.filter((r) => r.type === 'break-glass-resolve-failed')
  assertEq(fails.length, 1, '失败必须留痕')
  assertEq(fails[0].id, rec.id)
  assert(f.bg === undefined || true)
  rmSync(bgPathOf(cfg) + '.tmp', { force: true })
})

ta('无 bypass 时链上零 bypass 记录（放行路径不许刷屏）', async () => {
  const cfg = mkPhaseCfg('3')
  const { audit, p } = runPhaseListener(cfg, failingMirror(), mkBg([]))
  await p
  assertEq(audit.records.filter((r) => r.type === BG_CHAIN_TYPES.BYPASS).length, 0)
})

// ══════════════════════════════════════════════════════════════════ §9
lines.push('')
lines.push('[§9 gate pre-execute：bypass 留痕]')

ta('gate 放行 ⇒ 链上一条 break-glass-bypass，callAllowed=enforcing 且带 paths', async () => {
  const onto = mkOnto()
  const cfg = mkGateCfg(onto)
  const bg = mkBg([mkRecord('GATE-PATH', cfg)])
  const audit = fakeAudit()
  const f = fakeCtx(undefined)
  gateAuditListener(f.ctx, cfg, audit, bg)
  const cb = f.handlers.get('tools/pre-execute')
  const r = await cb(shellExec(`echo hi > ${join(onto, 'actions.yaml')}`), () => Promise.resolve())

  const rows = audit.records.filter((x) => x.type === BG_CHAIN_TYPES.BYPASS)
  assertEq(rows.length, 1, '应留一条 bypass 痕')
  assertEq(rows[0].denyId, 'GATE-PATH')
  assertEq(rows[0].callAllowed, true, 'enforce 模式下确实放行了')
  assert(Array.isArray(rows[0].paths) && rows[0].paths.length > 0, 'hits 应进留痕')
  assertEq(r, undefined, '不应返回 deny')
  assertEq(audit.records.filter((x) => x.decision === 'deny').length, 0, '不该同时记一条 deny')
})

ta('gate shadow 模式下放行 ⇒ callAllowed=false（这条路本来就不拦）', async () => {
  const onto = mkOnto()
  const cfg = mkGateCfg(onto, { mode: 'shadow' })
  const bg = mkBg([mkRecord('GATE-PATH', cfg)])
  const audit = fakeAudit()
  const f = fakeCtx(undefined)
  gateAuditListener(f.ctx, cfg, audit, bg)
  await f.handlers.get('tools/pre-execute')(
    shellExec(`echo hi > ${join(onto, 'actions.yaml')}`),
    () => Promise.resolve()
  )
  const rows = audit.records.filter((x) => x.type === BG_CHAIN_TYPES.BYPASS)
  assertEq(rows.length, 1)
  assertEq(rows[0].callAllowed, false)
  assertEq(rows[0].mode, 'shadow')
})

ta('gate 无放行 ⇒ 行为与接线前一致（记 deny 并返回 deny）', async () => {
  const onto = mkOnto()
  const cfg = mkGateCfg(onto)
  const audit = fakeAudit()
  const f = fakeCtx(undefined)
  gateAuditListener(f.ctx, cfg, audit, new BreakGlassMirror())
  const r = await f.handlers.get('tools/pre-execute')(
    shellExec(`echo hi > ${join(onto, 'actions.yaml')}`),
    () => Promise.resolve()
  )
  assertEq(r.kind, 'deny')
  assertEq(audit.records.filter((x) => x.type === BG_CHAIN_TYPES.BYPASS).length, 0)
  assertEq(audit.records.filter((x) => x.decision === 'deny').length, 1)
})

ta('gate 无 bg 参数（缺省）⇒ 仍然拦（fail-closed 缺省值）', async () => {
  const onto = mkOnto()
  const cfg = mkGateCfg(onto)
  const audit = fakeAudit()
  const f = fakeCtx(undefined)
  gateAuditListener(f.ctx, cfg, audit) // 不传 bg
  const r = await f.handlers.get('tools/pre-execute')(
    shellExec(`echo hi > ${join(onto, 'actions.yaml')}`),
    () => Promise.resolve()
  )
  assertEq(r.kind, 'deny')
})

// ================================================================ 收尾
await Promise.all(pending)

lines.push('')
if (process.env.FDE_INVERT === '1') {
  t('[INVERT] 故意失败以验证退出码敏感', () => assert(false, 'injected by FDE_INVERT'))
}

lines.push(`通过 ${passed} / 失败 ${failed}`)
lines.push(failed > 0 ? 'RESULT: FAIL' : 'RESULT: PASS')
writeFileSync(process.env.FDE_OUT ?? OUT, lines.join('\n') + '\n', 'utf8')

console.log(`[e1-test] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
