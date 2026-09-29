/**
 * state.yaml 读写：单写者锁 + 原子 rename + revision 乐观并发 + 容错解析。
 *
 * 设计取舍（施工单 §5.3）：
 *   - **不引第三方 yaml 库** —— 状态文件是自有格式，自己写的 parser 就是攻击面，
 *     而本文件只产出/消费固定 6 字段的标量，没必要引依赖。复用 dsl `yamlsubset.js`
 *     的"宁可报错不可猜"精神，但状态文件比 ontology 简单得多，这里用极简行解析即可。
 *   - **锁**：`<projectRoot>/memory/.state.lock`，`open('wx')` 原子排他；
 *     抢不到且过期 → 强夺并写审计（`decision: 'lock-steal'`，`oldPid` = 被抢走的那个）；
 *     抢不到且未过期 → fail-closed 抛错（不重试等待），但**先落一条审计**
 *     （`decision: 'lock-contended'`，`holderPid` = 仍持有者，另带 `holderAt`/`ttlMs` 供复算），
 *     并把 `record()` 返回的 `seq` 拼进错误文案 —— 与 D1 被拒同形态，模型拿得到定位锚。
 *     锁文件不可解析（半写/损坏）→ `info={}` → `at=NaN` → **判为「不可解析」并拒绝**
 *     （**不是**判它过期 —— "过没过期"这个判断压根没做出，且坏锁永不自行过期），
 *     错误文案走另一套措辞并给出"手工删锁"的恢复动作；审计里 `holderPid`/`holderAt` 记 `null`、
 *     `parseable: false`。
 *   - **写**：写前重读（锁内）→ 改 → 写 `.tmp` → `rename()` 覆盖（同卷 rename 原子）→ 释放锁。
 *
 * ⚠️ guard 是同步的，不能在里面写 state；只有 `fde_phase_advance` 的 execute（async）才写。
 * 但 guard **读** state 是同步的（`readStateGradedSync`，用于取 current_phase 做门禁判定），
 * 所以这里同时提供同步读与异步写两套接口。
 *
 * #### 三个同步读函数，别混用（2026-09-29 收敛，此前 guard 用错了其中一个）
 *
 * | 函数 | 文件不在 | 文件在但读不出/无意义 | 用途 |
 * |---|---|---|---|
 * | `readStateSync` | `DEFAULT_STATE` | **`DEFAULT_STATE`**（错→已不再用于门禁） | 只给"文件不在就是初始状态"且**不据此撤保护**的地方 |
 * | `readStateStrictSync` | `null` | `null` | fail-safe 调用方（restrict：不可知 ⇒ 既不挂也不摘） |
 * | `readStateGradedSync` | `enoent` + 初始状态 | **`present:false, reason:'bad'/'empty'/'schema'`** | **门禁判定**：缺席必须能与"不可知"分开 |
 *
 * ⚠️ `readStateSync` 保留但**不得再用于任何门禁/保护判定** —— 它的两个分支返回同一个值
 * （`tools/_restrict_failopen_probe.mjs` 的 D 段已在实测里证明"ENOENT 判断是死代码"）。
 */

import { readFile, writeFile, rename, rm, open, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** state.yaml 的初始形态（spec 第七节：只放状态机，别把 decisions/checklist 塞进来）。 */
export const DEFAULT_STATE = {
  schema_version: 1,
  current_phase: '0.1',
  phase_status: 'in_progress', // in_progress | done
  ontology_version: 1,
  revision: 0,
  updated_at: '',
  // C3（spec §10.4）：回滚观察期起点（ISO 时间戳）。空串 = 不在观察期；非空 = 回滚后处于观察期。
  rollback_at: ''
}

/**
 * C3（spec §10.4）：回滚观察期时长 —— 24h。
 * 回滚后停留 24h 观察期，期间禁止推进（guard/evaluate 与 execute 双向冻结），
 * 结束后才恢复推进、届时确认是否重新部署。
 */
export const OBSERVATION_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * 是否处于回滚观察期内（`rollback_at` 非空且距现在不足 24h）。
 *
 * 纯函数（可单测）：guard 同步读 state 后调用，与 execute 共用同一份判定，避免两处漂移。
 * `rollback_at` 非法（非字符串 / 不可解析时间戳）一律判**不在观察期** —— 那不是"放行",
 * 而是"无法证明正在观察"；真正需要 fail-closed 的地方（回滚写入）会另行校验时间戳格式。
 *
 * @param {object} state - readStateSync / readState 的结果
 * @returns {boolean} true = 正在观察期内
 */
export function inObservation(state) {
  const at = state?.rollback_at
  if (typeof at !== 'string' || at === '') return false
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return false
  return Date.now() - t < OBSERVATION_WINDOW_MS
}

function parseScalar(s) {
  s = String(s).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s) || /^-?\d+\.\d+$/.test(s)) return Number(s)
  return s
}

