/**
 * E1 接线回归 —— 在**部署副本**上跑两个 `index.js` 的 `apply()`，验证 break-glass 的接线。
 *
 * 跑法（必须在已部署副本旁跑，才能解析到真 SDK）：
 *   node _fde_e1_wiring_test.mjs
 * 结果写 `_e1_wiring_out.txt`（不走控制台，规避 Windows 代码页乱码）。
 * 支持 `FDE_OUT` 覆盖输出名（跑轮次时不互相覆盖）。
 *
 * 🔴 为什么必须单独一个文件、且必须 import **部署副本**：
 *    `index.js` 要 `Config`（schemastery）⇒ 工作区跑不了（本工作区无该包）。
 *    而接线恰恰是本机制里"单测全绿、活体全废"风险最高的一层 —— 本项目已有两次先例：
 *      · P0-1：`ctx.effect(() => disposeCheckResult(), …)` 在 apply 期**当场注销**监听器；
 *      · E4：`restrict` 的 scoped ctx 只有在真 ctx 上才暴露。
 *    所以这里用**忠实模拟 Cordis 语义**的假 ctx（`effect` 的返回值若是函数 ⇒ 登记为注销器、
 *    只在 teardown 调用；`on` 返回注销器且**同名可挂多个**；`inject(['agents'], cb)` 同步回调），
 *    把接线行为钉死。
 *
 * ⚠️ 本套件**不覆盖**：真 SDK 的 approval 弹窗路由、`agent.send` 的 inbox 送达、
 *    真 `ctx.inject` 的 fiber 生命周期。那些只能活体验。
 *
 * 覆盖：
 *   [A] gate：`fde/break-glass` 监听器注册且**存活**（没被 apply 期当场注销）
 *   [B] gate：**重启恢复** —— 链上预置一条 break-glass ⇒ apply 后 GATE-PATH 真被放行
 *       [B2] 对照组：链上无记录 ⇒ 同一调用被拒（否则 [B1] 可能只是"根本没拦"）
 *   [C] gate：收到事件 ⇒ 本链新增 open + 立即放行（各写各的链）
 *   [D] gate：收到 resolved ⇒ 不再放行 + 本链新增 resolved + 重启后不复活
 *   [E] phase：guard / fde-break-glass 工具 / session-start 提醒 / pre-execute 监听器都在
 *   [F] phase：**重启恢复** —— 链上预置 break-glass ⇒ apply 后 guard 真放行 D1
 *       [F1′] 锚点在 apply 后仍生效：改了 actions.yaml ⇒ 恢复出来的放行立刻失效
 *       [F2] 对照组：链上无记录 ⇒ 同一推进行被拒
 */

import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.env.FDE_OUT ?? join(HERE, '_e1_wiring_out.txt')
const DEPLOYED = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/node_modules'
const url = (rel) => pathToFileURL(join(DEPLOYED, rel)).href

const lines = []
let passed = 0
let failed = 0

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败')
}
function assertEq(a, b, msg) {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg || '不相等'}：期望 ${y}，实际 ${x}`)
}
/** 断言里全部改成 async —— 审计的 `record()` 是 `await appendFile`，不等一拍是读不到的。 */
async function t(name, fn) {
  try {
    await fn()
    passed += 1
    lines.push(`  ✓ ${name}`)
  } catch (e) {
    failed += 1
    lines.push(`  ✗ ${name}`)
    lines.push(`      ${e && e.message ? e.message : String(e)}`)
  }
}
/** 让在途的 appendFile / fire-and-forget 的 promise 落地。 */
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))

/**
 * 忠实模拟 Cordis 的 effect / on / inject 语义。
 * 🔴 关键：`effect(fn)` 里 `fn()` 的返回值**若是函数**，那是注销器，**只在 teardown 调用**。
 *    apply 期就调用它 = 监听器当场注销（P0-1）。
 */
function makeCtx() {
  const handlers = new Map() // name -> cb[]
  const tools = []
  const guards = []
  const disposers = []
  return {
    handlers,
    tools,
    guards,
    teardown() {
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* 单个注销器抛错不影响其余 */
        }
      }
    },
    /** 触发某个事件的全部监听器（Cordis 同名可挂多个）。 */
    fire(name, payload) {
      for (const cb of handlers.get(name) ?? []) cb(payload)
    },
    count(name) {
      return (handlers.get(name) ?? []).length
    },
    ctx: {
      on(name, cb) {
        if (!handlers.has(name)) handlers.set(name, [])
        handlers.get(name).push(cb)
        return () => {
          const list = handlers.get(name) ?? []
          const i = list.indexOf(cb)
          if (i >= 0) list.splice(i, 1)
        }
      },
      emit() {},
      effect(fn) {
        const r = fn()
        if (typeof r === 'function') disposers.push(r)
        return r
      },
      get: () => undefined,
      inject(_names, cb) {
        // 真 Cordis：依赖已就绪时**同步**回调，返回 fiber（含 dispose）。
        const injected = {
          agents: { list: () => [] },
          tools: { restrict: () => () => {} },
          get: () => undefined,
          logger: { info() {}, warn() {}, error() {} }
        }
        const r = cb(injected)
        if (typeof r === 'function') disposers.push(r)
        return { dispose() {} }
      },
      tools: {
        guard: (fn) => {
          guards.push(fn)
          return () => {}
        },
        register: (d) => {
          tools.push(d)
          return () => {}
        }
      },
      logger: { info() {}, warn() {}, error() {} }
    }
  }
}

/** 链上一条记录的 hash（与 `lib/audit.js` 的 `linkHash` 同算法：sha256(prevHash + '\n' + JSON)）。 */
const linkHash = (prevHash, record) =>
  createHash('sha256').update(prevHash).update('\n').update(JSON.stringify(record)).digest('hex')
const GENESIS = '0'.repeat(64)

/**
 * 预置一条**链接合法**的 break-glass 记录到指定链文件。
 * ⚠️ 刻意让 prevHash/hash 都算对：预置行若不是合法链记录，`#restoreFromTail` 取不到链头，
 *    后续记录会与它争抢同一个 prevHash —— 那测的就不是"恢复"而是"链坏了会怎样"。
 */
