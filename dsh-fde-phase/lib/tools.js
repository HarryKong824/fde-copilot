/**
 * `fde_phase_advance` —— 模型推进 FDE 业务阶段的**唯一**入口（与 gate 的专用工具同构）。
 *
 * 设计要点（施工单 §5.4）：
 *   - 只能推进到「下一个」阶段（不允许跳跃）。跳过阶段 = 跳过门禁（如跳过 Phase 3 = 跳过 D1）。
 *   - 推进前跑当前阶段的 deny 检查；guard 已在入口同步否决，本 execute 只做**纵深防御**。
 *   - 拒绝一律 `throw new HarnessError(message, code)`（真实 SDK）；桩环境无 HarnessError 时降级为 Error。
 *   - 回执**只给状态与理由**，绝不回显 state.yaml 全文（同 dsl "不回显 ontology 内容"的红线）。
 *   - shadow / enforce 行为差异：enforce 下 deny 检查不过就抛错（工具调用失败）；
 *     shadow 下即使「本会被拒」也照常推进，但会写审计说明（影子模式 = 看见了先不拦）。
 *
 * 🔴 HarnessError 的正确来源（2026-09-28 活验修正）：真 SDK 的 `@deepseek-ai/dsh-tools`
 * **不 re-export `HarnessError`**（实测 `dshTools.HarnessError === undefined`）——它定义在
 * `@deepseek-ai/dsh-llm`。旧写法 `dshTools.HarnessError ?? Error` 在真 SDK 下静默降级为裸
 * `Error`、`code` 字段丢失（宿主按 `error.code` 路由失效）。故直接从 `@deepseek-ai/dsh-llm`
 * 具名 import；工作区根已补同名桩（带 `code` 字段），离线测试同样能验到 code。
 */

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import * as dshTools from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { readState, writeState, inObservation } from './state.js'
import { nextPhase, DENY_CHECKS, IMPLEMENTED_CHECKS, PHASE_IDS } from './phases.js'
import { runDenyChecks, remoteConjunctFor } from './guard.js'
import { TOOL_BY_CHECK } from './mirror.js'
import { runD2Check, D2_ANCHOR_ALG } from './check-d2.js'
import { runD5Check, D5_ANCHOR_ALG, COMPLIANCE_KEYS, isRegulatedIndustry, parseComplianceYaml } from './check-d5.js'
import { writeComplianceDataPolicy } from './compliance-write.js'
import { askApproval } from './approval.js'
import {
  readLatestChange,
  verifyRequiredChecks,
  describeIncomplete,
  REQUIRED_CHECKS,
  NEEDS_APPROVAL
} from './change-flow.js'

const { defineTool } = dshTools

/** 工具名。v3 阶段推进的唯一入口。 */
export const PHASE_ADVANCE_TOOL = 'fde_phase_advance'

/** D2 的工具名：跑一次 gate 审计链的完整性检查，并把结论广播给本插件的镜像。 */
export const AUDIT_CHECK_TOOL = 'fde-run-audit-check'

/**
 * 把推进结果压成一行人话（也是工具回执的正文）。不回显 state.yaml 全文。
 *
 * 🔴 0071 缺陷 F 修复：字段语义写死，避免数据层分不开。
 *   链上 `checks` 字段在「D5 跑了」（V3 deny）与「D5 没跑」（V1 放行）两种情况下取值都是 ["D5"]，
 *   靠 `notApplicable` 字段缺席判断（V3 字段缺席=跑了，反直觉）。新增 passedChecks + phaseChecks 让数据层自洽。
 *   - `phaseChecks`：本阶段**配置**的全部 deny 项（已实现 + 未实现）= checks ∪ skipped。让读者看清"本阶段配了哪些"。
 *   - `checks`：本阶段配置且**已实现**的 deny 项。**≠ 跑过** —— V1 时 D5 不适用，checks=["D5"] 但 D5 没跑（guard.js:56 continue）。
 *   - `passedChecks`：**实际跑过且通过**的 deny 项 = checks 减去 failures 减去 notApplicable。
 *     V1 passedChecks=[]（D5 没跑）、V4 passedChecks=["D5"]（D5 跑了且通过）—— 这是区分「跑没跑」的唯一字段。
 *   - `skipped`：本阶段配置但**未实现**的 deny 项（诚实说明，本轮不拦）。
 *   - `notApplicable`：本阶段配置且已实现但**不适用**的 deny 项（如 D5 在非受监管行业）。
 *     🔴 字段缺席 ≠ 不适用 —— 不适用 = 字段存在且为非空数组。V3 deny 时该字段缺席是"跑了且失败"（throw，不走到 return）。
 * @param {{from:string,to:string,revision:number,phaseChecks:string[],checks:string[],passedChecks:string[],skipped:string[],notApplicable:string[],d4Approval:string}} r
 */
