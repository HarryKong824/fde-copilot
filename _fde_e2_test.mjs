/**
 * E2（spec v3 §7「探索沙箱 experiments/」）回归套件。
 *
 * spec 的四条要求 → 本套件逐条对应一组断言：
 *   ① 沙箱内容**不进入分层注入**   → E 组（往沙箱塞 note/state/checklist 形态文件，
 *                                    注入面输出必须**逐字不变**）。
 *   ② 沙箱 ontology 草稿**不参与 D1/D3** → E3（结构性：D1/D3 只读 ontologyRoot 的直接
 *                                    子文件，沙箱不在 ontologyRoot 内 ⇒ 交集为空）。
 *   ③ 合入走**正式 L0/L1/L2 通道**  → D 组（沙箱**没有**任何"提升"工具；写 ontology
 *                                    必须经 fde_ontology_write，直写被 gate 拒 = C 组）。
 *   ④ 沙箱内容**无审计要求**        → D9（写沙箱前后，真审计链字节数不变）。
 *
 * 🔴 本套件最重要的一组是 C 组：**豁免只在沙箱内生效，沙箱外一格不让**。
 *    每条"放行"断言都配一条同形的"仍然拒"断言（双向判据）——
 *    只有"放行成功"没有"别处仍被拒"的话，一个"把保护根整个关掉"的实现也能全绿。
 *
 * 跑法：node _fde_e2_test.mjs
 * 结果另写 `_e2_out.txt`（规避控制台代码页乱码）。`FDE_OUT` 可覆盖。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ 用命名空间取而非具名 import：具名 import 一个**尚不存在**的导出会让整个模块加载失败
//    ⇒ 红灯变成"崩溃"而非"断言失败"（`_gate_audit_guard_test.mjs` 的同款纪律）。
// 🔴 本套件**不** import gate 的 `config.js`：它 import `@deepseek-ai/schemastery`，
//    而工作区的桩只有 dsh-tools / dsh-llm ⇒ 整个模块加载失败、报告零产出。
//    （本项目的既有套件同样回避它。）代价与替代判据见 F 组 F3/F4 —— 不是"绕过去就算了"。
import * as pathsMod from './dsh-fde-ontology-gate/lib/paths.js'
import * as guardMod from './dsh-fde-ontology-gate/lib/guard.js'
import * as expMod from './dsh-fde-memory/lib/experiments.js'
import * as memToolsMod from './dsh-fde-memory/lib/tools.js'
import * as memConfigMod from './dsh-fde-memory/lib/config.js'
import { AuditChain } from './dsh-fde-memory/lib/audit.js'

const sandboxPathsOf = pathsMod.sandboxPathsOf
const assertSandboxSubdirs = pathsMod.assertSandboxSubdirs
const assertSandboxNotInOtherRoots = pathsMod.assertSandboxNotInOtherRoots
const formatProtectedRootsLine = pathsMod.formatProtectedRootsLine
const evaluateRules = guardMod.evaluateRules
const EXPERIMENTS_SUBDIR = expMod.EXPERIMENTS_SUBDIR
const installMemoryTools = memToolsMod.installMemoryTools
const CONTEXT_TOOL = memToolsMod.CONTEXT_TOOL

const HERE = dirname(fileURLToPath(import.meta.url))
const GATE_LIB = join(HERE, 'dsh-fde-ontology-gate', 'lib')
const OUT = process.env.FDE_OUT || join(HERE, '_e2_out.txt')
const lines = []
let passed = 0
let failed = 0

function check(name, ok, extra = '') {
  lines.push(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !extra ? '' : `\n      ${extra}`}`)
  ok ? passed++ : failed++
}

/** 抛错类断言：必须抛，且消息里含期望片段。没抛 = 红，抛了但消息不对 = 也红。 */
function checkThrows(name, fn, mustInclude) {
  try {
    fn()
    check(name, false, '（没有抛错 —— 期望 fail-closed 拒绝）')
  } catch (e) {
    const msg = String(e?.message ?? e)
    check(name, msg.includes(mustInclude), `实际消息：${msg}`)
  }
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))

