/**
 * 第四批 `restrict` 审计补丁离线回归 —— `restored` / `replaced` / `untracked` / `history-miss` + 夹具。
 *
 * 跑法：
 *   node _restrict_index_test.mjs              → 期望 exit 0
 *   FDE_INVERT=1 node _restrict_index_test.mjs → 期望 exit 1
 * 结果**自己写文件**（`_restrict_index_out.txt`）—— 不走控制台（Windows 代码页乱码纪律）。
 *
 * ### 这一批修的是什么静默点
 *
 * 链上出现**连续两条** `restrict-applied` 而中间没有 `lifted` 时（实测 `#15/#16`、`#35/#36`），
 * 读者无法判断"第二条是叠加了一层（越叠越窄）"还是"重启/对象重建后的接续"。本批把它变成
 * 可判别：`prev` 缺失时查该 agent **最近一条** restrict 决策，据规则表落 `restored` 并带 `from`。
 *
 * ### 🔴 规则表（0001 §2.1，判据必须收紧到「最近一条」，不能是「存在任意 applied」）
 *
 * | 最近一条 D | 落什么 |
 * |---|---|
 * | `applied` 且名单相同 | `restored` + `from` |
 * | `untracked` | `restored` + `from` |
 * | `lifted` / `replaced` / `degraded` / `error` / 无记录 | `applied`（真重新挂载 / 首次） |
 *
 * `replaced` 走**方案 A**：只有"前后名单都非空且不同"才算替换（`[] → ['pwsh']` 仍是 `applied`，
 * 否则会削弱 `restrict-applied` 这个既有检索键）。
 *
 * ### 覆盖
 *
 * - restored 七种输入（applied 同名 / applied 异名 / lifted / untracked / degraded / error / 无记录）
 * - restored 仍真的挂上限制（不是只写审计）
 * - replaced 方案 A 三态（非空→非空不同 / 空→非空 / 非空→空）
 * - untracked：异步落审计 / 门（没挂过不落）/ 台账同步删除
 * - history-miss：>64KiB 长链截断 ⇒ 每条 reconcile 最多一条聚合记录；短链未截断 ⇒ 不落
 * - 长链截断下 restored 退化为 `applied`（fail-safe：绝不因查不到历史就不挂限制）
 * - `from` 恒指「该 agent 最后一条 applied 的 seq」：restored 不链式 / 截断 ⇒ null / untracked 同口径
 * - 索引增量（`record()` 后同实例立即可见）+ duck typing（audit 没有该方法 ⇒ 退化不崩）
 * - 夹具 sha256 断言（禁止直接读活链）
 *
 * ⚠️ 假 agent 与 `_restrict_test.mjs` 同款：`agent.ctx` 每次访问返回新对象（真 SDK 的 traceable 代理行为）。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RestrictGovernor } from './dsh-fde-phase/lib/restrict.js'
import { AuditChain, GENESIS } from './dsh-fde-phase/lib/audit.js'

// 刻意**不从 audit.js 导入** TAIL_BYTES：本批要给它加导出，若这里 import 它，
// 改前跑出来会是"整个文件 import 失败"，那就不是"改前红"而是"根本没跑"。
const TAIL_BYTES = 65536
import { serializeState } from './dsh-fde-phase/lib/state.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '_restrict_index_out.txt')
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
const CFG_B = { protectedPhases: ['4', '6', '10'], denyTools: ['pwsh'] }

function mkProject(phase) {
  const dir = mkdtempSync(join(tmpdir(), 'fde-restrict-idx-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(
    join(dir, 'memory', 'state.yaml'),
    serializeState({
      schema_version: 1,
      current_phase: phase,
      phase_status: 'in_progress',
      ontology_version: 1,
      revision: 1,
      updated_at: '2026-09-26T00:00:00.000Z'
    }),
    'utf8'
  )
  return dir
}

function cfgB(phase = '6') {
  return { ...CFG_B, projectRoot: mkProject(phase) }
}

/** 假 agent：`known` = 本部署存在的全局工具名。 */
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
            const d = () => disposed.push(deny)
            return d
          }
        }
      }
    },
    // 自测钩子
    _calls: calls,
    _disposed: disposed
  }
  return agent
}

/**
 * 假审计：可注入「该 agent 最近一条 restrict 决策」。
 * `tailTruncated` 默认 false（= 窗口覆盖全链）。
 */
function fakeAudit(history = {}, opts = {}) {
  const recs = []
  return {
    records: recs,
    tailTruncated: opts.tailTruncated === true,
    async record(entry) {
      recs.push({ seq: recs.length + 1, ...entry })
      return { seq: recs.length, hash: 'fake', persisted: opts.persisted === true }
    },
    latestRestrictByAgent() {
      return new Map(Object.entries(history))
    },
    of(decision) {
      return recs.filter((r) => r.decision === decision)
    },
    last() {
      return recs[recs.length - 1]
    }
  }
}

// ================================================================ 1. restored 规则表
lines.push('## 1. restored：`prev` 缺失时按「最近一条」决策判定')

