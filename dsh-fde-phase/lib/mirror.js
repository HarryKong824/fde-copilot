/**
 * D1 结论的内存镜像（施工单 §5.5 / §4 步骤 2-3）。
 *
 * 为什么需要它：guard 是**同步**的，写不了文件、也读不了审计链。
 * 所以 D1 的结论必须常驻内存，guard 只比对内存里的值。
 *
 * 数据来源有两条：
 *   ① 运行时：`ctx.on('fde/check-result')` 收到 dsl 广播 → `update(payload)`。
 *   ② 重启后：`restoreSync(auditPath)` 读审计文件尾部，重建最近一条 D1 结论。
 *
 * 🔴 关键性质（设计要点，写进 README）：**改了 actions.yaml / guards.yaml 任一文件 → 结论必然失效**。
 *   实现方式：`update` 时记下 `anchor`（复合哈希，覆盖两文件），guard 的 `verify`
 *   同步重算两文件复合 sha256 与 anchor 比对；不一致或 alg 形态过期即 deny（fail-closed）。
 *   这正是要的性质：D1 结论必须绑定"当前 ontology 内容"，内容一变就作废。
 */

import { createHash } from 'node:crypto'
import { readFileSync, openSync, readSync, statSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { D2_ANCHOR_ALG, auditChainFingerprintSync } from './check-d2.js'
import { D5_ANCHOR_ALG, complianceFingerprintSync } from './check-d5.js'

const TAIL_BYTES = 65536

/**
 * **按 check 分派的锚点算法表**（Stage 5.5）。
 *
 * 🔴 改这里必须同时改 `dsh-fde-dsl/lib/tools.js` 里那张同名表 ——
 * 两个插件各有一份字面量（详见那里为什么不能共享），靠 `_fde_d2d3_test.mjs` 的
 * "两侧逐项相同"用例机器钉住，不再靠人肉同步。
 *
 * 为什么必须**分派**：早期实现恒用 D1 的 alg 去比 ⇒ D3 的结论会被 D1 的判定口径
 * 判过期 / 反过来也可能被判新鲜。**每个 check 锚自己的文件，就只能按 check 取 alg。**
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ANCHOR_ALGS = Object.freeze({
  /** D1：actions.yaml + guards.yaml 的复合 sha256（第二轮起的已验收形态）。 */
  D1: 'sha256(actions+\u0000+guards)@v2',
  /** D3：objects.yaml + logic.yaml 的复合 sha256（规则↔实现一致性，规则在这两个文件里）。 */
  D3: 'sha256(objects+\u0000+logic)@v1',
  /** D2：gate 审计链的行数 + 链头 hash（唯一定义处见 `check-d2.js`）。 */
  D2: D2_ANCHOR_ALG,
  /** D5：compliance.yaml 的 sha256 + 行数 + 非空键（唯一定义处见 `check-d5.js`）。 */
  D5: D5_ANCHOR_ALG
})

/** 兼容旧引用：单一常量时代的名字保留为 D1 那一项。 */
export const ANCHOR_ALG = ANCHOR_ALGS.D1

/** 每个 check 各自的重跑工具名 —— deny 文案要指路到具体工具，而不是一律叫你去跑 D1。 */
export const TOOL_BY_CHECK = Object.freeze({
  D1: 'fde-run-guardrails-check',
  D3: 'fde-run-validation',
  D2: 'fde-run-audit-check',
  D5: 'fde-run-compliance-check'
})