function renderAdvance(r) {
  const parts = [`阶段推进：${r.from} → ${r.to}（revision ${r.revision}）`]

  // §3 反问②：列出本阶段门禁集合（已实现 + 未实现），让读者看清"本阶段配了哪些"，不再被迫猜
  const phaseList = []
  if (r.checks && r.checks.length > 0) phaseList.push(...r.checks.map((c) => `${c}（已实现）`))
  if (r.skipped && r.skipped.length > 0) phaseList.push(...r.skipped.map((c) => `${c}（未实现）`))
  if (phaseList.length > 0) parts.push(`　本阶段门禁集合：${phaseList.join('、')}`)

  // 🔴 缺陷 F：用 passedChecks（实际跑过且通过）替代原误用 checks 的"跑过门禁"
  //    V1 时 D5 不适用（notApplicable=["D5"]），passedChecks=[] —— 让"没跑"在数据层与文案层都显形
  const passed =
    r.passedChecks && r.passedChecks.length > 0
      ? r.passedChecks.join('、')
      : '（无 — 本阶段已实现的项均不适用或未跑）'
  parts.push(`　实际跑过且通过：${passed}`)

  if (r.notApplicable && r.notApplicable.length > 0) {
    // 🔴 缺陷 F：去掉"检查通过"误导 —— 不适用 = 根本没跑（guard.js:56 continue），不是"跑了且通过"
    parts.push(
      '　不适用的门禁：' + r.notApplicable.join('、') + '（行业未声明，未执行检查，见 README §D5）'
    )
  }
  if (r.skipped && r.skipped.length > 0) {
    parts.push(
      `　未实现而放过的门禁：${r.skipped.join('、')}（本轮不拦，见 README 诚实缺口清单）`
    )
  }
  // D1/L4（spec §8）：降级通过必须**在回执正文里说出来** ——
  // 只把这个标记留在审计里，模型与用户就会以为"和正常通过一样"。
  if (r.degraded === true) {
    parts.push(
      '　🔴 本次通过依赖**审计外置降级模式**（远端不可达已超过阈值）：本地哈希链完整，' +
        '但"远端存在"这一条不成立 ⇒ 审计保证强度低于正常态（spec §8 诚实边界）。'
    )
  }

  // 0089：D4 从 deny 降 ask —— 诚实披露其结果（'n/a' 未触发则不打印）。
  if (r.d4Approval && r.d4Approval !== 'n/a') {
    parts.push(
      '　D4 客户验收：' + (r.d4Approval === 'confirmed' ? '已确认' : '降级放行（提醒未送达）')
    )
  }
  // B3：D5-pre（Phase 2 数据接入前置检查，ask 级）—— 诚实披露其结果。
  if (r.d5PreApproval && r.d5PreApproval !== 'n/a') {
    parts.push(
      '　D5-pre 数据接入：' +
        (r.d5PreApproval === 'confirmed' ? '已确认并写入 compliance.yaml' : '降级放行（提醒未送达，Phase 6 D5 会因 data_policy 空而不通过）')
    )
  }
  return parts.join('\n')
}

/**
 * 注册 `fde_phase_advance`。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化配置（含 projectRoot / ontologyRoot / mode / lockTtlMs）
 * @param {import('./audit.js').AuditChain} audit
 * @param {import('./mirror.js').D1Mirror} mirror - D1 结论内存镜像（execute 复用其 verify）
 * @param {import('./restrict.js').RestrictGovernor} [governor] - 工具面过滤治理器（第二批）；
 *        推进成功后对所有存活 agent 重算 —— 缺失时跳过对账（不影响推进本身）
 * @returns {() => void} 注销器
 */