// ── 布局：projectRoot(extra) / ontologyRoot / 审计目录，三者互不包含 ────────────
const base = mkdtempSync(join(tmpdir(), 'fde-e2-'))
const projectRoot = join(base, 'fde-state')
const ontologyRoot = join(base, 'ontology')
const auditDir = join(base, 'fde-audit')
for (const d of [projectRoot, ontologyRoot, auditDir]) mkdirSync(d, { recursive: true })
writeFileSync(join(projectRoot, 'SCHEMA_VERSION'), '1\n', 'utf8')
mkdirSync(join(projectRoot, 'memory'), { recursive: true })
writeFileSync(join(projectRoot, 'memory', 'state.yaml'), 'schema_version: 1\ncurrent_phase: "3"\nrevision: 1\n', 'utf8')

/**
 * 构造 gate 配置。
 *
 * 🔴 手写而**不**经 `normalizeConfig`：后者在 config.js 里，而 config.js import 不了
 *    schemastery（见文件头）。手写的代价是"字段会漂移"，由 F3/F4 两条断言兜住：
 *    F3 断言 normalizeConfig 真的调了两个沙箱校验函数（否则 B 组全绿而线上无效）；
 *    F4 断言这里列出的字段**覆盖** guard.js / paths.js 实际读到的每一个 `cfg.*`。
 */
const makeGateCfg = (extra = {}) => ({
  ontologyRoot,
  mode: 'enforce',
  denyRunCode: true,
  workspaceRoot: join(base, 'ws'),
  auditPath: '',
  allowedWriteSources: ['user', 'model'],
  minConfidence: 70,
  industry: '未声明',
  protectedExtraRoots: [projectRoot],
  sandboxSubdirs: [],
  maxConfirmPerCall: 50,
  ...extra
})
const gateCfg = makeGateCfg

const SANDBOX = join(projectRoot, EXPERIMENTS_SUBDIR)

/** 造一次路径工具的调用（走 GENERIC_PATH_KEYS 里的 file_path）。 */
const writeExec = (p) => ({ name: 'write', arguments: { file_path: p } })

// ═════════════════════════════════════════════════ A 组：沙箱派生面 ═════════════════════════════════════════════════
lines.push('A 组：sandboxPathsOf 的派生面（豁免只可能长在 extra 类根上）')

check(
  '[A1] sandboxSubdirs 为空 ⇒ 无沙箱（空 = 没有洞，不是"洞在默认位置"）',
  sandboxPathsOf(gateCfg()).length === 0,
  `实际 ${JSON.stringify(sandboxPathsOf(gateCfg()))}`
)
check(
  '[A2] 只从 protectedExtraRoots 派生：ontologyRoot 上的同名子目录**不**产生沙箱',
  (() => {
    const cfg = gateCfg({ sandboxSubdirs: [EXPERIMENTS_SUBDIR] })
    const boxes = sandboxPathsOf(cfg)
    return (
      boxes.length === 1 &&
      boxes[0].path === join(projectRoot, EXPERIMENTS_SUBDIR) &&
      !boxes.some((b) => b.path.startsWith(ontologyRoot))
    )
  })(),
  JSON.stringify(sandboxPathsOf(gateCfg({ sandboxSubdirs: [EXPERIMENTS_SUBDIR] })))
)
check(
  '[A3] 多条 extra 根 × 多个子目录名 ⇒ 笛卡尔积，每条都带自己的宿主 root',
  (() => {
    const r2 = join(base, 'second-state')
    mkdirSync(r2, { recursive: true })
    const boxes = sandboxPathsOf(
      gateCfg({ protectedExtraRoots: [projectRoot, r2], sandboxSubdirs: ['experiments', 'sandbox'] })
    )
    const want = new Set([
      join(projectRoot, 'experiments'),
      join(projectRoot, 'sandbox'),
      join(r2, 'experiments'),
      join(r2, 'sandbox')
    ])
    return boxes.length === 4 && boxes.every((b) => want.has(b.path)) && boxes.every((b) => b.path.startsWith(b.root))
  })(),
  JSON.stringify(sandboxPathsOf(gateCfg({ sandboxSubdirs: [EXPERIMENTS_SUBDIR] })))
)

// ═════════════════════════════════════════════════ B 组：加载期校验 ═════════════════════════════════════════════════
lines.push('')
lines.push('B 组：加载期 fail-closed（配错 = 插件不加载，而不是"以为堵上了、其实敞着"）')

