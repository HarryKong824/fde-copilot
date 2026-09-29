/**
 * dsh-fde-phase 离线回归（task #4）。
 *
 * 跑法：
 *   node _fde_phase_test.mjs
 *   故意验证退出码会变红： FDE_INVERT=1 node _fde_phase_test.mjs
 *
 * 结果**自己写文件**（`_phase_test_out.txt`）—— 不走控制台（Windows 代码页乱码纪律）。
 *
 * 覆盖（对应施工单 §1 完成判据 + §5 各模块）：
 *   - config.normalizeConfig（必填 / 默认值 / 非法 mode / 非法 lockTtlMs）
 *   - phases（15 Phase / nextPhase / DENY_CHECKS / IMPLEMENTED_CHECKS）
 *   - audit（记录 + 落盘恢复链头）
 *   - state（writeState 创建 + revision 递增 + 锁过期强夺 lock-steal + 锁未过期 fail-closed 阻塞）
 *   - mirror（update/verify 命中 / 内容变更失效 / 无结论 fail-closed / 未通过 / restoreSync 恢复）
 *   - guard.evaluate（非本工具不拦 / 跳跃被拒 / 末阶段无 next / Phase3 D1 未过被拒 /
 *     D1 已过放行 / D1 锚点失效重拒 / Phase2 无检查放行 / Phase4 含未实现项 skipped 但放行）
 *
 * ⚠️ 本测试只覆盖纯逻辑层；tools.js（依赖真 SDK defineTool）与 config-schema.js（依赖 schemastery）
 * 不在此覆盖，由 precheck.mjs 在已安装副本目录用真 SDK 验。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConfig } from '../dsh-fde-phase/lib/config.js'
import {
  PHASE_IDS,
  nextPhase,
  DENY_CHECKS,
  IMPLEMENTED_CHECKS
} from '../dsh-fde-phase/lib/phases.js'
import { AuditChain } from '../dsh-fde-phase/lib/audit.js'
import {
  DEFAULT_STATE,
  serializeState,
  writeState,
  acquireLock
} from '../dsh-fde-phase/lib/state.js'
import { D1Mirror, sha256Text } from '../dsh-fde-phase/lib/mirror.js'
import { evaluate } from '../dsh-fde-phase/lib/guard.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_phase_test_out.txt')
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

function assertThrows(pattern, fn, msg) {
  let threw = null
  try {
    fn()
  } catch (e) {
    threw = e
  }
  if (!threw) throw new Error(`${msg || '期望抛错'}：没有抛`)
  const hay = `${threw.code ?? ''} ${threw.message ?? ''}`
  if (!hay.includes(pattern)) {
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
// 必须与 dsh-fde-phase/lib/mirror.js 的 ANCHOR_ALG / compositeAnchorSha 保持一致（P1-1：锚点覆盖两文件）
const SEP = '\u0000'
const ANCHOR_ALG = 'sha256(actions+\u0000+guards)@v2'
const DEFAULT_GUARDS = '# default guards\n'
function compositeSha(a, g) {
  return createHash('sha256').update(a + SEP + g).digest('hex')
}
function mkProject(currentPhase = '0.1') {
  const root = mkdtempSync(join(tmpdir(), 'fde-phase-'))
  const mem = join(root, 'memory')
  mkdirSync(mem, { recursive: true })
  writeFileSync(join(mem, 'state.yaml'), serializeState({ ...DEFAULT_STATE, current_phase: currentPhase }))
  return root
}

// P1-1：ontology 目录现在必须有 actions.yaml + guards.yaml 两个文件（锚点覆盖两文件）
function mkOnto(actionsText, guardsText = DEFAULT_GUARDS) {
  const dir = mkdtempSync(join(tmpdir(), 'fde-onto-'))
  writeFileSync(join(dir, 'actions.yaml'), actionsText)
  writeFileSync(join(dir, 'guards.yaml'), guardsText)
  return dir
}

// 构造一个合法的 v2 锚点（与 dsl/tools.js emit、mirror.verify 同形）
function makeAnchor(dir, actionsText, guardsText = DEFAULT_GUARDS) {
  return {
    alg: ANCHOR_ALG,
    files: [join(dir, 'actions.yaml'), join(dir, 'guards.yaml')],
    sha256: compositeSha(actionsText, guardsText)
  }
}

// ================================================================ 测试体
lines.push('== dsh-fde-phase 离线回归 ==')

// ---------- config ----------
lines.push('[config]')
t('normalizeConfig 缺 projectRoot 抛错', () => assertThrows('projectRoot', () => normalizeConfig({ ontologyRoot: 'o' })))
t('normalizeConfig 缺 ontologyRoot 抛错', () => assertThrows('ontologyRoot', () => normalizeConfig({ projectRoot: 'p' })))
t('normalizeConfig 默认值', () => {
  // gateAuditPath：Stage 5.5 起与 projectRoot / ontologyRoot 同为必填（D2 要验 gate 链）。
  const c = normalizeConfig({ projectRoot: 'p', ontologyRoot: 'o', gateAuditPath: 'g' })
  assertEq(c.mode, 'shadow')
  assertEq(c.lockTtlMs, 30000)
  assertEq(c.auditPath, '')
})
t('normalizeConfig enforce', () => {
  const c = normalizeConfig({ projectRoot: 'p', ontologyRoot: 'o', gateAuditPath: 'g', mode: 'enforce' })
  assertEq(c.mode, 'enforce')
})
t('normalizeConfig 非法 mode 抛错', () => assertThrows('mode', () => normalizeConfig({ projectRoot: 'p', ontologyRoot: 'o', gateAuditPath: 'g', mode: 'x' })))
t('normalizeConfig 非法 lockTtlMs 抛错', () => assertThrows('lockTtlMs', () => normalizeConfig({ projectRoot: 'p', ontologyRoot: 'o', gateAuditPath: 'g', lockTtlMs: -1 })))

// ---------- phases ----------
lines.push('[phases]')
t('15 个 Phase', () => assertEq(PHASE_IDS.length, 15))
t('nextPhase 连续推进', () => assertEq(nextPhase('0.1'), '0.2'))
t('nextPhase 末阶段 undefined', () => assertEq(nextPhase('11'), undefined))
t('DENY_CHECKS[3]=[D1]', () => assertEq(DENY_CHECKS['3'], ['D1']))
// Stage 5.6：D2 / D3 / D5 已全部接线；D4 已按 v3 从 deny 降为 ask（不再进 DENY_CHECKS，见 0089）。
t('IMPLEMENTED_CHECKS = D1/D2/D3/D5 均已实现', () => assertEq(IMPLEMENTED_CHECKS, { D1: true, D2: true, D3: true, D5: true }))
t('DENY_CHECKS[4]=[D2,D3]', () => assertEq(DENY_CHECKS['4'], ['D2', 'D3']))
t('DENY_CHECKS[6]=[D5]', () => assertEq(DENY_CHECKS['6'], ['D5']))
t('D4 已从 deny 降为 ask（DENY_CHECKS 不再有 10 键）', () => assertEq(DENY_CHECKS['10'], undefined))

// ---------- audit ----------
lines.push('[audit]')
ta('AuditChain 内存记录 count/head', async () => {
  const a = new AuditChain('')
  const r = await a.record({ type: 'x' })
  assertEq(r.seq, 1)
  assertEq(a.count, 1)
  assertEq(a.head.length, 64)
})
ta('AuditChain 落盘后新实例从尾部恢复链头', async () => {
  const p = join(mkdtempSync(join(tmpdir(), 'fde-audit-')), 'audit.jsonl')
  const a = new AuditChain(p)
  await a.record({ type: 'a' })
  await a.record({ type: 'b' })
  await a.flush()
  const b = new AuditChain(p)
  assert(b.count >= 2, `恢复后 count 应 ≥2，实际 ${b.count}`)
})

// P2-3 审计链分叉回归：末行是 check-result（dsl 不上报 seq）时，重启后不得分叉。
ta('AuditChain record 携带 seq:undefined 不得覆盖自动编号（P2-3）', async () => {
  const p = join(mkdtempSync(join(tmpdir(), 'fde-audit-seq-')), 'audit.jsonl')
  const a = new AuditChain(p)
  await a.record({ type: 'phase-advance' })
  // 模拟 index.js 旧代码：写 check-result 时传 seq: undefined（dsl 从不上报 seq）
  const r = await a.record({ type: 'check-result', seq: undefined })
  await a.flush()
  // 落盘末行必须带有效 seq（否则重启恢复会跳过它 → 分叉）
  const ls = readFileSync(p, 'utf8').trim().split('\n')
  const last = JSON.parse(ls[ls.length - 1])
  assert(Number.isInteger(last.seq) && last.seq > 0, `末行 check-result 应带有效 seq，实际 ${JSON.stringify(last.seq)}`)
  assert(Number.isInteger(r.seq) && r.seq === last.seq, `record() 返回值 seq 应一致，实际 ${JSON.stringify(r.seq)}`)
})
ta('AuditChain 末行是 check-result 时重启链头=真正末行（无分叉 P2-3）', async () => {
  const p = join(mkdtempSync(join(tmpdir(), 'fde-audit-fork-')), 'audit.jsonl')
  const a = new AuditChain(p)
  await a.record({ type: 'phase-advance', from: '3', to: '4' }) // seq 1
  const r2 = await a.record({ type: 'check-result', seq: undefined }) // 末行，seq 2（旧代码会缺 seq）
  await a.flush()
  const lastHash = r2.hash
  // 模拟重启：新实例从尾部恢复
  const a2 = new AuditChain(p)
  const headBefore = a2.head // 应为真正末行 check-result 的 hash
  assert(
    headBefore === lastHash,
    `重启后链头必须是末行 check-result 的 hash（无分叉）；期望 ${lastHash?.slice(0, 8)} 实际 ${headBefore?.slice(0, 8)}`
  )
  await a2.record({ type: 'phase-advance', from: '4', to: '5' })
  await a2.flush()
  // 逐行校验：每条记录的 prevHash 必须等于前一条的 hash，形成单链（无分叉）
  const rows = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  for (let i = 1; i < rows.length; i++) {
    assert(rows[i].prevHash === rows[i - 1].hash, `第 ${i + 1} 条 prevHash 必须等于前一条 hash（断链/分叉）`)
  }
})

// P1-1 审计链 #seq 收尾回归：末行缺 seq 时 count 不得回落为 0 → 新记录不得从 1 重开。
// ⚠️ 必须**绕过 record() 直接写原始行**。上面两条用 record({seq:undefined}) 铺数据，
//    而修复后的 record() 会从入口剥掉调用方 seq 再盖章 —— 永远造不出缺 seq 的文件，
//    断言必然绿。它们盯的是「record() 入口防御」+「链头不分叉」，测不到本条。
ta('AuditChain 末行缺 seq 时序号不得回落为 0（P1-1）', async () => {
  // 复刻 audit.js 的 linkHash（逐字同源），用于手工铸造合法链上的行
  const linkHash = (prev, rec) =>
    createHash('sha256').update(prev).update('\n').update(JSON.stringify(rec)).digest('hex')
  const genesis = '0'.repeat(64)

  const p = join(mkdtempSync(join(tmpdir(), 'fde-audit-seqgap-')), 'audit.jsonl')
  const rec1 = { seq: 1, ts: '2026-09-25T00:00:00.000Z', type: 'phase-advance' }
  const h1 = linkHash(genesis, rec1)
  // 末行 = 历史遗留的 check-result 形态（dsl 从不上报 seq）—— 正是 Phase 重启前的常见末行
  const rec2 = { ts: '2026-09-25T00:00:01.000Z', type: 'check-result', check: 'D1', passed: true }
  const h2 = linkHash(h1, rec2)
  writeFileSync(
    p,
    [
      JSON.stringify({ ...rec1, prevHash: genesis, hash: h1 }),
      JSON.stringify({ ...rec2, prevHash: h1, hash: h2 })
    ].join('\n') + '\n'
  )

  // 模拟重启：新实例从尾部恢复
  const a = new AuditChain(p)
  // ① 链头必须落在真正的末行（不因缺 seq 而跳到上一条 → 分叉）
  assertEq(a.head, h2, '重启后链头应为末行 check-result 的 hash')
  // ② 序号必须继承窗口内已见最大值，不得回落为 0
  assert(
    a.count >= 1,
    `末行缺 seq 时 count 回落为 0（实际 ${a.count}）→ 新记录会从 1 重开，与文件里已有的 seq=1 撞号`
  )
  // ③ 新记录必须接续为 seq 2
  const r = await a.record({ type: 'phase-advance', from: '4', to: '5' })
  await a.flush()
  assertEq(r.seq, 2, '末行缺 seq 时新记录应接续为 seq 2')
  // ④ 全文件仍是单一连续链
  const rows = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  for (let i = 1; i < rows.length; i++) {
    assert(rows[i].prevHash === rows[i - 1].hash, `第 ${i + 1} 条 prevHash 必须等于前一条 hash（断链/分叉）`)
  }
})

// ---------- state + 锁 ----------
lines.push('[state + lock]')
ta('writeState 创建并 revision 递增', async () => {
  const root = mkProject('0.1')
  const sp = join(root, 'memory', 'state.yaml')
  const lp = join(root, 'memory', '.state.lock')
  const r1 = await writeState(sp, lp, (c) => ({ ...c, current_phase: '0.2' }), 30000, null)
  assertEq(r1.current_phase, '0.2')
  assertEq(r1.revision, 1)
  const r2 = await writeState(sp, lp, (c) => ({ ...c, current_phase: '0.3' }), 30000, null)
  assertEq(r2.revision, 2)
  assertEq(r2.current_phase, '0.3')
})
ta('锁过期 → 强夺并记 lock-steal', async () => {
  const root = mkProject('0.1')
  const sp = join(root, 'memory', 'state.yaml')
  const lp = join(root, 'memory', '.state.lock')
  // 预置一个已过期、且持有 pid 已死的锁（A2：残留检测 —— 必须「超时 + pid 死」双条件才自动释放）。
  // 用 999999999（远超 Windows 实际 pid 范围 ⇒ 必 ESRCH = 不存在）；别用 pid:1，跨环境不确定。
  writeFileSync(lp, JSON.stringify({ pid: 999999999, at: new Date(Date.now() - 100000).toISOString() }))
  const ap = join(mkdtempSync(join(tmpdir(), 'fde-lvaudit-')), 'audit.jsonl')
  const a = new AuditChain(ap)
  await writeState(sp, lp, (c) => ({ ...c, current_phase: '0.2' }), 30000, a)
  await a.flush()
  const txt = readFileSync(ap, 'utf8')
  assert(txt.includes('lock-steal'), '应记录 decision=lock-steal')
})
ta('锁过期但持有进程仍存活 → 拒绝（A2：不自动释放）', async () => {
  const root = mkProject('0.1')
  const sp = join(root, 'memory', 'state.yaml')
  const lp = join(root, 'memory', '.state.lock')
  // 超时 + 持有 pid = 当前进程（一定活着）⇒ A2 双条件不满足 ⇒ 拒绝，不是强夺。
  writeFileSync(lp, JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 100000).toISOString() }))
  const ap = join(mkdtempSync(join(tmpdir(), 'fde-lkalive-')), 'audit.jsonl')
  const a = new AuditChain(ap)
  let err = null
  try {
    await writeState(sp, lp, (c) => ({ ...c, current_phase: '0.2' }), 30000, a)
  } catch (e) {
    err = e
  }
  assert(err && /占用/.test(err.message), '锁超时但持有进程存活时应拒绝写入（不得强夺）')
  assert(err && err.message.includes('存活'), `文案应含「存活」说明不自动释放，实际：${err?.message}`)
  assert(err && !err.message.includes('未过期'), `文案不得说「未过期」（它其实超时了），实际：${err?.message}`)
  // 拒绝后锁必须还在，内容仍是持有者的 pid（不得被强夺覆盖）
  assert(existsSync(lp), '拒绝后锁文件必须还在')
  const after = JSON.parse(readFileSync(lp, 'utf8'))
  assertEq(after.pid, process.pid, '拒绝后锁内容必须仍是原持有者（当前进程）的 pid')
  await a.flush()
  const rows = readFileSync(ap, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const rec = rows.find((r) => r.decision === 'lock-contended')
  assert(rec, '超时但存活的锁被拒同样要留痕 lock-contended')
  assertEq(rec.holderPid, process.pid, 'holderPid 应为存活持有者的 pid')
})
ta('锁未过期 → fail-closed 阻塞写入', async () => {
  const root = mkProject('0.1')
  const sp = join(root, 'memory', 'state.yaml')
  const lp = join(root, 'memory', '.state.lock')
  // 预置一个新鲜的锁（now - at ≈ 0 < ttl）
  writeFileSync(lp, JSON.stringify({ pid: 1, at: new Date().toISOString() }))
  await assertRejects(
    () => writeState(sp, lp, (c) => ({ ...c, current_phase: '0.2' }), 30000, null),
    '占用',
    '锁未过期时应拒绝写入'
  )
})
ta('锁未过期被拒 → 不删别人的锁（防 acquireLock 被挪进 try 里退化）', async () => {
  const root = mkProject('0.1')
  const sp = join(root, 'memory', 'state.yaml')
  const lp = join(root, 'memory', '.state.lock')
  writeFileSync(lp, JSON.stringify({ pid: 4242, at: new Date().toISOString() }))
  await assertRejects(
    () => writeState(sp, lp, (c) => ({ ...c, current_phase: '0.2' }), 30000, null),
    '占用',
    '锁未过期时应拒绝写入'
  )
  // 这条是防退化的唯一拦网：writeState 把 acquireLock 放在 try 之外才有此性质；
  // 谁把它挪进 try（finally 里 releaseLock），就会顺手删掉别人的锁。
  assert(existsSync(lp), '拒绝后锁文件必须还在（不能删别人的锁）')
  const after = JSON.parse(readFileSync(lp, 'utf8'))
  assertEq(after.pid, 4242, '拒绝后锁内容必须仍是原持有者的 pid')
})
ta('锁未过期被拒 → 审计落 lock-contended 且 holderPid/holderAt/ttlMs 齐', async () => {
  const root = mkProject('0.1')
  const sp = join(root, 'memory', 'state.yaml')
  const lp = join(root, 'memory', '.state.lock')
  const holderAt = new Date().toISOString()
  writeFileSync(lp, JSON.stringify({ pid: 4242, at: holderAt }))
  const ap = join(mkdtempSync(join(tmpdir(), 'fde-lkcontend-')), 'audit.jsonl')
  const a = new AuditChain(ap)
  let err = null
  try {
    await writeState(sp, lp, (c) => ({ ...c, current_phase: '0.2' }), 30000, a)
  } catch (e) {
    err = e
  }
  assert(err && /占用/.test(err.message), '锁未过期时应拒绝写入')
  // 错误文案必须带审计号（与 D1 被拒同形态），模型才有定位锚
  assert(err && /审计 #\d+/.test(err.message), `错误文案应带审计号，实际：${err?.message}`)
  // parseable:true 分支：事实就是"未过期"，文案必须这么说 + 必须给出持有者 pid
  assert(err && err.message.includes('未过期'), `可解析且未过期时文案应含「未过期」，实际：${err?.message}`)
  assert(err && err.message.includes('pid=4242'), `可解析时文案应给出持有者 pid，实际：${err?.message}`)
  await a.flush()
  const rows = readFileSync(ap, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const rec = rows.find((r) => r.decision === 'lock-contended')
  assert(rec, `审计里应有 decision=lock-contended，实际：${JSON.stringify(rows.map((r) => r.decision))}`)
  assertEq(rec.holderPid, 4242, 'holderPid 应为持有者 pid')
  assertEq(rec.holderAt, holderAt, 'holderAt 应原样落盘，便于审读者复算判据')
  assertEq(rec.ttlMs, 30000, 'ttlMs 应落盘，便于审读者复算判据')
  assert(rec.oldPid === undefined, '锁竞争被拒不得写 oldPid（那是"被抢走的那个"的语义）')
})
ta('锁文件不可解析 → 拒绝 + lock-contended（holderPid: null）', async () => {
  const root = mkProject('0.1')
  const sp = join(root, 'memory', 'state.yaml')
  const lp = join(root, 'memory', '.state.lock')
  writeFileSync(lp, 'not json') // 半写/损坏：JSON.parse 失败 → info={} → at=NaN → stale=false
  const ap = join(mkdtempSync(join(tmpdir(), 'fde-lkbad-')), 'audit.jsonl')
  const a = new AuditChain(ap)
  let err = null
  try {
    await writeState(sp, lp, (c) => ({ ...c, current_phase: '0.2' }), 30000, a)
  } catch (e) {
    err = e
  }
  assert(err && /占用/.test(err.message), '锁文件不可解析时应拒绝写入（不得当成过期直接抢）')
  // 🔴 文案不得说谎：这条路径下 at=NaN → stale 被短路为 false，"过没过期"**根本没判出来**，
  //    且坏锁永远不会自行过期。若共用"未过期。稍后重试"，会把模型推向等待（活体实测踩过：
  //    模型据此提出"等到过期时间"），既说谎又违反"不重试等待"的纪律。
  assert(err && err.message.includes('不可解析'), `文案应含「不可解析」，实际：${err?.message}`)
  assert(
    err && !err.message.includes('未过期'),
    `文案**不得**含「未过期」（该分支根本没做出过期判断），实际：${err?.message}`
  )
  // 必须给出"删锁"这个恢复动作（本状态机既有风格：D1 被拒也会说"请先跑 …"）
  assert(err && err.message.includes('.state.lock'), `文案应给出手工删锁的恢复动作，实际：${err?.message}`)
  assert(err && /审计 #\d+/.test(err.message), `不可解析分支同样要带审计号，实际：${err?.message}`)
  await a.flush()
  const rows = readFileSync(ap, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const rec = rows.find((r) => r.decision === 'lock-contended')
  assert(rec, '不可解析的锁被拒同样要留痕 lock-contended')
  assertEq(rec.holderPid, null, '读不出持有者时 holderPid 必须是 null（≠"没有持有者"）')
  assertEq(rec.holderAt, null, '读不出时 holderAt 必须是 null')
  assert(existsSync(lp), '不可解析时同样不得删锁')
})

// ---------- mirror ----------
lines.push('[mirror]')
t('mirror.update + verify 命中（P1-1 复合锚点）', () => {
  const content = 'actions: []\n'
  const dir = mkOnto(content)
  const ap = join(dir, 'actions.yaml')
  const m = new D1Mirror()
  m.update({ check: 'D1', passed: true, anchor: makeAnchor(dir, content), at: 't' })
  const v = m.verify('D1', [ap, join(dir, 'guards.yaml')])
  assert(v.ok, `应 ok，实际 ${JSON.stringify(v)}`)
})
t('mirror.verify 内容变更 → 失效', () => {
  const content = 'actions: []\n'
  const dir = mkOnto(content)
  const ap = join(dir, 'actions.yaml')
  const m = new D1Mirror()
  m.update({ check: 'D1', passed: true, anchor: makeAnchor(dir, content), at: 't' })
  writeFileSync(ap, 'actions: [{id: x}]\n')
  const v = m.verify('D1', [ap, join(dir, 'guards.yaml')])
  assert(!v.ok, '内容变了应失效')
  assert(v.reason && v.reason.includes('不符'), `应报不符，实际 ${v.reason}`)
})
t('mirror.verify 无结论 → fail-closed', () => {
  const m = new D1Mirror()
  const dir = mkOnto('x')
  const v = m.verify('D1', [join(dir, 'actions.yaml'), join(dir, 'guards.yaml')])
  assert(!v.ok)
})
t('mirror.verify 上次未通过 → fail-closed', () => {
  const content = 'actions: []\n'
  const dir = mkOnto(content)
  const ap = join(dir, 'actions.yaml')
  const m = new D1Mirror()
  m.update({ check: 'D1', passed: false, anchor: makeAnchor(dir, content), at: 't' })
  const v = m.verify('D1', [ap, join(dir, 'guards.yaml')])
  assert(!v.ok)
})
t('mirror.verify 只改 guards.yaml 也失效（P1-1 绕过修复）', () => {
  const a = 'actions: []\n'
  const g = 'guards:\n  - ref: g1\n    impl: {">": [1, 2]}\n'
  const dir = mkOnto(a, g)
  const ap = join(dir, 'actions.yaml')
  const gp = join(dir, 'guards.yaml')
  const m = new D1Mirror()
  m.update({ check: 'D1', passed: true, anchor: makeAnchor(dir, a, g), at: 't' })
  // 只改 guards.yaml（放宽 impl，不影响 actions）
  writeFileSync(gp, 'guards:\n  - ref: g1\n    impl: 100000\n')
  const v = m.verify('D1', [ap, gp])
  assert(!v.ok, '只改 guards 也应失效（旧代码这里会放行）')
  assert(v.reason && v.reason.includes('不符'), `应报不符，实际 ${v.reason}`)
})
t('mirror.verify anchor 缺 alg → fail-closed（P1-1 形态过期）', () => {
  const content = 'actions: []\n'
  const dir = mkOnto(content)
  const ap = join(dir, 'actions.yaml')
  const gp = join(dir, 'guards.yaml')
  const m = new D1Mirror()
  // 旧形态锚点：只有 {file, sha256}，无 alg
  m.update({ check: 'D1', passed: true, anchor: { file: ap, sha256: compositeSha(content, DEFAULT_GUARDS) }, at: 't' })
  const v = m.verify('D1', [ap, gp])
  assert(!v.ok, '缺 alg 必须 fail-closed')
  // Stage 5.5 后 alg 按 check 查表 ⇒ 文案变成"是 X 而应当是 Y"，但**不许放行**这条性质没变。
  assert(v.reason && v.reason.includes('alg'), `应点明 alg 不匹配，实际 ${v.reason}`)
})
ta('mirror.restoreSync 从审计尾部恢复结论（v2 锚点）', async () => {
  const content = 'actions: []\n'
  const dir = mkOnto(content)
  const ap = join(dir, 'actions.yaml')
  const gp = join(dir, 'guards.yaml')
  const auditPath = join(mkdtempSync(join(tmpdir(), 'fde-miraudit-')), 'audit.jsonl')
  const a = new AuditChain(auditPath)
  await a.record({ type: 'check-result', check: 'D1', passed: true, anchor: makeAnchor(dir, content), detail: 'ok', at: 't' })
  await a.flush()
  const m = new D1Mirror()
  m.restoreSync(auditPath)
  const v = m.verify('D1', [ap, gp])
  assert(v.ok, `restore 后 verify 应 ok，实际 ${JSON.stringify(v)}`)
})

// ---------- guard.evaluate ----------
lines.push('[guard.evaluate]')
t('guard 非 fde_phase_advance 不拦', () => {
  const cfg = { projectRoot: mkProject('2'), ontologyRoot: mkOnto('x'), mode: 'enforce' }
  const r = evaluate({ name: 'other', arguments: {} }, cfg, new D1Mirror())
  assertEq(r.deny, undefined)
})
t('guard 跳跃推进被拒（跳过阶段=跳过门禁）', () => {
  const cfg = { projectRoot: mkProject('2'), ontologyRoot: mkOnto('x'), mode: 'enforce' }
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '5' } }, cfg, new D1Mirror())
  assert(r.deny && r.deny.includes('跳跃'), `应拒跳跃，实际 ${r.deny}`)
})
t('guard 末阶段无可推进', () => {
  const cfg = { projectRoot: mkProject('11'), ontologyRoot: mkOnto('x'), mode: 'enforce' }
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '12' } }, cfg, new D1Mirror())
  assert(r.deny, '末阶段应拒')
})
t('guard Phase3 D1 未过 → 被拒（完成判据#2）', () => {
  const content = 'actions: []\n'
  const cfg = { projectRoot: mkProject('3'), ontologyRoot: mkOnto(content), mode: 'enforce' }
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '4' } }, cfg, new D1Mirror())
  assert(r.deny && r.deny.includes('D1'), `应因 D1 未过被拒，实际 ${r.deny}`)
  assertEq(r.checks, ['D1'])
  assertEq(r.skipped, [])
})
t('guard Phase3 D1 已过 → 放行（完成判据#3）', () => {
  const content = 'actions: []\n'
  const dir = mkOnto(content)
  const ap = join(dir, 'actions.yaml')
  const cfg = { projectRoot: mkProject('3'), ontologyRoot: dir, mode: 'enforce' }
  const m = new D1Mirror()
  m.update({ check: 'D1', passed: true, anchor: makeAnchor(dir, content), at: 't' })
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '4' } }, cfg, m)
  assertEq(r.deny, undefined)
  assertEq(r.checks, ['D1'])
})
t('guard D1 锚点失效 → 重新被拒（完成判据#4）', () => {
  const content = 'actions: []\n'
  const dir = mkOnto(content)
  const ap = join(dir, 'actions.yaml')
  const cfg = { projectRoot: mkProject('3'), ontologyRoot: dir, mode: 'enforce' }
  const m = new D1Mirror()
  m.update({ check: 'D1', passed: true, anchor: makeAnchor(dir, content), at: 't' })
  writeFileSync(ap, 'actions: [{id: changed}]\n') // 改了 actions.yaml → 锚点失效
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '4' } }, cfg, m)
  assert(r.deny && r.deny.includes('不符'), `应因锚点失效被拒，实际 ${r.deny}`)
})
t('guard Phase2 无 deny 检查 → 放行', () => {
  const cfg = { projectRoot: mkProject('2'), ontologyRoot: mkOnto('x'), mode: 'enforce' }
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '3' } }, cfg, new D1Mirror())
  assertEq(r.deny, undefined)
  assertEq(r.skipped, [])
})
// Stage 5.6 之后 D5 已接线（见 `_fde_d5_test.mjs`）。行业未声明（哨兵值，非受监管）⇒ D5 自动关闭 ⇒ 放行。
t('guard Phase6 D5 已实现：行业未声明 → 自动关闭（不适用即放行）', () => {
  const cfg = { projectRoot: mkProject('6'), ontologyRoot: mkOnto('x'), mode: 'enforce', gateAuditPath: 'g' }
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '7' } }, cfg, new D1Mirror())
  assertEq(r.deny, undefined)
  assertEq(r.checks, ['D5'])
  assertEq(r.skipped, [])
})
// 「未实现项明确不拦 + 写说明」这条诚实机制现在没有真实缺口了（所有 deny 项均已实现）。
// 但「不变量」还得有人盯着：DENY_CHECKS 里若出现未实现项，guard 会把它当 skipped 放行 ——
// 必须靠下面这条断言保证"没有任何未实现项"（谁加 check 忘实现，这条就红）。
t('不变量：DENY_CHECKS 所有项均已实现（skipped 恒空）', () => {
  for (const c of Object.values(DENY_CHECKS).flat()) {
    assert(IMPLEMENTED_CHECKS[c], `DENY_CHECKS 里的 ${c} 未在 IMPLEMENTED_CHECKS 中`)
  }
})
t('guard Phase4 现在是真拦：D2/D3 都进 checks，一个结论没有就拒', () => {
  const cfg = { projectRoot: mkProject('4'), ontologyRoot: mkOnto('x'), mode: 'enforce', gateAuditPath: 'g' }
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '5' } }, cfg, new D1Mirror())
  assertEq(r.checks, ['D2', 'D3'])
  assertEq(r.skipped, [])
  assert(r.deny, 'Phase 4 不再放行未验证的推进')
})
t('guard shadow 模式同样判定（仅不拦）', () => {
  const content = 'actions: []\n'
  const cfg = { projectRoot: mkProject('3'), ontologyRoot: mkOnto(content), mode: 'shadow' }
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '4' } }, cfg, new D1Mirror())
  // shadow 下 evaluate 仍返回 deny 文案（监听器据此记 shadow-deny），但不改结论字段
  assert(r.deny && r.deny.includes('D1'), 'shadow 仍应判定 D1 未过')
})

// ---------- 🔴 已知缺口绊线：state.yaml 损坏 ⇒ guard 退到「初始状态」，门禁被整体跳过 ----------
// 这条**故意断言「当前是坏的」**。它不是"把 bug 写成测试"，是个**绊线**：
//   ① 谁真把它修好了 ⇒ 本条立刻变红，逼着去把 SECURITY.md §三 与 roadmap 一起改掉（否则又是一条 stale red）；
//   ② 谁把 fail-closed 改得更差 ⇒ 下面两条对照先红。
// 根因不在 guard，在 `dsh-fde-phase/lib/state.js:111-114` —— `readStateSync` 把 **ENOENT 与
// 「文件在、但内容坏了 / 读不了」合进同一个 catch**，两支返回同一个 `DEFAULT_STATE`
// （`current_phase:'0.1'`、`rollback_at:''`，`:29-38`）⇒ 调用方分不出「真读到」与「什么都没读到」。
// 详见 SECURITY.md §三 同名条目。
lines.push('[已知缺口绊线：state.yaml 损坏时的 fail-open]')
function mkRawProject(rawText) {
  const root = mkdtempSync(join(tmpdir(), 'fde-phase-bad-'))
  const mem = join(root, 'memory')
  mkdirSync(mem, { recursive: true })
  writeFileSync(join(mem, 'state.yaml'), rawText)
  return root
}
const okCfg = (root) => ({ projectRoot: root, ontologyRoot: mkOnto('x'), mode: 'enforce', gateAuditPath: 'g' })

t('对照A：state.yaml 完好且刚回滚过（阶段6）⇒ 请求 0.2 因「观察期冻结」被拒', () => {
  const root = mkRawProject(serializeState({
    ...DEFAULT_STATE,
    current_phase: '6',
    rollback_at: new Date(Date.now() - 60_000).toISOString() // 1 分钟前回滚 ⇒ 24h 窗口内
  }))
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '0.2' } }, okCfg(root), new D1Mirror())
  assert(r.deny && r.deny.includes('观察期'), `对照应因观察期被拒，实际 ${r.deny}`)
})
t('对照B：state.yaml 完好、不在观察期（阶段6）⇒ 请求 0.2 因「跳跃」被拒', () => {
  const root = mkRawProject(serializeState({ ...DEFAULT_STATE, current_phase: '6' }))
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '0.2' } }, okCfg(root), new D1Mirror())
  assert(r.deny && r.deny.includes('跳跃'), `对照应因跳跃被拒，实际 ${r.deny}`)
})
t('🔴 已知缺口：state.yaml 损坏 ⇒ 上面两道拦阻**同时消失**，请求 0.2 被放行', () => {
  // 二进制垃圾：一行都匹配不上 ⇒ parseState 原样返回 DEFAULT_STATE。
  const root = mkRawProject('\u0000\u0001binary garbage, not yaml at all')
  const r = evaluate({ name: 'fde_phase_advance', arguments: { to: '0.2' } }, okCfg(root), new D1Mirror())
  assertEq(r.deny, undefined,
    '若这里开始返回 deny ⇒ **缺口已被修好**：请同步更新 SECURITY.md §三 与 roadmap 后，把本条改成新判据')
  assertEq(r.checks, [], '坏文件下 checks 为空 —— 正是"门禁被整体跳过"的直接证据')
})

// ================================================================ 收尾
// 等所有异步用例结算（含 audit / state+lock / mirror.restoreSync），再写文件与判定退出码。
await Promise.all(pending)

lines.push('')
// 故意反一次以验证退出码会变红（手册 §8 第二条纪律）。
if (process.env.FDE_INVERT === '1') {
  t('[INVERT] 故意失败以验证退出码敏感', () => assert(false, 'injected by FDE_INVERT'))
}

lines.push(`通过 ${passed} / 失败 ${failed}`)
lines.push(failed > 0 ? 'RESULT: FAIL' : 'RESULT: PASS')
// FDE_OUT（0030 §7）：跑轮次时显式给输出名 ⇒ 两轮不互相覆盖（缺省沿用原名）
writeFileSync(process.env.FDE_OUT ?? OUT, lines.join('\n') + '\n', 'utf8')

console.log(`[phase-test] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
