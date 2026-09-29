import { readChainRecords, listArchivedSegments, computeShadowStatsFromChain } from './shadow-stats.js'

/**
 * spec v3 §14 验证指标采集（六项）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * §14 原文（逐字）：
 *   指标 / 定义 / 推翻条件
 *   ① deny 修复率        deny 拦截后，FDE 真正修复（而非 break-glass 绕过）的比例
 *                        长期 < 30% → 门禁位置设错，应下调为 ask
 *   ② break-glass 分类统计 deny_defect / scope_edge / evasion 三类各自的比例
 *                        deny_defect > 20% → 门禁 bug 太多，需重审规则质量
 *   ③ 变更触发率         每个 Phase 平均触发的 L0+L1 变更次数
 *                        Phase 4 单阶段 > 5 次 → Ontology 首版质量不合格
 *   ④ ask 跳过率         被跳过的 ask 项 / 总 ask 项
 *                        > 30% → 摩擦点设计错了，FDE 认为无价值
 *   ⑤ Phase 停留时长     各 Phase 平均日历天数
 *                        Phase 1–4 合计 > 15 工作日 → 流程过重，需砍 Phase
 *   ⑥ 影子模式准确率     observe 模式下，FDE 认同"这里确实该拦"的比例
 *                        < 70% → 不应该切 enforce，门禁还不成熟
 * ─────────────────────────────────────────────────────────────────────
 *
 * 🔴 **本模块最要紧的一条红线：分母为 0 时 `value` 必须是 `null`、`verdict` 必须是
 *    `insufficient-data`，绝不报 0%。**
 *    §14 的推翻条件**全部是对阈值的比较**（`< 30%` / `> 20%` / `> 5` / `> 30%` / `> 15` / `< 70%`）。
 *    "没有样本"与"比值为 0"是两个不同的状态，而 `0 < 30%` 当场为真 ⇒
 *    报 0% 会让一条**从未被观测过**的指标直接触发推翻结论（"门禁位置设错"）。
 *    这不是措辞问题：读者会据此去改一个没坏的部署。0 条样本的正确结论是
 *    "这条指标还没有可判的数据"，不是"这条指标不合格"。
 *
 * 本模块**分两层**（沿用 `shadow-stats.js` 的范式，便于离线穷举）：
 *   ① 五个纯函数 `computeXxx(records, opts)` —— 零 IO、零时钟（`now` 由参数注入）；
 *   ② 薄 IO `collectMetrics(cfg)` —— 只把两条链的字节读成数组，再喂给①。
 *
 * 指标 ⑥ 不在这里重算 —— 它**已经**由 `shadow-stats.js` 实现（E4 那批），
 * 本模块直接调 `computeShadowStatsFromChain` 并把结果**原样**嵌进报告。
 * 重写一遍会造出两个"影子准确率"，它们迟早漂移，而读者无从分辨哪个是权威。
 */

/** 六个指标的稳定 id（对外契约，工具输出与离线断言都钉它）。 */
export const METRIC_IDS = Object.freeze([
  'deny-fix-rate',
  'break-glass-categories',
  'change-rate',
  'ask-skip-rate',
  'phase-dwell',
  'shadow-accuracy'
])

/**
 * "合法通道"专用工具 —— 判定"FDE 真的去改"的证据来源。
 *
 * 只含**写/推进**类：`fde_ontology_read` 不在内（读一次不构成"修复"）。
 */
export const REPAIR_CHANNELS = Object.freeze(['fde_ontology_write', 'fde_phase_advance'])

/** §14 ② 的分类取值域（与 `deny-ids.js` 的 `CATEGORY_META` 逐字对应）。 */
export const BG_CATEGORIES = Object.freeze(['deny_defect', 'scope_edge', 'evasion'])

/** ask 记录的类型后缀（`phase-advance-d4-ask` / `phase-advance-d5pre-ask` …）。 */
export const ASK_SUFFIX = '-ask'

/**
 * ask 的 outcome 分桶（**实测取值域**，来自 `dsh-fde-phase/lib/tools.js:260/274/307/326/341`）。
 *
 * 🔴 `degraded` 是**跳过**：`d4Approval = d4 === 'allowed-once' ? 'confirmed' : 'degraded'`
 *    —— 源记录把 `cancelled`（撤回）与 `unavailable`（无 answerer）**合并**成一个 `degraded`。
 *    ⇒ 本指标**无法**把这两者分列（设计时曾打算分列，实测数据源不支持；见 README 诚实清单）。
 * 🔴 `rejected` **不计入跳过**：拒绝是一个**有效结论**（FDE 明确说了"不"），
 *    把它算成"跳过"会把"认真回答过"污名化成"没回答"。
 * 🔴 `write-failed` 既不是跳过也不是有效结论（D5-pre 确认了但落盘失败，本次推进也失败了）
 *    ⇒ 单列第三桶，绝不并进任何一边。
 */
export const ASK_OUTCOMES = Object.freeze({
  skipped: 'degraded',
  effective: Object.freeze(['confirmed', 'rejected'])
})

/** §14 的六条推翻阈值（与 spec 逐字对应；**改这里等于改判据**）。 */
export const OVERTURN = Object.freeze({
  denyFixRatePct: 30, // ① 长期 < 30%
  denyDefectPct: 20, // ② deny_defect > 20%
  phase4Changes: 5, // ③ Phase 4 单阶段 > 5 次
  askSkipPct: 30, // ④ > 30%
  dwell14Days: 15, // ⑤ Phase 1–4 合计 > 15（口径见 computePhaseDwell 的 note）
  shadowAccuracyPct: 70 // ⑥ < 70%（权威实现在 shadow-stats.js 的 OVERTURN_PCT）
})

const DAY_MS = 86400000

/**
 * 生成一条指标记录。**统一形状**，六个指标无一例外 —— 读者不必逐条记"这个的字段叫什么"。
 *
 * @param {object} m
 * @returns {object}
 */