/**
 * 容错解析：缺字段用默认值补，坏行直接跳过（不抛）。
 * 文件不存在 → 返回 DEFAULT_STATE（**不报错**，由插件首次创建）。
 * @param {string} text
 * @returns {object}
 */
export function parseState(text) {
  const out = { ...DEFAULT_STATE }
  if (!text) return out
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/)
    if (!m) continue
    out[m[1]] = parseScalar(m[2])
  }
  return out
}

/** 把状态序列化回 yaml（标量足够，无需嵌套）。 */
export function serializeState(state) {
  const s = state ?? {}
  return [
    `schema_version: ${s.schema_version ?? 1}`,
    `current_phase: "${s.current_phase ?? '0.1'}"`,
    `phase_status: ${s.phase_status ?? 'in_progress'}`,
    `ontology_version: ${s.ontology_version ?? 1}`,
    `revision: ${s.revision ?? 0}`,
    `updated_at: "${s.updated_at ?? ''}"`,
    `rollback_at: "${s.rollback_at ?? ''}"`
  ].join('\n') + '\n'
}

/** 同步读（guard 用）。文件不存在 → DEFAULT_STATE。 */
export function readStateSync(statePath) {
  try {
    return parseState(readFileSync(statePath, 'utf8'))
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ...DEFAULT_STATE }
    return { ...DEFAULT_STATE }
  }
}

/**
 * 严格解析：**只收录文件里真正写了的键**，一个都没读到 ⇒ 返回**空对象**（绝不是 DEFAULT_STATE）。
 *
 * 与 `parseState` 的区别只有一个：不以 DEFAULT_STATE 为基底。看似很小，实则决定了
 * "这个文件到底可靠不可靠"能不能被判定出来 —— `parseState` 对垃圾内容会返回一个
 * 满是默认值的对象，**和真读过文件一模一样**，调用方无法区分"真读到"与"什么都读到=什么都没读到"。
 *
 * @param {string} text
 * @returns {object} 稀疏 map（可能为空对象）
 */
export function parseStateStrict(text) {
  const out = {}
  if (!text) return out
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/)
    if (!m) continue
    out[m[1]] = parseScalar(m[2])
  }
  return out
}

/**
 * 严格同步读：**只有真正从文件里读出了内容**才返回对象，任何失败一律返回 `null`。
 *
 * #### 为什么非它不可（读 differing fail-open 实录）
 *
 * `readStateSync` 对**任何**失败都回落 `{...DEFAULT_STATE}`，而 `DEFAULT_STATE.current_phase`
 * 是 `'0.1'` —— 一个**合法且非受保护**的阶段值。凡是拿"当前阶段"来决定"要不要**撤掉**某种保护"
 * 的调用方（restrict 治理器就是），一旦把"读失败"误读成"当前处于 0.1 阶段"，就会**静默摘掉已挂的限制**：
 * 读失败这种最该保守的时刻，反而变成保护最松的时刻。
 *
 * #### 🔴 别写成 `try { return parseState(...) } catch { return null }`
 *
 * 那是**修不掉**的：`parseState` 本身不抛异常，垃圾内容会被它逐行跳过、
 * 最后返回一个写着默认值的对象 ⇒ 非 null ⇒ 回落照样生效（`_restrict_strictstate_out.txt`
 * 改前那段红就是这个原因：内容坏 / 缺 current_phase / 空文件**三条全 false**）。
 * 真正的判据必须是"**文件里到底有没有我们关心的键**"，也就是本函数用的 `parseStateStrict`。
 *
 * #### 适用范围
 *
 * 只给"阶段不可知 ⇒ **不变更任何状态**"这类 **fail-safe 调用方**用（restrict 治理器）。
 * 它把"文件不在"和"文件坏了"**合并成同一个 `null`** —— 这对 fail-safe 够用（两种都不变更），
 * 但**不足以做门禁判定**：门禁必须区分"首次运行（文件还没建 ⇒ 初始阶段 0.1 是对的）"
 * 与"文件坏了（不可知 ⇒ 必须拒绝）"。那个区分由 `readStateGradedSync` 提供。
 *
 * ⚠️ 本函数**不是** `readStateSync` 的替代品，两者语义不同、**不可互换**。
 *
 * @param {string} statePath
 * @returns {object|null} 读到内容 ⇒ 稀疏状态 map；读不到 / 读空 ⇒ `null`
 */
