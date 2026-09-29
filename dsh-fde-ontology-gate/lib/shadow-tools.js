import * as dshTools from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { askApproval } from './approval.js'
import {
  ADMIT_PCT,
  MODE_SWITCH,
  SHADOW_JUDGED,
  computeShadowStatsFromChain,
  formatShadowStats,
  listArchivedSegments,
  pendingShadowRecords,
  readChainRecords
} from './shadow-stats.js'

const { defineTool } = dshTools

/**
 * 影子模式的两个工具（spec v3 §12）。
 *
 *   · `fde_shadow_status` —— **只读**：现在离"可切 enforce"还差什么。
 *   · `fde_shadow_switch` —— **写**：切换门的裁决器 + spec §12 的 R2 级逐条确认。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 🔴 本文件里最容易做错的三处（都已在代码里就地注释）：
 *
 * ① **闸门顺序**：先判"与用户回答无关"的硬事实（样本量 / 窗口 / 链异常），
 *    通过了才逐条弹窗。反过来的话，真环境（影子期只有 3.28 小时数据）会先让 FDE
 *    答完 10 个窗、再被告知"跨度不够"—— 白打扰，而且会让人以为"多答几次就能切"。
 *
 * ② **approval 三态的方向**：这里 `unavailable` / `cancelled` 一律**中止**（fail-closed），
 *    与 D4 的 ask（unavailable 放行）**方向相反**。理由：D4 是"放行前问一声"，
 *    拿不到回答时放行是安全的；这里是"要一个明确的 FDE 结论才允许把门禁从 observe 拧到 enforce"，
 *    拿不到结论就必须停在 observe。**同一个 helper，两种相反的语义，由调用方定**。
 *
 * ③ **approval 与审计的关系**：`ctx.approval` 自己会成对写 `approval/asked` + `approval/decided`
 *    到**会话事件**里；本模块写的是 **gate 自己的哈希链**（`shadow-judged`）。
 *    两者不可互相替代：前者证明"问过"，后者是权威统计口径的数据源。
 * ─────────────────────────────────────────────────────────────────────
 */

export const SHADOW_STATUS = 'fde_shadow_status'
export const SHADOW_SWITCH = 'fde_shadow_switch'

/** 逐条确认时给 FDE 看的单条摘要（不泄漏 ontology 内容，只给工具名与拒绝理由）。 */
function itemLine(i, n, s) {
  return (
    `第 ${i}/${n} 条 —— 工具 ${s.tool ?? '(未知)'}：${String(s.reason ?? '(无理由)')}` +
    `\n（enforce 模式下这次调用会被拦下；observe 模式下只记录、已放行。）\n你认为**确实该拦**吗？`
  )
}