function metric(m) {
  return {
    id: m.id,
    name: m.name,
    spec: m.spec,
    value: m.value,
    unit: m.unit,
    numerator: m.numerator ?? null,
    denominator: m.denominator ?? null,
    sample: m.sample ?? null,
    // 'exact'  = 分子分母都是链上直接可数的量；
    // 'proxy'  = 有一侧是**代理量**（口径不完美，方向必须写在 note 里）；
    // 'absent' = 数据源缺席（未配置 / 无记录），value 必为 null。
    confidence: m.confidence,
    verdict: m.verdict,
    overturnWhen: m.overturnWhen,
    overturnHit: m.overturnHit ?? false,
    note: m.note,
    buckets: m.buckets ?? {}
  }
}

/**
 * 比值 + 判决的公共出口。**分母为 0 的唯一处理点**（别在别处再写一遍判断）。
 *
 * @param {number|null} num
 * @param {number|null} den
 * @param {boolean} overturnHit
 * @param {string} dataNote - 数据源缺席时的人话原因
 * @returns {{value: number|null, verdict: string, confidence: string}}
 */
function ratioVerdict(num, den, overturnHit, dataNote) {
  if (!Number.isFinite(den) || den === 0) {
    return { value: null, verdict: 'insufficient-data', confidence: 'absent', absentReason: dataNote }
  }
  // ⚠️ 用**整数交叉相乘**比较阈值，不用浮点比值 —— 同 `shadow-stats.js:344` 的理由：
  //    `0.8` 在二进制浮点下不可精确表示，"恰好等于阈值"这条边界必须可复算。
  return {
    value: num / den,
    verdict: overturnHit ? 'overturn' : 'ok',
    confidence: 'exact',
    absentReason: null
  }
}

/**
 * "**有没有可判数据**"的出口 —— 给**绝对值**型指标用（③ 变更触发率 / ⑤ Phase 停留时长）。
 *
 * 🔴 为什么不能套 `ratioVerdict`：那两项的值不是比值，硬套就会逼出一个**假的分母**
 *    （实测第一版正是写成了 `ratioVerdict(sum14, 1, …)` —— `den` 恒为 1 ⇒
 *    "没有可配对的停留"会被算成 `0 天` 并给出 `ok` 判决，**永远不可能红**。
 *    这与本项目既有纪律里的"恒真判据"是同一族错误：它只是一行打印。）
 *
 * @param {number} value - 已经算好的绝对值
 * @param {boolean} hasData - 是否存在**可判**的样本（不是"算出来是 0"）
 * @param {boolean} overturnHit
 * @param {string} dataNote - 无数据时的人话原因
 * @returns {{value: number|null, verdict: string, confidence: string, absentReason: string|null}}
 */
function absoluteVerdict(value, hasData, overturnHit, dataNote) {
  if (!hasData) {
    return { value: null, verdict: 'insufficient-data', confidence: 'absent', absentReason: dataNote }
  }
  return {
    value,
    verdict: overturnHit ? 'overturn' : 'ok',
    confidence: 'exact',
    absentReason: null
  }
}

/** 取记录的有效时间戳（毫秒）；坏 / 缺 ts ⇒ null（由调用方计数报出，不许静默丢弃）。 */
function tsOf(r) {
  const t = Date.parse(r?.ts ?? '')
  return Number.isFinite(t) ? t : null
}

/** 按 ts 升序排（稳定；缺 ts 的留在原地不影响已排序部分）。 */
function sortedByTs(records) {
  return records
    .map((r, i) => ({ r, t: tsOf(r), i }))
    .sort((a, b) => {
      if (a.t === null && b.t === null) return a.i - b.i
      if (a.t === null) return 1
      if (b.t === null) return -1
      return a.t - b.t
    })
}

/** 报表里"样本"这一格的人话（`null` 与 `0` 要能分辨）。 */
function sampleText(m) {
  if (m.value === null) return `—（${m.buckets.absentReason ?? '无样本，不报 0%'}）`
  const v = m.unit === 'pct' ? `${(m.value * 100).toFixed(1)}%` : `${Number(m.value.toFixed(2))}`
  return `${v}${m.unit === 'pct' ? '' : m.unit === 'count' ? ' 次' : ' 天'}`
}

// ═══════════════════════════════════════════════════════════════════════
// ① deny 修复率
// ═══════════════════════════════════════════════════════════════════════

/**
 * ① deny 修复率（spec §14：「deny 拦截后，FDE 真正修复（而非 break-glass 绕过）的比例」）。
 *
 * 🔴 **本指标是 proxy，不是 exact** —— 必须把偏差方向讲清楚（两个方向都有）：
 *
 *    · 分子只认**有实据**的修复：该条 deny 之后，链上出现一次**合法通道的成功写/推进**
 *      （`REPAIR_CHANNELS`，`decision === 'allow'`）。这**低估** ——— FDE 也可能
 *      修在了本链看不见的地方（改的是别的仓库 / 人工改 ontology 后又经一次无关调用落链）。
 *    · 分母 = 全部**有时间戳**的 deny 记录。缺 ts 的进 `undated` 桶、不进分母 ——
 *      它们**判不出方向**（无法比较"之后"），既不能算修复也不能算绕过。
 *    · 绕过配对分**强弱两档**（`denyId` 是 2026-09-29 才补进 `pre-execute.js` 的，
 *      只对未来记录生效 ⇒ 历史 deny 没有它）：
 *        — 强配对：deny 有 `denyId` ⇒ 按 id 严格配；
 *        — 弱配对：deny 无 `denyId` ⇒ 退到按 `tool` 配（`break-glass-bypass` 也带 tool）。
 *          弱配对会把**同工具的不同 deny** 混在一起 ⇒ 可能**高估**绕过率 ⇒ 压低修复率
 *          ⇒ 方向仍是**偏红**。弱配对的条数在 `buckets.weaklyPaired` 里如实报出。
 *
 *    ⇒ 结论方向：**偏红**（分子窄、弱配对只会更低）。选偏红而非偏绿是刻意的 ——
 *      §14 的推翻动作是"下调为 ask / 重审规则质量"，比"漏报门禁位置设错"轻得多。
 *
 * ⚠️ 本函数**只读 gate 链**。phase 链上的 deny（阶段门禁）不在这里 ——
 *    它们与 ontology 变更无关，混进来会让"门禁位置设错"的结论指错地方。
 *
 * @param {object[]} gateRecords
 * @returns {object}
 */
