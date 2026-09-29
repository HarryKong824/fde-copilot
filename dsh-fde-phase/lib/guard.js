/**
 * 门禁判定 —— 主防线（与 gate 的 guard.js 同构）。
 *
 * `evaluate()` 是**纯同步函数**，被两个消费者共用：
 *   - `ctx.tools.guard()`（enforce 模式下真拦，只能否决）
 *   - `ctx.on('tools/pre-execute')` 监听器（两种模式都记录，shadow 下把 would-deny 记成 shadow-deny）
 *
 * 判定与留痕共用同一份规则，避免"shadow 说会拦、enforce 却不拦"这类规则漂移。
 *
 * 🔴 guard 是同步的，所以：
 *   - 读 state 用 `readStateSync`（同步 fs）
 *   - D1 结论比对用 `mirror.verify`（同步重算 actions.yaml 的 sha256）
 *   - 绝不在这里写审计（写审计在 pre-execute 监听器里做）
 */

import { join } from 'node:path'
import { readStateSync, inObservation } from './state.js'
import { nextPhase, DENY_CHECKS, IMPLEMENTED_CHECKS } from './phases.js'
import { TOOL_BY_CHECK } from './mirror.js'
import { complianceFingerprintSync, isRegulatedIndustry } from './check-d5.js'
import { currentAnchorSync } from './break-glass.js'
import { crossCheckRemoteSync } from './remote-state.js'

/**
 * L4 的括号（spec §8）—— 只在**本轮真跑了 D2** 时才有意义。
 *
 * ⚠️ 返回 `null` 表示"这条括号**不适用**"（本轮没跑 D2）。这与 `{status:'missing'}` 是两回事：
 *    前者是"这条判据跟本轮无关"，后者是"判据说不行"。混起来会让"没跑 D2 的阶段"
 *    因为它们本就不该受外置审计约束而被判失败。
 *
 * @param {string[]} checks - 本轮真跑了的、已实现的 check
 * @param {object} cfg
 * @param {number} nowMs
 * @returns {null | {applicable: boolean, status: 'present'|'degraded'|'missing', reason: string, outageMs?: number|null}}
 */
export function remoteConjunctFor(checks, cfg, nowMs) {
  if (!Array.isArray(checks) || !checks.includes('D2')) return null
  return crossCheckRemoteSync(cfg.telemetryStatePath ?? '', nowMs)
}

/**
 * 跑一组已实现的 deny 检查，返回**全部失败项**（不短路，方便一次性说清要补什么）。
 *
 * 🔴 为什么这个函数必须存在：原本"对每个 check 怎么验"写在了 `guard.js` 与 `tools.js` **两处**，
 * 每加一个 check 就要在两边各补一次分支 —— 漏一处 ⇒ guard 拦了而 execute 放行（或反之），
 * 而且**两边都不报错**（施工单 §3②，也是 §6 预判最容易出问题的第 2 条）。
 * 现在两边都调这里 ⇒ 漂移在结构上不可能发生。
 *
 * @param {string[]} checks - 本阶段配置的、且已实现的 check（如 `['D2','D3']`）
 * @param {object} cfg - 规范化配置（ontologyRoot / gateAuditPath / telemetryStatePath）
 * @param {import('./mirror.js').D1Mirror} mirror
 * @param {{now?: number, remote?: object|null}} [deps]
 *   `remote` 是 L4 括号的**预算好的**判定（见 `remoteConjunctFor`）。调用方预算一次传进来
 *   是为了避免"一趟判定里读两遍同一份文件、中间被改过 ⇒ 两处结论不一致"。
 *   不传 ⇒ 本函数自己算（代价 = 同步读一个 <1KB 的 JSON）。
 * @returns {Array<{check: string, reason: string, currentSha?: string, currentLen?: number}>}
 */
