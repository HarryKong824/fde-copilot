/**
 * `restrict` 治理器 —— 受保护 Phase 内，对**每个 agent** 隐藏指定的全局工具（PoC 口径 = 方案 B）。
 *
 * 一句话背景：**阶段是全局的（`state.yaml` 一个值），限制是每 agent 的（`ToolsRuntime.restrict()` 带 scope）**。
 * 所以"进入受保护阶段"这件事发生时，**已经开着的会话**必须被一起覆盖 —— 只处理 `agent/session-start`
 * 会漏掉它们（施工单 §2.1，也是判据 5 唯一考察的东西）。
 *
 * ### 三条必须记住的机制（全部有出处，不是"应该可以"）
 *
 * 1. **`restrict()` 要在 `agent.ctx` 上调**，不能在插件自己的全局 ctx 上调。
 *    `restrict()` 第一句是 `scopeOf(this.ctx)`（`dsh-tools/lib/index.js:2792`），而服务属性的访问会经
 *    cordis 的 traceable 代理、把 `this.ctx` 解析成**访问方 ctx**
 *    （`@deepseek-ai/cordis/lib/index.js:128` + `:1770-1774`）。
 *    ⇒ 同一个服务实例，从哪个 ctx 访问，就作用在哪个 scope 上。
 *
 * 2. **`restrict()` 每次调用都会追加一条 filter（`layers.restrictions.append(compiled)`，`:2805`），
 *    而多条 filter 是交集语义** ⇒ 想"放宽"必须调用上一次**返回的那个 disposer**，
 *    否则限制只会越叠越窄。所以本模块为每个 agent 记住 `{ desired, applied, dispose }` 三元组：
 *    `desired` 用于判幂等（期望名单没变就什么都不做），`dispose` 用于真正放宽。
 *
 * 3. **restrict 是热生效的**：模型每一次请求的工具清单都是当刻 `view(scope)` 重算的
 *    （`dsh-tools:2609` → `wireSchemas:2726` → `SystemPrompt.assemble():299-318` →
 *    `AgentLoop.preStep()` 位于 `turn()` 的 `while(true)` 里，`dsh-agent-loop:502`）。
 *    ⇒ 推进到受保护阶段后，**同一会话的下一回合**就看不到工具了，不需要新开会话。
 *
 * ### 🔴 点不上的名字不得静默（与 `check-skipped` 同精神）
 *
 * 名单里可能存在本部署不存在的工具（平台差异：win32 只有 `pwsh` 没有 `bash`；preset 差异；将来改了 preset）。
 * `restrict()` 会抛 `names unknown global tool "x"; known global tools: …`。本模块的处理是：
 * **一个名字不存在 ≠ 整条保护失效** —— 解析出 unknown 后拿**剩下的**名字重挂，
 * 并把被跳过的名字写进审计 `skipped`（绝不假装拦住了）。若**全部**名字都点不上 ⇒ 保护完全失效 ⇒
 * 落 `restrict-degraded`（比 `restrict-applied` 醒目一级）。
 *
 * ### 🧪 纯函数部分刻意不依赖 cordis / 真 SDK ⇒ 可离线回归（本项目一贯纪律）
 *
 * `desiredDeny()` 与 `parseUnknownNames()` 是纯函数（`_restrict_test.mjs` 直接喂数据测）。
 * 只有 `RestrictGovernor` 的几句 `restrict()` 调用需要真 SDK，那部分靠注入**假 agent**来测幂等。
 */

import { join } from 'node:path'
// ⚠️ 刻意用**严格**读（不是 readStateSync）：见下面 currentPhase() 的 fail-open 说明。
import { readStateStrictSync } from './state.js'

/**
 * 「这次 restrict 是谁触发的」—— 封闭的四个值。
 *
 * 🔴 为什么必须**沿调用链传下来**，不能在落盘点猜：
 * `sync()` 有两个调用者（`reconcile()` 与 `agent/session-start`），同一个函数体里的 5 个落盘点
 * 在两条路径上要写**不同**的值 ⇒ 写死任何一句，另一条路上的记录就会说假话。
 *
 * 🔴 为什么**不给默认值**：漏传 ⇒ 记录缺 `trigger` ⇒ 判据「每条 restrict 记录都可归因」当场红。
 * 给默认值等于替新调用点**编造来源**（这是 C 系列里最贵的那种错：证据齐全，但来源是假的）。
 *
 * @type {readonly string[]}
 */
export const RESTRICT_TRIGGERS = Object.freeze([
  'session-start', // 新会话建立（installRestrict 的 agent/session-start）
  'phase-changed', // 阶段推进成功（tools.js 的 fde_phase_advance → reconcile）
  'full-reconcile', // 插件装载后的全量对账（ctx.inject(['agents'])）
  'agent-disposed' // agent 销毁时的台账终结（untrack）
])

/**
 * 「当前阶段 → 应该隐藏哪些工具」。
 *
 * 纯函数，不读 IO、不碰 SDK —— 这是本模块唯一决定"保护什么"的地方，刻意做成配置驱动，
 * 将来调口径（换受保护阶段 / 换名单）改 config 即可，**不必动 `lib/`**（施工单 §1）。
 *
 * 返回的是**新数组**，调用方可以随意改，不会污染 config。
 *
 * @param {string|number|null|undefined} phase - 当前阶段 id（如 `'6'`）
 * @param {{protectedPhases?: string[], denyTools?: string[]}} cfg - 已规范化配置
 * @returns {string[]} 要隐藏的工具名；非受保护阶段 / 名单为空 / 未配 ⇒ `[]`
 */
export function desiredDeny(phase, cfg) {
  const tools = Array.isArray(cfg?.denyTools) ? cfg.denyTools : []
  if (tools.length === 0) return []

  const id = String(phase ?? '')
  if (id === '') return []

  const protectedPhases = Array.isArray(cfg?.protectedPhases) ? cfg.protectedPhases : []
  const hit = protectedPhases.some((p) => String(p) === id)
  return hit ? [...tools] : []
}