checkThrows(
  '[B1] 子目录名含 .. ⇒ 加载期抛错（否则 join 出来就是保护根外的任意位置）',
  () => assertSandboxSubdirs(['../memory'], [projectRoot]),
  '单段'
)
checkThrows('[B2] 子目录名含 / ⇒ 加载期抛错', () => assertSandboxSubdirs(['a/b'], [projectRoot]), '单段')
checkThrows('[B3] 子目录名是绝对路径 ⇒ 加载期抛错', () => assertSandboxSubdirs([ontologyRoot], [projectRoot]), '单段')
checkThrows('[B4] 子目录名是空串 ⇒ 加载期抛错', () => assertSandboxSubdirs(['  '], [projectRoot]), '非空')
checkThrows(
  '[B5] sandboxSubdirs 非空但 protectedExtraRoots 为空 ⇒ 加载期抛错（沙箱没有宿主，配了也不生效）',
  () => assertSandboxSubdirs(['experiments'], []),
  'protectedExtraRoots 为空'
)
check(
  '[B5′] 对照组：sandboxSubdirs 为空数组时，protectedExtraRoots 为空**不**抛错（空沙箱是合法态）',
  (() => {
    try {
      assertSandboxSubdirs([], [])
      return true
    } catch {
      return false
    }
  })()
)
checkThrows(
  '[B6] 沙箱压在**审计目录**内 ⇒ 加载期抛错（否则等于在合规证据上开可写洞）',
  () => assertSandboxNotInOtherRoots(gateCfg({ auditPath: join(SANDBOX, 'x.jsonl'), sandboxSubdirs: [EXPERIMENTS_SUBDIR] })),
  '沙箱'
)
check(
  '[B6′] 对照组：同一份 cfg 去掉 sandboxSubdirs 后**不**抛错（证明 B6 拦的是"沙箱与审计重叠"这件事本身）',
  (() => {
    try {
      assertSandboxNotInOtherRoots(gateCfg({ auditPath: join(SANDBOX, 'x.jsonl') }))
      return true
    } catch {
      return false
    }
  })()
)

// ═════════════════════════════════════════════════ C 组：guard 真判定 ═════════════════════════════════════════════════
lines.push('')
lines.push('C 组：guard 路径兜底 —— 沙箱内放行 / 沙箱外一格不让（每条放行都配一条同形的"仍然拒"）')

const cfgBox = gateCfg({ sandboxSubdirs: [EXPERIMENTS_SUBDIR] })
const cfgNoBox = gateCfg()

const denyOf = (cfg, exec) => evaluateRules(exec, cfg, true)