export function computeDenyFixRate(gateRecords) {
  const recs = Array.isArray(gateRecords) ? gateRecords : []
  const denials = recs.filter((r) => r && r.decision === 'deny' && typeof r.tool === 'string')
  const bypasses = recs.filter((r) => r && r.type === 'break-glass-bypass')

  let undated = 0
  let weaklyPaired = 0
  let bypassed = 0
  let fixed = 0
  let unobserved = 0

  for (const d of denials) {
    const dts = tsOf(d)
    // 缺 ts ⇒ **判不出方向**（"之后"没有定义）⇒ 不进分母，单列。
    // ⚠️ 这里**不**把它当成"没被绕过"：那会把一条无法判断的记录算进分子侧，
    //    方向是偏绿 —— 与本节"取偏红"的取舍相反。
    if (dts === null) {
      undated++
      continue
    }
    const hasId = typeof d.denyId === 'string' && d.denyId.length > 0
    if (!hasId) weaklyPaired++
    // 时间上必须在 deny **之后**（链是 append-only，用 ts 比较；
    // 两条链的 seq 是**不同命名空间**，不能用 seq 跨链比大小）。
    const laterBypass = bypasses.some((b) => {
      const bt = tsOf(b)
      if (bt === null || bt < dts) return false
      return hasId ? b.denyId === d.denyId : b.tool === d.tool
    })
    if (laterBypass) {
      bypassed++
      continue
    }
    // 修复实据：deny 之后出现合法通道（写/推进）的成功调用。
    // ⚠️ 只认 `REPAIR_CHANNELS`：`fde_ontology_read` 的 allow **不算**（读一次不构成修复）。
    const repaired = recs.some((r) => {
      if (!r || r.decision !== 'allow' || !REPAIR_CHANNELS.includes(r.tool)) return false
      const rt = tsOf(r)
      return rt !== null && rt >= dts
    })
    if (repaired) fixed++
    else unobserved++
  }

  const den = fixed + bypassed + unobserved
  const rv = ratioVerdict(
    fixed,
    den,
    den > 0 && fixed * 100 < OVERTURN.denyFixRatePct * den,
    'gate 链上没有任何**带时间戳**的 deny 记录（无法判定"之后有没有修"）'
  )
  return metric({
    id: 'deny-fix-rate',
    name: 'deny 修复率',
    spec: 'spec §14 ①：deny 拦截后，FDE 真正修复（而非 break-glass 绕过）的比例。长期 < 30% → 门禁位置设错，应下调为 ask。',
    // 单位是**比值**（0–1），不是百分数 —— `unit:'pct'` 只用来决定报表怎么显示。
    value: rv.value,
    unit: 'pct',
    numerator: fixed,
    denominator: den,
    sample: denials.length,
    confidence: rv.confidence === 'absent' ? 'absent' : 'proxy',
    verdict: rv.verdict,
    overturnWhen: `修复率 < ${OVERTURN.denyFixRatePct}%`,
    overturnHit: rv.verdict === 'overturn',
    buckets: {
      denials: denials.length,
      fixed,
      bypassed,
      unobserved,
      weaklyPaired,
      undated,
      absentReason: rv.absentReason,
      bypassRecordsOnChain: bypasses.length
    },
    note:
      'proxy 口径：分子 = 该 deny **之后**出现合法通道（' +
      REPAIR_CHANNELS.join(' / ') +
      '）成功调用的条数（**低估**修复；只读通道不计）。已确认被 break-glass 绕过的优先算绕过。' +
      `分母 = 带时间戳的 deny ${den} 条（其中弱配对 ${weaklyPaired} 条），另有 ${undated} 条缺 ts ⇒ 单列、不计入分母。` +
      ' ⚠️ 本口径不区分"修复了"与"放弃了"：`unobserved`（' +
      unobserved +
      ' 条）两者都落在里面 —— 这是本 proxy 的最大粗糙处，故达到阈值时应**先人工复核再动门禁位置**。'
  })
}

// ═══════════════════════════════════════════════════════════════════════
// ② break-glass 分类统计
// ═══════════════════════════════════════════════════════════════════════

/**
 * ② break-glass 分类统计（spec §14：「deny_defect / scope_edge / evasion 三类各自的比例」）。
 *
 * 🔴 **只数 phase 链，不数 gate 链。** gate 链上也有 `break-glass`（开）记录，但那是
 *    `index.js` 收到 `fde/break-glass` 事件后写的**镜像**（为了让重启后放行表能恢复）。
 *    两边都数 = 同一件事记两次 = 比例分母翻倍。权威生产者是 phase 的 `fde-break-glass`。
 *
 * @param {object[]} phaseRecords
 * @param {{gateRecords?: object[]}} [opts]
 * @returns {object}
 */
export function computeBreakGlassCategories(phaseRecords, opts = {}) {
  const recs = Array.isArray(phaseRecords) ? phaseRecords : []
  const opens = recs.filter((r) => r && r.type === 'break-glass')
  const counts = { deny_defect: 0, scope_edge: 0, evasion: 0, unknown: 0 }
  for (const r of opens) {
    if (BG_CATEGORIES.includes(r.category)) counts[r.category]++
    else counts.unknown++ // 未知分类必须单列 —— 静默丢弃会让三类的分母悄悄变小
  }
  const den = counts.deny_defect + counts.scope_edge + counts.evasion + counts.unknown
  const defectDen = counts.deny_defect + counts.scope_edge + counts.evasion
  // 未知分类不参与"三类各自的比例"（那三类之外的样本），但它**参与**"有没有数据"的判断。
  const rv = ratioVerdict(
    counts.deny_defect,
    defectDen,
    defectDen > 0 && counts.deny_defect * 100 > OVERTURN.denyDefectPct * defectDen,
    'phase 链上没有任何 break-glass（开）记录 —— 本指标无从计算'
  )
  const gateMirror = (Array.isArray(opts.gateRecords) ? opts.gateRecords : []).filter(
    (r) => r && r.type === 'break-glass'
  ).length
  return metric({
    id: 'break-glass-categories',
    name: 'break-glass 分类统计',
    spec: 'spec §14 ②：deny_defect / scope_edge / evasion 三类各自的比例。deny_defect > 20% → 门禁 bug 太多，需重审规则质量。',
    value: rv.value,
    unit: 'pct',
    numerator: counts.deny_defect,
    denominator: defectDen,
    sample: den,
    confidence: rv.confidence,
    verdict: rv.verdict,
    overturnWhen: `deny_defect 占比 > ${OVERTURN.denyDefectPct}%`,
    overturnHit: rv.verdict === 'overturn',
    buckets: {
      ...counts,
      total: den,
      absentReason: rv.absentReason,
      gateMirrorRecords: gateMirror
    },
    note:
      `value 是 deny_defect 的占比（唯一带推翻条件的那一类）；三类各自比例见 buckets。` +
      (counts.unknown > 0 ? `⚠️ 有 ${counts.unknown} 条 category 不在三类之内，已单列且**不计入**三类比例的分母。` : '') +
      (gateMirror > 0
        ? `gate 链另有 ${gateMirror} 条同事件镜像记录，**未计入**（两边都数会重复计数）。`
        : '') +
      '⚠️ "绕过次数"口径：本指标数的是**开**记录（含尚未补正的），不是"用了多久"——时长见 break-glass 审计里的 resolved 配对。'
  })
}

