import { readFile, readdir } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * 影子模式统计（spec v3 §12 影子模式 + §14 验证指标）。
 *
 * spec §12 原文：
 *   「observe（影子）记录"本应 deny"但不阻断；弹窗提示"这里会被拦"但你可以继续」
 *   「新项目默认 observe 模式」
 *   「连续 7 天 deny 预判准确率 > 80%（即插件认为该拦的，你也觉得确实该拦）→ 可切 enforce」
 *   「切换本身是 R2 级确认：逐条确认所有历史"本应 deny"的项」
 *   「切换后仍可随时切回 observe」
 * spec §14 原文：
 *   「影子模式准确率：observe 模式下，FDE 认同"这里确实该拦"的比例
 *     < 70% → 不应该切 enforce，门禁还不成熟」
 *
 * ─────────────────────────────────────────────────────────────────────
 * 🔴 **两个阈值不是同一个数的两种写法，也不是互相矛盾**（差距清单 0090 E4 行
 *    曾把 `pre-execute.js:10` 的注释口径判为"与 spec 不一致"，对，但理由要写准）：
 *
 *    - `ADMIT_PCT = 80`   ← §12 的**准入线**。达到它**才允许**切 enforce（必要条件之一）。
 *    - `OVERTURN_PCT = 70`← §14 的**推翻线**。低于它说明门禁**不成熟**，该重审规则质量。
 *
 *    70–80 之间是一段**灰区**：不推翻（门禁没坏），但也**不够切**（证据不足）。
 *    这正是 `pre-execute.js:10` 原注释（「准确率 ≥70% 再切 enforce」）的错处 ——
 *    它把 §14 的推翻线当成了 §12 的准入线来用。那句话已在本轮修正。
 *
 *    把两者合成一个"阈值"会同时错两次：门槛低了（70 就放行）或高了（80 以下就判门禁坏）。
 * ─────────────────────────────────────────────────────────────────────
 *
 * 本模块**分两层**：
 *   ① 纯函数 `computeShadowStats(records, opts)` —— 零 IO，边界可穷举（离线测试的主体）；
 *   ② 两个薄 IO helper `readChainRecords` / `listArchivedSegments` —— 只负责"把字节变成数组"，
 *      并**分档报告缺席**（见下）。
 *
 * 🔴 **缺席必须分档，不许压成"空数组"**（本项目既有纪律「缺席有三层」）：
 *    · 链文件不存在        ⇒ `ok:false, reason:'enoent'`（读不到，不等于没有样本）
 *    · 链文件存在但为空    ⇒ `ok:true, records:[]`（真的没有样本）
 *    · 链可读但有坏行      ⇒ `ok:true, badLines:N`（**必须报出来**，否则静默少算样本）
 *    · `auditPath` 为 ''   ⇒ `ok:false, reason:'no-path'`（链只驻内存，统计根本无从谈起）
 *   把第一种说成第二种，读者会得到"影子期没有预判"的**假结论**，而真相是"统计读不到数据"。
 */

/** spec §12 准入线：准确率必须**严格大于** 80% 才允许切 enforce。 */
export const ADMIT_PCT = 80

/** spec §14 推翻线：准确率**小于** 70% ⇒ 门禁不成熟，不应切 enforce。 */
export const OVERTURN_PCT = 70

/** spec §12 的"连续 7 天"，以**毫秒跨度**落地（日历天数会让"同一天两个样本"算 1 天）。 */
export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** 审计里代表"enforce 会拦但 observe 下放行"的决策标签（`pre-execute.js:36` 产出）。 */
export const SHADOW_DENY = 'shadow-deny'

/** 审计里代表"FDE 对该条 shadow-deny 的逐条确认结论"的决策标签（`shadow-tools.js` 产出）。 */
export const SHADOW_JUDGED = 'shadow-judged'

/** 逐条确认的两种结论（spec §14 的分子/分母来源）。 */
export const VERDICTS = ['agree', 'disagree']

/** 审计里代表"一次模式切换的裁决"的决策标签（`shadow-tools.js` 产出）。 */
export const MODE_SWITCH = 'mode-switch'

