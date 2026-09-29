/**
 * checklist.js —— 按 Phase 分片的待办清单（spec §5 债 2 第 ③ 条，A3 §3.2）。
 *
 * 文件形态：<projectRoot>/memory/checklist/{phase}.yaml
 *   items: [{ id: string, text: string, done: boolean, evidence?: string }]
 *
 * 三个写入器共有约定（0082 §3.2）：
 *   ① 走 assertPhaseId（本库带 phase）
 *   ② 写完 appendChange 追加一条 change_log
 *   ③ 原子写（tmp+fsync+rename）
 */

import { mkdirSync, existsSync, writeFileSync, closeSync, openSync, fsyncSync, renameSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertPhaseId } from './decisions.js'
import { serializeYaml } from './yaml-write.js'
import { appendChange } from './change-log.js'
import { parseYamlSubset } from './yamlsubset.js'

/**
 * 读某 phase 的 checklist。文件不存在 ⇒ null（不抛）。
 * @param {string} projectRoot
 * @param {string} phase
 * @returns {{ phase: string, items: object[] } | null}
 */
export function readChecklist(projectRoot, phase) {
  assertPhaseId(phase)
  const p = join(projectRoot, 'memory', 'checklist', `${phase}.yaml`)
  if (!existsSync(p)) return null
  const text = readFileSync(p, 'utf8')
  if (text.trim().length === 0) return null
  const obj = parseYamlSubset(text, p)
  // 兼容：items 字段可能缺失（视为空）
  if (!Array.isArray(obj.items)) obj.items = []
  return obj
}

/**
 * 写某 phase 的 checklist（整文件重写 + 原子写）。
 * @param {string} projectRoot
 * @param {string} phase
 * @param {Array<{ id: string, text: string, done: boolean, evidence?: string }>} items
 * @returns {{ file: string, changeLine: number }}
 */
export function writeChecklist(projectRoot, phase, items) {
  assertPhaseId(phase)
  if (!Array.isArray(items)) {
    throw new Error(`writeChecklist: items 必须是数组，收到 ${JSON.stringify(typeof items)}`)
  }
  // 字段校验（宁可报错，不可猜）
  for (const it of items) {
    if (typeof it.id !== 'string' || it.id.length === 0) {
      throw new Error(`writeChecklist: item.id 必须是非空字符串，收到 ${JSON.stringify(it.id)}`)
    }
    if (typeof it.text !== 'string' || it.text.length === 0) {
      throw new Error(`writeChecklist: item.text 必须是非空字符串，收到 ${JSON.stringify(it.text)}`)
    }
    if (typeof it.done !== 'boolean') {
      throw new Error(`writeChecklist: item.done 必须是布尔，收到 ${JSON.stringify(it.done)}`)
    }
    if (it.evidence !== undefined && typeof it.evidence !== 'string') {
      throw new Error(`writeChecklist: item.evidence 必须是字符串，收到 ${JSON.stringify(it.evidence)}`)
    }
  }

  const dir = join(projectRoot, 'memory', 'checklist')
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, `${phase}.yaml`)
  const yamlText = serializeYaml({ phase, items })

  // 原子写：tmp + fsync + rename
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
    throw new Error(`writeChecklist: 写盘失败: ${e?.message ?? e}`)
  }
  // 写完成功后追加 change_log
  const done = items.filter((it) => it.done).length
  const cr = appendChange(projectRoot, {
    kind: 'checklist',
    target: phase,
    summary: `${items.length} items (${done} done)`
  })
  return { file: `${phase}.yaml`, changeLine: cr.line }
}