export function runDenyChecks(checks, cfg, mirror, deps = {}) {
  const failures = []
  const onto = cfg.ontologyRoot
  for (const c of checks) {
    if (c === 'D1') {
      const v = mirror.verify('D1', [join(onto, 'actions.yaml'), join(onto, 'guards.yaml')])
      if (!v.ok) failures.push({ check: c, reason: v.reason, currentSha: v.currentSha })
    } else if (c === 'D3') {
      const v = mirror.verify('D3', [join(onto, 'objects.yaml'), join(onto, 'logic.yaml')])
      if (!v.ok) failures.push({ check: c, reason: v.reason, currentSha: v.currentSha })
    } else if (c === 'D2') {
      if (typeof cfg.gateAuditPath !== 'string' || cfg.gateAuditPath === '') {
        failures.push({ check: c, reason: 'gateAuditPath 未配置 ⇒ 无法验证 gate 审计链完整性' })
        continue
      }
      const v = mirror.verifyChain('D2', cfg.gateAuditPath)
      if (!v.ok) {
        failures.push({ check: c, reason: v.reason, currentSha: v.currentSha, currentLen: v.currentLen })
        continue
      }
      // 🔴 L4 交叉校验（spec §8）：`deny 校验 = 本地链完整 **AND**（远端存在 OR 降级模式）`。
      //    链完整已经由上面那条验过；这里补后半个括号。
      //    ⚠️ 括号**不适用**时（部署方没配外置审计）不拦 —— 把"没配"判成"不满足"会让
      //    所有没接远端审计的部署在 Phase 4 永久卡死，那正是 spec 要修的死锁形态。
      const remote = deps.remote !== undefined ? deps.remote : remoteConjunctFor(checks, cfg, deps.now ?? Date.now())
      if (remote && remote.applicable && remote.status === 'missing') {
        failures.push({
          check: c,
          reason: `gate 审计链本身完整，但 **L4 交叉校验不通过**：${remote.reason}`,
          currentLen: v.currentLen,
          currentSha: v.currentSha
        })
      }
    } else if (c === 'D5') {
      // 缺陷 A 修复（spec :246）：非受监管行业自动关闭 D5。
      // '未声明' 是哨兵值（不适用），不是行业名；受监管行业（medical-*）才启用。
      // ⚠️ continue 不是 push —— 不适用 ≠ 失败（同 D2 gateAuditPath 未配置那条的形态）。
      if (!isRegulatedIndustry(cfg.industry)) continue
      // D5：compliance.yaml 存在性 + 非空键。guard 同步取指纹比对。
      const path = join(onto, 'compliance.yaml')
      let fp
      try {
        fp = complianceFingerprintSync(path)
      } catch (e) {
        failures.push({ check: c, reason: '读 compliance.yaml 失败：' + String(e?.message ?? e) })
        continue
      }
      const v = mirror.verify('D5', [path], { len: fp.len, sha256: fp.sha256, nonempty: fp.nonempty })
      if (!v.ok) failures.push({ check: c, reason: v.reason, currentSha: v.currentSha })
    } else {
      // fail-closed：登记成"已实现"却没有分支处理 ⇒ 不许因为它没分支就当它过了。
      failures.push({ check: c, reason: `${c} 已登记为已实现，但没有对应的判定分支` })
    }
  }
  return failures
}

/**
 * 纯同步判定。返回 { deny, checks?, skipped? }。
 *
 * @param {Readonly<{name: string, arguments?: unknown, agent?: unknown}>} exec
 * @param {object} cfg - 已规范化配置（含 projectRoot / ontologyRoot / auditPath / mode / lockTtlMs）
 * @param {import('./mirror.js').D1Mirror} mirror
 * @param {import('./bg-mirror.js').BreakGlassMirror} [bg] - 放行表；缺省 ⇒ 无任何放行（fail-closed）
 * @returns {{deny: string | undefined, checks?: string[], skipped?: string[], bypassed?: string[], resolvedCandidates?: string[]}}
 */