/** 审计里代表"启动时发现 enforce 无批准记录"的决策标签（`index.js` apply 期产出）。 */
export const MODE_SWITCH_UNATTESTED = 'mode-switch-unattested'

/**
 * 取链上**最后一条**模式切换记录。
 *
 * 🔴 为什么是"最后一条"而不是"存在一条 approved 的"：
 *    approve(enforce) → switch(observe) → 运维又手改配置回 enforce
 *    这条路径上，T1 那次批准**已被 T2 的 observe 抵消**，不该再算数。
 *    只搜"存在 approved"会把它当有效凭据 —— 门就漏了。
 *    ⇒ 按 seq 取最大者（链是 append-only，seq 单调；缺 seq 的按出现顺序兜底）。
 *
 * @param {object[]} records
 * @returns {object|null}
 */
export function lastModeSwitch(records) {
  let best = null
  let bestSeq = -Infinity
  // 防御：`readChainRecords().records` 在**读不到时是 `undefined`**（不是 `[]`）。
  // 判据函数不许被坏输入弄崩 —— 崩一次会让上层整段逻辑（含本该给出的告警）消失，
  // 而那正是"读不到链"这个最需要被说出来的场景。
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r !== 'object' || r.decision !== MODE_SWITCH) continue
    const s = Number.isInteger(r.seq) ? r.seq : Infinity // 缺 seq 的按"最后出现"算
    if (s >= bestSeq) {
      bestSeq = s
      best = r
    }
  }
  return best
}

/**
 * 当前 enforce 是否**有链上凭据**（spec §12 的"才可切 enforce"）。
 *
 * 返回 `attested: false` 的两种情形要分开报（`why`）：
 *   · `'none'`     —— 链上从来没有过模式切换记录（本流程从未走过）
 *   · `'observe'`  —— 最后一次是切回 observe（旧批准已被抵消）
 *   · `'rejected'` —— 最后一次是**被拒**的 enforce 尝试（明确记录过不达标）
 * 三种都不是"批准"，但运维要采取的动作不同 ⇒ 不能压成一个布尔。
 *
 * @param {object[]} records
 * @returns {{attested: boolean, why: string, record: object|null}}
 */
export function enforceAttestation(records) {
  const last = lastModeSwitch(records)
  if (!last) return { attested: false, why: 'none', record: null }
  if (last.to === 'observe') return { attested: false, why: 'observe', record: last }
  if (last.to === 'enforce' && last.approved === true) return { attested: true, why: 'approved', record: last }
  return { attested: false, why: 'rejected', record: last }
}

/**
 * 解析链文本 → 记录数组。**纯函数**：async 读、sync 读共用这一份，
 * 避免"异步版与同步版对同一份字节给出不同结果"（那种漂移只能靠人去比对，测不出来）。
 *
 * @param {string} text
 * @returns {{records: object[], badLines: number, bytes: number}}
 */
export function parseChainText(text) {
  const lines = String(text).split('\n').filter((l) => l.trim().length > 0)
  const records = []
  let badLines = 0
  for (const line of lines) {
    try {
      records.push(JSON.parse(line))
    } catch {
      badLines++
    }
  }
  return { records, badLines, bytes: Buffer.byteLength(String(text), 'utf8') }
}

/** 把"读不到"的两种常见 errno 归一成人话（async / sync 两条路径共用同一套措辞）。 */
function ioFailure(e, chainPath) {
  if (e?.code === 'ENOENT') {
    return { ok: false, reason: 'enoent', error: `审计链文件不存在：${chainPath}` }
  }
  return {
    ok: false,
    reason: 'io',
    error: `审计链不可读（${String(e?.code ?? '')}）：${String(e?.message ?? e)}`
  }
}

const NO_PATH = {
  ok: false,
  reason: 'no-path',
  error: '审计链未落盘（auditPath 为空，链只驻内存、进程退出即失）⇒ 无历史可统计'
}

/**
 * 读链文件（异步），**分档**返回。
 *
 * @param {string} chainPath
 * @returns {Promise<{ok: boolean, records?: object[], badLines?: number, bytes?: number,
 *                    reason?: string, error?: string}>}
 */