ta('最近一条 = applied 同名单 ⇒ `restored` + from（这正是 #36 的形态）', async () => {
  const audit = fakeAudit({ 'session-x': { seq: 35, decision: 'restrict-applied', denied: ['pwsh'] } })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  const a = fakeAgent('session-x')
  const r = await g.sync(a, ['pwsh'], '6', audit.latestRestrictByAgent())
  assertEq(r, 'applied', '返回值不变（restored 是审计 decision，不是返回码，避免打破既有断言）')
  const last = audit.last()
  assertEq(last.decision, 'restrict-restored', '应记 restored')
  assertEq(last.from, 35, 'from 应指向被接续那条的 seq')
  assertEq(a._calls.length, 1, 'restored 也必须真的挂上限制（不能只写审计）')
  assertEq(a._calls[0], ['pwsh'])
})

ta('最近一条 = applied 但**名单不同** ⇒ 仍是 `applied`（不是接续）', async () => {
  const audit = fakeAudit({ 'session-x': { seq: 35, decision: 'restrict-applied', denied: ['bash'] } })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  const r = await g.sync(fakeAgent('session-x'), ['pwsh'], '6', audit.latestRestrictByAgent())
  assertEq(r, 'applied')
  assertEq(audit.last().decision, 'restrict-applied')
})

ta('最近一条 = untracked ⇒ `restored`（台账曾终结、旧层已随 fiber 撤销）', async () => {
  // ⚠️ 0005 §1.3 改口径后：from 指「最后一条 applied」，不再是 untracked 自己的 seq。
  // 这里索引条目**没有** appliedSeq ⇒ 源头不可考 ⇒ from 为 null（不编造）。
  const audit = fakeAudit({ 'session-x': { seq: 12, decision: 'restrict-untracked' } })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  await g.sync(fakeAgent('session-x'), ['pwsh'], '6', audit.latestRestrictByAgent())
  const last = audit.last()
  assertEq(last.decision, 'restrict-restored')
  assertEq(last.from, null, 'from 恒指 applied；此处 appliedSeq 缺失 ⇒ null，不得拿 untracked 的 seq=12 顶替')
})

// ↓ 以下四条是**反向验证**：改前就该是绿的，用来证明上面那组断言不是恒真（C 恒绿防护）
ta('[反向] 最近一条 = lifted ⇒ 必须 `applied`，不得误记 restored（这正是 #35）', async () => {
  const audit = fakeAudit({ 'session-x': { seq: 31, decision: 'restrict-lifted' } })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  await g.sync(fakeAgent('session-x'), ['pwsh'], '6', audit.latestRestrictByAgent())
  assertEq(audit.last().decision, 'restrict-applied')
})
ta('[反向] 最近一条 = degraded ⇒ applied', async () => {
  const audit = fakeAudit({ 'session-x': { seq: 7, decision: 'restrict-degraded' } })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  await g.sync(fakeAgent('session-x'), ['pwsh'], '6', audit.latestRestrictByAgent())
  assertEq(audit.last().decision, 'restrict-applied')
})
ta('[反向] 最近一条 = error ⇒ applied', async () => {
  const audit = fakeAudit({ 'session-x': { seq: 8, decision: 'restrict-error' } })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  await g.sync(fakeAgent('session-x'), ['pwsh'], '6', audit.latestRestrictByAgent())
  assertEq(audit.last().decision, 'restrict-applied')
})
ta('[反向] 无历史 ⇒ applied（首次挂载）', async () => {
  const audit = fakeAudit({})
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  await g.sync(fakeAgent('session-x'), ['pwsh'], '6', audit.latestRestrictByAgent())
  assertEq(audit.last().decision, 'restrict-applied')
})
ta('[反向] prev 已存在 ⇒ 不查历史、直接走幂等闸门（不得把重算记成 restored）', async () => {
  const audit = fakeAudit({ 'session-x': { seq: 35, decision: 'restrict-applied', denied: ['pwsh'] } })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  const a = fakeAgent('session-x')
  await g.sync(a, ['pwsh'], '6', audit.latestRestrictByAgent())
  await g.sync(a, ['pwsh'], '6', audit.latestRestrictByAgent())
  assertEq(audit.records.length, 1, '第二次必须一个字节都不动（含不写审计）')
  assertEq(a._calls.length, 1)
})

// ================================================================ 2. replaced（方案 A）
lines.push('## 2. replaced：方案 A（前后名单都非空且不同才算替换）')

ta('`[\'pwsh\'] → [\'pwsh\',\'bash\']` ⇒ `replaced` + from/to', async () => {
  const audit = fakeAudit({})
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  const a = fakeAgent('session-y', ['pwsh', 'bash'])
  await g.sync(a, ['pwsh'], '6', audit.latestRestrictByAgent())
  await g.sync(a, ['pwsh', 'bash'], '6', audit.latestRestrictByAgent())
  const last = audit.last()
  assertEq(last.decision, 'restrict-replaced')
  assertEq(last.from, ['pwsh'])
  assertEq(last.to, ['pwsh', 'bash'])
  assertEq(a._calls.length, 2, '换名单必须真的重挂一次')
})

ta('[反向] `[] → [\'pwsh\']`（离开受保护后再进入）⇒ 仍是 `applied`（方案 A 的取舍）', async () => {
  const audit = fakeAudit({})
  const g = new RestrictGovernor({ cfg: cfgB('7'), audit })
  const a = fakeAgent('session-y')
  await g.sync(a, [], '7', audit.latestRestrictByAgent()) // phase 7 ⇒ []
  await g.sync(a, ['pwsh'], '6', audit.latestRestrictByAgent())
  assertEq(audit.last().decision, 'restrict-applied')
})

