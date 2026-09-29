/**
 * P1 回归 —— 「state.yaml 读不出来时，**已挂的限制不得被静默摘掉**」（fail-open → fail-safe）。
 *
 * ### 为什么单独一个文件
 *
 * 施工单 §3 明确要求"回调用例必须**新开**"：现有 `_restrict_test.mjs` 只有
 * 「文件不存在」那一条（`projectRoot: join(tmpdir(), 'definitely-not-exists-fde')`），
 * 而它恰恰被 `existsSync` 先短路成了 null ⇒ fail-safe 如期生效、用例变绿。
 * **缺口正好落在没测的那条上**（"文件存在但内容不可解析"）。在这里补齐另一半。
 *
 * ### 🔴 断言的核心不是 `phase === null`，而是「**保护还在**」
 *
 * 只断 `currentPhase() === null` 是不够的：它只能证明"这一刻没算出来"，
 * 证明不了"上一刻挂上的限制没被顺手摘掉"。所以每条都同时断三件事：
 *   ① 没有新的 `restrict()` 调用（台账没被重算）
 *   ② 没有 dispose（上一次那层 restriction 没被摘）
 *   ③ 台账 `applied` 仍是 `['pwsh']`，且审计里**没有** `restrict-lifted`
 *
 * ### 反向验证（防止"C 恒绿"）
 *
 * 末尾有一条**对照组**：同一个 governor、同一个 agent，把阶段**正常**推进到 7（非受保护）⇒
 * 此时**必须** dispose + 落 `restrict-lifted`。若这条也绿而上面几条也在该失败时失败，
 * 才说明"不摘"这组断言不是因为夹具写错而恒真。
 *
 * 跑法：
 *   node _restrict_strictstate_test.mjs            → 期望 exit 0
 *   FDE_INVERT=1 node _restrict_strictstate_test.mjs → 期望 exit 1
 * 结果写 `_restrict_strictstate_out.txt`。
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RestrictGovernor } from '../dsh-fde-phase/lib/restrict.js'
import { readStateStrictSync, serializeState } from '../dsh-fde-phase/lib/state.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_restrict_strictstate_out.txt')
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
const CFG_B = { protectedPhases: ['4', '6', '10'], denyTools: ['pwsh'] }

/** 建一个带 state.yaml 的临时 projectRoot。 */
function mkProject(text) {
  const dir = mkdtempSync(join(tmpdir(), 'fde-strict-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  const p = join(dir, 'memory', 'state.yaml')
  writeFileSync(
    p,
    text ??
      serializeState({
        schema_version: 1,
        current_phase: '6',
        phase_status: 'in_progress',
        ontology_version: 1,
        revision: 1,
        updated_at: '2026-09-25T00:00:00.000Z'
      }),
    'utf8'
  )
  return { dir, p }
}

function statePathOf(dir) {
  return join(dir, 'memory', 'state.yaml')
}

function cfgAt(dir) {
  return { projectRoot: dir, ...CFG_B }
}

function gov(cfg, audit) {
  return new RestrictGovernor({ cfg, audit })
}

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
              throw new Error(
                `tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ` +
                  `${unknown.map((n) => `"${n}"`).join(', ')}; ` +
                  `known global tools: ${[...known].sort().join(', ') || '(none)'}`
              )
            }
            return () => disposed.push(deny)
          }
        }
      }
    },
    _calls: calls,
    _disposed: disposed
  }
  return agent
}

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

const CORRUPT = 'this is not yaml at all {{\n\tcurrent_phase: [unclosed\n'
const NO_PHASE = 'schema_version: 1\nphase_status: in_progress\nrevision: 3\n'
const EMPTY_PHASE = 'schema_version: 1\ncurrent_phase: ""\nrevision: 3\n'

// ================================================================ ① readStateStrictSync：拒绝回落
lines.push('## readStateStrictSync：拒绝回落到 DEFAULT_STATE')

t('正常文件 ⇒ 读到对象且 current_phase 为 "6"', () => {
  const { p } = mkProject()
  const s = readStateStrictSync(p)
  assert(s !== null, '正常文件不该返回 null')
  assertEq(s.current_phase, '6')
})

t('文件不存在 ⇒ null（不是 DEFAULT_STATE）', () => {
  const q = join(tmpdir(), 'definitely-not-exists-fde', 'memory', 'state.yaml')
  assertEq(readStateStrictSync(q), null)
})

t('🔴 文件存在但内容不可解析 ⇒ null（**不是**回落的 DEFAULT_STATE）', () => {
  const { p } = mkProject(CORRUPT)
  assertEq(readStateStrictSync(p), null, '内容坏时必须返回 null，不能假装有读到状态')
})

t('🔴 合法但不含 current_phase ⇒ 不得凭空补出 current_phase', () => {
  const { p } = mkProject(NO_PHASE)
  const s = readStateStrictSync(p)
  assert(
    s === null || s.current_phase === undefined,
    `不得补出默认值，实际 current_phase=${JSON.stringify(s?.current_phase)}`
  )
})

t('空文件 ⇒ null', () => {
  const { p } = mkProject('')
  assertEq(readStateStrictSync(p), null)
})

// ================================================================ ② Governor.currentPhase()
lines.push('## Governor.currentPhase()：读不到阶段 ⇒ null（不是默认阶段）')

function phaseOf(text) {
  const { dir } = mkProject(text)
  return gov(cfgAt(dir), fakeAudit()).currentPhase()
}

