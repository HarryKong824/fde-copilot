import { Config } from './config-schema.js'
import { normalizeConfig, NAME } from './config.js'
import { AuditChain, GENESIS } from './audit.js'
import { D1Mirror } from './mirror.js'
import { installGuard } from './guard.js'
import { installAuditListener } from './audit-listener.js'
import {
  installPhaseTool,
  installAuditCheckTool,
  installComplianceCheckTool,
  installRollbackTool,
  installChangeCloseTool
} from './tools.js'
import { installRestrict } from './restrict.js'
import { BreakGlassMirror } from './bg-mirror.js'
import { installBreakGlassTool } from './break-glass-tool.js'
import { installBreakGlassNotify } from './break-glass-notify.js'

/**
 * dsh-fde-phase —— FDE Copilot v3 的 Phase 状态机插件。
 *
 * 架构（施工单 §4）：
 *   主防线  = `ctx.tools.guard()` 钉在 `fde_phase_advance` 入口（同步、只能否决）
 *   推进动作 = `fde_phase_advance`（模型改变当前阶段的唯一入口）
 *   留痕    = `tools/pre-execute`（async）写哈希链审计（guard 同步、碰不了 IO）
 *   结论传输 = 监听 dsl 广播的 `fde/check-result` → 写审计 + 更新内存镜像
 *   镜像恢复 = apply 期同步读审计尾部，重建 D1 结论（重启不丢，但 actions.yaml / guards.yaml 任一变更即失效——锚点覆盖两文件）
 *   工具面过滤 = `restrict`：受保护 Phase 内对**每个 agent** 隐藏 config 名单里的全局工具
 *               （阶段是全局的、限制是每 agent 的 ⇒ 阶段一变就要对所有存活 agent 对账）
 *
 * 能力边界（必须对客户讲清）：
 *   本插件是**进程内软约束** —— 防的是模型无意的失误与漂移，不是有意的恶意绕过。
 *   deny 门禁 D1 / D2 / D3 / D5 均已实现（D2 的 `fde-run-audit-check`、D5 的
 *   `fde-run-compliance-check` 由本插件自己提供）；D4 已按 v3 降为 ask（execute 层 approval，见 0089）。
 */

const name = NAME

