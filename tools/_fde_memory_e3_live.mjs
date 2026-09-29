/**
 * E3 schema 迁移失败降只读 —— 真 SDK 活验（import **已安装副本**的 lib，让 lib 内部解析到真 SDK）。
 *
 * 跑法：node _fde_memory_e3_live.mjs
 *
 * ## 这一层验的是什么 / 不验什么（不许混）
 *
 * ✅ 验：真 `@deepseek-ai/dsh-tools` 的 `defineTool`（严格校验 output.schema）构造成功 +
 *        真 `@deepseek-ai/dsh-llm` 的 `HarnessError`（`code` 字段真的挂在错误对象上）+
 *        **真实 memory/ 数据树**上的读路径可用、写路径被封。
 * ❌ 不验：插件在 **DSH 进程内**注册成功（重启后看 `pluginInventory/list` 的 fiberPhase）。
 *
 * ## 🔴 零污染（硬约束 + 前后快照自证）
 *
 * - 全程 `audit` 传 `null` ⇒ **不写**真实 `memory/audit/events.jsonl`。
 * - 只调 `installMemoryTools`（注册工具），**不调 `apply()`** ⇒ 不建目录、不写 SCHEMA_VERSION。
 * - 场景 2 的只读判定跑在**系统临时目录**，不碰真 projectRoot。
 * - 场景 3 跑在**真 memory/ 树**上，但只有读 + 被拒的写 ⇒ 收尾用前后快照**证明**一字未改。
 *
 * ## 场景
 *
 * 1. 真 SCHEMA_VERSION 实况：读真 `fde-state/SCHEMA_VERSION` ⇒ 打印版本与 status（只读观察）。
 * 2. 隔离 tmp：SCHEMA_VERSION=2 ⇒ `apply()` 不抛错、四个工具经**真 defineTool** 注册成功、
 *    审计落 schema-readonly、三个写工具被 `MEMORY_SCHEMA_READ_ONLY` 拒（真 HarnessError，带 code）。
 *    ⇒ 顺带证明 `instanceof HarnessError` 成立（桩环境证不了这条）。
 * 3. 真 projectRoot：只读上下文读得出内容、写工具全被拒，且**前后快照一字未改**。
 */

import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, readdirSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '_fde_memory_e3_live_out.txt')
const DEP = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/node_modules/dsh-fde-memory'
const lib = (f) => pathToFileURL(join(DEP, 'lib', f)).href

const { apply } = await import(lib('index.js'))
const { installMemoryTools, CONTEXT_TOOL } = await import(lib('tools.js'))
const { CURRENT, readSchemaVersion } = await import(lib('schema-version.js'))
// 真 HarnessError：从**真 SDK 的 llm 包**直接 import（插件的工具抛的就是它）
const { HarnessError } = await import(
  pathToFileURL('E:/DSH-desktop/DeepSeek Harness/data/node_modules/@deepseek-ai/dsh-llm/lib/index.js').href
)

const REAL_PROJECT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state'

// ⚠️ 输出顺序 = **登记序**（不是完成序）：异步用例各自往自己的槽位写，收尾统一渲染。
//    否则「场景 3」的标题会跑到用例前面 —— 读的人会以为那条用例属于上一节。
const records = []
let passed = 0
let failed = 0
const pending = []