export async function readChainRecords(chainPath) {
  if (typeof chainPath !== 'string' || chainPath.trim().length === 0) return NO_PATH
  let text
  try {
    text = await readFile(chainPath, 'utf8')
  } catch (e) {
    return ioFailure(e, chainPath)
  }
  return { ok: true, ...parseChainText(text) }
}

/**
 * 同步版（**只在插件 `apply()` 期用**：apply 是同步函数，拿不到 await）。
 *
 * 用同步 IO 的理由与 `AuditChain#restoreFromTail` / `formatProtectedRootsLine` 相同：
 * 只在挂载期跑一次、文件量在几十 KiB 量级，不值得为它把 apply 改成异步
 * （改了会连带改变插件的加载时序 —— 那个代价比几十毫秒的同步读大得多）。
 *
 * @param {string} chainPath
 * @returns {{ok: boolean, records?: object[], badLines?: number, bytes?: number,
 *            reason?: string, error?: string}}
 */
export function readChainRecordsSync(chainPath) {
  if (typeof chainPath !== 'string' || chainPath.trim().length === 0) return NO_PATH
  let text
  try {
    text = readFileSync(chainPath, 'utf8')
  } catch (e) {
    return ioFailure(e, chainPath)
  }
  return { ok: true, ...parseChainText(text) }
}

/**
 * 列出同目录下的**归档链段**（同步版，apply 期用）。
 * @param {string} chainPath
 * @returns {{files: string[], error: string|null}}
 */
export function listArchivedSegmentsSync(chainPath) {
  if (typeof chainPath !== 'string' || chainPath.trim().length === 0) return { files: [], error: null }
  const dir = dirname(chainPath)
  const prefix = basename(chainPath) + '.'
  try {
    const files = readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .filter((n) => !n.endsWith('.manifest.md'))
      .sort()
    return { files, error: null }
  } catch (e) {
    return { files: [], error: `归档段目录不可读：${String(e?.code ?? e)}` }
  }
}

/**
 * 列出同目录下的**归档链段**（`<chain>.2026-09-26T10-18-10-793Z` 形态）。
 *
 * 为什么必须报出来：归档是把旧链**切成两段**，而本统计只读 `cfg.auditPath` 指向的那一段
 * ⇒ 影子期若发生在归档侧，当前段的样本数**系统性偏低**。静默返回一个更小的 N，
 * 读者会得出"样本不够"之外完全错误的结论（"影子期没跑过"）。
 * 本函数**只负责让这件事可见**，不自动合并（合并口径需人来定，见 README 缺口）。
 *
 * @param {string} chainPath
 * @returns {Promise<{files: string[], error: string|null}>}
 */
export async function listArchivedSegments(chainPath) {
  if (typeof chainPath !== 'string' || chainPath.trim().length === 0) return { files: [], error: null }
  const dir = dirname(chainPath)
  const prefix = basename(chainPath) + '.'
  try {
    const entries = await readdir(dir)
    const files = entries
      .filter((n) => n.startsWith(prefix))
      // `.manifest.md` 是归档时写的说明文件，不是链段
      .filter((n) => !n.endsWith('.manifest.md'))
      .sort()
    return { files, error: null }
  } catch (e) {
    return { files: [], error: `归档段目录不可读：${String(e?.code ?? e)}` }
  }
}

/**
 * 从链记录里挑出影子模式相关的两类记录。
 *
 * ⚠️ 单独导出：`shadow-tools.js` 要按 `refSeq` 定位一条 shadow-deny（逐条确认用），
 *    走的必须是**同一套**挑选取舍，否则"统计看到的项"与"能确认到的项"会不是同一集合。
 *
 * @param {object[]} records
 */
export function pickShadowRecords(records) {
  const shadow = []
  const judged = []
  for (const r of records) {
    if (!r || typeof r !== 'object') continue
    if (r.decision === SHADOW_DENY) shadow.push(r)
    else if (r.decision === SHADOW_JUDGED) judged.push(r)
  }
  return { shadow, judged }
}

/**
 * 计算影子模式统计。**纯函数**：无 IO、无时钟依赖（`now` 显式传入或不用）。
 *
 * @param {object[]} records - 链记录（已 JSON.parse）
 * @param {{ archivedSegments?: string[], chainPath?: string, readError?: string|null,
 *           badLines?: number }} [opts]
 * @returns {object} stats
 */