/** 需要 tools 服务就绪才能注册 guard / 工具 / 监听。 */
const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const log = ctx.logger ?? console

  const audit = new AuditChain(cfg.auditPath)
  const mirror = new D1Mirror()

  // apply 期同步读审计尾部，恢复 D1 结论镜像（重启不丢；改了 actions.yaml 结论必然失效）。
  mirror.restoreSync(cfg.auditPath)
  const mirrorState = mirror.get('D1') ? `有 D1 结论（passed=${mirror.get('D1').passed}）` : '无 D1 结论'

  // break-glass 放行表（spec §11）：与 D1 结论同样在 apply 期从**本插件自己的链**恢复。
  // ⚠️ 恢复窗口只有链尾 `TAIL_BYTES` —— 窗口外的记录读不到 ⇒ 那条放行在重启后消失。
  //    方向是**保守的**（少放行 = 更难绕），但已写进 README 诚实清单。
  const bg = new BreakGlassMirror()
  bg.restoreSync(cfg.auditPath)
  const bgOpen = bg.openRecords()
  const bgState = bgOpen.length > 0 ? `待补正 ${bgOpen.length} 条（超期 ${bg.overdueRecords().length}）` : '无待补正'

  // 1) restrict：受保护 Phase 内对每个 agent 隐藏 `denyTools` 名单里的工具（第二批施工单 §2）。
  //    ⚠️ 必须在 `fde_phase_advance`（第 2 步）**之前**创建：推进成功后要拿它的 governor
  //    对所有存活 agent 做全量对账 —— 否则"推进前就开着"的会话不会被覆盖（判据 5）。
  const restrict = installRestrict(ctx, cfg, audit)
  ctx.effect(() => restrict.dispose, `${name} restrict（受保护 Phase 工具面过滤）`)

  // 2) guard：enforce 模式下真拦（同步拒绝 fde_phase_advance）。
  ctx.effect(() => installGuard(ctx, cfg, mirror, bg), `${name} guard（fde_phase_advance 入口）`)

  // 3) 工具：fde_phase_advance（模型推进阶段的唯一入口）。
  ctx.effect(
    () => installPhaseTool(ctx, cfg, audit, mirror, restrict.governor),
    `${name} 工具 fde_phase_advance`
  )

  // 3b) 工具：fde-run-audit-check（D2 —— 跑 gate 审计链完整性，广播结论供 guard 比对）。
  //     ⚠️ 由本插件自己提供：D2 验的是 gate 链的完整性，而判定要落在"推进"这个动作上。
  ctx.effect(() => installAuditCheckTool(ctx, cfg), `${name} 工具 fde-run-audit-check`)

  // 3c) D5 工具：fde-run-compliance-check
  ctx.effect(() => installComplianceCheckTool(ctx, cfg), `${name} 工具 fde-run-compliance-check`)

  // 3d) C3 工具：fde_rollback（回滚独立通道，使用回滚预授权，不重审 D5）
  ctx.effect(() => installRollbackTool(ctx, cfg, audit), `${name} 工具 fde_rollback`)

  // 3e) C2 工具：fde_change_close（L0/L1/L2 各自流程的闭环判定）。
  //     ⚠️ 级别由本工具**自己从 gate 审计链读**，不由模型传入 —— 否则模型报 L0 就能少跑 D1/D5。
  //     ⚠️ 复用 2) 的同一个 mirror 实例：这里核验的锚点必须与 guard 推进时用的是同一份结论。
  ctx.effect(
    () => installChangeCloseTool(ctx, cfg, audit, mirror),
    `${name} 工具 fde_change_close`
  )

  // 3f) E1 工具：fde-break-glass（紧急逃生门，spec §11）。
  //     ⚠️ 它**不受 guard 约束**（guard 只钉 `fde_phase_advance`）⇒ 它自己的闸门
  //     （id 白名单 / 理由必填 / 分类 / **当前确实在拦** / approval）**就是主防线**。
  ctx.effect(
    () => installBreakGlassTool(ctx, cfg, audit, mirror, bg),
    `${name} 工具 fde-break-glass`
  )

  // 3g) E1 提醒：每次会话建立时提示"有 N 条 break-glass 待补正"（spec §11 R6）。
  ctx.effect(
    () =>
      installBreakGlassNotify(ctx, name, bg, (e, where) => {
        // 塞不进 inbox 不致命，但**不许静默** —— 否则"没提醒"和"没有待补正"长得一样。
        audit
          .record({ type: 'break-glass-notify-failed', where, error: String(e?.message ?? e) })
          .catch(() => {})
      }),
    `${name} break-glass 会话提醒（agent/session-start）`
  )

  // 4) 审计监听器：tools/pre-execute（记录 deny / shadow-deny / 未实现项说明 / break-glass 留痕）。
  ctx.effect(
    () => installAuditListener(ctx, cfg, audit, mirror, bg),
    `${name} 审计（tools/pre-execute + session/flush）`
  )

  // 5) D1 结论接收：dsl 广播 fde/check-result → 写审计 + 更新内存镜像。
  //    ⚠️ 接收方用同步函数 + .catch，避免异步 reject 变成 unhandled rejection
  //    （广播方 dsl 已用 try/catch 包住 emit，这里再兜底一次）。
  const disposeCheckResult = ctx.on('fde/check-result', (payload) => {
    mirror.update(payload)
    audit
      .record({
        type: 'check-result',
        check: payload?.check,
        passed: !!payload?.passed,
        anchor: payload?.anchor,
        detail: payload?.detail,
        at: payload?.at,
        callId: payload?.callId
      })
      .catch(() => {})
  })
  ctx.effect(() => disposeCheckResult, `${name} 监听 fde/check-result`)

  // 「新链 vs 续接」只能拿**链头**判：`count === 0` 也会出现在"文件有内容、链头已正确恢复、
  // 但窗口内没有任何 seq"的情形，而那实质是**正确续接**。旧代码按 count 判定会把后者
  // 谎报成「新链，全零起点」，排查 P1-1 这类问题时正好把人带偏（P2-1）。
  const freshChain = audit.head === GENESIS
  const auditState =
    cfg.auditPath === ''
      ? '仅内存'
      : freshChain
        ? `${cfg.auditPath}（新链，全零起点）`
        : audit.count === 0
          ? `${cfg.auditPath}（续接旧链，链头已就位；但窗口内无可用 seq，序号将从 1 起排）`
          : `${cfg.auditPath}（续接旧链至 seq ${audit.count}）`

  log.info?.(
    `[${name}] 已挂载：mode=${cfg.mode}, projectRoot=${cfg.projectRoot}, ` +
      `ontologyRoot=${cfg.ontologyRoot}, audit=${auditState}, D1 镜像=${mirrorState}, break-glass=${bgState}`
  )
}

export { Config, apply, inject, name }
