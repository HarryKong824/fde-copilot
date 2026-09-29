/**
 * Stage 5.5 · D2 + D3 接线离线回归。
 *
 * 跑法：
 *   node _fde_d2d3_test.mjs
 *   故意做反验证退出码敏感： FDE_INVERT=1 node _fde_d2d3_test.mjs
 *
 * 结果**自己写文件**（`_fde_d2d3_out.txt`）—— 不走控制台（Windows 代码页乱码纪律）。
 *
 * 覆盖（对应 Stage5.5-D2D3-接线-施工单 §1 完成判据 + §5.1）：
 *   §1 config        `gateAuditPath` fail-closed（缺失 / 空串 / 非字符串都抛）
 *   §2 锚点算法表      phase 与 dsl 两侧 ANCHOR_ALGS **逐项相同**（§3⑤ 现在靠人肉同步 ⇒ 机器钉死）
 *   §3 D3 锚点分派     改 objects 只让 D3 失效 / 改 actions 只让 D1 失效（完成判据 #3，本批最核心）
 *   §4 guard Phase4   checks 含 D2/D3、skipped 为空、无结论 ⇒ deny
 *   §5 check-d2       完整 / 断链 / 截断 / 缺 seq / 坏行 / 空链 / 追加即失效
 *   §6 双份逻辑        真跑 tools.js 的 execute，证它与 guard 同判定（施工单 §3② 与 §6-2）
 *
 * 🔴 本文件在 `lib/` 改动**之前**写成 ⇒ 预期是红的。那是"改前必须红"的取证，不是文件坏了。
 *    其中标 🔴 的用例改前必红；未标的改前绿，是防止"改过头"的反向护栏。
 *
 * ⚠️ 尚未存在的模块一律 `await import()` 动态取（放在 §7 守卫区），取不到 ⇒ 记成一条红，
 *    而不是让整个文件在 import 阶段崩掉（那样只能看到一行 stack，看不出哪几条是目标）。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConfig } from './dsh-fde-phase/lib/config.js'
import { DENY_CHECKS, IMPLEMENTED_CHECKS } from './dsh-fde-phase/lib/phases.js'
import { AuditChain, GENESIS } from './dsh-fde-phase/lib/audit.js'
// namespace 导入：既有的具名导出照常取，尚未存在的 `ANCHOR_ALGS` 取到 undefined 也不会让链接阶段崩。
import * as mirrorNs from './dsh-fde-phase/lib/mirror.js'

// —— 下面这些要么还没改全、要么还没创建 ⇒ 动态取，失败只让相关用例变红 ——
let guardMod = null
try {
  guardMod = await import('./dsh-fde-phase/lib/guard.js')
} catch {
  guardMod = null
}
let toolsMod = null
try {
  toolsMod = await import('./dsh-fde-phase/lib/tools.js')
} catch {
  toolsMod = null
}
let checkD2Mod = null
try {
  checkD2Mod = await import('./dsh-fde-phase/lib/check-d2.js')
} catch {
  checkD2Mod = null
}
let dslToolsMod = null
try {
  dslToolsMod = await import('./dsh-fde-dsl/lib/tools.js')
} catch {
  dslToolsMod = null
}

const D1Mirror = mirrorNs.D1Mirror

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_fde_d2d3_out.txt')
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

// ---------------------------------------------------------------- 常量与夹具
const SEP = '\u0000'
/** 三个 alg 字面量在**本文件**重新写一遍：它们是"期望"，不该从被测件里取出来自己比自己。 */
const ALG_D1 = 'sha256(actions+\u0000+guards)@v2'
const ALG_D3 = 'sha256(objects+\u0000+logic)@v1'
const ALG_D2 = 'audit-chain(len+head)@v1'

const ACT = 'actions: []\n'
const GRD = '# default guards\n'
const OBJ = 'objects:\n  - id: Patient\n'
const LOG = 'rules:\n  - id: r1\n'