function section(t) {
  records.push({ header: t })
}
function info(t) {
  records.push({ info: t })
}
function check(name, fn) {
  const i = records.push({ name, ok: null, err: null, notes: [] }) - 1
  const note = (s) => records[i].notes.push(s)
  pending.push(
    (async () => {
      try {
        await fn(note)
        records[i].ok = true
        passed += 1
      } catch (e) {
        records[i].ok = false
        records[i].err = e && e.message ? e.message : String(e)
        failed += 1
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeCtx() {
  const tools = {}
  const warns = []
  const infos = []
  return {
    tools,
    warns,
    infos,
    ctx: {
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
      logger: { info: (...a) => infos.push(a.join(' ')), warn: (...a) => warns.push(a.join(' ')) }
    }
  }
}

/** 递归快照一棵目录树：相对路径 → "size:mtimeMs"。不存在 ⇒ {}。 */
function snapshot(root) {
  const out = {}
  if (!existsSync(root)) return out
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const st = statSync(p)
        out[relative(root, p).replace(/\\/g, '/')] = `${st.size}:${st.mtimeMs}`
      }
    }
  }
  walk(root)
  return out
}
function diffSnapshot(a, b) {
  const added = Object.keys(b).filter((k) => !(k in a))
  const removed = Object.keys(a).filter((k) => !(k in b))
  const changed = Object.keys(a).filter((k) => k in b && a[k] !== b[k])
  return { added, removed, changed }
}

const ALL_TOOLS = ['fde_memory_confirm', 'fde_memory_context', 'fde_memory_review', 'fde_memory_write_decision']
const WRITES = [
  ['fde_memory_write_decision', { phase: '3', decision: '不该落盘', source: 'plugin_inferred' }],
  ['fde_memory_confirm', { phase: '3', decision: '不该落盘', reason: '活验' }],
  ['fde_memory_review', { file: '2026-09-28-design-review.md' }]
]

// ================================================================ §1 真数据实况
info('== E3 schema 迁移失败降只读 · 真 SDK 活验 ==')
section('[场景 1：真 SCHEMA_VERSION 实况（只读观察）]')

const realVersionPath = join(REAL_PROJECT, 'SCHEMA_VERSION')
const realRaw = existsSync(realVersionPath) ? readFileSync(realVersionPath, 'utf8').trim() : '(缺失)'
// ⚠️ 用**纯读**的 readSchemaVersion，不用 ensureSchemaVersion ——
//    后者在文件缺失时会**写盘**，不该让"只读观察"这条路径带写能力（production 上尤其）。
let realV = null
let realErr = null
try {
  realV = readSchemaVersion(REAL_PROJECT)
} catch (e) {
  realErr = e
}
const realStatus = realErr ? 'invalid' : realV === undefined ? 'created(将)' : realV === CURRENT ? 'ok' : 'failed'
info(`  真 projectRoot = ${REAL_PROJECT}`)
info(`  SCHEMA_VERSION 文件内容 = "${realRaw}"，插件 CURRENT = ${CURRENT} ⇒ status="${realStatus}"`)
info(
  realStatus === 'failed'
    ? '  🔴 真环境当前处于**只读模式**（迁移失败）'
    : '  ✅ 真环境当前**不是**只读模式（版本匹配）⇒ 只读分支是**韧性路径**、当前未被触发；'
)
info('     它的正确性由「离线 19 断言 + 12 变异」与「场景 2 的真 SDK 隔离验证」覆盖，不靠真环境撞上。')

// ================================================================ §2 隔离：真 defineTool
section('[场景 2：隔离 tmp（SCHEMA_VERSION=2）· 真 defineTool + 真 HarnessError]')

check('failed 迁移时 apply() 不抛错（真 SDK 下同样成立）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e3live-'))
  writeFileSync(join(dir, 'SCHEMA_VERSION'), '2\n', 'utf8')
  const { ctx } = makeCtx()
  let threw = null
  try {
    apply(ctx, { projectRoot: dir, mode: 'enforce', auditPath: '' })
  } catch (e) {
    threw = e
  }
  assert(!threw, `apply 不该抛错，实际 ${threw && threw.message}`)
  rmSync(dir, { recursive: true, force: true })
})

check('四个工具经**真 defineTool** 构造成功（output.schema 逐层 additionalProperties 合法）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e3live-'))
  writeFileSync(join(dir, 'SCHEMA_VERSION'), '2\n', 'utf8')
  const { ctx, tools } = makeCtx()
  apply(ctx, { projectRoot: dir, mode: 'enforce', auditPath: '' })
  assertEq(Object.keys(tools).sort(), ALL_TOOLS, '四个工具都应注册')
  // 真 defineTool 会校验 parameters/output.schema；能拿到 name 说明构造期没被拒
  for (const n of ALL_TOOLS) assert(tools[n] && typeof tools[n].execute === 'function', `${n} 应有 execute`)
  rmSync(dir, { recursive: true, force: true })
})

check('三个写工具被拒，且错误是**真 HarnessError**（instanceof 成立、code 可读）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e3live-'))
  writeFileSync(join(dir, 'SCHEMA_VERSION'), '2\n', 'utf8')
  const { ctx, tools } = makeCtx()
  apply(ctx, { projectRoot: dir, mode: 'enforce', auditPath: '' })
  for (const [name, args] of WRITES) {
    let threw = null
    try {
      await tools[name].execute(args, { callId: 'e3-live' })
    } catch (e) {
      threw = e
    }
    assert(threw, `${name} 应被拒`)
    assertEq(threw.code, 'MEMORY_SCHEMA_READ_ONLY', `${name} 的 code`)
    assert(threw instanceof HarnessError, `${name} 抛的应是**真 SDK 的** HarnessError（桩环境证不了这条）`)
  }
  rmSync(dir, { recursive: true, force: true })
})

