/**
 * 上线前预检 —— 用 **真实的** `@deepseek-ai/dsh-tools` 跑一遍工具注册 + schema 校验。
 *
 * ## 为什么非得有这个脚本
 * 离线回归（`_fde_phase_test.mjs`）里的 `@deepseek-ai/dsh-tools` 是**工作区根的本地桩**：
 * `defineTool = (def) => def` —— 恒等函数，零 schema 校验。
 * 于是"离线 import 成功"**推不出**"工具能在 DSH 里注册成功"。
 *
 * 真实 SDK 会在 `defineTool()` 里逐层校验输出 schema：
 * 每一层 `type: 'object'` 都必须显式声明 `additionalProperties`，
 * 否则同步抛 `unsupported JSON schema: schema.properties.<x>.additionalProperties
 * must be explicitly true or false`。
 *
 * 那个抛错发生在插件 `apply()` 里 → **插件加载即失败** → 工具根本注册不上，
 * 重启只会得到一个 `fiberPhase: failed` 的条目。
 *
 * ## 怎么跑
 * **必须在"已安装副本"目录里跑**，不能在工作区源目录跑：
 * 只有副本那条 node_modules 链解析得到真 SDK，工作区解析到的是桩。
 *
 * ```powershell
 * cd "<DSH_HOME>\profiles\web\node_modules\dsh-fde-phase"
 * node precheck.mjs
 * ```
 *
 * 退出码：`0` 全部通过；`2` 跑在桩环境（位置不对，结论无效）；`3` 注册/校验失败。
 */

import { createRequire } from 'node:module'
import { normalizeConfig } from './lib/config.js'
import { AuditChain } from './lib/audit.js'
import { D1Mirror } from './lib/mirror.js'
import { installPhaseTool, installAuditCheckTool, installRollbackTool, installChangeCloseTool, PHASE_ADVANCE_TOOL, AUDIT_CHECK_TOOL, ROLLBACK_TOOL, CHANGE_CLOSE_TOOL } from './lib/tools.js'
import { PHASE_IDS } from './lib/phases.js'

const require = createRequire(import.meta.url)