function composite(parts) {
  return createHash('sha256').update(parts.join(SEP)).digest('hex')
}
function mkDir() {
  return mkdtempSync(join(tmpdir(), 'fde-d2d3-'))
}
/** 带 state.yaml 的 projectRoot。 */
function mkProject(phase) {
  const root = mkDir()
  const mem = join(root, 'memory')
  mkdirSync(mem, { recursive: true })
  writeFileSync(
    join(mem, 'state.yaml'),
    `schema_version: 1\ncurrent_phase: "${phase}"\nphase_status: in_progress\nontology_version: 1\nrevision: 1\n`
  )
  return root
}
/** 四文件齐全的 ontologyRoot。 */
function mkOnto() {
  const dir = mkDir()
  writeFileSync(join(dir, 'actions.yaml'), ACT)
  writeFileSync(join(dir, 'guards.yaml'), GRD)
  writeFileSync(join(dir, 'objects.yaml'), OBJ)
  writeFileSync(join(dir, 'logic.yaml'), LOG)
  return dir
}
function d1Anchor(dir) {
  return { alg: ALG_D1, files: [join(dir, 'actions.yaml'), join(dir, 'guards.yaml')], sha256: composite([ACT, GRD]) }
}
function d3Anchor(dir) {
  return { alg: ALG_D3, files: [join(dir, 'objects.yaml'), join(dir, 'logic.yaml')], sha256: composite([OBJ, LOG]) }
}
/** 用**真 AuditChain** 写一条合法链 ⇒ 顺便交叉验证 check-d2 接受真实产物，不是自造自认。 */
async function writeRealChain(path, n) {
  const c = new AuditChain(path)
  for (let i = 0; i < n; i++) await c.record({ type: 'probe', i, decision: `x${i}` })
  return path
}
/** 独立重算"行数 + 末行 hash"（不复用被测实现，免得实现 == 期望的自证循环）。 */
function fingerprint(path) {
  const text = readFileSync(path, 'utf8')
  const ls = text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
  if (ls.length === 0) return { len: 0, sha256: GENESIS }
  return { len: ls.length, sha256: JSON.parse(ls[ls.length - 1]).hash }
}
function d2Anchor(chain) {
  const fp = fingerprint(chain)
  return { alg: ALG_D2, files: [chain], len: fp.len, sha256: fp.sha256 }
}
function gateCfg(phase, dir, chain) {
  return { projectRoot: mkProject(phase), ontologyRoot: dir, mode: 'enforce', gateAuditPath: chain }
}
/** 造一套"D2 + D3 结论都新鲜"的场景。 */
async function freshScene(phase) {
  const dir = mkOnto()
  const chain = await writeRealChain(join(mkDir(), 'gate.jsonl'), 3)
  const cfg = gateCfg(phase, dir, chain)
  const m = new D1Mirror()
  m.update({ check: 'D2', passed: true, anchor: d2Anchor(chain), at: 't' })
  m.update({ check: 'D3', passed: true, anchor: d3Anchor(dir), at: 't' })
  return { dir, chain, cfg, m }
}
/** 真注册 `fde_phase_advance`（桩 SDK 的 defineTool 是恒等函数 ⇒ 拿到定义本体）。 */
function registerAdvance(cfg, m) {
  if (!toolsMod || typeof toolsMod.installPhaseTool !== 'function') return null
  const defs = []
  const ctx = { tools: { register: (d) => { defs.push(d); return () => {} } } }
  toolsMod.installPhaseTool(ctx, cfg, new AuditChain(''), m)
  return defs.find((d) => d && d.name === 'fde_phase_advance') ?? null
}

// ================================================================ 测试体
lines.push('== Stage 5.5 · D2 + D3 接线离线回归 ==')