check(
  '[C1] 写 <projectRoot>/experiments/x.yaml ⇒ 放行（无 deny、无 hits）',
  (() => {
    const r = denyOf(cfgBox, writeExec(join(SANDBOX, 'x.yaml')))
    return r.deny === undefined && (r.hits ?? []).length === 0
  })(),
  JSON.stringify(denyOf(cfgBox, writeExec(join(SANDBOX, 'x.yaml'))))
)
check(
  '[C2] 写 <projectRoot>/memory/state.yaml ⇒ 仍然拒（沙箱的兄弟目录一点没松）',
  (() => {
    const r = denyOf(cfgBox, writeExec(join(projectRoot, 'memory', 'state.yaml')))
    return typeof r.deny === 'string' && r.denyId === 'GATE-PATH'
  })(),
  JSON.stringify(denyOf(cfgBox, writeExec(join(projectRoot, 'memory', 'state.yaml'))))
)
check(
  '[C3] 写 <projectRoot>/SCHEMA_VERSION ⇒ 仍然拒（它在 projectRoot 根下，不在 memory/ 下）',
  (() => {
    const r = denyOf(cfgBox, writeExec(join(projectRoot, 'SCHEMA_VERSION')))
    return typeof r.deny === 'string' && r.denyId === 'GATE-PATH'
  })(),
  JSON.stringify(denyOf(cfgBox, writeExec(join(projectRoot, 'SCHEMA_VERSION'))))
)
check(
  '[C4] 写 <projectRoot>/experiments/../memory/state.yaml ⇒ 拒（穿越被 canonicalize 规范化挡回）',
  (() => {
    const r = denyOf(cfgBox, writeExec(join(SANDBOX, '..', 'memory', 'state.yaml')))
    return typeof r.deny === 'string' && r.denyId === 'GATE-PATH'
  })(),
  JSON.stringify(denyOf(cfgBox, writeExec(join(SANDBOX, '..', 'memory', 'state.yaml'))))
)
check(
  '[C5] 写 <projectRoot>/experiments-evil/x.yaml ⇒ 拒（前缀相似 ≠ 在内，比的是路径段）',
  (() => {
    const r = denyOf(cfgBox, writeExec(join(projectRoot, 'experiments-evil', 'x.yaml')))
    return typeof r.deny === 'string' && r.denyId === 'GATE-PATH'
  })(),
  JSON.stringify(denyOf(cfgBox, writeExec(join(projectRoot, 'experiments-evil', 'x.yaml'))))
)
check(
  '[C6] 沙箱内建符号链接指向 memory/ ⇒ 写 experiments/link/state.yaml 仍被拒（跟随链接=逃逸）',
  (() => {
    mkdirSync(SANDBOX, { recursive: true })
    const link = join(SANDBOX, 'link')
    try {
      if (existsSync(link)) rmSync(link, { recursive: true, force: true })
      symlinkSync(join(projectRoot, 'memory'), link, 'junction')
    } catch {
      return false // 建不出符号链接（权限）⇒ 本断言判红，不静默跳过
    }
    const r = denyOf(cfgBox, writeExec(join(link, 'state.yaml')))
    const ok = typeof r.deny === 'string' && r.denyId === 'GATE-PATH'
    rmSync(link, { recursive: true, force: true })
    return ok
  })(),
  JSON.stringify(denyOf(cfgBox, writeExec(join(SANDBOX, 'link', 'state.yaml'))))
)
check(
  '[C7] 对照组：sandboxSubdirs=[] 时写 experiments/x.yaml ⇒ **拒**（证明豁免来自配置，不是"本来就不拦"）',
  (() => {
    const r = denyOf(cfgNoBox, writeExec(join(SANDBOX, 'x.yaml')))
    return typeof r.deny === 'string' && r.denyId === 'GATE-PATH'
  })(),
  JSON.stringify(denyOf(cfgNoBox, writeExec(join(SANDBOX, 'x.yaml'))))
)
check(
  '[C8] 写 <ontologyRoot>/experiments/x.yaml ⇒ 拒（ontology 类根拿不到豁免 —— 结构性收窄）',
  (() => {
    const r = denyOf(cfgBox, writeExec(join(ontologyRoot, EXPERIMENTS_SUBDIR, 'x.yaml')))
    return typeof r.deny === 'string' && r.denyId === 'GATE-PATH'
  })(),
  JSON.stringify(denyOf(cfgBox, writeExec(join(ontologyRoot, EXPERIMENTS_SUBDIR, 'x.yaml'))))
)
check(
  '[C9] shell 形式：command 里带沙箱路径 ⇒ 放行；带 memory 路径 ⇒ 拒（两条都判，双向）',
  (() => {
    const okBox = denyOf(cfgBox, { name: 'pwsh', arguments: { command: `echo hi > "${join(SANDBOX, 'x.txt')}"` } })
    const noBox = denyOf(cfgBox, { name: 'pwsh', arguments: { command: `echo hi > "${join(projectRoot, 'memory', 'state.yaml')}"` } })
    return okBox.deny === undefined && typeof noBox.deny === 'string' && noBox.denyId === 'GATE-PATH'
  })(),
  JSON.stringify([
    denyOf(cfgBox, { name: 'pwsh', arguments: { command: `echo hi > "${join(SANDBOX, 'x.txt')}"` } }),
    denyOf(cfgBox, { name: 'pwsh', arguments: { command: `echo hi > "${join(projectRoot, 'memory', 'state.yaml')}"` } })
  ])
)

// ═════════════════════════════════════════════════ D 组：memory 沙箱工具（真定义） ═════════════════════════════════════════════════
lines.push('')
lines.push('D 组：fde_experiment_* 三个工具（取 apply 注册的**真定义**，不是直接调模块函数）')

