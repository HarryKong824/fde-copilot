/**
 * 审计外置 **L3 —— 外置只写端点投递** ＋ **离线降级模式**（spec 第八节 L3/L4）。
 *
 * spec 原文（§8）：
 *   「L3 外置  自定义 TelemetryBackend → HTTP(S) 只写端点
 *              → FDE 账号对远端只读，写凭据由服务账号持有」
 *   「L4 交叉校验  deny 校验 = 本地链完整 AND（远端存在 OR 降级模式）」
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 🔴 **为什么没有实现 spec 字面上的 `SessionTelemetryBackend`**（这是**有意偏离**，不是漏做）
 *
 * spec §9.0 自己写着「开发第 0 步：验证这些 API …… 对不上先改方案再写代码」。实测对不上的有两处：
 *
 * ① `ctx.sessionTelemetry` **只有一个位**（seam README：重复加载抛异常），而本部署**已经**装了
 *    `@deepseek-ai/dsh-session-telemetry-otel`（活体 `pluginInventory/list` 实测 `fiberPhase: active`）。
 *    再注册一个是**重复注册 ⇒ 抛错**，不是"多一个后端"。
 * ② 那个已装后端跑的是默认 `mode: DISABLED`，而 DISABLED 的行为是「**不构造协调器**」⇒
 *    seam 的 `session-telemetry/record` waterfall **永远不会被派发**。也就是说：
 *    就算不撞①、改成挂一个 waterfall 监听器，这条路在本部署下**也是死的**。
 *
 * ⇒ 本插件**不碰 seam 槽位**，L2/L3 建在**自己已有的 L1 采集**（`ctx.on('session/event')`）之上。
 *    代价诚实写明：**拿不到 seam 的 `sharing` 披露与「每 (turn,step) 只发首块」投影**，
 *    本模块投递的是**本插件自己捕获的**审计记录（L1 已经脱敏过的那批）。
 *    收益是这条路在本部署下**真的会跑**，而不是挂一个永远不触发的后端。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 🔴 **降级不是"和正常一样安全"**（spec §8 诚实边界原文）。本模块把它落成三件事：
 *   ① 阈值只有一个真源 ⇒ 写进 `state.json` 的 `degradeAfterMs`（`outbox.js` 的 `emptyState()`，
 *      写入时在 `:61-80`），phase 侧读出来**现算**（`remote-state.js` 的 `evaluateRemote()`，
 *      写入时在 `:94` 起）—— 现算的理由：阈值到点那一刻
 *      **没有任何写入动作**，缓存成布尔必然过期。
 *   ② 降级窗口内投递成功的条数记在 `state.degradedDelivered`（本文件 `drainQueue()` 里 +1、
 *      `markSuccess()` 里归零；写入时分别在 `:301` 与 `:230`），
 *      随 `telemetry-recovered` 记录以 `pendingReview: N` 说出（本文件 `markSuccess()` 里，
 *      写入时在 `:219-230`）。
 *      ⚠️ **它数的是"这段窗口里投递成功了几条"，不是"降级期间放行了几次 deny"** ——
 *      后者只有 phase 的 guard 知道，而 `state.json` 的写者只有本插件（单写者纪律），
 *      所以那个数改记在 **phase 自己的链**上（`type:'phase-advance'` 带 `degraded:true`）。
 *      早期版本想在本文件里加 `degradedPasses` 字段，**已删**：没有唯一维护者的字段迟早
 *      变成一个没人更新的谎。理由见 `README.md` §12.4。
 *   ③ 恢复时把 ② 那个 N 写成一条审计记录（spec：「恢复后集中提示"降级期间有 N 条事件待复核"」）。
 *
 * 🔴 **只写端点**：本模块只发 POST，**从不** GET / 从不解析响应体内容（只看状态码）。
 *    spec §8「FDE 账号对远端只读，写凭据由服务账号持有」—— 这里用的就是服务账号的写凭据
 *    （`telemetryToken`），它跟 FDE 的读凭据不是一回事。
 */

import { NAME } from './config.js'
import {
  countOutboxSync,
  emptyState,
  listOutboxSync,
  outboxRootOf,
  readOutboxSync,
  readStateSync,
  removeOutboxSync,
  sweepTmpSync,
  writeOutboxSync,
  writeStateSync
} from './outbox.js'