// ---------- §1 config：gateAuditPath fail-closed ----------
lines.push('[config gateAuditPath]')
t('🔴 缺 gateAuditPath ⇒ normalizeConfig 抛错（fail-closed，与 projectRoot 同原则）', () => {
  assertThrows('gateAuditPath', () => normalizeConfig({ projectRoot: 'p', ontologyRoot: 'o' }))
})
t('🔴 gateAuditPath 空串 ⇒ 同样抛错（空串 = 没给，不等于"不验"）', () => {
  assertThrows('gateAuditPath', () =>
    normalizeConfig({ projectRoot: 'p', ontologyRoot: 'o', gateAuditPath: '' })
  )
})
t('gateAuditPath 非字符串 ⇒ 抛错', () => {
  assertThrows('gateAuditPath', () =>
    normalizeConfig({ projectRoot: 'p', ontologyRoot: 'o', gateAuditPath: 42 })
  )
})
t('给了合法 gateAuditPath ⇒ 原样保留', () => {
  const c = normalizeConfig({ projectRoot: 'p', ontologyRoot: 'o', gateAuditPath: 'E:/x/gate.jsonl' })
  assertEq(c.gateAuditPath, 'E:/x/gate.jsonl')
})
t('补上必需项后其余默认值仍生效（新增必填不得把别的东西带坏）', () => {
  const c = normalizeConfig({ projectRoot: 'p', ontologyRoot: 'o', gateAuditPath: 'g' })
  assertEq(c.mode, 'shadow')
  assertEq(c.protectedPhases, ['4', '6', '10'])
  assertEq(c.denyTools, ['pwsh'])
})
t('projectRoot / ontologyRoot 缺失时仍然先报它们自己的错（错误优先级不漂移）', () => {
  assertThrows('projectRoot', () => normalizeConfig({ ontologyRoot: 'o', gateAuditPath: 'g' }))
  assertThrows('ontologyRoot', () => normalizeConfig({ projectRoot: 'p', gateAuditPath: 'g' }))
})

// ---------- §2 锚点算法表：两侧必须一致 ----------
lines.push('[ANCHOR_ALGS 两侧一致]')
t('🔴 phase 侧导出 ANCHOR_ALGS（按 check 一张表，不再单一常量）', () => {
  const p = mirrorNs.ANCHOR_ALGS
  assert(p, 'phase/lib/mirror.js 应导出 ANCHOR_ALGS')
  assertEq(Object.keys(p).sort(), ['D1', 'D2', 'D3', 'D5'])
})
t('🔴 dsl 侧导出 ANCHOR_ALGS', () => {
  const d = dslToolsMod && dslToolsMod.ANCHOR_ALGS
  assert(d, `dsl/lib/tools.js 应导出 ANCHOR_ALGS（实际导出：${dslToolsMod ? Object.keys(dslToolsMod).join(',') : 'null'}）`)
  assertEq(Object.keys(d).sort(), ['D1', 'D2', 'D3', 'D5'])
})
t('🔴 两侧 ANCHOR_ALGS **逐项相同**（§3⑤ 人工同步 ⇒ 这里机器钉死）', () => {
  const p = mirrorNs.ANCHOR_ALGS
  const d = dslToolsMod && dslToolsMod.ANCHOR_ALGS
  assert(p && d, '两侧都要有 ANCHOR_ALGS')
  assertEq(d, p, 'dsl 与 phase 的锚点算法表必须完全一致')
})
t('D1 alg 仍是 v2 字面量（既有已验收形态，不许漂移）', () => {
  assertEq(mirrorNs.ANCHOR_ALGS?.D1, ALG_D1)
})
t('D3 alg = sha256(objects+logic)@v1', () => {
  assertEq(mirrorNs.ANCHOR_ALGS?.D3, ALG_D3)
})
t('D2 alg = audit-chain(len+head)@v1', () => {
  assertEq(mirrorNs.ANCHOR_ALGS?.D2, ALG_D2)
})
t('四个 alg 互不相同（分派表不能有两个 alg 相同，否则按 alg 反查会歧义）', () => {
  const p = mirrorNs.ANCHOR_ALGS
  assertEq(new Set([p?.D1, p?.D2, p?.D3, p?.D5]).size, 4)
})

