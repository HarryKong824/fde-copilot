/**
 * dsh-fde-memory —— source 防污染（B1）+ R2 逐条确认（B2）离线回归。
 *
 * 跑法：
 *   node _fde_memory_source_test.mjs
 *   故意验证退出码会变红： FDE_INVERT=1 node _fde_memory_source_test.mjs
 *
 * 结果**自己写文件**（`_memory_source_test_out.txt`）—— 不走控制台（Windows 代码页乱码纪律）。
 *
 * 覆盖（0090 差距清单 B1 §7 + B2 §5）：
 *   A. writeDecision 纯函数 source 防污染：
 *      · client_stated 无 provenance → 抛；有 provenance → 写成功（provenance 落盘）
 *      · fde_confirmed 无 approved_at → 抛；有 approved_at → 写成功
 *      · plugin_inferred 无需 provenance → 写成功
 *   B. fde_memory_write_decision 工具：
 *      · source=fde_confirmed → 抛 MEMORY_SOURCE_POLLUTED + 审计 source-polluted
 *      · source=client_stated 无 provenance → 抛 MEMORY_BAD_PROVENANCE
 *      · source=client_stated 有 provenance → 写成功
 *   C. fde_memory_confirm 工具（R2 逐条确认，经 approval）：
 *      · reason 缺失 → 抛 MEMORY_BAD_REASON（R2 一句话理由必填）
 *      · rejected → 抛 MEMORY_CONFIRM_REJECTED + 审计 outcome=rejected
 *      · allowed-once → 写 source=fde_confirmed + 审计 outcome=confirmed
 *      · unavailable / cancelled → 抛 MEMORY_CONFIRM_UNAVAILABLE + 审计 outcome=unavailable（fail-closed）
 *
 * ⚠️ 本测试不覆盖真 SDK 的 approval.request 路由 —— 那些只在活 DSH 里能验（用户点 allow/reject）。
 * 离线只钉住「防污染拒绝 + confirm 三态开关」的纯逻辑。
 */

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeDecision, readDecision, assertPhaseId } from './dsh-fde-memory/lib/decisions.js'
import { installMemoryTools, WRITE_DECISION_TOOL, CONFIRM_TOOL } from './dsh-fde-memory/lib/tools.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_memory_source_test_out.txt')
const lines = []
let passed = 0
let failed = 0
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

