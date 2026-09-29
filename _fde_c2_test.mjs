/**
 * C2 · L0/L1/L2 各自流程 —— 离线回归（spec §4）。
 *
 * 跑法：
 *   node _fde_c2_test.mjs
 *   FDE_INVERT=1 node _fde_c2_test.mjs   （故意做反：若断言有效则应 EXIT=1）
 *
 * 覆盖：
 *   §1 readLatestChange 单元（不可读 / 空文件 / 只有 deny / allow 无 level / 取最后一条 / 半截行）
 *   §2 verifyRequiredChecks 按级别分派（L0=仅 D3、L1=D1+D3、L2=D1+D3+D5、未知级别 fail-closed、
 *      无结论、结论过期）
 *   §3 describeIncomplete 文案（缺项 + 指路工具名）
 *   §4 fde_change_close execute（L0 过 ⇒ 闭环落审计 / L1 缺 D1 ⇒ CHANGE_FLOW_INCOMPLETE /
 *      L2 全过 + approval 允许 ⇒ 闭环 / L2 approval 拒绝 ⇒ CHANGE_APPROVAL_REQUIRED（fail-closed）/
 *      L2 approval 不可用 ⇒ 也拒（与 D4 ask 的三态相反）/ 无变更 ⇒ CHANGE_NONE / 无 level ⇒ CHANGE_NO_LEVEL）
 *
 * 设计要点（为什么这样测）：**级别一律从 gate 审计链读、不由调用方传** —— 所以每个 execute 用例
 * 都必须先造一条 gate.jsonl 记录，而不是往 execute 里塞 level 参数。这也正是夹具的形状。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { D1Mirror, ANCHOR_ALGS, compositeAnchorSha } from './dsh-fde-phase/lib/mirror.js'
import {
  D5_ANCHOR_ALG,
  complianceFingerprintSync
} from './dsh-fde-phase/lib/check-d5.js'
import {
  REQUIRED_CHECKS,
  NEEDS_APPROVAL,
  readLatestChange,
  verifyRequiredChecks,
  describeIncomplete
} from './dsh-fde-phase/lib/change-flow.js'
import { installChangeCloseTool } from './dsh-fde-phase/lib/tools.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_fde_c2_out.txt')
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

// ---------------------------------------------------------------- 夹具
const WRITE = 'fde_ontology_write'

/** 把若干条 gate 记录写成 JSONL（``raw`` 里的字符串原样追加，用来造半截行）。 */
function writeGate(dir, records, raw = []) {
  const p = join(dir, 'gate.jsonl')
  const body = records.map((r) => JSON.stringify(r)).join('\n')
  writeFileSync(p, body + (body ? '\n' : '') + raw.join(''), 'utf8')
  return p
}

function allowRec(seq, level, extra = {}) {
  return { seq, ts: `2026-09-29T00:00:0${seq % 10}.000Z`, tool: WRITE, decision: 'allow', level, ...extra }
}

/** 造一个 ontology 目录 + 内容，返回 {dir, onto, cfg}。 */
function makeEnv(seed = '') {
  const dir = mkdtempSync(join(tmpdir(), 'c2-'))
  const onto = join(dir, 'onto')
  mkdirSync(onto, { recursive: true })
  const files = {
    'objects.yaml': `objects:\n  - id: obj_a${seed}\n`,
    'logic.yaml': `logic:\n  - id: rule_a${seed}\n`,
    'actions.yaml': `actions:\n  - id: act_a${seed}\n`,
    'guards.yaml': `guards:\n  - ref: guard.a${seed}\n`,
    'compliance.yaml': `output_boundary:\n  statement: "x${seed}"\nrollback_preauth:\n  authorized: true\n`
  }
  for (const [n, c] of Object.entries(files)) writeFileSync(join(onto, n), c, 'utf8')
  return { dir, onto, files }
}