/**
 * 从 `restrict()` 的错误文案里解析出「点不上的名字」。
 *
 * 真 SDK 的原文（两处形式，单数 / 复数都要能解析）：
 *   `tools.restrict() names unknown global tool "bash"; known global tools: pwsh, read`
 *   `tools.restrict() names unknown global tools "bash", "x"; known global tools: (none)`
 *
 * 只取 marker 之后、`; known global tools:` 之前那段里的引号名 —— 后面那段是"目前有哪些"，
 * 混进来会把存在的名字也当成不存在的。
 *
 * @param {string|Error|unknown} message - 错误原文或 Error
 * @returns {string[]} unknown 名字列表；无法识别 ⇒ `[]`（调用方据此判断"这不是点名失败"）
 */
export function parseUnknownNames(message) {
  const text = typeof message === 'string' ? message : String(message?.message ?? message ?? '')
  const marker = 'unknown global tool'
  const at = text.indexOf(marker)
  if (at < 0) return []

  const rest = text.slice(at + marker.length)
  const tail = '; known global tools:'
  const end = rest.indexOf(tail)
  const scope = end >= 0 ? rest.slice(0, end) : rest

  const names = []
  const re = /"([^"]+)"/g
  let m
  while ((m = re.exec(scope)) !== null) names.push(m[1])
  return names
}

/** 把期望名单压成一个可比较的标量（用于判幂等：期望没变就什么都不做）。 */
function keyOf(names) {
  return (names ?? []).join('\u0000')
}

/**
 * 「该 agent 仍带着限制」的 decision 白名单（第五批，见 `isCarrying()` 的规则表）。
 * ⚠️ 用白名单而不是"denied 非空"：`degraded` / `error` 的 denied 也可能非空，但那是**没挂上**。
 */
const CARRYING_DECISIONS = new Set(['restrict-applied', 'restrict-restored', 'restrict-replaced'])

/**
 * `restrict-lifted` 的**来源**，写进审计的 `via` 字段。
 * - `'ledger'`：本进程台账内确有"有过 → 无"的转变（真摘除）
 * - `'index'` ：本进程从未挂过，靠链上索引推断（跨进程；0007 §3）
 *
 * ⚠️ 必须**二选一显式写出**：省略会让读者分不清"被摘过"和"推断失效"，
 * 那等于用一个静默点换掉另一个静默点 —— 正是第四批要消灭的东西。
 */
export const LIFT_VIA = { LEDGER: 'ledger', INDEX: 'index' }

/**
 * 「该 agent 最近一条 restrict 决策」⇒ 本次挂载该记 `applied` 还是 `restored`（第四批）。
 *
 * ### 为什么需要它
 *
 * 链上出现**连续两条 `restrict-applied` 而中间没有 `lifted`** 时（实测 `#15/#16`、`#35/#36`），
 * 读者分不清第二条是"又叠了一层（交集 ⇒ 越叠越窄）"还是"重启/对象重建后的接续"。
 * 两者链上形态完全一致，是本模块此前最大的静默点。
 *
 * ### 🔴 判据必须收紧到「**最近一条**」，不能是「存在任意一条 applied」
 *
 * 按后者实现会在 `#35` 上**说谎**：`#35` 之前确实存在 `#25 applied phase=10 denied=['pwsh']`，
 * 但中间隔着 `#31 lifted` ⇒ 限制**真的被摘过**，`#35` 是一次真实的重新挂载。
 *
 * | 最近一条 D | 落什么 | 语义 |
 * |---|---|---|
 * | `applied` 且名单相同 | **`restored`** | 接续（重启 / agent 对象重建 / 插件 fiber 重建），不是叠加 |
 * | `restored` | **`restored`** | 连续多次重启/重建：仍是接续（0005 §3 拍板） |
 * | `untracked` | **`restored`** | 台账曾终结、旧层已随 fiber 撤销 ⇒ 本次是接续 |
 * | `lifted` | `applied` | 限制真被摘过 ⇒ 真重新挂载（正是 `#35`） |
 * | `replaced` / `degraded` / `error` / 查不到 | `applied` | 首次，或状态不可接续 |
 *
 * ### 🔴 `from` 恒指「该 agent 最后一条 `applied` 的 seq」，不是「前一条」（0005 §1.3 拍板）
 *
 * `restored` 的语义是"**我接的是一条已存在的限制**"，而这条限制的**唯一来源**是那条 `applied`；
 * 中间的 `restored` 只是传递。若 `from` 取「前一条记录的 seq」，连续重启会退化成链式
 * （`#36 applied → #37 restored from=36 → #38 restored from=37`）⇒ 判据 1「`from` 指向重启前最后一条
 * applied」**从第二次重启起就失效**，而判据 1 恰恰是要跑多次重启的那个判据。
 * 顺序本就由 `seq` 单调编码，`from` 再编一遍是冗余 —— 它该编的是"接续到**哪一层限制**"。
 *
 * ⇒ `from` 一律取索引里的 `appliedSeq`（只被 `restrict-applied` 推进）。
 * 索引条目**没有** `appliedSeq`（老链 / 假索引 / 兼容路径）⇒ 回落 `last.seq`（那条就是 applied 本身）。
 * 源头落在尾部窗口外 ⇒ `appliedSeq` 为 `null` ⇒ `from: null`（**不编造**；也不因此退化成 `applied` ——
 * "窗口不完整"由 `restrict-history-miss` 负责报告）。
 *
 * 纯函数（不读 IO）⇒ 可离线精确构造每种输入。
 *
 * @param {{seq?:number|null, decision?:string|null, denied?:string[]|null, appliedSeq?:number|null}|null|undefined} last
 * @param {string[]} want - 本次要挂的期望名单
 * @returns {{decision: 'restrict-applied'|'restrict-restored', from: number|null, note: string|null}}
 */
