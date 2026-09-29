/**
 * break-glass 待补正提醒（spec §11 R6：「补正期内每次启动会话都提醒：有 N 条 break-glass 待补正」）。
 *
 * ## 提醒的载体是什么（这一节是设计，不是实现细节）
 * DSH 里插件**没有**"往会话里插一句系统提示"的显式 API。可用的落点是 agent 的 **inbox**：
 *   `agent.send(message, target, wakeup)` —— `target ∈ {'next-turn','next-step'}`，
 *   `message` 必须是 `UserMessage`（用真 SDK 的 `createUserMessage` 造，它负责发 id 与深冻结）。
 *
 * 🔴 **`wakeup: false`（有意）**：提醒**不自动开一个回合**。
 *    理由：会话一建立就自动让模型说话，是**没被要求的开销**，而且会让"启动即刷屏"变成常态 ——
 *    那会让人把提醒当噪音，正好毁掉这个机制的目的。`wakeup:false` 让提醒**挂着**，
 *    随用户本会话的第一条消息一起被看见。仍然是"每次启动会话都提醒"。
 *
 * 🔴 **`source.kind = 'plugin'`（不是 `'user'`）**：真 SDK 的 `MessageSourceMap` 为此专门留了
 *    `{kind:'plugin', plugin:string}` 这一支。用 `'user'` 会把机器写的提醒伪装成真人发言 ——
 *    事后看 transcript 就分不出哪句是人说的。
 *
 * ⚠️ **送达失败不致命**：inbox 是宿主拥有的结构，插件不该因为"塞不进去"而让会话建立失败。
 *    但**也不静默**：失败会在链上留一条 `break-glass-notify-failed`（见 index.js）。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** 会话提醒里最多列几条明细（避免刷屏）—— 剩下的用"N 条已省略"收口。 */
export const NOTICE_MAX_ROWS = 5

/**
 * 纯函数：把待补正记录渲染成一段人话（**可离线断言**，不碰任何 IO）。
 *
 * @param {Array<object>} open - 未补正记录（按 at 升序）
 * @param {Array<object>} overdue - 其中已超期的
 * @param {{maxRows?:number}} [opts]
 * @returns {string}
 */
export function formatPendingNotice(open, overdue, opts = {}) {
  const maxRows = opts.maxRows ?? NOTICE_MAX_ROWS
  const overIds = new Set(overdue.map((r) => r.id))
  const head =
    `⚠️ 有 ${open.length} 条 break-glass 待补正` +
    (overdue.length > 0 ? `，其中 **${overdue.length} 条已超期**` : '') +
    `。`
  const rows = open.slice(0, maxRows).map((r) => {
    const mark = overIds.has(r.id) ? '🔴 超期' : '🟡 期内'
    return `  · ${mark} ${r.id}｜${r.denyId}｜${r.category}｜补正期至 ${r.expiresAt}`
  })
  if (open.length > rows.length) rows.push(`  · …另有 ${open.length - rows.length} 条已省略`)
  return [
    head,
    ...rows,
    '补正方式：走正常流程修复导致 break-glass 的问题（例如重跑对应检查工具并使其通过）——',
    '该门禁一旦自己通过，这条记录会自动标记为已补正。'
  ].join('\n')
}

/**
 * 挂上 `agent/session-start` 提醒。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} pluginName - 写进 `source.plugin`（事后可追溯是哪個插件塞的）
 * @param {import('./bg-mirror.js').BreakGlassMirror} bg
 * @param {(e:unknown, where:string)=>void} [onFail] - 塞不进去时的留痕回调（不传则静默）
 * @returns {() => void} 注销器
 */
export function installBreakGlassNotify(ctx, pluginName, bg, onFail) {
  return ctx.on('agent/session-start', (payload) => {
    const agent = payload?.agent
    // fail-soft：拿不到 agent（或它不是我们认识的形态）就什么都不做 ——
    // 一个"提醒"绝不该让会话建立失败。
    if (!agent || typeof agent.send !== 'function') return

    let open
    try {
      open = bg.openRecords()
    } catch (e) {
      onFail?.(e, 'openRecords')
      return
    }
    if (open.length === 0) return

    const overdue = bg.overdueRecords()
    let message
    try {
      message = createUserMessage({
        content: [{ type: 'text', text: formatPendingNotice(open, overdue) }],
        source: { kind: 'plugin', plugin: pluginName }
      })
    } catch (e) {
      onFail?.(e, 'createUserMessage')
      return
    }
    try {
      agent.send(message, 'next-turn', /* wakeup */ false)
    } catch (e) {
      onFail?.(e, 'agent.send')
    }
  })
}