export function installPhaseTool(ctx, cfg, audit, mirror, governor) {
  const dispose = ctx.tools.register(
    defineTool({
      name: PHASE_ADVANCE_TOOL,
      description:
        '推进 FDE 业务阶段。这是改变当前阶段的唯一入口。' +
        '只能推进到「下一个」阶段（不允许跳跃）。推进前会跑当前阶段的门禁检查，' +
        '不通过则调用被拒绝 —— 报告里会给出每个未通过项的原因与完成路径。' +
        '回执只含状态与理由，不回显 state.yaml 全文。',
      parameters: {
        to: {
          type: 'string',
          required: true,
          enum: PHASE_IDS,
          description: '目标阶段 id，必须正好是「当前阶段的下一个」（不允许跳跃）'
        },
        reason: {
          type: 'string',
          required: true,
          description: '本次推进的业务理由（写入审计）'
        },
        data_authorization: {
          type: 'string',
          description: '仅 Phase 2 → 3（D5-pre 数据接入前置检查）必填：数据授权依据（谁授权、依据什么）'
        },
        deidentification_plan: {
          type: 'string',
          description: '仅 Phase 2 → 3（D5-pre 数据接入前置检查）必填：脱敏方案（哪些字段、怎么脱敏）'
        }
      },
      output: {
        schema: {
          // ⚠️ 顶层 object 必须显式 additionalProperties —— 缺了真 SDK 在 defineTool() 即抛错，
          // 等于插件加载失败、工具注册不上（与 dsl/gate 同款坑）。
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string', required: true },
            to: { type: 'string', required: true },
            revision: { type: 'number', required: true },
            // ⚠️ array 节点本身不需要 additionalProperties（只有 type:'object' 需要显式声明）。
            // 🔴 0071 缺陷 F：新增 phaseChecks + passedChecks，避免 checks 在「跑了」与「没跑」时取值相同
            phaseChecks: { type: 'array', required: true },
            checks: { type: 'array', required: true },
            passedChecks: { type: 'array', required: true },
            skipped: { type: 'array', required: true },
            notApplicable: { type: 'array', required: true },
            // 0089：D4 从 deny 降 ask，回执诚实披露其结果（'n/a' 未触发 / 'confirmed' 已确认 / 'degraded' 降级放行）
            d4Approval: { type: 'string', required: true },
            // B3：D5-pre（Phase 2 数据接入前置检查，ask 级）结果（'n/a' 未触发 / 'confirmed' 已确认并写 compliance.yaml / 'degraded' 降级放行）
            d5PreApproval: { type: 'string', required: true },
            // D1/L4（spec §8）：本次推进是否是在**审计外置降级模式**下通过的。
            // ⚠️ schema DSL 里没有 `null`，而"这条括号不适用"也必须能与"没降级"分辨 ⇒
            //    回执里只用布尔（不适用 = false），而**审计记录**里另有 `remote: null|{...}`
            //    承担三分（不适用 / present / degraded）。两处口径的差别写在 README §L4。
            degraded: { type: 'boolean', required: true }
          }
        },
        render(_args, value) {
          return [{ type: 'text', text: renderAdvance(value) }]
        }
      },
      async execute(args, exec) {
        const to = typeof args?.to === 'string' ? args.to : ''
        const reason = typeof args?.reason === 'string' ? args.reason : ''
        const enforcing = cfg.mode === 'enforce'

        const statePath = join(cfg.projectRoot, 'memory', 'state.yaml')
        const lockPath = join(cfg.projectRoot, 'memory', '.state.lock')

        // —— 纵深防御：重读状态，独立复算一遍 guard 的判定（不依赖入口 guard 已放行）。
        const state = await readState(statePath)
        const current = String(state.current_phase ?? '0.1')

        // ⓪ C3（spec §10.4）：回滚观察期冻结（与 guard 同构的纵深防御，不依赖入口 guard 已拦）。
        if (inObservation(state)) {
          throw new HarnessError(
            `回滚观察期内（回滚于 ${state.rollback_at}，24h 观察期未结束），禁止推进。` +
              `请等待观察期结束后再推进，届时确认是否重新部署。`,
            'ROLLBACK_OBSERVATION_ACTIVE'
          )
        }

        const want = nextPhase(current)
        if (want === undefined) {
          throw new HarnessError(`当前已是最后一个阶段（${current}），不能再推进。`, 'PHASE_NO_NEXT')
        }
        if (to !== want) {
          throw new HarnessError(
            `不允许跳跃推进：当前 ${current}，下一个合法阶段是 ${want}（你请求的是 ${to || '（空）'}）。` +
              ` 跳过阶段等于跳过门禁，属安全漏洞。`,
            'PHASE_JUMP_DENIED'
          )
        }

        // 本阶段配置的 deny 检查：拆成「已实现」与「未实现」。
        const checksConfigured = DENY_CHECKS[current] ?? []
        const checks = checksConfigured.filter((c) => IMPLEMENTED_CHECKS[c])
        const skipped = checksConfigured.filter((c) => !IMPLEMENTED_CHECKS[c])

        // 已实现的检查：本轮 D1 / D3（文件复合锚点）+ D2（gate 审计链锚点）。
        // 🔴 判定与入口 guard 共用 `runDenyChecks` —— 不在这里另写一份 for 循环体：
        // 施工单 §3② 指出"两边各写一遍"是本模块最容易漏的地方，漏了还会两边都不报错。
        // 🔴 L4（spec §8）：括号只算一次，判定与留痕共用同一份结论。
        //    这里与 `guard.evaluate` 是**同一条路**（都调 `remoteConjunctFor`），
        //    所以 guard 拦了而 execute 放行（或反之）在结构上不可能发生。
        const nowMs = Date.now()
        const remote = remoteConjunctFor(checks, cfg, nowMs)
        const degraded = !!(remote && remote.applicable && remote.status === 'degraded')
        const failures = runDenyChecks(checks, cfg, mirror, { now: nowMs, remote })
        for (const f of failures) {
          await audit
            .record({
              type: 'phase-advance-blocked',
              from: current,
              to,
              reason,
              check: f.check,
              detail: f.reason,
              currentSha: f.currentSha,
              currentLen: f.currentLen,
              enforcing,
              callId: exec?.callId,
              rootCallId: exec?.rootCallId
            })
            .catch(() => {})
        }
        if (failures.length > 0) {
          if (enforcing) {
            const tools = Array.from(new Set(failures.map((f) => TOOL_BY_CHECK[f.check] ?? `${f.check} 对应工具`)))
            throw new HarnessError(
              `阶段 ${current} 门禁未通过 —— ${failures.map((f) => `${f.check}：${f.reason}`).join('；')}。` +
                `请先跑 ${tools.join(' / ')} 并使其通过，再推进到 ${to}。`,
              `PHASE_${failures[0].check}_DENIED`
            )
          }
          // shadow：照常推进，但上面的审计已记「本会被拒」。
        }

        // 未实现的 deny 项（若将来又出现）由 pre-execute 审计监听器统一记录 check-skipped，
        // 此处不重复写，避免审计噪声。（v3 后 DENY_CHECKS 里各项均已实现，skipped 恒为空。）

        // —— D4 签字提醒（v3 §2/§3：D4 从 deny 降为 ask，放 execute 层走 approval.request）。
        // 只在「推进离开 Phase 10」时触发（current=10 ⇒ to=11）。ask 语义：确认即过、拒绝则不过、
        // 通道不可用/取消则降级放行 + 记审计（fail-open，与 deny 的 fail-closed 相反，见施工单 0089 §3.2）。
        let d4Approval = 'n/a'
        if (current === '10') {
          const d4 = await askApproval(ctx, exec, '推进到 Phase 11 Disengage 前，确认客户已验收（D4 提醒）')
          if (d4 === 'rejected') {
            await audit
              .record({
                type: 'phase-advance-d4-ask',
                from: current,
                to,
                outcome: 'rejected',
                reason,
                callId: exec?.callId,
                rootCallId: exec?.rootCallId
              })
              .catch(() => {})
            throw new HarnessError('用户未确认客户验收（D4）；如已确认请重新推进。', 'D4_REJECTED')
          }
          d4Approval = d4 === 'allowed-once' ? 'confirmed' : 'degraded'
          await audit
            .record({
              type: 'phase-advance-d4-ask',
              from: current,
              to,
              outcome: d4Approval,
              reason,
              callId: exec?.callId,
              rootCallId: exec?.rootCallId
            })
            .catch(() => {})
        }

        // —— D5-pre（v3 §10.3：Phase 2 数据接入前置检查，ask 级）。
        // 只在「推进离开 Phase 2」时触发（current=2 ⇒ to=3）。ask 语义与 D4 同向：确认即过、
        // 拒绝则不过、通道不可用/取消则降级放行（fail-open）。确认后把「授权依据 + 脱敏方案」
        // 写进 compliance.yaml 的 data_policy —— Phase 6 的 D5 会查它非空，降级放行（没写）会被 D5 卡住。
        let d5PreApproval = 'n/a'
        if (current === '2') {
          const auth = typeof args?.data_authorization === 'string' ? args.data_authorization.trim() : ''
          const deid = typeof args?.deidentification_plan === 'string' ? args.deidentification_plan.trim() : ''
          if (auth.length === 0 || deid.length === 0) {
            throw new HarnessError(
              'Phase 2 数据接入前置检查（D5-pre）：请同时提供 data_authorization（授权依据）与 deidentification_plan（脱敏方案），确认后写入 compliance.yaml。',
              'D5PRE_MISSING_FIELDS'
            )
          }
          const d5pre = await askApproval(
            ctx,
            exec,
            `Phase 2 数据接入前确认：已获得数据授权并制定脱敏方案。授权依据：${auth}；脱敏方案：${deid}`
          )
          if (d5pre === 'rejected') {
            await audit
              .record({
                type: 'phase-advance-d5pre-ask',
                from: current,
                to,
                outcome: 'rejected',
                reason,
                callId: exec?.callId,
                rootCallId: exec?.rootCallId
              })
              .catch(() => {})
            throw new HarnessError('用户未确认数据授权与脱敏方案（D5-pre）；如已确认请重新推进。', 'D5PRE_REJECTED')
          }
          d5PreApproval = d5pre === 'allowed-once' ? 'confirmed' : 'degraded'
          if (d5pre === 'allowed-once') {
            try {
              writeComplianceDataPolicy(cfg.ontologyRoot, { authorization: auth, deidentification: deid })
            } catch (e) {
              // 确认了但没落盘 ⇒ fail-closed：D5 后面会因 data_policy 空而不通过，这里直接让本次推进失败
              await audit
                .record({
                  type: 'phase-advance-d5pre-ask',
                  from: current,
                  to,
                  outcome: 'write-failed',
                  reason,
                  detail: String(e?.message ?? e),
                  callId: exec?.callId,
                  rootCallId: exec?.rootCallId
                })
                .catch(() => {})
              throw new HarnessError(`D5-pre 已确认，但写入 compliance.yaml 失败：${e?.message ?? e}`, 'D5PRE_WRITE_FAIL')
            }
          }
          await audit
            .record({
              type: 'phase-advance-d5pre-ask',
              from: current,
              to,
              outcome: d5PreApproval,
              reason,
              callId: exec?.callId,
              rootCallId: exec?.rootCallId
            })
            .catch(() => {})
        }

        // 原子写：锁内写前重读 + revision +1 + rename 覆盖（state.js 已实现）。
        const result = await writeState(
          statePath,
          lockPath,
          (cur) => ({
            ...cur,
            current_phase: to,
            phase_status: 'in_progress',
            ontology_version: cur.ontology_version ?? 1
          }),
          cfg.lockTtlMs,
          audit
        )

        // Stage 5.6（缺陷 A 修复）：D5 在非受监管行业（含'未声明'哨兵值）不适用。
        // 统一调 isRegulatedIndustry()，与 guard.js 同一份判定，避免两处各写一份漂移。
        const notApplicable = []
        if (!isRegulatedIndustry(cfg.industry) && checks.includes('D5')) {
          notApplicable.push('D5')
        }

        // 🔴 0071 缺陷 F 修复：算 passedChecks（实际跑过且通过）与 phaseChecks（本阶段配置的全部）
        //    - passedChecks = checks 减去 failures 减去 notApplicable
        //      V1: D5 不适用（notApplicable=["D5"]）且 failures=[] ⇒ passedChecks=[] —— 数据层显形"没跑"
        //      V4: D5 跑了且通过（failures=[]，notApplicable=[]）⇒ passedChecks=["D5"]
        //    - phaseChecks = checks ∪ skipped —— 本阶段配置的全部 deny 项，让回执读者不再被迫猜
        //    🔴 shadow 模式下 failures.length > 0 仍推进（不 throw），故必须显式减 failures
        const passedChecks = checks.filter(
          (c) => !failures.find((f) => f.check === c) && !notApplicable.includes(c)
        )
        const phaseChecks = checks.concat(skipped)

        // 记一笔实际推进（无论 shadow/enforce 都记——这是真实发生的状态变更）。
        await audit
          .record({
            type: 'phase-advance',
            from: current,
            to,
            reason,
            phaseChecks,
            checks,
            passedChecks,
            skipped,
            notApplicable,
            revision: result.revision,
            // 🔴 spec §8：「降级期间所有 deny 通过都带 degraded: true 标记」。
            //    ⚠️ 只在**真的适用且真的降级**时为 true；`remote` 为 null（没跑 D2）时是 false，
            //    那是"这条括号与本次无关"，不是"没降级" —— 两者靠字段在不在区分：
            //    不适用 ⇒ `remote: null`；适用 ⇒ `remote: {status, reason}`。
            degraded,
            remote,
            // C3（spec §10.4 第 1 条）：每次 D5 部署审批（推进到 Phase 6）时，同步记录"允许回滚至版本 X"。
            // target_version = 部署前的 revision（result.revision - 1）。PoC 无 ontology 快照，
            // 用 state revision 标识"上一个状态版本"，回滚不做真实内容恢复（见 README 诚实清单）。
            ...(to === '6'
              ? { rollback_preauth: { authorized: true, target_version: 'rev-' + (result.revision - 1) } }
              : {}),
            callId: exec?.callId,
            rootCallId: exec?.rootCallId
          })
          .catch(() => {})

        // —— 阶段是全局的，限制是**每 agent** 的 ——
        // 状态一旦落盘，必须对所有**存活** agent 重算工具面：只靠 `agent/session-start`
        // 会漏掉"推进之前就已经开着"的会话（第二批施工单 §2.1，也是判据 5 唯一考察的东西）。
        // 这一行是 restrict **热生效**的落点：模型每步请求都重算清单（施工单 §0.3），
        // 所以已有会话的**下一次请求**就不再看到名单里的工具 —— 不需要新开会话、不需要重启。
        if (governor) {
          try {
            // 🔴 第三批：`trigger` 必须显式传 —— 这条路的触发源是"阶段刚变"，
            //    与 `installRestrict` 里的装载后全量对账（full-reconcile）不是一回事。
            await governor.reconcile(to, 'phase-changed')
          } catch (e) {
            // 对账失败不影响本次已完成的推进（内部已按 agent 逐个兜底并落 restrict-error 审计）。
            // 🔴 第三批：但"吞掉"必须留痕 —— 否则离线看链时分不清"没对账"还是"对账了、但整批抛错"。
            await governor.noteDegraded('advance-reconcile', e, 'phase-changed')
          }
        }

        return {
          from: current,
          to,
          revision: result.revision,
          phaseChecks,
          checks,
          passedChecks,
          skipped,
          notApplicable,
          d4Approval,
          d5PreApproval,
          // 结果里也带上：模型/回执读者要能看见"这次是通过了，但依据是降级模式"。
          degraded
        }
      }
    })
  )

  return () => {
    dispose()
  }
}

