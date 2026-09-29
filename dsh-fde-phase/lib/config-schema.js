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
  /** state.yaml 的落点目录（绝对路径），实际文件为 `<projectRoot>/memory/state.yaml`。 */
  projectRoot: z.string().required().description('项目根目录绝对路径；state.yaml 落于其下 memory/ 子目录'),

  /** D1 结论哈希锚定的 actions.yaml 来源目录（绝对路径）。 */
  ontologyRoot: z.string().required().description('ontology 目录绝对路径（actions.yaml 来源，D1 锚定用）'),

  /** shadow = 门禁不通过只报告、工具正常返回；enforce = 门禁不通过工具报错。 */
  mode: z.union([z.const('shadow'), z.const('enforce')]).default(DEFAULTS.mode),

  /** 哈希链审计 JSONL 落盘路径；留空则只进内存 outbox（PoC 默认不落盘）。 */
  auditPath: z.string().default(DEFAULTS.auditPath),

  /** 单写者锁过期阈值（毫秒）：超过这个时长视为锁主已死，可强夺。 */
  lockTtlMs: z.number().default(DEFAULTS.lockTtlMs),

  /**
   * Stage 5.5 新增：gate 审计链路径 —— **D2 要验它整条有没有被动过**。
   *
   * ⚠️ 必填且非空（`config.js` 的 `normalizeConfig()` fail-closed 兜底）：
   * 它不是"gate 插件的私有文件"，而是**这个项目的合规证据文件**，只是由 gate 生产。
   * 与 `projectRoot` / `ontologyRoot` 同一原则：**路径由配置显式给，插件不猜**。
   * 这里只做面板提示，`normalizeConfig()` 才是权威。
   */
  gateAuditPath: z.string().required().description('gate 审计链 JSONL 路径（D2 验证其完整性用，必填）'),

  /**
   * 受保护阶段：处于这些阶段时，对**每个** agent 隐藏 `denyTools` 里的工具。
   * 默认 = 方案 B（PoC 口径）：`['4', '6', '10']`，与 `DENY_CHECKS` 覆盖的阶段对齐。
   */
  protectedPhases: z
    .array(z.string())
    .default(DEFAULTS.protectedPhases)
    .description('受保护阶段 id 列表（进入即隐藏 denyTools）；默认 [4,6,10] = 方案 B（PoC 口径）'),

  /**
   * 受保护阶段内隐藏的全局工具名。默认 = 方案 B（PoC 口径）：`['pwsh']`。
   *
   * ⚠️ 不得含 `run_code`（PTC 保留名，restrict 点名必抛且无法跳过）—— 这层由
   * `config.js` 的 `normalizeConfig()` fail-closed 兜底；这里只是面板提示。
   */
  denyTools: z
    .array(z.string())
    .default(DEFAULTS.denyTools)
    .description('受保护阶段内隐藏的全局工具名；默认 [pwsh] = 方案 B（PoC 口径）；禁止含 run_code'),

  /**
   * Stage 5.6 新增：本部署所属行业。由部署方在 config 显式填，**不**让 compliance.yaml
   * 自报（否则被检查对象可改 "无行业" 绕过 D5）。默认 '未声明' ⇒ D5 通过后以
   * notApplicable 留痕（不拦、但合规边界因行业未声明而无法判定内容）。
   */
  industry: z
    .string()
    .default(DEFAULTS.industry)
    .description('本部署所属行业（由部署方填，非 compliance.yaml 自报）；默认"未声明"⇒ D5 以 notApplicable 留痕')
})
