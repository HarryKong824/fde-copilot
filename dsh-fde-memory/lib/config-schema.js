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
  /** 记忆系统根 = config 的 projectRoot（0076 §3.1：spec $DSH_HOME/projects/{project}/ 不成立）。 */
  projectRoot: z.string().required().description('记忆系统根目录的绝对路径（= config 的 projectRoot，本部署 = …\\dsh-home\\fde-state）'),

  /** shadow = 仅记录不强制；enforce = 校验失败让插件 apply 失败。 */
  mode: z.union([z.const('shadow'), z.const('enforce')]).default(DEFAULTS.mode),

  /** SCHEMA_VERSION 当前版本（0076 A1：本单只有 v1）。 */
  schemaVersion: z.number().default(DEFAULTS.schemaVersion),

  /** notes 默认过期天数（默认 90 天）。 */
  notesTtlDays: z.number().default(DEFAULTS.notesTtlDays),

  /** informal_commitment 强制过期天数（非正式承诺类强制 30 天）。 */
  informalCommitmentTtlDays: z.number().default(DEFAULTS.informalCommitmentTtlDays),

  /** 分层注入：最近 N 条 change_log。 */
  injectChangeLogLimit: z.number().default(DEFAULTS.injectChangeLogLimit)
})
