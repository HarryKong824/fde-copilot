/**
 * Phase 状态机配置 —— **纯 JS、零依赖**，保证核心层可离线回归测试。
 *
 * ⚠️ 刻意不放 schemastery：一旦这里 import `Config`，离线测试就得先能解析
 * `@deepseek-ai/schemastery`，而它只在 DSH profile 的 node_modules 里存在。
 * 插件运行时的 schema 声明见 `config-schema.js`（仅用于 DSH 配置面板提示），
 * **真正生效的校验全部在本文件的 `normalizeConfig()`** —— 它是 fail-closed 的唯一权威。
 *
 * 与 gate / dsl 同构：config 里只放同步可读的静态值，guard 是同步的，
 * 任何需要 await 的东西都不许进配置层。
 */

export const NAME = 'dsh-fde-phase'

/** 默认配置。与 config-schema.js 的默认值必须一致（两处不同以本文件为准）。 */
/**
 * 🔴 `restrict` 永远点不上的名字 —— PTC 模式的呈现层传输名。
 *
 * `run_code` 不只"点名必抛"（`dsh-tools/lib/index.js:2801`），它**无法像未知名那样跳过**
 * （点名失败的那套重试逻辑对它无效：它单独前置校验）。所以必须在**配置层**就 fail-closed 拒掉，
 * 不能等到运行时才发现限制压根没挂上。
 */
export const RESERVED_TOOL_NAMES = ['run_code']

export const DEFAULTS = {
  /** shadow = 门禁不通过只报告、工具正常返回；enforce = 门禁不通过工具报错（isError）。 */
  mode: 'shadow',
  /** 哈希链审计 JSONL 落盘路径；留空则只进内存 outbox（PoC 默认不落盘）。 */
  auditPath: '',
  /** 单写者锁过期阈值（毫秒）：超过这个时长视为锁主已死，可强夺。 */
  lockTtlMs: 30000,
  /**
   * 受保护阶段：进入这些阶段时，对**每个** agent 隐藏 `denyTools` 里的工具。
   * 默认值 = **方案 B**（PoC 口径）：与 `DENY_CHECKS` 已覆盖的 4 / 6 / 10 对齐
   * —— 这三个阶段是"改生产 / 改交付物"的关口。
   */
  protectedPhases: ['4', '6', '10'],
  /**
   * 受保护阶段内要隐藏的**全局工具名**。默认值 = **方案 B**（PoC 口径）：只收 shell。
   *
   * ⚠️ 名单是"候选名单"：实现会按"实际存在才点名"处理（施工单 §1 注），
   * 点不上的名字（平台差异 —— win32 只有 `pwsh` 没有 `bash`；preset 差异）会进审计 `skipped`，
   * 不会被静默吞掉，也不会因为一个名字不存在就让整条保护失效。
   */
  denyTools: ['pwsh'],
  /**
   * Stage 5.6 新增：本部署所属行业。**必须由部署方显式填**，默认 '未声明' ⇒
   * D5 在 compliance.yaml 检查通过后仍以 "notApplicable" 留痕（不拦、但诚实说明
   * 合规边界因行业未声明而无法判定内容）。
   *
   * 🔴 为什么放 config 而非 compliance.yaml：compliance.yaml 是"被检查对象"，
   * 若让被检查对象自己声明"我属于哪个行业"⇒ 它可以改成"无行业"来绕过 D5。
   * industry 必须由部署 config（部署方填）钉死，与被检查对象解耦。
   */
  industry: '未声明',
  /**
   * D1/L4 新增（spec §8）：外置审计降级状态 `state.json` 的路径。**留空 = 这条括号不适用**。
   *
   * 🔴 刻意**不像 `gateAuditPath` 那样必填**，两者的不对称是有理由的：
   *   `gateAuditPath` 缺了 ⇒ D2 验不了 ⇒ "验不了但假装能验"必须 fail-closed；
   *   而 `telemetryStatePath` 缺了 ⇒ **部署方本来就没打算接外置审计** ⇒ 那是**合法配置**，
   *   本地链完整就是最完整的保证。把它判成"不满足"会让所有没接远端的部署在 Phase 4 永久卡死
   *   —— 那正是 spec §8 要修的死锁（v2 的 D4「远端不可达 = 永远不过」）。
   *
   * ⚠️ 路径**给了**但读不出来（坏 JSON / schema 不认 / 空文件）⇒ **fail-closed 判 missing**。
   *    "读不到"与"没配"必须分开（前者是故障，后者是选择）。
   */
  telemetryStatePath: ''
}

/**
 * 规范化并校验配置。**任何一项不合法都抛错**（fail-closed：宁可不工作，也不带病运行）。
 *
 * @param {object} raw - DSH 传入的原始配置（可缺字段，此处补默认值）
 * @returns {object & typeof DEFAULTS & {projectRoot: string, ontologyRoot: string}}
 */