ta('[反向] `[\'pwsh\'] → []` ⇒ 仍是 `lifted`', async () => {
  const audit = fakeAudit({})
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  const a = fakeAgent('session-y')
  await g.sync(a, ['pwsh'], '6', audit.latestRestrictByAgent())
  const r = await g.sync(a, [], '7', audit.latestRestrictByAgent())
  assertEq(r, 'lifted')
  assertEq(audit.last().decision, 'restrict-lifted')
})

// ================================================================ 3. untracked
lines.push('## 3. untracked：agent 销毁时留痕（此前是纯静默）')

ta('`untrack()` 落 `restrict-untracked`，带 agent id 与 from', async () => {
  const audit = fakeAudit({})
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  const a = fakeAgent('session-z')
  await g.sync(a, ['pwsh'], '6', audit.latestRestrictByAgent())
  await g.untrack(a)
  const last = audit.last()
  assertEq(last.decision, 'restrict-untracked')
  assertEq(last.agent, 'session-z')
  assert(last.from === 1 || last.from === null, `from 应带上被终结那条 applied 的 seq，实际 ${last.from}`)
})

ta('台账删除是**同步**的（await 前已删）', async () => {
  const audit = fakeAudit({})
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  const a = fakeAgent('session-z')
  await g.sync(a, ['pwsh'], '6', audit.latestRestrictByAgent())
  assertEq(g.size, 1)
  const p = g.untrack(a)
  assertEq(g.size, 0, 'untrack 返回 promise 时台账必须已清空')
  await p
})

ta('[反向] 从没挂过限制的会话被销毁 ⇒ 不落 untracked（否则每个会话都刷一条噪声）', async () => {
  const audit = fakeAudit({})
  const g = new RestrictGovernor({ cfg: cfgB('11'), audit })
  const a = fakeAgent('session-cold')
  await g.sync(a, [], '11', audit.latestRestrictByAgent())
  await g.untrack(a)
  assertEq(audit.of('restrict-untracked').length, 0)
  assertEq(audit.records.length, 0, '不该有任何审计行')
})

ta('untrack(undefined) 不抛（disposed 回调可能拿不到 agent）', async () => {
  const audit = fakeAudit({})
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  await g.untrack(undefined)
  await g.untrack(null)
  assertEq(audit.records.length, 0)
})

// ================================================================ 4. duck typing
lines.push('## 4. duck typing：audit 没有 `latestRestrictByAgent` ⇒ 退化为 applied 且不崩')

ta('缺 `#audit.latestRestrictByAgent` ⇒ 不查历史、照常挂限制', async () => {
  const recs = []
  const bare = { async record(e) { recs.push(e); return { seq: recs.length } } }
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit: bare })
  const r = await g.sync(fakeAgent('session-x'), ['pwsh'], '6')
  assertEq(r, 'applied')
  assertEq(recs[recs.length - 1].decision, 'restrict-applied')
})

// ================================================================ 5. history-miss（真 AuditChain + 长链）
lines.push('## 5. history-miss：尾部窗口未覆盖全链 ⇒ 聚合留痕（真 `AuditChain`，非假审计）')

/** 造一条超过 TAIL_BYTES 的长链：`earlyAgent` 的 applied 落在窗口之外。 */
async function mkLongChain(file, earlyAgent) {
  const c = new AuditChain(file)
  await c.record({ type: 'restrict', decision: 'restrict-applied', agent: earlyAgent, phase: '6', denied: ['pwsh'] })
  // 填充到远超 64KiB：单条 ~260B × 400 ≈ 100KB
  for (let i = 0; i < 400; i++) {
    await c.record({ type: 'filler', decision: 'note', note: 'x'.repeat(200), i })
  }
  return c
}

function readRecords(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

ta(`长链 > ${TAIL_BYTES}B ⇒ tailTruncated=true，窗口外的 agent 查不到`, async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  await mkLongChain(file, 'session-old')
  const c2 = new AuditChain(file) // 模拟重启：新实例从尾部恢复
  assert(c2.tailTruncated === true, '尾部窗口未覆盖全链 ⇒ 必须标记为截断')
  assert(!c2.latestRestrictByAgent().has('session-old'), '窗口外的 agent 不该在索引里')
})

ta('截断 + agent 不在索引 ⇒ **一条聚合** `restrict-history-miss`（同批多个 agent 也只占一条）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  await mkLongChain(file, 'session-old')
  const audit = new AuditChain(file)
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  const a1 = fakeAgent('session-old')
  const a2 = fakeAgent('session-old2') // 也不在索引里
  g.bind({ agents: { list: () => [a1, a2] } })
  await g.reconcile('6')
  const miss = readRecords(file).filter((r) => r.decision === 'restrict-history-miss')
  assertEq(miss.length, 1, '每条 reconcile 最多一条（聚合口径，否则一过窗口就刷屏）')
  assertEq(miss[0].agents.sort(), ['session-old', 'session-old2'], '两个 agent 合并在一条里')
  assertEq(miss[0].truncated, true)
  assertEq(miss[0].reason, 'tail-window')
})