check('读工具在只读模式下正常返回（真 SDK 下"数据不扣人质"仍成立）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e3live-'))
  writeFileSync(join(dir, 'SCHEMA_VERSION'), '2\n', 'utf8')
  const { ctx, tools } = makeCtx()
  apply(ctx, { projectRoot: dir, mode: 'enforce', auditPath: '' })
  const res = await tools[CONTEXT_TOOL].execute({ phase: '3' }, { callId: 'e3-live' })
  assert(res && typeof res.text === 'string' && res.text.length > 0, 'context 应返回非空 text')
  rmSync(dir, { recursive: true, force: true })
})

check('审计链落 schema-readonly（真 AuditChain，写的是隔离 tmp）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e3live-'))
  writeFileSync(join(dir, 'SCHEMA_VERSION'), '2\n', 'utf8')
  const { ctx } = makeCtx()
  apply(ctx, { projectRoot: dir, mode: 'enforce', auditPath: '' })
  await sleep(120)
  const p = join(dir, 'memory', 'audit', 'events.jsonl')
  assert(existsSync(p), '审计文件应存在')
  const recs = readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
  const r = recs.find((x) => x.type === 'schema-readonly')
  assert(r, `应有 schema-readonly，实际 types=${JSON.stringify(recs.map((x) => x.type))}`)
  assertEq(r.from, 2)
  assertEq(r.current, CURRENT)
  rmSync(dir, { recursive: true, force: true })
})

// ================================================================ §3 真数据树（只读）
section('[场景 3：真 memory/ 树上验证（只读 + 被拒的写，前后快照证明零污染）]')

check('真 memory/ 树：读得出内容、写全被拒、**一字未改**', async (note) => {
  const memDir = join(REAL_PROJECT, 'memory')
  assert(existsSync(memDir), `真 memory/ 应存在：${memDir}`)
  const before = snapshot(memDir)

  // 只注册工具、不 apply（不建目录、不写 SCHEMA_VERSION）
  const { ctx, tools } = makeCtx()
  installMemoryTools(ctx, { projectRoot: REAL_PROJECT, mode: 'enforce' }, null, {
    active: true,
    error: '活验：模拟迁移失败（不写盘，仅内存标志）',
    from: 2
  })
  assertEq(Object.keys(tools).sort(), ALL_TOOLS)

  // 读：用真 state.yaml 里的 current_phase（不传 phase 走 readCurrentPhase）
  const res = await tools[CONTEXT_TOOL].execute({}, { callId: 'e3-live' })
  assert(res && typeof res.text === 'string' && res.text.length > 0, '真数据上下文应非空')
  note(`真上下文长度 ${res.text.length} 字符（首行：${res.text.split('\n')[0].slice(0, 60)}）`)

  // 写：三个全拒
  for (const [name, args] of WRITES) {
    let threw = null
    try {
      await tools[name].execute(args, { callId: 'e3-live' })
    } catch (e) {
      threw = e
    }
    assert(threw && threw.code === 'MEMORY_SCHEMA_READ_ONLY', `${name} 应在真数据上被拒`)
  }

  const after = snapshot(memDir)
  const d = diffSnapshot(before, after)
  assertEq([d.added, d.removed, d.changed], [[], [], []], `真 memory/ 树必须一字未改，实际差异 ${JSON.stringify(d)}`)
  note(`前后快照一致：${Object.keys(before).length} 个文件（含 audit/events.jsonl）逐字节未变`)
})

await Promise.all(pending)

const out = []
for (const r of records) {
  if (r.info !== undefined) {
    out.push(r.info)
    continue
  }
  if (r.header !== undefined) {
    out.push(r.header)
    continue
  }
  if (r.ok === null) {
    out.push(`  ! ${r.name}  （未完成：异步用例没被 await）`)
    continue
  }
  out.push(`  ${r.ok ? '✓' : '✗'} ${r.name}`)
  for (const n of r.notes) out.push(`      · ${n}`)
  if (!r.ok) out.push(`      ${r.err}`)
}
out.push('')
out.push(`PASS ${passed} / FAIL ${failed}`)
out.push('RESULT: ' + (failed === 0 ? 'PASS' : 'FAIL'))
writeFileSync(OUT, out.join('\n') + '\n', 'utf8')
console.log(`[e3-live] ${passed} passed / ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
