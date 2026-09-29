/**
 * L4 交叉校验的 **phase 侧只读镜像**（spec 第八节）：
 *   「L4 交叉校验  deny 校验 = 本地链完整 **AND**（远端存在 **OR** 降级模式）」
 *
 * 「本地链完整」= D2（`check-d2.js`，本插件已有）。本文件补的是**后半个括号**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 🔴 **为什么要有一份镜像而不 import `dsh-fde-memory`**：
 *    本项目既有硬约束（0076 §3.3）：**插件独立安装，跨包 import 会互相拖垮**
 *    —— 先例：`ANCHOR_ALGS`、`deny-ids.js`、`EXPERIMENTS_SUBDIR` 都是各存一份。
 *    所以这里**不 import memory 的任何文件**，只共享**文件格式**：
 *    `<projectRoot>/memory/outbox/state.json`（写入者是 memory 的 `lib/outbox.js`）。
 *    两边的一致性由 `_fde_d1_crosspkg_test.mjs` **逐字对拍字面量 + 同一批输入对拍判定**钉住。
 *
 * 🔴 **`evaluateRemote` 必须与 memory 侧同名函数逐例同解**。任何一边单独改判据
 *    ⇒ 一边说"降级了可以通过"、另一边说"不行"，而这种不一致**两边都不会报错**。
 *
 * 🔴 **guard 是同步的**：所以这里全用同步 fs。读的是一份 <1KB 的 JSON ——
 *    与 D2 已经做的"同步全量读 gate 审计链"相比，代价可以忽略。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 跨包字面量契约（与 dsh-fde-memory/lib/outbox.js 逐字一致，由 crosspkg 测试对拍）──
/** @see dsh-fde-memory/lib/outbox.js 的 `OUTBOX_SUBDIR` */
export const OUTBOX_SUBDIR = 'outbox'
/** @see dsh-fde-memory/lib/outbox.js 的 `STATE_FILE` */
export const STATE_FILE = 'state.json'
/** @see dsh-fde-memory/lib/outbox.js 的 `STATE_SCHEMA` */
export const STATE_SCHEMA = 1
/** `memory/outbox` 相对 `<projectRoot>` 的路径段（把上面两个拼起来，只此一处）。 */
export const OUTBOX_REL_DIR = `memory/${OUTBOX_SUBDIR}`

/** 时间字段形态（与 memory 侧同一判据）。 */
const ISO_OR_NULL = (v) => v === null || (typeof v === 'string' && v.length > 0)

/** 默认 state.json 路径（config 没显式给时用）。 */
export function defaultStatePath(projectRoot) {
  return join(projectRoot, 'memory', OUTBOX_SUBDIR, STATE_FILE)
}

/**
 * 读降级状态。**缺席分档**（与 memory 侧 `readStateSync` 同一套 reason 取值）：
 * `enoent` / `empty` / `bad` / `schema`。
 *
 * @param {string} path
 * @returns {{present: true, state: object} | {present: false, reason: string, error?: string}}
 */
export function readRemoteStateSync(path) {
  if (typeof path !== 'string' || path === '') return { present: false, reason: 'enoent', error: '路径为空' }
  if (!existsSync(path)) return { present: false, reason: 'enoent' }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    return { present: false, reason: 'bad', error: String(e?.message ?? e) }
  }
  if (text.trim().length === 0) return { present: false, reason: 'empty' }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { present: false, reason: 'bad', error: String(e?.message ?? e) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { present: false, reason: 'bad', error: 'state.json 顶层不是对象' }
  }
  if (parsed.schema !== STATE_SCHEMA) {
    return { present: false, reason: 'schema', error: `schema=${JSON.stringify(parsed.schema)}，本插件只认 ${STATE_SCHEMA}` }
  }
  for (const k of ['updatedAt', 'lastDeliveredAt', 'lastAttemptAt', 'outageSince', 'degradedSince']) {
    if (!ISO_OR_NULL(parsed[k])) {
      return { present: false, reason: 'bad', error: `${k} 不是 ISO 字符串也不是 null：${JSON.stringify(parsed[k])}` }
    }
  }
  if (!Number.isInteger(parsed.degradedDelivered) || parsed.degradedDelivered < 0) {
    return { present: false, reason: 'bad', error: `degradedDelivered 不是 ≥0 的整数：${JSON.stringify(parsed.degradedDelivered)}` }
  }
  // 🔴 阈值必须为正：0/负数/NaN ⇒ "降级"恒成立 ⇒ 括号退化成恒真 ⇒ 门禁静默失效。
  if (!Number.isFinite(parsed.degradeAfterMs) || parsed.degradeAfterMs <= 0) {
    return { present: false, reason: 'bad', error: `degradeAfterMs 不是正数：${JSON.stringify(parsed.degradeAfterMs)}` }
  }
  return { present: true, state: parsed }
}