ta('[反向] 第二次 reconcile **不再重复**落 miss（索引已被 `record()` 增量更新 ⇒ 不刷屏）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  await mkLongChain(file, 'session-old')
  const audit = new AuditChain(file)
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  g.bind({ agents: { list: () => [fakeAgent('session-old')] } })
  await g.reconcile('6')
  await g.reconcile('6')
  const miss = readRecords(file).filter((r) => r.decision === 'restrict-history-miss')
  assertEq(miss.length, 1, '同一 agent 不该每次对账都来一条 —— 那正好跟加它的目的相反')
})

ta('截断时 restored 退化为 `applied`（fail-safe：绝不因查不到历史就不挂限制）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  await mkLongChain(file, 'session-old')
  const audit = new AuditChain(file)
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  const a = fakeAgent('session-old')
  g.bind({ agents: { list: () => [a] } })
  await g.reconcile('6')
  const recs = readRecords(file).filter((r) => r.type === 'restrict' && r.agent === 'session-old')
  assertEq(recs[recs.length - 1].decision, 'restrict-applied', '查不到历史 ⇒ 按首次挂载处理')
  assertEq(a._calls.length, 1, '限制仍必须真的挂上')
})

ta('[反向] 链未截断（短链）+ agent 不在索引 ⇒ **不落** history-miss', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  const audit = new AuditChain(file)
  await audit.record({ type: 'filler', decision: 'note' })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  const a = fakeAgent('session-brand-new')
  g.bind({ agents: { list: () => [a] } })
  await g.reconcile('6')
  const miss = readRecords(file).filter((r) => r.decision === 'restrict-history-miss')
  assertEq(miss.length, 0, '窗口覆盖全链 ⇒ "查不到"就是真的没有历史，不是盲区')
})

ta('长链 + 新记录后：全链重放仍是单一连续哈希链（不得因改索引把链写坏）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  await mkLongChain(file, 'session-old')
  const audit = new AuditChain(file)
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  g.bind({ agents: { list: () => [fakeAgent('session-old')] } })
  await g.reconcile('6')

  // 重新计算：逐行 prevHash + hash 连续
  const recs = readRecords(file)
  let prev = GENESIS
  let lastSeq = 0
  for (const r of recs) {
    const { prevHash, hash, ...body } = r
    assertEq(prevHash, prev, `seq=${body.seq} 断链`)
    assertEq(hash, createHash('sha256').update(prev).update('\n').update(JSON.stringify(body)).digest('hex'),
      `seq=${body.seq} hash 不匹配`)
    assert(body.seq > lastSeq, `seq 必须单调递增，实际 ${body.seq} <= ${lastSeq}`)
    lastSeq = body.seq
    prev = hash
  }
})

// ================================================================ 6. 索引增量
lines.push('## 6. 索引：构造期建 + `record()` 增量更新（同实例立即可见）')

ta('`record()` 之后 `latestRestrictByAgent()` 立即反映（零额外 IO）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  const c = new AuditChain(file)
  assert(!c.latestRestrictByAgent().has('session-a'))
  const r = await c.record({ type: 'restrict', decision: 'restrict-applied', agent: 'session-a', denied: ['pwsh'] })
  const got = c.latestRestrictByAgent().get('session-a')
  assert(got, 'record() 必须增量更新索引')
  assertEq(got.seq, r.seq)
  assertEq(got.decision, 'restrict-applied')
})

ta('索引取的是**最近一条**（后写的覆盖先写的）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  const c = new AuditChain(file)
  await c.record({ type: 'restrict', decision: 'restrict-applied', agent: 'session-a', denied: ['pwsh'] })
  await c.record({ type: 'restrict', decision: 'restrict-lifted', agent: 'session-a', denied: [] })
  assertEq(c.latestRestrictByAgent().get('session-a').decision, 'restrict-lifted')
})

ta('非 restrict 记录 / 无 agent 字段 ⇒ 不进索引', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  const c = new AuditChain(file)
  await c.record({ type: 'gate', decision: 'deny' })
  await c.record({ type: 'restrict', decision: 'restrict-undetermined', phase: null })
  assertEq(c.latestRestrictByAgent().size, 0)
})

// ================================================================ 7. 夹具（禁止直接读活链）
lines.push('## 7. 夹具：`_fixtures/phase-chain-2026-09-25.jsonl` sha256 断言')

t('夹具 sha256 与侧车 meta 一致（不符 ⇒ 直接红，不是警告）', () => {
  const jsonl = join(HERE, '_fixtures', 'phase-chain-2026-09-25.jsonl')
  const meta = JSON.parse(readFileSync(join(HERE, '_fixtures', 'phase-chain-2026-09-25.meta.json'), 'utf8'))
  const buf = readFileSync(jsonl)
  const sha = createHash('sha256').update(buf).digest('hex')
  assertEq(sha, meta.sha256, '夹具被改动了 ⇒ 全部基线作废')
  assertEq(buf.length, meta.bytes)
  const n = buf.toString('utf8').split('\n').filter((l) => l.trim().length > 0).length
  assertEq(n, meta.lines)
})

t('夹具快照上的 restrict 记录：13 条、最早 seq=15、无 restored/untracked/history-miss', () => {
  const jsonl = join(HERE, '_fixtures', 'phase-chain-2026-09-25.jsonl')
  const recs = readRecords(jsonl)
  assertEq(recs.length, 36)
  const rs = recs.filter((r) => r.type === 'restrict')
  assertEq(rs.length, 13, 'restrict 记录条数（钉住基线，防止将来误判为回归）')
  assertEq(rs[0].seq, 15, '最早一条 restrict 的 seq')
  for (const d of ['restrict-restored', 'restrict-replaced', 'restrict-untracked', 'restrict-history-miss']) {
    assertEq(rs.filter((r) => r.decision === d).length, 0, `快照里不应出现 ${d}（它是本批新增的）`)
  }
})

