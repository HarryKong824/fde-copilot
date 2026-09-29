import z from '@deepseek-ai/schemastery'
import { assertProtectedExtraRoots, assertSandboxNotInOtherRoots, assertSandboxSubdirs } from './paths.js'
import { UNSPECIFIED_INDUSTRY } from './classify.js'

/**
 * 门禁配置。
 *
 * 全部为同步可读的静态值 —— guard 是同步的，配置里不要放任何需要 await 的东西。
 */
export const Config = z.object({
  /** 受保护 ontology 目录的绝对路径。按架构决议应当在 process.cwd() 之外（区外）。 */
  ontologyRoot: z.string().required().description('受保护 ontology 目录的绝对路径'),

  /**
   * shadow = 只审计、不拦（先跑第一个真实项目校准阈值）；
   * enforce = 真拦。
   */
  mode: z.union([z.const('shadow'), z.const('enforce')]).default('shadow'),

  /**
   * 是否整体拒掉 `run_code`（PTC 通道）。
   *
   * 部署默认 mode 是 native，模型看不到 run_code；只有切到 ptc preset 才会出现。
   * run_code 是保留名，`ctx.tools.restrict` 点名它会直接报错，所以只能靠 guard 拒。
   */
  denyRunCode: z.boolean().default(true),

  /**
   * 相对路径的解析基准。fail-closed：参数是相对路径时，
   * 会对 workspaceRoot 与 process.cwd() 两个基准各解析一次，任一命中 ontology 即拒。
   */
  workspaceRoot: z.string().default(process.cwd()),

  /** 审计 JSONL 落盘路径；留空则只进内存 outbox（PoC 默认不落盘）。 */
  auditPath: z.string().default(''),

  /**
   * `dsh-fde-phase` 的审计链路径（`phase.jsonl`）—— `fde_metrics` 读 spec §14 的 ③④⑤
   * 三项指标要用（变更的 Phase 归属 / ask 跳过 / Phase 停留时长都只在 phase 链上）。
   *
   * 与 phase 的 `gateAuditPath` **镜像对称**（E1 已有先例）：两条链分开落盘，
   * 谁要读对方的数据谁就得被显式告知路径 —— 插件一律不猜路径。
   *
   * 🔴 **这里刻意 `default('')` + 缺席可运行，与 phase 侧 `gateAuditPath` 的 fail-closed 相反**，
   *    理由是这个字段的**用途不同**：
   *      · phase 的 `gateAuditPath` 是 **D2 门禁判据**的数据源 —— 验不了就不能假装能验 ⇒ 不给就抛。
   *      · gate 的 `phaseAuditPath` 只是**只读指标**的数据源，不参与任何拦截判定。
   *        缺它不会让任何一次 deny 失效，只会让三项指标明确报 `insufficient-data`
   *        （**不是 0%**，见 `lib/metrics.js` 的红线）。为"少三行统计"拒绝加载整个门禁，
   *        方向错了：那是拿可用性去换一个非门禁的特性。
   *    ⇒ 缺席的处理已经**有判据**（`insufficient-data` + 启动日志显式打印），不必也不该 fail-closed。
   */
  phaseAuditPath: z.string().default(''),

  /** 写入 ontology 时允许的 payload 来源。不在表内的来源一律拒。 */
  allowedWriteSources: z.array(z.string()).default(['user', 'model']),

  /** source 为 model 时要求的最低置信度（防污染）。低于它即拒。 */
  minConfidence: z.number().default(70),

  /**
   * 部署行业。受监管行业（medical-*）会让变更分级（L0/L1/L2）里的
   * "受监管行业 + logic.yaml deny 规则 ⇒ L2"这一条生效。与 phase 的 industry 语义一致。
   */
  industry: z.string().default(UNSPECIFIED_INDUSTRY),

  /**
   * 除 `ontologyRoot` 与审计链目录之外的**额外受保护目录**（0023 P0-4a / 缺陷 A②③）。
   *
   * 典型取值：phase 状态机的 `<projectRoot>`（其下 `memory/state.yaml` 与
   * `memory/.state.lock` 都不在 ontologyRoot / 审计目录里 ⇒ 此前完全不受守卫）。
   *
   * ⚠️ 配错即**加载失败**（见 `assertProtectedExtraRoots`）：宁可不起，
   * 也不带着"以为堵上了、其实敞着"的配置运行。
   */
  protectedExtraRoots: z.array(z.string()).default([]),

  /**
   * 探索沙箱（spec v3 §7）：在上面某条 `protectedExtraRoots` 之下、**豁免路径守卫**的子目录名。
   *
   * 语义：模型可以自由读写 `<extraRoot>/<sandboxSubdir>`，其余部分照旧受保护。
   * 这是"试验品 vs 正式记忆"的物理边界 —— 沙箱内容不进分层注入、不参与 D1/D3、
   * 无审计要求；验收后经 `fde_ontology_write` 走正式 L0/L1/L2 通道合入。
   *
   * 🔴 三处刻意收窄（每一处都对应一个"开洞"的方向）：
   *   ① **只能挂在 `extra` 类根下** —— `ontologyRoot` 与审计目录的豁免在结构上不可达
   *      （派生逻辑在 `sandboxPathsOf()` 里，只遍历 protectedExtraRoots）；
   *   ② **只接受单段子目录名** —— 禁 `/ \ : ` 与 `.`/`..`，故沙箱位置在结构上无法穿越出宿主；
   *   ③ **默认空数组** = 不开沙箱。空数组是"没有洞"，不是"洞在默认位置"。
   *
   * ⚠️ 配错即**加载失败**（`assertSandboxSubdirs` / `assertSandboxNotInOtherRoots`）。
   */
  sandboxSubdirs: z.array(z.string()).default([]),

  /**
   * `fde_shadow_switch` 单次调用最多**逐条确认**多少项（spec §12 的 R2 逐条确认）。
   *
   * ⚠️ **拍脑袋值**（同 spec §15 的惯例：降级阈值 24h / notes 过期天数 / break-glass 补正期 7 天
   * 都自认是拍脑袋值，本项一并标注）：目的是避免真实链上几百条 shadow-deny 时
   * 一次调用弹几百个窗。达到上限时**中止并如实报告进度**（`SHADOW_CONFIRM_BATCH_LIMIT`），
   * 不是"跳过未确认的项"—— 那会让 R2 变成一句空话。
   */
  maxConfirmPerCall: z.number().default(50)
})

