/**
 * break-glass 放行表 —— **内存镜像**（guard 同步读它，不碰 IO）。
 *
 * 🔴 **本文件在 `dsh-fde-phase` 与 `dsh-fde-ontology-gate` 各有一份，必须逐字相同。**
 *    同 `deny-ids.js` 的理由（跨包不能 import），由 `_fde_e1_crosspkg_test.mjs` 逐字对拍。
 *
 * 形态与 `mirror.js` 的 `D1Mirror` **刻意同构**（这不是巧合，是同一个问题的同一个解）：
 *   ① 运行时：`ctx.on('fde/break-glass')` 收到 phase 广播 → `update(payload)`
 *   ② 重启后：`apply()` 期 `restoreSync(自己的审计链)` 同步扫尾部重建
 *   ③ guard：`isBypassed(id, anchorFn)` —— 纯同步、只读内存
 *
 * 🔴 **为什么每个插件各持一份、各写自己的链**：guard 是**同步**的、碰不了 IO；
 *    而跨插件只有 `ctx.emit`/`ctx.on`。若只让 phase 持表，gate 重启后会**丢失放行**
 *    （phase 不会重新广播）⇒ 行为依赖"谁先起来"。各写各的链 ⇒ 重启顺序无关。
 *
 * ⚠️ 链记录用 **camelCase**（与 gate 链既有的 `autoLevel`/`callId` 一致）；
 *    YAML 文件用 snake_case（与 `state.yaml` 一致）。转换只发生在写/读的两端。
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { TAIL_BYTES } from './audit.js'
import { ANCHORED_DENY_IDS, BYPASSABLE_DENY_IDS } from './deny-ids.js'

/**
 * 链上表示"砸了一次玻璃"的记录类型。**三种类型共同构成一条记录的生命周期**：
 *   `break-glass`            —— 砸了（open）
 *   `break-glass-bypass`     —— 这次调用**真的**因为它被放行了（不是状态变更，是使用留痕）
 *   `break-glass-resolved`   —— 该门禁后来自己通过了 ⇒ 补正完成
 */
export const BG_CHAIN_TYPES = Object.freeze({
  OPEN: 'break-glass',
  BYPASS: 'break-glass-bypass',
  RESOLVED: 'break-glass-resolved'
})

export class BreakGlassMirror {
  /** @type {Map<string, {id:string, denyId:string, category:string, reason:string, at:string, expiresAt:string, anchor:string|null, status:'open'|'resolved', resolvedAt:string|null}>} */
  #records = new Map()

  /**
   * 只读取一条（调试/断言用）。
   * @param {string} id
   */
  get(id) {
    return this.#records.get(id)
  }

  /** 表内记录条数（含已 resolved）。 */
  size() {
    return this.#records.size
  }