function assertThrows(fn, pattern, msg) {
  let threw = null
  try {
    fn()
  } catch (e) {
    threw = e
  }
  if (!threw) throw new Error(`${msg || '期望抛错'}：没有抛`)
  const hay = `${threw.code ?? ''} ${threw.message ?? ''}`
  if (pattern && !hay.includes(pattern)) {
    throw new Error(`${msg || '错误不符'}：期望包含 "${pattern}"，实际 ${hay}`)
  }
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
function mkProject() {
  return mkdtempSync(join(tmpdir(), 'fde-memory-src-'))
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

/** 假 ctx：提供 askApproval 用到的 ctx.get + installMemoryTools 用到的 ctx.tools.register。 */
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

/** 假 audit：记录 record 调用（含 type/outcome），供断言 source-polluted / memory-confirm 审计。 */
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

const phase = '3'

// ================================================================ 测试体
lines.push('== dsh-fde-memory source 防污染（B1）+ R2 逐条确认（B2）离线回归 ==')

// ---------- A. writeDecision 纯函数 source 防污染 ----------
lines.push('[A. writeDecision source 防污染]')
t('client_stated 无 provenance → 抛', () => {
  assertThrows(
    () => writeDecision(mkProject(), { phase, decision: 'd', source: 'client_stated' }),
    'provenance',
    'client_stated 无 provenance 应抛'
  )
})
t('client_stated 有 provenance → 写成功且 provenance 落盘', () => {
  const root = mkProject()
  const r = writeDecision(root, { phase, decision: 'd', source: 'client_stated', provenance: 'doc://x/y.md' })
  const obj = readDecision(root, phase, r.seq)
  assertEq(obj.source, 'client_stated')
  assertEq(obj.provenance, 'doc://x/y.md', 'provenance 应落盘')
})
t('fde_confirmed 无 approved_at → 抛', () => {
  assertThrows(
    () => writeDecision(mkProject(), { phase, decision: 'd', source: 'fde_confirmed' }),
    'approval',
    'fde_confirmed 无 approved_at 应抛'
  )
})
t('fde_confirmed 有 approved_at → 写成功', () => {
  const root = mkProject()
  const r = writeDecision(root, { phase, decision: 'd', source: 'fde_confirmed', approved_at: '2026-09-28T00:00:00Z' })
  const obj = readDecision(root, phase, r.seq)
  assertEq(obj.source, 'fde_confirmed')
  assertEq(obj.approved_at, '2026-09-28T00:00:00Z', 'approved_at 应落盘')
})
t('plugin_inferred 无需 provenance → 写成功', () => {
  const root = mkProject()
  const r = writeDecision(root, { phase, decision: 'd', source: 'plugin_inferred' })
  assertEq(readDecision(root, phase, r.seq).source, 'plugin_inferred')
})

// ---------- B. fde_memory_write_decision 工具 source 防污染 ----------
lines.push('[B. write_decision 工具 source 防污染]')
const writeExec = { agent: {}, name: WRITE_DECISION_TOOL, callId: 'c1' }

ta('write_decision: source=fde_confirmed → 抛 MEMORY_SOURCE_POLLUTED + 审计 source-polluted', async () => {
  const ap = mkApproval('allowed-once')
  const audit = fakeAudit()
  const f = fakeCtx(ap)
  installMemoryTools(f.ctx, { projectRoot: mkProject() }, audit)
  const def = f.defs.find((d) => d.name === WRITE_DECISION_TOOL)
  await assertRejects(
    () => def.execute({ phase, decision: 'd', source: 'fde_confirmed' }, writeExec),
    '防污染',
    '直接写 fde_confirmed 应抛'
  )
  const sp = audit.records.filter((r) => r.type === 'source-polluted')
  assertEq(sp.length, 1, '应记一条 source-polluted 审计')
})

ta('write_decision: source=client_stated 无 provenance → 抛 MEMORY_BAD_PROVENANCE', async () => {
  const ap = mkApproval('allowed-once')
  const f = fakeCtx(ap)
  installMemoryTools(f.ctx, { projectRoot: mkProject() })
  const def = f.defs.find((d) => d.name === WRITE_DECISION_TOOL)
  await assertRejects(
    () => def.execute({ phase, decision: 'd', source: 'client_stated' }, writeExec),
    'provenance',
    'client_stated 无 provenance 应抛'
  )
})

ta('write_decision: source=client_stated 有 provenance → 写成功', async () => {
  const root = mkProject()
  const ap = mkApproval('allowed-once')
  const f = fakeCtx(ap)
  installMemoryTools(f.ctx, { projectRoot: root })
  const def = f.defs.find((d) => d.name === WRITE_DECISION_TOOL)
  const out = await def.execute({ phase, decision: 'd', source: 'client_stated', provenance: 'sess://abc' }, writeExec)
  assertEq(readDecision(root, phase, out.seq).provenance, 'sess://abc')
})

// ---------- C. fde_memory_confirm 工具（R2 逐条确认） ----------
lines.push('[C. confirm 工具 R2 逐条确认三态]')
const confirmExec = { agent: {}, name: CONFIRM_TOOL, callId: 'c2' }

ta('confirm: reason 缺失 → 抛 MEMORY_BAD_REASON（R2 一句话理由必填）', async () => {
  const ap = mkApproval('allowed-once')
  const f = fakeCtx(ap)
  installMemoryTools(f.ctx, { projectRoot: mkProject() })
  const def = f.defs.find((d) => d.name === CONFIRM_TOOL)
  await assertRejects(
    () => def.execute({ phase, decision: 'd' }, confirmExec),
    'reason',
    'R2 缺理由应抛'
  )
})

ta('confirm: rejected → 抛 MEMORY_CONFIRM_REJECTED + 审计 outcome=rejected，不写盘', async () => {
  const root = mkProject()
  const ap = mkApproval('rejected')
  const audit = fakeAudit()
  const f = fakeCtx(ap)
  installMemoryTools(f.ctx, { projectRoot: root }, audit)
  const def = f.defs.find((d) => d.name === CONFIRM_TOOL)
  await assertRejects(
    () => def.execute({ phase, decision: 'd', reason: 'r' }, confirmExec),
    '确认',
    'rejected 应抛'
  )
  const mc = audit.records.filter((r) => r.type === 'memory-confirm')
  assertEq(mc.length, 1)
  assertEq(mc[0].outcome, 'rejected')
})

ta('confirm: allowed-once → 写 source=fde_confirmed（带 approved_at）+ 审计 outcome=confirmed', async () => {
  const root = mkProject()
  const ap = mkApproval('allowed-once')
  const audit = fakeAudit()
  const f = fakeCtx(ap)
  installMemoryTools(f.ctx, { projectRoot: root }, audit)
  const def = f.defs.find((d) => d.name === CONFIRM_TOOL)
  const out = await def.execute({ phase, decision: 'd', reason: '客户确认了数据接入范围' }, confirmExec)
  const obj = readDecision(root, phase, out.seq)
  assertEq(obj.source, 'fde_confirmed')
  assert(typeof obj.approved_at === 'string' && obj.approved_at.length > 0, 'approved_at 应存在')
  const mc = audit.records.filter((r) => r.type === 'memory-confirm')
  assertEq(mc.length, 1)
  assertEq(mc[0].outcome, 'confirmed')
})

for (const outcome of ['unavailable', 'cancelled']) {
  ta(`confirm: ${outcome} → 抛 MEMORY_CONFIRM_UNAVAILABLE（fail-closed）+ 审计 outcome=unavailable`, async () => {
    const ap = mkApproval(outcome)
    const audit = fakeAudit()
    const f = fakeCtx(ap)
    installMemoryTools(f.ctx, { projectRoot: mkProject() }, audit)
    const def = f.defs.find((d) => d.name === CONFIRM_TOOL)
    await assertRejects(
      () => def.execute({ phase, decision: 'd', reason: 'r' }, confirmExec),
      '无法产生 fde_confirmed',
      `${outcome} 应 fail-closed 抛错`
    )
    const mc = audit.records.filter((r) => r.type === 'memory-confirm')
    assertEq(mc.length, 1)
    assertEq(mc[0].outcome, 'unavailable')
  })
}

// ================================================================ 收尾
await Promise.all(pending)

lines.push('')
if (process.env.FDE_INVERT === '1') {
  t('[INVERT] 故意失败以验证退出码敏感', () => assert(false, 'injected by FDE_INVERT'))
}

lines.push(`通过 ${passed} / 失败 ${failed}`)
lines.push(failed > 0 ? 'RESULT: FAIL' : 'RESULT: PASS')
writeFileSync(process.env.FDE_OUT ?? OUT, lines.join('\n') + '\n', 'utf8')

console.log(`[memory-source-test] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
