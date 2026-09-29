/**
 * 第二批 `restrict` 离线回归（施工单 §2.6）。
 *
 * 跑法：
 *   node _restrict_test.mjs
 *   故意验证退出码会变红： FDE_INVERT=1 node _restrict_test.mjs
 *
 * 结果**自己写文件**（`_restrict_test_out.txt`）—— 不走控制台（Windows 代码页乱码纪律）。
 *
 * 覆盖（施工单 §2.6 的五个用例 + 本轮自查补的边界）：
 *   - desiredDeny：受保护返回名单 / 非受保护返回 [] / 名单为空返回 [] / 未配返回 [] / 返回的是拷贝
 *   - 阶段切换：6 → 7 名单从 ['pwsh'] 变 []（驱动"该 dispose 了"）
 *   - parseUnknownNames：真实文案（单数 / 复数 / 尾部 known 段不得混入）/ 非点名错误返回 []
 *   - 点名失败不致命：部分 unknown ⇒ restrict-applied + skipped；全 unknown ⇒ restrict-degraded
 *   - 幂等：同一 agent 名单未变 ⇒ 不重复调 restrict()（这是本批最容易**静默退化**的一条）
 *   - 生命周期：离开受保护阶段 ⇒ 调用上一次的 disposer + 落 restrict-lifted
 *   - 异常：restrict 抛非点名错误 ⇒ restrict-error 且**不崩**、不假装 applied
 *   - config：默认值 = 方案 B；run_code 触发 fail-closed 拒配
 *
 * ⚠️ 假 agent 刻意让 `agent.ctx` **每次访问都返回新对象**（getter）—— 真 SDK 里
 * `agent.ctx` 经 cordis traceable 代理、每次属性访问都新建 Proxy（施工单 §4）。
 * 若实现里把 `agent.ctx.tools` 缓存进长期变量，这组测试会暴露它的陈旧代理问题。
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConfig, DEFAULTS } from '../dsh-fde-phase/lib/config.js'
import { desiredDeny, parseUnknownNames, RestrictGovernor } from '../dsh-fde-phase/lib/restrict.js'
import { serializeState } from '../dsh-fde-phase/lib/state.js'
import { AuditChain } from '../dsh-fde-phase/lib/audit.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_restrict_test_out.txt')
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
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? '断言失败')
}
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg ?? '值不等'}：实际 ${a}，期望 ${e}`)
}

// ---------------------------------------------------------------- 夹具
const CFG_B = {
  protectedPhases: ['4', '6', '10'],
  denyTools: ['pwsh']
}

/**
 * 带 `projectRoot` 的配置 —— Governor 构造时要拼 `<projectRoot>/memory/state.yaml`，
 * 缺了它 `join()` 会当场抛（生产里 `normalizeConfig` 已把 projectRoot 定为必填，这里补等价约束）。
 */
function cfgB(phase = '6') {
  return { ...CFG_B, projectRoot: mkProject(phase) }
}