  /**
   * apply 期同步恢复。
   *
   * ⚠️ **只覆盖尾部窗口**（`TAIL_BYTES`，与 `D1Mirror.restoreSync` 同一取舍）：
   *    窗口外的 `break-glass` 读不到 ⇒ 那条放行在重启后**静默失效**。
   *    方向是**保守的**（少放行 = 更难绕过），但必须在 README 写明。
   *    窗口内的 `break-glass-resolved` 一定读得到（它比 open 晚），所以不会出现
   *    "已补正却被当成还开着"。
   *
   * @param {string} [auditPath] - **本插件自己的**审计链路径
   */
  restoreSync(auditPath) {
    if (!auditPath) return
    let fd
    try {
      const { size } = statSync(auditPath)
      if (size === 0) return
      fd = openSync(auditPath, 'r')
      const length = Math.min(size, TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      for (const line of buffer.toString('utf8').split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const rec = JSON.parse(t)
          if (rec.type === BG_CHAIN_TYPES.OPEN && rec.id) {
            this.#records.set(rec.id, {
              id: rec.id,
              denyId: String(rec.denyId ?? ''),
              category: String(rec.category ?? ''),
              reason: String(rec.reason ?? ''),
              at: String(rec.at ?? ''),
              expiresAt: String(rec.expiresAt ?? ''),
              anchor: typeof rec.anchor === 'string' ? rec.anchor : null,
              status: 'open',
              resolvedAt: null
            })
          } else if (rec.type === BG_CHAIN_TYPES.RESOLVED && rec.id) {
            const cur = this.#records.get(rec.id)
            if (cur) {
              cur.status = 'resolved'
              cur.resolvedAt = String(rec.at ?? '')
            }
            // 窗口内只有 resolved、没有 open：无需建墓碑 —— 没有 open 记录本来就不放行。
          }
        } catch {
          // 残行/损坏行：跳过，继续向前找（与 D1Mirror 同）
        }
      }
    } catch {
      // 文件不存在/不可读 ⇒ 空表（= 不放行任何东西，fail-closed）
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // 关闭失败不影响恢复结果
        }
      }
    }
  }

  /**
   * 事件驱动更新（`fde/break-glass` 监听器 / 本地工具写入后调用）。
   *
   * @param {{id:string, denyId:string, category?:string, reason?:string, at:string, expiresAt:string, anchor?:string|null, resolved?:boolean}} payload
   */
  update(payload) {
    if (!payload || !payload.id) return
    // ⚠️ `resolved` 分支只认 `id` —— 标补正时调用方手上未必还有 `denyId`
    //    （它可能只从 guard 拿到了一个 id 列表）。若把 `denyId` 的检查提到前面，
    //    这条会**静默不生效**：镜像里永远 open、放行永远不失效。
    if (payload.resolved === true) {
      const cur = this.#records.get(payload.id)
      if (cur) {
        cur.status = 'resolved'
        cur.resolvedAt = String(payload.at ?? '')
      }
      return
    }
    if (!payload.denyId) return
    this.#records.set(payload.id, {
      id: payload.id,
      denyId: String(payload.denyId),
      category: String(payload.category ?? ''),
      reason: String(payload.reason ?? ''),
      at: String(payload.at ?? ''),
      expiresAt: String(payload.expiresAt ?? ''),
      anchor: typeof payload.anchor === 'string' ? payload.anchor : null,
      status: 'open',
      resolvedAt: null
    })
  }

  /**
   * **放行判定**（guard 同步调用）。
   *
   * 三个条件全部满足才算放行：
   *   ① 存在该 `denyId` 的**未补正**记录
   *   ② 若该 id 属**带锚点**的一类：当前指纹必须与记录时的**逐字相同**
   *   ③ （**不检查** `expiresAt` —— 见下）
   *
   * 🔴 **超期不撤销放行**（有意）：spec §11 R7 只说"持续红色警告 + 计入指标"，**没说撤销**。
   *    撤销会让 FDE 在客户现场**再次被卡死**，与 break-glass 的立意相悖。
   *    代价 = "永远被记着 + 红色"，那是这个机制要的。
   *
   * 🔴 **算不出当前锚点 ⇒ 不放行**（fail-closed）。锚点算不出来（文件没了/读不动）
   *    正是"内容可能已经变了"的最坏情形，此时认这条放行等于用旧指纹给新内容背书。
   *
   * @param {string} denyId
   * @param {(denyId: string) => string|null} [anchorFn] - 同步算当前内容指纹；返回 null/抛错 ⇒ 不放行
   * @returns {boolean}
   */
  isBypassed(denyId, anchorFn) {
    // ⓪ **不可绕的 id 直接短路为 false**（2026-09-29 补，实测抓出来的）。
    //
    // 🔴 这条**不是**冗余：`fde-break-glass` 的 `enum` 只是**工具面**的一道闸，
    //    而本函数是**消费侧**的闸。两者之间隔着 `break-glass.json` 这个**可被手改的文件**
    //    与一次 JSON 解析 —— 表里出现 `GATE-PTC` 的路径至少有：人工编辑、把别的记录
    //    改错字段、将来某个工具实现 bug。**只要表里有，这里就会放行。**
    //    实测：把 `GATE-PTC` 硬塞进表（跳过 enum），改前本函数返回 true ⇒ PTC 被放行。
    //    ⇒ 现在把"哪些 id 可绕"这个事实**钉在消费侧**，不依赖"表里恰好没有"这个巧合。
    //    （同族教训：断言域 ≠ 验证域 —— 我原先在 gate/guard.js 的注释里写了
    //     "双保险"，但那个"保险"当时并不存在。）
    if (!BYPASSABLE_DENY_IDS.includes(denyId)) return false

    for (const r of this.#records.values()) {
      if (r.denyId !== denyId) continue
      if (r.status !== 'open') continue
      if (ANCHORED_DENY_IDS.includes(denyId)) {
        if (typeof r.anchor !== 'string' || r.anchor === '') return false
        let cur = null
        try {
          cur = typeof anchorFn === 'function' ? anchorFn(denyId) : null
        } catch {
          return false
        }
        if (typeof cur !== 'string' || cur === '' || cur !== r.anchor) return false
      }
      return true
    }
    return false
  }

  /**
   * 未补正记录（按 `at` 升序）—— 给会话提醒（R6）与回执用。
   * @returns {Array<object>}
   */
  openRecords() {
    return [...this.#records.values()]
      .filter((r) => r.status === 'open')
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  }

  /**
   * 超期未补正（R7）。**派生量，不写盘** —— 写盘会让"超期"变成需要维护的状态，
   * 而它本来就是 `now` 的函数（同 `state.js` 的 `inObservation` 取舍）。
   *
   * @param {number} [nowMs]
   * @returns {Array<object>}
   */
  overdueRecords(nowMs = Date.now()) {
    return this.openRecords().filter((r) => {
      const t = Date.parse(r.expiresAt)
      return Number.isFinite(t) && nowMs > t
    })
  }
}
