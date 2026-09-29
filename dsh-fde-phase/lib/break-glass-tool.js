import * as dshTools from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { askApproval } from './approval.js'
import { runDenyChecks } from './guard.js'
import { BG_RELATIVE_PATH, currentAnchorSync, readBreakGlassSync, writeBreakGlassAtomic } from './break-glass.js'
import {
  BREAK_GLASS_CATEGORIES,
  BYPASSABLE_DENY_IDS,
  CATEGORY_META,
  CORRECTION_WINDOW_MS,
  DENY_LABEL,
  makeEventId
} from './deny-ids.js'

const { defineTool } = dshTools

/** 工具名 —— 取自 spec §11 的命令名原样（`fde-break-glass`），与 dsl 的 `fde-run-*` 同族用中划线。 */
export const BREAK_GLASS_TOOL = 'fde-break-glass'

/** 补正期天数（spec §11 R5），给文案用。 */
const WINDOW_DAYS = CORRECTION_WINDOW_MS / (24 * 60 * 60 * 1000)

/**
 * 当前有哪些**带锚点**的 deny-id 可以由本插件自己复核（纵深防御用）。
 * `GATE-*` 不在其中：那两道门在 gate 插件里，phase 复算不了 ⇒ 只能不验，如实标注。
 */
const SELF_CHECKABLE = Object.freeze(['D1', 'D2', 'D3', 'D5'])

/**
 * `fde-break-glass` —— 紧急逃生门（spec §11）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 🔴 本文件里最容易做错的四处：
 *
 * ① **闸门顺序**：先跑"与用户回答无关"的硬校验（id 合法 / 理由非空 / 分类合法 /
 *    该门禁**当前确实在拦**），全过了**才**弹确认框。反过来的话，用户先答了"确认绕过"，
 *    再被告知"你填的 D9 不存在"—— 白打扰，而且会让人以为"多试几次就能绕"。
 *
 * ② **approval 的方向**：`allowed-once` 之外的**一切**（`rejected` / `cancelled` /
 *    `unavailable`）一律**中止**。这与 D4 的 ask（unavailable 放行）**方向相反**：
 *    D4 是"放行前问一声"，拿不到回答时放行是安全的；这里是"要一个明确的人工结论
 *    才允许绕过一个否决"，拿不到结论就必须**保持拦住**（fail-closed）。
 *
 * ③ **纵深防御**：execute 里**再判一次**"该门禁当前是否真的在拦"。
 *    guard 拦不到这个工具（它拦的是 `fde_phase_advance`），所以这里没有第二道防线 ——
 *    **这个复核就是主防线**。它挡的是"预防性砸玻璃"（没被拦却先把玻璃砸了，等于
 *    提前给未来所有调用发通行证）。
 *
 * ④ **写盘与写链的顺序**：先 approval → 再写**文件**（durable、可失败、失败即拒）
 *    → 再写**链** → 再更新内存镜像 → 最后广播。
 *    链写失败是 fail-open（`audit.record` 内部会吞），于是会出现"文件里有、链上没有"；
 *    重启后镜像从**链**恢复 ⇒ 那条放行消失。**这正是要的**：
 *    放行与记录**同生共死**，不会出现"绕过了但查不到是谁放的"。
 * ─────────────────────────────────────────────────────────────────────
 */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化配置
 * @param {import('./audit.js').AuditChain} audit
 * @param {import('./mirror.js').D1Mirror} d1mirror
 * @param {import('./bg-mirror.js').BreakGlassMirror} bgmirror
 * @returns {() => void} 注销器
 */