const registered = new Map()
const auditPath = join(auditDir, 'events.jsonl')
const audit = new AuditChain(auditPath)
const memCtx = {
  logger: { info() {}, warn() {} },
  tools: {
    register(def) {
      if (def && def.name) registered.set(def.name, def)
      return () => {}
    }
  },
  on() {
    return () => {}
  },
  effect(fn) {
    let d
    try {
      d = typeof fn === 'function' ? fn() : undefined
    } catch {
      /* 安装失败不崩 */
    }
    return () => {
      if (typeof d === 'function') d()
    }
  }
}
// 走插件自己的 normalizeConfig 补默认值 —— 不手抄默认值（手抄的那份会随版本漂移）。
const memCfg = memConfigMod.normalizeConfig({ projectRoot, mode: 'enforce' })
installMemoryTools(memCtx, memCfg, audit, null)

const W = registered.get('fde_experiment_write')
const R = registered.get('fde_experiment_read')
const L = registered.get('fde_experiment_list')

check(
  '[D0] 三个沙箱工具都注册了（write / read / list）',
  Boolean(W) && Boolean(R) && Boolean(L),
  JSON.stringify([...registered.keys()])
)

check(
  '[D1] write → read 往返，内容逐字一致',
  await (async () => {
    if (!W || !R) return false
    const body = 'dose_mg 上限试验：150 应触发\n'
    const w = await W.execute({ name: 'ontology-drafts/dose.yaml', content: body }, {})
    const r = await R.execute({ name: 'ontology-drafts/dose.yaml' }, {})
    return w.bytes === Buffer.byteLength(body, 'utf8') && r.content === body
  })(),
  ''
)
check(
  '[D2] write 回执**不回显内容**（只有 name / bytes，与 ontology 写入的红线同款）',
  await (async () => {
    if (!W) return false
    const keys = Object.keys(await W.execute({ name: 'scratch-notes.md', content: 'secret-marker-zzz' }, {}))
    return keys.length === 2 && keys.includes('name') && keys.includes('bytes')
  })(),
  ''
)
check(
  '[D3] list 递归列出子目录条目（相对名带 / 前缀）',
  await (async () => {
    if (!L) return false
    const r = await L.execute({}, {})
    return (
      r.entries.some((e) => e.startsWith('scratch-notes.md')) &&
      r.entries.some((e) => e.startsWith('ontology-drafts/dose.yaml'))
    )
  })(),
  await (async () => (L ? JSON.stringify((await L.execute({}, {})).entries) : 'no-tool'))()
)
check(
  '[D4] 沙箱不存在 ⇒ list 返回空表且**不报错**（刚开始玩时沙箱本来就该是空的）',
  await (async () => {
    const emptyRoot = join(base, 'empty-state')
    mkdirSync(emptyRoot, { recursive: true })
    const r = expMod.listExperiments(emptyRoot)
    return r.entries.length === 0 && r.truncated === false
  })(),
  ''
)
checkThrows('[D5] 沙箱内 .. 段 ⇒ 拒（沙箱边界不可穿越）', () => expMod.resolveExperimentPath(projectRoot, '../memory/state.yaml'), '沙箱边界不可穿越')
checkThrows('[D6] 绝对路径 ⇒ 拒', () => expMod.resolveExperimentPath(projectRoot, join(projectRoot, 'memory', 'x.yaml')), '相对')
check(
  '[D7] 沙箱内符号链接 ⇒ 读写都拒（分段校验挡不住它，靠逐级 lstat）',
  (() => {
    const link = join(SANDBOX, 'evil-link')
    try {
      if (existsSync(link)) rmSync(link, { recursive: true, force: true })
      symlinkSync(join(projectRoot, 'memory'), link, 'junction')
    } catch {
      return false
    }
    let rejected = 0
    for (const fn of [
      () => expMod.resolveExperimentPath(projectRoot, 'evil-link/state.yaml'),
      () => expMod.writeExperiment(projectRoot, 'evil-link/x.yaml', 'x'),
      () => expMod.readExperiment(projectRoot, 'evil-link/state.yaml')
    ]) {
      try {
        fn()
      } catch {
        rejected++
      }
    }
    rmSync(link, { recursive: true, force: true })
    return rejected === 3
  })(),
  ''
)
checkThrows(
  '[D8] 内容超 256 KiB ⇒ 拒（fail-closed，不截断 —— 截断会让模型拿到"看起来完整"的半份草稿）',
  () => expMod.writeExperiment(projectRoot, 'big.md', 'x'.repeat(expMod.MAX_CONTENT_BYTES + 1)),
  '上限'
)
check(
  '[D9] 写沙箱**不落审计**（spec §7 第 4 条）：真审计链的字节数前后不变',
  await (async () => {
    // 先落一条真记录，让链文件存在且非空 —— 否则"0 字节不变"是因为链压根没写进去。
    await audit.record({ type: 'probe', note: 'e2-d9-baseline' })
    await settle()
    const before = existsSync(auditPath) ? readFileSync(auditPath).length : -1
    if (before <= 0) return false
    await W.execute({ name: 'no-audit-probe.md', content: 'should not be audited' }, {})
    await settle()
    const after = readFileSync(auditPath).length
    return after === before
  })(),
  ''
)

