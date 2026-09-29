/**
 * D5 —— **合规边界存在性检查**（Stage 5.6，Phase 6 的 deny 门禁）。
 *
 * 检查对象：`compliance.yaml`（位于 ontologyRoot，受 gate 保护）。
 *
 * PoC 降级：只做存在性 + 非空检查，不做内容判定（内容需按 industry，由部署 config 决定）。
 * industry === '未声明' 时，D5 通过存在性检查后以 notApplicable 留痕（不拦、但诚实说明）。
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

export const D5_ANCHOR_ALG = 'compliance.yaml(sha256+len+nonempty)@v1'

export const COMPLIANCE_KEYS = Object.freeze([
  'output_boundary',
  'review_chain',
  'data_policy',
  'change_assessment',
  'rollback_preauth'
])

/**
 * 哨兵值：表示部署方未声明行业（= 不适用 D5，非受监管）。
 * 🔴 **不许用字符串直接比较 industry**：
 *    - '未声明' 是真值字符串，if (!cfg.industry) 会把它当"已声明"；
 *    - 任何"是否适用 D5"的判定都必须走 isRegulatedIndustry()，避免漂移。
 */
export const UNSPECIFIED_INDUSTRY = '未声明'

/**
 * spec :246 —— 受监管行业启用 D5，非受监管行业自动关闭。
 * 纯函数（可单测）：不读文件、不读 cfg。
 *
 * 启用判据：行业名以 medical- 开头（如 medical-aesthetics）。
 * 未声明 / 空串 / retail / 其他 ⇒ 不适用（D5 自动关闭，以 notApplicable 留痕）。
 *
 * @param {string} industry
 * @returns {boolean} true = 受监管 ⇒ D5 启用；false = 不适用 ⇒ D5 关闭
 */
export function isRegulatedIndustry(industry) {
  const v = String(industry ?? '').trim()
  if (v === '' || v === UNSPECIFIED_INDUSTRY) return false
  return /^medical(-|$)/i.test(v)
}

export function parseComplianceYaml(text) {
  const lines = String(text ?? '').split('\n')
  const obj = {}
  let currentKey = null
  let currentBlock = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1
    if (line.trim().startsWith('#')) continue
    const topMatch = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/)
    if (topMatch && line === line.trimStart()) {
      if (currentKey !== null) obj[currentKey] = parseBlockValue(currentBlock)
      currentKey = topMatch[1]
      const inline = topMatch[2].trim()
      if (inline === '' || inline === '|' || inline === '>') {
        currentBlock = []
      } else {
        obj[currentKey] = parseInlineValue(inline)
        currentKey = null
        currentBlock = []
      }
      continue
    }
    if (currentKey !== null) {
      currentBlock.push(line)
    } else {
      // 缺陷 D 修复（方案 a）：非空、非注释、非 top-level key、且无累积 block
      // ⇒ 文件不是合法 YAML 子集，报 parse-error（而非把 4 键都报 missing-key）。
      const trimmed = line.trim()
      if (trimmed !== '') {
        return { ok: false, error: '第 ' + lineNo + ' 行无法解析："' + trimmed + '"（既不是顶层键，也不是任何键的子内容）' }
      }
    }
  }
  if (currentKey !== null) obj[currentKey] = parseBlockValue(currentBlock)
  return { ok: true, obj }
}

function parseInlineValue(v) {
  if (v === '' || v === '~' || v === 'null' || v === 'Null' || v === 'NULL') return null
  if (v === 'true' || v === 'True' || v === 'TRUE') return true
  if (v === 'false' || v === 'False' || v === 'FALSE') return false
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1)
  if (/^-?\d+$/.test(v)) return parseInt(v, 10)
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v)
  return v
}

function parseBlockValue(lines) {
  const trimmed = lines.map((l) => l.trimEnd()).filter((l) => l.trim() !== '')
  if (trimmed.length === 0) return null
  if (trimmed.every((l) => l.trimStart().startsWith('- '))) {
    return trimmed.map((l) => parseInlineValue(l.trimStart().slice(2).trim()))
  }
  if (trimmed.every((l) => /^[a-zA-Z_][\w-]*\s*:/.test(l.trimStart()))) {
    const o = {}
    for (const l of trimmed) {
      const m = l.trimStart().match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/)
      if (m) o[m[1]] = parseInlineValue(m[2].trim())
    }
    return o
  }
  return trimmed.join('\n')
}

export function isNonEmpty(v) {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v).length > 0
  return true
}

