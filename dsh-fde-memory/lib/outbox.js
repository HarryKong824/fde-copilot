/**
 * 审计外置 **L2 —— outbox 文件队列**（spec 第八节 L2）+ **L4 的远端状态判据**（spec 第八节 L4）。
 *
 * spec 原文（§8）：
 *   「L2 outbox 队列  写入 memory/outbox/{seq}.json
 *     网络可用 → TelemetryBackend.emit → 投递成功则删除
 *     网络不可用 → 留在 outbox，下次启动重放」
 *
 * 🔴 **本文件里的「outbox」与 `lib/audit.js` 的 `#outbox` 是两个不同的东西**，别混：
 *   - `audit.js` 的 `#outbox` 是 **L1 的写盘失败内存缓冲**（`内存数组，进程退出即丢`）；
 *   - 本文件是 **L2 的文件队列**，落在 `<projectRoot>/memory/outbox/`，**跨进程存活**。
 *   二者的共同点只有"叫法" —— 一个丢了会假断链（靠排队闸防），一个丢了会重复投递（靠幂等键防）。
 *
 * 三个刻意的设计选择：
 *
 * ① **文件名就是 `{seq}.json`（不补零）** —— spec 原文如此。排序由 `listOutboxSync()` 按**数值**
 *    升序完成，不靠文件名的字典序（补零虽然能让字典序 == 数值序，但那就不是 spec 写的名字了）。
 *    ⇒ 读取侧**只认 `^[1-9][0-9]*\.json$`**，`.tmp` / `state.json` / 别的垃圾一律不算队列成员，
 *    且**各自计数**（`ignored`）—— 静默跳过会让"队列看起来是空的"这种假象没人能发现。
 *
 * ② **原子写**：先写 `<seq>.json.tmp` 再 `rename`。直接写目标文件的话，进程在写到一半时死掉
 *    会在队列里留下一个**半截 JSON** —— 而重放器读它会解析失败，于是"这条到底投递过没有"
 *    永远说不清。rename 保证读者只会看到"完整的"或"不存在的"。
 *
 * ③ **`state.json` 由本文件拥有**（写入者是 memory 插件，读者还有 phase 插件的 L4 判据）。
 *    ⇒ 它是**跨插件的文件格式契约**：键名/取值域改动 = 破坏 phase 的 L4。
 *    `dsh-fde-phase/lib/remote-state.js` 里有同一份字面量的**镜像**，由
 *    `_fde_d1_crosspkg_test.mjs` 逐字对拍钉住（同 `deny-ids.js` / `EXPERIMENTS_SUBDIR` 的做法：
 *    插件之间不 import，靠测试对拍）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** outbox 目录名（`<projectRoot>/memory/<这个>`）。spec §8 原文 `memory/outbox/{seq}.json`。 */
export const OUTBOX_SUBDIR = 'outbox'

/** 降级状态文件名（与队列同目录）。**跨插件契约的一部分** —— 改名字要同步改 phase 的镜像。 */
export const STATE_FILE = 'state.json'

/** `state.json` 的 `schema` 字段当前值。读取侧不认别的值（见 `readStateSync`）。 */
export const STATE_SCHEMA = 1

/** 临时文件后缀（写一半的产物）。**不是**队列成员。 */
const TMP_SUFFIX = '.tmp'

/** 队列成员的文件名判据。刻意不含 `0` —— seq 从 1 起（`AuditChain.#seq = 0` 再 `++`）。 */
const QUEUE_NAME_RE = /^[1-9][0-9]*\.json$/

/** `state.json` 里所有时间字段的形态（ISO-8601 字符串或 null）。 */
const ISO_OR_NULL = (v) => v === null || (typeof v === 'string' && v.length > 0)

/**
 * 空状态：没有任何一次投递、没有任何中断。
 *
 * 🔴 `degradeAfterMs` **存在这个文件里**（而不是各插件各配一份）是刻意的：
 * 阈值只有一个真源。phase 的 L4 判据读它、按 `outageSince` 现算 —— 否则
 * "降级该在什么时候生效"会变成两份配置谁都不认的漂移点，而且**在 24h 那一刻没有任何写入动作**，
 * 缓存成布尔值必然过期（读者会在阈值刚过时仍看到 `false`）。
 */