export function classifyRestore(last, want) {
  if (!last || typeof last !== 'object') {
    return { decision: 'restrict-applied', from: null, note: null }
  }
  // 「最后一条 applied 的 seq」—— 唯一来源，不随 restored / untracked 推进。
  const src = Number.isInteger(last.appliedSeq) ? last.appliedSeq : null

  if (last.decision === 'restrict-applied' && keyOf(last.denied) === keyOf(want)) {
    return {
      decision: 'restrict-restored',
      from: src ?? last.seq ?? null,
      note: '本进程首次挂载，但链上最近一条是**同名单**的 applied ⇒ 这是接续（重启/对象重建），不是叠加'
    }
  }
  if (last.decision === 'restrict-restored') {
    return {
      decision: 'restrict-restored',
      from: src,
      note:
        '链上最近一条本身就是 restored ⇒ 连续多次重启/重建，本次仍是接续；' +
        'from 恒指最初那条 applied（不链式，便于每次重启都能断言）'
    }
  }
  if (last.decision === 'restrict-untracked') {
    return {
      decision: 'restrict-restored',
      from: src,
      note: '链上最近一条是 untracked（台账曾终结、旧层已随 fiber 撤销）⇒ 本次是接续，不是叠加'
    }
  }
  return { decision: 'restrict-applied', from: null, note: null }
}

/**
 * 「链上最后一条 ⇒ 该 agent 是否仍带着限制」（第五批，跨进程 `lifted` 的判据）。
 *
 * ⚠️ 判据是 **decision 白名单 + denied 非空**，**不能**只写 `denied.length > 0`：
 * `degraded`（一个都没挂上）和 `error`（挂的时候抛错）记录的 `denied` 都可能是非空名单
 * （`error` 直接写 `denied: want`），但那两种是**没挂上**，记成"限制已失效"就是编造。
 *
 * | 最后一条 | 带限制？ | 理由 |
 * |---|---|---|
 * | `applied` / `restored` | ✅ | 挂上了（restored = 跨进程接续） |
 * | `replaced` | ✅ | 挂上了，只是名单换过（它的 `denied` 是新名单） |
 * | `lifted` | ❌ | 已经摘过 ⇒ 再落一次就是刷屏（幂等靠这一行） |
 * | `untracked` | ❌ | 台账终结、旧层已随 fiber 撤销 ⇒ 不带 |
 * | `degraded` / `error` | ❌ | **没挂上** ⇒ 不存在"失效"这回事 |
 * | 无记录 | ❌ | 全新会话 ⇒ 落了就是审计噪声 |
 *
 * 纯函数（不读 IO）⇒ 可离线精确构造每种输入。
 *
 * @param {{seq?:number|null, decision?:string|null, denied?:string[]|null}|null|undefined} last
 * @returns {boolean}
 */
export function isCarrying(last) {
  if (!last || typeof last !== 'object') return false
  if (!CARRYING_DECISIONS.has(last.decision)) return false
  return (last.denied ?? []).length > 0
}

/**
 * 每 agent 的 restrict 生命周期治理。
 *
 * 刻意**不用** `Map<agentId>` 之类间接键 —— 直接拿 agent 对象当 key：
 * 它本身就是 scope key，且 dispose 语义天然跟对象走。
 */
export class RestrictGovernor {
  /**
   * @type {Map<object, {desired:string[], applied:string[], dispose:(()=>void)|null, error?:string, appliedSeq?:number|null}>}
   *   `appliedSeq` = 「该 agent **最后一条 restrict-applied** 的 seq」（0005 §2）：
   *   只在 `decision === 'restrict-applied'` 时更新，`restored` 时沿用索引带回的源头 ⇒ 不链式。
   */
  #entries = new Map()
  /** @type {import('@deepseek-ai/cordis').Context|null} 注入后可用 `agents` 服务的 ctx */
  #agentsCtx = null
  /** @type {{projectRoot: string, protectedPhases?: string[], denyTools?: string[]}} */
  #cfg
  /** @type {import('./audit.js').AuditChain} */
  #audit
  /** @type {string} */
  #statePath
  /**
   * @type {Set<string>}
   * 本进程已报过"查不到历史"的 agent（第五批补）。
   *
   * 🔴 为什么需要它：`want` 非空侧天然幂等 —— 落完 miss 之后 `sync()` 会真的把限制挂上，
   * `record()` 顺带把该 agent 写进**索引** ⇒ 下次 `history.has(id)` 为真 ⇒ 不再报。
   * 但 **`want` 为空侧没有这个副作用**：它既不挂限制、也不落 `lifted`（查不到历史 ⇒ 不敢落）⇒
   * 索引永远不会有它 ⇒ 每次 `reconcile()` 都会再报一条 ⇒ **刷屏**。
   * ⇒ 对齐之后必须补上这道闸：每个进程对每个 agent **最多报一次**。
   * 重启（新进程）会重新发现盲区并再报一次 —— 那是对的，不该被永久静默。
   */
  #missedAgents = new Set()

  /**
   * @param {{cfg: object, audit: import('./audit.js').AuditChain}} deps
   */
  constructor({ cfg, audit }) {
    this.#cfg = cfg
    this.#audit = audit
    this.#statePath = join(cfg.projectRoot, 'memory', 'state.yaml')
  }