/** 把 D1 / D3 / D5 三项结论按"当前文件内容"灌进镜像（模拟刚跑过三个检查且都通过）。 */
function primeMirror(mirror, onto, which = ['D1', 'D3', 'D5']) {
  if (which.includes('D1')) {
    mirror.update({
      check: 'D1',
      passed: true,
      anchor: {
        alg: ANCHOR_ALGS.D1,
        files: ['actions.yaml', 'guards.yaml'],
        sha256: compositeAnchorSha([
          readText(join(onto, 'actions.yaml')),
          readText(join(onto, 'guards.yaml'))
        ])
      },
      at: new Date().toISOString()
    })
  }
  if (which.includes('D3')) {
    mirror.update({
      check: 'D3',
      passed: true,
      anchor: {
        alg: ANCHOR_ALGS.D3,
        files: ['objects.yaml', 'logic.yaml'],
        sha256: compositeAnchorSha([
          readText(join(onto, 'objects.yaml')),
          readText(join(onto, 'logic.yaml'))
        ])
      },
      at: new Date().toISOString()
    })
  }
  if (which.includes('D5')) {
    const fp = complianceFingerprintSync(join(onto, 'compliance.yaml'))
    mirror.update({
      check: 'D5',
      passed: true,
      anchor: { alg: D5_ANCHOR_ALG, sha256: fp.sha256, len: fp.len, nonempty: fp.nonempty },
      at: new Date().toISOString()
    })
  }
}

function readText(p) {
  return readFileSync(p, 'utf8')
}

/** 注册 fde_change_close 并返回 {tool, auditRecords}。 */
function install(env, { gatePath, approval, mirror } = {}) {
  const auditRecords = []
  let tool = null
  const ctx = {
    tools: {
      register: (x) => {
        if (x.name === 'fde_change_close') tool = x
        return () => {}
      }
    },
    get: (k) => (k === 'approval' ? approval : undefined)
  }
  const audit = {
    record: async (e) => {
      auditRecords.push(e)
      return { seq: auditRecords.length, hash: '0'.repeat(64), persisted: false }
    }
  }
  const cfg = {
    ontologyRoot: env.onto,
    projectRoot: env.dir,
    gateAuditPath: gatePath ?? join(env.dir, 'gate.jsonl'),
    mode: 'enforce',
    lockTtlMs: 30000
  }
  installChangeCloseTool(ctx, cfg, audit, mirror ?? new D1Mirror())
  assert(tool, '应注册 fde_change_close')
  return { tool, auditRecords, cfg }
}

async function callClose(tool, { agent = { id: 'a1' } } = {}) {
  let threw = null
  let res = null
  try {
    res = await tool.execute({ reason: '测试闭环' }, { callId: 'c2', name: 'fde_change_close', agent })
  } catch (e) {
    threw = e
  }
  return { threw, res }
}

// ================================================================ 测试体
lines.push('== C2 L0/L1/L2 各自流程 offline ==')

// ---------- §1 readLatestChange ----------
lines.push('[readLatestChange 单元]')

t('gateAuditPath 为空串 ⇒ unreadable（兜底，normalizeConfig 会先拦）', () => {
  const r = readLatestChange('')
  assertEq(r.ok, false)
  assertEq(r.reason, 'unreadable')
})

t('文件不存在 ⇒ unreadable', () => {
  const r = readLatestChange(join(tmpdir(), 'c2-not-exist-' + Date.now(), 'gate.jsonl'))
  assertEq(r.ok, false)
  assertEq(r.reason, 'unreadable')
})

t('空文件 ⇒ no-change', () => {
  const { dir } = makeEnv()
  const p = writeGate(dir, [])
  const r = readLatestChange(p)
  assertEq(r.ok, false)
  assertEq(r.reason, 'no-change')
  rmSync(dir, { recursive: true, force: true })
})

t('只有 deny 记录 ⇒ no-change（deny 不是变更，不能当"最近一次变更"）', () => {
  const { dir } = makeEnv()
  const p = writeGate(dir, [
    { seq: 1, ts: 't', tool: WRITE, decision: 'deny', reason: '越界', level: 'L2' },
    { seq: 2, ts: 't', tool: WRITE, decision: 'write-probe' }
  ])
  const r = readLatestChange(p)
  assertEq(r.ok, false, 'deny/probe 都不算变更')
  assertEq(r.reason, 'no-change')
  rmSync(dir, { recursive: true, force: true })
})

t('allow 记录无 level ⇒ no-level（fail-closed，不猜级别）', () => {
  const { dir } = makeEnv()
  const p = writeGate(dir, [{ seq: 4, ts: '2026-09-26T00:00:00.000Z', tool: WRITE, decision: 'allow', target: 'objects.yaml' }])
  const r = readLatestChange(p)
  assertEq(r.ok, false)
  assertEq(r.reason, 'no-level')
  assert(String(r.detail).includes('seq=4'), 'detail 应指出是哪条记录，实际 ' + r.detail)
  rmSync(dir, { recursive: true, force: true })
})