export function readStateStrictSync(statePath) {
  try {
    const got = parseStateStrict(readFileSync(statePath, 'utf8'))
    // 一个键都没提取到 = 这个文件给不出任何信息 ⇒ 与"读失败"同等待遇。
    return Object.keys(got).length > 0 ? got : null
  } catch {
    return null
  }
}

/**
 * 分档同步读：**给门禁判定用**。缺席必须能与"不可知"分开，否则读失败会变成放行。
 *
 * 取值口径与 `dsh-fde-memory/lib/outbox.js` 的 `readStateSync` **同一套**
 * （`enoent` / `empty` / `bad` / `schema`）—— 那是本项目已有的正确实现，
 * 它的注释里甚至点名了"**尤其 phase 的 guard** 不许把 `present:false` 当成'没有中断'"。
 * 2026-09-29 之前 phase 的 guard 恰恰违反了这一条，本函数就是来补上的。
 *
 * #### 每一档的语义（调用方必须逐档处理，不许一律回落）
 *
 *   - `enoent`：**文件不在 ⇒ 首次运行**。这是**唯一**允许"缺席但继续"的档：
 *     插件尚未创建状态文件时，语义明确就是初始阶段，不是"不可知"。返回对象里
 *     **带上 `state = {...DEFAULT_STATE}`**，好让调用方不必再去 import 那个常量。
 *   - `empty`：文件在、但是空的（截断 / 没写完）。
 *   - `bad`：文件在、但**一个键都提取不出**（二进制垃圾 / 编码坏 / 缺 `current_phase` /
 *     `current_phase` 是空串）。
 *   - `schema`：`schema_version` 不是本插件认的值。
 *
 * ⚠️ **后三档都表示"这份状态不可信"，不是"没有状态"** —— 门禁必须 fail-closed。
 * 把它们读成 `0.1` 的后果（实测过）：①真实阶段的门禁被**整体跳过**；
 * ②回滚后 24h 观察期的冻结被**静默解除**（`rollback_at` 读到空串 ⇒ `inObservation()` 返回 false）；
 * ③这次"推进"还会把坏文件**就地重写成看起来正常的进度**，事故痕迹随之消失。
 *
 * 🔴 **为什么不能只靠 `catch`**：截断/编码坏这类最常见的意外里，`readFileSync` 是**成功**的，
 * `parseState` 又**从不抛异常**（逐行 `continue`）⇒ **`catch` 根本进不去**。
 * 所以判断必须落在"**文件里到底有没有我们关心的键**"上（`parseStateStrict`），
 * 不能落在"有没有抛错"上。
 *
 * @param {string} statePath
 * @returns {{present: true, reason: 'present', state: object}
 *        | {present: false, reason: 'enoent', state: object}
 *        | {present: false, reason: 'empty'|'bad'|'schema', error?: string}}
 */
