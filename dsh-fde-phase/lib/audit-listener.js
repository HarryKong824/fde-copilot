/**
 * 审计采集 —— 挂在 `tools/pre-execute`（async waterfall）。
 *
 * 与 gate 同构：guard 只同步判定，写 IO 一律走这条 async 通道。
 * shadow 模式：把"enforce 会拦掉"的调用记成 `shadow-deny` 后**放行**（影子模式 = 看见了先不拦）。
 * enforce 模式：记 `deny` 并真正拒绝。
 * 未实现的 deny 项（若将来又出现）：无论哪种模式，只要当前阶段挂了这些项，都写一条 `check-skipped`
 * 说明（明确不拦、绝不假装拦住）。v3 后 DENY_CHECKS 各项均已实现，此通道当前恒空。
 *
 * 🔴 **本文件为什么从 `index.js` 里拆出来**（2026-09-29，E1）：index.js 要 `Config`
 *    （schemastery），于是**任何** import index.js 的离线测试都被迫加载 SDK 依赖层 ⇒
 *    这段逻辑在离线回归里根本测不到，只能靠"import 部署副本"的接线测试顺带碰一下。
 *    break-glass 的留痕与自动补正全在这里，是这个机制里最容易写错、也最需要逐条断言的部分
 *    ⇒ 抽成零 SDK 依赖的独立模块，`_fde_e1_test.mjs` 就能直接调它。
 *    （同类先例：gate 的 `pre-execute.js` 本来就是独立文件。）
 */

import { join } from 'node:path'
import { evaluate } from './guard.js'
import { readStateSync } from './state.js'
import { BG_CHAIN_TYPES } from './bg-mirror.js'
import { BG_RELATIVE_PATH, readBreakGlassSync, writeBreakGlassAtomic } from './break-glass.js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg
 * @param {import('./audit.js').AuditChain} audit
 * @param {import('./mirror.js').D1Mirror} mirror
 * @param {import('./bg-mirror.js').BreakGlassMirror} [bg]
 * @returns {() => void}
 */
