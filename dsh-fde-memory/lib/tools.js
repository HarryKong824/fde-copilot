/**
 * tools.js —— A5 分层注入 + 工具面（0086 §4）。
 *
 * 三个工具（下划线族，与 gate/phase 的写入类工具同族；`grep fde_memory` 零冲突）：
 *   fde_memory_context        —— 只读，六层分层注入（spec 第九节）
 *   fde_memory_write_decision —— 写决策（走 decisions.js，confidence 调用方不可写）
 *   fde_memory_review         —— 复核 note（走 notes.js，更新 reviewed_at）
 *
 * 0086 §4.1.1：层名前缀用 ASCII（不用 ①②③）—— 套件要稳定 grep 层名，全角数字
 *   在不同代码页下会变形；中文说明留给模型读。层名定成 LAYER 常量，不散在模板里。
 *
 * 0086 §4.1.2：[L5] 是「内容视角」、[L6] 是「待办视角」，不冗余。
 *   [L5] 按 date 倒序最多 10 条，段尾带「共 N 条，其中过期 E 条」计数（截断要看得出来）。
 *   [L6] 判据 = isExpired 为真 且 reviewed_at 为空；按 expires_at 升序最多 20 条；
 *        只给 文件名 + date + 过期天数，不给正文。
 *
 * 红线（同 dsl「不回显 ontology 内容」）：输出**不回显** state.yaml 全文。
 * 升级路径（0086 §4.4）：跨 Phase 自动降档 / session-start 提醒**本单不做**（README 诚实清单）。
 *
 * 🔴 桩 SDK 兼容（0086 §4.2 拍定 1，照抄 dsh-fde-phase/lib/tools.js:27-28）：
 *   工作区根 `node_modules/@deepseek-ai/dsh-tools` 桩没有 HarnessError ⇒ 具名 import
 *   会在离线环境直接崩。用 namespace import + `?? Error` 兜底，别自己发明类。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as dshTools from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { parseYamlSubset } from './yamlsubset.js'
import { assertPhaseId, listDecisions, writeDecision } from './decisions.js'
import { readChecklist } from './checklist.js'
import { readStakeholders, summarize } from './stakeholders.js'
import { readRecentChanges } from './change-log.js'
import { listNotes, annotateForInjection, isExpired, reviewNote, assertNoteFile } from './notes.js'
import { askApproval } from './approval.js'
import {
  EXPERIMENTS_SUBDIR,
  listExperiments,
  readExperiment,
  writeExperiment
} from './experiments.js'

// HarnessError 的正确来源是 @deepseek-ai/dsh-llm（dsh-tools 不 re-export，见 phase/tools.js 同修）。
const { defineTool } = dshTools

export const CONTEXT_TOOL = 'fde_memory_context'
export const WRITE_DECISION_TOOL = 'fde_memory_write_decision'
export const REVIEW_TOOL = 'fde_memory_review'
/** B1/B2：经 approval 逐条确认产生 source=fde_confirmed 的决策（R2 不可逆层唯一入口）。 */
export const CONFIRM_TOOL = 'fde_memory_confirm'
/** E2（spec §7）：探索沙箱的三个入口。沙箱 = 保护根内豁免的子树，见 experiments.js。 */
export const EXPERIMENT_WRITE_TOOL = 'fde_experiment_write'
export const EXPERIMENT_READ_TOOL = 'fde_experiment_read'
export const EXPERIMENT_LIST_TOOL = 'fde_experiment_list'

// 0086 §4.1.1：层名前缀定成常量（ASCII，别散在模板里）
const LAYER = {
  L1: '[L1] 本 Phase checklist',
  L2: '[L2] 本 Phase decisions',
  L3: '[L3] stakeholders 摘要',
  L4: '[L4] 最近变更',
  L5: '[L5] notes',
  L6: '[L6] 过期未复核队列'
}

const NOTES_LIMIT = 10 // 0086 §4.1.2 [L5] 封顶
const QUEUE_LIMIT = 20 // 0086 §4.1.2 [L6] 封顶
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 读 state.yaml 的 current_phase（phase 插件财产，本插件只读）。
 * 读失败 ⇒ null（fail-open 于"读不到 phase"，但 [L1]/[L2] 会显形"未提供 phase"，不静默）。
 * @param {string} projectRoot
 * @returns {string | null}
 */
