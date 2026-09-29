/**
 * approval 底座 —— 把 `ctx.get('approval')` 的降级链 + 结果直通封装成一个纯 helper。
 *
 * 🔴 真 SDK（@deepseek-ai/dsh-user-approval）的事实（施工单 0089 §2）：
 *   - 服务获取：`ctx.get('approval')` —— opportunistic，未 compose 时返回 undefined（不抛错）。
 *   - 调用：`await approval.request({ agent, toolName, callId?, reason?, signal? })` → ApprovalOutcome
 *   - 结果：'allowed-once'（唯一 grant）| 'rejected'（用户拒绝）| 'cancelled'（撤回）
 *           | 'unavailable'（无 answerer，fail-closed）。
 *   - 三个硬前提：必须有 agent（否则无法路由/审计）；必须有开放 turn（工具 execute 天然满足）；
 *     审计自动成对写 approval/asked + approval/decided，调用方不用自己写 approval 审计。
 *
 * 本 helper 只做「降级 + 直通」，不判定语义（allow/deny/degrade 由调用方 switch）——
 * 因为 D4 是 ask（unavailable 放行），别的场景可能是 deny（unavailable 拒绝），语义不归 helper 管。
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