export function emptyState(degradeAfterMs) {
  return {
    schema: STATE_SCHEMA,
    updatedAt: null,
    lastDeliveredAt: null,
    lastAttemptAt: null,
    lastError: null,
    outageSince: null,
    degradedSince: null,
    /** 降级期间**成功投递**的条数 ⇒ 恢复时写成 "降级期间有 N 条事件待复核"。 */
    degradedDelivered: 0,
    /** 降级阈值（毫秒）。由 memory 插件的 config 写入；phase 读它现算 `degraded`。 */
    degradeAfterMs
    // ⚠️ **刻意没有 "降级期间通过了多少次 deny" 这个字段**。它一度在这里，去掉了，理由：
    //    那个数只有 phase 的 guard 知道，而**本文件的写者是 memory** —— 两方都写同一份 JSON
    //    就破了本项目"单写者"的纪律，而字段没有唯一维护者 = 迟早变成一个没人更新的谎。
    //    ⇒ 改记在 **phase 自己的审计链** 上（`type:'phase-advance'` 带 `degraded: true`）。
    //    要计数就从链上数（与 spec §14 其余指标同一口径：链是证据，报表是派生）。
  }
}

/** outbox 目录路径。 */
export function outboxRootOf(projectRoot) {
  return join(projectRoot, 'memory', OUTBOX_SUBDIR)
}

/** 某条记录在队列里的文件路径。`seq` 必须是正整数 —— 别的一律抛（fail-closed，不静默规范化）。 */
export function outboxFileOf(root, seq) {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`outbox: seq 必须是 ≥1 的整数，收到 ${JSON.stringify(seq)}`)
  }
  return join(root, `${seq}.json`)
}

/**
 * 把一条记录原子写进队列。
 *
 * @param {string} root - `outboxRootOf(projectRoot)`
 * @param {number} seq
 * @param {object} record
 * @returns {string} 写入的文件路径
 */
export function writeOutboxSync(root, seq, record) {
  const target = outboxFileOf(root, seq)
  const tmp = target + TMP_SUFFIX
  mkdirSync(root, { recursive: true })
  writeFileSync(tmp, JSON.stringify(record), 'utf8')
  // Windows 上 Node 的 rename 走 MoveFileEx(MOVEFILE_REPLACE_EXISTING) ⇒ 覆盖已存在文件。
  renameSync(tmp, target)
  return target
}

/**
 * 列出队列成员（**按 seq 数值升序**，不是文件名字典序）。
 *
 * @param {string} root
 * @returns {{seqs: number[], ignored: string[], tmpLeftovers: string[]}}
 *   `ignored` = 目录里既不是队列成员也不是 `.tmp` 的文件名（例如改过名/外来文件）；
 *   `tmpLeftovers` = 上次写到一半留下的 `.tmp`（进程被杀）。**单独一档**：
 *   它们意味着"有一条记录写残了"，与"有个不相干的文件躺在这儿"是两回事。
 */
export function listOutboxSync(root) {
  if (!existsSync(root)) return { seqs: [], ignored: [], tmpLeftovers: [] }
  const seqs = []
  const ignored = []
  const tmpLeftovers = []
  for (const name of readdirSync(root)) {
    if (QUEUE_NAME_RE.test(name)) seqs.push(Number(name.slice(0, -'.json'.length)))
    else if (name.endsWith(TMP_SUFFIX)) tmpLeftovers.push(name)
    else if (name !== STATE_FILE) ignored.push(name)
    // STATE_FILE 既不是成员也不是垃圾 —— 不计数，它本来就该在
  }
  seqs.sort((a, b) => a - b)
  return { seqs, ignored, tmpLeftovers }
}

/** 队列长度。 */
export function countOutboxSync(root) {
  return listOutboxSync(root).seqs.length
}

/**
 * 读一条队列记录。**解析失败返回 `{ok:false}` 而不是抛** ——
 * 重放器要能跳过坏条目继续投递后面的，而不是因为一条坏记录整个队列停摆。
 *
 * @returns {{ok: true, record: object} | {ok: false, error: string}}
 */
export function readOutboxSync(root, seq) {
  let text
  try {
    text = readFileSync(outboxFileOf(root, seq), 'utf8')
  } catch (e) {
    return { ok: false, error: `读不到 ${seq}.json：${String(e?.message ?? e)}` }
  }
  try {
    const record = JSON.parse(text)
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      return { ok: false, error: `${seq}.json 不是对象（是 ${Array.isArray(record) ? 'array' : typeof record}）` }
    }
    return { ok: true, record }
  } catch (e) {
    return { ok: false, error: `${seq}.json 不是合法 JSON：${String(e?.message ?? e)}` }
  }
}

