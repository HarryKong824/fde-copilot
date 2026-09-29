/**
 * confidence.js —— 置信度规则表（纯函数零 IO）。
 *
 * 规则来源：0076 §5.5 + 0079 §4 A2-2 补写。
 *
 * 🔴 叠加顺序（spec 未写清，本实现自定 —— 写进代码注释供回执单列）：
 *   第 0 步  入参校验：source ∉ {fde_confirmed, plugin_inferred, client_stated} ⇒ 抛
 *            phases_since_review 非整数（且非 null/undefined）⇒ 抛（fail-closed，0082 §2.1）
 *   第 1 步  基础档（互斥，取第一条命中）：
 *              source=plugin_inferred                                   -> low
 *              source=client_stated, !fde_confirmed                     -> low
 *              source=client_stated,  fde_confirmed                     -> medium
 *              source=client_stated,  fde_confirmed, data_verified      -> high
 *              source=fde_confirmed,                 data_verified      -> high
 *              source=fde_confirmed,                !data_verified      -> medium   ← 0079 补写（spec 未列）
 *   第 2 步  时效衰减（**叠在基础档之上**，不是"第一条命中就返回"）：
 *              last_reviewed == null && phases_since_review >= 1        -> 降一档（high→medium, medium→low）
 *              phases_since_review >= 3                                 -> 直接压到 low（覆盖前一条的结果）
 *   第 3 步  派生继承（叠加在最后）：
 *              derived_from_confidence == 'low'                         -> 结果上限 = medium（已是 low 则仍 low）
 *
 * 第 1 步里 `source=fde_confirmed, !data_verified` 这一档是 0079 §4 A2-2 注脚补写的，
 * 理由：与 `client_stated, fde_confirmed=true`（未数据核验 → medium）同档，
 * 语义都是"人确认过但没数据核验"。
 *
 * 0082 §2.1 修复：`phases_since_review` 非整数（如字符串 '3' / 浮点 1.5）原静默当 0
 *  ⇒ 时效衰减整条失效（fail-open）。改为非整数一律抛（null/undefined 视为未提供）。
 */

const VALID_SOURCES = new Set(['fde_confirmed', 'plugin_inferred', 'client_stated'])

/**
 * 推导置信度。
 * @param {object} facts
 * @param {string} facts.source - 来源：fde_confirmed | plugin_inferred | client_stated
 * @param {boolean} [facts.fde_confirmed] - 是否经 FDE 体系确认
 * @param {boolean} [facts.data_verified] - 是否经数据层核验
 * @param {number} [facts.phases_since_review] - 距上次复核过了几个 phase（整数或留空）
 * @param {string|null} [facts.last_reviewed] - 上次复核的 ISO 字符串或 null
 * @param {string|null} [facts.derived_from_confidence] - 上游 decision 的 confidence
 * @returns {'low'|'medium'|'high'}
 */
export function deriveConfidence(facts) {
  const f = facts ?? {}
  const source = f.source
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`confidence: source 必须是 fde_confirmed|plugin_inferred|client_stated，收到 ${String(source)}`)
  }
  const fdeConfirmed = f.fde_confirmed === true
  const dataVerified = f.data_verified === true
  // §2.1：null/undefined 视为"未提供"（与 last_reviewed == null 风格一致）；其余非整数一律抛（fail-closed）
  const rawPsr = f.phases_since_review
  if (rawPsr != null && !Number.isInteger(rawPsr)) {
    throw new Error(`confidence: phases_since_review 必须是整数或留空，收到 ${JSON.stringify(rawPsr)}（${typeof rawPsr}）`)
  }
  const psr = rawPsr ?? 0
  const lastReviewed = f.last_reviewed
  const derivedFrom = f.derived_from_confidence

  // ── 第 1 步：基础档（互斥，按上述顺序取第一条命中）──────────
  let base
  if (source === 'plugin_inferred') {
    base = 'low'
  } else if (source === 'client_stated' && !fdeConfirmed) {
    base = 'low'
  } else if (source === 'client_stated' && fdeConfirmed && dataVerified) {
    base = 'high'
  } else if (source === 'client_stated' && fdeConfirmed && !dataVerified) {
    base = 'medium'
  } else if (source === 'fde_confirmed' && dataVerified) {
    base = 'high'
  } else if (source === 'fde_confirmed' && !dataVerified) {
    // 0079 §4 A2-2 注脚补写：与 client_stated+fde_confirmed 同档
    base = 'medium'
  } else {
    // 防御：理论上前面的分支已穷举，到不了这里
    base = 'low'
  }

  // ── 第 2 步：时效衰减（叠在基础档之上）──────────────────────
  let result = base
  if (lastReviewed == null && psr >= 1) {
    // 降一档
    if (result === 'high') result = 'medium'
    else if (result === 'medium') result = 'low'
    // low 仍 low
  }
  if (psr >= 3) {
    // 直接压到 low（覆盖前一条结果）
    result = 'low'
  }

  // ── 第 3 步：派生继承（叠加在最后）──────────────────────────
  if (derivedFrom === 'low' && result === 'high') {
    // 结果上限 = medium
    result = 'medium'
  }
  // derived_from == 'low' 且 result 已是 medium/low ⇒ 不变

  return result
}
