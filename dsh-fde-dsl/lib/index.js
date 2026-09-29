/**
 * dsh-fde-dsl —— FDE Copilot v3 **Stage 3 + Stage 4**。
 *
 * Stage 3 Ontology 受限 DSL：logic.yaml 的条件只允许白名单算子，认不出就报错（fail-closed）。
 * Stage 4 D3 真验证：边界值反例**机械派生**、用例**不可删**、由插件内部执行 ——
 *   按 v3 9.2 的要求，模型不能为了跑测试自己去开 shell。
 *
 * 它是 fde-ontology-gate 的**下游**：gate 管"谁能在什么条件下改 ontology"，
 * 本插件管"改出来的规则本身能不能信"。两者不共享进程状态，只共享同一个 ontologyRoot。
 *
 * 能力边界（必须讲清，不得含糊）：
 *   本插件校验的是 **规则的可执行性 / 可反驳性 / 用例集完整性**，
 *   它**不**判定规则的临床正确性，也**不**保证"某个下游实现与规则一致"
 *   （后者需要有被测实现存在，属后续 Stage）。
 */

import { normalizeConfig } from './config.js'
import { Config } from './config-schema.js'
import { installValidationTool, installGuardrailsTool, ONTOLOGY_FILES } from './tools.js'

const name = 'dsh-fde-dsl'

/** 需要 tools 服务就绪才能注册工具。 */
const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const log = ctx.logger ?? console

  ctx.effect(() => installValidationTool(ctx, cfg), `${name} 工具 ${'fde-run-validation'}`)
  ctx.effect(() => installGuardrailsTool(ctx, cfg), `${name} 工具 ${'fde-run-guardrails-check'}`)

  log.info?.(
    `[${name}] 已挂载：mode=${cfg.mode}, minRules=${cfg.minRules}, ` +
      `minCasesPerRule=${cfg.minCasesPerRule}, ontologyRoot=${cfg.ontologyRoot}, ` +
      `读取 ${Object.values(ONTOLOGY_FILES).join('/')}`
  )
}

export { Config, apply, inject, name }