export function evaluate(exec, cfg, mirror, bg) {
  if (exec.name !== 'fde_phase_advance') return { deny: undefined }

  const args = /** @type {Record<string, unknown>} */ (exec.arguments ?? {})
  const to = typeof args.to === 'string' ? args.to : ''

  // 同步读 state.yaml（guard 不能 await；apply 期已把 projectRoot 解析好，不猜路径）。
  const statePath = join(cfg.projectRoot, 'memory', 'state.yaml')
  const state = readStateSync(statePath)
  const current = String(state.current_phase ?? '0.1')

  // ⓪ C3（spec §10.4）：回滚观察期冻结 —— 最高优先级，先于推进规则与门禁判定。
  // 回滚后 24h 内禁止任何推进：观察期语义是"部署出问题后暂停"，不继续往前跑，
  // 结束后才确认是否重新部署。
  if (inObservation(state)) {
    return {
      deny:
        `回滚观察期内（回滚于 ${state.rollback_at}，24h 观察期未结束），禁止推进。` +
        `请等待观察期结束后再推进，届时确认是否重新部署。`,
      checks: [],
      skipped: []
    }
  }

  // ① 推进规则：只允许 current → next (+1)，不允许跳跃（跳过 Phase 3 = 跳过 D1 = 门禁漏洞）。
  const want = nextPhase(current)
  if (want === undefined) {
    return {
      deny: `当前已是最后一个阶段（${current}），不能再推进。`,
      checks: [],
      skipped: []
    }
  }
  if (to !== want) {
    return {
      deny:
        `不允许跳跃推进：当前 ${current}，下一个合法阶段是 ${want}（你请求的是 ${to || '（空）'}）。` +
        ` 跳过阶段等于跳过门禁，属安全漏洞。`,
      checks: [],
      skipped: []
    }
  }

  // ② 本阶段配置的 deny 检查项：拆成"已实现"与"未实现"。
  const checksConfigured = DENY_CHECKS[current] ?? []
  const checks = checksConfigured.filter((c) => IMPLEMENTED_CHECKS[c])
  const skipped = checksConfigured.filter((c) => !IMPLEMENTED_CHECKS[c])

  // 未实现的 deny 项：明确不拦（本函数只返回 deny，不拦就是 deny===undefined），
  // 但必须在审计里写说明（由 pre-execute 监听器用下面的 `skipped` 字段记录）。
  // 绝不可挂桩返回 passed:true —— 那等于假装拦住了。

  // ③ 已实现的检查：D1 / D3 走文件复合锚点，D2 走 gate 审计链锚点（都在 `runDenyChecks` 里按 check 分派）。
  //    L4 括号**只算一次**、两处共用（判定 + 结果里的 degraded 标记）—— 见 `remoteConjunctFor` 的注释。
  const nowMs = Date.now()
  const remote = remoteConjunctFor(checks, cfg, nowMs)
  const degraded = !!(remote && remote.applicable && remote.status === 'degraded')
  const failures = runDenyChecks(checks, cfg, mirror, { now: nowMs, remote })

  // ④ break-glass 放行（spec §11）—— 把失败项分成"已被砸玻璃放过"与"仍然拦着"。
  //    ⚠️ **必须逐项判**，不能"有一个放行就全放"：D1 砸了玻璃而 D3 没砸，是真实场景；
  //    一刀切会让 D3 跟着 D1 一起静默放行 —— 那是**凭空多出一个门禁漏洞**。
  const bypassed = []
  const remaining = []
  for (const f of failures) {
    if (bg && bg.isBypassed(f.check, (id) => currentAnchorSync(id, cfg))) bypassed.push(f)
    else remaining.push(f)
  }

  // ⑤ 自动补正候选（spec §11 R5）：某条 open 记录对应的门禁**这一轮没失败** ⇒ 补正完成。
  //    ⚠️ 只在 `checks`（本阶段真跑了的、已实现的检查）范围内判 —— 没跑的检查谈不上"通过了"。
  //    ⚠️ 这里**只返回候选、不写盘**：guard 是同步的，写链/写表都在 `tools/pre-execute` 里做。
  const resolvedCandidates = bg
    ? bg
        .openRecords()
        .filter((r) => checks.includes(r.denyId) && !failures.some((f) => f.check === r.denyId))
        .map((r) => r.id)
    : []

  if (remaining.length > 0) {
    const detail = remaining.map((f) => `${f.check}：${f.reason}`).join('；')
    const tools = Array.from(new Set(remaining.map((f) => TOOL_BY_CHECK[f.check] ?? `${f.check} 对应工具`)))
    // 放行过的项要在文案里说出来 —— 否则用户会以为"修好了一个怎么还拦"，
    // 或者更糟：以为门禁没生效。
    const bgNote =
      bypassed.length > 0
        ? `（另有 ${bypassed.map((f) => f.check).join(' / ')} 已被 break-glass 放过，不在此列）`
        : ''
    return {
      deny:
        `阶段 ${current} 门禁未通过 —— ${detail}。` +
        `请先跑 ${tools.join(' / ')} 并使其通过，再推进到 ${to}。${bgNote}`,
      checks,
      skipped,
      bypassed: bypassed.map((f) => f.check),
      resolvedCandidates,
      degraded,
      remote
    }
  }

  return {
    deny: undefined,
    checks,
    skipped,
    bypassed: bypassed.map((f) => f.check),
    resolvedCandidates,
    // 🔴 spec §8：「降级期间所有 deny 通过都带 degraded: true 标记」——
    //    它是**通过**，但通过的依据弱于正常态，这件事必须跟着结果走到审计里去。
    degraded,
    remote
  }
}

/**
 * 注册单调 guard。只在 enforce 模式下真正否决。
 *
 * guard 语义：同步、返回字符串即拒绝、且不可被任何后续监听器翻盘。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg
 * @param {import('./mirror.js').D1Mirror} mirror
 * @param {import('./bg-mirror.js').BreakGlassMirror} [bg] - break-glass 放行表（spec §11）
 * @returns {() => void} 注销器
 */
export function installGuard(ctx, cfg, mirror, bg) {
  const applySemanticRules = cfg.mode === 'enforce'
  return ctx.tools.guard((exec) =>
    applySemanticRules ? evaluate(exec, cfg, mirror, bg).deny : undefined
  )
}