// ═══════════════════════════════════════════════════════════════════════
// ③ 变更触发率
// ═══════════════════════════════════════════════════════════════════════

/**
 * 从 phase 链的 `phase-advance` 记录构造**时间段 → Phase** 的归属序列。
 *
 * 规则：第 i 条 advance（`{from, to, ts}`）之后的时段（直到第 i+1 条 advance）属 `to`；
 *      第 0 条 advance **之前**的时段属 `from`（那一段的起点在链外 ⇒ 标 truncated）。
 * 这样**任意时刻**都被归到一个 Phase，且不需要猜"进入时刻"。
 *
 * @param {object[]} phaseRecords
 * @returns {{segments: {phase: string, from: number, to: number, truncated: boolean}[],
 *            undated: number, advances: number}}
 */
export function buildPhaseTimeline(phaseRecords) {
  const recs = Array.isArray(phaseRecords) ? phaseRecords : []
  const advances = recs.filter((r) => r && r.type === 'phase-advance' && typeof r.from === 'string')
  let undated = 0
  const dated = []
  for (const a of sortedByTs(advances)) {
    if (a.t === null) {
      undated++
      continue
    }
    dated.push({ from: a.r.from, to: String(a.r.to ?? ''), t: a.t })
  }
  const segments = []
  if (dated.length === 0) return { segments, undated, advances: advances.length }
  for (let i = 0; i < dated.length; i++) {
    // 第 i 条 advance 之后 → 属 dated[i].to
    if (i + 1 < dated.length) {
      segments.push({ phase: dated[i].to, from: dated[i].t, to: dated[i + 1].t, truncated: false })
    } else {
      // 最后一段延伸到"现在"—— 由调用方给 now（本函数不读时钟）
      segments.push({ phase: dated[i].to, from: dated[i].t, to: Infinity, truncated: false })
    }
  }
  // 链开始之前那一段：属第一条 advance 的 from
  segments.unshift({ phase: dated[0].from, from: -Infinity, to: dated[0].t, truncated: true })
  return { segments, undated, advances: advances.length }
}

/**
 * ③ 变更触发率（spec §14：「每个 Phase 平均触发的 L0+L1 变更次数」；「Phase 4 单阶段 > 5 次」）。
 *
 * 数据源**跨两条链**：变更记录（L0/L1）来自 gate 链的 `fde_ontology_write` allow 记录
 * （带 `level` / `autoLevel`），时间归属来自 phase 链的时间段（见 `buildPhaseTimeline`）。
 * 两条链的 `seq` 是**不同命名空间**，配对一律用 `ts` 真实时间。
 *
 * @param {object[]} gateRecords
 * @param {object[]} phaseRecords
 * @param {{now?: number}} [opts]
 * @returns {object}
 */