/** 心跳记录类型：只用来证明"远端可达"，**不进队列**（它没有审计链 seq 可挂）。 */
export const HEARTBEAT_KIND = 'telemetry-heartbeat'

/**
 * 本模块写进审计链的四种记录类型。
 * 它们属于 memory 插件自己的链（`memory/audit/events.jsonl`），**不是** phase/gate 的链，
 * 所以不需要跨包镜像（phase 的 L4 读的是 `outbox/state.json`，不是这些类型）。
 */
export const AUDIT_KINDS = Object.freeze({
  telemetryDisabled: 'telemetry-disabled',
  telemetryStateReset: 'telemetry-state-reset',
  telemetryDegraded: 'telemetry-degraded',
  telemetryRecovered: 'telemetry-recovered',
  telemetryTmpSwept: 'telemetry-tmp-swept'
})

/**
 * L4 的**纯判据**（无 IO）—— `deny 校验 = 本地链完整 AND（远端存在 OR 降级模式)` 的后半个括号。
 *
 * 🔴 phase 插件里有同一份逻辑的**镜像**（`lib/remote-state.js`），由 `_fde_d1_crosspkg_test.mjs`
 * 用同一批输入逐例对拍 ⇒ 两边算出的状态必须逐字相同。**不要**只想改一边。
 *
 * 三档 + 每档的判据：
 *   - `present`  最后一次投递成功、且当前没有未恢复的中断 ⇒ 括号成立
 *   - `degraded` 有未恢复中断，且中断时长 **≥** `degradeAfterMs` ⇒ 括号成立（但带 `degraded` 标记）
 *   - `missing`  其余（含"从未成功投递过"）⇒ 括号**不成立**，deny 校验该失败
 *
 * ⚠️ `lastDeliveredAt === null && outageSince === null`（启动了但还没试过）判成 `missing`：
 *    这是 **fail-closed**。"从来没成功过"不是"远端存在"的证据 —— 而启动心跳会很快把它翻成
 *    `present`（可达）或 `missing`（不可达，且开始计时）。**不许**把它判成 present 来图省事。
 *
 * @param {object} state - 已通过 `readStateSync` 校验的状态对象
 * @param {number} now - `Date.now()`
 * @returns {{status: 'present'|'degraded'|'missing', outageMs: number|null, reason: string}}
 */
export function evaluateRemote(state, now) {
  if (state.outageSince === null) {
    if (state.lastDeliveredAt !== null) {
      return { status: 'present', outageMs: null, reason: `最后一次投递成功于 ${state.lastDeliveredAt}，无未恢复中断` }
    }
    return {
      status: 'missing',
      outageMs: null,
      reason: '从未成功投递过（没有"远端存在"的证据）—— 首次投递成功前判为不满足'
    }
  }
  const since = Date.parse(state.outageSince)
  if (!Number.isFinite(since)) {
    // 时间戳解析不出来 ⇒ 进度算不了 ⇒ fail-closed（不许用 NaN 比较蒙混过关）
    return { status: 'missing', outageMs: null, reason: `outageSince 不是可解析的时间：${JSON.stringify(state.outageSince)}` }
  }
  const outageMs = Math.max(0, now - since)
  if (outageMs >= state.degradeAfterMs) {
    return {
      status: 'degraded',
      outageMs,
      reason: `远端中断已 ${(outageMs / 3600000).toFixed(2)}h（≥ 阈值 ${(state.degradeAfterMs / 3600000).toFixed(2)}h）⇒ 进入降级模式`
    }
  }
  return {
    status: 'missing',
    outageMs,
    reason: `远端中断 ${(outageMs / 3600000).toFixed(2)}h，未达降级阈值 ${(state.degradeAfterMs / 3600000).toFixed(2)}h ⇒ 正常等待远端`
  }
}

/**
 * 安装 L3 投递器。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化配置
 * @param {{record: (e: object) => Promise<unknown>}} audit - 本插件的审计链
 * @param {{now?: () => number, fetchImpl?: typeof fetch}} [deps] - 测试注入点（时间与网络）
 * @returns {{enabled: boolean, enqueue: (rec: {seq:number, hash:string, entry:object}) => void, dispose: () => Promise<void>}}
 */