  /**
   * 当前全局阶段；读不出来一律 `null`（= "阶段不可知"），此时 caller 会**跳过本次重算**并留痕。
   *
   * 这里刻意不回落到任何默认阶段值：那会凭空改变限制集合，
   * 而"乱挂一层 restriction"和"乱摘一层 restriction"一样糟。
   *
   * ### 🔴 为什么必须是**严格**读（这是第二批补丁 1 修掉的那个 fail-open）
   *
   * 早先这里用的是 `readStateSync(path)?.current_phase`。那个函数对**任何**读失败都回落
   * `{...DEFAULT_STATE}`，而 `DEFAULT_STATE.current_phase` 是 `'0.1'` —— 一个**合法且非受保护**的阶段值。
   * ⇒ `state.yaml` 一旦不可解析（外部脚本写坏、磁盘异常、人工改错），本模块会把它读成
   * "当前处于 0.1 阶段" ⇒ `desiredDeny()` 返回空名单 ⇒ **把已挂的限制全摘掉**，而且全过程无声无息。
   * 读失败这种最该保守的时刻，恰恰变成保护最松的时刻。
   *
   * 换成 `readStateStrictSync`（失败一律 `null`）之后：不可知 ⇒ 命中 `restrict-undetermined`
   * ⇒ **既不挂也不摘**，现状被原样保留。
   *
   * ### 「不可知」的四种形态，全部返回 null
   *
   *   文件不存在 / 有权限等 IO 错误 / 内容不可解析（一个键都提取不出） / 文件里没写 `current_phase`
   *   另：`current_phase` 写成空串或空白也算不可知 —— 空串不是阶段 id，当成 0.1 会更糟。
   *
   * @returns {string|null}
   */
  currentPhase() {
    try {
      const s = readStateStrictSync(this.#statePath)
      if (s === null) return null
      const v = s.current_phase
      // 注意：这个 undefined 判断在严格读下**不再是死代码** —— 严格读运回的就是稀疏 map，
      // "文件里没写 current_phase" 时它真的没有这个键（不像 readStateSync 那样永远补一个）。
      if (v === undefined || v === null) return null
      const id = String(v).trim()
      return id === '' ? null : id
    } catch {
      return null
    }
  }

  /**
   * 绑定具备 `agents` 服务的 ctx（由 `ctx.inject(['agents'], …)` 拿到）。
   * 之后 `reconcile()` 才能覆盖"插件装载之前就已经存在的会话"。
   *
   * @param {import('@deepseek-ai/cordis').Context} ctx
   */
  bind(ctx) {
    this.#agentsCtx = ctx ?? null
  }

  /**
   * 对**全部**存活 agent 重算限制。
   *
   * 候选集合 = 自己 track 过的 ∪ `ctx.agents.list()`：
   * 前者覆盖"会话事件已收到"的，后者兜住"插件装载前就存在 / 事件漏收"的（施工单 §2.1）。
   *
   * 🔴 单个 agent 抛错必须**吞掉并跳过** —— `list()` 返回的可能混进正在被销毁的 agent，
   * 一个坏 agent 不该让其余会话失去保护。
   *
   * @param {string} [knownPhase] - 调用方已知的最新阶段（如推进成功后就是 `to`），省一次读盘
   * @param {string} trigger - 本次对账的触发源（见 `RESTRICT_TRIGGERS`；**必须显式传**）
   * @returns {Promise<{phase: string|null, agents: number, applied: number, lifted: number, skipped: number}>}
   */
  async reconcile(knownPhase, trigger) {
    const phase = knownPhase ?? this.currentPhase()
    if (phase === null) {
      await this.#note({
        decision: 'restrict-undetermined',
        phase: null,
        trigger,
        note: '读不到 state.yaml 的 current_phase ⇒ 阶段不可知，本次不变更任何限制（既不挂也不摘）'
      })
      return { phase: null, agents: 0, applied: 0, lifted: 0, skipped: 0 }
    }