/** 把 D2 结果压成一段人话（也是工具回执正文）。 */
function renderAuditCheck(r) {
  const head = `D2 审计链完整性：${r.passed ? '通过' : '不通过'}`
  const lines = [head, `  gate 链：${r.lineCount} 行，链头 ${r.headHash || '（无）'}`, `  失败项：${r.failures.length} 条`]
  for (const f of r.failures) {
    lines.push(`  · 第 ${f.line} 行 [${f.code}] ${f.message}`)
  }
  return lines.join('\n')
}

/**
 * 注册 `fde-run-audit-check`（D2）。
 *
 * 与 D1 / D3 **完全同构**：工具里跑重活（gate 链可能很大，这里是全量读 + 逐条接续校验），
 * 把 `(行数, 链头 hash)` 当锚点广播出去；`guard` 那一侧只同步比这两个标量。
 * guard 是同步的，不能在推进那一刻去读整条链 —— 这个分工是刻意的。
 *
 * ⚠️ 结论**必然随链的生长而过期**：从这里跑完到你去推进，中间只要有任何一条新记录写进
 * `gate.jsonl`，行数就变了 ⇒ D2 过期 ⇒ 必须重跑。**这是设计意图，不是 bug**
 * （D2 要证明的是"在推进这一刻，链是完整的"），README §D2 里写清了。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化配置（用 `gateAuditPath`）
 * @returns {() => void} 注销器
 */
