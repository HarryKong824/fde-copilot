/**
 * dsh-fde-phase —— approval 接线 + D4 降 ask 离线回归（施工单 0089）。
 *
 * 跑法：
 *   node _fde_phase_approval_test.mjs
 *   故意验证退出码会变红： FDE_INVERT=1 node _fde_phase_approval_test.mjs
 *
 * 结果**自己写文件**（`_phase_approval_test_out.txt`）—— 不走控制台（Windows 代码页乱码纪律）。
 *
 * 覆盖（对应施工单 0089 §3 三态 + §4 落点）：
 *   - askApproval 降级链（ctx 缺 / ctx.get 缺 / approval undefined / exec 缺 / agent 缺 → 'unavailable'）
 *   - askApproval 四种 outcome 直通 + 参数透传（agent/toolName/callId/reason/signal，不透传 rootCallId）
 *   - execute 层 D4 三态：current=10 时
 *       · rejected      → 抛 D4_REJECTED，state 不变，审计 outcome=rejected
 *       · allowed-once  → 放行推进，d4Approval=confirmed，审计 outcome=confirmed
 *       · unavailable   → 放行推进，d4Approval=degraded，审计 outcome=degraded（fail-open）
 *       · cancelled     → 放行推进，d4Approval=degraded（fail-open）
 *   - current≠10（=9）→ 不触发 approval.request，d4Approval='n/a'，正常推进
 *
 * ⚠️ 本测试不覆盖真 SDK 的 approval.request 路由 / 审计成对写入 —— 那些只在活 DSH 里能验
 * （判据 5/6/7 需要用户在 UI 点 allow/reject）。离线只钉住「降级链 + 三态开关」的纯逻辑。
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { askApproval } from './dsh-fde-phase/lib/approval.js'
import { installPhaseTool } from './dsh-fde-phase/lib/tools.js'
import { readState, DEFAULT_STATE, serializeState } from './dsh-fde-phase/lib/state.js'
import { D1Mirror } from './dsh-fde-phase/lib/mirror.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_phase_approval_test_out.txt')
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
}

// ---------------------------------------------------------------- 夹具
function mkProject(currentPhase = '0.1') {
  const root = mkdtempSync(join(tmpdir(), 'fde-approval-'))
  const mem = join(root, 'memory')
  mkdirSync(mem, { recursive: true })
  writeFileSync(join(mem, 'state.yaml'), serializeState({ ...DEFAULT_STATE, current_phase: currentPhase }))
  return root
}

function mkOnto() {
  const dir = mkdtempSync(join(tmpdir(), 'fde-approval-onto-'))
  writeFileSync(join(dir, 'actions.yaml'), 'actions: []\n')
  writeFileSync(join(dir, 'guards.yaml'), '# default guards\n')
  return dir
}

function mkCfg(phase) {
  return {
    projectRoot: mkProject(phase),
    ontologyRoot: mkOnto(),
    mode: 'enforce',
    lockTtlMs: 30000,
    gateAuditPath: 'g'
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

/** 假 ctx：只提供 askApproval 用到的 ctx.get + installPhaseTool 用到的 ctx.tools.register。 */
function fakeCtx(approval) {
  const defs = []
  return {
    defs,
    ctx: {
      get: (n) => (n === 'approval' ? approval : undefined),
      tools: {
        register: (d) => {
          defs.push(d)
          return () => {}
        }
      }
    }
  }
}

/** 假 audit：记录 record 调用（含 type/outcome），供断言 D4 审计写入。 */
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

const statePathOf = (cfg) => join(cfg.projectRoot, 'memory', 'state.yaml')

// ================================================================ 测试体
lines.push('== dsh-fde-phase approval / D4 ask 离线回归（0089）==')

// ---------- askApproval：降级链 + outcome 直通 + 参数透传 ----------
lines.push('[askApproval 降级链]')
ta('ctx 为 undefined → unavailable', async () => {
  assertEq(await askApproval(undefined, { agent: {} }, 'r'), 'unavailable')
})
ta('ctx.get 不存在（ctx={}）→ unavailable', async () => {
  assertEq(await askApproval({}, { agent: {} }, 'r'), 'unavailable')
})
ta('ctx.get("approval") 返回 undefined → unavailable', async () => {
  assertEq(await askApproval({ get: () => undefined }, { agent: {} }, 'r'), 'unavailable')
})
ta('exec 为 undefined → unavailable（不调 request）', async () => {
  const ap = mkApproval('allowed-once')
  assertEq(await askApproval({ get: () => ap }, undefined, 'r'), 'unavailable')
  assertEq(ap.calls.length, 0)
})
ta('exec.agent 为 undefined → unavailable（不调 request）', async () => {
  const ap = mkApproval('allowed-once')
  assertEq(await askApproval({ get: () => ap }, { name: 't' }, 'r'), 'unavailable')
  assertEq(ap.calls.length, 0)
})