    const want = desiredDeny(phase, this.#cfg)
    const agents = this.#collectAgents()
    const tally = { phase, agents: agents.length, applied: 0, lifted: 0, skipped: 0 }

    // 「agent → 最近一条 restrict 决策」**整批只建一次**（每个 agent 各扫一遍文件是不可接受的）。
    const history = this.#historySnapshot()
    // 窗口没覆盖全链 ⇒ 索引可能不完整 ⇒ "查不到"必须被记成盲区，而不是"本来就没有"。
    const truncated = history !== null && this.#audit?.tailTruncated === true
    const missed = []

    for (const agent of agents) {
      try {
        const r = await this.sync(agent, want, phase, history, trigger)
        if (r === 'applied') tally.applied += 1
        else if (r === 'lifted') tally.lifted += 1
        if (r === 'degraded') tally.skipped += 1

        const id = agent?.id ?? null
        // 🔴 与 `want` 的正负**无关**（0008 §4 裁定）：前提只有一个 —— 窗口没覆盖全链 ⇒ 查不到 ≠ 没有。
        // 早先这里多加了 `want.length > 0`，理由是"want=0 时漏判只是少一条可见性记录"。这个理由站不住：
        // want>0 漏判**看得见**（链上多一条 applied，读者至少能起疑、能对着 denied 自救）；
        // want=0 漏判**看不见**（链上什么都没有，读者不知道这里本该有记录）⇒ 后者才是真正的静默点。
        if (
          truncated &&
          typeof id === 'string' &&
          id !== '' &&
          !history.has(id) &&
          !this.#missedAgents.has(id)
        ) {
          missed.push(id)
          // ⚠️ **不在这里标记**（0009 §3）：标记必须等下面那条 `#note` 真的落盘成功。
          // `#note` 吞掉写盘失败（不抛、只返回 null），若在循环里先标记 ⇒ 写盘失败时
          // 这批盲区在本进程内**永久不再报** —— "检测到了但没说出来，而且以后也不会再说"。
          // 宁可重复报一条，不可静默一次。
        }
      } catch (error) {
        await this.#note({
          decision: 'restrict-error',
          agent: agent?.id ?? null,
          phase,
          trigger,
          denied: want,
          skipped: [],
          note: `对该 agent 应用限制时抛异常：${String(error?.message ?? error)}`
        })
      }
    }

    // 盲区留痕：**每条 reconcile 最多一条**（聚合），否则链一过窗口就会每个会话每次对账刷一条，
    // 信号被噪声淹掉 —— 那正好跟加它的目的相反。
    if (missed.length > 0) {
      // `branch` 标明是**从哪个分支**发现的：影响面完全不同，读者一眼要知道是"可能多挂"还是"可能漏记"
      // （与 `via` 同一个取舍：判别靠**字段**，不靠读 note 里的自然语言）。
      const empty = want.length === 0
      const { persisted } = await this.#noteWithReceipt({
        decision: 'restrict-history-miss',
        phase,
        trigger,
        agents: missed,
        truncated: true,
        reason: 'tail-window',
        branch: empty ? 'want-empty' : 'want-nonempty',
        note: empty
          ? '尾部窗口未覆盖全链 ⇒ 这些 agent 的"最近一条 restrict 决策"查不到 ⇒ ' +
            '本次**不会**落跨进程 lifted（可能漏记一次摘除）。这一侧更隐蔽：链上连可疑的痕迹都没有，' +
            '读者无法自救 ⇒ 必须留痕，与 want 非空侧一视同仁（0008 §4）'
          : '尾部窗口未覆盖全链 ⇒ 这些 agent 的"最近一条 restrict 决策"查不到 ⇒ 本次一律按 applied 处理' +
            '（fail-safe：绝不因查不到历史就不挂限制），但 restored 判据在此处可能漏判'
      })
      // 落盘**成功**才允许去重（0009 §3）。写盘失败（进 outbox 或抛错）⇒ 不标记 ⇒
      // 下次 `reconcile()` 再报一次 —— 重复报是噪声，永久静默是把盲区藏起来，两者不等价。
      if (persisted) for (const id of missed) this.#missedAgents.add(id)
    }
    return tally
  }

  /**
   * 对单个 agent 应用「这个阶段应有的限制」（幂等）。
   *
   * @param {object} agent - agent 对象本体（**不是** `agent.ctx`；它同时是 scope key）
   * @param {string[]} [names] - 期望名单，缺省则从当前阶段算
   * @param {string} [phase] - 当前阶段（审计用）
   * @param {Map<string, object>} [history] - 「agent → 最近一条 restrict 决策」；
   *   缺省则向 `#audit` 现取（`reconcile()` 会传整批共享的那一份，省掉重复读取）
   * @param {string} trigger - 触发源（`RESTRICT_TRIGGERS` 之一）；**由调用方传入，本函数不得写死**
   * @returns {Promise<'applied'|'lifted'|'degraded'|'unchanged'|'undetermined'|'error'>}
   *   ⚠️ 返回值**不含** `restored` / `replaced`：那两个是**审计 decision**，不是返回码 ——
   *   既有用例（第二/三批）以 `sync()` 的返回值为断言，改它会把已验收的证据形态一起改掉。
   */
  async sync(agent, names, phase, history, trigger) {
    if (!agent || typeof agent !== 'object') return 'unchanged'

    const cur = phase ?? this.currentPhase()
    if (cur === null) return 'undetermined'

    const want = Array.isArray(names) ? names : desiredDeny(cur, this.#cfg)
    const prev = this.#entries.get(agent)

    // —— 幂等闸门：期望名单没变 ⇒ 一个字节都不动（含不写审计） ——
    // 否则每次阶段推进都会对全部 agent 追加一层 restriction（交集 ⇒ 越叠越窄），
    // 而且审计会被"没发生变化的重算"淹没。
    if (prev && keyOf(prev.desired) === keyOf(want)) return 'unchanged'

    // —— 本次要落哪个 decision（第四批）：默认 applied，两类场景下改写 ——
    let decision = 'restrict-applied'
    let from = null
    let to = null
    let decisionNote = null

    if (!prev && want.length > 0) {
      // prev 缺失 = 本进程/本实例没见过它。查链上最近一条决策，判别"叠加"还是"接续"。
      const hist = history === undefined ? this.#historySnapshot() : history
      const last = typeof hist?.get === 'function' ? hist.get(agent?.id ?? null) : undefined
      const c = classifyRestore(last, want)
      decision = c.decision
      from = c.from
      decisionNote = c.note
    } else if (prev && (prev.desired ?? []).length > 0 && want.length > 0) {
      // 前后名单**都非空且不同** ⇒ 真正的名单替换（走到这里必然不同：相同已被上面的闸门拦掉）。
      // 方案 A：`[] → ['pwsh']`（离开受保护阶段再进入）**不算**替换 —— 上一状态已由 lifted 表达清楚，
      // 且 `restrict-applied` 是"当前是否处于受保护状态"的核心检索键，不该被降级。
      decision = 'restrict-replaced'
      from = [...prev.desired]
      to = [...want]
      decisionNote = '名单被替换（前后都非空）⇒ 旧层已 dispose、新层已挂；这不是"离开受保护阶段"'
    }

    // —— 语义变更 ⇒ 必须先 dispose 旧的，再挂新的 ——
    if (prev?.dispose) {
      try {
        prev.dispose()
      } catch {
        // disposer 抛错也要继续：摘不掉旧的不能成为不挂新的理由（宁可两层，不可零层）
      }
    }

    if (want.length === 0) {
      const hadAny = (prev?.applied ?? []).length > 0
      this.#entries.set(agent, { desired: [], applied: [], dispose: null })

      // —— 本进程台账内确有"有过 → 无"的转变 ⇒ 真摘除 ——
      if (hadAny) {
        await this.#note({
          decision: 'restrict-lifted',
          agent: agent.id ?? null,
          phase: cur,
          trigger,
          denied: [],
          skipped: [],
          via: LIFT_VIA.LEDGER,
          from: prev?.appliedSeq ?? null,
          note:
            '离开受保护阶段：限制已摘除（工具重新可见）。' +
            'via=ledger ⇒ 本进程**确实挂过又摘掉**，不是推断'
        })
        return 'lifted'
      }

      // —— 第五批：跨进程可见性（0007 §3）——
      // 本进程从未挂过（没有"从有到无"可记），但**链上索引**显示它最后一条仍是"带着限制"的。
      // 从进程视角这确实不是一次摘除；但**从读者视角**，链上 `restored` 之后没有下文，
      // 读的人无从判断"这些限制现在还在不在" —— 这个静默点必须补。
      //
      // 判据走**索引**而不是 `prev`：跨进程时 `prev` 必然缺失，而索引本来就在内存里
      // （与第四批 `restored` 共用同一份，**零额外 IO**）。
      // 落完之后 `record()` 会把索引增量更新成 `lifted` ⇒ 下次对账不再落（幂等天然成立）。
      const hist = history === undefined ? this.#historySnapshot() : history
      const last = typeof hist?.get === 'function' ? hist.get(agent?.id ?? null) : undefined
      if (isCarrying(last)) {
        await this.#note({
          decision: 'restrict-lifted',
          agent: agent.id ?? null,
          phase: cur,
          trigger,
          denied: [...last.denied],
          skipped: [],
          via: LIFT_VIA.INDEX,
          from: Number.isInteger(last.seq) ? last.seq : null,
          note:
            `本进程从未挂过限制，但链上最近一条（#${last.seq ?? '?'} ${last.decision}）显示它带着 ` +
            `${JSON.stringify(last.denied)} ⇒ 记录"这些限制到此不再生效"。` +
            'via=index ⇒ **跨进程推断**，不是本进程摘除；摘除动作发生在上一个进程退出时'
        })
        return 'lifted'
      }
      return 'unchanged'
    }

    const { dispose, applied, skipped, error } = this.#tryRestrict(agent, want)

    if (error !== null) {
      // 不是"点名失败"这类可诊断错误（例如 `requires a scoped context`）。
      // 保护没挂上是事实 ⇒ 必须留痕，且不能写"applied"假装成功。
      this.#entries.set(agent, { desired: want, applied: [], dispose: null, error })
      await this.#note({
        decision: 'restrict-error',
        agent: agent.id ?? null,
        phase: cur,
        trigger,
        denied: [],
        skipped: want,
        note: error
      })
      return 'error'
    }

    this.#entries.set(agent, { desired: want, applied, dispose })

    if (applied.length === 0) {
      // 挂失败（degraded）时 **decision 不改写**：没有真实生效的限制，谈不上 restored / replaced。
      await this.#note({
        decision: 'restrict-degraded',
        agent: agent.id ?? null,
        phase: cur,
        trigger,
        denied: [],
        skipped,
        note: '名单里的名字在本部署一个都不存在 ⇒ 保护完全失效（不是拦住了，是没拦）'
      })
      return 'degraded'
    }

    const rec = {
      decision,
      agent: agent.id ?? null,
      phase: cur,
      trigger,
      denied: applied,
      skipped,
      note:
        decisionNote ??
        (skipped.length === 0
          ? '已对该 agent 隐藏名单内工具'
          : '点名失败的名字（本部署不存在），明确不拦、仅记录说明（绝不假装拦住了）')
    }
    // `from` 落盘：`restored` 即使源头不可考也要**显式写 null**（不是"没写"）—— 读者不必再猜
    // "没写"是"没找到"还是"忘了写"；其余 decision 沿用"没有就不写"（`applied` 的 from 本来就恒无）。
    if (decision === 'restrict-restored') {
      rec.from = from ?? null
    } else if (from !== null && from !== undefined) {
      rec.from = from
    }
    if (to !== null && to !== undefined) rec.to = to

    const seq = await this.#note(rec)
    // 「最后一条 applied 的 seq」：`untrack()` 落 `untracked` 时用它当 `from`（0005 §2）。
    // 🔴 只在 *applied* 时取本次 seq —— 否则多次重启后它会变成一条 restored 的 seq（链式同病）。
    // restored 时沿用从索引带回的源头 seq ⇒ 跨重启也不丢（销毁时 from 仍指最初那条 applied）。
    const entry = this.#entries.get(agent)
    if (entry) {
      // ⚠️ `prev` 是**旧** entry（`this.#entries.set()` 已经换成了新对象），旧值只能从这里取。
      // `replaced` 走"沿用"而不是"推进"：它不是一条 applied，但它**没打断**限制的连续性
      // （只是换了名单）⇒ 源头仍是那条 applied。若在这里置 null，销毁时会落 `from: null`
      // ⇒ 读者被告知"源头不可考"，而我们明明知道（0006 §5.2：那不是"没有就不编"，是"有却丢了"）。
      entry.appliedSeq =
        decision === 'restrict-applied'
          ? (seq ?? null)
          : decision === 'restrict-replaced'
            ? (prev?.appliedSeq ?? null)
            : Number.isInteger(from)
              ? from
              : null
    }
    return 'applied'
  }

  /**
   * 真正调用 `restrict()`。分两步：先全名单试；若因"名字不存在"失败，用剩下的重试。
   *
   * 🔴 `agent.ctx.tools` **每次现取**：它经 cordis traceable 代理，每次属性访问都新建 Proxy，
   * 缓存到长期变量再跨阶段用会拿到某个时刻的陈旧代理（施工单 §4）。
   *
   * @param {object} agent
   * @param {string[]} want
   */
  #tryRestrict(agent, want) {
    const call = (names) => agent.ctx.tools.restrict({ deny: names })

    let dispose = null
    try {
      dispose = call(want)
      return { dispose, applied: [...want], skipped: [], error: null }
    } catch (e) {
      const unknown = parseUnknownNames(e?.message)
      if (unknown.length === 0) {
        return { dispose: null, applied: [], skipped: [], error: String(e?.message ?? e) }
      }
      const rest = want.filter((n) => !unknown.includes(n))
      if (rest.length === 0) {
        // 全名单都点不上 —— 交给上层记 `restrict-degraded`（不是 applied）。
        return { dispose: null, applied: [], skipped: unknown, error: null }
      }
      try {
        dispose = call(rest)
        return { dispose, applied: rest, skipped: unknown, error: null }
      } catch (e2) {
        return {
          dispose: null,
          applied: [],
          skipped: unknown,
          error: `二次重试仍失败：${String(e2?.message ?? e2)}`
        }
      }
    }
  }

  /**
   * `agent/disposed` 时调用：清台账 + **留痕**（第四批以前这里是纯静默）。
   *
   * 不需要手工 dispose —— `restrict()` 内部是 `layers.effect(this.ctx, …)`，而那个 `this.ctx` 经代理是
   * **agentCtx** ⇒ effect 归 agent 的 fiber 所有，agent 销毁时自动撤销（施工单 §2.3）。
   * 这里只清理 Map，防止已死 agent 的台账永久留存。
   *
   * ### 三条实现约束（缺一条都会在活体上变形）
   *
   * 1. **签名是 async**（写审计必须异步），但**台账删除是同步的** —— 返回 promise 时 `#entries`
   *    必须已经清掉，否则"销毁后还能在台账里看到它"会污染后续对账。
   * 2. **`agent.id` 必须在 await 之前取**：`disposed` 时它可能已经读不出来了。
   * 3. **门**：只有"确实带着限制的会话"才落 `untracked`（与 `lifted` 同口径，见下），
   *    否则每个会话关闭都刷一条 ⇒ 把真正的信号淹掉。
   *
   * ⚠️ **DSH 整体退出时可能来不及落盘**：这条会进 `AuditChain.#outbox`，
   * 不能拿它当"一定已持久化"的保证（README §6.7 已写明）。
   *
   * @param {object} agent
   * @param {string} trigger - 触发源（目前唯一入口是 `agent/disposed`；显式传，不设默认值）
   * @returns {Promise<void>} 永不 reject（销毁路径上的异常必须就地吞掉）
   */
  async untrack(agent, trigger) {
    if (!agent) return
    const id = agent?.id ?? null // 先取 id：await 之后 agent 可能已不可读
    const prev = this.#entries.get(agent)
    this.#entries.delete(agent) // 同步删除（约束 1）

    if (!prev || (prev.applied?.length ?? 0) === 0) return // 门（约束 3）

    try {
      await this.#note({
        decision: 'restrict-untracked',
        agent: id,
        phase: this.currentPhase(),
        trigger,
        denied: [...prev.applied],
        from: prev.appliedSeq ?? null,
        note: 'agent 已销毁 ⇒ 台账终结（该 agent 那层 restriction 随其 fiber 自动撤销，此处只清台账）'
      })
    } catch {
      // 销毁路径：审计写失败不得抛出（agent 正在被销毁，没有"重试"这回事）
    }
  }

  /**
   * 给**编排层**（`installRestrict` / `tools.js`）留的一条"降级留痕"通道。
   *
   * 🔴 为什么要单独开门：`#note` 是私有的，而吞错点在**调用方**（不是治理器内部）。
   * 以前那些 `.catch(() => {})` 什么都没留下 ⇒ 对账到底跑没跑、跑失败了没有，**离线完全不可知**。
   *
   * ⚠️ 复用 `decision: 'restrict-degraded'`，依赖 `via` **字段**判别来源 —— 与既有的
   * 「全名单点不上 ⇒ degraded」（那条**没有** `via`）不是同一回事，不要合并处理。
   * ⇒ 反向判据只能按 `via ∈ VIA_SWALLOWED` 判，**不能**按 `decision` 计数。
   *
   * @param {string} via - 吞错点标识（`inject-reconcile` / `inject-failed` / `advance-reconcile` …）
   * @param {unknown} error - 被吞掉的异常
   * @param {string} trigger - 触发源（`RESTRICT_TRIGGERS` 之一）
   * @returns {Promise<void>} **永不 reject**：这是最后一道防线，它自己不可以是新的崩溃源。
   */
  async noteDegraded(via, error, trigger) {
    try {
      await this.#note({
        decision: 'restrict-degraded',
        agent: null,
        phase: this.currentPhase(),
        trigger,
        denied: [],
        skipped: [],
        via,
        note: `restrict 路径吞掉的异常（via=${via}）：${String(error?.message ?? error)}`
      })
    } catch {
      // 走到这里说明审计链自己也坏了 —— 那就真的无处可写，至少不能连累调用方。
    }
  }

  /** 插件卸载：摘掉所有由本治理器挂上的限制。 */
  disposeAll() {
    for (const [, entry] of this.#entries) {
      if (entry.dispose) {
        try {
          entry.dispose()
        } catch {
          // 卸载路径：单个抛错不影响其余（agent 可能已死，effect 已随 fiber 撤销）
        }
      }
    }
    this.#entries.clear()
  }

  /** 当前台账里的 agent 数（自测用）。 */
  get size() {
    return this.#entries.size
  }

  /**
   * 取某 agent 的台账快照（自测用，不影响行为）。
   * @param {object} agent
   */
  entryOf(agent) {
    const e = this.#entries.get(agent)
    return e ? { desired: [...e.desired], applied: [...e.applied], hasDispose: !!e.dispose } : undefined
  }

  /**
   * 向 `#audit` 现取「agent → 最近一条 restrict 决策」。
   *
   * 🔴 走**可选接口 + duck typing**：`latestRestrictByAgent` 不存在（旧 audit / 假 audit / 未落盘）
   * ⇒ 返回 `null` ⇒ 调用方一律按"查不到"退化成 `applied`（fail-safe：绝不因查不到历史就不挂限制）。
   *
   * @returns {Map<string, object>|null}
   */
  #historySnapshot() {
    try {
      return this.#audit?.latestRestrictByAgent?.() ?? null
    } catch {
      return null
    }
  }

  /**
   * 公开版 `#historySnapshot()`：给编排层（`installRestrict`）在 `session-start` 里取一次、传进 `sync()`。
   * 语义与内部版完全一致（查不到 ⇒ `null` ⇒ 退化为 `applied`）。
   */
  historySnapshot() {
    return this.#historySnapshot()
  }

  /** 候选集合：track 过的 ∪ `agents.list()`。 */
  #collectAgents() {
    const set = new Set(this.#entries.keys())
    try {
      const listed = this.#agentsCtx?.agents?.list?.() ?? []
      for (const a of listed) if (a !== undefined && a !== null) set.add(a)
    } catch {
      // agents 服务不可用 / list 抛错 ⇒ 退化到只处理 track 过的（仍覆盖绝大多数场景）
    }
    return [...set]
  }

  /**
   * 写一条 `type:'restrict'` 审计，**并要回执**（`persisted`：是否真的落盘）。
   *
   * 只有「必须知道到底写进去没有」的调用点用（当前只有 `reconcile()` 的盲区去重闸门，见 0009 §3）。
   *
   * @returns {Promise<{seq: number|null, persisted: boolean}>}
   *   `persisted` **只在 `appendFile` 成功时为 true**；进 outbox（待 `flush()` 重放）不算 ——
   *   outbox 里的东西此刻还没写进链，读者看不到，就不能算"已经报告过"。
   */
  async #noteWithReceipt(entry) {
    try {
      const r = await this.#audit.record({ type: 'restrict', ...entry })
      return { seq: r?.seq ?? null, persisted: r?.persisted === true }
    } catch {
      return { seq: null, persisted: false }
    }
  }

  /**
   * 写一条 `type:'restrict'` 审计（复用 phase 自己的哈希链，不新开文件）。
   * 审计失败绝不影响控制流 —— 记录属性失败不得让"限制"本身崩掉。
   *
   * ⚠️ **失败被吞掉，只以 `seq === null` 表达**（不抛）。需要区分"写盘失败"的调用点请用
   * `#noteWithReceipt()` —— 0009 §3 的缝正是出在这里：看返回值以为成功，其实是静默失败。
   *
   * @returns {Promise<number|null>}
   */
  async #note(entry) {
    return (await this.#noteWithReceipt(entry)).seq
  }
}