export function readCurrentPhase(projectRoot) {
  const p = join(projectRoot, 'memory', 'state.yaml')
  if (!existsSync(p)) return null
  try {
    const text = readFileSync(p, 'utf8')
    if (text.trim().length === 0) return null
    const obj = parseYamlSubset(text, p)
    const cp = obj && obj.current_phase
    if (cp === undefined || cp === null) return null
    return typeof cp === 'string' ? cp : String(cp)
  } catch {
    return null
  }
}

/** listNotes 的 item 转 annotateForInjection/isExpired 要的 note 形态（body 字段名是 _body）。 */
function noteShape(item) {
  return { body: item._body, date: item.date, expires_at: item.expires_at }
}

/** 判"过期未复核"：isExpired 为真 且 reviewed_at 为空（null/undefined/''）。 */
function isExpiredUnreviewed(item, now) {
  let expired = false
  try {
    expired = isExpired(noteShape(item), now)
  } catch {
    expired = false // 非法 expires_at 已在 readNote 阶段挡掉；此处防御性兜底
  }
  const reviewed = item.reviewed_at
  const unreviewed = reviewed === null || reviewed === undefined || reviewed === ''
  return expired && unreviewed
}

/** 过期天数 = floor((now - expires_at) / 1天)。进入队列者必已过期，故 >= 0。 */
function expiredDays(item, now) {
  const expMs = new Date(item.expires_at).getTime()
  if (Number.isNaN(expMs)) return 0
  return Math.floor((now.getTime() - expMs) / DAY_MS)
}

/**
 * 组装六层分层文本（纯函数，零 IO 之外的副作用 —— 读文件是唯一 IO，供离线断言）。
 * @param {object} cfg - 规范化配置（含 projectRoot / injectChangeLogLimit）
 * @param {string | null} phase - phase id；null 时 [L1]/[L2] 显形为空
 * @param {Date} now - 注入时钟（测试可注）
 * @returns {string} 六层文本
 */