/**
 * 纯判据：`远端存在 OR 降级模式`。**必须与 `dsh-fde-memory/lib/telemetry-sink.js` 的同名函数同解。**
 *
 * @param {object} state
 * @param {number} now
 * @returns {{status: 'present'|'degraded'|'missing', outageMs: number|null, reason: string}}
 */
export function evaluateRemote(state, now) {
  if (state.outageSince === null) {
    if (state.lastDeliveredAt !== null) {
      return { status: 'present', outageMs: null, reason: `最后一次投递成功于 ${state.lastDeliveredAt}，无未恢复中断` }
    }
    return {
      status: 'missing',
      outageMs: null,
      reason: '从未成功投递过（没有"远端存在"的证据）—— 首次投递成功前判为不满足'
    }
  }
  const since = Date.parse(state.outageSince)
  if (!Number.isFinite(since)) {
    return { status: 'missing', outageMs: null, reason: `outageSince 不是可解析的时间：${JSON.stringify(state.outageSince)}` }
  }
  const outageMs = Math.max(0, now - since)
  if (outageMs >= state.degradeAfterMs) {
    return {
      status: 'degraded',
      outageMs,
      reason: `远端中断已 ${(outageMs / 3600000).toFixed(2)}h（≥ 阈值 ${(state.degradeAfterMs / 3600000).toFixed(2)}h）⇒ 进入降级模式`
    }
  }
  return {
    status: 'missing',
    outageMs,
    reason: `远端中断 ${(outageMs / 3600000).toFixed(2)}h，未达降级阈值 ${(state.degradeAfterMs / 3600000).toFixed(2)}h ⇒ 正常等待远端`
  }
}

/**
 * 给 guard 用的**一步到位**判据：从 config 的路径读到判定。
 *
 * ⚠️ **路径为空 ⇒ `applicable: false`**（部署方没配外置审计 ⇒ 这条括号**不适用**，
 *   不是"不满足"）。这是刻意的：把"没配"判成"不满足"会让**所有没配外置审计的部署
 *   在 Phase 4 永久卡死** —— 那正是 spec §8 要修的那类死锁（v2 的 D4「远端不可达 = 永远不过」）。
 *
 * ⚠️ 路径**配了**但读不出来（`bad`/`schema`/`empty`）⇒ `status:'missing'`（**fail-closed**）。
 *   "读不到"绝不能当成"没问题"：那会把盲区说成事实。
 *
 * @param {string} statePath - config 的 `telemetryStatePath`（可为空串）
 * @param {number} now
 * @returns {{applicable: boolean, status: 'present'|'degraded'|'missing', reason: string, outageMs?: number|null}}
 */
export function crossCheckRemoteSync(statePath, now) {
  if (typeof statePath !== 'string' || statePath === '') {
    return { applicable: false, status: 'present', reason: '未配置 telemetryStatePath ⇒ 外置审计交叉校验不适用（本地链完整即为完整）' }
  }
  const r = readRemoteStateSync(statePath)
  if (!r.present) {
    return {
      applicable: true,
      status: 'missing',
      reason: `读不到外置审计降级状态（${r.reason}${r.error ? '：' + r.error : ''}）⇒ 无法证明"远端存在或已降级"`
    }
  }
  const v = evaluateRemote(r.state, now)
  return { applicable: true, status: v.status, reason: v.reason, outageMs: v.outageMs }
}