export function computeChangeRate(gateRecords, phaseRecords, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const grecs = Array.isArray(gateRecords) ? gateRecords : []
  const { segments, undated: undatedAdvances, advances } = buildPhaseTimeline(phaseRecords)

  const changes = grecs.filter(
    (r) =>
      r &&
      r.decision === 'allow' &&
      r.tool === 'fde_ontology_write' &&
      (r.level === 'L0' || r.level === 'L1')
  )
  // 🔴 **没有 `level` 字段的 ontology 写入必须单列、不许静默丢。**
  //    实测真链上就有（`gate.jsonl` 的 seq 4/5：`fde_ontology_write` + `decision:'allow'`
  //    但**没有** `level`）—— 它们是 `level` 字段被加进审计记录**之前**写的。
  //    第一版 filter 只认 `level === 'L0'|'L1'` ⇒ 这两条被**静默排除**，
  //    指标于是少报，而报告里看不出少了任何东西。这是"静默少算"，比算错更难发现。
  const allWrites = grecs.filter((r) => r && r.tool === 'fde_ontology_write' && r.decision === 'allow')
  const noLevel = allWrites.filter((r) => r.level !== 'L0' && r.level !== 'L1' && r.level !== 'L2')

  let outside = 0
  let undated = 0
  /** @type {Map<string, {phase:string,l0:number,l1:number,l2:number,noLevel:number,truncated:boolean}>} */
  const perPhase = new Map()
  // 先按**时间段**把每行建出来 —— 一个走了但零变更的 Phase 也必须在表里。
  // ⚠️ 第一版只从"有变更的段"建行 ⇒ 零变更时 rows 为空 ⇒ 报"无数据"，
  //    而真相是"有 Phase 但没有 L0/L1 变更"（值应该是 0）。那是**分母口径选错**，
  //    不是缺数据 —— 两者的动作完全不同（前者去核 chain 配置，后者什么都不用做）。
  for (const s of segments) {
    const cur = perPhase.get(s.phase) ?? {
      phase: s.phase,
      l0: 0,
      l1: 0,
      l2: 0,
      noLevel: 0,
      truncated: s.truncated
    }
    cur.truncated = cur.truncated || s.truncated
    perPhase.set(s.phase, cur)
  }
  const segOf = (t) => segments.find((s) => t >= s.from && t < (s.to === Infinity ? now + 1 : s.to))
  for (const c of allWrites) {
    const t = tsOf(c)
    if (t === null) continue
    const seg = segOf(t)
    if (!seg) {
      // 落在任何时间段之外（例如 ts 在 now 之后 —— 时钟回拨或写入未来时间）
      outside++
      continue
    }
    const b = perPhase.get(seg.phase) ?? { phase: seg.phase, l0: 0, l1: 0, l2: 0, noLevel: 0, truncated: false }
    if (c.level === 'L0') b.l0++
    else if (c.level === 'L1') b.l1++
    else if (c.level === 'L2') b.l2++
    else b.noLevel++ // 无 level 字段：**计数并报出**，但不计入 L0+L1（判不出级别就不许猜）
    perPhase.set(seg.phase, b)
  }

  const rows = [...perPhase.values()].sort((a, b) => String(a.phase).localeCompare(String(b.phase)))
  const total = rows.reduce((s, r) => s + r.l0 + r.l1, 0)
  // 平均的分母 = **链上有时间段的 Phase 数**（不是 15，也不是"有变更的 Phase 数"）。
  // ⚠️ 链没覆盖到的 Phase 不在分母里 ⇒ 这个平均值**不代表 15 个 Phase 的整体**，
  //    只代表"已经走到过的这些"。写进 note，别让读者外推。
  const den = rows.length
  const p4 = rows.find((r) => String(r.phase) === '4')
  const p4l0l1 = p4 ? p4.l0 + p4.l1 : null
  // ⚠️ Phase 4 缺席 ⇒ 推翻条件**未被评估**（不是"通过"）。`absoluteVerdict` 只在
  //    `den > 0` 时给 ok/overturn，故整体"无时间段"时报 insufficient-data；
  //    而"有时间段但 Phase 4 没走到"时**整体仍是 ok**，只在 note 与 `phase4L0L1: null` 上说明。
  //    这是刻意的：整体 verdict 描述的是"本指标能不能算"，Phase 4 是其中一个子条件。
  const rv = absoluteVerdict(total / den, den > 0, p4l0l1 !== null && p4l0l1 > OVERTURN.phase4Changes, 'phase 链上没有时间段（无 phase-advance 记录或未配置 phaseAuditPath）⇒ 无法把变更归到 Phase')
  const noLevelTotal = rows.reduce((s, r) => s + r.noLevel, 0)
  return metric({
    id: 'change-rate',
    name: '变更触发率',
    spec: 'spec §14 ③：每个 Phase 平均触发的 L0+L1 变更次数。Phase 4 单阶段 > 5 次 → Ontology 首版质量不合格。',
    value: rv.value,
    unit: 'count',
    numerator: total,
    denominator: den,
    sample: allWrites.length,
    confidence: rv.confidence === 'absent' ? 'absent' : noLevelTotal > 0 ? 'proxy' : 'exact',
    verdict: rv.verdict,
    overturnWhen: `Phase 4 单阶段 L0+L1 > ${OVERTURN.phase4Changes} 次`,
    overturnHit: rv.verdict === 'overturn',
    buckets: {
      perPhase: rows,
      phase4L0L1: p4l0l1,
      l0l1Total: total,
      l2Total: rows.reduce((s, r) => s + r.l2, 0),
      noLevelTotal,
      outsideSegments: outside,
      undatedChanges: undated,
      advances,
      undatedAdvances,
      absentReason: rv.absentReason
    },
    note:
      `value = 已走过的 ${den} 个 Phase 的 L0+L1 变更平均值（**分母只含链上出现过的 Phase，不代表 15 个**）。` +
      (p4l0l1 === null
        ? '⚠️ Phase 4 **未在链上出现** ⇒ 本指标的推翻条件**未被评估**（不是"通过了"，是"没数据"）。'
        : `Phase 4 单阶段 ${p4l0l1} 次。`) +
      (noLevelTotal > 0
        ? `🔴 另有 ${noLevelTotal} 条 ontology 写入**没有 level 字段**（写在 level 字段被加进审计之前）⇒ 判不出级别、` +
          `**未计入** L0+L1 ⇒ value 是**下界**，真值上界为 ${Number(((total + noLevelTotal) / den).toFixed(2))} 次/Phase。`
        : '') +
      (outside > 0 ? `⚠️ 有 ${outside} 条变更落在 phase 链的时间段之外，已单列、未计入。` : '') +
      (rows.some((r) => r.truncated)
        ? ' ⚠️ 首个时间段起点在链外（该 Phase 的进入时刻早于 phase 链第一条记录）⇒ 那一行的计数**可能偏高**。'
        : '') +
      ' 被拒的降级尝试（`decision:"deny"`）不计入。'
  })
}

// ═══════════════════════════════════════════════════════════════════════
// ④ ask 跳过率
// ═══════════════════════════════════════════════════════════════════════

/**
 * ④ ask 跳过率（spec §14：「被跳过的 ask 项 / 总 ask 项」；「> 30% → 摩擦点设计错了」）。
 *
 * 分桶口径见 `ASK_OUTCOMES` 的注释（那一处讲了三件事：degraded 是合并档、
 * rejected 是有效结论、write-failed 单列）。
 *
 * @param {object[]} phaseRecords
 * @returns {object}
 */
