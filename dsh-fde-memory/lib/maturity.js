/**
 * maturity.js —— 节点成熟度追踪（draft → verified → locked 单向，A3 §3.2）。
 *
 * 文件形态：<projectRoot>/memory/ontology/maturity.yaml
 *   records: [{ id, status, history: [{ at, from, to, by, reason }] }]
 *   status ∈ {draft, verified, locked}
 *
 * 单向规则：draft(0) → verified(1) → locked(2)
 *   - newRank > oldRank：前进，OK
 *   - newRank < oldRank：回退，**必须**显式 reason（否则抛），并 append history 留痕
 *   - newRank === oldRank：no-op（不抛也不写）
 *
 * 0084 §3.3：同 rank 分支注释修正 —— 删掉"仍追加一条 history 留痕"半句。
 *   实现是 no-op + 不写盘（审计上视为幂等 no-op，不留痕）。这是有意选择。
 *
 * 0084 §3.4：readMaturity 加 fail-closed 校验 —— 读回的 rec.status 若是非法值
 *   （如手改过的 status: 3）⇒ 抛，不"猜测兼容"。防 RANK[非法] === undefined
 *   导致 newRank < undefined 恒为 false、单向规则被绕过。
 *
 * ⚠️ nodeId 是自由字符串（本插件**不校验**它存在于 objects.yaml —— 跨包不 import，
 *    那是 dsl 的地盘）。README §3 必须披露：maturity 可挂着不存在于 ontology 的 nodeId。
 *
 * 三个写入器共有约定（0082 §3.2）：
 *   ① 走 assertPhaseId —— 本库无 phase 参数，跳过
 *   ② 写完 appendChange 追加一条 change_log
 *   ③ 原子写（tmp+fsync+rename）
 *
 * 0084 §3.5（仅披露）：setMaturity 里 appendChange 在写盘之后且无 try/catch
 *   ⇒ 若 change_log 写失败，maturity 已落盘但函数抛错（调用方以为失败）。README 缺口清单加一条。
 */

import { mkdirSync, existsSync, writeFileSync, closeSync, openSync, fsyncSync, renameSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serializeYaml } from './yaml-write.js'
import { appendChange } from './change-log.js'
import { parseYamlSubset } from './yamlsubset.js'

const RANK = { draft: 0, verified: 1, locked: 2 }
const VALID_STATUS = new Set(['draft', 'verified', 'locked'])

function readFile(projectRoot) {
  const p = join(projectRoot, 'memory', 'ontology', 'maturity.yaml')
  if (!existsSync(p)) return { records: [] }
  const text = readFileSync(p, 'utf8')
  if (text.trim().length === 0) return { records: [] }
  const obj = parseYamlSubset(text, p)
  if (!Array.isArray(obj.records)) obj.records = []
  return obj
}

function findRecord(records, nodeId) {
  return records.find((r) => r.id === nodeId)
}

/**
 * 读某 nodeId 的成熟度。不存在 ⇒ null。
 * @param {string} projectRoot
 * @param {string} nodeId
 * @returns {{ id: string, status: string, history: object[] } | null}
 */
export function readMaturity(projectRoot, nodeId) {
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    throw new Error(`readMaturity: nodeId 必须是非空字符串，收到 ${JSON.stringify(nodeId)}`)
  }
  const { records } = readFile(projectRoot)
  const r = findRecord(records, nodeId)
  if (!r) return null
  // 0084 §3.4：读回的 status 若是非法值（手改过）⇒ 抛（fail-closed）
  // 防 RANK[非法] === undefined 导致 newRank < undefined 恒为 false、单向规则被绕过
  if (!VALID_STATUS.has(r.status)) {
    throw new Error(`maturity: 磁盘上 ${nodeId} 的 status=${JSON.stringify(r.status)} 非法（draft|verified|locked）—— 文件可能被手改`)
  }
  return { ...r }
}

/**
 * 设置某 nodeId 的成熟度。
 * @param {string} projectRoot
 * @param {string} nodeId
 * @param {string} status - draft | verified | locked
 * @param {{ by?: string, reason?: string }} [opts]
 * @returns {{ nodeId: string, from: string|null, to: string, changeLine: number }}
 */
