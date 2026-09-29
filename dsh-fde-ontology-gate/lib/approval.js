/**
 * approval 底座 —— 把 `ctx.get('approval')` 的降级链 + 结果直通封装成一个纯 helper。
 *
 * 🔴 **照抄自 `dsh-fde-phase/lib/approval.js`（与 `dsh-fde-memory/lib/approval.js` 同源）**。
 *    照抄的理由是既有的架构约束：**插件之间不能互相 import**（0076 §3.3），
 *    跨包共享只能靠"照抄 + 头部注明出处"（本项目在 `linkHash` / `yamlsubset` 上已有先例）。
 *    出处：`dsh-fde-phase/lib/approval.js`（0089 落地，已活验过 D4 ask）。
 *    ⚠️ 三份副本的**语义必须一致**：改这里就要回头核另两份，反之亦然。
 *
 * 🔴 真 SDK（@deepseek-ai/dsh-user-approval）的事实（施工单 0089 §2）：
 *   - 服务获取：`ctx.get('approval')` —— opportunistic，未 compose 时返回 undefined（不抛错）。
 *   - 调用：`await approval.request({ agent, toolName, callId?, reason?, signal? })` → ApprovalOutcome
 *   - 结果：'allowed-once'（唯一 grant）| 'rejected'（用户拒绝）| 'cancelled'（撤回）
 *           | 'unavailable'（无 answerer，fail-closed）。
 *   - 三个硬前提：必须有 agent（否则无法路由/审计）；必须有开放 turn（工具 execute 天然满足）；
 *     审计自动成对写 approval/asked + approval/decided，调用方不用自己写 approval 审计。
 *
 * 本 helper 只做「降级 + 直通」，**不判定语义**（allow/deny/degrade 由调用方 switch）——
 * 因为 D4 是 ask（unavailable 放行），而影子模式的逐条确认是 R2（unavailable **中止**），
 * 语义不归 helper 管。
 *
 * 桩 SDK 兼容：离线环境 ctx.get 返回 undefined ⇒ 稳定返回 'unavailable'，不崩、可离线断言。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ agent?: unknown, name?: string, callId?: unknown, signal?: unknown }} exec
 * @param {string} [reason] - asker 的人话解释（为什么要问）
 * @returns {Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>}
 */
export async function askApproval(ctx, exec, reason) {
  const approval = ctx?.get?.('approval')
  if (approval === undefined) return 'unavailable'
  if (exec?.agent === undefined) return 'unavailable'
  return approval.request({
    agent: exec.agent,
    toolName: exec.name,
    ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(exec.signal !== undefined ? { signal: exec.signal } : {})
  })
}