lines.push('[askApproval outcome 直通]')
ta('四种 outcome 原样直通（allowed-once/rejected/cancelled/unavailable）', async () => {
  for (const o of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
    const ap = mkApproval(o)
    assertEq(await askApproval({ get: () => ap }, { agent: {}, name: 't' }, 'r'), o)
  }
})

lines.push('[askApproval 参数透传]')
ta('透传 agent/toolName/callId/reason/signal（不透传 rootCallId）', async () => {
  const ap = mkApproval('allowed-once')
  const agent = {}
  const signal = {}
  await askApproval(
    { get: () => ap },
    { agent, name: 'fde_phase_advance', callId: 'c1', rootCallId: 'r1', signal },
    '确认客户验收'
  )
  const req = ap.calls[0]
  assertEq(req.agent, agent)
  assertEq(req.toolName, 'fde_phase_advance')
  assertEq(req.callId, 'c1')
  assertEq(req.reason, '确认客户验收')
  assertEq(req.signal, signal)
  assert(!('rootCallId' in req), 'rootCallId 不应透传给 approval.request')
})

// ---------- execute 层 D4 三态 + 非 Phase10 不触发 ----------
lines.push('[execute D4 三态]')
ta('D4：current=10 + rejected → 抛 D4_REJECTED，state 不变，审计 outcome=rejected', async () => {
  const ap = mkApproval('rejected')
  const cfg = mkCfg('10')
  const audit = fakeAudit()
  const f = fakeCtx(ap)
  installPhaseTool(f.ctx, cfg, audit, new D1Mirror())
  const def = f.defs[0]
  await assertRejects(
    () => def.execute({ to: '11', reason: 'x' }, { agent: {}, name: 'fde_phase_advance', callId: 'c1' }),
    'D4',
    '应因 D4 拒绝而抛错'
  )
  const st = await readState(statePathOf(cfg))
  assertEq(st.current_phase, '10', 'rejected 后 state 不应推进')
  const d4 = audit.records.filter((r) => r.type === 'phase-advance-d4-ask')
  assertEq(d4.length, 1)
  assertEq(d4[0].outcome, 'rejected')
})

for (const [outcome, expectField] of [
  ['allowed-once', 'confirmed'],
  ['unavailable', 'degraded'],
  ['cancelled', 'degraded']
]) {
  ta(`D4：current=10 + ${outcome} → 放行推进，d4Approval=${expectField}`, async () => {
    const ap = mkApproval(outcome)
    const cfg = mkCfg('10')
    const audit = fakeAudit()
    const f = fakeCtx(ap)
    installPhaseTool(f.ctx, cfg, audit, new D1Mirror())
    const def = f.defs[0]
    const out = await def.execute(
      { to: '11', reason: 'x' },
      { agent: {}, name: 'fde_phase_advance', callId: 'c1' }
    )
    assertEq(out.d4Approval, expectField)
    const st = await readState(statePathOf(cfg))
    assertEq(st.current_phase, '11', 'ask 通过应推进到 11')
    const d4 = audit.records.filter((r) => r.type === 'phase-advance-d4-ask')
    assertEq(d4.length, 1)
    assertEq(d4[0].outcome, expectField)
  })
}

lines.push('[execute D4 非 Phase10 不触发]')
ta('D4：current=9（非 10）→ 不调 approval.request，d4Approval=n/a，正常推进到 10', async () => {
  const ap = mkApproval('allowed-once')
  const cfg = mkCfg('9')
  const audit = fakeAudit()
  const f = fakeCtx(ap)
  installPhaseTool(f.ctx, cfg, audit, new D1Mirror())
  const def = f.defs[0]
  const out = await def.execute(
    { to: '10', reason: 'x' },
    { agent: {}, name: 'fde_phase_advance', callId: 'c1' }
  )
  assertEq(out.d4Approval, 'n/a')
  assertEq(ap.calls.length, 0, '非 Phase 10 不应调 approval.request')
  const st = await readState(statePathOf(cfg))
  assertEq(st.current_phase, '10')
  assertEq(audit.records.filter((r) => r.type === 'phase-advance-d4-ask').length, 0)
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

console.log(`[phase-approval-test] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