export function installAuditCheckTool(ctx, cfg) {
  return ctx.tools.register(
    defineTool({
      name: AUDIT_CHECK_TOOL,
      description:
        '跑 D2 校验：全量检查 gate 审计链的完整性（逐条 prevHash 接续、seq 递增、无坏行），' +
        '通过后把"行数 + 链头 hash"作为锚点广播给阶段机插件。' +
        '注意：gate 链此后哪怕只多一条记录，本结论就过期 —— 那时请本工具重跑一次。',
      parameters: {
        reason: {
          type: 'string',
          required: true,
          description: '本次跑 D2 校验的业务理由（写入回执，便于追溯）'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            passed: { type: 'boolean', required: true },
            lineCount: { type: 'number', required: true },
            headHash: { type: 'string', required: true },
            failure_count: { type: 'number', required: true },
            failures: { type: 'array', required: true },
            reason: { type: 'string', required: true }
          }
        },
        render(_args, value) {
          return [{ type: 'text', text: renderAuditCheck(value) }]
        }
      },
      async execute(args, exec) {
        const chainPath = cfg.gateAuditPath
        const r = await runD2Check(chainPath)

        // 广播结论给本插件自己的镜像（index.js 的监听器同时会写审计）。
        // ⚠️ 与 D1 同口径：广播失败不得让校验本身失败，只记 warn。
        try {
          ctx.emit('fde/check-result', {
            check: 'D2',
            passed: r.passed,
            anchor: {
              alg: D2_ANCHOR_ALG,
              files: [chainPath],
              len: r.lineCount,
              sha256: r.headHash
            },
            detail: r.reason,
            at: new Date().toISOString(),
            callId: exec?.callId
          })
        } catch (e) {
          ctx.logger?.warn?.(`[${AUDIT_CHECK_TOOL}] 广播 fde/check-result 失败（已忽略）：${e?.message ?? e}`)
        }

        const result = {
          passed: r.passed,
          lineCount: r.lineCount,
          headHash: r.headHash,
          failure_count: r.failures.length,
          failures: r.failures,
          reason: r.reason
        }

        if (!r.passed && cfg.mode === 'enforce') {
          throw new Error(renderAuditCheck(result))
        }
        return result
      }
    })
  )
}