/** 把 stats 里"必须让读者看见"的字段压成一段人话。 */
function statsSummary(s) {
  const lines = [formatShadowStats(s)]
  if (s.blockers.length) lines.push('未达标原因：', ...s.blockers.map((b) => `  · ${b}`))
  if (s.warnings.length) lines.push('须知：', ...s.warnings.map((w) => `  · ${w}`))
  return lines.join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化配置
 * @param {import('./audit.js').AuditChain} audit
 * @returns {() => void} 注销器
 */
export function installShadowTools(ctx, cfg, audit) {
  const disposeStatus = ctx.tools.register(
    defineTool({
      name: SHADOW_STATUS,
      description:
        '查询影子模式（observe）的预判准确率统计，以及当前离"可切 enforce"还差什么。' +
        '数据源是 gate 自己的审计哈希链，只读、不改任何状态。',
      parameters: {
        reason: {
          type: 'string',
          required: true,
          description: '本次查询的业务理由（写入审计）'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            verdict: { type: 'string', required: true },
            ready: { type: 'boolean', required: true },
            total: { type: 'number', required: true },
            rated: { type: 'number', required: true },
            agree: { type: 'number', required: true },
            disagree: { type: 'number', required: true },
            pending: { type: 'number', required: true },
            accuracy: { type: 'string', required: true },
            spanDays: { type: 'number', required: true },
            blockers: { type: 'array', required: true, items: { type: 'string' } },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
            message: { type: 'string', required: true }
          }
        },
        render(_args, value) {
          return [{ type: 'text', text: value.message }]
        }
      },
      async execute(args, exec) {
        const stats = await computeShadowStatsFromChain(cfg.auditPath)
        // 只读动作也入链：与 `fde_ontology_read` 同形态（本项目口径：留痕即失效 ——
        // 只要有一类访问不落链，"完整访问史"就不成立）。
        await audit
          .record({
            tool: SHADOW_STATUS,
            decision: 'allow',
            reason: args.reason,
            verdict: stats.verdict,
            total: stats.total,
            callId: exec?.callId
          })
          .catch(() => {
            // 审计自身故障不得改变只读查询的结果（沿用本项目 audit fail-open 取舍）
          })
        return {
          verdict: stats.verdict,
          ready: stats.ready,
          total: stats.total,
          rated: stats.rated,
          agree: stats.agree,
          disagree: stats.disagree,
          pending: stats.pending,
          accuracy: stats.accuracyPct === null ? '—（无已确认样本）' : `${stats.accuracyPct.toFixed(1)}%`,
          spanDays: stats.spanDays,
          blockers: stats.blockers,
          warnings: stats.warnings,
          message: statsSummary(stats)
        }
      }
    })
  )

  const disposeSwitch = ctx.tools.register(
    defineTool({
      name: SHADOW_SWITCH,
      description:
        '影子模式开关（spec §12）。observe ⇒ enforce 是**受门禁的**：' +
        `要求连续 ${(7 * 24 * 60 * 60 * 1000) / 86400000} 天以上、信任预判准确率**严格大于** ${ADMIT_PCT}%，` +
        '且逐条确认所有历史"本应 deny"的项（R2 级，一次一条、不可批量跳过）。' +
        'enforce ⇒ observe 无条件允许（逃生方向不设门）。' +
        '⚠️ 模式由部署配置（cordis.patch.yml 的 mode）决定 —— 本工具**裁决并留痕**，' +
        '真正生效仍需改配置并重启 DSH。',
      parameters: {
        to: {
          type: 'string',
          required: true,
          enum: ['enforce', 'observe'],
          description: '目标模式。enforce 需通过准入检查；observe 无条件允许。'
        },
        reason: {
          type: 'string',
          required: true,
          description: '本次切换的业务理由（写入审计）'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            to: { type: 'string', required: true },
            approved: { type: 'boolean', required: true },
            needsRestart: { type: 'boolean', required: true },
            total: { type: 'number', required: true },
            agree: { type: 'number', required: true },
            disagree: { type: 'number', required: true },
            accuracy: { type: 'string', required: true },
            spanDays: { type: 'number', required: true },
            message: { type: 'string', required: true }
          }
        },
        render(_args, value) {
          return [{ type: 'text', text: value.message }]
        }
      },
      async execute(args, exec) {
        if (args.to !== 'enforce' && args.to !== 'observe') {
          throw new HarnessError(
            `to 只能是 enforce 或 observe，收到 ${String(args.to)}`,
            'SHADOW_BAD_ARG'
          )
        }

        // ───────────────── 切回 observe：fail-safe 方向**不设门** ─────────────────
        // spec §12：「切换后仍可随时切回 observe」。给"往回走"设门 = 把门禁变成单向棘轮，
        // 而那正是 spec 明确要避免的（门禁失效时人必须能撤）。
        if (args.to === 'observe') {
          await audit.record({
            tool: SHADOW_SWITCH,
            decision: MODE_SWITCH,
            to: 'observe',
            approved: true,
            reason: args.reason,
            callId: exec?.callId
          })
          return {
            to: 'observe',
            approved: true,
            needsRestart: true,
            total: 0,
            agree: 0,
            disagree: 0,
            accuracy: '—',
            spanDays: 0,
            message:
              '已批准切回 observe（无需准入检查）。\n' +
              '⚠️ 还需把 cordis.patch.yml 里 dsh-fde-ontology-gate 的 mode 改为 observe 并**重启 DSH** —— ' +
              '模式是 apply 期读的配置，本工具只能裁决与留痕，改不了运行中的进程。'
          }
        }

        // ───────────────── 切 enforce：三道闸门，顺序不可换 ─────────────────
        const chainPath = cfg.auditPath
        const read = await readChainRecords(chainPath)
        const arch = await listArchivedSegments(chainPath)
        const reject = async (code, message, extra = {}) => {
          await audit
            .record({
              tool: SHADOW_SWITCH,
              decision: MODE_SWITCH,
              to: 'enforce',
              approved: false,
              code,
              reason: args.reason,
              ...extra,
              callId: exec?.callId
            })
            .catch(() => {
              // 审计故障不得改变"拒绝"这个结论（结论一律 fail-closed）
            })
          throw new HarnessError(message, code)
        }

        // 闸门 0：链读不到 —— **绝不能**当成"没有样本"（缺席第三层）。
        if (!read.ok) {
          await reject(
            'SHADOW_STATS_UNAVAILABLE',
            `无法统计影子期数据：${read.error}\n` +
              '（注意：这是"读不到数据"，不是"影子期没有预判"。修好链的可读性再切换。）'
          )
        }

        const pre = await computeShadowStatsFromChain(chainPath)

        // 闸门 1：与"用户怎么回答"无关的硬事实，先判 —— 避免白弹窗。
        if (pre.total === 0) {
          await reject(
            'SHADOW_NO_SAMPLES',
            `observe 期没有任何"本应 deny"的样本（0 条 shadow-deny），无从计算预判准确率 ⇒ 拒绝切 enforce。\n` +
              `链路：${chainPath}\n` +
              (arch.files.length
                ? `⚠️ 同目录有 ${arch.files.length} 个归档链段未计入：${arch.files.join(', ')}\n` +
                  '若影子期发生在归档侧，请把归档段一并纳入统计口径后再判。'
                : '')
          )
        }
        if (!pre.windowOk) {
          await reject(
            'SHADOW_WINDOW_TOO_SHORT',
            `时间跨度不足：${pre.spanDays} 天 < 7 天（spec §12「连续 7 天」）⇒ 拒绝切 enforce。\n` +
              `样本 ${pre.total} 条，最早 ${pre.oldestTs}，最晚 ${pre.newestTs}。\n` +
              '⚠️ 本模块按"最早→最晚的跨度"落地"连续 7 天"，未校验中间是否有空档。'
          )
        }
        if (pre.anomalies > 0) {
          await reject(
            'SHADOW_CHAIN_ANOMALIES',
            `审计链上有 ${pre.anomalies} 处异常形状，统计口径不可信 ⇒ 拒绝切 enforce（fail-closed）。\n` +
              pre.blockers.map((b) => `  · ${b}`).join('\n') +
              '\n（本工具不提供链修复；修好后重跑。）',
            { anomalies: pre.anomalies }
          )
        }

        // 闸门 2：R2 逐条确认（spec §12「逐条确认所有历史"本应 deny"的项」）。
        //
        // 「已确认过的项不再重复问」—— 重复调用幂等，且不重复打扰。
        // 中止/达上限时**已写下的确认保留在链上**（append-only 的本性：写了就是写了），
        // 下次调用从断点继续，不必重答。
        const pending = pendingShadowRecords(read.records)
        const batch = pending.slice(0, cfg.maxConfirmPerCall)
        let done = 0
        for (const s of batch) {
          const outcome = await askApproval(ctx, exec, itemLine(done + 1, pending.length, s))
          if (outcome !== 'allowed-once' && outcome !== 'rejected') {
            // unavailable（无 answerer）/ cancelled（撤回）⇒ 中止。
            // 这是与 D4 ask **相反**的方向：拿不到 FDE 的明确结论，就不许把门拧到 enforce。
            await reject(
              'SHADOW_CONFIRM_ABORTED',
              `逐条确认在第 ${done + 1}/${pending.length} 条中止（approval 返回 ${outcome}）⇒ 未批准切 enforce。\n` +
                `本条：工具 ${s.tool} —— ${s.reason}\n` +
                `已确认的 ${done} 条**已保留在链上**（append-only），下次调用从断点继续。\n` +
                '⚠️ 拿不到明确结论时一律停在 observe：这是"逐条确认"的全部意义（R2 不可批量跳过）。',
              { confirmed: done, abortedAt: s.seq, outcome }
            )
          }
          await audit.record({
            tool: SHADOW_SWITCH,
            decision: SHADOW_JUDGED,
            refSeq: s.seq,
            verdict: outcome === 'allowed-once' ? 'agree' : 'disagree',
            outcome,
            srcTool: s.tool,
            srcReason: s.reason,
            reason: args.reason,
            callId: exec?.callId
          })
          done++
        }
        if (pending.length > batch.length) {
          await reject(
            'SHADOW_CONFIRM_BATCH_LIMIT',
            `本次确认了 ${done} 条，仍有 ${pending.length - done} 条未确认（单次上限 maxConfirmPerCall=${cfg.maxConfirmPerCall}）` +
              '⇒ 本次未批准。请再次调用本工具从断点继续。\n' +
              '⚠️ 上限是**拍脑袋值**，只为避免真实链上几百条时一次调用弹几百个窗；达到上限是"未完成"，不是"跳过"。',
            { confirmed: done, remaining: pending.length - done }
          )
        }

        // 闸门 3：**重读磁盘**再裁决。
        //
        // 为什么非重读不可：`audit.record()` 是 fail-open 的（写盘失败进内存 outbox、
        // 不抛错）⇒ 只信内存里的计数，会在"确认根本没落盘"的情况下批准切换。
        // 重读磁盘等于用**权威副本**复核一遍 "所有历史项都已确认" 这件事。
        const post = await computeShadowStatsFromChain(chainPath)
        if (!post.ready) {
          await reject(
            'SHADOW_NOT_READY',
            `逐条确认已完成（本次 ${done} 条），但准入条件仍未满足 ⇒ 未批准切 enforce。\n` +
              statsSummary(post),
            {
              total: post.total,
              agree: post.agree,
              disagree: post.disagree,
              accuracyPct: post.accuracyPct,
              spanDays: post.spanDays
            }
          )
        }

        // ───────────────── 批准 ─────────────────
        await audit.record({
          tool: SHADOW_SWITCH,
          decision: MODE_SWITCH,
          to: 'enforce',
          approved: true,
          reason: args.reason,
          total: post.total,
          agree: post.agree,
          disagree: post.disagree,
          accuracyPct: post.accuracyPct,
          spanDays: post.spanDays,
          oldestTs: post.oldestTs,
          newestTs: post.newestTs,
          chainPath,
          confirmedThisCall: done,
          callId: exec?.callId
        })
        return {
          to: 'enforce',
          approved: true,
          needsRestart: true,
          total: post.total,
          agree: post.agree,
          disagree: post.disagree,
          accuracy: `${post.accuracyPct.toFixed(1)}%`,
          spanDays: post.spanDays,
          message:
            `已批准切 enforce。\n${statsSummary(post)}\n` +
            (done > 0 ? `本次逐条确认 ${done} 条。\n` : '') +
            '⚠️ 还差一步：把 cordis.patch.yml 里 dsh-fde-ontology-gate 的 mode 改为 enforce 并**重启 DSH**。\n' +
            '重启后本插件会校验链上这条批准记录；找不到就会在启动时记一条 mode-switch-unattested 并告警' +
            '（配置被手改绕过本流程时，这件事**可见**）。'
        }
      }
    })
  )

  return () => {
    disposeStatus()
    disposeSwitch()
  }
}
