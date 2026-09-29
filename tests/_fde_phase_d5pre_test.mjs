/**
 * dsh-fde-phase —— D5-pre（B3：Phase 2 数据接入前置检查 + compliance.yaml 写入）离线回归。
 *
 * 跑法：
 *   node _fde_phase_d5pre_test.mjs
 *   故意验证退出码会变红： FDE_INVERT=1 node _fde_phase_d5pre_test.mjs
 *
 * 结果**自己写文件**（`_phase_d5pre_test_out.txt`）—— 不走控制台（Windows 代码页乱码纪律）。
 *
 * 覆盖（0090 差距清单 B3 §10.3）：
 *   A. writeComplianceDataPolicy 纯函数：
 *      · 文件不存在 → 创建含 data_policy（authorization + deidentification）
 *      · 文件存在（含其它键）→ 合并保留其它键 + 更新 data_policy
 *      · authorization / deidentification 空 → 抛
 *      · 现有文件坏掉（parse-error）→ 抛（fail-closed，不覆盖）
 *   B. serializeComplianceYaml ↔ parseComplianceYaml 对称（写出的能被 D5 读回且 data_policy 非空）
 *   C. fde_phase_advance 的 D5-pre：
 *      · current=2 缺 data_authorization/deidentification → 抛 D5PRE_MISSING_FIELDS
 *      · current=2 + allowed-once → 写 compliance.yaml + d5PreApproval=confirmed
 *      · current=2 + rejected → 抛 D5PRE_REJECTED（不写 compliance.yaml）
 *      · current=2 + unavailable → 降级放行（d5PreApproval=degraded，不写 compliance.yaml）
 *      · current=9（非 2）→ 不触发 D5-pre（d5PreApproval=n/a）
 *
 * ⚠️ 不覆盖真 SDK 的 approval.request 路由 —— 只在活 DSH 里能验（用户点 allow/reject）。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeComplianceDataPolicy, serializeComplianceYaml, compliancePath } from '../dsh-fde-phase/lib/compliance-write.js'
import { parseComplianceYaml, verifyComplianceText } from '../dsh-fde-phase/lib/check-d5.js'
import { installPhaseTool } from '../dsh-fde-phase/lib/tools.js'
import { readState, DEFAULT_STATE, serializeState } from '../dsh-fde-phase/lib/state.js'
import { D1Mirror } from '../dsh-fde-phase/lib/mirror.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_phase_d5pre_test_out.txt')
const lines = []
let passed = 0
let failed = 0
const pending = []

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

function assertThrows(fn, pattern, msg) {
  let threw = null
  try { fn() } catch (e) { threw = e }
  if (!threw) throw new Error(`${msg || '期望抛错'}：没有抛`)
  const hay = `${threw.code ?? ''} ${threw.message ?? ''}`
  if (pattern && !hay.includes(pattern)) {
    throw new Error(`${msg || '错误不符'}：期望包含 "${pattern}"，实际 ${hay}`)
  }
}

async function assertRejects(fn, pattern, msg) {
  let threw = null
  try { await fn() } catch (e) { threw = e }
  if (!threw) throw new Error(`${msg || '期望抛错'}：没有抛`)
  const hay = `${threw.code ?? ''} ${threw.message ?? ''}`
  if (pattern && !hay.includes(pattern)) {
    throw new Error(`${msg || '错误不符'}：期望包含 "${pattern}"，实际 ${hay}`)
  }
}

// ---------------------------------------------------------------- 夹具
function mkOntoRoot() {
  return mkdtempSync(join(tmpdir(), 'fde-d5pre-onto-'))
}

function mkProject(currentPhase = '0.1') {
  const root = mkdtempSync(join(tmpdir(), 'fde-d5pre-'))
  const mem = join(root, 'memory')
  mkdirSync(mem, { recursive: true })
  writeFileSync(join(mem, 'state.yaml'), serializeState({ ...DEFAULT_STATE, current_phase: currentPhase }))
  return root
}

function mkCfg(phase) {
  return {
    projectRoot: mkProject(phase),
    ontologyRoot: mkOntoRoot(),
    mode: 'enforce',
    lockTtlMs: 30000,
    gateAuditPath: 'g'
  }
}

function mkApproval(outcome) {
  const calls = []
  return { calls, request: async (req) => { calls.push(req); return outcome } }
}

function fakeCtx(approval) {
  const defs = []
  return {
    defs,
    ctx: {
      get: (n) => (n === 'approval' ? approval : undefined),
      tools: { register: (d) => { defs.push(d); return () => {} } }
    }
  }
}

function fakeAudit() {
  return { records: [], async record(r) { this.records.push(r); return { seq: this.records.length } }, async flush() {} }
}

// ================================================================ 测试体
lines.push('== dsh-fde-phase D5-pre（B3）离线回归 ==')

// ---------- A. writeComplianceDataPolicy 纯函数 ----------
lines.push('[A. writeComplianceDataPolicy]')
t('文件不存在 → 创建含 data_policy', () => {
  const root = mkOntoRoot()
  writeComplianceDataPolicy(root, { authorization: '客户授权书 #A1', deidentification: '姓名/证件号脱敏' })
  const p = compliancePath(root)
  assert(existsSync(p), 'compliance.yaml 应被创建')
  const obj = parseComplianceYaml(readFileSync(p, 'utf8'))
  assert(obj.ok, '写入后应可解析')
  assertEq(obj.obj.data_policy.authorization, '客户授权书 #A1')
  assertEq(obj.obj.data_policy.deidentification, '姓名/证件号脱敏')
})
t('文件存在（含其它键）→ 合并保留其它键 + 更新 data_policy', () => {
  const root = mkOntoRoot()
  writeFileSync(
    compliancePath(root),
    'output_boundary: "系统输出需执业人员复核"\nchange_assessment:\n  classified: true\n',
    'utf8'
  )
  writeComplianceDataPolicy(root, { authorization: 'A2', deidentification: 'D2' })
  const obj = parseComplianceYaml(readFileSync(compliancePath(root), 'utf8')).obj
  assertEq(obj.output_boundary, '系统输出需执业人员复核', '其它键应保留')
  assertEq(obj.change_assessment.classified, true, 'change_assessment 应保留')
  assertEq(obj.data_policy.authorization, 'A2')
  assertEq(obj.data_policy.deidentification, 'D2')
})
t('authorization 空 → 抛', () => {
  assertThrows(() => writeComplianceDataPolicy(mkOntoRoot(), { authorization: '  ', deidentification: 'x' }), 'authorization')
})
t('deidentification 空 → 抛', () => {
  assertThrows(() => writeComplianceDataPolicy(mkOntoRoot(), { authorization: 'x', deidentification: '' }), 'deidentification')
})
t('现有文件坏掉（parse-error）→ 抛（fail-closed，不覆盖）', () => {
  const root = mkOntoRoot()
  writeFileSync(compliancePath(root), '这不是顶层键也不是子内容\n', 'utf8')
  assertThrows(() => writeComplianceDataPolicy(root, { authorization: 'x', deidentification: 'y' }), '拒绝覆盖')
  // 原坏文件必须原样保留（没被覆盖）
  assertEq(readFileSync(compliancePath(root), 'utf8'), '这不是顶层键也不是子内容\n', '坏文件不应被覆盖')
})

// ---------- B. serialize ↔ parse 对称（D5 能读回且 data_policy 非空） ----------
lines.push('[B. serialize ↔ parse 对称]')
t('写入后 verifyComplianceText 能认 data_policy 非空（D5 前置可被满足）', () => {
  const root = mkOntoRoot()
  writeComplianceDataPolicy(root, { authorization: 'A', deidentification: 'D' })
  const r = verifyComplianceText(readFileSync(compliancePath(root), 'utf8'))
  const dp = r.failures.filter((f) => f.key === 'data_policy')
  assertEq(dp.length, 0, 'data_policy 不应有缺失/空值失败')
})
t('serializeComplianceYaml 输出可被 parseComplianceYaml 读回（标量/嵌套/list）', () => {
  const yaml = serializeComplianceYaml({
    output_boundary: '字符串',
    review_chain: { reviewer: '张医生', reviewed_at: '2026-09-28' },
    data_policy: { authorization: 'A', deidentification: 'D' },
    change_assessment: { classified: true }
  })
  const parsed = parseComplianceYaml(yaml)
  assert(parsed.ok, '序列化输出应可解析')
  assertEq(parsed.obj.review_chain.reviewer, '张医生')
  assertEq(parsed.obj.change_assessment.classified, true)
})

// ---------- C. fde_phase_advance 的 D5-pre ----------
lines.push('[C. fde_phase_advance D5-pre 三态]')
const advExec = { agent: {}, name: 'fde_phase_advance', callId: 'c1' }

ta('current=2 缺 data_authorization/deidentification → 抛 D5PRE_MISSING_FIELDS', async () => {
  const cfg = mkCfg('2')
  const f = fakeCtx(mkApproval('allowed-once'))
  installPhaseTool(f.ctx, cfg, fakeAudit(), new D1Mirror())
  const def = f.defs[0]
  await assertRejects(() => def.execute({ to: '3', reason: 'x' }, advExec), 'D5-pre')
  assert(!existsSync(compliancePath(cfg.ontologyRoot)), '缺字段时不应写 compliance.yaml')
})

ta('current=2 + allowed-once → 写 compliance.yaml + d5PreApproval=confirmed', async () => {
  const cfg = mkCfg('2')
  const audit = fakeAudit()
  const f = fakeCtx(mkApproval('allowed-once'))
  installPhaseTool(f.ctx, cfg, audit, new D1Mirror())
  const def = f.defs[0]
  const out = await def.execute({ to: '3', reason: 'x', data_authorization: '授权书', deidentification_plan: '脱敏' }, advExec)
  assertEq(out.d5PreApproval, 'confirmed')
  const obj = parseComplianceYaml(readFileSync(compliancePath(cfg.ontologyRoot), 'utf8')).obj
  assertEq(obj.data_policy.authorization, '授权书')
  assertEq(obj.data_policy.deidentification, '脱敏')
  const st = await readState(join(cfg.projectRoot, 'memory', 'state.yaml'))
  assertEq(st.current_phase, '3', '确认后应推进到 3')
})

ta('current=2 + rejected → 抛 D5PRE_REJECTED（不写 compliance.yaml，不推进）', async () => {
  const cfg = mkCfg('2')
  const audit = fakeAudit()
  const f = fakeCtx(mkApproval('rejected'))
  installPhaseTool(f.ctx, cfg, audit, new D1Mirror())
  const def = f.defs[0]
  await assertRejects(
    () => def.execute({ to: '3', reason: 'x', data_authorization: 'a', deidentification_plan: 'd' }, advExec),
    'D5-pre'
  )
  assert(!existsSync(compliancePath(cfg.ontologyRoot)), 'rejected 不应写 compliance.yaml')
  const st = await readState(join(cfg.projectRoot, 'memory', 'state.yaml'))
  assertEq(st.current_phase, '2', 'rejected 不应推进')
})

ta('current=2 + unavailable → 降级放行（d5PreApproval=degraded，不写 compliance.yaml）', async () => {
  const cfg = mkCfg('2')
  const f = fakeCtx(mkApproval('unavailable'))
  installPhaseTool(f.ctx, cfg, fakeAudit(), new D1Mirror())
  const def = f.defs[0]
  const out = await def.execute({ to: '3', reason: 'x', data_authorization: 'a', deidentification_plan: 'd' }, advExec)
  assertEq(out.d5PreApproval, 'degraded')
  assert(!existsSync(compliancePath(cfg.ontologyRoot)), 'degraded 不应写 compliance.yaml')
  const st = await readState(join(cfg.projectRoot, 'memory', 'state.yaml'))
  assertEq(st.current_phase, '3', 'degraded 仍放行推进（ask 语义）')
})

ta('current=9（非 2）→ 不触发 D5-pre（d5PreApproval=n/a）', async () => {
  const cfg = mkCfg('9')
  const ap = mkApproval('allowed-once')
  const f = fakeCtx(ap)
  installPhaseTool(f.ctx, cfg, fakeAudit(), new D1Mirror())
  const def = f.defs[0]
  const out = await def.execute({ to: '10', reason: 'x' }, advExec)
  assertEq(out.d5PreApproval, 'n/a')
  assertEq(ap.calls.length, 0, '非 Phase 2 不应调 approval.request')
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

console.log(`[phase-d5pre-test] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