// ================================================================ 8. from 指针（0005 §1.3 拍板）
lines.push('## 8. `from` 恒指「该 agent 最后一条 applied 的 seq」，不链式（0005 拍板）')

ta('最近一条 = restored 且能找到源头 applied ⇒ 仍记 `restored`，from = 那条 **applied** 的 seq', async () => {
  const audit = fakeAudit({
    'session-x': { seq: 37, decision: 'restrict-restored', appliedSeq: 36, denied: ['pwsh'] }
  })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  await g.sync(fakeAgent('session-x'), ['pwsh'], '6', audit.latestRestrictByAgent())
  const last = audit.last()
  assertEq(last.decision, 'restrict-restored', 'restored 之后仍是 restored（不得退化成 applied）')
  assertEq(last.from, 36, 'from 必须指 applied(36)，不是 restored(37)')
})

ta('[守门人] 连续两次重启（applied → restored → restored）⇒ 第二条 from 仍指最初那条 applied', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  const lastOf = (agent) =>
    readRecords(file).filter((r) => r.type === 'restrict' && r.agent === agent).at(-1)

  const c1 = new AuditChain(file)
  const g1 = new RestrictGovernor({ cfg: cfgB('6'), audit: c1 })
  const a = fakeAgent('session-r')
  g1.bind({ agents: { list: () => [a] } })
  await g1.reconcile('6')
  const src = lastOf('session-r').seq

  // 第一次重启
  const c2 = new AuditChain(file)
  const g2 = new RestrictGovernor({ cfg: cfgB('6'), audit: c2 })
  await g2.sync(a, ['pwsh'], '6', c2.latestRestrictByAgent())
  const r2 = lastOf('session-r')
  assertEq(r2.decision, 'restrict-restored', '第一次重启应记 restored')
  assertEq(r2.from, src, 'from 应指最初那条 applied')

  // 第二次重启
  const c3 = new AuditChain(file)
  const g3 = new RestrictGovernor({ cfg: cfgB('6'), audit: c3 })
  await g3.sync(a, ['pwsh'], '6', c3.latestRestrictByAgent())
  const r3 = lastOf('session-r')
  assertEq(r3.decision, 'restrict-restored')
  assertEq(r3.from, src, '第二次重启的 from 必须**仍指最初那条 applied**（不链式）')
})

ta('最近一条 = restored 但 applied 在窗口外（截断）⇒ 仍记 `restored`，from 显式 null', async () => {
  const audit = fakeAudit(
    { 'session-x': { seq: 37, decision: 'restrict-restored', appliedSeq: null, denied: ['pwsh'] } },
    { tailTruncated: true }
  )
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  await g.sync(fakeAgent('session-x'), ['pwsh'], '6', audit.latestRestrictByAgent())
  const last = audit.last()
  assertEq(last.decision, 'restrict-restored', '是否接续只看「最近一条」，与能否找到源头无关')
  assert(
    last.from === null,
    `from 必须是 null（源头不可考，不编造、也不退化），实际 ${JSON.stringify(last.from)}`
  )
})

ta('最近一条 = untracked（多次重启后）⇒ from = 最后一条 applied 的 seq，不是 untracked 自己的', async () => {
  const audit = fakeAudit({ 'session-x': { seq: 40, decision: 'restrict-untracked', appliedSeq: 36 } })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  await g.sync(fakeAgent('session-x'), ['pwsh'], '6', audit.latestRestrictByAgent())
  assertEq(audit.last().from, 36, 'from 必须指 applied(36)，不是 untracked(40)')
})

ta('重启（restored）后再销毁 ⇒ `untracked` 的 from 仍是那条 applied（不是 restored 的 seq）', async () => {
  const audit = fakeAudit({
    'session-x': { seq: 37, decision: 'restrict-restored', appliedSeq: 36, denied: ['pwsh'] }
  })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  const a = fakeAgent('session-x')
  await g.sync(a, ['pwsh'], '6', audit.latestRestrictByAgent())
  await g.untrack(a)
  const last = audit.last()
  assertEq(last.decision, 'restrict-untracked')
  assertEq(last.from, 36, 'untracked 的 from 也必须恒指 applied（跨重启不丢）')
})

ta('`applied → replaced → 销毁` ⇒ `untracked.from` 仍是那条 applied 的 seq（不是 null）', async () => {
  // 🔴 0006 §5.2：`replaced` 的 `from` 是**数组** ⇒ `Number.isInteger(from)` 为 false ⇒ 若不做处理，
  // appliedSeq 会被抹成 null ⇒ 销毁时被告知"源头不可考"，但我们明明知道（就是第一次那条 applied）。
  // `replaced` 不是一条 applied ⇒ 正确行为是"**沿用**旧值"，不是"推进"。
  const audit = fakeAudit({})
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  const a = fakeAgent('session-rep', ['pwsh', 'bash'])
  const hist = audit.latestRestrictByAgent()
  await g.sync(a, ['pwsh'], '6', hist)
  const appliedSeq = audit.last().seq
  await g.sync(a, ['pwsh', 'bash'], '6', hist) // ⇒ replaced
  assertEq(audit.last().decision, 'restrict-replaced')
  await g.untrack(a)
  const last = audit.last()
  assertEq(last.decision, 'restrict-untracked')
  assertEq(
    last.from,
    appliedSeq,
    'replaced 不得抹掉 appliedSeq：限制从那条 applied 一路延续下来，源头就是它'
  )
})