// ---------- §3 D3 锚点分派（完成判据 #3） ----------
lines.push('[D3 锚点分派]')
t('D3 结论新鲜（objects/logic 未变）⇒ ok', () => {
  const dir = mkOnto()
  const m = new D1Mirror()
  m.update({ check: 'D3', passed: true, anchor: d3Anchor(dir), at: 't' })
  const v = m.verify('D3', [join(dir, 'objects.yaml'), join(dir, 'logic.yaml')])
  assert(v.ok, `应 ok，实际 ${JSON.stringify(v)}`)
})
t('D3 无结论 ⇒ fail-closed', () => {
  const dir = mkOnto()
  const v = new D1Mirror().verify('D3', [join(dir, 'objects.yaml'), join(dir, 'logic.yaml')])
  assert(!v.ok, '没跑过 D3 必须拒')
})
t('D3 上次未通过 ⇒ fail-closed', () => {
  const dir = mkOnto()
  const m = new D1Mirror()
  m.update({ check: 'D3', passed: false, anchor: d3Anchor(dir), at: 't' })
  assert(!m.verify('D3', [join(dir, 'objects.yaml'), join(dir, 'logic.yaml')]).ok)
})
t('🔴 改 objects.yaml ⇒ D3 失效，**同时 D1 不受影响**（本批核心·正向）', () => {
  const dir = mkOnto()
  const m = new D1Mirror()
  m.update({ check: 'D1', passed: true, anchor: d1Anchor(dir), at: 't' })
  m.update({ check: 'D3', passed: true, anchor: d3Anchor(dir), at: 't' })
  writeFileSync(join(dir, 'objects.yaml'), 'objects:\n  - id: Changed\n')
  const v3 = m.verify('D3', [join(dir, 'objects.yaml'), join(dir, 'logic.yaml')])
  assert(!v3.ok, '改 objects ⇒ D3 应失效')
  assert(v3.reason && v3.reason.includes('不符'), `应报不符，实际 ${v3.reason}`)
  const v1 = m.verify('D1', [join(dir, 'actions.yaml'), join(dir, 'guards.yaml')])
  assert(v1.ok, `改 objects 不该动 D1，实际 ${JSON.stringify(v1)}`)
})
t('🔴 改 actions.yaml ⇒ D1 失效，**同时 D3 不受影响**（本批核心·反向）', () => {
  const dir = mkOnto()
  const m = new D1Mirror()
  m.update({ check: 'D1', passed: true, anchor: d1Anchor(dir), at: 't' })
  m.update({ check: 'D3', passed: true, anchor: d3Anchor(dir), at: 't' })
  writeFileSync(join(dir, 'actions.yaml'), 'actions: [{id: changed}]\n')
  const v1 = m.verify('D1', [join(dir, 'actions.yaml'), join(dir, 'guards.yaml')])
  assert(!v1.ok, '改 actions ⇒ D1 应失效')
  const v3 = m.verify('D3', [join(dir, 'objects.yaml'), join(dir, 'logic.yaml')])
  assert(v3.ok, `改 actions 不该动 D3，实际 ${JSON.stringify(v3)}`)
})
t('🔴 D3 挂着 D1 的 alg ⇒ fail-closed（必须按 check 查表，不能再恒用 D1 的 alg）', () => {
  const dir = mkOnto()
  const m = new D1Mirror()
  m.update({
    check: 'D3',
    passed: true,
    // 内容哈希是对的，但 alg 套错成 D1 的
    anchor: { alg: ALG_D1, files: [join(dir, 'objects.yaml'), join(dir, 'logic.yaml')], sha256: composite([OBJ, LOG]) },
    at: 't'
  })
  const v = m.verify('D3', [join(dir, 'objects.yaml'), join(dir, 'logic.yaml')])
  assert(!v.ok, 'alg 与 check 不匹配必须拒 —— 否则结论会"永远新鲜"')
})