/** D5 工具名：跑 compliance.yaml 的存在性 + 非空检查，广播结论供 guard 比对。 */
export const COMPLIANCE_CHECK_TOOL = 'fde-run-compliance-check'

/** 把 D5 结果压成一段人话。 */
function renderComplianceCheck(r) {
  const head = 'D5 合规边界检查：' + (r.passed ? '通过' : '不通过')
  const lines = [head, '  compliance.yaml：' + r.keyCount + ' 个顶层键，其中 ' + r.nonemptyCount + ' 个非空']
  if (r.failures && r.failures.length > 0) {
    lines.push('  失败项：' + r.failures.length + ' 条')
    for (const f of r.failures) {
      lines.push('  · [' + f.code + '] ' + (f.key ? f.key + ': ' : '') + f.message)
    }
  }
  if (r.notApplicable) {
    lines.push('  注：industry = 未声明 ⇒ 通过存在性检查后以 notApplicable 留痕（不判定内容）')
  }
  return lines.join('\n')
}

/**
 * 注册 `fde-run-compliance-check`（D5）。
 *
 * 与 D2 同构：工具里跑重活（读 compliance.yaml 全文 + 解析），把
 * `(sha256, 行数, 非空键数)` 当锚点广播出去；guard 那一侧只同步比这三个标量。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化配置（用 `ontologyRoot` + `industry`）
 * @returns {() => void} 注销器
 */
export function installComplianceCheckTool(ctx, cfg) {
  return ctx.tools.register(
    defineTool({
      name: COMPLIANCE_CHECK_TOOL,
      description:
        '跑 D5 校验：检查 ontologyRoot/compliance.yaml 是否存在且 4 个顶层键' +
        '（output_boundary / review_chain / data_policy / change_assessment）齐全且非空。' +
        '通过后把锚点广播给阶段机插件。注意：只做存在性检查，不按 industry 判定内容。',
      parameters: {
        reason: {
          type: 'string',
          required: true,
          description: '本次跑 D5 校验的业务理由（写入回执，便于追溯）'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            passed: { type: 'boolean', required: true },
            keyCount: { type: 'number', required: true },
            nonemptyCount: { type: 'number', required: true },
            notApplicable: { type: 'boolean', required: true },
            failures: { type: 'array', required: true },
            reason: { type: 'string', required: true }
          }
        },
        render(_args, value) {
          return [{ type: 'text', text: renderComplianceCheck(value) }]
        }
      },
      async execute(args, exec) {
        const path = join(cfg.ontologyRoot, 'compliance.yaml')
        const r = await runD5Check(path)
        const notApplicable = !isRegulatedIndustry(cfg.industry)

        try {
          ctx.emit('fde/check-result', {
            check: 'D5',
            passed: r.passed,
            anchor: {
              alg: D5_ANCHOR_ALG,
              files: [path],
              sha256: r.sha256,
              len: r.lineCount,
              nonempty: r.nonemptyCount
            },
            detail: r.reason,
            notApplicable,
            at: new Date().toISOString(),
            callId: exec?.callId
          })
        } catch (e) {
          ctx.logger?.warn?.('[' + COMPLIANCE_CHECK_TOOL + '] 广播 fde/check-result 失败（已忽略）：' + (e?.message ?? e))
        }

        const result = {
          passed: r.passed,
          keyCount: r.keyCount,
          nonemptyCount: r.nonemptyCount,
          notApplicable,
          failures: r.failures,
          reason: r.reason
        }

        if (!r.passed && cfg.mode === 'enforce') {
          throw new Error(renderComplianceCheck(result))
        }
        return result
      }
    })
  )
}


/** fde_rollback 工具名：回滚走独立通道，使用 D5 部署审批签发的回滚预授权，不重审 D5。 */
export const ROLLBACK_TOOL = 'fde_rollback'

/**
 * 读 compliance.yaml 的 rollback_preauth，返回预授权状态。
 *
 * 与 verifyComplianceText 里的 rollback_preauth 判据同源（authorized === true），
 * 但这里只取"是否已授权"，不报其余 4 键的问题 —— fde_rollback 不重审 D5 整体，
 * 只验证"有没有签发回滚预授权"这一件事（spec §10.4 第 2 条：直接使用预授权，不重审）。
 *
 * @param {string} ontologyRoot
 * @returns {Promise<{authorized: boolean, error?: string}>}
 */
async function readRollbackPreauth(ontologyRoot) {
  const path = join(ontologyRoot, 'compliance.yaml')
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    return { authorized: false, error: 'compliance.yaml 不存在：' + String(e?.message ?? e) }
  }
  const parsed = parseComplianceYaml(text)
  if (!parsed.ok) return { authorized: false, error: 'compliance.yaml 解析失败：' + parsed.error }
  const rp = parsed.obj.rollback_preauth
  if (typeof rp !== 'object' || rp === null || rp.authorized !== true) {
    return { authorized: false, error: 'rollback_preauth.authorized 非 true（部署审批未签发回滚预授权）' }
  }
  return { authorized: true }
}

/** 把回滚结果压成一段人话。 */
function renderRollback(r) {
  return (
    `回滚已执行：目标 ${r.rolled_back_to}（预授权 ${r.preauthorized ? '有效' : '无效'}）\n` +
    `  观察期：${r.observation_hours}h（自 ${r.observation_started} 起），期间禁止推进\n` +
    `  注：PoC 无 ontology 快照，回滚不恢复真实内容（见 README 诚实清单）`
  )
}