t('多条 allow ⇒ 取最后一条的级别（不是第一条）', () => {
  const { dir } = makeEnv()
  const p = writeGate(dir, [allowRec(1, 'L0'), allowRec(2, 'L2'), allowRec(3, 'L1')])
  const r = readLatestChange(p)
  assertEq(r.ok, true)
  assertEq(r.level, 'L1', '应取尾部最后一条')
  assertEq(r.seq, 3)
  rmSync(dir, { recursive: true, force: true })
})

t('尾部有半截行（进程中断）⇒ 跳过，不崩、仍取到上一条', () => {
  const { dir } = makeEnv()
  const p = writeGate(dir, [allowRec(1, 'L0')], ['{"seq":2,"tool":"fde_onto'])
  const r = readLatestChange(p)
  assertEq(r.ok, true, '半截行不应导致整体失败')
  assertEq(r.level, 'L0')
  rmSync(dir, { recursive: true, force: true })
})

t('allow 带 autoLevel 时一并带出（供审计追溯人工覆盖）', () => {
  const { dir } = makeEnv()
  const p = writeGate(dir, [allowRec(1, 'L2', { autoLevel: 'L1' })])
  const r = readLatestChange(p)
  assertEq(r.ok, true)
  assertEq(r.level, 'L2')
  assertEq(r.autoLevel, 'L1', 'autoLevel 应原样带出')
  rmSync(dir, { recursive: true, force: true })
})

// ---------- §2 verifyRequiredChecks 按级别分派 ----------
lines.push('[verifyRequiredChecks 按级别分派]')

t('REQUIRED_CHECKS 表本身：L0=[D3] / L1=[D1,D3] / L2=[D1,D3,D5]', () => {
  assertEq(REQUIRED_CHECKS.L0, ['D3'])
  assertEq(REQUIRED_CHECKS.L1, ['D1', 'D3'])
  assertEq(REQUIRED_CHECKS.L2, ['D1', 'D3', 'D5'])
})

t('NEEDS_APPROVAL：只有 L2 需要外部审批人确认', () => {
  assertEq(NEEDS_APPROVAL, { L0: false, L1: false, L2: true })
})

t('L0 只核 D3（D1/D5 缺失也不影响）', () => {
  const env = makeEnv()
  const m = new D1Mirror()
  primeMirror(m, env.onto, ['D3']) // 故意只灌 D3
  const rs = verifyRequiredChecks('L0', m, { ontologyRoot: env.onto })
  assertEq(rs.map((r) => r.check), ['D3'])
  assertEq(rs[0].ok, true)
  rmSync(env.dir, { recursive: true, force: true })
})

t('L1 核 D1+D3；只有 D3 时 D1 判未通过且指路 fde-run-guardrails-check', () => {
  const env = makeEnv()
  const m = new D1Mirror()
  primeMirror(m, env.onto, ['D3'])
  const rs = verifyRequiredChecks('L1', m, { ontologyRoot: env.onto })
  assertEq(rs.map((r) => r.check), ['D1', 'D3'])
  const d1 = rs.find((r) => r.check === 'D1')
  assertEq(d1.ok, false, 'D1 无结论应判未通过')
  assertEq(d1.tool, 'fde-run-guardrails-check', '应指路到 D1 的重跑工具')
  assert(String(d1.reason).includes('尚未跑过'), '原因应说明没跑过，实际 ' + d1.reason)
  rmSync(env.dir, { recursive: true, force: true })
})

t('L2 核 D1+D3+D5；三项都新鲜通过 ⇒ 全 ok', () => {
  const env = makeEnv()
  const m = new D1Mirror()
  primeMirror(m, env.onto) // 三项全灌
  const rs = verifyRequiredChecks('L2', m, { ontologyRoot: env.onto })
  assertEq(rs.map((r) => r.check), ['D1', 'D3', 'D5'])
  assertEq(rs.map((r) => r.ok), [true, true, true])
  rmSync(env.dir, { recursive: true, force: true })
})

t('L2：compliance.yaml 改了 ⇒ D5 判未通过（锚点失效）', () => {
  const env = makeEnv()
  const m = new D1Mirror()
  primeMirror(m, env.onto)
  writeFileSync(join(env.onto, 'compliance.yaml'), 'output_boundary:\n  statement: "改过了"\n', 'utf8')
  const rs = verifyRequiredChecks('L2', m, { ontologyRoot: env.onto })
  const d5 = rs.find((r) => r.check === 'D5')
  assertEq(d5.ok, false, '文件变更后 D5 结论应失效')
  assert(String(d5.reason).includes('不符'), '原因应说明与当前文件不符，实际 ' + d5.reason)
  rmSync(env.dir, { recursive: true, force: true })
})