// ---------- §4 guard.evaluate Phase 4 ----------
lines.push('[guard.evaluate Phase 4]')
t('🔴 IMPLEMENTED_CHECKS 含 D2/D3', () => {
  assertEq(IMPLEMENTED_CHECKS, { D1: true, D2: true, D3: true, D5: true })
})
t('DENY_CHECKS[4] 仍是 [D2,D3]（按**当前**阶段的配置跑）', () => {
  assertEq(DENY_CHECKS['4'], ['D2', 'D3'])
})
t('🔴 Phase4 ⇒ checks=[D2,D3]、skipped=[]（从"跳过"变"真跑"）', () => {
  assert(guardMod && typeof guardMod.evaluate === 'function', 'guard.js 应导出 evaluate')
  const cfg = gateCfg('4', mkOnto(), join(mkDir(), 'g.jsonl'))
  const r = guardMod.evaluate({ name: 'fde_phase_advance', arguments: { to: '5' } }, cfg, new D1Mirror())
  assertEq(r.checks, ['D2', 'D3'])
  assertEq(r.skipped, [])
})
t('🔴 Phase4 一个结论都没有 ⇒ deny，且同时点名 D2 与 D3', () => {
  const cfg = gateCfg('4', mkOnto(), join(mkDir(), 'g.jsonl'))
  const r = guardMod.evaluate({ name: 'fde_phase_advance', arguments: { to: '5' } }, cfg, new D1Mirror())
  assert(r.deny, 'Phase 4 应被拦')
  assert(r.deny.includes('D2'), `理由应点名 D2，实际 ${r.deny}`)
  assert(r.deny.includes('D3'), `理由应点名 D3，实际 ${r.deny}`)
})
ta('Phase4 三条都新鲜 ⇒ 放行（护栏：不得把放行路径也堵死）', async () => {
  const { cfg, m } = await freshScene('4')
  const r = guardMod.evaluate({ name: 'fde_phase_advance', arguments: { to: '5' } }, cfg, m)
  assertEq(r.deny, undefined, `都新鲜应放行，实际被拒：${r.deny}`)
})
ta('🔴 改 objects.yaml ⇒ 被拒且**只点名 D3**（证不是"任一文件改动都让全部失效"）', async () => {
  const { dir, cfg, m } = await freshScene('4')
  writeFileSync(join(dir, 'objects.yaml'), 'objects:\n  - id: Tampered\n')
  const r = guardMod.evaluate({ name: 'fde_phase_advance', arguments: { to: '5' } }, cfg, m)
  assert(r.deny, '改 objects 应被拒')
  assert(r.deny.includes('D3'), `应点名 D3，实际 ${r.deny}`)
  assert(!r.deny.includes('D2'), `D2 结论新鲜，不该被点名。实际：${r.deny}`)
})
ta('🔴 向 gate 链追加一行 ⇒ 被拒且**只点名 D2**（完成判据 #5 的静态形态）', async () => {
  const { chain, cfg, m } = await freshScene('4')
  const c = new AuditChain(chain)
  await c.record({ type: 'probe', decision: 'appended' })
  const r = guardMod.evaluate({ name: 'fde_phase_advance', arguments: { to: '5' } }, cfg, m)
  assert(r.deny, '链变了 D2 应过期')
  assert(r.deny.includes('D2'), `应点名 D2，实际 ${r.deny}`)
  assert(!r.deny.includes('D3'), `D3 结论新鲜，不该被点名。实际：${r.deny}`)
})
t('guard 仍不拦无关工具（别把门禁扩散到整个工具面）', () => {
  const cfg = gateCfg('4', mkOnto(), join(mkDir(), 'g.jsonl'))
  const r = guardMod.evaluate({ name: 'other', arguments: {} }, cfg, new D1Mirror())
  assertEq(r.deny, undefined)
})

