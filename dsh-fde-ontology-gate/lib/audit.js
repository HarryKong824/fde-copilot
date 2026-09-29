import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 哈希链审计。
 *
 * **只能在 `tools/pre-execute`（async waterfall）里调，不能在 guard 里调** ——
 * guard 是同步的，碰不了 IO。这是本骨架把"判定"和"留痕"拆成两个模块的原因。
 *
 * 落盘失败不抛：进内存 outbox 待重放。
 * 这是有意的取舍 —— 审计故障不应该让 agent 全线停摆（fail-open on audit）。
 * 合规场景若要 fail-closed，把 onWriteError 改成拒绝即可，见 README。
 */

const GENESIS = '0'.repeat(64)

/**
 * 恢复链头时从文件尾部最多回读的字节数（足以容纳若干超长审计行）。
 *
 * 🔴 **导出**（E1 起）：`bg-mirror.js` 要拿它做 break-glass 放行表的尾部恢复窗口。
 *    该文件与 `dsh-fde-phase/lib/bg-mirror.js` **必须逐字相同**，而 phase 的 `audit.js`
 *    本来就导出这个常量 —— 若这边不导出，那份副本就得自己再写一个字面量，
 *    于是同一个魔数有了第三份拷贝。导出它，让两边同源。
 */
export const TAIL_BYTES = 65536

/**
 * 把一条记录接到链上。记录本身不含 prevHash/hash，两者在写入时才计算。
 * @param {string} prevHash
 * @param {object} record
 * @returns {string}
 */
function linkHash(prevHash, record) {
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(JSON.stringify(record))
    .digest('hex')
}

export class AuditChain {
  /** @type {string} 上一条的 hash */
  #head = GENESIS
  /** @type {string[]} 落盘失败、待重放的行。**内存**数组，进程退出即丢。 */
  #outbox = []
  /**
   * **上一次 `appendFile` 失败后置位** ⇒ 后续记录一律进 outbox、不再尝试写盘，直到 `flush()` 成功。
   *
   * 没有这道闸会出现"**成功记录跨过失败记录**"：`A ✅ → B ❌（outbox）→ C ✅` ⇒ 磁盘上是 `A → C`，
   * 而 `C.prevHash` 指向只存在于内存的 `HB` ⇒ **假断链**（0011 §3 ①，2026-09-26 移植自 phase 补丁 3）。
   * 副作用刻意保留：写盘持续失败期间链停在最后成功点 —— **宁可"审计停止前进"，不可"前进了但是假的"**。
   */
  #degraded = false
  /** @type {string} 落盘路径，空串表示只驻内存 */
  #path
  /** @type {number} 单调序号 */
  #seq = 0

  /**
   * @param {string} [path] 落盘路径，留空则只驻内存（PoC 默认）
   *
   * 缺陷 ② 修复：指定路径时，构造即从文件尾部恢复链头（prevHash）与 seq 起点，
   * 插件热重载后**接续旧链**而不是从全零重开 —— 否则一次 mode 改动（热重载）就会
   * 把审计打成两条互不相连的链：尾部截断不可检测、seq 复用、回执定位失效。
   * 文件不存在/为空/尾部无一行可解析时，才回落到全零起点（新链）。
   */
  constructor(path = '') {
    this.#path = path
    if (path !== '') this.#restoreFromTail()
  }