export function verifyComplianceText(text) {
  const failures = []
  let parsed
  try {
    parsed = parseComplianceYaml(text)
  } catch (e) {
    return { passed: false, failures: [{ code: 'parse-error', message: 'compliance.yaml 解析失败：' + String(e?.message ?? e) }], keys: {} }
  }
  if (!parsed.ok) return { passed: false, failures: [{ code: 'parse-error', message: parsed.error }], keys: {} }
  const obj = parsed.obj
  for (const key of COMPLIANCE_KEYS) {
    if (!(key in obj)) {
      failures.push({ code: 'missing-key', key, message: 'compliance.yaml 缺少顶层键 ' + key })
      continue
    }
    if (!isNonEmpty(obj[key])) {
      failures.push({ code: 'empty-value', key, message: 'compliance.yaml 的 ' + key + ' 为空' })
      continue
    }
    // 施工单 §4：「子字段都是非空字符串」—— 检查对象值的所有字符串子字段非空。
    // isNonEmpty 只判"对象有 key"，抓不到 {reviewer:''} 这种空串子字段。
    // 这属存在性（"谁复核"的标记），不是内容判定（spec :257 禁止的是"评估得好不好"）。
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      const emptySubs = []
      for (const [sk, sv] of Object.entries(obj[key])) {
        if (typeof sv === 'string' && sv === '') emptySubs.push(sk)
      }
      if (emptySubs.length > 0) {
        failures.push({ code: 'empty-subfield', key, subfields: emptySubs, message: 'compliance.yaml 的 ' + key + ' 子字段为空串：' + emptySubs.join(', ') })
        continue
      }
    }
    // 缺陷 E 修复：change_assessment 是"是否已做合规分级评估"的存在性判定，
    // classified 必须是 true（不是"评估得好不好"——那是内容判定，spec :257 禁止）。
    // false / 缺失 / 非布尔 ⇒ not-classified（与 missing-key / empty-value 并列的不通过理由）。
    if (key === 'change_assessment') {
      const v = obj[key]
      if (typeof v !== 'object' || v === null || v.classified !== true) {
        failures.push({ code: 'not-classified', key, message: 'compliance.yaml 的 change_assessment.classified 必须为 true（已做合规分级评估）' })
      }
    }
    // C3（spec §10.1 表第 5 键）：rollback_preauth 是"部署审批包含紧急回滚授权路径"的存在性判定。
    // authorized 必须是 true（与 change_assessment.classified === true 同构的存在性判定，
    // 不是"回滚方案好不好"——那是内容判定）。false / 缺失 / 非布尔 ⇒ not-authorized。
    if (key === 'rollback_preauth') {
      const v = obj[key]
      if (typeof v !== 'object' || v === null || v.authorized !== true) {
        failures.push({ code: 'not-authorized', key, message: 'compliance.yaml 的 rollback_preauth.authorized 必须为 true（部署审批包含紧急回滚授权路径）' })
      }
    }
  }
  return { passed: failures.length === 0, failures, keys: obj }
}

export function complianceFingerprintSync(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error('读取 compliance.yaml 失败（' + path + '）：' + String(e?.message ?? e))
  }
  const r = verifyComplianceText(text)
  const sha256 = createHash('sha256').update(text).digest('hex')
  const len = text.split('\n').filter((l) => l.trim().length > 0).length
  const nonempty = COMPLIANCE_KEYS.filter((k) => r.keys[k] !== undefined && isNonEmpty(r.keys[k])).length
  return { sha256, len, nonempty }
}

export async function runD5Check(path) {
  let text = null
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    const msg = '读不到 compliance.yaml（' + path + '）：' + String(e?.message ?? e)
    return { passed: false, failures: [{ code: 'unreadable', message: msg }], reason: msg, sha256: '', lineCount: 0, nonemptyCount: 0, keyCount: 0 }
  }
  const r = verifyComplianceText(text)
  const sha256 = createHash('sha256').update(text).digest('hex')
  const lineCount = text.split('\n').filter((l) => l.trim().length > 0).length
  const keyCount = Object.keys(r.keys).length
  const nonemptyCount = COMPLIANCE_KEYS.filter((k) => r.keys[k] !== undefined && isNonEmpty(r.keys[k])).length
  return {
    passed: r.passed,
    failures: r.failures,
    reason: r.passed
      ? 'compliance.yaml 存在且 5 键齐全且非空'
      : r.failures.length + ' 处问题：' + r.failures.map((f) => f.message).join('；'),
    sha256,
    lineCount,
    nonemptyCount,
    keyCount
  }
}
