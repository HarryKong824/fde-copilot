import { Config, normalizeConfig } from './config.js'
import { AuditChain } from './audit.js'
import { installGuard } from './guard.js'
import { installAuditListener } from './pre-execute.js'
import { BreakGlassMirror, BG_CHAIN_TYPES } from './bg-mirror.js'
import { installOntologyTools } from './tools.js'
import { installShadowTools } from './shadow-tools.js'
import { installMetricsTools } from './metrics-tools.js'
import { MODE_SWITCH_UNATTESTED, enforceAttestation, readChainRecordsSync } from './shadow-stats.js'
import { canonicalizeSync, formatProtectedRootsLine, isInside } from './paths.js'

/**
 * fde-ontology-gate —— FDE Copilot ontology 门禁插件（PoC 骨架）。
 *
 * 架构（按可行性分析 6.7 收口决议）：
 *   主防线 = `ctx.tools.guard()` 钉在专用工具入口（同步、语义级 + source 溯源 + 置信度）
 *   兜底   = 同一个 guard 里做路径匹配，拦 shell / 通用 fs 工具直奔 ontology 直写
 *   留痕   = `tools/pre-execute`（async）写哈希链审计
 *   通道   = 专用工具用原生 node:fs 直写，是唯一被授权绕过原生 fs 围栏的合法通道
 *
 * 能力边界（必须对客户讲清）：
 *   本插件是**进程内软约束** —— 防的是模型无意的失误与漂移，不是有意的恶意绕过。
 *   绕过可见、可审计、可统计、可纠正，但不是"绝对拦死"。
 */

const name = 'fde-ontology-gate'