t('L1：logic.yaml 改了 ⇒ D3 判未通过（与 guard 推进同一套锚点判据）', () => {
  const env = makeEnv()
  const m = new D1Mirror()
  primeMirror(m, env.onto)
  writeFileSync(join(env.onto, 'logic.yaml'), 'logic:\n  - id: rule_changed\n', 'utf8')
  const rs = verifyRequiredChecks('L1', m, { ontologyRoot: env.onto })
  assertEq(rs.find((r) => r.check === 'D3').ok, false)
  rmSync(env.dir, { recursive: true, force: true })
})

t('未知级别 ⇒ 单条 ok:false（fail-closed，不猜要不要跑检查）', () => {
  const env = makeEnv()
  const m = new D1Mirror()
  primeMirror(m, env.onto)
  const rs = verifyRequiredChecks('L9', m, { ontologyRoot: env.onto })
  assertEq(rs.length, 1)
  assertEq(rs[0].ok, false)
  assert(String(rs[0].check).includes('unknown-level'), 'check 应标明未知级别，实际 ' + rs[0].check)
  rmSync(env.dir, { recursive: true, force: true })
})

// ---------- §3 describeIncomplete ----------
lines.push('[describeIncomplete 文案]')

t('文案含级别、缺项计数、每项原因与指路工具、以及该级别必需清单', () => {
  const msg = describeIncomplete('L2', [
    { check: 'D1', ok: true, tool: 'fde-run-guardrails-check' },
    { check: 'D3', ok: false, reason: 'D3 上次结论为未通过', tool: 'fde-run-validation' },
    { check: 'D5', ok: false, reason: '尚未跑过', tool: 'fde-run-compliance-check' }
  ])
  assert(msg.includes('L2 变更闭环未完成，缺 2 项'), '应写缺 2 项，实际 ' + msg)
  assert(msg.includes('fde-run-validation'), '应指路 D3 工具')
  assert(msg.includes('fde-run-compliance-check'), '应指路 D5 工具')
  assert(msg.includes('D1 + D3 + D5'), '应写出 L2 的必需清单')
  assert(!msg.includes('· D1：'), '已通过的项不应出现在缺项列表里，实际 ' + msg)
})

t('全过时 bad 为空 ⇒ 文案不列任何缺项', () => {
  const msg = describeIncomplete('L0', [{ check: 'D3', ok: true, tool: 'fde-run-validation' }])
  assert(msg.includes('缺 0 项'))
  assert(!msg.includes('  · '), '不应有缺项行，实际 ' + msg)
})

// ---------- §4 fde_change_close execute ----------
lines.push('[fde_change_close execute]')

ta('L0 + D3 新鲜通过 ⇒ 闭环成功，checks=[D3]、approval=n/a，审计有 change-closed', async () => {
  const env = makeEnv()
  const gate = writeGate(env.dir, [allowRec(1, 'L0', { target: 'objects.yaml' })])
  const m = new D1Mirror()
  primeMirror(m, env.onto, ['D3'])
  const { tool, auditRecords } = install(env, { gatePath: gate, mirror: m })
  const { threw, res } = await callClose(tool)
  assert(!threw, 'L0 不应抛错，实际 ' + (threw && threw.message))
  assertEq(res.level, 'L0')
  assertEq(res.checks, ['D3'])
  assertEq(res.approval, 'n/a', 'L0 不需要审批')
  assertEq(res.target, 'objects.yaml')
  const closed = auditRecords.find((r) => r.type === 'change-closed')
  assert(closed, '应有 change-closed 审计')
  assertEq(closed.required, ['D3'])
  assertEq(closed.approval, 'n/a')
  rmSync(env.dir, { recursive: true, force: true })
})

ta('L0：D3 从未跑过 ⇒ CHANGE_FLOW_INCOMPLETE + change-close-denied/checks-incomplete', async () => {
  const env = makeEnv()
  const gate = writeGate(env.dir, [allowRec(1, 'L0')])
  const { tool, auditRecords } = install(env, { gatePath: gate, mirror: new D1Mirror() })
  const { threw, res } = await callClose(tool)
  assert(threw, '应抛错')
  assertEq(res, null, '不应有返回值')
  assertEq(threw.code, 'CHANGE_FLOW_INCOMPLETE')
  assert(String(threw.message).includes('fde-run-validation'), '文案应指路 D3 工具，实际 ' + threw.message)
  const d = auditRecords.find((r) => r.type === 'change-close-denied')
  assert(d, '应有 change-close-denied 审计')
  assertEq(d.outcome, 'checks-incomplete')
  assertEq(d.failed, ['D3'])
  rmSync(env.dir, { recursive: true, force: true })
})