/**
 * 挂载 restrict 治理：`session-start` 管新会话、`agents.list()` 管全量对账。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化配置
 * @param {import('./audit.js').AuditChain} audit
 * @returns {{governor: RestrictGovernor, dispose: () => void}}
 */
export function installRestrict(ctx, cfg, audit) {
  const governor = new RestrictGovernor({ cfg, audit })
  const cleanups = []

  // 新会话：建立当下就按**当前阶段**算一次（此时可能已在受保护阶段 ⇒ 立刻被套上限制）。
  cleanups.push(
    ctx.on('agent/session-start', (payload) => {
      const agent = payload?.agent
      if (!agent) return
      // 刻意不 await：会话启动不该被"套限制"这件事阻塞。
      // 传整批共享的 history：新会话也可能是对"重启前就带着限制"的接续（restored 判据同样适用）。
      // 🔴 第三批：这里的 `.catch` 原本什么都不留 —— session-start 这一整条
      //    sync 路径失败时离线**完全不可知**。改为落一条 restrict-degraded（via 标明出处）。
      governor
        .sync(agent, undefined, undefined, governor.historySnapshot(), 'session-start')
        .catch((e) => governor.noteDegraded('session-start-sync', e, 'session-start'))
    })
  )

  // 会话销毁：清台账 + 落 `restrict-untracked`（限制随 agent 的 fiber 自动撤销，不必手工 dispose）。
  // ⚠️ 这里是**同步回调**，而 untrack 是 async ⇒ fire-and-forget + 显式 catch（不留未处理 rejection）。
  cleanups.push(
    ctx.on('agent/disposed', (payload) => {
      if (payload?.agent) {
        void governor
          .untrack(payload.agent, 'agent-disposed')
          .catch((e) => governor.noteDegraded('agent-disposed-async', e, 'agent-disposed'))
      }
    })
  )

  // agents 服务可用后：① 能拿到全量 list() ② 立即对账一次，覆盖"插件装载前就存在"的会话。
  // 🔴 这一步不能省 —— 少了它，插件热装载之前开着的会话永远不会被限制（判据 5 的变体）。
  try {
    const fiber = ctx.inject(['agents'], (injected) => {
      governor.bind(injected)
      governor
        .reconcile(undefined, 'full-reconcile')
        .catch((e) => governor.noteDegraded('inject-reconcile', e, 'full-reconcile'))
      return () => governor.bind(null)
    })
    cleanups.push(() => fiber?.dispose?.())
  } catch (e) {
    // inject 失败不致命：退化为只覆盖 session-start 之后的会话（README 会写明这一降级）。
    // 🔴 第三批：这个降级本身必须留痕 —— 否则读者看到"装载后没有全量对账记录"时，
    //    分不清是"没触发"还是"触发了但对不上"。
    void governor.noteDegraded('inject-failed', e, 'full-reconcile')
  }

  return {
    governor,
    // ⚠️ 刻意写成箭头函数属性：`ctx.effect(() => restrict.dispose, …)` 会把方法**脱离 this** 传给 effect，
    // 届时 `this.governor` 为 undefined（与第一批 P0-1 同款的"注销器被取出"陷阱）。
    dispose: () => {
      governor.disposeAll()
      for (const fn of cleanups) {
        try {
          fn()
        } catch {
          // 卸载路径的单个抛错不影响其余清理
        }
      }
    }
  }
}