export function buildContext(cfg, phase, now) {
  const root = cfg.projectRoot
  const changeLogLimit = cfg.injectChangeLogLimit ?? 5
  const lines = []

  // ── [L1] 本 Phase checklist ──
  lines.push(LAYER.L1)
  if (phase === null) {
    lines.push('（未提供 phase，本层为空）')
  } else {
    const cl = readChecklist(root, phase)
    if (!cl || !Array.isArray(cl.items) || cl.items.length === 0) {
      lines.push('（无）')
    } else {
      for (const it of cl.items) {
        lines.push(`  - [${it.done ? 'x' : ' '}] ${it.text}${it.evidence ? `（${it.evidence}）` : ''}`)
      }
      lines.push(`  （共 ${cl.items.length} 条）`)
    }
  }
  lines.push('')

  // ── [L2] 本 Phase decisions ──
  lines.push(LAYER.L2)
  if (phase === null) {
    lines.push('（未提供 phase，本层为空）')
  } else {
    const dl = listDecisions(root, phase)
    if (dl.items.length === 0) {
      lines.push('（无）')
    } else {
      for (const d of dl.items) {
        lines.push(`  - [seq ${d._seq}] ${d.decision}（${d.confidence}）`)
      }
      lines.push(`  （共 ${dl.items.length} 条）`)
    }
    if (dl.bad.length > 0) {
      lines.push(`  ⚠️ ${dl.bad.length} 条坏记录：${dl.bad.map((b) => b.file).join(', ')}`)
    }
  }
  lines.push('')

  // ── [L3] stakeholders 摘要（4 字段，非全文）──
  lines.push(LAYER.L3)
  const st = summarize(readStakeholders(root))
  if (st.length === 0) {
    lines.push('（无）')
  } else {
    for (const s of st) {
      lines.push(`  - ${s.name}（${s.role} @ ${s.org}，影响力 ${s.influence}）`)
    }
    lines.push(`  （共 ${st.length} 人）`)
  }
  lines.push('')

  // ── [L4] 最近 change_log（limit 用 cfg.injectChangeLogLimit，非硬编码）──
  lines.push(LAYER.L4)
  const clr = readRecentChanges(root, changeLogLimit)
  if (clr.items.length === 0) {
    lines.push('（无）')
  } else {
    for (const c of clr.items) {
      const ts = typeof c.at === 'string' ? c.at.slice(0, 19) : ''
      lines.push(`  - ${ts} [${c.kind}] ${c.target}: ${c.summary}`)
    }
    lines.push(`  （共 ${clr.items.length} 条）`)
  }
  if (clr.bad.length > 0) {
    lines.push(`  ⚠️ ${clr.bad.length} 条坏记录（第 ${clr.bad.map((b) => b.line).join(', ')} 行）`)
  }
  lines.push('')

  // ── [L5] notes（date 倒序最多 10 条，过期降级接进来）──
  lines.push(LAYER.L5)
  const nl = listNotes(root)
  const sorted = [...nl.items].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
  const top = sorted.slice(0, NOTES_LIMIT)
  if (sorted.length === 0) {
    lines.push('（无）')
  } else {
    // 「其中过期」= isExpired 为真（不含"未复核"口径；未复核视角在 [L6]）
    const expiredCount = top.filter((it) => {
      try { return isExpired(noteShape(it), now) } catch { return false }
    }).length
    const cap = sorted.length > NOTES_LIMIT ? `，共 ${sorted.length} 条，列出最近 ${NOTES_LIMIT} 条` : ''
    lines.push(`  （${top.length} 条，其中过期 ${expiredCount} 条${cap}）`)
    for (const it of top) {
      const { text } = annotateForInjection(noteShape(it), now)
      lines.push(`  - [${it.date}] ${text}`)
    }
  }
  if (nl.bad.length > 0) {
    lines.push(`  ⚠️ ${nl.bad.length} 条坏记录：${nl.bad.map((b) => b.file).join(', ')}`)
  }
  lines.push('')

  // ── [L6] 过期未复核队列（expires_at 升序最多 20 条，只给文件名+date+过期天数）──
  lines.push(LAYER.L6)
  const queue = nl.items.filter((it) => isExpiredUnreviewed(it, now))
  queue.sort((a, b) => String(a.expires_at ?? '').localeCompare(String(b.expires_at ?? '')))
  if (queue.length === 0) {
    lines.push('（无）')
  } else {
    const shown = queue.slice(0, QUEUE_LIMIT)
    lines.push(`  （共 ${queue.length} 条，列出前 ${shown.length} 条）`)
    for (const it of shown) {
      lines.push(`  - ${it._file}（${it.date}，过期 ${expiredDays(it, now)} 天）`)
    }
  }

  return lines.join('\n')
}

/**
 * 注册 memory 工具（B1/B2 后共四个：context / write_decision / confirm / review）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化配置（含 projectRoot / injectChangeLogLimit）
 * @param {import('./audit.js').AuditChain} [audit] - B1/B2 记审计用（source 污染拒绝 + confirm 三态）；
 *        缺失时跳过审计（不影响工具本身），供离线夹具不传 audit 也能跑
 * @param {{active: boolean, error: string, from?: number}} [readOnly]
 *        E3 降只读标志（SCHEMA_VERSION 迁移失败时由 `apply()` 传入）。
 *        🔴 **只拦写工具**：`fde_memory_context`（读）不受影响 —— spec 第七节原文
 *        「迁移失败 = 写入 fail-closed，**读取降级为只读模式**（数据不扣人质）」。
 *        旧实现在迁移失败时直接 `throw` 让整个插件不加载，**连读都没了** —— 那正是 spec 要避免的。
 * @returns {() => void} 注销器
 */