function seedChain(chainPath, payload) {
  mkdirSync(dirname(chainPath), { recursive: true })
  const record = { seq: 1, ts: payload.at, type: 'break-glass', ...payload }
  const line = JSON.stringify({ ...record, prevHash: GENESIS, hash: linkHash(GENESIS, record) })
  const prev = existsSync(chainPath) ? readFileSync(chainPath, 'utf8') : ''
  writeFileSync(chainPath, prev + line + '\n', 'utf8')
}

/** 读链文件里的记录数组（供断言）。 */
function chainRows(chainPath) {
  try {
    return readFileSync(chainPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

lines.push('== E1 break-glass 接线回归（import 部署副本，非工作区源码）==')
lines.push(`部署副本：${DEPLOYED}`)
lines.push('')

const { apply: gateApply } = await import(url('dsh-fde-ontology-gate/lib/index.js'))
const { Config: gateConfigSchema } = await import(url('dsh-fde-ontology-gate/lib/config.js'))
const { apply: phaseApply } = await import(url('dsh-fde-phase/lib/index.js'))
const { compositeAnchorSha } = await import(url('dsh-fde-phase/lib/mirror.js'))

// ---------------------------------------------------------------- 公共夹具
function mkOnto(name) {
  const dir = mkdtempSync(join(tmpdir(), `e1w-${name}-`))
  writeFileSync(join(dir, 'actions.yaml'), 'actions:\n  - id: a\n    writes: true\n')
  writeFileSync(join(dir, 'guards.yaml'), 'guards:\n  - ref: g\n    impl: true\n')
  writeFileSync(join(dir, 'objects.yaml'), 'objects: []\n')
  writeFileSync(join(dir, 'logic.yaml'), 'logic: []\n')
  writeFileSync(join(dir, 'compliance.yaml'), 'rules:\n  - id: r1\n')
  return dir
}
function mkProject(name, phase = '3') {
  const root = mkdtempSync(join(tmpdir(), `e1w-${name}-`))
  mkdirSync(join(root, 'memory'), { recursive: true })
  writeFileSync(
    join(root, 'memory', 'state.yaml'),
    `schema_version: 1\ncurrent_phase: "${phase}"\nphase_status: in_progress\nontology_version: 1\nrevision: 1\n`
  )
  return root
}
function mkChain(name) {
  return join(mkdtempSync(join(tmpdir(), `e1w-${name}-`)), 'chain.jsonl')
}

const d1AnchorOf = (onto) =>
  compositeAnchorSha([
    readFileSync(join(onto, 'actions.yaml'), 'utf8'),
    readFileSync(join(onto, 'guards.yaml'), 'utf8')
  ])

/** gate 配置：走**部署副本自己的** Config 补默认值（不手抄默认值，避免与 lib/config.js 漂移）。 */
const gateCfgOf = (extra) =>
  gateConfigSchema({
    mode: 'enforce',
    denyRunCode: true,
    workspaceRoot: join(tmpdir(), 'e1w-ws'),
    protectedExtraRoots: [],
    ...extra
  })

const hitProtected = (onto) => ({
  name: 'pwsh',
  arguments: { command: `echo hi > ${join(onto, 'actions.yaml')}` }
})

// ══════════════════════════════════════════════════ [A][B] gate 重启恢复
lines.push('[A/B/C/D] dsh-fde-ontology-gate')

const ontoB = mkOnto('b')
const chainB = mkChain('b')
seedChain(chainB, {
  id: 'evt_bg_seed1',
  denyId: 'GATE-PATH',
  category: 'deny_defect',
  reason: '预置：模拟"上次进程砸的玻璃"',
  at: '2026-09-29T00:00:00.000Z',
  expiresAt: '2026-10-06T00:00:00.000Z',
  anchor: null
})
const ctxB = makeCtx()
gateApply(ctxB.ctx, gateCfgOf({ ontologyRoot: ontoB, auditPath: chainB }))
const gateGuard = ctxB.guards[0]

await t('[A] 已注册 tools.guard', () => assert(typeof gateGuard === 'function', '没注册 guard'))
await t('[A] `fde/break-glass` 监听器注册且**存活**（没在 apply 期被当场注销）', () => {
  assert(ctxB.count('fde/break-glass') === 1, `P0-1 同型：监听器数 = ${ctxB.count('fde/break-glass')}`)
})
await t('[B1] 重启恢复：链上预置的 break-glass 让 GATE-PATH 真被放行', () => {
  assertEq(gateGuard(hitProtected(ontoB)), undefined, '应从自己的链恢复出放行')
})

await t('[B2] 对照组：链上无记录的另一个实例 ⇒ 同一调用被拒（证明 [B1] 不是"根本没拦"）', async () => {
  const ontoNo = mkOnto('b2')
  const c = makeCtx()
  gateApply(c.ctx, gateCfgOf({ ontologyRoot: ontoNo, auditPath: mkChain('b2') }))
  const r = c.guards[0](hitProtected(ontoNo))
  c.teardown()
  assert(typeof r === 'string' && r.length > 0, `无记录时应当拦，实际 ${JSON.stringify(r)}`)
})

// ══════════════════════════════════════════════════ [C][D] gate 事件
const ontoC = mkOnto('c')
const chainC = mkChain('c')
const ctxC = makeCtx()
gateApply(ctxC.ctx, gateCfgOf({ ontologyRoot: ontoC, auditPath: chainC }))

const recC = {
  id: 'evt_bg_live1',
  denyId: 'GATE-PATH',
  category: 'scope_edge',
  reason: '活体广播',
  at: '2026-09-29T01:00:00.000Z',
  expiresAt: '2026-10-06T01:00:00.000Z',
  anchor: null
}
ctxC.fire('fde/break-glass', recC)
await settle()

await t('[C] 收到事件 ⇒ 立即放行', () => {
  assertEq(ctxC.guards[0](hitProtected(ontoC)), undefined)
})
await t('[C] 收到事件 ⇒ **写进自己的链**（否则重启后放行全丢）', () => {
  const opens = chainRows(chainC).filter((r) => r.type === 'break-glass' && r.id === recC.id)
  assertEq(opens.length, 1, `本链应有 1 条 open，实际 ${JSON.stringify(chainRows(chainC).map((r) => r.type))}`)
  // 字段名必须与 bg-mirror.restoreSync 读的**逐字对应**，少一个就是"重启后放行失效"
  for (const k of ['denyId', 'category', 'reason', 'at', 'expiresAt', 'anchor']) {
    assert(k in opens[0], `链记录缺字段 ${k} ⇒ 重启后该字段恢复不出来`)
  }
})
await t('[C] 监听器对畸形载荷不抛（同步抛错会冒泡给广播方，把砸玻璃变成失败）', async () => {
  ctxC.fire('fde/break-glass', null)
  ctxC.fire('fde/break-glass', {})
  ctxC.fire('fde/break-glass', { id: 'x' })
  await settle()
})

ctxC.fire('fde/break-glass', { id: recC.id, at: '2026-09-30T00:00:00.000Z', resolved: true })
await settle()

await t('[D] 收到 resolved ⇒ 不再放行', () => {
  const r = ctxC.guards[0](hitProtected(ontoC))
  assert(typeof r === 'string' && r.length > 0, `应重新拦，实际 ${JSON.stringify(r)}`)
})
await t('[D] 收到 resolved ⇒ 本链新增一条 resolved（供下次重启恢复）', () => {
  assert(
    chainRows(chainC).some((r) => r.type === 'break-glass-resolved' && r.id === recC.id),
    JSON.stringify(chainRows(chainC).map((r) => r.type))
  )
})
await t('[D] 重启后（重新 apply 同一条链）该记录恢复为**已补正**、不放行', () => {
  const c = makeCtx()
  gateApply(c.ctx, gateCfgOf({ ontologyRoot: ontoC, auditPath: chainC }))
  const r = c.guards[0](hitProtected(ontoC))
  c.teardown()
  assert(typeof r === 'string' && r.length > 0, `已补正的放行不得在重启后复活，实际 ${JSON.stringify(r)}`)
})

ctxB.teardown()
ctxC.teardown()

// ══════════════════════════════════════════════════ [E][F] phase
lines.push('')
lines.push('[E/F] dsh-fde-phase')

function applyPhase(chainPath, projectRoot, onto) {
  const c = makeCtx()
  phaseApply(c.ctx, {
    projectRoot,
    ontologyRoot: onto,
    mode: 'enforce',
    auditPath: chainPath,
    gateAuditPath: mkChain('gap'),
    lockTtlMs: 30000
  })
  return c
}

const ontoO = mkOnto('o')
const ctxO = applyPhase(mkChain('o'), mkProject('o'), ontoO)
const toolNames = ctxO.tools.map((d) => d && d.name)

await t('[E] 已注册 fde-break-glass 工具', () => {
  assert(toolNames.includes('fde-break-glass'), `工具清单：${JSON.stringify(toolNames)}`)
})
await t('[E] 已注册 agent/session-start 提醒监听器（restrict 对账 + break-glass 提醒）', () => {
  assert(
    ctxO.count('agent/session-start') >= 2,
    `agent/session-start 监听器数应 ≥2（restrict + notify），实际 ${ctxO.count('agent/session-start')}`
  )
})
await t('[E] 已注册 tools/pre-execute 审计监听器', () => {
  assert(ctxO.count('tools/pre-execute') === 1, `实际 ${ctxO.count('tools/pre-execute')}`)
})
await t('[E] session-start 提醒监听器对无 agent 的载荷不抛（提醒绝不该让会话建立失败）', async () => {
  ctxO.fire('agent/session-start', {})
  ctxO.fire('agent/session-start', null)
  await settle()
})
await t('[F2] 对照组：环节 3 无 D1 结论 ⇒ fde_phase_advance 被拦', () => {
  const r = ctxO.guards[0]({ name: 'fde_phase_advance', arguments: { to: '4' } })
  assert(typeof r === 'string' && r.includes('D1'), `应当因 D1 被拦，实际 ${JSON.stringify(r)}`)
})
await t('[E] phase guard 对非推进工具一律放行', () => {
  assertEq(ctxO.guards[0]({ name: 'read', arguments: {} }), undefined)
})
ctxO.teardown()

// ---- [F] 预置 phase 链 ⇒ apply 后 guard 放行 D1 ----
const ontoF = mkOnto('f')
const chainF = mkChain('f')
seedChain(chainF, {
  id: 'evt_bg_seedF',
  denyId: 'D1',
  category: 'deny_defect',
  reason: '预置：模拟"上次进程砸的玻璃"',
  at: '2026-09-29T00:00:00.000Z',
  expiresAt: '2026-10-06T00:00:00.000Z',
  anchor: d1AnchorOf(ontoF)
})
const ctxF = applyPhase(chainF, mkProject('f'), ontoF)
const advance = { name: 'fde_phase_advance', arguments: { to: '4' } }

await t('[F1] 重启恢复：链上预置的 D1 break-glass 让 fde_phase_advance 真被放行', () => {
  assertEq(ctxF.guards[0](advance), undefined)
})
await t('[F1′] 锚点在 apply 后仍然生效：改了 actions.yaml ⇒ 恢复出来的放行立刻失效', () => {
  writeFileSync(join(ontoF, 'actions.yaml'), 'actions:\n  - id: 改了\n')
  const r = ctxF.guards[0](advance)
  assert(typeof r === 'string' && r.includes('D1'), `锚点失效应重新拦，实际 ${JSON.stringify(r)}`)
})
ctxF.teardown()

// ================================================================ 收尾
lines.push('')
await t('[INVERT 主动做反] 正常应为绿；设 FDE_INVERT=1 应转红以证明退出码敏感', () => {
  if (process.env.FDE_INVERT === '1') assert(false, 'injected by FDE_INVERT')
})

lines.push(`通过 ${passed} / 失败 ${failed}`)
lines.push(failed > 0 ? 'RESULT: FAIL' : 'RESULT: PASS')
writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(`[e1-wiring] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