ta('[反向] 索引条目**没有 appliedSeq**（老链/假索引）⇒ applied 分支回落到 `last.seq`，行为不变', async () => {
  const audit = fakeAudit({ 'session-x': { seq: 35, decision: 'restrict-applied', denied: ['pwsh'] } })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  await g.sync(fakeAgent('session-x'), ['pwsh'], '6', audit.latestRestrictByAgent())
  const last = audit.last()
  assertEq(last.decision, 'restrict-restored')
  assertEq(last.from, 35, '兼容回落：这条 applied 就是源头本身')
})

// ================================================================ 9. 第五批：跨进程 lifted
lines.push('## 9. 第五批：跨进程 `lifted`（「限制何时失效」在链上可见）')

/**
 * 判据：链上最后一条 ∈ {applied, restored, replaced} 且 denied 非空 ⇒ 视为"曾带着限制"。
 * 其余（lifted / degraded / error / untracked / 无记录）⇒ 不带 ⇒ 不落。
 * ⚠️ 不能用"denied 非空"当判据：`error` 记录的 denied 就是 want（非空）但它**没挂上**。
 */
const CARRYING = ['restrict-applied', 'restrict-restored', 'restrict-replaced']
const NOT_CARRYING = ['restrict-lifted', 'restrict-degraded', 'restrict-error', 'restrict-untracked']

for (const d of CARRYING) {
  ta(`最近一条 = ${d}（带限制）+ want=[] ⇒ 落跨进程 ` + '`lifted`', async () => {
    const denied = d === 'restrict-replaced' ? ['bash'] : ['pwsh']
    const audit = fakeAudit({ 'session-x': { seq: 41, decision: d, appliedSeq: 36, denied } })
    const g = new RestrictGovernor({ cfg: cfgB('11'), audit })
    const a = fakeAgent('session-x')
    const r = await g.sync(a, [], '11', audit.latestRestrictByAgent())
    assertEq(r, 'lifted', '该 agent 从"带限制"变成"不带" ⇒ 是真实的状态转变')
    const last = audit.last()
    assertEq(last.decision, 'restrict-lifted')
    assertEq(last.via, 'index', '必须标明是**索引推断**（跨进程），否则与"本进程摘除"不可判别')
    assertEq(last.from, 41, 'from 指向"它曾带限制"的那条，读者可跳回去对照')
    assertEq(last.denied, denied, '写旧名单 ⇒ 读者看得出摘掉的是什么')
  })
}

for (const d of NOT_CARRYING) {
  ta(`[反向] 最近一条 = ${d}（不带限制）⇒ **不落** lifted（不得刷屏/不得编造）`, async () => {
    const audit = fakeAudit({ 'session-x': { seq: 41, decision: d, appliedSeq: 36, denied: ['pwsh'] } })
    const g = new RestrictGovernor({ cfg: cfgB('11'), audit })
    const r = await g.sync(fakeAgent('session-x'), [], '11', audit.latestRestrictByAgent())
    assertEq(r, 'unchanged')
    assertEq(audit.records.length, 0, `不该留任何审计，实际 ${JSON.stringify(audit.records)}`)
  })
}

ta('[反向] 索引里**没有**这个 agent（全新会话）⇒ 不落 lifted（避免审计噪声）', async () => {
  const audit = fakeAudit({})
  const g = new RestrictGovernor({ cfg: cfgB('11'), audit })
  const r = await g.sync(fakeAgent('brand-new'), [], '11', audit.latestRestrictByAgent())
  assertEq(r, 'unchanged')
  assertEq(audit.records.length, 0)
})

ta('[反向] want **非空**（仍在受保护阶段）⇒ 绝不落 lifted', async () => {
  const audit = fakeAudit({ 'session-x': { seq: 41, decision: 'restrict-restored', appliedSeq: 36, denied: ['pwsh'] } })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  await g.sync(fakeAgent('session-x'), ['pwsh'], '6', audit.latestRestrictByAgent())
  assertEq(audit.of('restrict-lifted').length, 0, '受保护阶段内不该出现"限制已失效"的记录')
})

ta('本进程摘除（台账内有"有过→无"的转变）⇒ `via: \'ledger\'`（与跨进程可判别）', async () => {
  const audit = fakeAudit({})
  const g = new RestrictGovernor({ cfg: cfgB('11'), audit })
  const a = fakeAgent('session-x')
  await g.sync(a, ['pwsh'], '6')
  const r = await g.sync(a, [], '11')
  assertEq(r, 'lifted')
  const last = audit.last()
  assertEq(last.decision, 'restrict-lifted')
  assertEq(last.via, 'ledger', '本进程摘除必须标 ledger，与 index 区分 —— 否则又一个静默点')
})