export function computeAskSkipRate(phaseRecords) {
  const recs = Array.isArray(phaseRecords) ? phaseRecords : []
  const asks = recs.filter((r) => r && typeof r.type === 'string' && r.type.endsWith(ASK_SUFFIX))
  const buckets = { skipped: 0, effective: 0, other: 0, byOutcome: {}, byType: {} }
  for (const a of asks) {
    const o = String(a.outcome ?? '(缺)')
    buckets.byOutcome[o] = (buckets.byOutcome[o] ?? 0) + 1
    buckets.byType[a.type] = (buckets.byType[a.type] ?? 0) + 1
    if (o === ASK_OUTCOMES.skipped) buckets.skipped++
    else if (ASK_OUTCOMES.effective.includes(o)) buckets.effective++
    else buckets.other++ // write-failed / 未知：既不是跳过也不是有效结论
  }
  // 分母 = **总 ask 项**（spec 原文），即三类之和 —— 不是"有效 + 跳过"。
  // 「总 ask 项」就该含失败的那一档；把它剔出去会让分母变小、跳过率虚高。
  const den = asks.length
  const rv = ratioVerdict(
    buckets.skipped,
    den,
    den > 0 && buckets.skipped * 100 > OVERTURN.askSkipPct * den,
    'phase 链上没有任何 *-ask 记录 —— 本流程未走到过 ask 门（D4/D5-pre）'
  )
  return metric({
    id: 'ask-skip-rate',
    name: 'ask 跳过率',
    spec: 'spec §14 ④：被跳过的 ask 项 / 总 ask 项。> 30% → 摩擦点设计错了，FDE 认为无价值。',
    value: rv.value,
    unit: 'pct',
    numerator: buckets.skipped,
    denominator: den,
    sample: den,
    confidence: rv.confidence,
    verdict: rv.verdict,
    overturnWhen: `跳过率 > ${OVERTURN.askSkipPct}%`,
    overturnHit: rv.verdict === 'overturn',
    buckets: {
      ...buckets,
      absentReason: rv.absentReason
    },
    note:
      `跳过 = outcome \`${ASK_OUTCOMES.skipped}\`（**cancelled 与 unavailable 的合并档** —— ` +
      '源记录在 `dsh-fde-phase/lib/tools.js:268/315`（`? \'confirmed\' : \'degraded\'`）就把两者合并了，' +
      '本指标**无法**再拆（`:274/341` 的 `outcome: d4Approval / d5PreApproval` 已是合并后的值）；' +
      '要拆须改 phase 的记录格式，属跨包行为契约变更)。' +
      ` 有效结论 = ${ASK_OUTCOMES.effective.join(' / ')}（\`rejected\` **不算跳过**：拒绝是一个有效结论）。` +
      (buckets.other > 0
        ? ` ⚠️ 另有 ${buckets.other} 条 outcome 为 ${Object.keys(buckets.byOutcome)
            .filter((o) => o !== ASK_OUTCOMES.skipped && !ASK_OUTCOMES.effective.includes(o))
            .join('/')} —— 单列，既不计跳过也不计有效。`
        : '') +
      ' 分母 = 全部 *-ask 记录（含失败档），故跳过率不会因剔档而虚高。'
  })
}

// ═══════════════════════════════════════════════════════════════════════
// ⑤ Phase 停留时长
// ═══════════════════════════════════════════════════════════════════════

/**
 * ⑤ Phase 停留时长（spec §14：「各 Phase 平均日历天数」；「Phase 1–4 合计 > 15 工作日」）。
 *
 * 🔴 **spec 自身在本条上口径不一致**：定义写"日历天数"，推翻条件写"工作日"。
 *    本工具按**日历天**算（定义侧），并在 note 里写明这个偏差的**方向**：
 *    日历天 ≥ 工作日 ⇒ 同一个真实时长下本指标算出的数**更大** ⇒ **偏红**。
 *    （不换算工作日：那需要一张节假日表，而任何我编出来的表都是"编的权威"。）
 *
 * 🔴 严格配对才累加：只有 `advance[i-1].to === advance[i].from` 才构成一段**已结束的**停留。
 *    跳号（4→6）或乱序 ⇒ `unpaired` 计数报出，该段**丢弃**（不臆造时长）。
 *
 * 🔴 **链尾段**（最后一次 advance 的 `to` → now）单列 `chainTail`，**不计入平均**
 *    —— 它是截断值，混进平均会把"还在走的 Phase"算成"很快就走完了"。
 *
 *    ⚠️ **`chainTail.phase` 是"按链推断"，不是"当前是哪个 Phase"的权威答案。**
 *    权威是 `<projectRoot>/memory/state.yaml` 的 `current_phase`，而它**会被手工 seed/restore**
 *    （活验常用手段，不留链记录）。实测本机就出现过：链尾指向 `2→3`，而 state.yaml 是 `10`
 *    （seq88/93/96/99 每次推进到 3 之后都被 re-seed 回 10）。
 *    ⇒ 字段名刻意**不叫** `inProgress` —— 那个名字在断言"现在正处在这个阶段"，
 *    而本函数只读链、读不到 state.yaml。要报"现在在哪个阶段"必须去读 state.yaml。
 *
 * @param {object[]} phaseRecords
 * @param {{now?: number}} [opts]
 * @returns {object}
 */
