/**
 * change-log.js —— append-only JSONL 变更日志（A3 §3.0 5.2b 拍定）。
 *
 * 数据源：memory/change_log.jsonl（spec 目录树之外的新增文件 —— README §3 必须披露）。
 *
 * 与 maturity.yaml 的 history 字段不冲突：maturity 只记节点成熟度变更，
 * change_log 记**所有记忆写入**（decision/checklist/stakeholder/maturity/note）。
 *
 * 0084 §3.1 措辞修正（方案 A）：原注释说"按行倒读、不全量解析"名不副实。
 *   实际做法：全量读入 text + 全量 split('\n')，只有 JSON.parse 只对最后 N 条做。
 *   即"全量读入 + 倒序取最后 N 条（只 parse N 条）；文件很大时内存仍 O(文件大小)，PoC 内接受"。
 *
 * 0084 §3.2：readRecentChanges 改签名 -> { items, bad }：坏行进 bad 而非静默消失。
 *   与 listDecisions 同形（缺席第三层 —— 整条记录缺席最易漏）。
 *   change_log 是 A5 注入面的数据源（"最近 5 条 change_log"）⇒ 静默跳过 = 注入面静默缺内容。
 *
 * 0084 §3.5（仅披露）：appendFileSync 无 fsync（decisions/checklist/stakeholders/maturity 都有）
 *   ⇒ 崩溃时最后几条可能丢。README 缺口清单加一条。
 */

import { mkdirSync, existsSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const VALID_KINDS = new Set(['decision', 'checklist', 'stakeholder', 'maturity', 'note'])

/**
 * 追加一条变更记录到 change_log.jsonl。
 * @param {string} projectRoot
 * @param {{ at?: string, kind: string, target: string, summary: string }} entry
 * @returns {{ line: number, at: string }}
 */
export function appendChange(projectRoot, entry) {
  const e = entry ?? {}
  if (!VALID_KINDS.has(e.kind)) {
    throw new Error(`change-log: kind 必须是 decision|checklist|stakeholder|maturity|note，收到 ${JSON.stringify(e.kind)}`)
  }
  if (typeof e.target !== 'string' || e.target.length === 0) {
    throw new Error(`change-log: target 必须是非空字符串，收到 ${JSON.stringify(e.target)}`)
  }
  if (typeof e.summary !== 'string') {
    throw new Error(`change-log: summary 必须是字符串，收到 ${JSON.stringify(e.summary)}`)
  }
  const dir = join(projectRoot, 'memory')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'change_log.jsonl')
  const at = e.at ?? new Date().toISOString()
  const record = { at, kind: e.kind, target: e.target, summary: e.summary }
  // appendFileSync 是原子的追加（POSIX 保证 < PIPE_BUF 的 write 原子；本场景单行 JSON
  // 远小于 PIPE_BUF，且 PoC 单进程，无需额外加锁）
  // ⚠️ 0084 §3.5：无 fsync —— 崩溃时最后几条可能丢（README §3 已披露）
  appendFileSync(p, JSON.stringify(record) + '\n', 'utf8')
  // 算行号（基于当前文件总行数，本次追加的就是最后一行）
  const line = countLines(projectRoot)
  return { line, at }
}

function countLines(projectRoot) {
  const p = join(projectRoot, 'memory', 'change_log.jsonl')
  if (!existsSync(p)) return 0
  const text = readFileSync(p, 'utf8')
  if (text.length === 0) return 0
  // 末尾 \n 不算一行（标准 JSONL 每行以 \n 结尾）
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

/**
 * 读最近 N 条变更（逆序）。0084 §3.1 措辞修正：全量读入 + 倒序取最后 N 条（只 parse N 条）。
 * 文件很大时内存仍 O(文件大小)，PoC 内接受。
 *
 * 0084 §3.2：改签名 -> { items, bad }：坏行进 bad 而非静默消失（与 listDecisions 同形）。
 *
 * @param {string} projectRoot
 * @param {number} limit
 * @returns {{ items: object[], bad: { line: number, error: string }[] }}
 *   items 顺序：最新在前（倒序）。坏行进 bad（不抛）。
 */
export function readRecentChanges(projectRoot, limit) {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`change-log: limit 必须是非负整数，收到 ${JSON.stringify(limit)}`)
  }
  const p = join(projectRoot, 'memory', 'change_log.jsonl')
  if (!existsSync(p)) return { items: [], bad: [] }
  const text = readFileSync(p, 'utf8')
  if (text.length === 0) return { items: [], bad: [] }
  const lines = text.endsWith('\n') ? text.split('\n').slice(0, -1) : text.split('\n')
  // 倒序取最后 N 条（文件末尾是最新）
  const items = []
  const bad = []
  for (let i = lines.length - 1; i >= 0 && items.length < limit; i -= 1) {
    const line = lines[i]
    if (line.trim().length === 0) continue
    try {
      items.push(JSON.parse(line))
    } catch (e) {
      // 0084 §3.2：坏行进 bad 而非静默消失（append-only 文件理论上不该有坏行，
      // 但若被手改/截断，调用方需要知道）
      bad.push({ line: i + 1, error: String(e && e.message ? e.message : e) })
    }
  }
  return { items, bad }
}