/** 复合锚点哈希：parts 按 \u0000 连接后取 sha256（与 dsl 端 emit 时的算法一致）。 */
export function compositeAnchorSha(parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

/**
 * D1 结论镜像。
 */
export class D1Mirror {
  /** @type {Map<string, {passed:boolean, anchor?:{alg:string, files:string[], sha256:string}, detail?:string, at?:string, seq?:number}>} */
  #conclusions = new Map()

  /**
   * 只读接口（guard 用）：取某 check 当前结论。
   * @param {string} check
   */
  get(check) {
    return this.#conclusions.get(check)
  }

  /**
   * apply 期同步读审计尾部，恢复最近一条 `check-result` 结论（按 check 分组取最后一条）。
   * 用同步 IO：只在 apply 期跑一次、最多 64KiB，不值得异步化。
   * @param {string} [auditPath]
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
      const lines = buffer.toString('utf8').split('\n')
      for (const line of lines) {
        const t = line.trim()
        if (!t) continue
        try {
          const rec = JSON.parse(t)
          if (rec.type === 'check-result' && rec.check && rec.anchor) {
            this.#conclusions.set(rec.check, {
              passed: !!rec.passed,
              anchor: rec.anchor,
              detail: rec.detail,
              at: rec.at,
              seq: rec.seq
            })
          }
        } catch {
          // 残行/损坏行：继续向前找
        }
      }
    } catch {
      // 文件不存在或不可读 → 空镜像（无 D1 结论 = fail-closed）
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
   * 事件驱动更新（fde/check-result 监听器调用）。
   * @param {{check:string, passed:boolean, anchor?:{alg:string, files:string[], sha256:string}, detail?:string, at?:string, seq?:number}} payload
   */
  update(payload) {
    if (!payload || !payload.check) return
    this.#conclusions.set(payload.check, {
      passed: !!payload.passed,
      anchor: payload.anchor,
      detail: payload.detail,
      at: payload.at,
      seq: payload.seq
    })
  }

  /**
   * 三种 check 共用的前置判定：**有没有结论 / 上次是否通过 / 锚点 alg 是不是这个 check 该有的**。
   *
   * @param {string} check
   * @returns {{c?: object, alg?: string, tool?: string, error?: {ok:false, reason:string}}}
   */
  #common(check) {
    const c = this.#conclusions.get(check)
    const tool = TOOL_BY_CHECK[check] ?? `对应的 ${check} 检查工具`
    if (!c) {
      return { error: { ok: false, reason: `无 ${check} 结论（尚未跑过 ${tool}）` } }
    }
    if (!c.passed) {
      return { error: { ok: false, reason: `${check} 上次结论为未通过` } }
    }
    const alg = ANCHOR_ALGS[check]
    if (!alg) {
      // fail-closed：登记成了"已实现"却没有锚点算法定义 ⇒ 不知道该拿什么比 ⇒ 不许放行。
      return { error: { ok: false, reason: `${check} 未定义锚点算法（拒绝放行而非猜测比对方式）` } }
    }
    if (!c.anchor || typeof c.anchor.sha256 !== 'string') {
      return { error: { ok: false, reason: `${check} 结论锚点缺失（请重跑 ${tool}）` } }
    }
    if (c.anchor.alg !== alg) {
      return {
        error: {
          ok: false,
          reason: `${check} 结论的 anchor.alg = ${String(c.anchor.alg)}，而 ${check} 应当是 ${alg}（锚点形态不匹配，请重跑 ${tool}）`
        }
      }
    }
    return { c, alg, tool }
  }

  /**
   * **文件复合锚点**型 check（D1 / D3）的同步校验。
   *
   * 同步重算 filePaths 里各文件的复合 sha256，与镜像里的 anchor 比对。
   *
   * @param {string} check
   * @param {string[]} filePaths - `[join(ontologyRoot,'actions.yaml'), join(ontologyRoot,'guards.yaml')]`（D1）
   *                              或 `[…/objects.yaml, …/logic.yaml]`（D3）
   * @returns {{ok: boolean, reason?: string, currentSha?: string}}
   */
  verify(check, filePaths, expected) {
    const common = this.#common(check)
    if (common.error) return common.error
    const { c, tool } = common

    // D5：锚点是 (sha256, len, nonempty) 三元组，不是文件复合哈希。
    if (check === 'D5') {
      if (!expected || typeof expected.sha256 !== 'string' || typeof expected.len !== 'number' || typeof expected.nonempty !== 'number') {
        return { ok: false, reason: 'D5 需要 expected = {sha256, len, nonempty}' }
      }
      if (expected.sha256 !== c.anchor.sha256 || expected.len !== c.anchor.len || expected.nonempty !== c.anchor.nonempty) {
        return {
          ok: false,
          reason: 'D5 结论与当前 compliance.yaml 不符（文件已变更），需重新跑 ' + tool,
          currentSha: expected.sha256
        }
      }
      return { ok: true, currentSha: expected.sha256 }
    }

    let currentSha
    try {
      const parts = filePaths.map((p) => readFileSync(p, 'utf8'))
      currentSha = compositeAnchorSha(parts)
    } catch (e) {
      return { ok: false, reason: '无法读取 ' + filePaths.join(', ') + '：' + String(e?.message ?? e) }
    }
    if (currentSha !== c.anchor.sha256) {
      return {
        ok: false,
        reason: check + ' 结论与当前内容不符（锚定的文件已变更），需重新跑 ' + tool,
        currentSha
      }
    }
    return { ok: true, currentSha }
  }

  /**
   * **审计链锚点**型 check（D2）的同步校验。
   *
   * 比的是 `(行数, 链头 hash)`：任何一个变了 ⇒ 链被动过 ⇒ D2 结论过期。
   * ⚠️ 这只是**新鲜度**判定（自上次深验以来有没有变），完整性本身由 `fde-run-audit-check`
   * 跑 `runD2Check` 证明 —— guard 是同步的，不能在推进那一刻全链路重算（见 README §D2 边界）。
   *
   * @param {string} check
   * @param {string} chainPath - gate 审计链路径（来自 config 的 `gateAuditPath`）
   * @returns {{ok: boolean, reason?: string, currentSha?: string, currentLen?: number}}
   */
  verifyChain(check, chainPath) {
    const common = this.#common(check)
    if (common.error) return common.error
    const { c, tool } = common
    if (ANCHOR_ALGS[check] !== D2_ANCHOR_ALG) {
      return {
        ok: false,
        reason: `${check} 不是审计链型锚点（它是 ${ANCHOR_ALGS[check]}），不能用 verifyChain 比对`
      }
    }

    let fp
    try {
      fp = auditChainFingerprintSync(chainPath)
    } catch (e) {
      // fail-closed：验不出完整性 = 不能证明它完整。
      return { ok: false, reason: `${check} 无法读取 gate 审计链：${String(e?.message ?? e)}` }
    }
    if (c.anchor.len !== fp.len) {
      return {
        ok: false,
        reason:
          `${check} 结论已过期：gate 审计链行数从 ${c.anchor.len} 变成 ${fp.len}（期间有新记录写入或被截断）`,
        currentLen: fp.len,
        currentSha: fp.sha256
      }
    }
    if (c.anchor.sha256 !== fp.sha256) {
      return {
        ok: false,
        reason: `${check} 结论已过期：gate 审计链链头 hash 与结论记录的不一致（链被改写过）`,
        currentLen: fp.len,
        currentSha: fp.sha256
      }
    }
    return { ok: true, currentSha: fp.sha256, currentLen: fp.len, tool }
  }
}

/** 计算一段文本的 sha256（供 dsl check-d1 填 anchor 用，避免重复实现）。 */
export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}
