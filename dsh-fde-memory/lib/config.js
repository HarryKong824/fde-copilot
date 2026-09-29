/**
 * 记忆系统 v2 配置 —— **纯 JS、零依赖**，保证核心层可离线回归测试。
 *
 * ⚠️ 刻意不放 schemastery：一旦这里 import `Config`，离线测试就得先能解析
 * `@deepseek-ai/schemastery`，而它只在 DSH profile 的 node_modules 里存在。
 * 插件运行时的 schema 声明见 `config-schema.js`（仅用于 DSH 配置面板提示），
 * **真正生效的校验全部在本文件的 `normalizeConfig()`** —— 它是 fail-closed 的唯一权威。
 *
 * 0076 §3.1：spec 的 `$DSH_HOME/projects/{project}/` 路径不成立；记忆系统根 = config 的 `projectRoot`。
 * 0076 §3.5：本插件需要自己的 config 段（建议 key：`fdeMemory`）。改 cordis.patch.yml 后必须重启 DSH 才生效。
 */

export const NAME = 'dsh-fde-memory'

/** 默认配置。与 config-schema.js 的默认值必须一致（两处不同以本文件为准）。 */
export const DEFAULTS = {
  /** shadow = 仅记录不强制；enforce = 校验失败让插件 apply 失败（fail-closed）。 */
  mode: 'shadow',
  /** SCHEMA_VERSION 当前版本（0076 §5 A1.3：本单只有 v1）。 */
  schemaVersion: 1,
  /** notes 默认过期天数（0076 §5 A4.12：默认 90 天）。 */
  notesTtlDays: 90,
  /** informal_commitment 强制过期天数（0076 §5 A4.12：非正式承诺类强制 30 天）。 */
  informalCommitmentTtlDays: 30,
  /** 分层注入：最近 N 条 change_log（0076 §5 A5.15）。 */
  injectChangeLogLimit: 5,
  // ── 审计外置 L2/L3（spec 第八节）────────────────────────────────────────
  /** 外置只写端点。**留空 = 不启用**（不是错误，会写一条 `telemetry-disabled` 留痕）。 */
  telemetryEndpoint: '',
  /** 服务账号的**写**凭据（spec §8：「写凭据由服务账号持有」）。留空则不发 Authorization 头。 */
  telemetryToken: '',
  /** 降级阈值（毫秒）：远端中断超过它 ⇒ 进入降级模式。spec §8 默认 24h。 */
  telemetryDegradeAfterMs: 24 * 60 * 60 * 1000,
  /** 单次投递超时（毫秒）。超时按失败算（会开始/延续中断计时）。 */
  telemetryTimeoutMs: 5000,
  /** 重试/心跳周期（毫秒）。它决定"远端恢复"最多多久被发现。 */
  telemetryRetryMs: 60000
}

/**
 * 规范化并校验配置。**任何一项不合法都抛错**（fail-closed：宁可不工作，也不带病运行）。
 *
 * @param {object} raw - DSH 传入的原始配置（可缺字段，此处补默认值）
 * @returns {object & typeof DEFAULTS & {projectRoot: string}} 规范化后的配置
 */
export function normalizeConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}

  // 0076 §3.1：projectRoot 是记忆系统根，必填。本部署 = …\dsh-home\fde-state
  if (typeof input.projectRoot !== 'string' || input.projectRoot.trim().length === 0) {
    throw new Error(`${NAME}: projectRoot 必填，且必须是非空字符串（记忆系统根，spec $DSH_HOME/projects/{project}/ 路径不成立，见 0076 §3.1）`)
  }

  const cfg = { ...DEFAULTS, ...input }

  if (cfg.mode !== 'shadow' && cfg.mode !== 'enforce') {
    throw new Error(`${NAME}: mode 只能是 shadow 或 enforce，收到 ${String(cfg.mode)}`)
  }
  if (!Number.isInteger(cfg.schemaVersion) || cfg.schemaVersion < 1) {
    throw new Error(`${NAME}: schemaVersion 必须是 ≥1 的整数，收到 ${String(cfg.schemaVersion)}`)
  }
  if (!Number.isInteger(cfg.notesTtlDays) || cfg.notesTtlDays < 1) {
    throw new Error(`${NAME}: notesTtlDays 必须是 ≥1 的整数，收到 ${String(cfg.notesTtlDays)}`)
  }
  if (!Number.isInteger(cfg.informalCommitmentTtlDays) || cfg.informalCommitmentTtlDays < 1) {
    throw new Error(`${NAME}: informalCommitmentTtlDays 必须是 ≥1 的整数，收到 ${String(cfg.informalCommitmentTtlDays)}`)
  }
  if (!Number.isInteger(cfg.injectChangeLogLimit) || cfg.injectChangeLogLimit < 0) {
    throw new Error(`${NAME}: injectChangeLogLimit 必须是 ≥0 的整数，收到 ${String(cfg.injectChangeLogLimit)}`)
  }

  // ── 审计外置 L2/L3（spec 第八节）────────────────────────────────────────
  // 🔴 这里有意的**不对称**：端点/凭据配错 ⇒ **插件加载失败**（fail-closed，同 otel 后端的做法：
  //    「配置错误会在插件加载时失败」）；但**留空** ⇒ 不启用（合法配置，不是错误）。
  //    理由：配了一个连不上的端点却静默退回本地，会让部署方以为"审计已经外置了" ——
  //    那是**把没做的事说成做了**。宁可不加载。
  if (typeof cfg.telemetryEndpoint !== 'string') {
    throw new Error(`${NAME}: telemetryEndpoint 必须是字符串（可为空串 = 不启用），收到 ${String(cfg.telemetryEndpoint)}`)
  }
  cfg.telemetryEndpoint = cfg.telemetryEndpoint.trim()
  if (cfg.telemetryEndpoint !== '') {
    let u
    try {
      u = new URL(cfg.telemetryEndpoint)
    } catch {
      throw new Error(`${NAME}: telemetryEndpoint 不是合法 URL：${cfg.telemetryEndpoint}`)
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`${NAME}: telemetryEndpoint 只接受 http/https，收到 ${u.protocol}`)
    }
  }
  if (typeof cfg.telemetryToken !== 'string') {
    throw new Error(`${NAME}: telemetryToken 必须是字符串（可为空串），收到 ${String(cfg.telemetryToken)}`)
  }
  for (const k of ['telemetryDegradeAfterMs', 'telemetryTimeoutMs', 'telemetryRetryMs']) {
    // 🔴 `> 0` 不是形式主义：`telemetryDegradeAfterMs = 0` 会让"降级"在任何时刻立刻成立
    //    ⇒ L4 的「远端存在 OR 降级」退化成恒真 ⇒ 门禁静默失效（而它看起来还在工作）。
    if (!Number.isFinite(cfg[k]) || cfg[k] <= 0) {
      throw new Error(`${NAME}: ${k} 必须是正的有限数，收到 ${String(cfg[k])}`)
    }
  }

  return cfg
}

/** 判定当前是否处于真拦截模式（enforce 下校验失败要让 apply 失败）。 */
export function isEnforcing(cfg) {
  return cfg.mode === 'enforce'
}