export function installAuditListener(ctx, cfg, audit, mirror, bg) {
  const dispose = ctx.on('tools/pre-execute', async (exec, next) => {
    // 只关心推进阶段的动作；其余工具一律放行（evaluate 对它们也返回 deny:undefined）。
    if (exec.name !== 'fde_phase_advance') return next()

    const { deny, checks, skipped, bypassed, resolvedCandidates } = evaluate(exec, cfg, mirror, bg)
    const enforcing = cfg.mode === 'enforce'

    // 取 from / to 用于审计说明（不依赖 evaluate 的返回值结构）。
    const args = /** @type {Record<string, unknown>} */ (exec.arguments ?? {})
    const to = typeof args.to === 'string' ? args.to : ''
    const statePath = join(cfg.projectRoot, 'memory', 'state.yaml')
    const current = String(readStateSync(statePath).current_phase ?? '0.1')

    // 🔴 诚实缺口清单：未实现的 deny 项必须"明确不拦 + 写审计说明"。
    if (skipped && skipped.length > 0) {
      await audit
        .record({
          type: 'check-skipped',
          tool: exec.name,
          from: current,
          to,
          checks: skipped,
          note: '本轮未实现其检查逻辑：明确不拦，仅记录说明（绝不挂桩返回 passed:true）',
          callId: exec.callId,
          rootCallId: exec.rootCallId
        })
        .catch(() => {})
    }

    // ── break-glass（spec §11）──
    // 本次调用**真的有门禁项被放行** ⇒ 每项留一条痕。
    // ⚠️ 逐项记（不是"一条记录里塞个数组"）：E5 的指标要按 deny-id 分列，数组会逼着读的人再拆一次。
    // ⚠️ `callAllowed` 如实写：本调用如果因为**别的**检查项仍被拒，这次放行并没换来一次成功推进 ——
    //    把它记成"放行生效"会虚高指标。
    const willDeny = deny !== undefined && enforcing
    for (const id of bypassed ?? []) {
      await audit
        .record({
          type: BG_CHAIN_TYPES.BYPASS,
          denyId: id,
          callAllowed: !willDeny,
          from: current,
          to,
          callId: exec.callId,
          rootCallId: exec.rootCallId
        })
        .catch(() => {})
    }

    // 自动补正（R5）：某条 open 记录对应的门禁**这一轮通过了** ⇒ 文件 + 链 + 镜像三处一起标 resolved。
    // 顺序刻意是 **先文件、后镜像、再链**：镜像一旦标 resolved，放行立即失效；
    // 若文件写失败就 continue（不动镜像），避免"盘上还开着、内存里已关"的分叉。
    for (const rid of resolvedCandidates ?? []) {
      const rec = bg?.get(rid)
      if (!rec || rec.status !== 'open') continue
      const bgPath = join(cfg.projectRoot, BG_RELATIVE_PATH)
      const cur = readBreakGlassSync(bgPath)
      if (!cur.ok) {
        await audit
          .record({ type: 'break-glass-resolve-failed', id: rid, reason: cur.reason, callId: exec.callId })
          .catch(() => {})
        continue
      }
      const at = new Date().toISOString()
      try {
        writeBreakGlassAtomic(
          bgPath,
          cur.records.map((r) => (r.id === rid ? { ...r, status: 'resolved', resolvedAt: at } : r))
        )
      } catch (e) {
        await audit
          .record({ type: 'break-glass-resolve-failed', id: rid, reason: String(e?.message ?? e), callId: exec.callId })
          .catch(() => {})
        continue
      }
      bg.update({ id: rid, at, resolved: true })
      // 广播"已补正"给 gate —— **必须**，否则 gate 的镜像里这条永远 open：
      // gate 从**自己的链**恢复（两条链分开），而它只在自己收到事件时才会往那条链写。
      // 漏掉这一步的症状是"phase 说已补正、gate 还在放行"，且**只在重启后才看得出来**。
      // ⚠️ 仍然 try/catch：监听器同步抛错会冒泡，绝不能让它把补正流程搞失败。
      try {
        ctx.emit('fde/break-glass', { id: rid, at, resolved: true })
      } catch {
        // ⚠️ 广播失败 ⇒ gate **不会**知道这次补正（它只从自己的链恢复，而下面那行
        //    `audit.record` 写的是 **phase** 的链）。结果是 phase 已补正、gate 仍放行，
        //    且**没有自动恢复路径**。这是本设计承认的一个缺口，写进两边 README 的诚实清单：
        //    补救手段 = 再砸一次玻璃（会产生新 id，旧记录留作证据）或人工核对两条链。
        //    实测触发条件很窄（emit 的监听器同步抛错），但**不该假装它不存在**。
      }
      await audit
        .record({
          type: BG_CHAIN_TYPES.RESOLVED,
          id: rid,
          denyId: rec.denyId,
          at,
          callId: exec.callId,
          rootCallId: exec.rootCallId
        })
        .catch(() => {})
    }

    if (deny !== undefined) {
      const accepted = await audit.record({
        tool: exec.name,
        decision: enforcing ? 'deny' : 'shadow-deny',
        reason: deny,
        checks,
        skipped,
        callId: exec.callId,
        rootCallId: exec.rootCallId
      })
      if (enforcing) {
        // ⚠️ 编号必须带链名（同 gate 侧）：两条链各自从 1 起排，不带名会被并读。
        return { kind: 'deny', reason: `${deny}（phase 审计 #${accepted?.seq ?? '?'}）` }
      }
      // shadow：留痕后照常放行（只对「enforce 才会拦」的规则走到这里）。
      return next()
    }

    // 放行路径不逐条入链 —— 否则审计体量会被正常读写淹没，反而看不出异常。
    return next()
  })

  const disposeFlush = ctx.on('session/flush', async () => {
    await audit.flush()
  })

  return () => {
    dispose()
    disposeFlush()
  }
}