/** 解析到的 SDK 路径 —— 从路径就能先看出是真是桩。 */
let sdkPath = '(unresolved)'
let defineTool
try {
  sdkPath = require.resolve('@deepseek-ai/dsh-tools')
  ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch (e) {
  console.error('PRECHECK FAIL：解析不到 @deepseek-ai/dsh-tools ——', e?.message ?? e)
  process.exit(3)
}

console.log(`[1/4] SDK 路径：${sdkPath}`)

/**
 * 探针：喂一个**已知违规**的定义（嵌套 object 不写 additionalProperties）。
 * 真 SDK 会抛；桩是恒等函数，不抛。
 * @returns {{real: boolean, message?: string}}
 */
function probeRealSdk() {
  try {
    defineTool({
      name: '__fde_sdk_probe__',
      description: 'probe',
      parameters: {},
      output: { schema: { type: 'object', properties: { nested: { type: 'object' } } } },
      execute: async () => ({})
    })
    return { real: false }
  } catch (e) {
    return { real: true, message: String(e?.message ?? e) }
  }
}

const probe = probeRealSdk()
if (!probe.real) {
  console.error(
    '\nPRECHECK 无效：当前解析到的是**桩** defineTool（恒等函数、不校验 schema）。\n' +
      '这通常意味着你跑在了工作区源目录，而不是 DSH 的已安装副本目录。\n' +
      '请 cd 到 profiles\\web\\node_modules\\dsh-fde-phase 再跑 —— 只有那条路径能解析到真 SDK。\n' +
      `（当前解析：${sdkPath}）`
  )
  process.exit(2)
}
console.log(`[2/4] SDK 为真（会校验 schema）：探针抛错 = ${probe.message?.slice(0, 120)}`)

/** 最小 ctx 替身：只提供 installPhaseTool 真正用到的两个口子。 */
const registered = []
const ctx = {
  tools: {
    register(def) {
      registered.push(def)
      return () => {}
    }
  },
  effect(fn) {
    return fn()
  },
  logger: console
}

const cfg = normalizeConfig({
  projectRoot: process.env.FDE_PROJECT_ROOT ?? 'E:\\fde-project',
  ontologyRoot: process.env.FDE_ONTOLOGY_ROOT ?? 'E:\\ontologyRoot',
  // Stage 5.5 起的必填项：D2 要验的 gate 审计链。
  gateAuditPath:
    process.env.FDE_GATE_AUDIT_PATH ??
    'E:\\DSH-desktop\\DeepSeek Harness\\data\\dsh-home\\fde-audit\\gate.jsonl',
  mode: 'enforce'
})
console.log(`[3/4] 注册 ${PHASE_ADVANCE_TOOL}（projectRoot=${cfg.projectRoot}, mode=${cfg.mode}）`)

try {
  const audit = new AuditChain(cfg.auditPath)
  const mirror = new D1Mirror()
  installPhaseTool(ctx, cfg, audit, mirror)
  // D2 的工具也一起注册一遍 —— 它的输出 schema 同样要过真 SDK 的 additionalProperties 校验，
  // 而这一点在离线套件里被桩 SDK 掩盖了（桩的 defineTool 是恒等函数，不做任何校验）。
  installAuditCheckTool(ctx, cfg)
  // C3 的回滚工具也一起注册一遍（Stage 5.7 起）—— 同样要过真 SDK 的 schema 校验。
  installRollbackTool(ctx, cfg, audit)
  // C2 的变更闭环工具（2026-09-29 起）—— 同样要过真 SDK 的 schema 校验；
  // 它的 output.schema 有嵌套的 array/object，正是真 SDK 会挑毛病的地方。
  installChangeCloseTool(ctx, cfg, audit, mirror)
} catch (e) {
  console.error('\nPRECHECK FAIL：注册阶段抛错 ——', e?.message ?? e)
  console.error(
    '这条错误在 DSH 里会发生在 apply() 内 → 插件加载失败 → 工具注册不上。\n' +
      '修掉再重跑；不要带着它重启。'
  )
  process.exit(3)
}

const def = registered[0]
if (!def) {
  console.error('PRECHECK FAIL：register 没被调用')
  process.exit(3)
}

// ⚠️ 真 SDK 会把简写参数表（`{ to: {...}, reason: {...} }`）规范化成
// `{ type:'object', properties:{ to: {...}, reason: {...} } }` —— 清单要从 properties 里取。
const params = Object.keys(def.parameters?.properties ?? {})
console.log(`     已注册：name=${def.name}　参数清单=${JSON.stringify(params)}`)

if (
  params.length !== 4 ||
  !params.includes('to') ||
  !params.includes('reason') ||
  !params.includes('data_authorization') ||
  !params.includes('deidentification_plan')
) {
  console.error(
    `PRECHECK FAIL：参数清单应为 ['to','reason','data_authorization','deidentification_plan']，实际 ${JSON.stringify(params)}`
  )
  process.exit(3)
}

// `to` 必须是 15 个阶段 id 的 enum（保证模型不能随便传一个字符串跳过判定）。
const toEnum = def.parameters?.properties?.to?.enum
const enumOk = Array.isArray(toEnum) && toEnum.length === PHASE_IDS.length && PHASE_IDS.every((id) => toEnum.includes(id))
if (!enumOk) {
  console.error(`PRECHECK FAIL：to 的 enum 应为 15 个 Phase id，实际 ${JSON.stringify(toEnum)}`)
  process.exit(3)
}
console.log(`[4/4] 参数契约：to.enum = ${PHASE_IDS.length} 个阶段 id（${PHASE_IDS.join(',')}）`)

// ---- C2：fde_change_close 的契约（2026-09-29 起）----
const closeDef = registered.find((d) => d.name === CHANGE_CLOSE_TOOL)
if (!closeDef) {
  console.error(`PRECHECK FAIL：${CHANGE_CLOSE_TOOL} 没有注册上`)
  process.exit(3)
}
const closeParams = Object.keys(closeDef.parameters?.properties ?? {})
if (closeParams.length !== 1 || closeParams[0] !== 'reason') {
  console.error(`PRECHECK FAIL：${CHANGE_CLOSE_TOOL} 参数应为 ['reason']，实际 ${JSON.stringify(closeParams)}`)
  process.exit(3)
}
console.log(`[5/5] C2 契约：${CHANGE_CLOSE_TOOL} 参数=${JSON.stringify(closeParams)}`)

// 回执字段：C2 的返回里必须带 level（"级别被消费"的证据）等五项。
// ⚠️ 真 SDK 会把 `required: true`（写在属性内部）**提到 schema 顶层的 required 数组**，
// 所以两个地方都要查：properties 里有哪些字段、required 里声明了哪些必填。
const closeSchema = closeDef.output?.schema ?? {}
const closeProps = Object.keys(closeSchema.properties ?? {})
const WANT_OUT = ['level', 'target', 'change_seq', 'checks', 'approval']
const missingProp = WANT_OUT.filter((k) => !closeProps.includes(k))
if (missingProp.length > 0 || closeProps.length !== WANT_OUT.length) {
  console.error(
    `PRECHECK FAIL：${CHANGE_CLOSE_TOOL} 输出字段应为 ${JSON.stringify(WANT_OUT)}，实际 ${JSON.stringify(closeProps)}`
  )
  process.exit(3)
}
const closeRequired = [...(closeSchema.required ?? [])].sort()
if (closeRequired.join(',') !== [...WANT_OUT].sort().join(',')) {
  console.error(
    `PRECHECK FAIL：${CHANGE_CLOSE_TOOL} 的 required 应为 ${JSON.stringify([...WANT_OUT].sort())}，实际 ${JSON.stringify(closeRequired)}`
  )
  process.exit(3)
}
if (closeSchema.additionalProperties !== false) {
  console.error(
    `PRECHECK FAIL：${CHANGE_CLOSE_TOOL} 的输出 schema 顶层 additionalProperties 应为 false（不许模型/下游拿到未声明字段），实际 ${JSON.stringify(closeSchema.additionalProperties)}`
  )
  process.exit(3)
}
console.log(
  `      输出字段=${JSON.stringify(closeProps)}　required=${JSON.stringify(closeRequired)}　additionalProperties=false`
)


// Stage 5.5：D2 的工具必须也注册上（register 抛错时上一步就 exit 了，这里确认它真的在列表里）。
const auditDef = registered.find((d) => d && d.name === AUDIT_CHECK_TOOL)
if (!auditDef) {
  console.error(`PRECHECK FAIL：没注册到 ${AUDIT_CHECK_TOOL}（Phase 4 的 D2 依赖它广播结论）`)
  process.exit(3)
}
const d2Out = Object.keys(auditDef.output?.schema?.properties ?? {})
console.log(`     已注册：name=${auditDef.name}　输出字段=${JSON.stringify(d2Out)}`)

// C3：fde_rollback 必须也注册上（register 抛错时上一步就 exit 了，这里确认它真的在列表里）。
const rollbackDef = registered.find((d) => d && d.name === ROLLBACK_TOOL)
if (!rollbackDef) {
  console.error(`PRECHECK FAIL：没注册到 ${ROLLBACK_TOOL}（C3 回滚独立通道）`)
  process.exit(3)
}
const rbParams = Object.keys(rollbackDef.parameters?.properties ?? {})
const rbOut = Object.keys(rollbackDef.output?.schema?.properties ?? {})
console.log(`     已注册：name=${rollbackDef.name}　参数=${JSON.stringify(rbParams)}　输出字段=${JSON.stringify(rbOut)}`)
if (!rbParams.includes('reason')) {
  console.error(`PRECHECK FAIL：${ROLLBACK_TOOL} 参数应含 reason，实际 ${JSON.stringify(rbParams)}`)
  process.exit(3)
}
for (const f of ['preauthorized', 'rolled_back_to', 'observation_started', 'observation_hours']) {
  if (!rbOut.includes(f)) {
    console.error(`PRECHECK FAIL：${ROLLBACK_TOOL} 输出应含 ${f}，实际 ${JSON.stringify(rbOut)}`)
    process.exit(3)
  }
}

console.log(
  '\nPRECHECK OK —— 工具能在真实 SDK 下注册成功，output.schema 校验通过，可以重启 DSH 了。'
)
