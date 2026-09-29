/**
 * C3 回滚预授权 —— 离线回归（spec §10.4 + §10.1 表第 5 键）。
 *
 * 跑法：
 *   node _fde_c3_test.mjs
 *   FDE_INVERT=1 node _fde_c3_test.mjs   （故意做反：通过应 EXIT=1，验证断言有效）
 *
 * 覆盖：
 *   §1 inObservation 单元（空串 / 非法时间戳 / 观察期内 / 23h / 25h）
 *   §2 serializeState/parseState 的 rollback_at 往返（新字段进 DEFAULT_STATE）
 *   §3 guard.evaluate 观察期冻结（rollback_at 观察期内 ⇒ deny 含「观察期」；空串 ⇒ 不因观察期 deny）
 *   §4 fde_rollback execute（无预授权 ⇒ throw + rollback-denied；有预授权 ⇒ 落 rollback_at + rollback 审计；
 *      重复回滚 ⇒ throw ROLLBACK_ALREADY_OBSERVING）
 *   §5 fde_phase_advance execute 观察期冻结（观察期内 ⇒ throw ROLLBACK_OBSERVATION_ACTIVE）
 *
 * 注：D5 第 5 键 rollback_preauth 的判据反例由 _fde_d5_test.mjs 覆盖（§3b）。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_STATE,
  serializeState,
  parseState,
  inObservation
} from '../dsh-fde-phase/lib/state.js'
import { evaluate } from '../dsh-fde-phase/lib/guard.js'
import { D1Mirror } from '../dsh-fde-phase/lib/mirror.js'
import { installRollbackTool, installPhaseTool } from '../dsh-fde-phase/lib/tools.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_fde_c3_out.txt')
const lines = []
let passed = 0
let failed = 0
const pending = []

function t(name, fn) {
  try {
    fn()
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

// 把 state 对象写成 yaml（用 serializeState，测试里需要非默认 rollback_at）。
function writeStateFile(dir, state) {
  const memoryDir = join(dir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const p = join(memoryDir, 'state.yaml')
  writeFileSync(p, serializeState(state), 'utf8')
  return p
}

// ================================================================ 测试体
lines.push('== C3 回滚预授权 offline ==')

// ---------- §1 inObservation 单元 ----------
lines.push('[inObservation 单元]')
t('inObservation({rollback_at:""}) => false（空串=无观察期）', () => {
  assertEq(inObservation({ rollback_at: '' }), false)
})
t('inObservation({rollback_at:"not-a-date"}) => false（非法时间戳不判观察）', () => {
  assertEq(inObservation({ rollback_at: 'not-a-date' }), false)
})
t('inObservation({}) => false（缺字段）', () => {
  assertEq(inObservation({}), false)
})
t('inObservation(undefined) => false', () => {
  assertEq(inObservation(undefined), false)
})
t('inObservation(now) => true（刚回滚，观察期内）', () => {
  assertEq(inObservation({ rollback_at: new Date().toISOString() }), true)
})
t('inObservation(23h 前) => true（未满 24h）', () => {
  assertEq(inObservation({ rollback_at: new Date(Date.now() - 23 * 3600 * 1000).toISOString() }), true)
})
t('inObservation(25h 前) => false（已过 24h 观察期）', () => {
  assertEq(inObservation({ rollback_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }), false)
})

// ---------- §2 state 往返 ----------
lines.push('[state rollback_at 往返]')
t('DEFAULT_STATE 含 rollback_at: ""', () => {
  assertEq(DEFAULT_STATE.rollback_at, '')
})
t('serializeState 输出含 rollback_at 行', () => {
  const yaml = serializeState({ ...DEFAULT_STATE, rollback_at: '2026-09-28T10:00:00.000Z' })
  assert(yaml.includes('rollback_at: "2026-09-28T10:00:00.000Z"'), '应含 rollback_at 行，实际 ' + JSON.stringify(yaml))
})
t('parseState 读回 rollback_at', () => {
  const yaml = serializeState({ ...DEFAULT_STATE, rollback_at: '2026-09-28T10:00:00.000Z' })
  const s = parseState(yaml)
  assertEq(s.rollback_at, '2026-09-28T10:00:00.000Z')
})

// ---------- §3 guard.evaluate 观察期冻结 ----------
lines.push('[guard.evaluate 观察期冻结]')
t('观察期内 ⇒ deny 含「观察期」，且先于推进规则/门禁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c3-guard-'))
  writeStateFile(dir, { ...DEFAULT_STATE, current_phase: '5', rollback_at: new Date().toISOString() })
  const cfg = { projectRoot: dir, ontologyRoot: join(dir, 'onto'), mode: 'enforce', gateAuditPath: '', industry: '未声明' }
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '6', reason: 'x' } }, cfg, new D1Mirror())
  assert(r.deny && r.deny.includes('观察期'), '应因观察期 deny，实际 ' + JSON.stringify(r.deny))
  rmSync(dir, { recursive: true, force: true })
})
t('rollback_at 空 ⇒ 不因观察期 deny（观察期不触发）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c3-guard-'))
  writeStateFile(dir, { ...DEFAULT_STATE, current_phase: '5' })
  const cfg = { projectRoot: dir, ontologyRoot: join(dir, 'onto'), mode: 'enforce', gateAuditPath: '', industry: '未声明' }
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '6', reason: 'x' } }, cfg, new D1Mirror())
  // 非观察期：deny 若存在，也不该含「观察期」（可能因 D5 未过等其他原因 deny）
  assert(!(r.deny && r.deny.includes('观察期')), '不应因观察期 deny，实际 ' + JSON.stringify(r.deny))
  rmSync(dir, { recursive: true, force: true })
})

// ---------- §4 fde_rollback execute ----------
lines.push('[fde_rollback execute]')
ta('无预授权（compliance.yaml 缺 rollback_preauth）⇒ throw + rollback-denied 审计', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c3-rollback-'))
  const onto = join(dir, 'onto')
  mkdirSync(onto, { recursive: true })
  writeFileSync(join(onto, 'compliance.yaml'), 'output_boundary:\n  statement: "x"\n', 'utf8')
  const auditRecords = []
  let tool = null
  const ctx = { tools: { register: (t) => { if (t.name === 'fde_rollback') tool = t; return () => {} } } }
  const audit = { record: async (e) => { auditRecords.push(e); return { seq: auditRecords.length, hash: '0'.repeat(64), persisted: false } } }
  const cfg = { ontologyRoot: onto, projectRoot: dir, lockTtlMs: 30000, mode: 'enforce' }
  installRollbackTool(ctx, cfg, audit)
  assert(tool, '应注册 fde_rollback')
  let threw = null
  try { await tool.execute({ reason: '测试回滚' }, { callId: 'c3' }) } catch (e) { threw = e }
  assert(threw, '应抛错')
  assert(String(threw.message).includes('回滚预授权缺失'), '应含「回滚预授权缺失」，实际 ' + threw.message)
  assert(threw.code === 'ROLLBACK_NO_PREAUTH', 'code 应为 ROLLBACK_NO_PREAUTH，实际 ' + threw.code)
  assert(auditRecords.some((r) => r.type === 'rollback-denied' && r.outcome === 'no-preauth'), '应有 rollback-denied/no-preauth 审计')
  rmSync(dir, { recursive: true, force: true })
})
ta('有预授权 ⇒ 成功，落 rollback_at + rollback 审计', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c3-rollback-'))
  const onto = join(dir, 'onto')
  mkdirSync(onto, { recursive: true })
  writeFileSync(join(onto, 'compliance.yaml'), 'rollback_preauth:\n  authorized: true\n', 'utf8')
  const auditRecords = []
  let tool = null
  const ctx = { tools: { register: (t) => { if (t.name === 'fde_rollback') tool = t; return () => {} } } }
  const audit = { record: async (e) => { auditRecords.push(e); return { seq: auditRecords.length, hash: '0'.repeat(64), persisted: false } } }
  const cfg = { ontologyRoot: onto, projectRoot: dir, lockTtlMs: 30000, mode: 'enforce' }
  installRollbackTool(ctx, cfg, audit)
  const exec = { callId: 'c3' }
  const res = await tool.execute({ reason: '部署出错，紧急回滚' }, exec)
  assert(res.preauthorized === true, 'preauthorized 应 true')
  assert(res.observation_hours === 24, '观察期应 24h')
  assert(res.rolled_back_to && res.rolled_back_to.startsWith('rev-'), 'rolled_back_to 应 rev- 开头')
  // state.yaml 落盘 rollback_at
  const s = parseState(readFileSync(join(dir, 'memory', 'state.yaml'), 'utf8'))
  assert(s.rollback_at && s.rollback_at !== '', 'state.rollback_at 应写入')
  assert(inObservation(s) === true, '写入后应处于观察期内')
  assert(auditRecords.some((r) => r.type === 'rollback'), '应有 rollback 审计')
  rmSync(dir, { recursive: true, force: true })
})
ta('已观察期内重复回滚 ⇒ throw ROLLBACK_ALREADY_OBSERVING', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c3-rollback-'))
  const onto = join(dir, 'onto')
  mkdirSync(onto, { recursive: true })
  writeFileSync(join(onto, 'compliance.yaml'), 'rollback_preauth:\n  authorized: true\n', 'utf8')
  writeStateFile(dir, { ...DEFAULT_STATE, current_phase: '6', rollback_at: new Date().toISOString() })
  const auditRecords = []
  let tool = null
  const ctx = { tools: { register: (t) => { if (t.name === 'fde_rollback') tool = t; return () => {} } } }
  const audit = { record: async (e) => { auditRecords.push(e); return { seq: auditRecords.length, hash: '0'.repeat(64), persisted: false } } }
  const cfg = { ontologyRoot: onto, projectRoot: dir, lockTtlMs: 30000, mode: 'enforce' }
  installRollbackTool(ctx, cfg, audit)
  let threw = null
  try { await tool.execute({ reason: '再次回滚' }, { callId: 'c3' }) } catch (e) { threw = e }
  assert(threw, '应抛错')
  assert(String(threw.message).includes('不能重复回滚'), '应含「不能重复回滚」，实际 ' + threw.message)
  assert(threw.code === 'ROLLBACK_ALREADY_OBSERVING', 'code 应为 ROLLBACK_ALREADY_OBSERVING，实际 ' + threw.code)
  assert(auditRecords.some((r) => r.type === 'rollback-denied' && r.outcome === 'already-observing'), '应有 rollback-denied/already-observing 审计')
  rmSync(dir, { recursive: true, force: true })
})

// ---------- §5 fde_phase_advance execute 观察期冻结 ----------
lines.push('[fde_phase_advance execute 观察期冻结]')
ta('观察期内推进 ⇒ throw ROLLBACK_OBSERVATION_ACTIVE（纵深防御）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c3-adv-'))
  writeStateFile(dir, { ...DEFAULT_STATE, current_phase: '6', rollback_at: new Date().toISOString() })
  const auditRecords = []
  let tool = null
  const ctx = { tools: { register: (t) => { if (t.name === 'fde_phase_advance') tool = t; return () => {} } } }
  const audit = { record: async (e) => { auditRecords.push(e); return { seq: auditRecords.length, hash: '0'.repeat(64), persisted: false } } }
  const cfg = { projectRoot: dir, ontologyRoot: join(dir, 'onto'), mode: 'enforce', gateAuditPath: '', industry: '未声明', lockTtlMs: 30000 }
  installPhaseTool(ctx, cfg, audit, new D1Mirror(), undefined)
  assert(tool, '应注册 fde_phase_advance')
  let threw = null
  try { await tool.execute({ to: '7', reason: '推进' }, { callId: 'c3' }) } catch (e) { threw = e }
  assert(threw, '应抛错')
  assert(String(threw.message).includes('观察期'), '应含「观察期」，实际 ' + threw.message)
  assert(threw.code === 'ROLLBACK_OBSERVATION_ACTIVE', 'code 应为 ROLLBACK_OBSERVATION_ACTIVE，实际 ' + threw.code)
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- 收尾
await Promise.all(pending)

if (process.env.FDE_INVERT === '1') {
  lines.push('')
  lines.push('  ✗ [INVERT] 故意失败以验证退出码敏感')
  failed += 1
}
lines.push('')
lines.push('PASS ' + passed + ' / FAIL ' + failed)
lines.push('RESULT: ' + (failed === 0 ? 'PASS' : 'FAIL'))

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log('[c3] wrote ' + OUT + '  PASS ' + passed + ' / FAIL ' + failed)
process.exitCode = failed > 0 ? 1 : 0