ta('判别字段必存：任何 lifted 记录的 `via` ∈ {index, ledger}，不得缺失', async () => {
  const audit = fakeAudit({ 'session-x': { seq: 41, decision: 'restrict-applied', appliedSeq: 36, denied: ['pwsh'] } })
  const g = new RestrictGovernor({ cfg: cfgB('11'), audit })
  await g.sync(fakeAgent('session-x'), [], '11', audit.latestRestrictByAgent())
  const lifted = audit.of('restrict-lifted')
  assertEq(lifted.length, 1)
  assert(
    lifted[0].via === 'index' || lifted[0].via === 'ledger',
    `via 必须是可判别取值，实际 ${JSON.stringify(lifted[0].via)}（缺失会让读者分不清是哪种摘除）`
  )
})

ta('跨进程 lifted **不得**去调 disposer（本进程没有层可调）', async () => {
  const audit = fakeAudit({ 'session-x': { seq: 41, decision: 'restrict-applied', appliedSeq: 36, denied: ['pwsh'] } })
  const g = new RestrictGovernor({ cfg: cfgB('11'), audit })
  const a = fakeAgent('session-x')
  await g.sync(a, [], '11', audit.latestRestrictByAgent())
  assertEq(a._disposed, [], '本进程从未挂过 ⇒ 没有 disposer；强行调会误伤别的作用域')
})

ta('幂等：连续两次 reconcile（新实例 = 新进程）⇒ 只落一条（索引已被更新为 lifted）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  const c1 = new AuditChain(file)
  await c1.record({ type: 'restrict', decision: 'restrict-applied', agent: 'session-x', phase: '6', denied: ['pwsh'] })

  // 第二个进程：看到链上带着限制，而当前 phase 11 ⇒ 落一条跨进程 lifted
  const c2 = new AuditChain(file)
  const g2 = new RestrictGovernor({ cfg: cfgB('11'), audit: c2 })
  g2.bind({ agents: { list: () => [fakeAgent('session-x')] } })
  const t2 = await g2.reconcile('11')
  assertEq(t2.lifted, 1, '第一次应落一条')
  assertEq(c2.latestRestrictByAgent().get('session-x').decision, 'restrict-lifted')

  // 第三个进程：索引已是 lifted ⇒ 不该再落
  const c3 = new AuditChain(file)
  const g3 = new RestrictGovernor({ cfg: cfgB('11'), audit: c3 })
  g3.bind({ agents: { list: () => [fakeAgent('session-x')] } })
  const t3 = await g3.reconcile('11')
  assertEq(t3.lifted, 0, '第二次起不该再落 —— 否则每次启动都刷一批')
  const lifted = readRecords(file).filter((r) => r.decision === 'restrict-lifted')
  assertEq(lifted.length, 1, '全链只应有一条')
})

// ================================================================ 10. history-miss 对齐到 want=0 侧
lines.push('## 10. `history-miss` 对齐：`want` 为空时漏记摘除**同样**要留痕（0008 §4）')

ta('`want=[]` + 截断 + agent 不在索引 ⇒ 落 `history-miss`（``branch=\'want-empty\'``）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  await mkLongChain(file, 'session-old')
  const audit = new AuditChain(file)
  const g = new RestrictGovernor({ cfg: cfgB('11'), audit })
  g.bind({ agents: { list: () => [fakeAgent('session-old')] } })
  await g.reconcile('11')
  const miss = readRecords(file).filter((r) => r.decision === 'restrict-history-miss')
  assertEq(miss.length, 1, 'want=0 侧漏判**更隐蔽**（链上连可疑痕迹都没有）⇒ 必须留痕')
  assertEq(miss[0].branch, 'want-empty', '必须标明是从哪个分支发现的')
  assertEq(miss[0].agents, ['session-old'])
  assertEq(miss[0].truncated, true)
})

ta('[反向] `want=[]` 但**未截断** + agent 不在索引 ⇒ **不落**（窗口覆盖全链 ⇒ 查不到就是真没有）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  const audit = new AuditChain(file)
  await audit.record({ type: 'filler', decision: 'note' })
  const g = new RestrictGovernor({ cfg: cfgB('11'), audit })
  g.bind({ agents: { list: () => [fakeAgent('session-brand-new')] } })
  await g.reconcile('11')
  const miss = readRecords(file).filter((r) => r.decision === 'restrict-history-miss')
  assertEq(miss.length, 0, '短链 ⇒ "查不到"是真的没有历史，不是盲区 ⇒ 不该刷')
})

ta('`want=[]` + 截断 + agent **在**索引里 ⇒ 不落 miss（有历史 ⇒ 走 lifted，不是盲区）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  const c1 = new AuditChain(file)
  await c1.record({ type: 'restrict', decision: 'restrict-applied', agent: 'session-x', phase: '6', denied: ['pwsh'] })
  // 长链把窗口撑爆，但最后一条仍是 session-x ⇒ 索引里**有**它
  for (let i = 0; i < 400; i++) await c1.record({ type: 'filler', decision: 'note', note: 'y'.repeat(200), i })
  await c1.record({ type: 'restrict', decision: 'restrict-applied', agent: 'session-x', phase: '6', denied: ['pwsh'] })

  const audit = new AuditChain(file)
  assert(audit.tailTruncated === true, '前置：链必须截断')
  assert(audit.latestRestrictByAgent().has('session-x'), '前置：索引里必须有它')
  const g = new RestrictGovernor({ cfg: cfgB('11'), audit })
  g.bind({ agents: { list: () => [fakeAgent('session-x')] } })
  await g.reconcile('11')
  const miss = readRecords(file).filter((r) => r.decision === 'restrict-history-miss')
  assertEq(miss.length, 0, '查得到历史 ⇒ 不是盲区 ⇒ 不该落 miss')
  const lifted = readRecords(file).filter((r) => r.decision === 'restrict-lifted')
  assertEq(lifted.length, 1, '应当正常走跨进程 lifted')
})

