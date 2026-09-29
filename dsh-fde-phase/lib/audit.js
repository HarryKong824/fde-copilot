import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 哈希链审计 —— **格式照搬 gate 的 `lib/audit.js`**（施工单 §4 明确要求）。
 *
 * 只能在 `tools/pre-execute`（async waterfall）里调 `record()`，不能在 guard 里调
 * —— guard 是同步的，碰不了 IO。这是把"判定"和"留痕"拆成两个模块的原因。
 *
 * 落盘失败不抛：进内存 outbox 待重放。
 * 这是有意的取舍 —— 审计故障不应该让 agent 全线停摆（fail-open on audit）。
 * 合规场景若要 fail-closed，把 onWriteError 改成拒绝即可（见 README）。
 */

/**
 * 新链的哨兵链头（全零）。
 * 导出给上层判断"这是新链还是续接旧链" —— **只能拿 `#head` 跟它比，不能拿 `count === 0` 判断**：
 * 文件有内容但恢复不出 seq 时 count 也会是 0，那却是**正确续接**（见 index.js 挂载日志，P2-1）。
 */
export const GENESIS = '0'.repeat(64)

/**
 * 恢复链头时从文件尾部最多回读的字节数（足以容纳若干超长审计行）。
 *
 * ⚠️ 它同时是「按 agent 查最近一条 restrict 决策」的**可见窗口**（第四批）：窗口外的记录查不到
 * ⇒ 上层必须把它当成"未知"而不是"没有"（`tailTruncated` 就是给上层判这个的）。
 * 导出是为了让离线用例能精确构造"超出窗口"的长链，**不是**给生产代码调窗口大小用的。
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
  /** @type {string[]} 落盘失败、待重放的行。**内存**数组，进程退出即丢（见 §6.6 第 7 条）。 */
  #outbox = []
  /**
   * **上一次 `appendFile` 失败后置位** ⇒ 后续记录一律进 outbox、不再尝试写盘，直到 `flush()` 成功。
   *
   * 没有这道闸会出现"**成功记录跨过失败记录**"：`A ✅ → B ❌（outbox）→ C ✅` ⇒ 磁盘上是 `A → C`，
   * 而 `C.prevHash` 指向只存在于内存的 `HB` ⇒ **假断链**（README §6.6 第 8 条，2026-09-26 补丁 3）。
   */
  #degraded = false
  /** @type {string} 落盘路径，空串表示只驻内存 */
  #path
  /** @type {number} 单调序号 */
  #seq = 0
  /**
   * @type {Map<string, {seq:number|null, decision:string|null, phase:string|null, denied:string[]|null, appliedSeq:number|null}>}
   * `agent → 该 agent 最近一条 restrict 决策`（第四批）。构造期从尾部窗口建，`record()` 增量更新 ⇒ 零额外 IO。
   *
   * `appliedSeq` = 该 agent **最后一条 `restrict-applied`** 的 seq（`restored` 的 `from` 用它，0005 §1.3）。
   * 它**不随** `restored` / `untracked` 等决策推进 ⇒ 多次重启后仍指最初那条 applied（不链式）。
   */
  #restrictIndex = new Map()
  /** 尾部窗口是否**未覆盖全链**（⇒ 上面的索引可能不完整，上层必须按"未知"处理）。 */
  #tailTruncated = false

  /**
   * @param {string} [path] 落盘路径，留空则只驻内存（PoC 默认）
   *
   * 指定路径时，构造即从文件尾部恢复链头（prevHash）与 seq 起点，
   * 插件热重载后**接续旧链**而不是从全零重开。
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
   * - `#seq`  = 窗口内**出现过的最大 seq** —— 末行常常没有 seq（历史 `check-result` 都缺），
   *   此时应从前面继承而不是回落 0，否则新记录从 1 重开、与已有记录撞号（P1-1）。
   */
  /**
   * 同步读文件尾部，切成 JSON 行数组 —— **唯一的尾部读取路径**（`#restoreFromTail()` 与 restrict
   * 索引共用它，不新开第二条），符合"单一读取路径"要求。
   *
   * @returns {{lines: string[], needsNewline: boolean, truncated: boolean}}
   *   `truncated` = 窗口**没有覆盖全链** ⇒ 由它建的索引不完整（第四批的 `restrict-history-miss` 就靠它）：
   *   ① 文件比 `TAIL_BYTES` 长 ⇒ 窗口前必然还有记录；
   *   ② 否则看窗口内**第一行可解析记录**的 `prevHash` 是否等于 GENESIS —— 不等于说明链在更早就开始了
   *   （文件被截断/轮转过），同样算截断。
   */
  #readTailLines() {
    let fd
    try {
      const { size } = statSync(this.#path)
      if (size === 0) return { lines: [], needsNewline: false, truncated: false }
      fd = openSync(this.#path, 'r')
      const length = Math.min(size, TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      const needsNewline = buffer[length - 1] !== 0x0a
      const lines = buffer.toString('utf8').split('\n')

      let truncated = size > TAIL_BYTES
      if (!truncated) {
        for (const raw of lines) {
          const line = raw.trim()
          if (line.length === 0) continue
          let parsed
          try {
            parsed = JSON.parse(line)
          } catch {
            continue // 残行：继续找第一行可解析的
          }
          if (typeof parsed?.prevHash === 'string') {
            truncated = parsed.prevHash !== GENESIS
            break
          }
        }
      }
      return { lines, needsNewline, truncated }
    } catch {
      return { lines: [], needsNewline: false, truncated: false }
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

  #restoreFromTail() {
    const { lines, needsNewline, truncated } = this.#readTailLines()
    this.#tailTruncated = truncated

    // ---- 第一遍：窗口内出现过的**最大 seq** ----
    // 即使末行缺 seq（历史上每条 check-result 都缺，而它恰好常是 D1 跑完后的末行），
    // 序号也不回落、不与已有记录重号。`（审计 #N）` 靠 seq 唯一定位一行，
    // 重号 = 回执指向错行；这是合规件的底线性质，不是美观问题（P1-1）。
    // maxSeq 为 0（新文件）时首条记录仍是 seq 1，行为不变。
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
    // 链头落到上一条，重启后新记录与真正的末行争抢同一 prevHash → 分叉（P2-3）。
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.length === 0) continue
      try {
        const parsed = JSON.parse(line)
        if (typeof parsed.hash === 'string' && /^[0-9a-f]{64}$/.test(parsed.hash)) {
          this.#head = parsed.hash
          break
        }
      } catch {
        // 残行/损坏行：继续向前找最后一条完整记录
      }
    }

    // ---- 第三遍（第四批）：建「agent → 最近一条 restrict 决策」索引 ----
    this.#buildRestrictIndex(lines)

    if (needsNewline) {
      try {
        appendFileSync(this.#path, '\n')
      } catch {
        // 补换行失败：留给下一次 append 面对残行
      }
    }
  }

  /** 用一批（尾部窗口内的）原始行建索引。 */
  #buildRestrictIndex(lines) {
    for (const raw of lines) {
      const line = raw.trim()
      if (line.length === 0) continue
      try {
        this.#indexRestrict(JSON.parse(line))
      } catch {
        // 残行：跳过
      }
    }
  }

  /**
   * 把一条记录并入索引（`record()` 与构造期共用 ⇒ **零额外 IO**）。
   * 只收 `type:'restrict'` 且带字符串 `agent` 的记录；后写的覆盖先写的（取"最近一条"）。
   *
   * 🔴 `appliedSeq` **只在 `decision === 'restrict-applied'` 时推进**，其余决策沿用旧值
   * （0005 §1.3：`from` 恒指"最后一条 applied" ⇒ 连续两次重启也不会变成 `restored → restored` 的链式指针）。
   * 窗口外的 applied 查不到 ⇒ `appliedSeq` 保持 `null` ⇒ 上层落 `from: null`（不编造源头）。
   */
  #indexRestrict(rec) {
    if (!rec || rec.type !== 'restrict') return
    const id = rec.agent
    if (typeof id !== 'string' || id === '') return
    const seq = Number.isInteger(rec.seq) ? rec.seq : null
    const prev = this.#restrictIndex.get(id)
    if (prev && Number.isInteger(prev.seq) && (seq === null || prev.seq > seq)) return
    const next = {
      seq,
      decision: typeof rec.decision === 'string' ? rec.decision : null,
      phase: rec.phase ?? null,
      denied: Array.isArray(rec.denied) ? [...rec.denied] : null,
      appliedSeq: prev?.appliedSeq ?? null
    }
    if (rec.decision === 'restrict-applied' && seq !== null) next.appliedSeq = seq
    this.#restrictIndex.set(id, next)
  }

  /**
   * `agent → 该 agent 最近一条 restrict 决策`（第四批；供 `RestrictGovernor` 判 `restored`）。
   *
   * ⚠️ 返回的是**拷贝**，调用方改它不影响本链。
   * ⚠️ **只覆盖尾部窗口**（`TAIL_BYTES`）：窗口外的历史查不到，此时必须配合 `tailTruncated`
   * 判"未知"，**不得**把"查不到"当成"没有历史"（那是把盲区说成事实）。
   *
   * @returns {Map<string, {seq:number|null, decision:string|null, phase:string|null, denied:string[]|null, appliedSeq:number|null}>}
   */
  latestRestrictByAgent() {
    return new Map(this.#restrictIndex)
  }

  /** 尾部窗口是否**未覆盖全链**（⇒ `latestRestrictByAgent()` 的结果可能不完整）。 */
  get tailTruncated() {
    return this.#tailTruncated
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
    this.#indexRestrict(record) // 增量更新（落盘失败也要更新：内存里的链头已经前进了）
    const hash = linkHash(this.#head, record)
    const line = JSON.stringify({ ...record, prevHash: this.#head, hash })
    this.#head = hash

    if (this.#path === '') return { seq: record.seq, hash, persisted: false }

    // 🔴 **排队闸（2026-09-26 补丁 3，见 README §6.6-8）**：只要上一条没写进磁盘，
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