/**
 * 投递成功后删除队列条目。
 * @returns {boolean} 真的删掉了（不存在 ⇒ false，调用方据此判"是不是被别的进程先删了"）
 */
export function removeOutboxSync(root, seq) {
  const p = outboxFileOf(root, seq)
  if (!existsSync(p)) return false
  rmSync(p)
  return true
}

/** 清掉写残的 `.tmp`（apply 期跑一次）。返回清掉的个数。 */
export function sweepTmpSync(root) {
  const { tmpLeftovers } = listOutboxSync(root)
  let n = 0
  for (const name of tmpLeftovers) {
    try {
      rmSync(join(root, name))
      n++
    } catch {
      // 删不掉就留着（下一次 apply 再试）—— 不为此让插件起不来
    }
  }
  return n
}

// ────────────────────────────────────────────────────────────
// state.json —— **跨插件契约**（phase 的 L4 判据读它）
// ────────────────────────────────────────────────────────────

/**
 * 读降级状态。
 *
 * **缺席三档分开报**（本项目既有纪律：字段缺席 / 空容器 / 整条记录缺席必须能分辨）：
 *   - 目录不存在或文件不存在 ⇒ `present:false, reason:'enoent'`
 *   - 文件为空 ⇒ `present:false, reason:'empty'`
 *   - 解析失败 / schema 不认 ⇒ `present:false, reason:'bad'|'schema'`
 *   - 正常 ⇒ `present:true, state`
 *
 * 调用方（尤其 phase 的 guard）**不许把 `present:false` 当成"没有中断"** —— 那是把盲区说成事实。
 * `present:false` 的语义是"这份状态不可信"，该走 fail-closed。
 *
 * @returns {{present: true, state: object} | {present: false, reason: string, error?: string}}
 */
export function readStateSync(root) {
  const p = join(root, STATE_FILE)
  if (!existsSync(p)) return { present: false, reason: 'enoent' }
  let text
  try {
    text = readFileSync(p, 'utf8')
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
    return { present: false, reason: 'bad', error: `state.json 顶层不是对象` }
  }
  if (parsed.schema !== STATE_SCHEMA) {
    return { present: false, reason: 'schema', error: `state.json schema=${JSON.stringify(parsed.schema)}，本插件只认 ${STATE_SCHEMA}` }
  }
  // 时间字段形态校验：形态不对 ⇒ 整份不可信（半懂不懂地读一部分比不读更危险）
  for (const k of ['updatedAt', 'lastDeliveredAt', 'lastAttemptAt', 'outageSince', 'degradedSince']) {
    if (!ISO_OR_NULL(parsed[k])) {
      return { present: false, reason: 'bad', error: `state.json 的 ${k} 不是 ISO 字符串也不是 null：${JSON.stringify(parsed[k])}` }
    }
  }
  if (!Number.isInteger(parsed.degradedDelivered) || parsed.degradedDelivered < 0) {
    return { present: false, reason: 'bad', error: `state.json 的 degradedDelivered 不是 ≥0 的整数：${JSON.stringify(parsed.degradedDelivered)}` }
  }
  // 🔴 阈值必须**为正的有限数**：0 / 负数 / NaN 会让"降级"在任何时刻立刻成立 ⇒ L4 的
  //   "远端存在 OR 降级"退化成恒真 ⇒ 等于把这条门禁整个关掉（而它看起来还"在工作"）。
  if (!Number.isFinite(parsed.degradeAfterMs) || parsed.degradeAfterMs <= 0) {
    return { present: false, reason: 'bad', error: `state.json 的 degradeAfterMs 不是正数：${JSON.stringify(parsed.degradeAfterMs)}` }
  }
  return { present: true, state: parsed }
}

/** 原子写状态。`updatedAt` 由本函数填（调用方填的时间戳会被覆盖 —— 单一时间源）。 */
export function writeStateSync(root, state) {
  mkdirSync(root, { recursive: true })
  const target = join(root, STATE_FILE)
  const tmp = target + TMP_SUFFIX
  const body = JSON.stringify({ ...state, schema: STATE_SCHEMA, updatedAt: new Date().toISOString() }, null, 2)
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, target)
  return target
}