export function computeShadowStats(records, opts = {}) {
  const archivedSegments = opts.archivedSegments ?? []
  const list = Array.isArray(records) ? records : []
  const { shadow, judged } = pickShadowRecords(list)

  // ---- 逐条确认的结论按 refSeq 归并 ----
  // append-only 语义：同一条 shadow-deny 被确认多次 ⇒ **取第一条**（既成结论不许改判），
  // 并把重复计数报出来（链上有异常，不能静默按最后一条算）。
  const byRef = new Map()
  let duplicateJudged = 0
  let malformedJudged = 0
  for (const j of judged) {
    if (!Number.isInteger(j.refSeq)) {
      malformedJudged++
      continue
    }
    if (j.verdict !== 'agree' && j.verdict !== 'disagree') {
      malformedJudged++
      continue
    }
    if (byRef.has(j.refSeq)) {
      duplicateJudged++
      continue
    }
    byRef.set(j.refSeq, j)
  }

  // ---- shadow-deny 样本 ----
  const seqs = new Set()
  const times = []
  let undated = 0 // 缺 / 坏 ts：无法参与窗口计算
  let unseqed = 0 // 缺 seq：无法被逐条确认（refSeq 指不到它）
  let duplicateSeq = 0
  for (const s of shadow) {
    if (Number.isInteger(s.seq)) {
      if (seqs.has(s.seq)) duplicateSeq++
      seqs.add(s.seq)
    } else {
      unseqed++
    }
    const t = Date.parse(s.ts)
    if (Number.isFinite(t)) times.push(t)
    else undated++
  }
  times.sort((a, b) => a - b)

  // ---- 标注（只认指向真实存在样本的那些） ----
  let agree = 0
  let disagree = 0
  let orphanJudged = 0
  for (const [refSeq, j] of byRef) {
    if (!seqs.has(refSeq)) {
      orphanJudged++
      continue
    }
    if (j.verdict === 'agree') agree++
    else disagree++
  }
  const rated = agree + disagree
  const pending = shadow.length - rated

  // ---- 窗口：最早 → 最晚的**跨度** ----
  const spanMs = times.length >= 2 ? times[times.length - 1] - times[0] : 0
  // 相邻样本的最大间隔。**只作为可见事实报出，不参与裁决** ——
  // spec 的"连续"没有可判的权威口径，"中间不能有 N 天空档"这个 N 我不编（README 缺口）。
  let maxGapMs = 0
  for (let i = 1; i < times.length; i++) maxGapMs = Math.max(maxGapMs, times[i] - times[i - 1])
  // 只算一次：warnings 与返回值共用同一个量（各算一遍 = 两个数可能漂移）
  const maxGapDays = Number((maxGapMs / 86400000).toFixed(4))
  const spanDays = Number((spanMs / 86400000).toFixed(4))

  const windowOk = spanMs >= WINDOW_MS
  // ⚠️ 用**整数交叉相乘**比较，不用浮点比值：`agree*100 > 80*rated` 与"8/10 是否 > 80%"
  //    在二进制浮点下不是同一件事（0.8 不可精确表示）。整数比较让"恰好 80% ⇒ 不通过"
  //    这条边界**可复算**，而不是靠"浮点误差应该不会咬到"。
  const admitOk = rated > 0 && agree * 100 > ADMIT_PCT * rated
  const overturnHit = rated > 0 && agree * 100 < OVERTURN_PCT * rated
  const accuracyPct = rated === 0 ? null : (agree * 100) / rated

  // ---- 异常量：任何一条都**不许静默** ----
  const anomalies =
    (opts.badLines ?? 0) + undated + unseqed + duplicateSeq + orphanJudged + malformedJudged + duplicateJudged

  // ---- 判决 ----
  let verdict
  if (opts.readError) verdict = 'unreadable'
  else if (shadow.length === 0) verdict = 'no-data'
  else if (overturnHit) verdict = 'overturn'
  else if (admitOk && windowOk && pending === 0 && anomalies === 0) verdict = 'ready'
  else verdict = 'not-ready'

  // ---- 未达标原因（人话，且每条都对应上面一个可复算的量） ----
  //
  // 🔴 `blockers` 与 `warnings` **必须分开**，否则会产出自相矛盾的输出：
  //    "verdict=ready 但 blockers 非空"。原因是两类信息的**作用不同**：
  //      · blockers —— 参与裁决，`verdict !== 'ready'` 时必然非空、`ready` 时必然为空；
  //      · warnings —— 不参与裁决，但读者必须知道（否则会照着一个**不完整的样本**下结论）。
  //    归档段正是后者：它缺席只会让样本数**偏少**（更保守、更不容易 ready），
  //    不会让结论变松 ⇒ 不该阻断，但绝不该静默。
  const blockers = []
  const warnings = []
  if (opts.readError) blockers.push(`审计链读不到：${opts.readError}`)
  if (shadow.length === 0) blockers.push('observe 期尚无"本应 deny"样本（0 条 shadow-deny）')
  if (shadow.length > 0 && !windowOk) {
    blockers.push(
      `时间跨度 ${(spanMs / 86400000).toFixed(2)} 天 < 7 天（spec §12 要求"连续 7 天"，本模块按最早→最晚的跨度落地）`
    )
  }
  if (pending > 0) blockers.push(`尚有 ${pending} 项未逐条确认（spec §12：切换是 R2 级确认，须逐条确认所有历史"本应 deny"的项）`)
  if (rated > 0 && !admitOk && !overturnHit) {
    blockers.push(`准确率 ${accuracyPct.toFixed(1)}% 未**严格大于** ${ADMIT_PCT}%（恰为 ${ADMIT_PCT}% 不算达标）`)
  }
  if (overturnHit) {
    blockers.push(
      `准确率 ${accuracyPct.toFixed(1)}% < ${OVERTURN_PCT}% ⇒ 按 spec §14 **门禁还不成熟**，不应切 enforce（这不是"再攒点数据"，是规则质量要重审）`
    )
  }
  if ((opts.badLines ?? 0) > 0) blockers.push(`链上有 ${opts.badLines} 行无法解析（未计入统计）`)
  if (undated > 0) blockers.push(`${undated} 条 shadow-deny 缺 / 坏 ts，无法参与窗口计算`)
  if (unseqed > 0) blockers.push(`${unseqed} 条 shadow-deny 缺 seq，无法被逐条确认（refSeq 指不到它）`)
  if (duplicateSeq > 0) blockers.push(`链上有 ${duplicateSeq} 条 seq 重号（同一 seq 出现多次）`)
  if (orphanJudged > 0) blockers.push(`有 ${orphanJudged} 条确认指向不存在的 shadow-deny 项（链被切过 / 该项在归档段）`)
  if (malformedJudged > 0) blockers.push(`有 ${malformedJudged} 条 shadow-judged 记录缺 refSeq 或 verdict 非法`)
  if (duplicateJudged > 0) blockers.push(`有 ${duplicateJudged} 条重复确认（append-only：按第一条算，重复不改判）`)
  if (archivedSegments.length > 0) {
    warnings.push(
      `同目录存在 ${archivedSegments.length} 个**归档链段**未计入本统计（${archivedSegments.join(', ')}）` +
        `⇒ 影子期若发生在归档侧，本 N 系统性偏低（方向是保守的：样本偏少只会更难达标）`
    )
  }
  if (opts.archiveError) warnings.push(opts.archiveError)
  if (spanMs > 0) {
    warnings.push(
      `样本间最大间隔 ${maxGapDays} 天 —— 本模块只按"最早→最晚的跨度"落地 spec §12 的"连续 7 天"，` +
        `**未校验中间是否有空档**（"连续"的可判口径无权威定义，不编；见 README 缺口）`
    )
  }
  // `ready` 与 `blockers` 的关系是**双向可断言的不变量**（离线测试钉死）：
  //   ready ⇒ blockers 为空；且 blockers 非空 ⇒ 不 ready。
  // 它成立的代价是上面每个 push 都必须与 verdict 的判据**逐条对应**——加判据时别只改一半。
  if (verdict === 'ready' && blockers.length > 0) {
    warnings.push('内部不一致：verdict=ready 却有 blockers（判据与 blocker 生成逻辑漂移了）')
  }

  return {
    chainPath: opts.chainPath ?? '',
    total: shadow.length,
    rated,
    agree,
    disagree,
    pending,
    accuracyPct,
    oldestTs: times.length ? new Date(times[0]).toISOString() : null,
    newestTs: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    spanMs,
    spanDays,
    maxGapMs,
    maxGapDays,
    windowOk,
    admitOk,
    overturn: overturnHit,
    verdict,
    ready: verdict === 'ready',
    blockers,
    warnings,
    anomalies,
    archivedSegments,
    badLines: opts.badLines ?? 0
  }
}

