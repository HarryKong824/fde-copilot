/**
 * E3 · schema 迁移失败降只读 —— 离线回归（spec 第七节）。
 *
 * spec 原文（工程债修复表）：
 *   「schema 版本 …… 加 **迁移失败 = 写入 fail-closed，读取降级为只读模式（数据不扣人质）**」
 *
 * 跑法：
 *   node _fde_memory_e3_test.mjs
 *   FDE_INVERT=1 node _fde_memory_e3_test.mjs   （故意做反，验退出码敏感）
 *
 * 覆盖：
 *   §1 ensureSchemaVersion 单元（缺失/相同/磁盘更高/无路径升级/非法内容）
 *   §2 **apply 不再 throw**（旧行为：failed ⇒ 插件整体不加载 ⇒ 连读都没了，正是 spec 要修的）
 *   §3 只读守卫只拦写（write_decision / confirm / review 拒；context 照常）
 *   §4 边界（非只读时不拦，向后兼容）
 *
 * ⚠️ 输出顺序 = **登记序**（不是完成序）：异步用例各自往自己的槽位写结果，收尾统一渲染。
 *    否则 sleep(60) 的用例会落到输出后半段，读的人会以为它属于另一节。
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CURRENT, CHAIN, readSchemaVersion, ensureSchemaVersion } from '../dsh-fde-memory/lib/schema-version.js'
import { apply } from '../dsh-fde-memory/lib/index.js'
import * as memTools from '../dsh-fde-memory/lib/tools.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_fde_memory_e3_out.txt')

/** 输出槽位：登记序即输出序。header 与用例共用同一个数组。 */
const records = []
const pending = []
let passed = 0
let failed = 0

function section(title) {
  records.push({ header: title })
}
function finish(i, ok, err) {
  records[i].ok = ok
  records[i].err = err ? (err && err.message ? err.message : String(err)) : null
  if (ok) passed += 1
  else failed += 1
}
function t(name, fn) {
  const i = records.push({ name, ok: null, err: null }) - 1
  try {
    fn()
    finish(i, true)
  } catch (e) {
    finish(i, false, e)
  }
}
function ta(name, fn) {
  const i = records.push({ name, ok: null, err: null }) - 1
  pending.push(
    (async () => {
      try {
        await fn()
        finish(i, true)
      } catch (e) {
        finish(i, false, e)
      }
    })()
  )
}
function assert(c, m) {
  if (!c) throw new Error(m || '断言失败')
}
function assertEq(a, e, m) {
  const x = JSON.stringify(a)
  const y = JSON.stringify(e)
  if (x !== y) throw new Error(`${m || '不相等'}：期望 ${y}，实际 ${x}`)
}

/** 建一个临时 projectRoot；schemaVersion 传值则写进 SCHEMA_VERSION 文件。 */
function env({ schemaVersion } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'e3-'))
  if (schemaVersion !== undefined) writeFileSync(join(dir, 'SCHEMA_VERSION'), String(schemaVersion) + '\n', 'utf8')
  return dir
}

