/**
 * D3 验证器配置 —— **纯 JS、零依赖**，保证核心层可离线回归测试。
 *
 * ⚠️ 刻意不放 schemastery：一旦这里 import `Config`，离线测试就得先能解析
 * `@deepseek-ai/schemastery`，而它只在 DSH profile 的 node_modules 里存在。
 * 插件运行时的 schema 声明见 `config-schema.js`（仅用于 DSH 配置面板提示），
 * **真正生效的校验全部在本文件的 `normalizeConfig()`** —— 它是 fail-closed 的唯一权威。
 */

export const NAME = 'dsh-fde-dsl'

/** 默认配置。与 config-schema.js 的默认值必须一致（两处不同以本文件为准）。 */
export const DEFAULTS = {
  /** shadow = 校验不通过只报告、工具正常返回；enforce = 校验不通过工具报错（isError）。 */
  mode: 'shadow',
  /** v3 原文：规则少于 3 条不通过。 */
  minRules: 3,
  /**
   * 每条规则至少要派生出多少条反例。
   * 来源：v3 第十三节 Stage 4 完成判据「3 条规则派生 ≥15 条反例并全通过」→ 每规则 ≥5 条。
   */
  minCasesPerRule: 5,
  /**
   * 组合用例的预算上限。
   *
   * 多叶子规则要做候选值笛卡尔积才能证明"这条 and 规则真的能触发"，
   * 但组合数会爆炸 —— 超过这个上限就**明确放弃并报提示**，不假装验过。
   * 设为 0 等于关闭组合用例（退化为逐叶子验证）。
   */
  maxCombos: 200,
  /** 允许的 effect。不在表内的 effect 一律报 UnknownEffect（fail-closed）。 */
  allowedEffects: ['deny', 'warn', 'allow'],
  /** 属性允许的数据类型。 */
  allowedTypes: ['number', 'string', 'boolean'],
  /** 属性成熟度。默认值故意取 `draft` —— 未经显式声明的属性参与 deny 判定即为失败。 */
  allowedMaturity: ['draft', 'verified', 'locked']
}

/**
 * 规范化并校验配置。**任何一项不合法都抛错**（fail-closed：宁可不工作，也不带病运行）。
 *
 * @param {object} raw - DSH 传入的原始配置（可缺字段，此处补默认值）
 * @returns {object & typeof DEFAULTS & {ontologyRoot: string}} 规范化后的配置
 */
export function normalizeConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}

  if (typeof input.ontologyRoot !== 'string' || input.ontologyRoot.trim().length === 0) {
    throw new Error(`${NAME}: ontologyRoot 必填，且必须是非空字符串`)
  }

  const cfg = { ...DEFAULTS, ...input }

  if (cfg.mode !== 'shadow' && cfg.mode !== 'enforce') {
    throw new Error(`${NAME}: mode 只能是 shadow 或 enforce，收到 ${String(cfg.mode)}`)
  }
  if (!Number.isInteger(cfg.minRules) || cfg.minRules < 1) {
    throw new Error(`${NAME}: minRules 必须是 ≥1 的整数，收到 ${String(cfg.minRules)}`)
  }
  if (!Number.isInteger(cfg.minCasesPerRule) || cfg.minCasesPerRule < 1) {
    throw new Error(
      `${NAME}: minCasesPerRule 必须是 ≥1 的整数，收到 ${String(cfg.minCasesPerRule)}`
    )
  }
  if (!Array.isArray(cfg.allowedEffects) || cfg.allowedEffects.length === 0) {
    throw new Error(`${NAME}: allowedEffects 不能为空，否则任何规则都会被拒`)
  }
  if (!Array.isArray(cfg.allowedTypes) || cfg.allowedTypes.length === 0) {
    throw new Error(`${NAME}: allowedTypes 不能为空，否则任何属性声明都会被拒`)
  }

  return cfg
}

/** 判定当前是否处于真拦截模式（校验失败要让工具报错）。 */
export function isEnforcing(cfg) {
  return cfg.mode === 'enforce'
}