/** 临时 projectRoot（含 memory/state.yaml）。 */
function mkProject(phase) {
  const dir = mkdtempSync(join(tmpdir(), 'fde-restrict-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(
    join(dir, 'memory', 'state.yaml'),
    serializeState({
      schema_version: 1,
      current_phase: phase,
      phase_status: 'in_progress',
      ontology_version: 1,
      revision: 1,
      updated_at: '2026-09-25T00:00:00.000Z'
    }),
    'utf8'
  )
  return dir
}

/**
 * 假 agent：`known` = 本部署实际存在的全局工具名。
 * 记录每一次 restrict 调用与每一次 dispose，供幂等断言使用。
 */
function fakeAgent(id, known = ['pwsh', 'read', 'edit']) {
  const calls = []
  const disposed = []
  const agent = {
    id,
    get ctx() {
      return {
        tools: {
          restrict(filter) {
            const deny = [...(filter.deny ?? [])]
            calls.push(deny)
            const unknown = deny.filter((n) => !known.includes(n))
            if (unknown.length > 0) {
              // 真 SDK 原文（dsh-tools/lib/index.js:2804），单数 / 复数两种形态
              throw new Error(
                `tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ` +
                  `${unknown.map((n) => `"${n}"`).join(', ')}; ` +
                  `known global tools: ${[...known].sort().join(', ') || '(none)'}`
              )
            }
            const d = () => disposed.push(deny)
            return d
          }
        }
      }
    },
    _calls: calls,
    _disposed: disposed
  }
  return agent
}

/**
 * 收集审计（可以事后看 decision 序列）。刻意与 AuditChain 的 record() 签名一致：
 * reconcile() 内部只调这一个方法。
 */
function fakeAudit() {
  const records = []
  return {
    records,
    async record(entry) {
      records.push(entry)
      return { seq: records.length, hash: 'h', persisted: false }
    }
  }
}

/** 真实 AuditChain（不落盘）—— 用于确认 record 形态与真链兼容。 */
function realAudit() {
  const chain = new AuditChain('')
  const seen = []
  return {
    seen,
    async record(entry) {
      seen.push(entry)
      return chain.record(entry)
    }
  }
}

function gov(cfg, audit) {
  return new RestrictGovernor({ cfg, audit })
}

// ================================================================ desiredDeny（纯函数）
lines.push('## desiredDeny（纯函数）')

t('受保护阶段 6 → 返回名单 ["pwsh"]', () => {
  assertEq(desiredDeny('6', CFG_B), ['pwsh'])
})
t('受保护阶段 4 / 10 同样适用（方案 B 三阶段齐）', () => {
  assertEq(desiredDeny('4', CFG_B), ['pwsh'])
  assertEq(desiredDeny('10', CFG_B), ['pwsh'])
})
t('非受保护阶段 7 / 8 / 9 / 11 → 返回 []', () => {
  for (const p of ['7', '8', '9', '11', '0.1', '3']) assertEq(desiredDeny(p, CFG_B), [], `阶段 ${p}`)
})
t('名单为空 ⇒ 一律 []（含受保护阶段）', () => {
  assertEq(desiredDeny('6', { protectedPhases: ['6'], denyTools: [] }), [])
})
t('未配 protectedPhases / denyTools ⇒ []（不得因为缺省而"全收"）', () => {
  assertEq(desiredDeny('6', {}), [])
})
t('返回的是**拷贝**：改返回值不得污染 config', () => {
  const cfg = { protectedPhases: ['6'], denyTools: ['pwsh'] }
  const got = desiredDeny('6', cfg)
  got.push('mischief')
  assertEq(cfg.denyTools, ['pwsh'], 'cfg 被返回值反向改写了')
})
t('阶段传 number / null / undefined 都不炸（兜住 callId 之外的脏输入）', () => {
  assertEq(desiredDeny(6, CFG_B), ['pwsh'])
  assertEq(desiredDeny(null, CFG_B), [])
  assertEq(desiredDeny(undefined, CFG_B), [])
})
t('阶段切换：6 → 7 名单从 ["pwsh"] 变 []（驱动"该 dispose 了"）', () => {
  assertEq(desiredDeny('6', CFG_B), ['pwsh'])
  assertEq(desiredDeny('7', CFG_B), [])
})

// ================================================================ parseUnknownNames
lines.push('## parseUnknownNames（真实错误文案）')

t('复数形态：解析出全部 unknown 名字', () => {
  const msg =
    'tools.restrict() names unknown global tools "bash", "x"; known global tools: pwsh, read'
  assertEq(parseUnknownNames(msg), ['bash', 'x'])
})
t('单数形态：仍能解析', () => {
  const msg = 'tools.restrict() names unknown global tool "bash"; known global tools: pwsh'
  assertEq(parseUnknownNames(msg), ['bash'])
})
t('🔴 known 段不得混入结果（否则会把存在的名字当成不存在 ⇒ 保护被削弱）', () => {
  const msg =
    'tools.restrict() names unknown global tool "bash"; known global tools: pwsh, read, edit'
  const got = parseUnknownNames(msg)
  assertEq(got, ['bash'])
  assert(!got.includes('pwsh'), '"pwsh" 出现在 known 段里，被误判成 unknown 了')
  assert(!got.includes('read'), '"read" 出现在 known 段里，被误判成 unknown 了')
})
t('known 为空（"(none)"）也不混入', () => {
  const msg = 'tools.restrict() names unknown global tools "bash", "ralph"; known global tools: (none)'
  assertEq(parseUnknownNames(msg), ['bash', 'ralph'])
})
t('非「点名失败」的错误 ⇒ 返回 []（不得把它当成 unknown 去重试）', () => {
  assertEq(parseUnknownNames('tools.restrict() requires a scoped context (agent.ctx): …'), [])
  assertEq(parseUnknownNames(new Error('boom')), [])
  assertEq(parseUnknownNames(''), [])
})

// ================================================================ Governor：点名失败不致命
lines.push('## Governor：点名失败不得静默')

ta('部分 unknown ⇒ 剩下的挂上 + decision=restrict-applied + skipped 如实记录', async () => {
  const agent = fakeAgent('a1', ['pwsh', 'read'])
  const audit = fakeAudit()
  const g = gov(cfgB(), audit)
  const r = await g.sync(agent, ['pwsh', 'bash'], '6')
  assertEq(r, 'applied')
  // 第一次全名单失败、第二次用 ['pwsh'] 重试 ⇒ 两次调用，最后登账的是生效的那个
  assertEq(agent._calls, [['pwsh', 'bash'], ['pwsh']], 'restrict 调用序列')
  const e = g.entryOf(agent)
  assertEq(e.applied, ['pwsh'], '实际生效名单')
  assertEq(e.desired, ['pwsh', 'bash'], '期望名单（幂等比较用期望，不是生效值）')
  const rec = audit.records.find((x) => x.decision === 'restrict-applied')
  assert(rec, '应有一条 restrict-applied 审计')
  assertEq(rec.skipped, ['bash'], 'skipped 必须是被跳过的名字')
  assertEq(rec.denied, ['pwsh'], 'denied 必须只含真正拦住的名字')
  assert(rec.note.includes('不拦'), `note 应写清"明确不拦"，实际：${rec.note}`)
})

ta('全名单 unknown ⇒ restrict-degraded（保护完全失效，比 applied 醒目一级）', async () => {
  const agent = fakeAgent('a2', ['read'])
  const audit = fakeAudit()
  const g = gov(cfgB(), audit)
  const r = await g.sync(agent, ['pwsh', 'bash'], '6')
  assertEq(r, 'degraded')
  const rec = audit.records.find((x) => x.decision === 'restrict-degraded')
  assert(rec, '应有一条 restrict-degraded 审计')
  assertEq(rec.denied, [], 'degraded 时 denied 必须为空（一个都没拦住）')
  assertEq(rec.skipped, ['pwsh', 'bash'])
  // 关键：绝不能出现 applied
  assert(
    !audit.records.some((x) => x.decision === 'restrict-applied'),
    '一个都没挂上却记了 restrict-applied —— 这是假装拦住了'
  )
})

ta('restrict 抛非点名错误 ⇒ restrict-error 且不崩、不假装 applied', async () => {
  const boom = {
    id: 'a3',
    get ctx() {
      return {
        tools: {
          restrict() {
            throw new Error('tools.restrict() requires a scoped context (agent.ctx)')
          }
        }
      }
    }
  }
  const audit = fakeAudit()
  const g = gov(cfgB(), audit)
  const r = await g.sync(boom, ['pwsh'], '6')
  assertEq(r, 'error')
  const rec = audit.records.find((x) => x.decision === 'restrict-error')
  assert(rec, '应有一条 restrict-error 审计')
  assert(rec.note.includes('scoped context'), `note 应带原始错误原因，实际：${rec.note}`)
  assertEq(rec.denied, [], '没挂上就不得记 denied')
})

// ================================================================ Governor：幂等（本批最容易静默退化的一条）
lines.push('## Governor：幂等')

ta('同一 agent 名单未变 ⇒ **不重复** restrict()（不叠层、不刷审计）', async () => {
  const agent = fakeAgent('idem', ['pwsh'])
  const audit = fakeAudit()
  const g = gov(cfgB(), audit)
  await g.sync(agent, ['pwsh'], '6')
  await g.sync(agent, ['pwsh'], '6')
  await g.sync(agent, ['pwsh'], '6')
  assertEq(agent._calls.length, 1, `restrict() 被调用了 ${agent._calls.length} 次（应为 1）`)
  assertEq(audit.records.filter((x) => x.decision === 'restrict-applied').length, 1, 'applied 审计应只有一条')
})

ta('🔴 幂等闸门用的是**期望名单**而不是生效名单（部分 unknown 时不得反复重挂）', async () => {
  // 反例意义：若拿 applied(['pwsh']) 做比较、而期望是 ['pwsh','bash']，
  // 每次 sync 都会判定"名单变了" ⇒ dispose + 重挂 + 刷一条 skipped 审计，直到把审计淹没。
  const agent = fakeAgent('idem2', ['pwsh'])
  const audit = fakeAudit()
  const g = gov(cfgB(), audit)
  await g.sync(agent, ['pwsh', 'bash'], '6')
  await g.sync(agent, ['pwsh', 'bash'], '6')
  // 首次：全名单失败 + 剩下的重试 = 2 次调用；第二次 sync 应完全不动
  assertEq(agent._calls.length, 2, `第二次 sync 应一个字节都不动，实际调用了 ${agent._calls.length} 次`)
})

ta('名单真的变了 ⇒ 先 dispose 旧的再挂新的（filter 是交集，不 dispose 只会越叠越窄）', async () => {
  const agent = fakeAgent('chg', ['pwsh', 'read'])
  const audit = fakeAudit()
  const g = gov(cfgB(), audit)
  await g.sync(agent, ['pwsh'], '6')
  await g.sync(agent, ['read'], '6')
  assertEq(agent._disposed, [['pwsh']], '必须先 dispose 掉上一次那条 restriction')
  assertEq(agent._calls, [['pwsh'], ['read']])
})

// ================================================================ Governor：生命周期
lines.push('## Governor：生命周期（进入 / 离开受保护阶段）')

ta('离开受保护阶段 ⇒ 调上一次的 disposer + 落 restrict-lifted', async () => {
  const agent = fakeAgent('lift', ['pwsh'])
  const audit = fakeAudit()
  const g = gov(cfgB(), audit)
  await g.sync(agent, ['pwsh'], '6')
  const r = await g.sync(agent, [], '7')
  assertEq(r, 'lifted')
  assertEq(agent._disposed, [['pwsh']], '必须调用 disposer，否则工具永远回不来')
  const rec = audit.records.find((x) => x.decision === 'restrict-lifted')
  assert(rec, '应有一条 restrict-lifted 审计')
})

ta('从未挂过限制的 agent 遇到非受保护阶段 ⇒ 不记 lifted（避免审计噪声）', async () => {
  const agent = fakeAgent('fresh', ['pwsh'])
  const audit = fakeAudit()
  const g = gov(cfgB(), audit)
  const r = await g.sync(agent, [], '7')
  assertEq(r, 'unchanged')
  assertEq(audit.records.length, 0, `不该留任何审计，实际 ${JSON.stringify(audit.records)}`)
})

ta('untrack(agent) 后该 agent 退出台账（disposed 事件语义）', async () => {
  const agent = fakeAgent('gone', ['pwsh'])
  const g = gov(cfgB(), fakeAudit())
  await g.sync(agent, ['pwsh'], '6')
  assertEq(g.size, 1)
  g.untrack(agent)
  assertEq(g.size, 0)
})

// ================================================================ Governor：全量对账（reconcile）
lines.push('## Governor：reconcile（阶段是全局的，限制是每 agent 的）')

ta('reconcile 从 state.yaml 读阶段并对**所有** agent 生效（判据 5 的离线形态）', async () => {
  const root = mkProject('6')
  const cfg = { projectRoot: root, ...CFG_B }
  // 刻意用**真 AuditChain**（`：738` 会真正跑链 hash/seq），确认 record 形态兼容
  const audit = realAudit()
  const g = gov(cfg, audit)
  const a = fakeAgent('A', ['pwsh'])
  const b = fakeAgent('B', ['pwsh'])
  // 模拟"插件装载之前就存在的会话"：它们已进 list()，从没走过 sync / session-start
  g.bind({ agents: { list: () => [a, b] } })
  const tally = await g.reconcile()
  assertEq(tally.phase, '6')
  assertEq(tally.agents, 2, '候选集合必须含尚未 track 过的 agent')
  assertEq(a._calls, [['pwsh']], 'A 应被覆盖')
  assertEq(b._calls, [['pwsh']], 'B 应被覆盖')
  assert(auditRecordsOf(audit).every((r) => r.type === 'restrict'), '审计必须都带 type:restrict')
})

ta('reconcile 单个 agent 抛错 ⇒ 吞掉并跳过，其余照挂（一个坏 agent 不得让保护全崩）', async () => {
  const root = mkProject('6')
  const cfg = { projectRoot: root, ...CFG_B }
  const audit = fakeAudit()
  const g = gov(cfg, audit)
  const good = fakeAgent('good', ['pwsh'])
  const bad = {
    id: 'bad',
    get ctx() {
      throw new Error('agent 正在被销毁')
    }
  }
  g.bind({ agents: { list: () => [bad, good] } })
  await g.reconcile()
  assertEq(good._calls, [['pwsh']], '好 agent 必须照样被限制')
  const rec = auditRecordsOf(audit).find((r) => r.decision === 'restrict-error')
  assert(rec, '坏 agent 必须留一条 restrict-error（不得静默吞掉）')
  assertEq(rec.agent, 'bad')
})

ta('state.yaml 读不到 ⇒ restrict-undetermined，**不变更任何限制**（既不挂也不摘）', async () => {
  const cfg = { projectRoot: join(tmpdir(), 'definitely-not-exists-fde'), ...CFG_B }
  const audit = fakeAudit()
  const g = gov(cfg, audit)
  const agent = fakeAgent('u', ['pwsh'])
  g.bind({ agents: { list: () => [agent] } })
  const tally = await g.reconcile()
  assertEq(tally.phase, null)
  assertEq(agent._calls, [], '阶段不可知时不该凭空挂限制')
  const rec = auditRecordsOf(audit).find((r) => r.decision === 'restrict-undetermined')
  assert(rec, '必须醒目标注"本次没算"')
})

// ================================================================ config
lines.push('## config：默认值 = 方案 B + run_code fail-closed')

t('默认值就是方案 B（受保护 4/6/10、名单 pwsh）', () => {
  assertEq(DEFAULTS.protectedPhases, ['4', '6', '10'])
  assertEq(DEFAULTS.denyTools, ['pwsh'])
})
t('normalizeConfig 未传这两项 ⇒ 得到默认值（而不是空数组 ⇒ 保护静默失效）', () => {
  // gateAuditPath 是 Stage 5.5 起的新必填项（D2 用），不影响本套件的 restrict 语义。
  const cfg = normalizeConfig({ projectRoot: '/x', ontologyRoot: '/y', gateAuditPath: '/g' })
  assertEq(cfg.protectedPhases, ['4', '6', '10'])
  assertEq(cfg.denyTools, ['pwsh'])
})
t('🔴 denyTools 含 run_code ⇒ 配置层抛错（点名必抛且无法跳过 ⇒ 只能 fail-closed）', () => {
  let err = null
  try {
    normalizeConfig({ projectRoot: '/x', ontologyRoot: '/y', gateAuditPath: '/g', denyTools: ['pwsh', 'run_code'] })
  } catch (e) {
    err = e
  }
  assert(err, '必须抛错')
  assert(err.message.includes('run_code'), `错误信息应点名 run_code，实际：${err.message}`)
  assert(err.message.includes('保留名'), `错误信息应说明原因，实际：${err.message}`)
})
t('protectedPhases / denyTools 元素不得为空串或非字符串', () => {
  for (const bad of [['', 'pwsh'], ['pwsh', ''], [123], 'not-an-array']) {
    let err = null
    try {
      normalizeConfig({ projectRoot: '/x', ontologyRoot: '/y', gateAuditPath: '/g', denyTools: bad })
    } catch (e) {
      err = e
    }
    assert(err, `denyTools=${JSON.stringify(bad)} 应被拒`)
  }
})
t('normalizeConfig 返回的是拷贝：改返回值不得影响 DEFAULTS', () => {
  const cfg = normalizeConfig({ projectRoot: '/x', ontologyRoot: '/y', gateAuditPath: '/g' })
  cfg.denyTools.push('mischief')
  assertEq(DEFAULTS.denyTools, ['pwsh'], 'DEFAULTS 被反向污染了')
})

// ================================================================ trigger（第三批）
lines.push('## trigger：每条 restrict 记录必须能归因到「谁触发的」')

/** 为什么要有这条产品线（0039 §2.1）：审计只记"发生了什么"，不记"为什么会走到这里"。
 * `reconcile()` 有两个调用者（装载时全量对账 / 推进成功后），`sync()` 有两个调用者
 * （session-start / reconcile）⇒ `trigger` 必须**沿调用链传**，不能在落盘点猜。
 */
ta('🔴 reconcile(to, trigger) ⇒ 链上**每条**记录 trigger === 调用方传进来的那个（缺 trigger 条数 == 0）', async () => {
  const cfg = { projectRoot: mkProject('6'), ...CFG_B }
  const audit = fakeAudit()
  const g = gov(cfg, audit)
  const a = fakeAgent('A', ['pwsh'])
  g.bind({ agents: { list: () => [a] } })
  await g.reconcile(undefined, 'phase-changed')
  const recs = auditRecordsOf(audit)
  assert(recs.length > 0, '用例前提：这条 reconcile 至少写了一条记录')
  const missing = recs.filter((r) => r.trigger === undefined)
  assertEq(missing.length, 0, `缺 trigger 的记录 = ${JSON.stringify(missing)}`)
  const wrong = recs.filter((r) => r.trigger !== 'phase-changed')
  assertEq(wrong.map((r) => [r.decision, r.trigger]), [], 'trigger 必须等于传入值')
})

ta('🔴 sync 的两个调用入口写出**不同** trigger（专治"在 sync 里写死一个值"）', async () => {
  const cfg = { projectRoot: mkProject('6'), ...CFG_B }
  const audit = fakeAudit()
  const g = gov(cfg, audit)
  const a = fakeAgent('A', ['pwsh'])
  const b = fakeAgent('B', ['pwsh'])
  // 入口①：session-start（直接用第 5 参，等价于 installRestrict:792 那条语句）
  await g.sync(a, ['pwsh'], '6', undefined, 'session-start')
  // 入口②：reconcile（A 刚才已处理过 ⇒ 幂等闸门拦掉，B 是新面孔 ⇒ 只有它会写本次记录）
  g.bind({ agents: { list: () => [a, b] } })
  await g.reconcile(undefined, 'phase-changed')
  const recs = auditRecordsOf(audit).filter((r) => r.decision === 'restrict-applied')
  assertEq(recs.filter((r) => r.agent === 'A').map((r) => r.trigger), ['session-start'], 'A 走 session-start')
  assertEq(recs.filter((r) => r.agent === 'B').map((r) => r.trigger), ['phase-changed'], 'B 走 phase-changed')
})

ta('🔴 untrack 走 agent/disposed ⇒ trigger 随入口，且**不得靠默认值伪造来源**', async () => {
  const cfg = { projectRoot: mkProject('6'), ...CFG_B }
  const audit = fakeAudit()
  const g = gov(cfg, audit)
  const a = fakeAgent('gone', ['pwsh'])
  await g.sync(a, ['pwsh'], '6', undefined, 'session-start')
  await g.untrack(a, 'agent-disposed')
  const rec = auditRecordsOf(audit).find((r) => r.decision === 'restrict-untracked')
  assert(rec, '必须有 untracked 记录')
  assertEq(rec.trigger, 'agent-disposed')
})

ta('🔴 trigger 值集在**代码侧**有单一定义（判据脚本不得各写一版）', async () => {
  // 动态 import：故意的 —— 若静态 import 一个尚不存在的导出，整个文件会在链接期就炸，
  // 那样"改前红"看起来像崩溃而不是红条，读的人分不清是缺功能还是环境坏了。
  const R = await import('../dsh-fde-phase/lib/restrict.js')
  assert(R.RESTRICT_TRIGGERS, 'restrict.js 未导出 RESTRICT_TRIGGERS')
  assertEq(
    [...R.RESTRICT_TRIGGERS].sort(),
    ['agent-disposed', 'full-reconcile', 'phase-changed', 'session-start'],
    '四值集合（缺任何一个 ⇒ 9 个落盘点里会有一批记录无处归因）'
  )
})

// ================================================================ 吞错点留痕
lines.push('## 吞错点：从此刻起，`catch` 必须留下 `restrict-degraded` + `via`')

ta('🔴 noteDegraded(via, error, trigger) ⇒ 落 restrict-degraded，错原文留在链上', async () => {
  const audit = fakeAudit()
  const g = gov(cfgB(), audit)
  await g.noteDegraded('inject-reconcile', new Error('boom-inject'), 'full-reconcile')
  const rec = auditRecordsOf(audit).find((r) => r.decision === 'restrict-degraded')
  assert(rec, '吞掉的错必须有地方可查')
  assertEq(rec.via, 'inject-reconcile', '判别靠**字段**，不靠读 note 里的自然语言')
  assertEq(rec.trigger, 'full-reconcile')
  assert(String(rec.note).includes('boom-inject'), '错误原文要留给读者')
})

ta('🔴 noteDegraded 永不抛（最后一道防线自身不得成为新的崩溃源）', async () => {
  const g = gov(cfgB(), {
    async record() {
      throw new Error('disk on fire')
    }
  })
  await g.noteDegraded('inject-failed', new Error('x'), 'full-reconcile')
  await g.noteDegraded('advance-reconcile', '字符串形态的错', 'phase-changed')
})

ta('⚠️ 反例（非新功能，恒绿）：**全名单点不上** ⇒ 正常路径也会出现 restrict-degraded', async () => {
  // ⇒ 0039 §2.4 的反向判据「正常路径不得出现 restrict-degraded」按 **decision** 计数是**超域**的：
  // 这条恰好是无异常情况下的 degraded。真正的判据必须按 `via ∈ VIA_SWALLOWED` 来判。
  const cfg = { projectRoot: mkProject('6'), protectedPhases: ['6'], denyTools: ['bash'] }
  const audit = fakeAudit()
  const g = gov(cfg, audit)
  const a = fakeAgent('C', ['pwsh']) // known 里没有 bash ⇒ 一个都点不上
  await g.sync(a, ['bash'], '6', undefined, 'full-reconcile')
  const rec = auditRecordsOf(audit).find((r) => r.decision === 'restrict-degraded')
  assert(rec, '保护完全失效 ⇒ 必须落 degraded')
  assert(rec.via === undefined, '这条不是吞错 ⇒ 没有 via（正是它让 decision 计数不可用作反向判据）')
})

ta('🔴 正常路径（配置正常、无异常）⇒ 一条 swallowed-via 都没有', async () => {
  const cfg = { projectRoot: mkProject('6'), ...CFG_B }
  const audit = fakeAudit()
  const g = gov(cfg, audit)
  const a = fakeAgent('D', ['pwsh'])
  g.bind({ agents: { list: () => [a] } })
  await g.reconcile(undefined, 'full-reconcile')
  const VIA_SWALLOWED = new Set(['inject-reconcile', 'inject-failed', 'advance-reconcile'])
  const bad = auditRecordsOf(audit).filter((r) => VIA_SWALLOWED.has(r.via))
  assertEq(bad.map((r) => [r.decision, r.via]), [], '吞错留痕只该出现在真出错时')
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

console.log(`[restrict-test] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0

// ---------------------------------------------------------------- 本地小工具
function auditRecordsOf(a) {
  return a.records ?? a.seen ?? []
}
