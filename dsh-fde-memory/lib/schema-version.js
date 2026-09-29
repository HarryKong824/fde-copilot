/**
 * SCHEMA_VERSION —— 记忆系统 v2 的迁移依据（0076 §5 A1.3）。
 *
 * 设计：
 *   - SCHEMA_VERSION = 单行文件 <projectRoot>/SCHEMA_VERSION，内容是整数版本号
 *   - 缺失 ⇒ 视为 v1 并写入（本插件是新引入的，磁盘上不可能有更老的版本）
 *     ⚠️ 这条要写进 README 的"决策与理由"，因为另一种合理做法是 fail-closed
 *   - 存在且 == CURRENT ⇒ OK
 *   - 存在且 != CURRENT ⇒ 走 migrate()；无迁移路径 ⇒ 抛错、apply 失败（fail-closed）
 *
 * 迁移链骨架：CHAIN = { fromVersion: [toVersion, ...] }
 *   - 本单只有 v1，链是空的，但判定逻辑要在位（回归钉"无路径 ⇒ 抛"）
 *   - 未来加 v2 时：CHAIN['1'] = ['2']；v3 时再加 CHAIN['2'] = ['3']
 *   - migrate(1, 3) 会走 1→2→3（链式）
 *
 * 0076 §5 A1.4：迁移链骨架判定逻辑要在位，用回归钉住"无路径 ⇒ 抛"。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 当前 SCHEMA_VERSION（0076 A1：本单只有 v1）。 */
export const CURRENT = 1

/**
 * 迁移链。键 = 起始版本，值 = 可直接迁移到的目标版本列表。
 * 本单只有 v1，链是空的 —— 但 migrate() 的判定逻辑仍要在位。
 * 未来加版本时这里加键值对，例如 CHAIN['1'] = ['2']。
 */
export const CHAIN = Object.freeze({
  // '1': ['2'],  // 未来 v1 → v2
  // '2': ['3']   // 未来 v2 → v3
})

/**
 * 算从 from 到 to 的迁移路径（BFS）。返回版本号数组（含 from、to），或 undefined（无路径）。
 *
 * @param {number} from - 起始版本
 * @param {number} to - 目标版本
 * @param {Record<string, number[]>} [chain] - 迁移链（默认用 CHAIN）
 * @returns {number[] | undefined}
 */
export function migrate(from, to, chain = CHAIN) {
  if (from === to) return [from]
  if (!Number.isInteger(from) || !Number.isInteger(to)) return undefined

  // BFS：从 from 出发，看能不能走到 to
  const visited = new Set([from])
  const queue = [{ v: from, path: [from] }]

  while (queue.length > 0) {
    const { v, path } = queue.shift()
    // 🔴 chain 的键/值可能是字符串或数字（JSON 解析出字符串，代码字面量可能是数字）
    //    用 Number() coercion 统一比较，避免 '2' === 2 为 false 的类型陷阱
    const nexts = (chain[String(v)] ?? []).map((n) => Number(n))
    const toNum = Number(to)
    for (const next of nexts) {
      if (next === toNum) return [...path, next]
      if (!visited.has(next)) {
        visited.add(next)
        queue.push({ v: next, path: [...path, next] })
      }
    }
  }
  return undefined
}

/**
 * 读 <projectRoot>/SCHEMA_VERSION。返回整数版本号，或 undefined（文件缺失）。
 *
 * @param {string} projectRoot
 * @returns {number | undefined}
 */
export function readSchemaVersion(projectRoot) {
  const p = join(projectRoot, 'SCHEMA_VERSION')
  if (!existsSync(p)) return undefined
  const text = readFileSync(p, 'utf8').trim()
  if (text === '') return undefined
  const v = Number(text)
  if (!Number.isInteger(v) || v < 1) {
    throw new Error(`SCHEMA_VERSION 文件内容必须是 ≥1 的整数，收到 "${text}"`)
  }
  return v
}

/**
 * 写 <projectRoot>/SCHEMA_VERSION（单行整数）。
 *
 * @param {string} projectRoot
 * @param {number} version
 */
export function writeSchemaVersion(projectRoot, version) {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`writeSchemaVersion: version 必须是 ≥1 的整数，收到 ${String(version)}`)
  }
  const p = join(projectRoot, 'SCHEMA_VERSION')
  writeFileSync(p, String(version) + '\n', 'utf8')
}

/**
 * 确保 SCHEMA_VERSION 在位且合法。apply() 期调用。
 *
 * 决策（0076 §5 A1.3）：
 *   - 缺失 ⇒ 视为 v1 并写入（本插件新引入，磁盘上不可能有更老版本）
 *   - 存在且 == current ⇒ OK
 *   - 存在且 != current ⇒ 走 migrate()；无路径 ⇒ 抛错（fail-closed）
 *
 * @param {string} projectRoot
 * @param {number} [current] - 当前版本（默认 CURRENT）
 * @returns {{ version: number, status: 'created' | 'ok' | 'migrated' | 'failed', from?: number, path?: number[] }}
 */
export function ensureSchemaVersion(projectRoot, current = CURRENT) {
  const existing = readSchemaVersion(projectRoot)

  // 缺失 ⇒ 视为 v1 并写入（决策：本插件新引入）
  if (existing === undefined) {
    writeSchemaVersion(projectRoot, current)
    return { version: current, status: 'created' }
  }

  // 存在且 == current ⇒ OK
  if (existing === current) {
    return { version: existing, status: 'ok' }
  }

  // 存在且 != current ⇒ 走 migrate
  const path = migrate(existing, current)
  if (path === undefined) {
    // 无迁移路径 ⇒ fail-closed
    return {
      version: existing,
      status: 'failed',
      from: existing,
      path: undefined,
      error: `SCHEMA_VERSION=${existing} 无法迁移到 ${current}（无迁移路径，CHAIN=${JSON.stringify(CHAIN)}）`
    }
  }

  // 有迁移路径 ⇒ 执行迁移（本单链空，实际走不到这里；逻辑在位供未来用）
  writeSchemaVersion(projectRoot, current)
  return { version: current, status: 'migrated', from: existing, path }
}