export function installTelemetrySink(ctx, cfg, audit, deps = {}) {
  const now = deps.now ?? (() => Date.now())
  const doFetch = deps.fetchImpl ?? globalThis.fetch
  const log = ctx.logger ?? console
  const root = outboxRootOf(cfg.projectRoot)

  /** @type {() => void} */
  let stopTimer = () => {}

  // ── 未配置端点：**不是错误**，是一条留痕 ───────────────────────────────
  // spec §8 的降级故事是"远端连不上"，而"根本没打算连远端"是另一回事。
  // 两者都让 L4 的括号成立，但**必须能分辨**：所以这里写一条审计，且不写 state.json
  // （⇒ phase 的 L4 因为 telemetryStatePath 为空而**根本不适用**，而不是"读到了 a present 状态"）。
  if (cfg.telemetryEndpoint === '') {
    audit
      .record({
        type: AUDIT_KINDS.telemetryDisabled,
        reason: '未配置 telemetryEndpoint ⇒ 审计外置不启用（只留 L1 本地链）。L4 的「远端存在 OR 降级」不适用。',
        note: '这是配置选择不是故障：没有远端时"本地链完整"本身就是最完整的保证。'
      })
      .catch(() => {})
    return { enabled: false, enqueue: () => {}, dispose: async () => {} }
  }

  // ── 已配置：装配 ────────────────────────────────────────────────────────
  const swept = sweepTmpSync(root)
  const loaded = readStateSync(root)
  /** 读不出来一律从空状态重开（**不是**继承一份半懂的状态）—— 但这件事要留痕。 */
  let state = loaded.present ? loaded.state : emptyState(cfg.telemetryDegradeAfterMs)
  if (!loaded.present && loaded.reason !== 'enoent') {
    audit
      .record({
        type: AUDIT_KINDS.telemetryStateReset,
        reason: `state.json 不可用（${loaded.reason}）⇒ 降级状态从空重开`,
        error: loaded.error ?? null
      })
      .catch(() => {})
  }
  // 阈值以**本次 config** 为准（config 是权威；文件里那份可能是上一版 config 写的）
  state.degradeAfterMs = cfg.telemetryDegradeAfterMs

  let inFlight = false
  let disposed = false

  function persist() {
    try {
      writeStateSync(root, state)
    } catch (e) {
      log.warn?.(`[${NAME}] ⚠️ 写 outbox/state.json 失败：${String(e?.message ?? e)}`)
    }
  }

  /** fail-closed：`outageSince` 只在**为空**时置位 —— 中断从第一次失败算起，不因后续失败往后推。 */
  function markFailure(err) {
    const t = new Date(now()).toISOString()
    state.lastAttemptAt = t
    state.lastError = String(err ?? 'unknown').slice(0, 500)
    if (state.outageSince === null) state.outageSince = t
    // 降级**开始**这一刻要留痕（spec：「降级事件本身写入审计」）
    if (state.degradedSince === null && now() - Date.parse(state.outageSince) >= state.degradeAfterMs) {
      state.degradedSince = t
      audit
        .record({
          type: AUDIT_KINDS.telemetryDegraded,
          reason: `远端中断已达阈值 ⇒ 进入降级模式（本地哈希链完整即可通过 deny 校验）`,
          outageSince: state.outageSince,
          degradeAfterMs: state.degradeAfterMs,
          error: state.lastError
        })
        .catch(() => {})
    }
    persist()
  }

  /** 成功：清中断；若刚从降级恢复 ⇒ 写"降级期间有 N 条待复核"并归零。 */
  function markSuccess() {
    const t = new Date(now()).toISOString()
    state.lastAttemptAt = t
    state.lastError = null
    state.lastDeliveredAt = t
    state.outageSince = null
    if (state.degradedSince !== null) {
      const recovered = state.degradedDelivered
      audit
        .record({
          type: AUDIT_KINDS.telemetryRecovered,
          reason: `远端恢复 ⇒ 退出降级模式。**降级期间有 ${recovered} 条事件待复核**（这些记录在降级窗口内通过，审计保证强度低于正常态）。`,
          degradedSince: state.degradedSince,
          degradedUntil: t,
          pendingReview: recovered
        })
        .catch(() => {})
      state.degradedSince = null
      state.degradedDelivered = 0
    }
    persist()
  }

  /**
   * 投递一条记录。**只看状态码，不解析响应体**（只写端点）。
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function post(payload) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), cfg.telemetryTimeoutMs)
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (cfg.telemetryToken !== '') headers.Authorization = `Bearer ${cfg.telemetryToken}`
      const res = await doFetch(cfg.telemetryEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal
      })
      // 响应体读掉一个极小切片就取消，避免占着 socket（内容**不使用**）
      try {
        await res.body?.cancel()
      } catch {
        /* 关不掉不影响判定 */
      }
      if (res.status >= 200 && res.status < 300) return { ok: true }
      return { ok: false, error: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, error: `${e?.name === 'AbortError' ? '超时' : '请求失败'}：${String(e?.message ?? e)}` }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 投递一条**队列外**的记录（心跳）。它不占 seq、不落队列 ——
   * 它的唯一作用是回答"远端此刻可达吗"，落队列只会让队列里混进没有审计链序号的东西。
   */
  async function probe() {
    if (disposed) return
    const r = await post({
      kind: HEARTBEAT_KIND,
      at: new Date(now()).toISOString(),
      projectRoot: cfg.projectRoot,
      pending: countOutboxSync(root)
    })
    if (r.ok) markSuccess()
    else markFailure(r.error)
  }

  /** 按 seq 升序重放队列：**一条失败就停**（保序 —— 后一条先投会让远端看到的顺序与链上不一致）。 */
  async function drainQueue() {
    if (disposed || inFlight) return
    inFlight = true
    try {
      for (const seq of listOutboxSync(root).seqs) {
        if (disposed) break
        const r = readOutboxSync(root, seq)
        if (!r.ok) {
          // 坏条目：**不删**（删了等于把"有一条投递不出去"这件事抹掉），只记账并跳过。
          markFailure(`队列条目不可读：${r.error}`)
          continue
        }
        const out = await post(r.record)
        if (!out.ok) {
          markFailure(out.error)
          break
        }
        removeOutboxSync(root, seq)
        if (state.degradedSince !== null) state.degradedDelivered += 1
        markSuccess()
      }
    } finally {
      inFlight = false
    }
  }

  /** L1 每落一条链记录就调这里。**同步**（写文件），异常一律吞掉（绝不能拖垮会话）。 */
  function enqueue(rec) {
    if (disposed) return
    try {
      writeOutboxSync(root, rec.seq, {
        kind: 'session-audit-event',
        seq: rec.seq,
        chainHash: rec.hash,
        at: new Date(now()).toISOString(),
        record: rec.entry
      })
    } catch (e) {
      log.warn?.(`[${NAME}] ⚠️ 写 outbox 失败（seq=${rec.seq}）：${String(e?.message ?? e)}`)
      return
    }
    void drainQueue()
  }

  // 启动：先补传历史队列，再心跳探一次可达性。
  void (async () => {
    await drainQueue()
    await probe()
  })()

  const interval = setInterval(() => {
    void (async () => {
      await drainQueue()
      // 降级**开始**的那一瞬间可能没有投递动作（阈值到了但没人在试）⇒ 周期性探一次，
      // 让 "进入降级" 这件事必然被写进审计，而不是等人来推进阶段时才被现算发现。
      await probe()
    })()
  }, cfg.telemetryRetryMs)
  interval.unref?.()
  stopTimer = () => clearInterval(interval)

  if (swept > 0) {
    audit
      .record({
        type: AUDIT_KINDS.telemetryTmpSwept,
        reason: `清理了 ${swept} 个写残的 .tmp（上次进程写到一半被终止）`,
        count: swept
      })
      .catch(() => {})
  }

  log.info?.(
    `[${NAME}] 审计外置 L2/L3 已挂载：endpoint=${cfg.telemetryEndpoint}, ` +
      `队列积压=${countOutboxSync(root)}, 降级阈值=${(cfg.telemetryDegradeAfterMs / 3600000).toFixed(2)}h`
  )

  return {
    enabled: true,
    enqueue,
    async dispose() {
      disposed = true
      stopTimer()
      // 收尾：尽最后一次力把队列推出去（失败也不抛 —— dispose 抛错会拖垮应用拆卸）
      try {
        await drainQueue()
      } catch {
        /* 见上 */
      }
    }
  }
}