export function readStateGradedSync(statePath) {
  let text
  try {
    text = readFileSync(statePath, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { present: false, reason: 'enoent', state: { ...DEFAULT_STATE } }
    // 权限 / 路径是目录 / 编码错 —— 真读不出来，**不给**初始状态
    return { present: false, reason: 'bad', error: `读取失败：${String(e?.message ?? e)}` }
  }
  if (text.trim().length === 0) return { present: false, reason: 'empty', error: '文件是空的' }
  const keys = parseStateStrict(text)
  if (Object.keys(keys).length === 0) {
    return { present: false, reason: 'bad', error: '一个键都提取不出（内容不可解析）' }
  }
  if (keys.schema_version !== 1) {
    return {
      present: false,
      reason: 'schema',
      error: `schema_version=${JSON.stringify(keys.schema_version)}，本插件只认 1`
    }
  }
  const cp = keys.current_phase
  if (cp === undefined || cp === null) {
    return { present: false, reason: 'bad', error: '文件里没有 current_phase' }
  }
  // 空串 / 全空白都不是阶段 id —— 当成 0.1 会比不读更糟（那是个合法且非受保护的阶段值）。
  if (String(cp).trim() === '') {
    return { present: false, reason: 'bad', error: 'current_phase 是空串或全空白' }
  }
  return { present: true, reason: 'present', state: parseState(text) }
}

/** 异步读。文件不存在 → DEFAULT_STATE。 */
export async function readState(statePath) {
  try {
    return parseState(await readFile(statePath, 'utf8'))
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ...DEFAULT_STATE }
    throw e
  }
}

/**
 * A2（spec §7 并发控制）：PID 存活检测 —— 用 `process.kill(pid, 0)` 探进程。
 *
 * - 探到（no-throw）或 `EPERM`（存在但无权限）⇒ 进程还活着 ⇒ true
 * - `ESRCH`（不存在）⇒ false
 * - pid 非正整数（缺失/损坏/非法）⇒ 返回 true（**保守**：无法判定"不存在"就不许自动释放，
 *   宁可锁死也不误抢 —— 与"坏锁不判过期"的 fail-closed 同一方向）
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!(e && e.code === 'EPERM')
  }
}

/**
 * 获取单写者锁。抢不到且未过期 → 抛错（fail-closed）。
 * 过期（且持有 PID 已死）→ 强夺并记审计（A2：残留检测）。
 * @param {string} lockPath
 * @param {number} ttlMs
 * @param {import('./audit.js').AuditChain} [audit]
 * @returns {Promise<void>}
 */