export function installMemoryTools(ctx, cfg, audit, readOnly) {
  const disposers = []

  /**
   * 降只读守卫：写工具在执行任何动作**之前**调用。
   *
   * 为什么放在每个写工具的开头而不是统一包一层：这是**每个写工具的第一行**，
   * 读者扫一眼就能看到"这个工具受只读模式约束"，不必去别处找包装器。
   *
   * @param {string} what - 人话的动作名（用于错误文案）
   */
  function assertWritable(what) {
    if (!readOnly?.active) return
    throw new HarnessError(
      `记忆系统处于**只读模式**（SCHEMA_VERSION 迁移失败：${String(readOnly.error)}）⇒ ${what} 被拒绝。` +
        `读取不受影响：可用 ${CONTEXT_TOOL} 查看既有记忆（数据不扣人质）。` +
        `修法：把 <projectRoot>/SCHEMA_VERSION 改回本插件支持的版本，或升级本插件。`,
      'MEMORY_SCHEMA_READ_ONLY'
    )
  }

  // ── fde_memory_context（只读）──
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: CONTEXT_TOOL,
        description:
          '读取分层记忆上下文（只读）。按六层组织：本 Phase checklist、本 Phase decisions、' +
          'stakeholders 摘要、最近变更、notes（过期已降级标注）、过期未复核队列。' +
          '不传 phase 时缺省取 state.yaml 的 current_phase。只回显记忆内容，不回显 state.yaml 全文。',
        parameters: {
          phase: {
            type: 'string',
            description: '要读取的 phase id（数字或 数字.数字，如 "3" / "0.1"）。缺省取 state.yaml 的 current_phase'
          }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true }
            }
          },
          render(_args, value) {
            return [{ type: 'text', text: value.text }]
          }
        },
        async execute(args, exec) {
          const projectRoot = cfg.projectRoot
          let phase = typeof args?.phase === 'string' && args.phase.length > 0 ? args.phase : null
          if (phase !== null) {
            try {
              assertPhaseId(phase)
            } catch (e) {
              throw new HarnessError(e?.message ?? String(e), 'MEMORY_BAD_PHASE')
            }
          } else {
            phase = readCurrentPhase(projectRoot)
          }
          return { text: buildContext(cfg, phase, new Date()) }
        }
      })
    )
  )

  // ── fde_memory_write_decision ──
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: WRITE_DECISION_TOOL,
        description:
          '写一条决策到记忆系统。confidence 由写入器按来源与事实推导（调用方传了也忽略并覆盖），' +
          'expires_at 同理（notes 才有，decision 无）。回执只给 { file, seq, confidence }，不回显 decision 全文。',
        parameters: {
          phase: { type: 'string', required: true, description: '决策所属的 phase id（数字或 数字.数字，如 "3" / "0.1"）' },
          question: { type: 'string', description: '这条决策要回答的问题（写入 decision 文件，便于追溯）' },
          decision: { type: 'string', required: true, description: '决策内容（必填）' },
          rationale: { type: 'string', description: '决策理由（写入 decision 文件）' },
          source: { type: 'string', required: true, description: '证据来源：plugin_inferred | client_stated（须附 provenance）。fde_confirmed 只能经 fde_memory_confirm 产生，本工具不接受' },
          provenance: { type: 'string', description: '来源出处（source=client_stated 时必填）：文档路径 / session ID / 对话引用' },
          facts: {
            type: 'object',
            additionalProperties: true,
            description:
              '供置信度推导的事实（可选对象）：{ fde_confirmed?: boolean, data_verified?: boolean, ' +
              'phases_since_review?: number, last_reviewed?: string, derived_from_confidence?: string }'
          }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              file: { type: 'string', required: true },
              seq: { type: 'number', required: true },
              confidence: { type: 'string', required: true }
            }
          },
          render(_args, value) {
            return [{ type: 'text', text: `已写入决策 ${value.file}（seq ${value.seq}，confidence ${value.confidence}）` }]
          }
        },
        async execute(args, exec) {
          assertWritable('写入决策')
          const projectRoot = cfg.projectRoot
          const phase = args?.phase
          try {
            assertPhaseId(phase)
          } catch (e) {
            throw new HarnessError(e?.message ?? String(e), 'MEMORY_BAD_PHASE')
          }
          const decision = args?.decision
          if (typeof decision !== 'string' || decision.length === 0) {
            throw new HarnessError('fde_memory_write_decision: decision 必填', 'MEMORY_BAD_DECISION')
          }
          const source = args?.source
          if (typeof source !== 'string' || source.length === 0) {
            throw new HarnessError('fde_memory_write_decision: source 必填', 'MEMORY_BAD_SOURCE')
          }
          // B1（spec §7 source 防污染）：模型不能直接写 fde_confirmed（只能经 fde_memory_confirm / approval）。
          // 在工具层就拒绝（而非等 writeDecision 抛），并把这次尝试记进审计 —— 污染尝试本身也是要留痕的。
          if (source === 'fde_confirmed') {
            await audit
              ?.record({
                type: 'source-polluted',
                tool: WRITE_DECISION_TOOL,
                attempt: 'write fde_confirmed directly',
                phase,
                callId: exec?.callId,
                rootCallId: exec?.rootCallId
              })
              .catch(() => {})
            throw new HarnessError(
              'fde_memory_write_decision: source=fde_confirmed 只能经 fde_memory_confirm（approval 逐条确认）产生，模型不得直接写入（source 防污染）',
              'MEMORY_SOURCE_POLLUTED'
            )
          }
          // B1：client_stated 必带 provenance（来源出处）。
          if (source === 'client_stated') {
            const provenance = args?.provenance
            if (typeof provenance !== 'string' || provenance.trim().length === 0) {
              throw new HarnessError(
                'fde_memory_write_decision: source=client_stated 必须带 provenance（来源出处：文档路径/session ID/对话引用）',
                'MEMORY_BAD_PROVENANCE'
              )
            }
          }
          const facts = args?.facts && typeof args.facts === 'object' && !Array.isArray(args.facts) ? args.facts : {}
          const input = {
            phase,
            decision,
            source,
            question: args?.question,
            rationale: args?.rationale,
            fde_confirmed: facts.fde_confirmed,
            data_verified: facts.data_verified,
            phases_since_review: facts.phases_since_review,
            last_reviewed: facts.last_reviewed,
            derived_from_confidence: facts.derived_from_confidence,
            ...(args?.provenance !== undefined ? { provenance: args.provenance } : {})
          }
          try {
            const r = writeDecision(projectRoot, input)
            return { file: r.file, seq: r.seq, confidence: r.confidence }
          } catch (e) {
            throw new HarnessError(`写决策失败：${e?.message ?? e}`, 'MEMORY_WRITE_FAIL')
          }
        }
      })
    )
  )

  // ── fde_memory_review ──
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: REVIEW_TOOL,
        description:
          '复核一条 note（更新其 reviewed_at，原子写并追加 change_log）。file 必须是 YYYY-MM-DD-slug.md 形态。',
        parameters: {
          file: { type: 'string', required: true, description: 'note 文件名（如 "2026-09-28-design-review.md"）' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              file: { type: 'string', required: true },
              reviewed_at: { type: 'string', required: true }
            }
          },
          render(_args, value) {
            return [{ type: 'text', text: `已复核 ${value.file}（reviewed_at ${value.reviewed_at}）` }]
          }
        },
        async execute(args, exec) {
          assertWritable('复核 note')
          const projectRoot = cfg.projectRoot
          const file = args?.file
          try {
            assertNoteFile(file)
          } catch (e) {
            throw new HarnessError(e?.message ?? String(e), 'MEMORY_BAD_FILE')
          }
          try {
            const r = reviewNote(projectRoot, file, { at: new Date().toISOString() })
            return { file, reviewed_at: r.reviewed_at }
          } catch (e) {
            throw new HarnessError(`复核失败：${e?.message ?? e}`, 'MEMORY_REVIEW_FAIL')
          }
        }
      })
    )
  )

  // ── fde_memory_confirm（B1/B2：经 approval 逐条确认产生 source=fde_confirmed）──
  // spec §5 R2 层（不可逆：数据接入范围/规则阈值/上线部署/对外承诺/跳过 deny 相邻项）：
  //   逐条确认 + 一句话理由必填 + 不允许异步补录。落地 = 每条决策单独走 approval.request，
  //   确认后写 source=fde_confirmed（带 approved_at 凭证）。
  // spec §7 source 防污染：fde_confirmed 只能经本工具产生；fde_memory_write_decision 直接写会被拒。
  // 🔴 三态语义与 D4 ask 相反：D4 是 ask（unavailable 放行），这里是 fail-closed（unavailable 拒绝）
  //   —— fde_confirmed 是"人确认过"的最高档，通道不可用时绝不能降级成"已确认"。
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: CONFIRM_TOOL,
        description:
          '经 approval 逐条确认产生 source=fde_confirmed 的决策（R2 不可逆层唯一入口）。' +
          '每条决策单独弹窗确认，必须填一句话理由（reason）。确认后写入决策，source 恒为 fde_confirmed。' +
          '通道不可用/被取消时 fail-closed 拒绝（不会降级成"已确认"）。回执只给 { file, seq, confidence }。',
        parameters: {
          phase: { type: 'string', required: true, description: '决策所属的 phase id（数字或 数字.数字，如 "3" / "0.1"）' },
          question: { type: 'string', description: '这条决策要回答的问题（写入 decision 文件，便于追溯）' },
          decision: { type: 'string', required: true, description: '决策内容（必填）' },
          rationale: { type: 'string', description: '决策理由（写入 decision 文件）' },
          reason: { type: 'string', required: true, description: '一句话确认理由（R2 必填，弹窗里展示给确认人）' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              file: { type: 'string', required: true },
              seq: { type: 'number', required: true },
              confidence: { type: 'string', required: true }
            }
          },
          render(_args, value) {
            return [{ type: 'text', text: `已确认决策 ${value.file}（seq ${value.seq}，confidence ${value.confidence}，source=fde_confirmed）` }]
          }
        },
        async execute(args, exec) {
          assertWritable('逐条确认')
          const projectRoot = cfg.projectRoot
          const phase = args?.phase
          try {
            assertPhaseId(phase)
          } catch (e) {
            throw new HarnessError(e?.message ?? String(e), 'MEMORY_BAD_PHASE')
          }
          const decision = args?.decision
          if (typeof decision !== 'string' || decision.length === 0) {
            throw new HarnessError('fde_memory_confirm: decision 必填', 'MEMORY_BAD_DECISION')
          }
          // R2：一句话理由必填（不校验理由质量 —— spec §5 诚实边界：输入端没法验证理由质量）。
          const reason = args?.reason
          if (typeof reason !== 'string' || reason.trim().length === 0) {
            throw new HarnessError('fde_memory_confirm: reason 必填（R2 逐条确认要求一句话理由）', 'MEMORY_BAD_REASON')
          }

          // R2 逐条确认：走 approval（fde_confirmed 只能经 approval 产生，不允许异步补录）。
          const outcome = await askApproval(ctx, exec, reason)
          if (outcome === 'rejected') {
            await audit
              ?.record({ type: 'memory-confirm', outcome: 'rejected', phase, reason, callId: exec?.callId, rootCallId: exec?.rootCallId })
              .catch(() => {})
            throw new HarnessError('用户未确认（R2 逐条确认被拒绝）；如需写入请重新调用本工具确认。', 'MEMORY_CONFIRM_REJECTED')
          }
          if (outcome !== 'allowed-once') {
            // unavailable / cancelled：fail-closed —— fde_confirmed 是最高档，通道不可用时不能降级成"已确认"
            await audit
              ?.record({ type: 'memory-confirm', outcome: 'unavailable', phase, reason, callId: exec?.callId, rootCallId: exec?.rootCallId })
              .catch(() => {})
            throw new HarnessError('确认通道不可用/已取消，无法产生 fde_confirmed（fail-closed，不降级）', 'MEMORY_CONFIRM_UNAVAILABLE')
          }

          const approvedAt = new Date().toISOString()
          const input = {
            phase,
            decision,
            source: 'fde_confirmed',
            question: args?.question,
            rationale: args?.rationale,
            approved_at: approvedAt,
            confirm_reason: reason
          }
          try {
            const r = writeDecision(projectRoot, input)
            await audit
              ?.record({ type: 'memory-confirm', outcome: 'confirmed', phase, seq: r.seq, reason, callId: exec?.callId, rootCallId: exec?.rootCallId })
              .catch(() => {})
            return { file: r.file, seq: r.seq, confidence: r.confidence }
          } catch (e) {
            throw new HarnessError(`确认决策写入失败：${e?.message ?? e}`, 'MEMORY_WRITE_FAIL')
          }
        }
      })
    )
  )

  // ── E2（spec §7）：探索沙箱的三个入口 ──
  // 🔴 本段与上面三个工具在**三处刻意相反**，每一处都是 spec §7 的原文要求：
  //   ① **不落审计**（spec:「沙箱内容无审计要求（你随便玩）」）—— 本段一次都不碰 `audit`。
  //      配套排查纪律：链上没有沙箱记录是**设计**，不是"审计坏了"。
  //   ② **不受只读模式约束**（刻意**不**调 `assertWritable`）—— 只读模式保护的是正式记忆
  //      （SCHEMA_VERSION 迁移失败时"数据不扣人质"），沙箱里没有需要迁移的东西。
  //   ③ **不走 source / confidence 判定** —— 沙箱不是 ontology。合入时才经
  //      `fde_ontology_write`，那一步才受 gate 的语义判定约束。本模块**不提供**"提升"工具：
  //      有它就等于绕开 source 溯源与置信度门槛，正是 spec §7 第 2 条要防的事。
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: EXPERIMENT_WRITE_TOOL,
        description:
          `在探索沙箱（<projectRoot>/${EXPERIMENTS_SUBDIR}/）里写一个试验文件。` +
          '沙箱用于"随便试想法"：其内容**不进入分层注入**（不污染上下文）、' +
          '**不参与 D1/D3 校验**、**无审计要求**（spec §7）。' +
          'name 是沙箱内的相对路径（如 "scratch-notes.md" 或 "ontology-drafts/dose.yaml"），' +
          '不得含 .. 段、不得是绝对路径；沙箱内不得使用符号链接。' +
          '验证成功后，把内容经 fde_ontology_write 走正式 L0/L1/L2 通道合入 —— ' +
          '沙箱没有"提升"工具，直写 ontology 会被门禁拒绝。回执只给 { name, bytes }，不回显内容。',
        parameters: {
          name: { type: 'string', required: true, description: '沙箱内相对路径，如 "scratch-notes.md" / "ontology-drafts/x.yaml"' },
          content: { type: 'string', required: true, description: '文件内容（UTF-8）' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              bytes: { type: 'number', required: true }
            }
          },
          render(_args, value) {
            return [
              {
                type: 'text',
                text: `已写入沙箱 ${value.name}（${value.bytes} 字节）。沙箱不落审计 —— 链上没有这条记录是设计使然。`
              }
            ]
          }
        },
        async execute(args) {
          try {
            return writeExperiment(cfg.projectRoot, args?.name, args?.content)
          } catch (e) {
            throw new HarnessError(`沙箱写入失败：${e?.message ?? e}`, 'MEMORY_BAD_EXPERIMENT')
          }
        }
      })
    )
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: EXPERIMENT_READ_TOOL,
        description:
          '读一个探索沙箱文件（沙箱语义同 fde_experiment_write）。' +
          '回执给 { name, content }。读取有 256 KiB 上限，超限 fail-closed 不截断。',
        parameters: {
          name: { type: 'string', required: true, description: '沙箱内相对路径' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              content: { type: 'string', required: true }
            }
          },
          render(_args, value) {
            return [{ type: 'text', text: `沙箱文件 ${value.name}：\n${value.content}` }]
          }
        },
        async execute(args) {
          try {
            return readExperiment(cfg.projectRoot, args?.name)
          } catch (e) {
            throw new HarnessError(`沙箱读取失败：${e?.message ?? e}`, 'MEMORY_BAD_EXPERIMENT')
          }
        }
      })
    )
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: EXPERIMENT_LIST_TOOL,
        description:
          '列探索沙箱内容（递归，最多 4 层 / 200 条）。沙箱不存在 ⇒ 返回空表（不是错误）。' +
          '被截断时 truncated=true 显形（不静默丢条目）。沙箱内的符号链接只列出、不跟随。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              entries: { type: 'array', required: true, items: { type: 'string' } },
              truncated: { type: 'boolean', required: true }
            }
          },
          render(_args, value) {
            if (value.entries.length === 0) return [{ type: 'text', text: '沙箱为空。' }]
            return [
              {
                type: 'text',
                text:
                  `沙箱条目（${value.entries.length}${value.truncated ? '+，已截断' : ''}）：\n` +
                  value.entries.join('\n')
              }
            ]
          }
        },
        async execute() {
          const { entries, truncated } = listExperiments(cfg.projectRoot)
          return {
            entries: entries.map((e) =>
              e.bytes < 0 ? `${e.name}  [符号链接，未跟随]` : `${e.name}  (${e.bytes} B)`
            ),
            truncated
          }
        }
      })
    )
  )

  return () => {
    for (const d of disposers) d()
  }
}