// ---------- §5 check-d2 ----------
lines.push('[check-d2]')
t('🔴 check-d2.js 已创建，导出 D2_ANCHOR_ALG / verifyAuditChainText / auditChainFingerprintSync / runD2Check', () => {
  assert(checkD2Mod, '尚未创建 dsh-fde-phase/lib/check-d2.js')
  assertEq(checkD2Mod.D2_ANCHOR_ALG, ALG_D2)
  assert(typeof checkD2Mod.verifyAuditChainText === 'function', '缺 verifyAuditChainText')
  assert(typeof checkD2Mod.auditChainFingerprintSync === 'function', '缺 auditChainFingerprintSync')
  assert(typeof checkD2Mod.runD2Check === 'function', '缺 runD2Check')
})
ta('完整链 ⇒ passed，lineCount/headHash 与独立重算一致', async () => {
  const chain = await writeRealChain(join(mkDir(), 'g.jsonl'), 4)
  const r = checkD2Mod.verifyAuditChainText(readFileSync(chain, 'utf8'))
  assert(r.passed, `应通过，实际 ${JSON.stringify(r.failures)}`)
  assertEq(r.lineCount, fingerprint(chain).len)
  assertEq(r.headHash, fingerprint(chain).sha256)
})
ta('🔴 断链（中间一条 prevHash 被改）⇒ 不通过，失败项点明 prevHash', async () => {
  const chain = await writeRealChain(join(mkDir(), 'g.jsonl'), 4)
  const ls = readFileSync(chain, 'utf8').split('\n').filter((s) => s.trim())
  const rec = JSON.parse(ls[2])
  rec.prevHash = 'f'.repeat(64)
  ls[2] = JSON.stringify(rec)
  writeFileSync(chain, ls.join('\n') + '\n')
  const r = checkD2Mod.verifyAuditChainText(readFileSync(chain, 'utf8'))
  assert(!r.passed, '断链必须验不出来才行（这里断言它验得出来）')
  assert(
    JSON.stringify(r.failures).includes('prevHash'),
    `失败项应指出 prevHash，实际 ${JSON.stringify(r.failures)}`
  )
})
ta('🔴 截断（丢掉中间一条）⇒ 不通过 —— 这是"必须全量读、不能沿用 TAIL_BYTES 尾部窗口"的理由', async () => {
  const chain = await writeRealChain(join(mkDir(), 'g.jsonl'), 5)
  const ls = readFileSync(chain, 'utf8').split('\n').filter((s) => s.trim())
  writeFileSync(chain, [ls[0], ls[1], ls[3], ls[4]].join('\n') + '\n')
  const r = checkD2Mod.verifyAuditChainText(readFileSync(chain, 'utf8'))
  assert(!r.passed, '截断必须验得出来 —— 只看尾部窗口会漏掉它')
})
ta('🔴 缺 seq 的行 ⇒ 不通过（P2-3 那道坑的同形态，D2 这里必须再挡一次）', async () => {
  const chain = await writeRealChain(join(mkDir(), 'g.jsonl'), 3)
  const ls = readFileSync(chain, 'utf8').split('\n').filter((s) => s.trim())
  const rec = JSON.parse(ls[1])
  delete rec.seq
  ls[1] = JSON.stringify(rec)
  writeFileSync(chain, ls.join('\n') + '\n')
  const r = checkD2Mod.verifyAuditChainText(readFileSync(chain, 'utf8'))
  assert(!r.passed, '缺 seq 必须验出来')
})
ta('不可解析的行 ⇒ 不通过（残尾/坏行不得被当成完整链）', async () => {
  const chain = await writeRealChain(join(mkDir(), 'g.jsonl'), 3)
  const r = checkD2Mod.verifyAuditChainText(readFileSync(chain, 'utf8') + '{broken json\n')
  assert(!r.passed)
})
t('空链 ⇒ 通过（没有东西可验 ≠ 有问题），len=0 且 headHash=GENESIS', () => {
  const r = checkD2Mod.verifyAuditChainText('')
  assert(r.passed, `空链应视为完整，实际 ${JSON.stringify(r.failures)}`)
  assertEq(r.lineCount, 0)
  assertEq(r.headHash, GENESIS)
})
ta('指纹 = 行数 + 末行 hash；追加一行 ⇒ len+1 且 headHash 变 ⇒ 旧锚点必失效', async () => {
  const chain = await writeRealChain(join(mkDir(), 'g.jsonl'), 3)
  const fp1 = checkD2Mod.auditChainFingerprintSync(chain)
  assertEq(fp1, fingerprint(chain), '指纹必须与独立算法一致')
  const c = new AuditChain(chain)
  await c.record({ type: 'probe', decision: 'more' })
  const fp2 = checkD2Mod.auditChainFingerprintSync(chain)
  assertEq(fp2, fingerprint(chain))
  assertEq(fp2.len, fp1.len + 1)
  assert(fp2.sha256 !== fp1.sha256, 'headHash 必须变 —— 否则"追加"就溜过去了')
})
t('链文件不存在 ⇒ fingerprint 抛错（调用方翻成 deny 理由，绝不返回可比对的值）', () => {
  let threw = null
  try {
    checkD2Mod.auditChainFingerprintSync(join(mkDir(), 'nope.jsonl'))
  } catch (e) {
    threw = e
  }
  assert(threw, '读不到链必须抛，不得静默返回')
})
ta('runD2Check（异步）在完整链上返回 passed + 指纹', async () => {
  const chain = await writeRealChain(join(mkDir(), 'g.jsonl'), 3)
  const r = await checkD2Mod.runD2Check(chain)
  assertEq(r.passed, true)
  assertEq(r.lineCount, fingerprint(chain).len)
  assertEq(r.headHash, fingerprint(chain).sha256)
})
ta('runD2Check 在断链上返回 passed:false + failures', async () => {
  const chain = await writeRealChain(join(mkDir(), 'g.jsonl'), 3)
  const ls = readFileSync(chain, 'utf8').split('\n').filter((s) => s.trim())
  const rec = JSON.parse(ls[1])
  rec.prevHash = 'a'.repeat(64)
  ls[1] = JSON.stringify(rec)
  writeFileSync(chain, ls.join('\n') + '\n')
  const r = await checkD2Mod.runD2Check(chain)
  assertEq(r.passed, false)
  assert(r.failures.length > 0, '应给出失败项')
})
ta('🔴 mirror.verifyChain：追加一行 ⇒ D2 结论失效', async () => {
  const chain = await writeRealChain(join(mkDir(), 'g.jsonl'), 3)
  const m = new D1Mirror()
  m.update({ check: 'D2', passed: true, anchor: d2Anchor(chain), at: 't' })
  assert(typeof m.verifyChain === 'function', 'D1Mirror 应有 verifyChain（D2 走审计链锚点）')
  assert(m.verifyChain('D2', chain).ok, '新鲜时应 ok')
  const c = new AuditChain(chain)
  await c.record({ type: 'probe', decision: 'later' })
  assert(!m.verifyChain('D2', chain).ok, '链长了 D2 必须过期')
})
t('mirror.verifyChain：链不存在 ⇒ ok:false 且带理由（不抛、不返回 undefined）', () => {
  const m = new D1Mirror()
  const v = m.verifyChain('D2', join(mkDir(), 'nope.jsonl'))
  assertEq(v.ok, false)
  assert(v.reason, '应给出人类可读理由')
})
t('mirror.verifyChain：D2 上次未通过 ⇒ ok:false', () => {
  const chain = join(mkDir(), 'g.jsonl')
  writeFileSync(chain, '')
  const m = new D1Mirror()
  m.update({ check: 'D2', passed: false, anchor: { alg: ALG_D2, files: [chain], len: 0, sha256: GENESIS }, at: 't' })
  assertEq(m.verifyChain('D2', chain).ok, false)
})
t('mirror.verifyChain：D2 挂着别的 alg ⇒ fail-closed', () => {
  const chain = join(mkDir(), 'g.jsonl')
  writeFileSync(chain, '')
  const m = new D1Mirror()
  m.update({ check: 'D2', passed: true, anchor: { alg: ALG_D1, files: [chain], len: 0, sha256: GENESIS }, at: 't' })
  assertEq(m.verifyChain('D2', chain).ok, false)
})