/**
 * 一步到位：读链 + 探归档 + 算统计。IO 与纯逻辑分开，只是为了让上面那个可穷举。
 *
 * @param {string} chainPath
 * @returns {Promise<object>} stats（`verdict === 'unreadable'` 表示链读不到）
 */
export async function computeShadowStatsFromChain(chainPath) {
  const read = await readChainRecords(chainPath)
  const arch = await listArchivedSegments(chainPath)
  if (!read.ok) {
    return computeShadowStats([], {
      chainPath,
      readError: read.error,
      archivedSegments: arch.files,
      archiveError: arch.error
    })
  }
  return computeShadowStats(read.records, {
    chainPath,
    badLines: read.badLines,
    archivedSegments: arch.files,
    archiveError: arch.error
  })
}

/**
 * 同步版一步到位（**仅供 apply 期的 unattested 检查**，不用于工具 —— 工具走异步版）。
 * @param {string} chainPath
 */
export function computeShadowStatsFromChainSync(chainPath) {
  const read = readChainRecordsSync(chainPath)
  const arch = listArchivedSegmentsSync(chainPath)
  if (!read.ok) {
    return computeShadowStats([], {
      chainPath,
      readError: read.error,
      archivedSegments: arch.files,
      archiveError: arch.error
    })
  }
  return computeShadowStats(read.records, {
    chainPath,
    badLines: read.badLines,
    archivedSegments: arch.files,
    archiveError: arch.error
  })
}