ta('L1：只跑了 D3（缺 D1）⇒ 拒绝，且文案点名缺 D1', async () => {
  const env = makeEnv()
  const gate = writeGate(env.dir, [allowRec(1, 'L1', { target: 'logic.yaml' })])
  const m = new D1Mirror()
  primeMirror(m, env.onto, ['D3']) // 故意不灌 D1
  const { tool, auditRecords } = install(env, { gatePath: gate, mirror: m })
  const { threw } = await callClose(tool)
  assert(threw, '应抛错')
  assertEq(threw.code, 'CHANGE_FLOW_INCOMPLETE')
  assert(String(threw.message).includes('缺 1 项'), '应缺 1 项，实际 ' + threw.message)
  assert(String(threw.message).includes('D1'), '应点名 D1')
  assert(String(threw.message).includes('fde-run-guardrails-check'), '应指路 D1 工具')
  assertEq(auditRecords.find((r) => r.type === 'change-close-denied').failed, ['D1'])
  rmSync(env.dir, { recursive: true, force: true })
})

ta('L1：D1+D3 都新鲜通过 ⇒ 闭环成功，不需审批', async () => {
  const env = makeEnv()
  const gate = writeGate(env.dir, [allowRec(1, 'L1')])
  const m = new D1Mirror()
  primeMirror(m, env.onto, ['D1', 'D3'])
  const { tool } = install(env, { gatePath: gate, mirror: m })
  const { threw, res } = await callClose(tool)
  assert(!threw, '不应抛错，实际 ' + (threw && threw.message))
  assertEq(res.level, 'L1')
  assertEq(res.checks, ['D1', 'D3'])
  assertEq(res.approval, 'n/a', 'L1 不需要审批')
  rmSync(env.dir, { recursive: true, force: true })
})

ta('L2：D1+D3+D5 全过 + approval=allowed-once ⇒ 闭环成功 approval=confirmed', async () => {
  const env = makeEnv()
  const gate = writeGate(env.dir, [allowRec(1, 'L2', { target: 'compliance.yaml' })])
  const m = new D1Mirror()
  primeMirror(m, env.onto) // 三项全灌
  let asked = null
  const approval = {
    request: async (req) => {
      asked = req
      return 'allowed-once'
    }
  }
  const { tool, auditRecords } = install(env, { gatePath: gate, mirror: m, approval })
  const { threw, res } = await callClose(tool)
  assert(!threw, '不应抛错，实际 ' + (threw && threw.message))
  assertEq(res.level, 'L2')
  assertEq(res.checks, ['D1', 'D3', 'D5'])
  assertEq(res.approval, 'confirmed')
  assert(asked, '应向 approval 服务发起请求')
  assert(String(asked.reason).includes('L2'), '审批理由应说明是 L2，实际 ' + asked.reason)
  assertEq(auditRecords.find((r) => r.type === 'change-closed').approval, 'confirmed')
  rmSync(env.dir, { recursive: true, force: true })
})

ta('L2：approval=rejected ⇒ CHANGE_APPROVAL_REQUIRED（fail-closed），不落 change-closed', async () => {
  const env = makeEnv()
  const gate = writeGate(env.dir, [allowRec(1, 'L2')])
  const m = new D1Mirror()
  primeMirror(m, env.onto)
  const { tool, auditRecords } = install(env, {
    gatePath: gate,
    mirror: m,
    approval: { request: async () => 'rejected' }
  })
  const { threw, res } = await callClose(tool)
  assert(threw, '用户拒绝后应抛错')
  assertEq(res, null)
  assertEq(threw.code, 'CHANGE_APPROVAL_REQUIRED')
  assert(!auditRecords.some((r) => r.type === 'change-closed'), '不应有 change-closed 审计')
  const d = auditRecords.find((r) => r.type === 'change-close-denied')
  assertEq(d.outcome, 'approval-rejected')
  rmSync(env.dir, { recursive: true, force: true })
})

