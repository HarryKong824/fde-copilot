/**
 * stakeholders.js —— 干系人档案 + 4 字段摘要（A3 §3.0 5.2a 拍定 + §3.2）。
 *
 * 文件形态：<projectRoot>/memory/stakeholders.yaml
 *   全量字段：{ id, name, role, org, influence, contact?, notes? }
 *   influence ∈ {high, medium, low}
 *
 * 4 字段摘要（A5 注入面用）：summarize() 返回 [{name, role, org, influence}] —— 不含联系方式类字段
 * （隐私 + 体积）。
 *
 * 三个写入器共有约定（0082 §3.2）：
 *   ① 走 assertPhaseId —— 本库无 phase 参数，跳过
 *   ② 写完 appendChange 追加一条 change_log
 *   ③ 原子写（tmp+fsync+rename）
 */

import { mkdirSync, existsSync, writeFileSync, closeSync, openSync, fsyncSync, renameSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serializeYaml } from './yaml-write.js'
import { appendChange } from './change-log.js'
import { parseYamlSubset } from './yamlsubset.js'

const VALID_INFLUENCE = new Set(['high', 'medium', 'low'])

/**
 * 读全部干系人。文件不存在 ⇒ 空数组（不抛）。
 * @param {string} projectRoot
 * @returns {object[]}
 */
export function readStakeholders(projectRoot) {
  const p = join(projectRoot, 'memory', 'stakeholders.yaml')
  if (!existsSync(p)) return []
  const text = readFileSync(p, 'utf8')
  if (text.trim().length === 0) return []
  const obj = parseYamlSubset(text, p)
  if (!Array.isArray(obj.stakeholders)) return []
  return obj.stakeholders
}

/**
 * 写 / 更新单个干系人（按 id upsert）。整文件重写 + 原子写。
 * @param {string} projectRoot
 * @param {{ id: string, name: string, role: string, org: string, influence: string, contact?: string, notes?: string }} s
 * @returns {{ file: string, changeLine: number, mode: 'insert' | 'update' }}
 */
export function writeStakeholder(projectRoot, s) {
  if (!s || typeof s !== 'object') {
    throw new Error(`writeStakeholder: 入参必须是对象，收到 ${JSON.stringify(s)}`)
  }
  if (typeof s.id !== 'string' || s.id.length === 0) {
    throw new Error(`writeStakeholder: id 必须是非空字符串，收到 ${JSON.stringify(s.id)}`)
  }
  if (typeof s.name !== 'string' || s.name.length === 0) {
    throw new Error(`writeStakeholder: name 必须是非空字符串，收到 ${JSON.stringify(s.name)}`)
  }
  if (typeof s.role !== 'string') {
    throw new Error(`writeStakeholder: role 必须是字符串，收到 ${JSON.stringify(s.role)}`)
  }
  if (typeof s.org !== 'string') {
    throw new Error(`writeStakeholder: org 必须是字符串，收到 ${JSON.stringify(s.org)}`)
  }
  if (!VALID_INFLUENCE.has(s.influence)) {
    throw new Error(`writeStakeholder: influence 必须是 high|medium|low，收到 ${JSON.stringify(s.influence)}`)
  }
  if (s.contact !== undefined && typeof s.contact !== 'string') {
    throw new Error(`writeStakeholder: contact 必须是字符串，收到 ${JSON.stringify(s.contact)}`)
  }
  if (s.notes !== undefined && typeof s.notes !== 'string') {
    throw new Error(`writeStakeholder: notes 必须是字符串，收到 ${JSON.stringify(s.notes)}`)
  }

  const dir = join(projectRoot, 'memory')
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, 'stakeholders.yaml')

  // upsert：按 id 替换或追加
  const existing = readStakeholders(projectRoot)
  const idx = existing.findIndex((x) => x.id === s.id)
  let mode
  if (idx >= 0) {
    existing[idx] = s
    mode = 'update'
  } else {
    existing.push(s)
    mode = 'insert'
  }
  const yamlText = serializeYaml({ stakeholders: existing })

  // 原子写
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
    throw new Error(`writeStakeholder: 写盘失败: ${e?.message ?? e}`)
  }
  const cr = appendChange(projectRoot, {
    kind: 'stakeholder',
    target: s.id,
    summary: `${mode} ${s.name} (${s.influence})`
  })
  return { file: 'stakeholders.yaml', changeLine: cr.line, mode }
}

/**
 * 4 字段摘要（A3 §3.0 5.2a 拍定）—— A5 注入面调用。
 * 联系方式类字段不进摘要（隐私 + 体积）。
 * @param {object[]} stakeholders
 * @returns {{ name: string, role: string, org: string, influence: string }[]}
 */
export function summarize(stakeholders) {
  if (!Array.isArray(stakeholders)) return []
  return stakeholders.map((s) => ({
    name: s.name,
    role: s.role,
    org: s.org,
    influence: s.influence
  }))
}