export function computePhaseDwell(phaseRecords, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const recs = Array.isArray(phaseRecords) ? phaseRecords : []
  const advances = recs.filter((r) => r && r.type === 'phase-advance' && typeof r.from === 'string')
  const dated = []
  let undated = 0
  for (const a of sortedByTs(advances)) {
    if (a.t === null) {
      undated++
      continue
    }
    dated.push({ from: a.r.from, to: String(a.r.to ?? ''), t: a.t })
  }
  /** @type {Map<string, {phase:string, sumMs:number, n:number}>} */
  const byPhase = new Map()
  const pairs = []
  let unpaired = 0
  for (let i = 1; i < dated.length; i++) {
    if (dated[i - 1].to !== dated[i].from) {
      unpaired++ // 不连续：判不出这段停留属于谁
      continue
    }
    const ms = dated[i].t - dated[i - 1].t
    if (ms < 0) {
      unpaired++
      continue
    }
    const ph = dated[i].from
    const b = byPhase.get(ph) ?? { phase: ph, sumMs: 0, n: 0, minMs: Infinity, maxMs: 0 }
    b.sumMs += ms
    b.n++
    b.minMs = Math.min(b.minMs, ms)
    b.maxMs = Math.max(b.maxMs, ms)
    byPhase.set(ph, b)
    pairs.push({ phase: ph, ms, from: new Date(dated[i - 1].t).toISOString(), to: new Date(dated[i].t).toISOString() })
  }
  // 链尾段：**按链推断**（非权威，权威是 state.yaml 的 current_phase —— 见函数头 JSDoc）
  const chainTail = dated.length
    ? { phase: dated[dated.length - 1].to, ms: Math.max(0, now - dated[dated.length - 1].t) }
    : null

  const rows = [...byPhase.values()]
    .sort((a, b) => String(a.phase).localeCompare(String(b.phase)))
    .map((b) => ({
      phase: b.phase,
      n: b.n,
      avgDays: Number((b.sumMs / b.n / DAY_MS).toFixed(3)),
      minDays: Number((b.minMs / DAY_MS).toFixed(3)),
      maxDays: Number((b.maxMs / DAY_MS).toFixed(3))
    }))
  const totalPairs = rows.reduce((s, r) => s + r.n, 0)
  // Phase 1–4 合计：用**逐次停留累加**（不是"各 Phase 平均值再相加"）——
  // spec 说的是"合计"，而同一 Phase 进出多次时两种算法结果不同；累加才是实际经过的时间。
  const sum14Ms = pairs.filter((p) => ['1', '2', '3', '4'].includes(String(p.phase))).reduce((s, p) => s + p.ms, 0)
  const sum14 = sum14Ms / DAY_MS
  const has14 = pairs.some((p) => ['1', '2', '3', '4'].includes(String(p.phase)))
  // 🔴 `has14` 是**数据的判据**，不是那个 1：没有 Phase 1–4 的可配对停留时
  //    `sum14` 恒为 0，若照比值写法给它一个 `den = 1`，判决就**永远不可能红**
  //    （"恒真判据"—— 实测第一版正是这么写的）。用 `absoluteVerdict` 把
  //    "有没有数据"与"值是多少"拆成两个独立的量。
  const rv = absoluteVerdict(
    sum14,
    has14,
    has14 && sum14 > OVERTURN.dwell14Days,
    'phase 链上没有**可配对的** Phase 1–4 停留（无 phase-advance 记录，或推进不连续/跳号 ⇒ 判不出段）'
  )
  return metric({
    id: 'phase-dwell',
    name: 'Phase 停留时长',
    spec: 'spec §14 ⑤：各 Phase 平均日历天数。Phase 1–4 合计 > 15 工作日 → 流程过重，需砍 Phase。',
    value: rv.value,
    unit: 'days',
    numerator: null,
    denominator: totalPairs,
    sample: totalPairs,
    confidence: rv.confidence,
    verdict: rv.verdict,
    overturnWhen: `Phase 1–4 合计 > ${OVERTURN.dwell14Days} 天`,
    overturnHit: rv.verdict === 'overturn',
    buckets: {
      perPhase: rows,
      sumPhase1to4Days: Number(sum14.toFixed(3)),
      pairs: totalPairs,
      unpaired,
      undatedAdvances: undated,
      chainTail: chainTail ? { phase: chainTail.phase, days: Number((chainTail.ms / DAY_MS).toFixed(3)) } : null,
      absentReason: rv.absentReason
    },
    note:
      `value = Phase 1–4 的**逐次停留累加**（日历天）；各 Phase 平均天数见 buckets.perPhase。` +
      ` ⚠️ 口径：spec 定义写"日历天数"、推翻条件写"工作日"，本工具按**日历天**算 ⇒ 日历天 ≥ 工作日 ⇒ 本指标**偏红**（不换算工作日：那需要节假日表，编一张表等于造一个假权威）。` +
      (unpaired > 0 ? ` ⚠️ 有 ${unpaired} 处推进不连续（跳号/乱序），对应停留段**已丢弃**、未计入。` : '') +
      (chainTail
        ? ` ⚠️ 链尾段：链上最后一条推进指向 Phase ${chainTail.phase}（按链推断已 ${(chainTail.ms / DAY_MS).toFixed(2)} 天），单列、未计入平均。` +
          `**这不是"当前处在哪个 Phase"** —— 权威是 state.yaml 的 current_phase；` +
          `手工 seed/restore 会让链尾落后于 state.yaml（实测本机链尾 Phase 3 而 state.yaml Phase 10）。`
        : '')
  })
}

// ═══════════════════════════════════════════════════════════════════════
// ⑥ 影子模式准确率（转调 shadow-stats，不重算）
// ═══════════════════════════════════════════════════════════════════════

/**
 * ⑥ 影子模式准确率 —— **权威实现在 `shadow-stats.js`**，本函数只做形状适配。
 *
 * 为什么转调而不是重算：重写一遍会造出两个"影子准确率"（`fde_shadow_status` 一个、
 * `fde_metrics` 另一个），它们迟早漂移，读者无从分辨哪个是权威。
 * 两个阈值（准入 80 / 推翻 70）也只在 `shadow-stats.js` 定义一份。
 *
 * @param {object} stats - `computeShadowStatsFromChain` 的返回值
 * @returns {object}
 */
export function shadowAccuracyMetric(stats) {
  const s = stats ?? {}
  // 🔴 缺席判据必须是"**有没有可判的样本**"，写成 `rated === 0` 是不够的：
  //    `rated` 缺失（`undefined`）时那个等号为假 ⇒ 会走成 `verdict: 'ok'` + `value: null`
  //    —— 一份**自己违反了本模块红线**的报告（"ok 却没有值"）。离线测试的 A7c 正是拿
  //    这个形状当坏样本的，而第一版源码自己就长这样（实测被 A1b/A3/A7a 三条断言抓住）。
  //    ⇒ 用"是正数"来判有数据，任何非数 / 0 / 负数一律算缺席。
  const ratedOk = typeof s.rated === 'number' && Number.isFinite(s.rated) && s.rated > 0
  // `accuracyPct` 也必须真的是个数 —— 否则会产出"verdict=ok 但 value=null"的自相矛盾形状，
  // 而那个形状正是本模块红线要禁的（坏输入不许让红线失效）。
  const absent =
    !ratedOk ||
    typeof s.accuracyPct !== 'number' ||
    !Number.isFinite(s.accuracyPct) ||
    s.verdict === 'unreadable' ||
    s.verdict === 'no-data'
  return metric({
    id: 'shadow-accuracy',
    name: '影子模式准确率',
    spec: 'spec §14 ⑥：observe 模式下，FDE 认同"这里确实该拦"的比例。< 70% → 不应该切 enforce，门禁还不成熟。',
    value: absent ? null : (s.accuracyPct ?? null),
    unit: 'pct',
    numerator: s.agree ?? null,
    denominator: s.rated ?? null,
    sample: s.total ?? null,
    confidence: absent ? 'absent' : 'exact',
    verdict: absent ? 'insufficient-data' : s.overturn ? 'overturn' : 'ok',
    overturnWhen: `准确率 < ${OVERTURN.shadowAccuracyPct}%（权威实现在 shadow-stats.js 的 OVERTURN_PCT）`,
    overturnHit: s.overturn === true,
    buckets: {
      agree: s.agree ?? null,
      disagree: s.disagree ?? null,
      pending: s.pending ?? null,
      windowSpanDays: s.spanDays ?? null,
      blockers: s.blockers ?? [],
      warnings: s.warnings ?? [],
      absentReason: absent ? `影子统计无可判样本（verdict=${s.verdict ?? '未知'}）` : null
    },
    note:
      '本指标**不重算**：数值、双阈值（准入 80 / 推翻 70）与缺席分档全部来自 shadow-stats.js。' +
      ` 其中准入线与推翻线是**两个不同的数**（70–80 为灰区），详见该文件头。` +
      (s.verdict === 'ready'
        ? ' 当前 verdict=ready（满足 §12 准入）。'
        : ` 当前 verdict=${s.verdict ?? '未知'}，未达 §12 准入。`)
  })
}