// ---------- §6 双份逻辑：guard 与 tools.execute 必须同判定 ----------
lines.push('[双份逻辑一致性]')
t('🔴 guard.js 导出 runDenyChecks（两边共用判定，替掉 §3② 那个各写一遍的 for 循环体）', () => {
  assert(guardMod && typeof guardMod.runDenyChecks === 'function', 'guard.js 应导出 runDenyChecks')
})
t('runDenyChecks：未知但标为 implemented 的 check ⇒ fail-closed（不能因为没分支就跳过）', () => {
  const cfg = gateCfg('4', mkOnto(), join(mkDir(), 'g.jsonl'))
  const fs = guardMod.runDenyChecks(['DX'], cfg, new D1Mirror())
  assert(fs.length === 1, '应有 1 条失败')
  assert(fs[0].check === 'DX', `失败项应点名 DX，实际 ${JSON.stringify(fs)}`)
})
ta('🔴 tools.js 的 execute 自己也会拦 D2/D3（不能只靠入口 guard）', async () => {
  const cfg = gateCfg('4', mkOnto(), join(mkDir(), 'g.jsonl'))
  const def = registerAdvance(cfg, new D1Mirror())
  assert(def, '没注册到 fde_phase_advance（桩环境异常）')
  let threw = null
  try {
    await def.execute({ to: '5', reason: 'probe' }, { callId: 'c1' })
  } catch (e) {
    threw = e
  }
  assert(threw, 'execute 必须自己复算门禁 —— 只靠入口 guard 的话这里会直接放行')
  assert(/D2|D3/.test(`${threw.code ?? ''} ${threw.message ?? ''}`), `拒绝理由应点名 D2/D3，实际 ${threw.message}`)
})
ta('execute 与 guard 一致：都新鲜 ⇒ execute 放行且 checks=[D2,D3]', async () => {
  const { cfg, m } = await freshScene('4')
  const def = registerAdvance(cfg, m)
  const r = await def.execute({ to: '5', reason: 'probe' }, { callId: 'c1' })
  assertEq(r.from, '4')
  assertEq(r.to, '5')
  assertEq(r.checks, ['D2', 'D3'])
  assertEq(r.skipped, [])
})
ta('🔴 execute 也会因 D3 锚点失效而拒（改 objects.yaml）', async () => {
  const { dir, cfg, m } = await freshScene('4')
  const def = registerAdvance(cfg, m)
  writeFileSync(join(dir, 'objects.yaml'), 'objects:\n  - id: Tampered\n')
  let threw = null
  try {
    await def.execute({ to: '5', reason: 'probe' }, { callId: 'c1' })
  } catch (e) {
    threw = e
  }
  assert(threw, 'execute 侧应拒绝')
  assert(`${threw.message ?? ''}`.includes('D3'), `应点名 D3，实际 ${threw.message}`)
})

// ================================================================ 收尾
await Promise.all(pending)
lines.push('')
if (process.env.FDE_INVERT === '1') {
  t('[INVERT] 故意失败以验证退出码敏感', () => assert(false, 'injected by FDE_INVERT'))
}
lines.push(`通过 ${passed} / 失败 ${failed}`)
lines.push(failed > 0 ? 'RESULT: FAIL' : 'RESULT: PASS')
// FDE_OUT（0030 §7）：跑轮次时显式给输出名 ⇒ 两轮不互相覆盖（缺省沿用原名）
writeFileSync(process.env.FDE_OUT ?? OUT, lines.join('\n') + '\n', 'utf8')
console.log(`[d2d3-test] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
