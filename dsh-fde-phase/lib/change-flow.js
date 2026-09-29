/**
 * C2 · L0/L1/L2 各自流程（spec §4）—— 变更闭环判定。
 *
 * ## 为什么需要这个模块
 *
 * C1（`dsh-fde-ontology-gate/lib/classify.js`）已经能判出变更级别并写进审计，但**没有任何
 * 消费者** —— 级别是"死数据"。spec §4 给每一级规定了变更后必须走的流程：
 *
 * | 级别 | 流程（spec §4 原文） |
 * |---|---|
 * | L0 补充 | 记录理由 → 重生成用例 → 重跑 D3 |
 * | L1 修正 | 回 Phase 3 变更模式 → 改规则 → 重生成用例 → 重跑 D1+D3 → 标记下游 → 自动回原 Phase |
 * | L2 受监管 | L1 全流程 + D5 合规分级评估 + 外部审批人确认 |
 *
 * 把"流程"字面拆开看，其中**插件能判定的**只有一件事：**该跑的检查跑没跑、过没过、
 * 结论还新不新鲜**（重生成用例、改规则、标记下游都是人或模型的动作，插件只能事后核）。
 * 所以本模块把三支流程机器化为三张"必需检查清单"，并在变更闭环时逐项核验。
 *
 * ## 为什么从 gate 审计链读级别，而不是让调用方传
 *
 * 级别是**自动判定**的（spec §4：「插件自动判，FDE 只能升级不能降级」）。若让模型在
 * 闭环时自报级别，模型报 `L0` 就能少跑 D1/D5 —— 那等于把门禁敞开。gate 审计链是
 * 级别判定结果的**唯一权威落盘处**（`fde_ontology_write` 的 allow 记录带 `level`/`autoLevel`），
 * 且链是哈希链、改不动。故本模块只读链。
 *
 * ## 已知边界（诚实写）
 *
 * - **旧记录无 `level`**：C1 落地（2026-09-28）之前的写入记录没有 `level` 字段（实测
 *   gate.jsonl seq=4/5 是 09-26 的，键里无 level）。读到这种记录**不猜**，返回
 *   `no-level` 让调用方 fail-closed 报错。
 * - **「标记下游」未实现**：spec L1 流程里的"标记下游"需要一个"受影响下游清单"的概念，
 *   本项目尚无。本模块不假装做了 —— README 诚实清单列明。
 * - **「自动回原 Phase」未实现**：见 change-flow 设计说明 —— 本项目 Phase 状态机的不变量是
 *   `current → next(+1)` 不许回退（回退会给"退回 Phase 3 重跑 D1"开门）。故变更期间
 *   **不动 `current_phase`**，只做闭环判定；spec 的"变更模式"语义由「未闭环变更」的
 *   **可判定性**承载，而非由一个可回退的 phase 承载。
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { complianceFingerprintSync } from './check-d5.js'
import { TOOL_BY_CHECK } from './mirror.js'

/** 尾部扫描窗口。比 `mirror.js` 的 64KiB 大一档：链里 write 记录稀疏，窗口小了会误报"无变更"。 */
const TAIL_BYTES = 262144

/** gate 审计链里"写 ontology"的 tool 名（`dsh-fde-ontology-gate/lib/tools.js` 的 `ONTOLOGY_WRITE`）。 */
const WRITE_TOOL = 'fde_ontology_write'

/**
 * 每一级变更闭环**必需**的检查项（spec §4 三支流程的机器化）。
 *
 * - **L0**（仅新增、effect 非 deny、不涉受监管字段）⇒ 只要 D3（用例集完整 + 规则可执行可反驳）。
 *   为什么不含 D1：L0 不改既有语义、不新增 deny 护栏，护栏绑定的完整性不受影响。
 * - **L1**（改既有语义 / 新增带 deny 的规则）⇒ D1（护栏绑定）+ D3。
 * - **L2**（触及临床判定 / 改适用范围或输出形式 / 受监管行业的 deny 规则）
 *   ⇒ L1 全流程 + D5（合规边界）。
 */
export const REQUIRED_CHECKS = Object.freeze({
  L0: Object.freeze(['D3']),
  L1: Object.freeze(['D1', 'D3']),
  L2: Object.freeze(['D1', 'D3', 'D5'])
})

/** 哪些级别需要外部审批人确认（spec §4：只有 L2 有"外部审批人确认"）。 */
export const NEEDS_APPROVAL = Object.freeze({ L0: false, L1: false, L2: true })

/** 合法级别（与 `classify.js` 的输出域一致）。 */
export const CHANGE_LEVELS = Object.freeze(['L0', 'L1', 'L2'])

/**
 * 读 gate 审计链尾部，取**最后一条真正写成功**的 ontology 变更。
 *
 * 只认 `decision === 'allow'`：`deny`（降级拒绝）与 `write-probe`（越界探测）都不是变更，
 * 拿它们当"最近一次变更"会让闭环判到一个根本没落盘的改动上。
 *
 * 同步 IO：本函数被工具 execute 调用，且只读尾部 ≤256KiB，不值得异步化
 * （与 `mirror.js` 的 `restoreSync` 同一取舍）。
 *
 * @param {string} gateAuditPath - config 的 `gateAuditPath`
 * @param {number} [tailBytes]
 * @returns {{ok:true, level:string, autoLevel:string|undefined, target:string|undefined, ts:string|undefined, seq:number}}
 *        | {ok:false, reason:'unreadable'|'no-change'|'no-level', detail?:string}
 */
