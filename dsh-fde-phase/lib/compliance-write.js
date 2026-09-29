/**
 * compliance-write.js —— B3（spec §10.3）：Phase 2 数据接入前置检查（D5-pre）确认后，
 * 把「授权依据 + 脱敏方案」写入 compliance.yaml 的 data_policy 键。
 *
 * 落点：<ontologyRoot>/compliance.yaml（与 D5 检查 read 的是**同一个文件**）。
 * 语义：只写/合并 data_policy 键；已存在的其它键（output_boundary / review_chain /
 * change_assessment）原样保留（Phase 6 前补全它们，D5-pre 不替它们占位）。
 *
 * 🔴 合并策略 fail-closed：现有 compliance.yaml 若**解析不了**（parseComplianceYaml 报错），
 *   拒绝覆盖 —— 现有合规证据比"补写 data_policy"更值钱，宁可让 D5-pre 失败，
 *   也不许用一个半读的文件把已有内容抹掉。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, closeSync, openSync, fsyncSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseComplianceYaml } from './check-d5.js'

/** compliance.yaml 的落点（与 D5 检查 read 的路径同源，避免两处各写一份漂移）。 */
export function compliancePath(ontologyRoot) {
  return join(ontologyRoot, 'compliance.yaml')
}

/** 标量序列化（与 check-d5.js parseInlineValue 对称：特殊字符/字面量/数字一律加引号）。 */
function serializeScalar(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    const looksNumeric = v.trim() !== '' && !isNaN(Number(v)) && isFinite(Number(v))
    if (/[:\n\r#]|^\s|\s$/.test(v) || /^(yes|no|on|off|true|false|null|~)$/i.test(v) || looksNumeric) {
      return JSON.stringify(v)
    }
    return v
  }
  return JSON.stringify(v)
}

/** 序列化 compliance.yaml（与 parseComplianceYaml 对称：顶层键 → 标量 / list / map / 空）。 */
export function serializeComplianceYaml(obj) {
  const lines = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      lines.push(`${k}:`)
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`)
        continue
      }
      lines.push(`${k}:`)
      for (const item of v) lines.push(`  - ${serializeScalar(item)}`)
    } else if (typeof v === 'object') {
      const keys = Object.keys(v)
      if (keys.length === 0) {
        lines.push(`${k}: {}`)
        continue
      }
      lines.push(`${k}:`)
      for (const sk of keys) lines.push(`  ${sk}: ${serializeScalar(v[sk])}`)
    } else {
      lines.push(`${k}: ${serializeScalar(v)}`)
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * 写/合并 compliance.yaml 的 data_policy 键（授权依据 authorization + 脱敏方案 deidentification）。
 *
 * @param {string} ontologyRoot
 * @param {{ authorization: string, deidentification: string }} dataPolicy
 * @returns {{ file: string }} 写入后的文件路径
 */
export function writeComplianceDataPolicy(ontologyRoot, dataPolicy) {
  if (!dataPolicy || typeof dataPolicy.authorization !== 'string' || dataPolicy.authorization.trim().length === 0) {
    throw new Error('writeComplianceDataPolicy: authorization（授权依据）必须是非空字符串')
  }
  if (typeof dataPolicy.deidentification !== 'string' || dataPolicy.deidentification.trim().length === 0) {
    throw new Error('writeComplianceDataPolicy: deidentification（脱敏方案）必须是非空字符串')
  }

  const path = compliancePath(ontologyRoot)
  let existing = {}
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8')
    const parsed = parseComplianceYaml(text)
    if (!parsed.ok) {
      // fail-closed：现有文件坏掉不覆盖（见文件头注释）
      throw new Error('compliance.yaml 现有内容无法解析，拒绝覆盖（请先手工修复该文件）：' + parsed.error)
    }
    existing = parsed.obj
  }

  existing.data_policy = {
    authorization: dataPolicy.authorization.trim(),
    deidentification: dataPolicy.deidentification.trim()
  }

  // 原子写：tmp + fsync + rename（与 state.js / decisions.js 同族）
  mkdirSync(dirname(path), { recursive: true })
  const yamlText = serializeComplianceYaml(existing)
  const tmpPath = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
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
    renameSync(tmpPath, path)
  } catch (e) {
    try { if (tmpFd !== null) closeSync(tmpFd) } catch {}
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch {}
    throw new Error(`writeComplianceDataPolicy: 写盘失败: ${e?.message ?? e}`)
  }
  return { file: path }
}