  /**
   * 同步读文件尾部，恢复链头（prevHash）与序号起点（seq）。
   * 用同步 IO：只在插件 apply 期跑一次、最多 64KiB，不值得异步化。
   *
   * **两个量分两遍取，不能混在一次扫描里定位**（这是两个不同的"最后一条"）：
   * - `#head` = 最后一条 **hash 合法**的行 —— 必须是真正的末行，错一行就分叉（P2-3）；
   * - `#seq`  = 窗口内**出现过的最大 seq** —— 末行可能没有 seq（老格式 / 别的写入方），
   *   此时应从前面继承而不是回落，否则新记录与前一条重号（P1-1）。
   *
   * ⚠️ 极易被误读成"它校验过 prevHash"：**没有**。这里读的是 prevHash 之外的东西，
   * 链完整性由外部校验器（逐条比 prevHash）判定，本方法只管"从哪里接着写"。
   */
  #restoreFromTail() {
    let needsNewline = false
    let fd
    try {
      const { size } = statSync(this.#path)
      if (size === 0) return
      fd = openSync(this.#path, 'r')
      const length = Math.min(size, TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      needsNewline = buffer[length - 1] !== 0x0a
      const lines = buffer.toString('utf8').split('\n')

      // ---- 第一遍：窗口内出现过的**最大 seq** ----
      // 即使末行缺 seq，序号也不回落、不与已有记录重号。`（审计 #N）` 靠 seq 唯一定位一行，
      // 重号 = 回执指向错行；这是合规件的底线性质，不是美观问题（P1-1）。
      // maxSeq 为 0（新文件 / 全是老格式）时首条记录仍是 seq 1，行为不变。
      let maxSeq = 0
      for (const raw of lines) {
        const line = raw.trim()
        if (line.length === 0) continue
        try {
          const parsed = JSON.parse(line)
          if (Number.isInteger(parsed.seq) && parsed.seq > maxSeq) maxSeq = parsed.seq
        } catch {
          // 残行/损坏行：跳过
        }
      }
      this.#seq = maxSeq

      // ---- 第二遍：从尾部向前找最后一条 hash 合法的行作为链头 ----
      // 判据只认 hash 是否为合法 64 位 hex，**不强制 seq** —— 否则末行缺 seq 会被跳过、
      // 链头落到上一条，新记录与真正的末行争抢同一 prevHash ⇒ **真分叉**（P2-3）。
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (line.length === 0) continue
        try {
          const parsed = JSON.parse(line)
          if (typeof parsed.hash === 'string' && /^[0-9a-f]{64}$/.test(parsed.hash)) {
            this.#head = parsed.hash
            // break 而非 return：换行补写（needsNewline）必须照常执行
            break
          }
        } catch {
          // 残行/损坏行：继续向前找最后一条完整记录
        }
      }
    } catch {
      // 文件不存在或不可读 → 保持全零起点（新链）
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // 关闭失败不影响恢复结果
        }
      }
    }
    if (needsNewline) {
      try {
        appendFileSync(this.#path, '\n')
      } catch {
        // 补换行失败：留给下一次 append 面对残行
      }
    }
  }

  /**
   * 追加一条审计记录。
   * @param {object} entry - 记录正文（tool / decision / reason / paths 等）
   * @returns {Promise<{seq: number, hash: string, persisted: boolean, error?: string}>}
   */
  async record(entry) {
    // 防御：剥离 entry 自带的 seq（若含 undefined，会在展开时覆盖自动编号，
    // 导致落盘记录缺 seq → 重启恢复跳过末行 → 审计链分叉，见 P2-3）。
    // 审计序号永远由 AuditChain 单调自增，调用方不得注入。
    const { seq, ...rest } = entry
    const record = { seq: ++this.#seq, ts: new Date().toISOString(), ...rest }
    const hash = linkHash(this.#head, record)
    const line = JSON.stringify({ ...record, prevHash: this.#head, hash })
    this.#head = hash

    if (this.#path === '') return { seq: record.seq, hash, persisted: false }

    // 🔴 **排队闸（2026-09-26，移植自 phase 补丁 3）**：只要上一条没写进磁盘，
    // 本条就**不许抢先写** —— 否则磁盘上出现 `A → C`，而 `C.prevHash` 指向只存在于内存的 `HB`
    // ⇒ 悬空 prevHash（假断链），外部校验器会报"链断了/被篡改"，而链其实没被改过。
    if (this.#degraded) {
      this.#outbox.push(line)
      return {
        seq: record.seq,
        hash,
        persisted: false,
        queuedBehind: true,
        reason: '前一条尚未落盘 ⇒ 本条一并排队（保序），不得抢先写盘造成假断链'
      }
    }

    try {
      await mkdir(dirname(this.#path), { recursive: true })
      await appendFile(this.#path, line + '\n', 'utf8')
      return { seq: record.seq, hash, persisted: true }
    } catch (error) {
      this.#degraded = true
      this.#outbox.push(line)
      return {
        seq: record.seq,
        hash,
        persisted: false,
        error: String(error?.message ?? error)
      }
    }
  }

  /**
   * 重放 outbox。**按原始顺序**补写；只要还有没写进去的，`#degraded` 保持为真
   * ⇒ 期间到达的新记录继续排队（否则又会插到已失败记录前面去）。
   * @returns {Promise<number>} 仍未成功的条数
   */
  async flush() {
    if (this.#path === '' || this.#outbox.length === 0) return this.#outbox.length
    const pending = this.#outbox
    this.#outbox = []
    const failed = []
    for (const line of pending) {
      try {
        await mkdir(dirname(this.#path), { recursive: true })
        await appendFile(this.#path, line + '\n', 'utf8')
      } catch {
        failed.push(line)
      }
    }
    // 失败的按**原序放回队首**：flush 期间新进的记录排在它们之后 ⇒ 顺序仍然不乱。
    if (failed.length > 0) this.#outbox = failed.concat(this.#outbox)
    this.#degraded = this.#outbox.length > 0
    return this.#outbox.length
  }

  /** 待重放条数。 */
  get pending() {
    return this.#outbox.length
  }

  /** 当前链头 hash。 */
  get head() {
    return this.#head
  }

  /** 已记录条数。 */
  get count() {
    return this.#seq
  }
}