/** 建 apply 用的假 ctx：记录注册的工具、捕获 logger 输出。 */
function makeCtx() {
  const tools = {}
  const warns = []
  const infos = []
  const ctx = {
    tools: {
      register: (def) => {
        tools[def.name] = def
        return () => {}
      }
    },
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    on: () => () => {},
    logger: {
      info: (...a) => infos.push(a.join(' ')),
      warn: (...a) => warns.push(a.join(' '))
    }
  }
  return { ctx, tools, warns, infos }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 期望注册的工具清单。
 *
 * 🔴 E2（2026-09-29）起**不写死字面量**：原为 4 个硬编码名字，E2 新增 3 个沙箱工具后
 *    它把**正确实现**判成红的 —— 而那正是"旧断言指控正确实现、最省事的修法是改回缺陷"
 *    的经典陷阱（规矩 10）。改成从 `tools.js` 的**导出常量**算 ⇒ 加工具时自动跟上，
 *    同时仍能抓住"某个工具漏注册"（从 `installMemoryTools` 里删掉一个注册 ⇒ 期望里还在它 ⇒ 红）。
 */
const ALL_TOOLS = [
  memTools.CONTEXT_TOOL,
  memTools.WRITE_DECISION_TOOL,
  memTools.REVIEW_TOOL,
  memTools.CONFIRM_TOOL,
  memTools.EXPERIMENT_WRITE_TOOL,
  memTools.EXPERIMENT_READ_TOOL,
  memTools.EXPERIMENT_LIST_TOOL
].sort()

/** 读 <projectRoot>/memory/audit/events.jsonl 的全部记录（不存在 ⇒ []）。 */
function readAudit(dir) {
  const p = join(dir, 'memory', 'audit', 'events.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

/**
 * 轮询等待审计链出现满足条件的记录，**超时也返回**（由调用方的断言判红，不在这里抛）。
 *
 * 用途见 `迁移失败时审计落 schema-readonly` 那条：`audit.record` 是 fire-and-forget，
 * 固定 `sleep(N)` 在慢机器上是间歇红的主要来源。轮询把"等多久"从猜测变成有上限的探测。
 *
 * @param {string} dir
 * @param {(recs: any[]) => boolean} pred
 * @param {number} [timeoutMs]
 * @returns {Promise<any[]>}
 */
async function waitForAudit(dir, pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let recs = readAudit(dir)
  while (!pred(recs) && Date.now() < deadline) {
    await sleep(20)
    recs = readAudit(dir)
  }
  return recs
}

// ================================================================ §1
section('[§1 ensureSchemaVersion 单元]')

t('CHAIN 为空（本单无 v2 格式）—— 这不是缺口，是没有可迁的版本', () => {
  assertEq(Object.keys(CHAIN), [], 'CHAIN 应为空对象')
  assertEq(CURRENT, 1)
})

t('SCHEMA_VERSION 缺失 ⇒ created，写入 CURRENT', () => {
  const dir = env()
  const r = ensureSchemaVersion(dir)
  assertEq(r.status, 'created')
  assertEq(r.version, CURRENT)
  assertEq(readFileSync(join(dir, 'SCHEMA_VERSION'), 'utf8').trim(), String(CURRENT))
  rmSync(dir, { recursive: true, force: true })
})

t('SCHEMA_VERSION == CURRENT ⇒ ok', () => {
  const dir = env({ schemaVersion: CURRENT })
  const r = ensureSchemaVersion(dir)
  assertEq(r.status, 'ok')
  assertEq(r.version, CURRENT)
  rmSync(dir, { recursive: true, force: true })
})

t('磁盘版本更高（插件回退：磁盘=2、代码=1）⇒ failed，带 from 与 error', () => {
  const dir = env({ schemaVersion: 2 })
  const r = ensureSchemaVersion(dir)
  assertEq(r.status, 'failed')
  assertEq(r.from, 2)
  assert(String(r.error).includes('无法迁移到'), 'error 应说明无迁移路径，实际 ' + r.error)
  assert(String(r.error).includes('CHAIN'), 'error 应带上 CHAIN（便于排查），实际 ' + r.error)
  rmSync(dir, { recursive: true, force: true })
})

t('磁盘版本更低且无迁移路径（磁盘=1、代码=2）⇒ failed', () => {
  const dir = env({ schemaVersion: 1 })
  const r = ensureSchemaVersion(dir, 2)
  assertEq(r.status, 'failed')
  assertEq(r.from, 1)
  rmSync(dir, { recursive: true, force: true })
})

t('SCHEMA_VERSION 内容非法（0 / abc / -1）⇒ readSchemaVersion 抛错', () => {
  for (const bad of ['0', 'abc', '-1']) {
    const dir = env({ schemaVersion: bad })
    let threw = null
    try {
      readSchemaVersion(dir)
    } catch (e) {
      threw = e
    }
    assert(threw, `${bad} 应抛错`)
    assert(String(threw.message).includes('≥1 的整数'), `${bad} 的错误文案应说明要求，实际 ${threw.message}`)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ================================================================ §2
section('[§2 apply 在迁移失败时不再 throw（E3 的核心修正）]')

t('SCHEMA_VERSION=2 时 apply **不抛错**（旧实现：throw ⇒ 插件整体不加载）', () => {
  const dir = env({ schemaVersion: 2 })
  const { ctx } = makeCtx()
  let threw = null
  try {
    apply(ctx, { projectRoot: dir, mode: 'enforce' })
  } catch (e) {
    threw = e
  }
  assert(!threw, `apply 不该抛错，实际抛了：${threw && threw.message}`)
  rmSync(dir, { recursive: true, force: true })
})

t('迁移失败时**全部工具都注册**（旧实现下一个都没有 ⇒ 连读都没了）', () => {
  const dir = env({ schemaVersion: 2 })
  const { ctx, tools } = makeCtx()
  apply(ctx, { projectRoot: dir, mode: 'enforce' })
  assertEq(Object.keys(tools).sort(), ALL_TOOLS, '注册的工具应恰好等于 tools.js 声明的全部工具')
  rmSync(dir, { recursive: true, force: true })
})

t('迁移失败时 logger.warn 明确说出「只读模式」（不是静默降级）', () => {
  const dir = env({ schemaVersion: 2 })
  const { ctx, warns, infos } = makeCtx()
  apply(ctx, { projectRoot: dir, mode: 'enforce' })
  assert(
    warns.some((w) => w.includes('只读模式') && w.includes('写入 fail-closed') && w.includes('读取照常')),
    `warn 应说明只读模式，实际 warns=${JSON.stringify(warns)}`
  )
  assert(
    infos.some((i) => i.includes('只读模式')),
    `info 汇总行也应带只读标记（否则只翻 info 的人看不到），实际 infos=${JSON.stringify(infos)}`
  )
  rmSync(dir, { recursive: true, force: true })
})

ta('迁移失败时审计落 `schema-readonly`，且 from/current 各表一侧（可读出卡在哪）', async () => {
  const dir = env({ schemaVersion: 2 })
  const { ctx } = makeCtx()
  apply(ctx, { projectRoot: dir, mode: 'enforce' })
  // 🔴 E2（2026-09-29）把固定 sleep(80) 换成**轮询等待**：audit.record 是 fire-and-forget，
  //    固定等待在慢机器/负载下会偶发读不到（实测出现过一次 `types=[]` 的红，紧接着
  //    连跑 6 次又全不复现 —— 这是"间歇红"，比稳定红更危险：它会被当成噪声忽略）。
  //    轮询到出现即返回、超时才判红，且超时上限远大于原来的 80ms。
  const recs = await waitForAudit(dir, (rs) => rs.some((x) => x.type === 'schema-readonly'))
  const r = recs.find((x) => x.type === 'schema-readonly')
  assert(r, `应有 schema-readonly 记录，实际 types=${JSON.stringify(recs.map((x) => x.type))}`)
  assertEq(r.from, 2, 'from = 磁盘上的版本')
  assertEq(r.current, CURRENT, 'current = 本插件支持的版本（不是 sv.version，否则 from===current 读不出真相）')
  assert(String(r.note).includes('写入 fail-closed'), 'note 应说明封写不封读')
  rmSync(dir, { recursive: true, force: true })
})

ta('schema 正常时不写 schema-readonly（否则就是噪音）', async () => {
  const dir = env()
  const { ctx } = makeCtx()
  apply(ctx, { projectRoot: dir, mode: 'enforce' })
  await sleep(80)
  assert(!readAudit(dir).some((x) => x.type === 'schema-readonly'), '不该有 schema-readonly')
  rmSync(dir, { recursive: true, force: true })
})

// ================================================================ §3
section('[§3 只读守卫：写工具拒、读工具照常]')

/** 造一个降只读的 apply 环境。 */
function readOnlyEnv() {
  const dir = env({ schemaVersion: 2 })
  const { ctx, tools } = makeCtx()
  apply(ctx, { projectRoot: dir, mode: 'enforce' })
  return { dir, tools }
}

const WRITE_CALLS = [
  ['fde_memory_write_decision', { phase: '3', decision: '用 A 方案', source: 'plugin_inferred' }, '写入决策'],
  ['fde_memory_confirm', { phase: '3', decision: '用 A 方案', reason: '客户已确认' }, '逐条确认'],
  ['fde_memory_review', { file: '2026-09-28-design-review.md' }, '复核 note']
]

for (const [toolName, args, what] of WRITE_CALLS) {
  ta(`只读模式下 ${toolName} ⇒ throw MEMORY_SCHEMA_READ_ONLY（文案点名"${what}"）`, async () => {
    const { dir, tools } = readOnlyEnv()
    const tool = tools[toolName]
    assert(tool, `${toolName} 应已注册`)
    let threw = null
    try {
      await tool.execute(args, { callId: 'e3' })
    } catch (e) {
      threw = e
    }
    assert(threw, `${toolName} 应被拒`)
    assertEq(threw.code, 'MEMORY_SCHEMA_READ_ONLY', `${toolName} 的 code`)
    assert(String(threw.message).includes('只读模式'), '文案应说明只读模式，实际 ' + threw.message)
    assert(String(threw.message).includes(what), `文案应点名动作「${what}」，实际 ` + threw.message)
    assert(String(threw.message).includes('fde_memory_context'), '文案应指路读工具（数据不扣人质），实际 ' + threw.message)
    assert(String(threw.message).includes('SCHEMA_VERSION'), '文案应给出修法，实际 ' + threw.message)
    rmSync(dir, { recursive: true, force: true })
  })
}

ta('只读模式下 fde_memory_context **照常可用**（这正是 spec 要的"数据不扣人质"）', async () => {
  const { dir, tools } = readOnlyEnv()
  const tool = tools.fde_memory_context
  assert(tool, 'context 工具应已注册')
  let threw = null
  let res = null
  try {
    res = await tool.execute({ phase: '3' }, { callId: 'e3' })
  } catch (e) {
    threw = e
  }
  assert(!threw, `只读模式下 context 不应抛错，实际：${threw && threw.message}`)
  assert(res && typeof res.text === 'string' && res.text.length > 0, 'context 应返回非空 text')
  rmSync(dir, { recursive: true, force: true })
})

ta('只读守卫发生在任何写动作**之前**（decisions 目录保持空 = 没落盘）', async () => {
  const { dir, tools } = readOnlyEnv()
  let threw = null
  try {
    await tools.fde_memory_write_decision.execute(
      { phase: '3', decision: '不该落盘', source: 'plugin_inferred' },
      { callId: 'e3' }
    )
  } catch (e) {
    threw = e
  }
  assert(threw, '应被拒')
  const d = join(dir, 'memory', 'decisions')
  assertEq(existsSync(d) ? readdirSync(d) : [], [], 'decisions 目录应保持空')
  rmSync(dir, { recursive: true, force: true })
})

// ================================================================ §4
section('[§4 边界：非只读时不拦写]')

ta('schema 正常 ⇒ write_decision 正常写入，不因只读被拒', async () => {
  const dir = env()
  const { ctx, tools } = makeCtx()
  apply(ctx, { projectRoot: dir, mode: 'enforce' })
  let threw = null
  try {
    await tools.fde_memory_write_decision.execute(
      { phase: '3', decision: '正常写入', source: 'plugin_inferred' },
      { callId: 'e3' }
    )
  } catch (e) {
    threw = e
  }
  assert(!threw, `非只读时不该抛错，实际：${threw && threw.message}`)
  rmSync(dir, { recursive: true, force: true })
})

ta('非只读下 confirm 走 approval 通道（离线 unavailable ⇒ 拒），但**不是**只读码', async () => {
  const dir = env()
  const { ctx, tools } = makeCtx()
  apply(ctx, { projectRoot: dir, mode: 'enforce' })
  let threw = null
  try {
    await tools.fde_memory_confirm.execute({ phase: '3', decision: 'x', reason: 'y' }, { callId: 'e3' })
  } catch (e) {
    threw = e
  }
  assert(threw === null || threw.code !== 'MEMORY_SCHEMA_READ_ONLY', `不该是只读拒绝，实际 ${threw && threw.code}`)
  rmSync(dir, { recursive: true, force: true })
})

ta('readOnly 未传（installMemoryTools 三参老调用方）⇒ 不拦', async () => {
  const dir = env()
  const { ctx, tools } = makeCtx()
  // 绕过 apply，直接三参调用 —— 锁住「新增第四参数不破坏老调用方」这条兼容性
  const { installMemoryTools } = await import('../dsh-fde-memory/lib/tools.js')
  installMemoryTools(ctx, { projectRoot: dir, mode: 'enforce' }, null)
  let threw = null
  try {
    await tools.fde_memory_write_decision.execute(
      { phase: '3', decision: '三参调用方写入', source: 'plugin_inferred' },
      { callId: 'e3' }
    )
  } catch (e) {
    threw = e
  }
  assert(!threw, `三参调用下不该抛错，实际：${threw && threw.message}`)
  rmSync(dir, { recursive: true, force: true })
})

// ================================================================ 收尾
await Promise.all(pending)

if (process.env.FDE_INVERT === '1') {
  section('')
  t('[INVERT] 故意失败以验证退出码敏感', () => {
    assert(false, '故意失败')
  })
}

const out = []
out.push('== E3 schema 迁移失败降只读 offline ==')
for (const r of records) {
  if (r.header !== undefined) {
    out.push(r.header)
    continue
  }
  if (r.ok === null) {
    out.push(`  ! ${r.name}  （未完成：异步用例没被 await）`)
    continue
  }
  out.push(`  ${r.ok ? '✓' : '✗'} ${r.name}`)
  if (!r.ok) out.push(`      ${r.err}`)
}
out.push('')
out.push(`PASS ${passed} / FAIL ${failed}`)
out.push('RESULT: ' + (failed === 0 ? 'PASS' : 'FAIL'))
writeFileSync(OUT, out.join('\n') + '\n', 'utf8')
console.log(`[e3] ${passed} passed / ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