/**
 * 列出**尚未逐条确认**的 shadow-deny 项，按 `seq` 升序。
 *
 * 为什么升序：R2 逐条确认的顺序必须**可复现** —— 按链上出现顺序问，
 * 换个人/换个时间跑，问的是同一批、同一个次序。按 `ts` 排会被"缺 ts 的样本"搅乱。
 *
 * ⚠️ 缺 `seq` 的样本**无法被确认**（`refSeq` 指不到它）⇒ 这里**不返回**它们；
 *    它们由 `computeShadowStats` 的 `unseqed` 计数报出，并作为切换的硬 blocker
 *    （详见 `shadow-tools.js` 的数据闸门）。
 *
 * @param {object[]} records
 * @returns {object[]}
 */
export function pendingShadowRecords(records) {
  const { shadow, judged } = pickShadowRecords(records)
  const settled = new Set()
  for (const j of judged) {
    if (Number.isInteger(j.refSeq) && (j.verdict === 'agree' || j.verdict === 'disagree')) {
      settled.add(j.refSeq)
    }
  }
  return shadow
    .filter((s) => Number.isInteger(s.seq) && !settled.has(s.seq))
    .sort((a, b) => a.seq - b.seq)
}

/** 给工具回执 / 日志用的一行人话摘要。 */
export function formatShadowStats(s) {
  const acc = s.accuracyPct === null ? '—' : `${s.accuracyPct.toFixed(1)}%`
  return (
    `影子统计：样本 ${s.total} 条、已逐条确认 ${s.rated} 条（认同 ${s.agree} / 不认同 ${s.disagree}）、` +
    `准确率 ${acc}、跨度 ${s.spanDays} 天（>${ADMIT_PCT}% 且 ≥7 天方可切 enforce）⇒ ${s.verdict}` +
    (s.warnings.length ? `；⚠️ ${s.warnings.length} 条须知` : '')
  )
}

/** 归档段的完整路径（供回执贴出，读者可直接打开核对）。 */
export function archivedPaths(chainPath, files) {
  return files.map((f) => join(dirname(chainPath), f))
}