export function normalizeConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}

  // 🔴 spec 第七节明文：$DSH_HOME/projects/{project}/ 在真 SDK 里**不存在**。
  // 所以 state.yaml 的落点必须由 config 显式给，插件不做任何路径猜测。
  if (typeof input.projectRoot !== 'string' || input.projectRoot.trim().length === 0) {
    throw new Error(`${NAME}: projectRoot 必填（state.yaml 落点 <projectRoot>/memory/state.yaml），必须是非空字符串`)
  }
  if (typeof input.ontologyRoot !== 'string' || input.ontologyRoot.trim().length === 0) {
    throw new Error(`${NAME}: ontologyRoot 必填（D1 结论哈希锚定的 actions.yaml 来源），必须是非空字符串`)
  }
  // Stage 5.5：D2（Phase 4 的门禁项之一）要验 gate 审计链的完整性。
  // 它与上面两个同性质 —— **都是这个项目的合规证据文件的位置**，插件不猜。
  // ⇒ 不给就抛（fail-closed）：宁可插件不起，也不带着"验不了但假装能验"的配置运行。
  if (typeof input.gateAuditPath !== 'string' || input.gateAuditPath.trim().length === 0) {
    throw new Error(
      `${NAME}: gateAuditPath 必填（D2 要验完整性的 gate 审计链 JSONL 路径），必须是非空字符串`
    )
  }

  const cfg = { ...DEFAULTS, ...input }

  if (cfg.mode !== 'shadow' && cfg.mode !== 'enforce') {
    throw new Error(`${NAME}: mode 只能是 shadow 或 enforce，收到 ${String(cfg.mode)}`)
  }
  if (!Number.isFinite(cfg.lockTtlMs) || cfg.lockTtlMs < 0) {
    throw new Error(`${NAME}: lockTtlMs 必须是 ≥0 的数值，收到 ${String(cfg.lockTtlMs)}`)
  }
  if (typeof cfg.auditPath !== 'string') {
    throw new Error(`${NAME}: auditPath 必须是字符串（可为空串）`)
  }
  if (typeof cfg.telemetryStatePath !== 'string') {
    throw new Error(`${NAME}: telemetryStatePath 必须是字符串（可为空串 = L4 括号不适用）`)
  }

  cfg.protectedPhases = normalizeNameList(cfg.protectedPhases, 'protectedPhases', false)
  cfg.denyTools = normalizeNameList(cfg.denyTools, 'denyTools', true)

  // Stage 5.6：industry 必须是非空字符串（默认 '未声明' 也是非空，所以不给也合法）。
  // 🔴 '未声明' 是**哨兵值不是行业名**：在布尔语境里是真值字符串，
  //    if (!cfg.industry) / if (cfg.industry) 都会把它当"已声明"判错。
  //    ⇒ 任何"是否适用 D5"的判定都必须走 isRegulatedIndustry()（check-d5.js），
  //       不许直接字符串比较 cfg.industry === '未声明'（会漂移）。
  if (typeof cfg.industry !== 'string' || cfg.industry.trim().length === 0) {
    throw new Error(`${NAME}: industry 必须是非空字符串，收到 ${JSON.stringify(cfg.industry)}`)
  }
  cfg.industry = cfg.industry.trim()

  return cfg
}

/**
 * 名单类配置的校验：**必须是字符串数组，元素不得为空串**，并拷贝一份（防止外部改动穿透进来）。
 *
 * 阶段 id 允许 `'0.1'` 这类带点的字符串、工具名允许字母数字下划线，
 * 本轮**刻意不校验字符形状** —— 它们最终由 `restrictableNames` 去证伪，
 * 在这里做正则白名单只会挡住将来合法的名字（PoC 不值得吃这个维护成本）。
 *
 * @param {unknown} value
 * @param {string} field
 * @param {boolean} checkReserved - 是否禁止保留名（工具名要查，阶段 id 不用）
 * @returns {string[]}
 */
function normalizeNameList(value, field, checkReserved) {
  if (value === undefined || value === null) {
    // 未配 ⇒ 沿用 DEFAULTS 里那个值（调用方可能显式传 undefined 覆盖默认，这里回落到默认更安全）
    return [...DEFAULTS[field]]
  }
  if (!Array.isArray(value)) {
    throw new Error(`${NAME}: ${field} 必须是字符串数组，收到 ${String(value)}`)
  }
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${NAME}: ${field} 里不得包含空值/非字符串，收到 ${JSON.stringify(item)}`)
    }
    const name = item.trim()
    if (checkReserved && RESERVED_TOOL_NAMES.includes(name)) {
      throw new Error(
        `${NAME}: denyTools 不得包含保留名 ${name} —— ` +
          `restrict() 点名必抛且**无法像未知名那样跳过**，等同于让整条保护失效`
      )
    }
    out.push(name)
  }
  return out
}

/** 判定当前是否处于真拦截模式。 */
export function isEnforcing(cfg) {
  return cfg.mode === 'enforce'
}