t('基线：正常 state.yaml ⇒ "6"（别为了修 fail-open 把正常路径也弄成不可知）', () => {
  assertEq(phaseOf(null), '6')
})
t('文件不存在 ⇒ null', () => {
  const g = gov(cfgAt(join(tmpdir(), 'definitely-not-exists-fde')), fakeAudit())
  assertEq(g.currentPhase(), null)
})
t('🔴 内容不可解析 ⇒ null', () => {
  assertEq(phaseOf(CORRUPT), null, `实际=${JSON.stringify(phaseOf(CORRUPT))}`)
})
t('🔴 合法但缺 current_phase ⇒ null', () => {
  assertEq(phaseOf(NO_PHASE), null, `实际=${JSON.stringify(phaseOf(NO_PHASE))}`)
})
t('🔴 current_phase 为空串 ⇒ null', () => {
  assertEq(phaseOf(EMPTY_PHASE), null, `实际=${JSON.stringify(phaseOf(EMPTY_PHASE))}`)
})

// ================================================================ ③ 核心：已挂的限制不得被摘
lines.push('## 核心：阶段不可知 ⇒ **已挂的限制一个都不许摘**')

/**
 * 先把 pwsh 挂上（有 restrict-applied 留痕），再把 state 文件改成某种"坏"样子，
 * 然后 reconcile —— 断言**什么都没发生**：不重算、不 dispose、台账不变、不记 lifted。
 */
async function keepScenario(text) {
  const { dir } = mkProject(null) // 起手是正常 phase 6
  const audit = fakeAudit()
  const g = gov(cfgAt(dir), audit)
  const agent = fakeAgent('keep', ['pwsh'])
  g.bind({ agents: { list: () => [agent] } })

  // 起手确有保护（这一步同时是"这次真的挂上了"的前提证据）
  const first = await g.sync(agent, ['pwsh'], '6')
  if (first !== 'applied') throw new Error(`前置失败：首次 sync 应为 applied，实际 ${first}`)

  const callsBefore = agent._calls.length
  const dispBefore = agent._disposed.length
  const appliedBefore = g.entryOf(agent).applied

  if (text === null) {
    // 模拟"文件不存在"
    const { rmSync } = await import('node:fs')
    rmSync(statePathOf(dir), { force: true })
  } else {
    writeFileSync(statePathOf(dir), text, 'utf8')
  }

  const tally = await g.reconcile()
  return { tally, agent, audit, g, callsBefore, dispBefore, appliedBefore }
}

function assertProtectionKept(ctxa, label) {
  const { tally, agent, audit, g, callsBefore, dispBefore, appliedBefore } = ctxa
  assertEq(tally.phase, null, `${label}：reconcile 应判「阶段不可知」`)
  assertEq(
    agent._calls.length,
    callsBefore,
    `${label}：阶段不可知时不得发起新的 restrict() 调用（说明没走"重算成空名单"那条）`
  )
  assertEq(agent._disposed.length, dispBefore, `${label}：🔴 不得 dispose —— 已挂的限制被摘掉了`)
  assertEq(
    g.entryOf(agent).applied,
    appliedBefore,
    `${label}：台账必须仍记着已生效的名单（保护还在）`
  )
  assertEq(g.entryOf(agent).applied, ['pwsh'], `${label}：生效名单应仍是 ["pwsh"]`)
  assert(
    !audit.records.some((r) => r.decision === 'restrict-lifted'),
    `${label}：出现 restrict-lifted —— 保护在没人批准的情况下被解除了`
  )
  assert(
    audit.records.some((r) => r.decision === 'restrict-undetermined'),
    `${label}：必须落 restrict-undetermined（明确告知"本次没算"，而不是静默放过）`
  )
}

ta('🔴 内容不可解析 ⇒ 保护保留 + restrict-undetermined', async () => {
  assertProtectionKept(await keepScenario(CORRUPT), '内容坏')
})

ta('🔴 合法但缺 current_phase ⇒ 保护保留 + restrict-undetermined', async () => {
  assertProtectionKept(await keepScenario(NO_PHASE), '缺 current_phase')
})

ta('🔴 current_phase 为空串 ⇒ 保护保留 + restrict-undetermined', async () => {
  assertProtectionKept(await keepScenario(EMPTY_PHASE), '空 phase')
})

ta('对照：文件不存在 ⇒ 保护同样保留（现有用例覆盖的那条，形态补齐）', async () => {
  assertProtectionKept(await keepScenario(null), '文件不存在')
})

// ---------------------------------------------------------------- 反向验证
ta('🔁 反 Assert：同一夹具下**正常**推进到非受保护阶段 ⇒ 必须真的摘掉限制', async () => {
  // 这条存在的意义：证明上面四条"不摘"不是因为夹具写错而恒真 ——
  // 同一个 governor、同一个 agent，只要阶段**确实**是合法的 7，限制就必须被 dispose + 记 lifted。
  const { dir } = mkProject(null)
  const audit = fakeAudit()
  const g = gov(cfgAt(dir), audit)
  const agent = fakeAgent('ctl', ['pwsh'])
  g.bind({ agents: { list: () => [agent] } })

  await g.sync(agent, ['pwsh'], '6')

  writeFileSync(
    statePathOf(dir),
    serializeState({
      schema_version: 1,
      current_phase: '7',
      phase_status: 'in_progress',
      ontology_version: 1,
      revision: 2,
      updated_at: '2026-09-25T00:00:00.000Z'
    }),
    'utf8'
  )

  const tally = await g.reconcile()
  assertEq(tally.phase, '7')
  assertEq(agent._disposed, [['pwsh']], '合法离开受保护阶段时必须 dispose')
  assertEq(g.entryOf(agent).applied, [], '台账必须清空')
  assert(
    audit.records.some((r) => r.decision === 'restrict-lifted'),
    '合法离开受保护阶段必须落 restrict-lifted'
  )
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

console.log(`[restrict-strictstate] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