ta('`want` 非空 + 截断 ⇒ `branch=\'want-nonempty\'`（既有行为不变）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  await mkLongChain(file, 'session-old')
  const audit = new AuditChain(file)
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  g.bind({ agents: { list: () => [fakeAgent('session-old')] } })
  await g.reconcile('6')
  const miss = readRecords(file).filter((r) => r.decision === 'restrict-history-miss')
  assertEq(miss.length, 1)
  assertEq(miss[0].branch, 'want-nonempty')
})

ta('聚合：`want=[]` + 多个 agent 不在索引 ⇒ **一条**（不刷屏）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  await mkLongChain(file, 'session-old')
  const audit = new AuditChain(file)
  const g = new RestrictGovernor({ cfg: cfgB('11'), audit })
  g.bind({ agents: { list: () => [fakeAgent('session-old'), fakeAgent('session-old2')] } })
  await g.reconcile('11')
  const miss = readRecords(file).filter((r) => r.decision === 'restrict-history-miss')
  assertEq(miss.length, 1, '每条 reconcile 最多一条（聚合）')
  assertEq(miss[0].agents.sort(), ['session-old', 'session-old2'])
})

ta('幂等：`want=[]` + 截断 ⇒ 第二次 reconcile **不再重复**落（进程内去重）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  await mkLongChain(file, 'session-old')
  const audit = new AuditChain(file)
  const g = new RestrictGovernor({ cfg: cfgB('11'), audit })
  g.bind({ agents: { list: () => [fakeAgent('session-old')] } })
  await g.reconcile('11')
  await g.reconcile('11')
  const miss = readRecords(file).filter((r) => r.decision === 'restrict-history-miss')
  assertEq(miss.length, 1, 'want=0 侧没有"挂上"这个副作用去更新索引 ⇒ 必须靠进程内去重，否则每次对账刷一条')
})

ta('去重只限**本进程**：新实例（= 新进程）重新发现盲区 ⇒ **再报一次**（不得永久静默）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  await mkLongChain(file, 'session-old')
  const g1 = new RestrictGovernor({ cfg: cfgB('11'), audit: new AuditChain(file) })
  g1.bind({ agents: { list: () => [fakeAgent('session-old')] } })
  await g1.reconcile('11')
  const g2 = new RestrictGovernor({ cfg: cfgB('11'), audit: new AuditChain(file) }) // 模拟重启
  g2.bind({ agents: { list: () => [fakeAgent('session-old')] } })
  await g2.reconcile('11')
  const miss = readRecords(file).filter((r) => r.decision === 'restrict-history-miss')
  assertEq(miss.length, 2, '盲区仍在 ⇒ 新进程必须重新报告，永久静默等于把盲区藏起来')
})

// ================================================================ 11. 去重闸门只在**落盘成功**后生效（0009 §3）
lines.push('## 11. `#missedAgents` 去重闸门：报**成功**才算报过（0009 §3）')

ta('落盘失败（`persisted:false`）⇒ 第二次 reconcile **仍要报**（不得被去重闸门永久静默）', async () => {
  const audit = fakeAudit({}, { tailTruncated: true, persisted: false })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  g.bind({ agents: { list: () => [fakeAgent('session-old')] } })
  await g.reconcile('6')
  assertEq(audit.of('restrict-history-miss').length, 1, '前置：第一次应报一条')
  await g.reconcile('6')
  assertEq(
    audit.of('restrict-history-miss').length,
    2,
    '⚠️ #note 吞掉写盘失败（不抛）⇒ 若照旧在循环里先标记，这批盲区在本进程内永久不再报。' +
      '"检测到了但没说出来，而且以后也不会再说" —— 正是本批要根除的形态'
  )
})

ta('[反向] 落盘成功 ⇒ 第二次 reconcile **不再报**（既有幂等不变，防改过头）', async () => {
  const audit = fakeAudit({}, { tailTruncated: true, persisted: true })
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  g.bind({ agents: { list: () => [fakeAgent('session-old')] } })
  await g.reconcile('6')
  await g.reconcile('6')
  assertEq(audit.of('restrict-history-miss').length, 1, '落盘成功 ⇒ 照旧去重（正常路径不得刷屏）')
})

ta('[反向] 真 `AuditChain` + `want` 非空 ⇒ 两次 reconcile 仍只一条（真链路径不受影响）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fde-chain-')), 'phase.jsonl')
  await mkLongChain(file, 'session-old')
  const audit = new AuditChain(file)
  const g = new RestrictGovernor({ cfg: cfgB('6'), audit })
  g.bind({ agents: { list: () => [fakeAgent('session-old')] } })
  await g.reconcile('6')
  await g.reconcile('6')
  const miss = readRecords(file).filter((r) => r.decision === 'restrict-history-miss')
  assertEq(miss.length, 1)
  assertEq(miss[0].branch, 'want-nonempty')
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

console.log(`[restrict-index-test] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