ta('L2：approval 不可用（未 compose）⇒ 也拒绝（与 D4 ask 的三态相反，此处 fail-closed）', async () => {
  const env = makeEnv()
  const gate = writeGate(env.dir, [allowRec(1, 'L2')])
  const m = new D1Mirror()
  primeMirror(m, env.onto)
  const { tool, auditRecords } = install(env, { gatePath: gate, mirror: m }) // 不传 approval
  const { threw } = await callClose(tool)
  assert(threw, 'unavailable 也应拒绝')
  assertEq(threw.code, 'CHANGE_APPROVAL_REQUIRED')
  assert(String(threw.message).includes('unavailable'), '文案应写明 unavailable，实际 ' + threw.message)
  assertEq(auditRecords.find((r) => r.type === 'change-close-denied').outcome, 'approval-unavailable')
  rmSync(env.dir, { recursive: true, force: true })
})

ta('L2：approval 不可用时即便检查全过也拒绝（顺序：先检查后审批，都要过）', async () => {
  const env = makeEnv()
  const gate = writeGate(env.dir, [allowRec(1, 'L2')])
  const m = new D1Mirror()
  primeMirror(m, env.onto)
  const { tool } = install(env, { gatePath: gate, mirror: m })
  const { threw } = await callClose(tool)
  assertEq(threw.code, 'CHANGE_APPROVAL_REQUIRED', '检查已全过，仍应卡在审批这一步')
  rmSync(env.dir, { recursive: true, force: true })
})

ta('gate 链里无 allow 变更 ⇒ CHANGE_NONE + 拒绝', async () => {
  const env = makeEnv()
  const gate = writeGate(env.dir, [])
  const m = new D1Mirror()
  primeMirror(m, env.onto)
  const { tool, auditRecords } = install(env, { gatePath: gate, mirror: m })
  const { threw } = await callClose(tool)
  assert(threw, '应抛错')
  assertEq(threw.code, 'CHANGE_NONE')
  assertEq(auditRecords.find((r) => r.type === 'change-close-denied').outcome, 'no-change')
  rmSync(env.dir, { recursive: true, force: true })
})

ta('allow 记录无 level（C1 落地前的旧记录）⇒ CHANGE_NO_LEVEL（不猜级别）+ 拒绝', async () => {
  const env = makeEnv()
  const gate = writeGate(env.dir, [{ seq: 4, ts: '2026-09-26T00:00:00.000Z', tool: WRITE, decision: 'allow' }])
  const m = new D1Mirror()
  primeMirror(m, env.onto)
  const { tool, auditRecords } = install(env, { gatePath: gate, mirror: m })
  const { threw } = await callClose(tool)
  assert(threw, '应抛错')
  assertEq(threw.code, 'CHANGE_NO_LEVEL')
  assert(String(threw.message).includes('seq=4'), '文案应指出是哪条旧记录，实际 ' + threw.message)
  assertEq(auditRecords.find((r) => r.type === 'change-close-denied').outcome, 'no-level')
  rmSync(env.dir, { recursive: true, force: true })
})

ta('gate 链不可读（路径是目录）⇒ CHANGE_CHAIN_UNREADABLE + 拒绝', async () => {
  const env = makeEnv()
  const m = new D1Mirror()
  primeMirror(m, env.onto)
  const { tool, auditRecords } = install(env, { gatePath: env.dir, mirror: m }) // 目录 ⇒ readSync 失败
  const { threw } = await callClose(tool)
  assert(threw, '应抛错')
  assertEq(threw.code, 'CHANGE_CHAIN_UNREADABLE')
  assertEq(auditRecords.find((r) => r.type === 'change-close-denied').outcome, 'unreadable')
  rmSync(env.dir, { recursive: true, force: true })
})

ta('闭环成功后重复闭环 ⇒ 仍成功（幂等读同一条变更；级别不变）', async () => {
  const env = makeEnv()
  const gate = writeGate(env.dir, [allowRec(1, 'L0')])
  const m = new D1Mirror()
  primeMirror(m, env.onto, ['D3'])
  const { tool } = install(env, { gatePath: gate, mirror: m })
  const a = await callClose(tool)
  const b = await callClose(tool)
  assert(!a.threw && !b.threw, '两次都应成功')
  assertEq(a.res.change_seq, b.res.change_seq, '读到的应是同一条变更')
  rmSync(env.dir, { recursive: true, force: true })
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
console.log('[c2] wrote ' + OUT + '  PASS ' + passed + ' / FAIL ' + failed)
process.exitCode = failed > 0 ? 1 : 0
