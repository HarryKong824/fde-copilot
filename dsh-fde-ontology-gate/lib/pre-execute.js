import { evaluate } from './guard.js'
import { BG_CHAIN_TYPES } from './bg-mirror.js'

/**
 * 审计采集 —— 挂在 `tools/pre-execute`（async waterfall）。
 *
 * 为什么审计不放在 guard 里：`ctx.tools.guard()` 是**同步**的，写不了文件。
 * 所以分工是固定的：guard 只做同步判定，留痕一律走这条 async 通道。
 *
 * shadow 模式下的行为：把"enforce 会拦掉"的调用记成 `shadow-deny` 后放行。
 * 这是 spec §12「observe（影子）记录"本应 deny"但不阻断」的落地方式。
 *
 * 🔴 2026-09-29（E4）**修正本行原注释的口径**。原文写的是
 *   「文档"影子模式先行、准确率 ≥70% 再切 enforce"」—— 那句话把 spec §14 的
 *   **推翻线**（`< 70% → 不应该切 enforce，门禁还不成熟`）当成了 §12 的**准入线**用。
 *   两者是**两个不同的数**，用途不同：
 *     · 准入（§12）：连续 7 天、准确率**严格大于 80%** —— 达到才**允许**切 enforce；
 *     · 推翻（§14）：准确率**小于 70%** —— 门禁不成熟，该重审规则质量，不是"再攒数据"。
 *   70–80 之间是**灰区**：不推翻，但也不够切。落点见 `lib/shadow-stats.js` 文件头。
 *
 * ⚠️ 缺陷 ① 修复：与 mode 无关的规则（denyRunCode）在 shadow 下也**真拦**，
 * 这类记录必须标 'deny' 并直接返回 deny —— 否则审计标签与实际决策相反，
 * 合规留痕会低报真实拦截量、无法区分「本会拦但放行了」与「真拦住了」。
 */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化配置
 * @param {import('./audit.js').AuditChain} audit
 * @param {import('./bg-mirror.js').BreakGlassMirror} [bg] - break-glass 放行表
 * @returns {() => void} 注销器
 */
export function installAuditListener(ctx, cfg, audit, bg) {
  const dispose = ctx.on('tools/pre-execute', async (exec, next) => {
    const enforcing = cfg.mode === 'enforce'

    // 用与 guard 完全相同的规则求值，避免 shadow 与 enforce 之间规则漂移。
    //
    // 🔴 2026-09-29（E5）**补上一个被丢掉的量：`denyId`**。
    //    `guard.js` 的 `evaluate` 一直返回它（三个 deny 站点分别是 `GATE-PTC` / `GATE-CLASSIFY` /
    //    `GATE-PATH`，见 `guard.js:186/198/236`），但这里解构时漏了 ⇒ **链上从来没有 deny 类别**。
    //    后果不是"少一个字段"，是 spec §14 ① 的"哪一类 deny 最常被绕过"**答不出来** ——
    //    `break-glass-bypass` 记录带 `denyId`，而 deny 记录不带，两者配不上对。
    //    ⚠️ 这是**只增字段**：既有读者（合规报表、离线断言）不受影响；
    //       历史记录仍然没有它，读侧必须把"缺 denyId"当成**独立一档**处理，
    //       不许静默当成"没被绕过"（见 `lib/metrics.js` 的 `unclassifiable` 桶）。
    const { deny, denyId, hits, modeIndependent, bypassed } = evaluate(exec, cfg, true, bg)

    // ── break-glass 留痕（spec §11）──
    // 规则说该拦、但放行表里有一条有效记录 ⇒ 这条调用被放行了，**必须留痕**。
    // ⚠️ 这里不写 `break-glass`（开）也**不写** resolved —— gate 只**消费**放行表，
    //    表的生命周期（开/补正）由 phase 的 `fde-break-glass` 工具与自动补正循环管。
    //    两边都写会造成"同一件事两条记录、各自算一次"，指标就重复计数了。
    // ⚠️ `callAllowed` 如实写：shadow 模式下这条路本来就不拦 ⇒ 这次"放行"并没有改变结果。
    //    但它仍要记 —— 它证明**存在一条开着的高危放行**，正是 E5 指标要看的东西。
    if (bypassed !== undefined) {
      await audit
        .record({
          type: BG_CHAIN_TYPES.BYPASS,
          denyId: bypassed,
          tool: exec.name,
          callAllowed: enforcing,
          mode: cfg.mode,
          paths: hits,
          callId: exec.callId,
          rootCallId: exec.rootCallId
        })
        .catch(() => {})
    }

    if (deny !== undefined) {
      const accepted = await audit.record({
        tool: exec.name,
        // 标签必须反映实际决策（缺陷 ① 修复）：mode 无关的规则（denyRunCode）
        // 在 shadow 下也真拦 → 记 'deny'；只有「仅 enforce 才会拦」的语义/路径
        // 规则在 shadow 下才记 'shadow-deny'（本会拦但放行）。
        decision: enforcing || modeIndependent ? 'deny' : 'shadow-deny',
        // E5：deny 类别 —— 与 `break-glass-bypass` 的 `denyId` 同名同域，供 §14 ① 配对。
        denyId,
        reason: deny,
        paths: hits,
        callId: exec.callId,
        rootCallId: exec.rootCallId
      })

      if (enforcing || modeIndependent) {
        // ⚠️ 编号必须带**链名**：gate 与 phase 各有一条链、各自从 1 起排，
        //    只写「（审计 #7）」会被并读成同一条链的推进（0023 §5.3 实测：模型正是这么误判的）。
        return { kind: 'deny', reason: `${deny}（gate 审计 #${accepted.seq}）` }
      }
      // shadow：留痕后照常放行（只对「enforce 才会拦」的规则走到这里）。
      return next()
    }

    // 放行路径不逐条入链 —— 否则审计体量会被正常读写淹没，反而看不出异常。
    return next()
  })

  // 会话的持久化检查点顺带把审计 outbox 重放掉。
  const disposeFlush = ctx.on('session/flush', async () => {
    await audit.flush()
  })

  return () => {
    dispose()
    disposeFlush()
  }
}
