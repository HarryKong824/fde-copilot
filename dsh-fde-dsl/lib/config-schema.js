/**
 * 插件运行时的配置 schema —— **只服务于 DSH 的配置面板与类型提示**。
 *
 * ⚠️ 真正的校验权威是 `config.js` 的 `normalizeConfig()`：它 fail-closed、
 *    报错直白、且能被离线测试直接调用。本文件 **不承担** 安全性职责。
 *
 * 两个文件的默认值必须保持一致；若漂移，以 `config.js` 的 `DEFAULTS` 为准
 * （normalizeConfig 每次 apply 都会重跑一遍，schema 里漏了也不会生效）。
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULTS } from './config.js'

export const Config = z.object({
  /** 受保护 ontology 目录的绝对路径。与 fde-ontology-gate 的 ontologyRoot 同根。 */
  ontologyRoot: z.string().required().description('ontology 目录的绝对路径（与 gate 插件同根）'),

  /** shadow = 校验失败只报告；enforce = 校验失败让工具报错。 */
  mode: z.union([z.const('shadow'), z.const('enforce')]).default(DEFAULTS.mode),

  /** 最少规则数（v3：少于 3 条不通过）。 */
  minRules: z.number().default(DEFAULTS.minRules),

  /** 每条规则最少派生反例数（来源：3 规则 ≥15 反例）。 */
  minCasesPerRule: z.number().default(DEFAULTS.minCasesPerRule),

  /** 组合用例预算上限；0 = 关闭。超出会明确报 CombinatorialSkip，不假装验过。 */
  maxCombos: z.number().default(DEFAULTS.maxCombos),

  /** 允许的 effect。 */
  allowedEffects: z.array(z.string()).default(DEFAULTS.allowedEffects),

  /** 允许的属性类型。 */
  allowedTypes: z.array(z.string()).default(DEFAULTS.allowedTypes),

  /** 允许的属性成熟度。 */
  allowedMaturity: z.array(z.string()).default(DEFAULTS.allowedMaturity)
})
