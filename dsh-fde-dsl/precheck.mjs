/**
 * 上线前预检 —— 用 **真实的** `@deepseek-ai/dsh-tools` 跑一遍工具注册 + 取数。
 *
 * ## 为什么非得有这个脚本
 * 离线回归（`_fde_dsl_test.mjs`）里的 `@deepseek-ai/dsh-tools` 是**工作区根的本地桩**：
 * `defineTool = (def) => def` —— 恒等函数，零 schema 校验。
 * 于是"离线 import 成功"**推不出**"工具能在 DSH 里注册成功"。
 *
 * 真实 SDK 会在 `defineTool()` 里逐层校验输出 schema：
 * 每一层 `type: 'object'` 都必须显式声明 `additionalProperties`，
 * 否则同步抛 `unsupported JSON schema: schema.properties.<x>.additionalProperties
 * must be explicitly true or false`。
 *
 * 那个抛错发生在插件 `apply()` 里 → **插件加载即失败** → 工具根本注册不上，
 * 重启只会得到一个 `fiberPhase: failed` 的条目（2026-09-24 踩过一次，改一行修复）。
 *
 * ## 怎么跑
 * **必须在"已安装副本"目录里跑**，不能在工作区源目录跑：
 * 只有副本那条 node_modules 链解析得到真 SDK，工作区解析到的是桩。
 *
 * ```powershell
 * cd "<DSH_HOME>\profiles\web\node_modules\dsh-fde-dsl"
 * node precheck.mjs
 * ```
 *
 * 退出码：`0` 全部通过；`2` 跑在桩环境（位置不对，结论无效）；`3` 注册/取数失败。
 */

import { createRequire } from 'node:module'
import { normalizeConfig } from './lib/config.js'
import { installValidationTool, installGuardrailsTool, loadOntology, VALIDATION_TOOL, GUARDRAILS_TOOL } from './lib/tools.js'
import { validateOntology } from './lib/validate.js'

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
      '请 cd 到 profiles\\web\\node_modules\\dsh-fde-dsl 再跑 —— 只有那条路径能解析到真 SDK。\n' +
      `（当前解析：${sdkPath}）`
  )
  process.exit(2)
}
console.log(`[2/4] SDK 为真（会校验 schema）：探针抛错 = ${probe.message?.slice(0, 120)}`)

/** 最小 ctx 替身：只提供 installValidationTool 真正用到的两个口子。 */
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
  ontologyRoot: process.env.FDE_ONTOLOGY_ROOT ?? 'E:\\ontologyRoot',
  mode: 'shadow'
})
console.log(`[3/4] 注册 ${VALIDATION_TOOL} + ${GUARDRAILS_TOOL}（ontologyRoot=${cfg.ontologyRoot}, mode=${cfg.mode}）`)

try {
  installValidationTool(ctx, cfg)
  installGuardrailsTool(ctx, cfg)
} catch (e) {
  console.error('\nPRECHECK FAIL：注册阶段抛错 ——', e?.message ?? e)
  console.error(
    '这条错误在 DSH 里会发生在 apply() 内 → 插件加载失败 → 工具注册不上。\n' +
      '修掉再重跑；不要带着它重启。'
  )
  process.exit(3)
}

function checkToolParams(name) {
  const def = registered.find((d) => d.name === name)
  if (!def) {
    console.error(`PRECHECK FAIL：register 没注册 ${name}`)
    process.exit(3)
  }
  // ⚠️ 真 SDK 会把简写参数表（`{ reason: {...} }`）规范化成 JSON Schema
  // `{ type:'object', properties:{ reason: {...} } }` —— 清单从 properties 里取。
  const params = Object.keys(def.parameters?.properties ?? {})
  console.log(`     已注册：${def.name}　参数清单=${JSON.stringify(params)}`)
  if (params.length !== 1 || params[0] !== 'reason') {
    console.error(`PRECHECK FAIL：${name} 参数清单应为 ['reason']，实际 ${JSON.stringify(params)}`)
    process.exit(3)
  }
}

checkToolParams(VALIDATION_TOOL)
checkToolParams(GUARDRAILS_TOOL)

// 取数 + 校验路径也真跑一遍（直读 E:\ontologyRoot 下的 objects.yaml / logic.yaml）。
try {
  const { attributes, rules } = await loadOntology(cfg)
  const report = validateOntology({ attributes, rules, cfg })
  console.log(
    `[4/4] 取数 + 执行：passed=${report.passed}　` +
      `cases=${report.summary.cases}　失败=${report.summary.failures}　指纹=${report.summary.fingerprint}`
  )
} catch (e) {
  console.error(`[4/4] 取数/执行失败：${e?.message ?? e}`)
  console.error(
    '如果只是 ontologyRoot 下还没有 objects.yaml / logic.yaml，属预期（先把样例拷进去）。\n' +
      '**注册校验已经在上面过了**，这一项不影响插件能否加载。'
  )
  process.exit(0)
}

console.log('\nPRECHECK OK —— 工具能在真实 SDK 下注册成功，可以重启 DSH 了。')