/**
 * 注册 `fde_rollback`（C3，spec §10.4）。
 *
 * 独立通道：验证 D5 部署审批签发的 rollback_preauth（authorized === true）后直接回滚，
 * **不重跑 D5 的 5 键检查**（否则紧急回滚会被"任何改动都要合规评估"卡死，正是 spec 要避免的治理笑话）。
 * 回滚后进入 24h 观察期（state.rollback_at），期间禁止推进（guard/evaluate 与 fde_phase_advance 双向冻结）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化配置（用 ontologyRoot + projectRoot + lockTtlMs）
 * @param {import('./audit.js').AuditChain} audit
 * @returns {() => void} 注销器
 */
export function installRollbackTool(ctx, cfg, audit) {
  return ctx.tools.register(
    defineTool({
      name: ROLLBACK_TOOL,
      description:
        '紧急回滚。部署出问题后走独立通道回滚到部署前版本，' +
        '使用 D5 部署审批时签发的回滚预授权（不重审 D5）。' +
        '回滚后进入 24h 观察期，期间禁止推进。' +
        '注：PoC 无 ontology 快照，回滚不恢复真实内容，只记录回滚意图并进入观察期。',
      parameters: {
        reason: {
          type: 'string',
          required: true,
          description: '回滚的业务理由（写入审计）'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            preauthorized: { type: 'boolean', required: true },
            rolled_back_to: { type: 'string', required: true },
            observation_started: { type: 'string', required: true },
            observation_hours: { type: 'number', required: true }
          }
        },
        render(_args, value) {
          return [{ type: 'text', text: renderRollback(value) }]
        }
      },
      async execute(args, exec) {
        const reason = typeof args?.reason === 'string' ? args.reason : ''
        const statePath = join(cfg.projectRoot, 'memory', 'state.yaml')
        const lockPath = join(cfg.projectRoot, 'memory', '.state.lock')

        // ① 验证回滚预授权（spec §10.4 第 2 条：回滚走独立通道，直接使用预授权，不重审 D5）。
        const preauth = await readRollbackPreauth(cfg.ontologyRoot)
        if (!preauth.authorized) {
          await audit
            .record({
              type: 'rollback-denied',
              outcome: 'no-preauth',
              reason,
              detail: preauth.error,
              callId: exec?.callId,
              rootCallId: exec?.rootCallId
            })
            .catch(() => {})
          throw new HarnessError(
            '回滚预授权缺失：' + preauth.error + '（需先通过 D5 部署审批，签发 rollback_preauth）',
            'ROLLBACK_NO_PREAUTH'
          )
        }

        // ② 观察期检查：已在观察期 ⇒ 不能重复回滚。
        const state = await readState(statePath)
        if (inObservation(state)) {
          await audit
            .record({
              type: 'rollback-denied',
              outcome: 'already-observing',
              reason,
              detail: '回滚于 ' + state.rollback_at + '，观察期未结束',
              callId: exec?.callId,
              rootCallId: exec?.rootCallId
            })
            .catch(() => {})
          throw new HarnessError(
            '已处于回滚观察期内（回滚于 ' + state.rollback_at + '），不能重复回滚。',
            'ROLLBACK_ALREADY_OBSERVING'
          )
        }

        // ③ 进入观察期（state.rollback_at = now）。"版本 X"以回滚动作前的 revision 标识，
        //    PoC 无 ontology 快照，回滚不恢复真实内容（诚实降级，见 README）。
        const rolledBackTo = 'rev-' + (state.revision ?? 0)
        const result = await writeState(
          statePath,
          lockPath,
          (cur) => ({ ...cur, rollback_at: new Date().toISOString() }),
          cfg.lockTtlMs,
          audit
        )

        // ④ 记回滚审计（spec §10.4 第 3 条：回滚事件写入审计）。
        await audit
          .record({
            type: 'rollback',
            reason,
            rolled_back_to: rolledBackTo,
            preauthorized: true,
            observation_started: result.rollback_at,
            observation_hours: 24,
            note: 'PoC 无 ontology 快照，回滚不恢复真实内容（见 README 诚实清单）',
            callId: exec?.callId,
            rootCallId: exec?.rootCallId
          })
          .catch(() => {})

        return {
          preauthorized: true,
          rolled_back_to: rolledBackTo,
          observation_started: result.rollback_at,
          observation_hours: 24
        }
      }
    })
  )
}

/** C2 的工具名：按级别闭环一次 ontology 变更（spec §4 的 L0/L1/L2 各自流程）。 */
export const CHANGE_CLOSE_TOOL = 'fde_change_close'

/** 渲染 change_close 回执（不回显 ontology 内容，同本项目红线）。 */
function renderChangeClose(value) {
  const checks = (value.checks ?? []).map((c) => `${c}✓`).join(' ')
  const approval = value.approval === 'confirmed' ? '，外部审批人已确认' : ''
  return (
    `${value.level} 变更闭环已记录：${value.target}（变更 seq=${value.change_seq}）\n` +
    `必需检查：${checks}${approval}`
  )
}