export function setMaturity(projectRoot, nodeId, status, opts) {
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    throw new Error(`setMaturity: nodeId 必须是非空字符串，收到 ${JSON.stringify(nodeId)}`)
  }
  if (!VALID_STATUS.has(status)) {
    throw new Error(`setMaturity: status 必须是 draft|verified|locked，收到 ${JSON.stringify(status)}`)
  }
  const by = (opts && typeof opts.by === 'string') ? opts.by : 'unknown'
  const reason = (opts && typeof opts.reason === 'string') ? opts.reason : null

  const dir = join(projectRoot, 'memory', 'ontology')
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, 'maturity.yaml')

  const { records } = readFile(projectRoot)
  const rec = findRecord(records, nodeId)
  const fromStatus = rec ? rec.status : null

  // 0084 §3.4：读回的 status 若是非法值（手改过）⇒ 抛（fail-closed）
  // 防 RANK[非法] === undefined 导致 newRank < undefined 恒为 false、单向规则被绕过
  if (rec && !VALID_STATUS.has(rec.status)) {
    throw new Error(`maturity: 磁盘上 ${nodeId} 的 status=${JSON.stringify(rec.status)} 非法（draft|verified|locked）—— 文件可能被手改`)
  }

  // 单向规则
  if (fromStatus !== null) {
    const oldRank = RANK[fromStatus]
    const newRank = RANK[status]
    if (newRank < oldRank) {
      // 回退：必须 reason
      if (!reason) {
        throw new Error(`setMaturity: ${nodeId} 从 ${fromStatus} 回退到 ${status} 必须显式 reason（单向规则，别静默允许）`)
      }
    }
    if (newRank === oldRank) {
      // 0084 §3.3：同 rank 重复设置不留痕、不写盘（审计上视为幂等 no-op）
      // —— 这是有意选择：避免无意义的 fsync；不留 from==to 的 history 条目
      return { nodeId, from: fromStatus, to: status, changeLine: 0 }
    }
    // 写 history
    if (!Array.isArray(rec.history)) rec.history = []
    rec.history.push({ at: new Date().toISOString(), from: fromStatus, to: status, by, reason })
    rec.status = status
  } else {
    // 新建：from = null
    records.push({
      id: nodeId,
      status,
      history: [{ at: new Date().toISOString(), from: null, to: status, by, reason }]
    })
  }

  // 原子写
  const yamlText = serializeYaml({ records })
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
  let tmpFd = null
  try {
    tmpFd = openSync(tmpPath, 'w')
    writeFileSync(tmpPath, yamlText, 'utf8')
    closeSync(tmpFd)
    tmpFd = null
    tmpFd = openSync(tmpPath, 'r+')
    fsyncSync(tmpFd)
    closeSync(tmpFd)
    tmpFd = null
    renameSync(tmpPath, finalPath)
  } catch (e) {
    try { if (tmpFd !== null) closeSync(tmpFd) } catch {}
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch {}
    throw new Error(`setMaturity: 写盘失败: ${e?.message ?? e}`)
  }
  // 0084 §3.5：appendChange 在写盘之后且无 try/catch —— 若 change_log 写失败，
  // maturity 已落盘但函数抛错（调用方以为失败）。README §3 已披露
  const cr = appendChange(projectRoot, {
    kind: 'maturity',
    target: nodeId,
    summary: `${fromStatus ?? '∅'} → ${status}${reason ? ' (reason: ' + reason + ')' : ''}`
  })
  return { nodeId, from: fromStatus, to: status, changeLine: cr.line }
}

/**
 * 读某 nodeId 的变更历史（按时间升序）。
 * @param {string} projectRoot
 * @param {string} nodeId
 * @returns {object[]}
 */
export function historyOf(projectRoot, nodeId) {
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    throw new Error(`historyOf: nodeId 必须是非空字符串，收到 ${JSON.stringify(nodeId)}`)
  }
  const r = readMaturity(projectRoot, nodeId)
  if (!r) return []
  return Array.isArray(r.history) ? r.history : []
}