export function installBreakGlassTool(ctx, cfg, audit, d1mirror, bgmirror) {
  const path = join(cfg.projectRoot, BG_RELATIVE_PATH)

  return ctx.tools.register(
    defineTool({
      name: BREAK_GLASS_TOOL,
      description:
        '紧急逃生门（break-glass）：在 deny 门禁**确实拦住了你**、且属紧急/bug/边界场景时，' +
        '临时绕过该道门禁，让 Phase 推进继续。这是一次**有痕**操作 —— 理由与分类会永久写入' +
        '本地与外置审计，并进入 7 天补正期。绕过前会要求人工确认。' +
        '注意：只能绕内容门禁（D1/D2/D3/D5 与 gate 的分级/路径），' +
        '**不能**绕流程规则（跳跃推进 / 末阶段 / 回滚观察期）。',
      parameters: {
        deny_id: {
          type: 'string',
          required: true,
          enum: BYPASSABLE_DENY_IDS,
          description: '要绕过的那道门禁的 id（必须是当前正在拦住你的那一道）'
        },
        reason: {
          type: 'string',
          required: true,
          description: '为什么必须绕过（必填，永久保存，会计入指标）'
        },
        category: {
          type: 'string',
          required: true,
          enum: BREAK_GLASS_CATEGORIES,
          description:
            '分类：deny_defect=门禁本身有 bug 拦错了；scope_edge=边界场景规则没覆盖到；' +
            'evasion=为省事故意绕过（理由不充分）'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            eventId: { type: 'string', required: true },
            denyId: { type: 'string', required: true },
            category: { type: 'string', required: true },
            expiresAt: { type: 'string', required: true },
            anchor: { type: 'string', required: true },
            verified: { type: 'boolean', required: true },
            pending: { type: 'number', required: true },
            overdue: { type: 'number', required: true },
            message: { type: 'string', required: true }
          }
        },
        render(_args, value) {
          return [{ type: 'text', text: value.message }]
        }
      },
      /**
       * @param {{deny_id:string, reason:string, category:string}} args
       * @param {any} exec
       */
      async execute(args, exec) {
        const denyId = String(args?.deny_id ?? '')
        const reason = String(args?.reason ?? '').trim()
        const category = String(args?.category ?? '')

        // ── 闸门 1：id 合法（`enum` 已在宿主侧拦一层，这里是纵深防御 + 更清楚的报错）──
        if (!BYPASSABLE_DENY_IDS.includes(denyId)) {
          throw new HarnessError(
            `deny_id「${denyId}」不可绕过。可绕过的只有：${BYPASSABLE_DENY_IDS.join(' / ')}。` +
              `流程规则（跳跃推进 / 已是末阶段 / 回滚观察期）**有意**不做成可绕 —— ` +
              `绕过它们等于跳过整个 Phase 门禁体系，那是新开一个洞，不是砸玻璃。`,
            'BG_ID_NOT_BYPASSABLE'
          )
        }

        // ── 闸门 2：理由必填（spec §11 R1）──
        if (reason === '') {
          throw new HarnessError(
            'reason 必填且不能是空白。break-glass 的理由会被永久保存并计入指标 —— ' +
              '没有理由的绕过等同于 `evasion`，而 `evasion` 本身就要写理由。',
            'BG_REASON_REQUIRED'
          )
        }

        // ── 闸门 3：分类合法 ──
        if (!BREAK_GLASS_CATEGORIES.includes(category)) {
          throw new HarnessError(
            `category「${category}」不是合法分类，必须是：${BREAK_GLASS_CATEGORIES.join(' / ')}。`,
            'BG_BAD_CATEGORY'
          )
        }

        // ── 闸门 4（纵深防御 / 主防线）：该门禁**当前确实在拦**吗 ──
        //    见文件头 ③。GATE-* 在 gate 插件里、phase 复算不了 ⇒ 只能不验，如实标注。
        let verified = false
        let detail = ''
        if (SELF_CHECKABLE.includes(denyId)) {
          const failures = runDenyChecks([denyId], cfg, d1mirror)
          if (failures.length === 0) {
            throw new HarnessError(
              `门禁 ${denyId} 当前**并未**拦住你（复核未发现失败项）⇒ 无需 break-glass。` +
                `break-glass 只用于"门禁确实拦住了、但拦错了"的情形；` +
                `预先砸玻璃等于提前给未来所有调用发通行证。`,
              'BG_NOT_BLOCKED'
            )
          }
          verified = true
          detail = failures[0].reason
        } else {
          detail = `${denyId} 由 gate 插件判定，本插件无法复核它此刻是否在拦`
        }

        // ── 闸门 5：人工确认（spec §11 R2）──
        const outcome = await askApproval(
          ctx,
          exec,
          `你即将绕过 deny 门禁 [${DENY_LABEL[denyId] ?? denyId}]。` +
            (detail ? `\n当前拦截原因：${detail}` : '') +
            `\n此操作将被记录到本地和外置审计。理由将被永久保存。` +
            `\n（分类 ${category}：${CATEGORY_META[category]?.label ?? ''}）` +
            `\n确认绕过吗？`
        )
        if (outcome !== 'allowed-once') {
          throw new HarnessError(
            `未获得确认（approval 返回 ${outcome}）⇒ **未**绕过门禁，${denyId} 仍然生效。`,
            'BG_NOT_CONFIRMED'
          )
        }

        // ── 落账 ──
        const at = new Date().toISOString()
        const expiresAt = new Date(Date.parse(at) + CORRECTION_WINDOW_MS).toISOString()
        const eventId = makeEventId(exec?.callId ?? 'no-call-id', at)
        const anchor = currentAnchorSync(denyId, cfg)

        const prev = readBreakGlassSync(path)
        if (!prev.ok) {
          // 表已损坏 ⇒ 拒绝（不覆盖坏证据，也不假装它是空的）。
          throw new HarnessError(
            `break-glass 记录表已损坏，拒绝写入（避免覆盖掉原有的记录）：${prev.reason}。` +
              `请先人工检查 ${path}。`,
            'BG_TABLE_CORRUPT'
          )
        }

        const record = { id: eventId, denyId, category, reason, at, expiresAt, anchor, status: 'open', resolvedAt: null, callId: exec?.callId ?? null }
        // ① 文件（durable、可失败 ⇒ 失败即整体拒绝）
        try {
          writeBreakGlassAtomic(path, [...prev.records, record])
        } catch (e) {
          throw new HarnessError(
            `写 break-glass 记录表失败 ⇒ 未绕过门禁（拒绝"无痕绕过"）：${String(e?.message ?? e)}`,
            'BG_WRITE_FAILED'
          )
        }

        // ② 链（fail-open：写不进去也不阻断，但那条放行重启后会随链一起消失 —— 见文件头 ④）
        await audit
          .record({
            type: 'break-glass',
            id: eventId,
            denyId,
            category,
            reason,
            at,
            expiresAt,
            anchor,
            verified,
            callId: exec?.callId,
            rootCallId: exec?.rootCallId
          })
          .catch(() => {})

        // ③ 内存镜像（本进程立即生效）
        bgmirror.update(record)

        // ④ 广播给 gate（跨插件唯一通道）。⚠️ 送达不了 ⇒ gate 仍然拦，**方向是安全的**。
        try {
          ctx.emit('fde/break-glass', { ...record, verified })
        } catch {
          // 监听器同步抛错会冒泡到调用方 —— 绝不让广播失败把这次砸玻璃变成失败。
        }

        const open = bgmirror.openRecords()
        const overdue = bgmirror.overdueRecords()
        const msg =
          `✅ break-glass 已执行，事件 ID: ${eventId}\n` +
          `绕过门禁：${DENY_LABEL[denyId] ?? denyId}\n` +
          `分类：${category}（${CATEGORY_META[category]?.label ?? ''}）\n` +
          `补正期至 ${expiresAt}（${WINDOW_DAYS} 天）。Phase 推进继续。\n` +
          (verified ? '' : `⚠️ 本次未能复核"该门禁此刻是否真的在拦"：${detail}\n`) +
          (anchor ? `锚点：内容一旦变更，本条放行**自动失效**。\n` : `⚠️ 本 id 不带内容锚点：放行不会因文件变更而失效（见 README 诚实清单）。\n`) +
          `提示：请在 ${WINDOW_DAYS} 天内完成补正（走正常流程修复导致 break-glass 的问题），` +
          `否则会持续标记"未补正"。\n` +
          `当前待补正 ${open.length} 条${overdue.length > 0 ? `，其中 **${overdue.length} 条已超期**` : ''}。`

        return {
          eventId,
          denyId,
          category,
          expiresAt,
          anchor: anchor ?? '',
          verified,
          pending: open.length,
          overdue: overdue.length,
          message: msg
        }
      }
    })
  )
}