/**
 * 注册 `fde_change_close` —— C2 的入口。
 *
 * ## 级别从哪来（关键设计，别改成"调用方传参"）
 *
 * 级别读 **gate 审计链**里最近一条 `decision==='allow'` 的 `fde_ontology_write` 记录，
 * **不由模型指定**。理由：级别是自动判定的（spec §4「插件自动判，FDE 只能升级不能降级」），
 * 而三级的必需检查数不同（L0 只 D3、L2 要 D1+D3+D5）—— 让模型自报级别，报 L0 就少跑三项，
 * 门禁等于敞开。审计链是哈希链，链上的 `level` 改不动。
 *
 * ## 三态语义（与 D4 ask 相反，别照抄）
 *
 * L2 的"外部审批人确认"是 spec §4 的**硬要求**，故 **fail-closed**：`unavailable`
 * （无 answerer）与 `cancelled` 一律拒绝闭环。这与 D4 ask 的"unavailable 放行"相反 ——
 * 与 `fde_memory_confirm`（同样 fail-closed）同一取向。见 `approval.js` 的说明。
 *
 * ## 诚实边界（README 同步记录）
 *
 * - spec L1 的「标记下游」与「自动回原 Phase」本模块**不实现**：前者缺"受影响下游清单"
 *   概念；后者与本项目 Phase 状态机不变量（`current → next(+1)` 不许回退）冲突 ——
 *   回退会给"退回 Phase 3 重跑 D1"开门。故本工具只做**闭环判定**，不动 `current_phase`。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化的配置
 * @param {import('./audit.js').AuditChain} audit
 * @param {import('./mirror.js').D1Mirror} mirror - D1/D3/D5 结论镜像（与 guard 同一个）
 * @returns {() => void} 注销器
 */
export function installChangeCloseTool(ctx, cfg, audit, mirror) {
  return ctx.tools.register(
    defineTool({
      name: CHANGE_CLOSE_TOOL,
      description:
        '闭环一次 ontology 变更（C2）。变更级别由门禁自动判定（读 gate 审计链），不由调用方指定。' +
        '按级别核验必需检查：L0 需 D3；L1 需 D1+D3；L2 需 D1+D3+D5 且需外部审批人确认。' +
        '检查未跑过、未通过、或结论锚点与当前 ontology 内容不一致时一律拒绝，并指出该重跑哪个工具。',
      parameters: {
        reason: {
          type: 'string',
          required: true,
          description: '本次变更的业务理由（写入审计）'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            level: { type: 'string', required: true },
            target: { type: 'string', required: true },
            change_seq: { type: 'number', required: true },
            checks: { type: 'array', required: true },
            approval: { type: 'string', required: true }
          }
        },
        render(_args, value) {
          return [{ type: 'text', text: renderChangeClose(value) }]
        }
      },
      async execute(args, exec) {
        const reason = typeof args?.reason === 'string' ? args.reason : ''
        const auditTail = { reason, callId: exec?.callId, rootCallId: exec?.rootCallId }

        // ① 从 gate 审计链取级别（权威、不可伪造）。
        const latest = readLatestChange(cfg.gateAuditPath)
        if (!latest.ok) {
          const MAP = {
            'no-change': [
              'CHANGE_NONE',
              '未找到已落盘的 ontology 变更（gate 审计链里没有 decision=allow 的 fde_ontology_write 记录）⇒ 无需闭环。'
            ],
            'no-level': [
              'CHANGE_NO_LEVEL',
              '最近一次变更的记录里没有级别信息：' +
                String(latest.detail ?? '') +
                '。该记录早于变更分级（C1）落地，本插件不猜级别。'
            ],
            unreadable: [
              'CHANGE_CHAIN_UNREADABLE',
              'gate 审计链不可读：' + String(latest.detail ?? '')
            ]
          }
          const [code, message] = MAP[latest.reason] ?? [
            'CHANGE_STATE_UNKNOWN',
            '变更状态未知：' + String(latest.reason)
          ]
          await audit
            .record({ type: 'change-close-denied', outcome: latest.reason, ...auditTail })
            .catch(() => {})
          throw new HarnessError(message, code)
        }

        const level = latest.level

        // ② 按级别核验必需检查（复用 guard 同款同步锚点比对）。
        const results = verifyRequiredChecks(level, mirror, cfg)
        const bad = results.filter((r) => !r.ok)
        if (bad.length > 0) {
          await audit
            .record({
              type: 'change-close-denied',
              outcome: 'checks-incomplete',
              level,
              target: latest.target,
              change_seq: latest.seq,
              failed: bad.map((r) => r.check),
              ...auditTail
            })
            .catch(() => {})
          throw new HarnessError(describeIncomplete(level, results), 'CHANGE_FLOW_INCOMPLETE')
        }

        // ③ L2：外部审批人确认（fail-closed —— 与 D4 ask 的三态相反）。
        let approval = 'n/a'
        if (NEEDS_APPROVAL[level]) {
          const outcome = await askApproval(
            ctx,
            exec,
            `L2 受监管变更闭环需外部审批人确认：${latest.target}（变更 seq=${latest.seq}；D5 合规边界已核过）`
          )
          if (outcome !== 'allowed-once') {
            await audit
              .record({
                type: 'change-close-denied',
                outcome: 'approval-' + outcome,
                level,
                target: latest.target,
                change_seq: latest.seq,
                ...auditTail
              })
              .catch(() => {})
            throw new HarnessError(
              `L2 变更闭环需要外部审批人确认，approval 结果为 ${outcome}` +
                '（fail-closed：未确认不予闭环）。',
              'CHANGE_APPROVAL_REQUIRED'
            )
          }
          approval = 'confirmed'
        }

        // ④ 记录闭环（这是"级别被消费"的证据 —— C1 判出的级别到此才不再死数据）。
        const checkNames = results.map((r) => r.check)
        await audit
          .record({
            type: 'change-closed',
            level,
            target: latest.target,
            change_seq: latest.seq,
            change_ts: latest.ts,
            required: REQUIRED_CHECKS[level] ?? [],
            checks: checkNames,
            approval,
            ...auditTail
          })
          .catch(() => {})

        return {
          level,
          target: String(latest.target ?? ''),
          change_seq: Number(latest.seq) || 0,
          checks: checkNames,
          approval
        }
      }
    })
  )
}