// ═════════════════════════════════════════════════ E 组：隔离的负面断言（E2 的核心） ═════════════════════════════════════════════════
lines.push('')
lines.push('E 组：隔离 —— 往沙箱里塞"看起来像正式记忆"的文件，注入面与 D1/D3 的输入必须**逐字不变**')

/** 在当前沙箱与 memory/ 两处各造一份同形文件，然后跑注入面。 */
async function contextOut() {
  const def = registered.get(CONTEXT_TOOL)
  if (!def) return null
  const out = []
  const value = await def.execute({ phase: '3' }, {})
  out.push(JSON.stringify(value))
  return out.join('\n')
}

const ctxBefore = await contextOut()
check(
  '[E1] 基线：注入面能跑出非空输出（否则后面的"不变"是"两边都是 null"这种假绿）',
  typeof ctxBefore === 'string' && ctxBefore.length > 2,
  String(ctxBefore).slice(0, 200)
)

// 往沙箱塞四类"看起来像正式记忆"的文件
mkdirSync(join(SANDBOX, 'notes'), { recursive: true })
mkdirSync(join(SANDBOX, 'checklist'), { recursive: true })
mkdirSync(join(SANDBOX, 'ontology'), { recursive: true })
writeFileSync(join(SANDBOX, 'notes', '2026-09-29-fake.md'), '---\ndate: 2026-09-29\ntitle: 沙箱假 note\n---\n不该出现在注入面\n', 'utf8')
writeFileSync(join(SANDBOX, 'state.yaml'), 'current_phase: "9"\nrevision: 999\n', 'utf8')
writeFileSync(join(SANDBOX, 'checklist', '3.yaml'), 'items:\n  - id: fake\n    done: true\n', 'utf8')
writeFileSync(join(SANDBOX, 'stakeholders.yaml'), 'stakeholders:\n  - name: 沙箱假人\n', 'utf8')
writeFileSync(join(SANDBOX, 'ontology', 'objects.yaml'), 'objects:\n  - id: fake_object\n', 'utf8')

const ctxAfter = await contextOut()
check(
  '[E2] 沙箱里塞了 note / state.yaml / checklist / stakeholders ⇒ 注入面输出**逐字不变**',
  typeof ctxAfter === 'string' && ctxAfter === ctxBefore,
  `before=${String(ctxBefore).slice(0, 300)}\n      after =${String(ctxAfter).slice(0, 300)}`
)
// 🔴 E3 的观测点必须是**输出里真的会变的东西**。
//    本断言原写法是「输出里的 phase 仍是 3、不是沙箱里的 9」—— 而注入面**根本不回显 phase 值**
//    （只有 "[L1] 本 Phase checklist" 这样的层名）⇒ `!includes('"9"')` **恒真**，
//    测不到任何东西（与"恒真判据"同型）。改用 [L5] notes 这个**真的会显示文件名**的观测点，
//    并把"同一份文件放进正式位置 ⇒ 立刻显示"作为**正面对照** ——
//    否则"沙箱里的不显示"完全可能只是因为 [L5] 这条路本来就是死的。
const fakeNote = '2026-09-29-fake.md'
mkdirSync(join(projectRoot, 'memory', 'notes'), { recursive: true })
writeFileSync(
  join(projectRoot, 'memory', 'notes', '2026-09-29-real.md'),
  readFileSync(join(SANDBOX, 'notes', fakeNote), 'utf8'),
  'utf8'
)
const ctxWithReal = await contextOut()
check(
  '[E3] 同一份 note 放沙箱 ⇒ [L5] 不显示；放进 memory/notes/ ⇒ [L5] 立刻显示（前半证隔离，后半证观测点不是死的）',
  typeof ctxAfter === 'string' &&
    !ctxAfter.includes(fakeNote) &&
    typeof ctxWithReal === 'string' &&
    ctxWithReal.includes('2026-09-29-real.md'),
  `沙箱态：${String(ctxAfter).slice(0, 240)}\n      正式态：${String(ctxWithReal).slice(0, 240)}`
)