/** 需要 tools 服务就绪才能注册 guard / restrict / 工具。 */
const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const log = ctx.logger ?? console

  const ontologyRoot = canonicalizeSync(cfg.ontologyRoot)

  // 架构决议要求 ontology 落在 process.cwd() 之外（区外）。落区内不会让门禁失效，
  // 但会让原生 workspace-write 围栏把"区外=只读"的偶然纵深弄丢，值得显式提醒。
  if (isInside(ontologyRoot, process.cwd())) {
    log.warn?.(
      `[${name}] ontologyRoot 位于工作区内部（${ontologyRoot}）。` +
        '架构决议要求区外；区内时原生 fs 围栏不再提供额外纵深，只能靠本插件的 guard。'
    )
  }

  const audit = new AuditChain(cfg.auditPath)

  // 🔴 spec §12 的"才可切 enforce"在此处**兑现一次**（2026-09-29，E4）。
  //
  // 判两件事：`mode === 'enforce'` 时，链上**最后一条**模式切换记录是不是本流程批准的
  // （`enforceAttestation`；"最后一条"而非"存在一条"—— 见该函数注释）。
  //
  // ⚠️ 这里的强度是「**曝光**」而不是「**拒绝加载**」，这是**有意**的取舍，理由有二：
  //   ① 模式是**部署层配置**（`cordis.patch.yml`），插件只读。运维手改配置这个动作
  //      本插件在结构上就管不着 —— 与"手改文件绕过 deny"同属**进程内软约束的边界**
  //      （见文件头"能力边界"）。假装拒绝加载只会把"绕过"变成"起不来"，更糟。
  //   ② 若在这里把无凭据的 enforce **降级回 shadow**，方向是**放松门禁**（真拦变只记）。
  //      实测本机真环境正是 `mode: enforce` 且在生效 ⇒ 硬降级会让一个正在工作的门禁
  //      当场失效。**宁可"生效但被记一笔"，不可"静默失效"。**
  // 真正的硬门在 `fde_shadow_switch` 工具里（不达标直接拒绝），两者分工明确。
  if (cfg.mode === 'enforce') {
    const att = enforceAttestation(readChainRecordsSync(cfg.auditPath).records ?? [])
    if (!att.attested) {
      const why =
        att.why === 'none'
          ? '链上从未有过模式切换记录（本准入流程一次都没走过）'
          : att.why === 'observe'
            ? '链上最后一条模式切换是切回 observe（此前若有批准已被它抵消）'
            : '链上最后一条模式切换是**被拒**的 enforce 尝试'
      audit
        .record({
          type: MODE_SWITCH_UNATTESTED,
          decision: MODE_SWITCH_UNATTESTED,
          mode: cfg.mode,
          why: att.why,
          note:
            '当前以 enforce 运行，但链上没有一次通过 spec §12 准入检查的批准记录。' +
            '门禁本身仍然生效（本条只是让它**可见**）；要走完准入流程请用 fde_shadow_switch。'
        })
        .catch(() => {})
      log.warn?.(
        `[${name}] ⚠️ 当前 mode=enforce，但**没有影子期批准记录**：${why}。` +
          '门禁照常生效；本条只是提醒这次 enforce 未经 spec §12 的校准流程（observe ≥7 天 + 准确率 >80% + 逐条确认）。' +
          '要走完流程请调用 fde_shadow_switch（先切 observe 攒数据）。'
      )
    }
  }

  // break-glass 放行表（spec §11）—— 本插件**只消费**，不生产。
  //
  // 🔴 **为什么 gate 要把它镜像进自己的链，而不是去读 phase 的链**：两条链是**分开的**
  //    （`gate.jsonl` / `phase.jsonl`，见 `cordis.patch.yml`），而且 guard 是**同步**的、
  //    跨插件只有 `ctx.emit`。`fde-break-glass` 工具在 phase 里 ⇒ 它写的 `break-glass`
  //    记录落在 **phase 的链**上。gate 若只监听事件、不落自己的链，**重启后放行全丢**
  //    （phase 不会为已存在的记录重新广播）⇒ 行为依赖"谁先起来"。
  //    ⇒ 各写各的链，重启顺序无关（同 `D1Mirror` 的取舍）。
  const bg = new BreakGlassMirror()
  bg.restoreSync(cfg.auditPath)
  const bgOpen = bg.openRecords()

  ctx.effect(
    () => installGuard(ctx, cfg, bg),
    `${name} guard（专用工具入口 + 路径兜底 + break-glass 放行表）`
  )
  ctx.effect(
    () => installAuditListener(ctx, cfg, audit, bg),
    `${name} 审计（tools/pre-execute + session/flush）`
  )

  // break-glass 事件接收（phase 广播）。
  // ⚠️ 监听器**必须同步且不抛**：`emit` 的监听器同步抛错会冒泡给**广播方**，
  //    那会把一次成功的砸玻璃变成工具调用失败。两个 `audit.record` 都是异步的、
  //    且自带 `.catch` —— 唯一可能同步抛的是 `bg.update`，故整段再包一层 try/catch。
  const disposeBG = ctx.on('fde/break-glass', (payload) => {
    try {
      bg.update(payload)
      // 镜像进**本插件自己的链**，供下次 apply 期 `restoreSync` 重建（见上方 🔴）。
      // ⚠️ 字段名与 `bg-mirror.js` 的 `restoreSync` 读的**逐字对应**
      //    （id/denyId/category/reason/at/expiresAt/anchor）—— 少一个就是"重启后放行失效"。
      if (payload?.resolved === true) {
        audit
          .record({ type: BG_CHAIN_TYPES.RESOLVED, id: payload.id, at: payload.at, via: 'phase' })
          .catch(() => {})
      } else if (payload?.id) {
        audit
          .record({
            type: BG_CHAIN_TYPES.OPEN,
            id: payload.id,
            denyId: payload.denyId,
            category: payload.category,
            reason: payload.reason,
            at: payload.at,
            expiresAt: payload.expiresAt,
            anchor: payload.anchor ?? null,
            via: 'phase'
          })
          .catch(() => {})
      }
    } catch {
      // 放行表更新失败 ⇒ 本次调用仍按"没有放行"处理（fail-closed，方向安全）。
    }
  })
  ctx.effect(() => disposeBG, `${name} 监听 fde/break-glass`)
  ctx.effect(
    () => installOntologyTools(ctx, cfg, audit),
    `${name} 专用工具 fde_ontology_read / fde_ontology_write`
  )
  ctx.effect(
    () => installShadowTools(ctx, cfg, audit),
    `${name} 影子模式工具 fde_shadow_status / fde_shadow_switch`
  )
  ctx.effect(() => installMetricsTools(ctx, cfg, audit), `${name} 指标采集工具 fde_metrics（spec §14）`)

  // 缺陷 ② 修复后，挂载日志同时暴露链状态：续接旧链还是新链，一眼可辨。
  const auditState =
    cfg.auditPath === ''
      ? '仅内存'
      : audit.count === 0
        ? `${cfg.auditPath}（新链，全零起点）`
        : `${cfg.auditPath}（续接旧链至 seq ${audit.count}）`

  // P0-6：启动期把**生效的**受保护根整个打出来。
  // 取自 `protectedRootsOf(cfg)` —— 与 guard 判定同一个函数 ⇒ "打印的"与"判的"
  // 字面不可能不一致；剩下能漂的只有配置项本身，而那正是这一行要让它可见的。
  // 整行由 `formatProtectedRootsLine()` 产出（与判定同一个 protectedRootsOf，
  // 且离线可测 —— 0024 §6：活体上观测不到 stdout，"打印对不对"只能靠离线断言背书）。
  const protectedLine = formatProtectedRootsLine(cfg)

  log.info?.(
    `[${name}] 已挂载：mode=${cfg.mode}, denyRunCode=${cfg.denyRunCode}, ` +
      `ontologyRoot=${ontologyRoot}, audit=${auditState}, ` +
      `break-glass=${bgOpen.length > 0 ? `已恢复 ${bgOpen.length} 条放行` : '无放行'}`
  )
  log.info?.(
    `[${name}] ${protectedLine}` +
      `${cfg.mode === 'shadow' ? '（⚠️ shadow 模式下**不拦**）' : ''}`
  )

  // E5：`fde_metrics` 的 phase 链来源也要在启动时可见 —— 与受保护根同一理由：
  // 配错路径的症状是"三项指标静默无数据"，只有把**生效值**打出来才能一眼分辨
  // "真没数据"与"路径配错了"。
  log.info?.(
    `[${name}] fde_metrics 的 phase 链 = ` +
      (cfg.phaseAuditPath.trim().length > 0
        ? cfg.phaseAuditPath
        : '⚠️ 未配置（phaseAuditPath 为空）⇒ ③变更触发率 / ④ask 跳过率 / ⑤Phase 停留时长 三项**无从计算**' +
          '（会如实报 insufficient-data，不是 0%）')
  )
}

export { Config, apply, inject, name }