/**
 * 规范化配置：补上 DSH 未校验的收尾检查。
 *
 * 这些检查故意放在 apply 里而非 schema 里 —— schema 校验失败的信息不如这里直白，
 * 而且阈值这类跨字段约束用 schemastery 表达会很难读。
 *
 * @param {object} raw - schema 已应用默认值后的配置
 * @returns {object} 校验通过的配置
 */
export function normalizeConfig(raw) {
  // fail-closed：受保护根写错 ⇒ 插件加载失败，而不是静默丢弃那一条。
  assertProtectedExtraRoots(raw.protectedExtraRoots)
  if (typeof raw.ontologyRoot !== 'string' || raw.ontologyRoot.trim().length === 0) {
    throw new Error('fde-ontology-gate: ontologyRoot 必填，且必须是非空字符串')
  }
  // 沙箱校验**排在 ontologyRoot 校验之后**：`assertSandboxNotInOtherRoots` 要拿
  // ontologyRoot / auditPath / protectedExtraRoots 三者拼出**完整**保护根集合才能判
  // "沙箱有没有压在别的受保护区域上"；ontologyRoot 是空串时 protectedRootsOf 会跳过它，
  // 判出来的集合是**残缺**的 ⇒ 那条断言会因为"少了一个根"而漏判。
  assertSandboxSubdirs(raw.sandboxSubdirs, raw.protectedExtraRoots)
  assertSandboxNotInOtherRoots(raw)
  if (raw.mode !== 'shadow' && raw.mode !== 'enforce') {
    throw new Error(`fde-ontology-gate: mode 只能是 shadow 或 enforce，收到 ${String(raw.mode)}`)
  }
  if (!Number.isFinite(raw.minConfidence) || raw.minConfidence < 0 || raw.minConfidence > 100) {
    throw new Error(`fde-ontology-gate: minConfidence 必须是 0–100 的数值，收到 ${String(raw.minConfidence)}`)
  }
  if (!Array.isArray(raw.allowedWriteSources) || raw.allowedWriteSources.length === 0) {
    throw new Error('fde-ontology-gate: allowedWriteSources 不能为空，否则任何写入都会被拒')
  }
  // 至少 1：0 或负数会让 `fde_shadow_switch` 永远卡在"本次确认 0 条"，
  // 门禁永远切不过去，而错误信息看起来像"还有 N 条没确认"（把配置错说成业务未就绪）。
  if (!Number.isInteger(raw.maxConfirmPerCall) || raw.maxConfirmPerCall < 1) {
    throw new Error(
      `fde-ontology-gate: maxConfirmPerCall 必须是 ≥1 的整数，收到 ${String(raw.maxConfirmPerCall)}`
    )
  }
  return raw
}

/** 判定当前是否处于真拦截模式。 */
export function isEnforcing(cfg) {
  return cfg.mode === 'enforce'
}