// D1/D3 的输入面：结构性判据（比"我没看到"强）
const dslFiles = { objects: 'objects.yaml', logic: 'logic.yaml', actions: 'actions.yaml', guards: 'guards.yaml', maturity: 'maturity.yaml' }
check(
  '[E4] D1/D3 的输入路径全部由 ontologyRoot 直接拼出，且与任何沙箱**无交集**（结构性，不靠"我没看到"）',
  (() => {
    const boxes = sandboxPathsOf(cfgBox).map((b) => b.path)
    return Object.values(dslFiles).every((f) => {
      const p = join(ontologyRoot, f)
      return boxes.every((b) => !p.startsWith(b + '\\') && !p.startsWith(b + '/') && p !== b)
    })
  })(),
  JSON.stringify(sandboxPathsOf(cfgBox))
)
check(
  '[E5] D1/D3 的文件名都是**单段**名（不含分隔符）⇒ join(ontologyRoot, name) 永远是 ontologyRoot 的直接子文件，不可能是沙箱里的东西',
  Object.values(dslFiles).every((f) => !f.includes('/') && !f.includes('\\')),
  JSON.stringify(dslFiles)
)

// ═════════════════════════════════════════════════ F 组：跨插件 / 部署实况对拍 ═════════════════════════════════════════════════
lines.push('')
lines.push('F 组：跨插件一致性 —— 对**部署实况**对拍，不是对源码常量自说自话')

// ⚠️ F1/F2 判的是「**部署实况** ↔ 源码常量」，没有部署就没有可比对象 ⇒ 它们**不是纯离线断言**。
//    旧写法在文件不存在时让 profileText 变空串 ⇒ 两条判红，把「没得比」说成了「不一致」。
//    现在：本机没有部署就**明确跳过并报条数**，退出码 77（由 _run_all_tests.sh 计入 SKIP）。
//    设 FDE_DSH_HOME 指向你的 dsh-home 即可跑。
const DSH_HOME = process.env.FDE_DSH_HOME ?? 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home'
const PROFILE = join(DSH_HOME, 'profiles/web/cordis.patch.yml')
const profileText = existsSync(PROFILE) ? readFileSync(PROFILE, 'utf8') : ''
const dshSkipped = profileText ? 0 : 2
if (dshSkipped) {
  lines.push('')
  lines.push(`⚠️ 跳过 ${dshSkipped} 条：本机没有部署实况可对拍（${PROFILE} 不存在）`)
  lines.push('   F1/F2 判的是「部署配置 ↔ 源码常量」，没有部署就没有可比对象。')
  lines.push('   设 FDE_DSH_HOME 指向你的 dsh-home 即可跑；本套件随后以退出码 77 收尾（= 跳过）。')
} else {
  check(
    '[F1] 部署配置里 gate 的 sandboxSubdirs 含 EXACTLY 一个值，且 === memory 的 EXPERIMENTS_SUBDIR',
    (() => {
      const m = profileText.match(/sandboxSubdirs:\s*\[([^\]]*)\]/)
      if (!m) return false
      const names = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
      return names.length === 1 && names[0] === EXPERIMENTS_SUBDIR
    })(),
    `EXPERIMENTS_SUBDIR=${JSON.stringify(EXPERIMENTS_SUBDIR)}，配置片段=${JSON.stringify((profileText.match(/sandboxSubdirs:[^\n]*/) ?? ['（没找到）'])[0])}`
  )
  check(
    '[F2] 部署配置里 protectedExtraRoots[0] === memory 的 projectRoot（同一锚点，不可能各自漂移）',
    (() => {
      const m = profileText.match(/protectedExtraRoots:\s*\[\s*&fde_state_root\s*'([^']+)'/)
      const m2 = profileText.match(/id:\s*dsh-fde-memory[\s\S]{0,400}?projectRoot:\s*(\*fde_state_root|'([^']+)')/)
      if (!m) return false
      return Boolean(m2) && (m2[1] === '*fde_state_root' || m2[2] === m[1])
    })(),
    JSON.stringify((profileText.match(/protectedExtraRoots:[^\n]*/) ?? ['（没找到）'])[0])
  )
}

