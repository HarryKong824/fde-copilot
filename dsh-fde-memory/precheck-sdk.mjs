/**
 * 上线前预检（真 SDK）—— 用**真实的** `@deepseek-ai/dsh-tools` 跑一遍 memory 工具注册 + schema 校验。
 *
 * ## 为什么非得有这个脚本
 * 离线回归里的 `@deepseek-ai/dsh-tools` 是工作区根的本地桩（`defineTool = (def) => def`），
 * 零 schema 校验。B1/B2 新增了 `fde_memory_confirm`、给 `fde_memory_write_decision` 加了 `facts`
 * 嵌套 object 与 `provenance` 参数 —— 这些 schema 若在真 SDK 下不合法（如嵌套 object 漏写
 * additionalProperties），会在 apply() 里抛错 → 整个 memory 插件加载失败 → fiber failed。
 * 桩掩盖了这一点，必须用真 SDK 兜一遍。
 *
 * ## 怎么跑（必须在已安装副本目录里跑）
 * ```powershell
 * cd "E:\DSH-desktop\DeepSeek Harness\data\dsh-home\profiles\web\node_modules\dsh-fde-memory"
 * node precheck-sdk.mjs
 * ```
 * 退出码：`0` 全部通过；`2` 跑在桩环境（位置不对）；`3` 注册/校验失败。
 */

import { createRequire } from 'node:module'
import { normalizeConfig } from './lib/config.js'
import { AuditChain } from './lib/audit.js'
import { installMemoryTools, CONTEXT_TOOL, WRITE_DECISION_TOOL, REVIEW_TOOL, CONFIRM_TOOL } from './lib/tools.js'

const require = createRequire(import.meta.url)

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

function probeRealSdk() {
  try {
    defineTool({
      name: '__fde_mem_sdk_probe__',
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
      '请 cd 到 profiles\\web\\node_modules\\dsh-fde-memory 再跑 —— 只有那条路径能解析到真 SDK。\n' +
      `（当前解析：${sdkPath}）`
  )
  process.exit(2)
}
console.log(`[2/4] SDK 为真（会校验 schema）：探针抛错 = ${probe.message?.slice(0, 120)}`)

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
  projectRoot: process.env.FDE_MEMORY_PROJECT_ROOT ?? 'E:\\fde-project'
})
const audit = new AuditChain(cfg.projectRoot + '\\memory\\audit\\events.jsonl')

console.log(`[3/4] 注册 memory 四工具（projectRoot=${cfg.projectRoot}）`)
try {
  installMemoryTools(ctx, cfg, audit)
} catch (e) {
  console.error('\nPRECHECK FAIL：注册阶段抛错 ——', e?.message ?? e)
  console.error('这条错误在 DSH 里会发生在 apply() 内 → 插件加载失败 → 工具注册不上。修掉再重跑。')
  process.exit(3)
}

const names = registered.map((d) => d?.name).sort()
const expect = [CONTEXT_TOOL, WRITE_DECISION_TOOL, REVIEW_TOOL, CONFIRM_TOOL].sort()
console.log(`[4/4] 已注册 ${registered.length} 个工具：${names.join(', ')}`)
if (JSON.stringify(names) !== JSON.stringify(expect)) {
  console.error(`PRECHECK FAIL：工具清单应为 ${expect.join(', ')}，实际 ${names.join(', ')}`)
  process.exit(3)
}

console.log('\nPRECHECK OK —— memory 四工具能在真实 SDK 下注册成功，output.schema 校验通过，可以重启 DSH 了。')