// ═══════════════════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════════════════

/**
 * 六个指标一次算齐。**纯函数**（`now` 注入、两条链的记录数组由调用方给）。
 *
 * @param {{gateRecords?: object[], phaseRecords?: object[], shadowStats?: object,
 *          gateRead?: object, phaseRead?: object, gateArchive?: object, phaseArchive?: object,
 *          now?: number}} input
 * @returns {object} 报告
 */
export function computeAllMetrics(input = {}) {
  const g = Array.isArray(input.gateRecords) ? input.gateRecords : []
  const p = Array.isArray(input.phaseRecords) ? input.phaseRecords : []
  const now = Number.isFinite(input.now) ? input.now : Date.now()

  const metrics = [
    computeDenyFixRate(g),
    computeBreakGlassCategories(p, { gateRecords: g }),
    computeChangeRate(g, p, { now }),
    computeAskSkipRate(p),
    computePhaseDwell(p, { now }),
    shadowAccuracyMetric(input.shadowStats ?? {})
  ]

  // 缺席与读取故障：**不参与裁决，但读者必须知道**（同 shadow-stats 的 blockers/warnings 分工）。
  const warnings = []
  for (const [label, read] of [
    ['gate 链', input.gateRead],
    ['phase 链', input.phaseRead]
  ]) {
    if (read && read.ok === false) warnings.push(`${label}读不到：${read.error}`)
    if (read && read.ok === true && (read.badLines ?? 0) > 0) {
      warnings.push(`${label}有 ${read.badLines} 行无法解析（未计入统计）`)
    }
  }
  for (const [label, arch] of [
    ['gate', input.gateArchive],
    ['phase', input.phaseArchive]
  ]) {
    if (arch && arch.files && arch.files.length > 0) {
      warnings.push(
        `${label} 链有 ${arch.files.length} 个**归档段**未计入本报告（${arch.files.join(', ')}）` +
          '⇒ 所有比值只反映**当前活跃链段**，非全史'
      )
    }
    if (arch && arch.error) warnings.push(`${label} 归档段探测失败：${arch.error}`)
  }

  const overturns = metrics.filter((m) => m.verdict === 'overturn').map((m) => m.id)
  const insufficient = metrics.filter((m) => m.verdict === 'insufficient-data').map((m) => m.id)
  return {
    metrics,
    overturns,
    insufficient,
    warnings,
    // 🔴 总判决**只由 "overturn" 驱动**。"insufficient-data" **不算通过**：
    //    它进 `insufficient` 单列，读者一眼能看出"这条没数据"，而不是被一个绿色总判决骗过去。
    verdict: overturns.length > 0 ? 'overturn' : insufficient.length === metrics.length ? 'no-data' : 'ok'
  }
}

/**
 * 薄 IO：读两条链 + 影子统计，算齐六项。
 *
 * @param {{auditPath: string, phaseAuditPath?: string}} cfg
 * @param {{now?: number}} [opts]
 * @returns {Promise<object>}
 */
export async function collectMetrics(cfg, opts = {}) {
  const gatePath = cfg?.auditPath ?? ''
  const phasePath = cfg?.phaseAuditPath ?? ''
  const [gateRead, phaseRead, gateArchive, phaseArchive, shadowStats] = await Promise.all([
    readChainRecords(gatePath),
    phasePath.trim().length === 0
      ? Promise.resolve({
          ok: false,
          reason: 'no-path',
          error:
            '未配置 phaseAuditPath（phase 链路径）⇒ ④ ask 跳过率 / ⑤ Phase 停留时长 / ③ 变更触发率的时间归属**无从计算**'
        })
      : readChainRecords(phasePath),
    listArchivedSegments(gatePath),
    phasePath.trim().length === 0 ? Promise.resolve({ files: [], error: null }) : listArchivedSegments(phasePath),
    computeShadowStatsFromChain(gatePath)
  ])
  return computeAllMetrics({
    gateRecords: gateRead.ok ? gateRead.records : [],
    phaseRecords: phaseRead.ok ? phaseRead.records : [],
    shadowStats,
    gateRead,
    phaseRead,
    gateArchive,
    phaseArchive,
    now: opts.now
  })
}

/**
 * 人话报告（工具输出与活验回执共用同一份 —— 两处各写一遍必然漂移）。
 *
 * @param {object} report - `computeAllMetrics` / `collectMetrics` 的返回值
 * @returns {string}
 */
export function formatMetricsReport(report) {
  const lines = [`spec §14 验证指标（${report.metrics.length} 项）—— 总判决：${report.verdict}`]
  if (report.overturns.length) lines.push(`🔴 达到推翻条件：${report.overturns.join(', ')}`)
  if (report.insufficient.length) {
    lines.push(`⚪ 无数据（**不是通过**）：${report.insufficient.join(', ')}`)
  }
  for (const m of report.metrics) {
    const mark = m.verdict === 'overturn' ? '🔴' : m.verdict === 'insufficient-data' ? '⚪' : '✅'
    lines.push(
      `  ${mark} ${m.name}（${m.id}）：${sampleText(m)}` +
        `　[${m.confidence}]` +
        (m.denominator !== null ? `　分子/分母 = ${m.numerator ?? '—'}/${m.denominator}` : '')
    )
    lines.push(`      推翻条件：${m.overturnWhen}${m.overturnHit ? '　← **已命中**' : ''}`)
    lines.push(`      口径：${m.note}`)
  }
  if (report.warnings.length) {
    lines.push('须知（不参与裁决，但会影响读法）：')
    for (const w of report.warnings) lines.push(`  · ${w}`)
  }
  return lines.join('\n')
}