export async function acquireLock(lockPath, ttlMs, audit) {
  await mkdir(dirname(lockPath), { recursive: true }).catch(() => {})
  try {
    const fd = await open(lockPath, 'wx')
    await fd.close().catch(() => {})
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    return
  } catch (e) {
    if (e && e.code !== 'EEXIST') throw e
    // 锁已存在：读它，判断是否过期
    let info = {}
    let parseable = false
    try {
      const parsed = JSON.parse(await readFile(lockPath, 'utf8'))
      info = parsed && typeof parsed === 'object' ? parsed : {}
      parseable = true
    } catch {
      // 半写 / 损坏的锁文件：读不出 → info 保持 {} → at=NaN → stale=false → 走拒绝分支。
      // 这是 fail-closed 而非"当成过期直接抢"，绝不能放宽。
      info = {}
      parseable = false
    }
    const at = typeof info.at === 'string' ? Date.parse(info.at) : NaN
    const timedOut = Number.isFinite(at) && Date.now() - at > ttlMs
    // A2（spec §7）：自动释放必须「超时 + 持有 PID 已不存在」双条件。
    // 持有进程还活着时，即使超时也不抢 —— 进程可能在做长任务，锁仍有效；
    // 只有进程死了（残留锁）才自动释放。
    const holderDead = !pidAlive(info.pid)
    const stale = timedOut && holderDead
    if (stale) {
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      if (audit) {
        await audit
          .record({ type: 'lock', decision: 'lock-steal', path: lockPath, oldPid: info.pid ?? null })
          .catch(() => {})
      }
      return
    }
    // 拒绝分支：**先留痕再抛**。与 D1 被拒（phase-advance-blocked）同形态 ——
    // 模型在错误文案里拿得到审计号，运维事后也查得到"当时有人在抢写"。
    let auditSeq = null
    if (audit) {
      const r = await audit
        .record({
          type: 'lock',
          decision: 'lock-contended',
          path: lockPath,
          // ⚠️ 字段名是 holderPid，不是 oldPid：oldPid 的语义是"被抢走的那个"，
          // 而这条锁**还在别人手上**。混用会让审读者把"竞争被拒"误读成"抢了一次"。
          holderPid: info.pid ?? null,
          // holderAt + ttlMs 一起落盘，审读者才能自己复算"当时到底过没过期"，
          // 而不是只能采信"我们判它没过期"。读不出时记 null（≠"没有持有者"）。
          holderAt: typeof info.at === 'string' ? info.at : null,
          ttlMs,
          parseable
        })
        // 审计写失败不得改变"这次写入被拒绝"这个结果：
        // 拒绝是安全属性，审计是记录属性 —— 记录失败不能把 fail-closed 变成 fail-open。
        .catch(() => {})
      auditSeq = r?.seq ?? null
    }
    // ⚠️ 文案必须按三分支 —— 各路径的**事实与补救动作完全不同**，不能共用一句话：
    //   · parseable=false：at=NaN → "过没过期"这个判断**根本没做出**；且坏锁**永不自行过期** → 手工删锁
    //   · timedOut 但持有 pid 仍存活（A2）：锁确实超时了，但进程还活着 → 不自动释放，先确认真相
    //   · 未过期：确有另一进程在写 → 稍后重试（等它释放）
    // 共用"锁未过期。稍后重试"会把模型推向等待（活体实测：模型据此提出"等到过期时间"），
    // 既说谎，又违反本状态机"fail-closed 不重试等待"的纪律。
    // 给出恢复手段是本状态机的既有风格（D1 被拒也会说"请先跑 fde-run-guardrails-check"）。
    const why = !parseable
      ? '锁文件不可解析：半写/损坏，无法判定是否过期'
      : timedOut
        ? `锁已超时，但持有进程（pid=${info.pid}）仍存活，不自动释放`
        : '锁未过期'
    const remedy = !parseable
      ? `该锁不会自行过期 —— 请确认没有并发写后，手工删除 ${lockPath} 再重试。`
      : timedOut
        ? '请确认该进程仍在写 state；若确认其已僵死，可手工删除锁文件后重试。'
        : '稍后重试，或确认没有并发写。'
    // 「超时但存活」时 pid 已写进 why，不重复拼；「未过期」时拼持有者 pid；不可解析时 pid 必空。
    const holder = parseable && !timedOut && info.pid ? ` 持有者 pid=${info.pid}` : ''
    throw new Error(
      `state.yaml 被另一进程占用（${why}）。${remedy}${holder}` +
        (auditSeq ? `（phase 审计 #${auditSeq}）` : '')
    )
  }
}

/** 释放锁（放 finally，异常路径也解锁）。 */
export async function releaseLock(lockPath) {
  try {
    await rm(lockPath, { force: true })
  } catch {
    // 释放失败不致命
  }
}

/**
 * 写入 state：单写者锁 + 写前重读 + revision +1 + 原子 rename。
 *
 * @param {string} statePath
 * @param {string} lockPath
 * @param {(cur: object) => object} mutator - 返回"期望的下一状态"（不必带 revision）
 * @param {number} ttlMs
 * @param {import('./audit.js').AuditChain} [audit]
 * @returns {Promise<object>} 写入后的状态
 */
export async function writeState(statePath, lockPath, mutator, ttlMs, audit) {
  await acquireLock(lockPath, ttlMs, audit)
  try {
    // 写前重读（乐观并发：校验调用方持有的 revision 已被锁内重读覆盖）
    const current = await readState(statePath)
    const next = mutator(current)
    // revision 永远 = 当前 +1（锁内重读后，这就是真实的乐观并发版本号）
    next.revision = (current.revision ?? 0) + 1
    next.updated_at = new Date().toISOString()
    const tmp = statePath + '.tmp'
    await writeFile(tmp, serializeState(next), 'utf8')
    await rename(tmp, statePath) // Windows 同卷 rename 是原子的
    return next
  } finally {
    await releaseLock(lockPath)
  }
}