// F3/F4：本套件绕开了 config.js（schemastery 无桩 ⇒ 加载不了），这两条是**代价的补丁**。
const gateConfigSrc = readFileSync(join(GATE_LIB, 'config.js'), 'utf8')
check(
  '[F3] normalizeConfig **真的调了**两个沙箱校验（否则 B 组全绿而线上毫无作用 —— 静态断言，可被变异证伪）',
  gateConfigSrc.includes('assertSandboxSubdirs(') && gateConfigSrc.includes('assertSandboxNotInOtherRoots('),
  'config.js 里没有这两个调用'
)
const cfgFieldSources = ['guard.js', 'paths.js'].map((f) => readFileSync(join(GATE_LIB, f), 'utf8')).join('\n')
check(
  '[F4] 本套件手写的 cfg **覆盖** guard.js / paths.js 读到的每一个 `cfg.*` 字段（防手写 cfg 漂移）',
  (() => {
    const used = new Set([...cfgFieldSources.matchAll(/\bcfg\??\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))
    const mine = new Set(Object.keys(makeGateCfg()))
    const missing = [...used].filter((k) => !mine.has(k))
    return missing.length === 0
  })(),
  (() => {
    const used = new Set([...cfgFieldSources.matchAll(/\bcfg\??\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))
    const mine = new Set(Object.keys(makeGateCfg()))
    return `缺：${JSON.stringify([...used].filter((k) => !mine.has(k)))}；我用到的：${JSON.stringify([...mine])}`
  })()
)
lines.push('')
lines.push('G 组：启动打印 —— 一个配错的沙箱在运行期毫无症状，必须靠启动那行字可见')

const lineWith = formatProtectedRootsLine(cfgBox)
const lineWithout = formatProtectedRootsLine(cfgNoBox)
check(
  '[G1] 开了沙箱 ⇒ 打印行含沙箱路径与宿主 root',
  lineWith.includes(SANDBOX) && lineWith.includes(projectRoot) && lineWith.includes('沙箱'),
  JSON.stringify(lineWith)
)
check(
  '[G2] 没开沙箱 ⇒ 打印行**不含**"沙箱"字样（双向判据：防"总是打印一行沙箱"这种假绿）',
  !lineWithout.includes('沙箱'),
  JSON.stringify(lineWithout)
)

// ── 收尾 ────────────────────────────────────────────────────────────────────
lines.push('')
lines.push(`通过 ${passed} / 失败 ${failed}${dshSkipped ? ` / 跳过 ${dshSkipped}（本机无部署实况）` : ''}`)
if (failed > 0) {
  // ⚠️ 先 filter 再 push：边遍历 lines 边往 lines 里 push 是死循环。
  const reds = lines.filter((l) => l.includes('✗ '))
  lines.push('')
  lines.push('红名单：')
  for (const l of reds) lines.push(`  - ${l.trim().slice(2)}`)
}
writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(`[e2-test] 通过 ${passed} / 失败 ${failed}${dshSkipped ? `，跳过 ${dshSkipped}（本机无部署实况）` : ''} ⇒ ${OUT}`)
// 退出码优先级：**失败 > 跳过 > 0**（坏消息优先 —— 有红就不能用"跳过"盖住）
process.exitCode = failed > 0 ? 1 : dshSkipped > 0 ? 77 : 0