export function readLatestChange(gateAuditPath, tailBytes = TAIL_BYTES) {
  if (typeof gateAuditPath !== 'string' || gateAuditPath.trim() === '') {
    return { ok: false, reason: 'unreadable', detail: 'gateAuditPath 未配置（normalizeConfig 会拦，此处兜底）' }
  }
  let fd
  try {
    const st = statSync(gateAuditPath)
    // ⚠️ 必须先判「是不是文件」再判大小：**目录的 size 在 Windows 上也是 0**，
    // 直接按 size===0 判会把"gateAuditPath 配成了目录"（配置错误）误报成 `no-change`
    // —— 那等于告诉模型"没有变更可闭环"，是个会把人带偏的答案。
    if (!st.isFile()) {
      return { ok: false, reason: 'unreadable', detail: `${gateAuditPath} 不是普通文件（是目录或特殊文件）` }
    }
    if (st.size === 0) return { ok: false, reason: 'no-change' }
    fd = openSync(gateAuditPath, 'r')
    const length = Math.min(st.size, tailBytes)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, st.size - length)
    const lines = buffer.toString('utf8').split('\n')
    // 从尾部往前找：第一条命中的就是"最近一次变更"。
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim()
      if (!t) continue
      let rec
      try {
        rec = JSON.parse(t)
      } catch {
        continue // 残行/半写行：跳过（窗口起点处必然有一行是半截的）
      }
      if (rec.tool !== WRITE_TOOL || rec.decision !== 'allow') continue
      if (typeof rec.level !== 'string' || rec.level.trim() === '') {
        // fail-closed：不猜级别。旧记录（C1 落地前）没有 level 字段。
        return { ok: false, reason: 'no-level', detail: `gate.jsonl seq=${rec.seq}（${rec.ts}）的写入记录没有 level 字段` }
      }
      return {
        ok: true,
        level: rec.level,
        autoLevel: rec.autoLevel,
        target: rec.target,
        ts: rec.ts,
        seq: rec.seq
      }
    }
    return { ok: false, reason: 'no-change' }
  } catch (e) {
    return { ok: false, reason: 'unreadable', detail: String(e?.message ?? e) }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 关闭失败不影响已读到的内容
      }
    }
  }
}

/**
 * 按级别逐项核验必需检查（复用 `D1Mirror` 的同步锚点比对 —— 与 guard 推进时同一套判据）。
 *
 * ⚠️ 这里**不重新实现**任何检查语义：`mirror.verify` 内部已经涵盖"有没有结论 / 上次是否通过 /
 * 锚点 alg 对不对 / 锚点与当前文件是否一致"四件事（见 `mirror.js` 的 `#common`）。
 * 本函数只负责"按级别挑出该跑哪几项 + 把 D5 的 expected 算出来"。
 *
 * @param {string} level
 * @param {import('./mirror.js').D1Mirror} mirror
 * @param {{ ontologyRoot: string }} cfg
 * @returns {Array<{check:string, ok:boolean, reason?:string, tool:string}>}
 */
export function verifyRequiredChecks(level, mirror, cfg) {
  const required = REQUIRED_CHECKS[level]
  if (!required) {
    // 未知级别 ⇒ 不猜"要不要跑检查"，直接判成未通过（fail-closed）。
    return [{ check: `unknown-level:${level}`, ok: false, reason: `未登记的变更级别 ${level}`, tool: '-' }]
  }
  const onto = cfg.ontologyRoot
  return required.map((check) => {
    const tool = TOOL_BY_CHECK[check] ?? `对应的 ${check} 检查工具`
    let v
    if (check === 'D1') {
      v = mirror.verify('D1', [join(onto, 'actions.yaml'), join(onto, 'guards.yaml')])
    } else if (check === 'D3') {
      v = mirror.verify('D3', [join(onto, 'objects.yaml'), join(onto, 'logic.yaml')])
    } else if (check === 'D5') {
      // D5 的锚点是 (sha256, len, nonempty) 三元组，得先同步算当前指纹再比。
      try {
        const fp = complianceFingerprintSync(join(onto, 'compliance.yaml'))
        v = mirror.verify('D5', [join(onto, 'compliance.yaml')], {
          sha256: fp.sha256,
          len: fp.len,
          nonempty: fp.nonempty
        })
      } catch (e) {
        v = { ok: false, reason: `无法读取 compliance.yaml：${String(e?.message ?? e)}` }
      }
    } else {
      v = { ok: false, reason: `${check} 未在本模块登记判定实现（拒绝放行而非假装通过）` }
    }
    return { check, ok: !!v.ok, reason: v.reason, tool }
  })
}

/**
 * 把核验结果拼成给模型看的人话（未通过时用）。
 * @param {string} level
 * @param {Array<{check:string, ok:boolean, reason?:string, tool:string}>} results
 */
export function describeIncomplete(level, results) {
  const bad = results.filter((r) => !r.ok)
  const lines = bad.map((r) => `  · ${r.check}：${r.reason ?? '未通过'}（重跑：${r.tool}）`)
  return (
    `${level} 变更闭环未完成，缺 ${bad.length} 项：\n` +
    lines.join('\n') +
    `\n（${level} 必需：${(REQUIRED_CHECKS[level] ?? []).join(' + ')}；每项都要求"跑过且通过"且结论锚点与当前 ontology 内容一致）`
  )
}
