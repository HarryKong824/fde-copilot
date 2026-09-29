import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import {
  isInside,
  protectedRootsOf,
  sandboxPathsOf,
  sessionCwdOf,
  toCandidates,
  UNKNOWN_PROTECTED_NOTE
} from './paths.js'
import { ONTOLOGY_READ, ONTOLOGY_WRITE } from './tools.js'

/**
 * 门禁判定 —— 主防线。
 *
 * `evaluate()` 是**纯同步函数**，同时被两个消费者使用：
 *   - `ctx.tools.guard()`（enforce 模式真拦，只能否决）
 *   - `tools/pre-execute`（两种模式都记录，shadow 模式下把 would-deny 记成 shadow-deny）
 *
 * 判定与留痕共用同一份规则，避免"shadow 说会拦、enforce 却不拦"这类规则漂移。
 */

/** 已知工具的路径参数名。fs 工具是 snake_case 的 `file_path`，不是 `filePath`。 */
const KNOWN_PATH_KEYS = {
  read: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  read_image: ['file_path'],
  str_replace_editor: ['path'],
  [ONTOLOGY_READ]: ['path'],
  [ONTOLOGY_WRITE]: ['path']
}

/**
 * 未知工具的兜底键名。宁可多扫也不要漏 —— 漏一个就是一条绕过路径。
 * 注意同时覆盖 camelCase 与 snake_case：不同工具的 schema 习惯不一致。
 */
const GENERIC_PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'filepath',
  'file',
  'target',
  'target_path',
  'targetPath',
  'directory',
  'dir'
]

/** 疑似路径的 shell token：含分隔符、或以 . / ~ 开头、或带盘符。 */
const SHELL_PATH_LIKE = /(?:[/\\]|^[.~]|^[A-Za-z]:)/

/** 绝对路径锚点：盘符根（`E:\` / `E:/`）或 UNC 前缀（`\\`）。锚点之后的整段即路径。 */
const ABS_PATH_ANCHOR = /[A-Za-z]:[\\/]|[\\/]{2}/g

/**
 * 从 shell 命令串里抠出疑似路径的 token。
 *
 * ⚠️ 这是**有损**的启发式，不是解析器：`cat $VAR/x`、变量拼接、base64 解码后再写
 * 等情形都抓不到。文档 9.1 用它的原因是可以接受漏报（原生沙箱兜第二层）。
 * 不要把它当作可靠边界。
 *
 * ⚠️ **且"原生沙箱兜第二层"对读不成立** —— 原生沙箱**读永远放行**（HANDOFF §7 #5）。
 * 所以 shell 读侧的漏报是**没有任何兜底**的，抓到多少是多少。
 * 2026-09-23 修掉其中一类：引号串内嵌的字面量路径（见下方 split 兜底）。
 *
 * @param {string} command
 * @returns {string[]}
 */
function shellPathTokens(command) {
  const rawTokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  /** @type {string[]} */
  const out = []
  const push = (s) => {
    if (s.length > 0 && !out.includes(s)) out.push(s)
  }

  for (const raw of rawTokens) {
    const token = raw.replace(/^["']|["']$/g, '')
    if (token.length === 0) continue
    if (SHELL_PATH_LIKE.test(token)) push(token)

    // 兜法 ①：引号串被整体抠成**一个** token（如 `"type E:\ontologyRoot\x.md"`）。
    // 整串当相对路径 resolve 必然落空 → 漏报且不落审计（2026-09-23 实测）。
    // 按空白再拆一次，引号内的路径就现形了；相对路径（`..\ontologyRoot\x.md`）也靠这一步。
    if (/\s/.test(token)) {
      for (const piece of token.split(/\s+/)) {
        const inner = piece.replace(/^["']+|["']+$/g, '')
        if (inner !== token && SHELL_PATH_LIKE.test(inner)) push(inner)
      }
    }

    // 兜法 ②：路径被**粘**在别的东西上 —— `--file=E:\x.md`、`(E:\ontologyRoot\*)`、
    // `说明：E:/ontologyRoot\x.md`（无空白，兜法 ① 不触发）。按绝对路径锚点取后缀。
    ABS_PATH_ANCHOR.lastIndex = 0
    let m
    while ((m = ABS_PATH_ANCHOR.exec(token)) !== null) {
      const tail = token.slice(m.index)
      if (tail !== token) push(tail)
    }
  }
  return out
}

/**
 * 从一次调用里收集所有"可能指向文件"的候选路径。
 * @param {{name: string, arguments: unknown}} exec
 * @param {string[]} roots - 相对路径的解析基准（fail-closed：多个基准全判）
 * @returns {string[]}
 */
function collectCandidates(exec, roots) {
  const args = /** @type {Record<string, unknown> | undefined} */ (exec.arguments)
  if (args === null || typeof args !== 'object') return []

  const keys = KNOWN_PATH_KEYS[exec.name] ?? GENERIC_PATH_KEYS
  /** @type {string[]} */
  const candidates = []

  for (const key of keys) {
    candidates.push(...toCandidates(args[key], roots))
  }

  // 任何带 `command` 字符串字段的调用按 shell 处理（bash / pwsh / 持久变体都覆盖），
  // 不硬编码工具名 —— 那些名字没在 .d.ts 里核实过。
  if (typeof args.command === 'string') {
    for (const token of shellPathTokens(args.command)) {
      candidates.push(...toCandidates(token, roots))
    }
  }

  return candidates
}

/**
 * 对一个专用工具写调用做语义判定（source 溯源 + 置信度防污染）。
 * @param {Record<string, unknown>} args
 * @param {object} cfg
 * @returns {string | undefined} 拒绝原因；undefined 表示通过
 */
function evaluateWritePayload(args, cfg) {
  const source = typeof args.source === 'string' ? args.source : ''
  if (source.length === 0) return 'fde_ontology_write 缺少 source，无法做来源溯源'

  if (!cfg.allowedWriteSources.includes(source)) {
    return `来源 ${source} 不在允许写入 ontology 的来源表内（${cfg.allowedWriteSources.join(' / ')}）`
  }

  if (source === 'model') {
    const confidence = typeof args.confidence === 'number' ? args.confidence : Number.NaN
    if (!Number.isFinite(confidence)) {
      return 'source 为 model 时必须给出 confidence'
    }
    if (confidence < cfg.minConfidence) {
      return `置信度 ${confidence} 低于门槛 ${cfg.minConfidence}，拒绝写入以避免污染 ontology`
    }
  }

  if (typeof args.reason !== 'string' || args.reason.trim().length === 0) {
    return 'fde_ontology_write 缺少 reason'
  }

  return undefined
}

/**
 * 纯同步判定。返回 undefined 表示放行。
 *
 * @param {Readonly<{name: string, arguments: unknown, agent?: unknown}>} exec
 * @param {object} cfg - 已规范化配置
 * @param {boolean} applySemanticRules - false 时跳过路径/语义规则（shadow 模式用）
 * @returns {{deny: string | undefined, skipReason?: string, hits: string[], modeIndependent?: boolean}}
 *   modeIndependent === true 表示该拒绝与 cfg.mode 无关（shadow 下同样真拦）——
 *   审计标签必须据此记 'deny'，否则会出现"记 shadow-deny、实际却拦住了"的反向留痕（缺陷 ①）。
 */
export function evaluateRules(exec, cfg, applySemanticRules) {
  // ① PTC 通道：与 mode 无关，独立开关。
  //    run_code 是保留名，restrict 点名会报错，所以只能在这里拒。
  //    modeIndependent: true —— 本判定位于 applySemanticRules 早退之前，shadow 下也【真拦】，
  //    审计必须记 'deny' 而非 'shadow-deny'，否则标签与实际决策相反（缺陷 ①）。
  //    ⚠️ `denyId: 'GATE-PTC'` **不在** `BYPASSABLE_DENY_IDS` 里 ⇒ 永远不被 break-glass 放行。
  //    理由：它不是"门禁判错了"，而是一个**部署级的通道开关**（`cfg.denyRunCode`）；
  //    要放行该通道应当改配置，而不是砸玻璃 —— 否则等于把"关掉 PTC 策略"伪装成一次紧急绕过。
  if (cfg.denyRunCode && exec.name === RUN_CODE_NAME) {
    return {
      deny: 'PTC 通道（run_code）已按门禁策略禁用：它不受 restrict 约束，且其内部代码无法被路径守卫审计',
      denyId: 'GATE-PTC',
      hits: [],
      modeIndependent: true
    }
  }

  if (!applySemanticRules) return { deny: undefined, hits: [] }

  // ② 专用工具入口的语义判定 —— 主防线。
  if (exec.name === ONTOLOGY_WRITE) {
    const args = /** @type {Record<string, unknown>} */ (exec.arguments ?? {})
    const reason = evaluateWritePayload(args, cfg)
    if (reason !== undefined) return { deny: reason, denyId: 'GATE-CLASSIFY', hits: [] }
    return { deny: undefined, hits: [] }
  }

  // ③ 路径兜底 —— 拦"绕过专用工具直奔 ontology / 审计目录直写"的通用 fs / shell 调用。
  //
  // 🔴 受保护集原本**只有** `cfg.ontologyRoot` 一个（0019 §4 实测的缺口）：
  //    审计链（`cfg.auditPath`）落在 `ontologyRoot` **之外** ⇒ 模型只要获准提权一次
  //    （`danger-full-access`）就能改写审计链 ⇒ 留痕即失效，而门禁自己没有任何判定。
  //    ⇒ 本段把审计目录一并纳入（0022 P0-2）。
  //
  // ⚠️ 空串判空、去重、扩展根的全部规则都在 `protectedRootsOf()` 里（paths.js）。
  //    这里是**唯一**的判定入口，index.js 的启动打印复用同一个函数 ——
  //    "打印出来的保护根"和"真正判的保护根"字面上不可能不一致（0023 P0-6）。
  const protectedRoots = protectedRootsOf(cfg)

  // 探索沙箱（spec §7）：保护根内**豁免**的子树。派生源只有 `protectedExtraRoots`
  // （见 `sandboxPathsOf`），所以 ontologyRoot / 审计目录**拿不到**豁免 —— 那是刻意的。
  const sandboxes = sandboxPathsOf(cfg)

  const roots = [sessionCwdOf(exec, cfg.workspaceRoot), process.cwd(), cfg.workspaceRoot]
  const uniqueRoots = [...new Set(roots)]
  const hits = collectCandidates(exec, uniqueRoots)
    .filter((candidate) => protectedRoots.some((entry) => isInside(candidate, entry.root)))
    .filter((candidate) => !sandboxes.some((box) => isInside(candidate, box.path)))

  if (hits.length > 0) {
    // 🔴 文案由**命中的那一条**生成（0024 P0-8），不是写死的一句话。
    //    写死的形态是"ontology 只能通过 …；审计链目录不接受任何直写" —— 无论命中哪个根
    //    都把两句全说一遍 ⇒ 写 `fde-state` 被拒时理由在讲审计链目录（实测 0024 §5.1），
    //    模型因此建立错误的心理模型。现在 label / note 取自命中条目本身。
    // hits[0] 必然命中某一条（上面就是按这个条件筛的）；留兜底只为不让"万一"变成进程内抛错。
    const matched = protectedRoots.find((entry) => isInside(hits[0], entry.root)) ?? {
      label: '受保护区域',
      note: UNKNOWN_PROTECTED_NOTE
    }
    return {
      deny: `目标路径命中受保护区域（${matched.label}）：${hits[0]}。${matched.note}`,
      denyId: 'GATE-PATH',
      hits
    }
  }

  return { deny: undefined, hits: [] }
}

/**
 * 判定入口（guard 与 pre-execute 都走这里）：先跑规则，再问 break-glass 放行表。
 *
 * 🔴 **为什么把"跑规则"与"要不要放行"分成两层**：`evaluateRules` 是纯规则（可单独断言），
 *    放行是**策略**（带 IO 依赖的放行表）。混在一层里，测试就没法在不构造放行表的情况下
 *    验"规则本身还对不对"—— 而那种测试恰恰是最该长期保留的。
 *
 * 🔴 放行**只对 `denyId` 在 `BYPASSABLE_DENY_IDS` 里的项生效**，且这条约束钉在
 *    `bg-mirror.js` 的 `isBypassed()` **内部**（第一行短路），不在本文件。
 *    为什么不在这里判：这里是**每个消费者各写一遍**的地方，而"哪些 id 可绕"是
 *    两个插件共有的**同一个事实** —— 放在共享模块里只可能有一份，放在这里就会有两份。
 *    ⇒ `GATE-PTC`（PTC 通道开关）永不被放行：它在 `BYPASSABLE_DENY_IDS` 之外。
 *
 *    ⚠️ 2026-09-29 订正：本段原写的是"表里只可能有那些 id（enum 挡在前面）⇒ 双保险"。
 *    **那个"保险"当时并不存在** —— `isBypassed` 原先只查表内容，不查 id 是否可绕；
 *    实测把 `GATE-PTC` 硬塞进表就能绕过。现在短路那条已补进 `bg-mirror.js`，
 *    本段才成立。（教训：注释里写下的机制，要么当场在代码里指出它在哪一行，要么别写。）
 *
 * @param {Readonly<{name:string, arguments:unknown, agent?:unknown}>} exec
 * @param {object} cfg
 * @param {boolean} applySemanticRules
 * @param {import('./bg-mirror.js').BreakGlassMirror} [bg] - 缺省 ⇒ 无任何放行（fail-closed）
 * @returns {{deny:string|undefined, denyId?:string, hits:string[], modeIndependent?:boolean, bypassed?:string}}
 */
export function evaluate(exec, cfg, applySemanticRules, bg) {
  const res = evaluateRules(exec, cfg, applySemanticRules)
  if (res.deny === undefined || res.denyId === undefined) return res
  if (bg && bg.isBypassed(res.denyId)) {
    // ⚠️ `hits` 要原样带出去：pre-execute 的审计要靠它说明"命中了哪个路径"，
    //    丢掉它会让 break-glass 放行的那一条记录变成一句无从复核的话。
    return { deny: undefined, hits: res.hits, bypassed: res.denyId, modeIndependent: res.modeIndependent }
  }
  return res
}

/**
 * 注册单调 guard。只在 enforce 模式下真正否决。
 *
 * guard 的语义：同步、返回字符串即拒绝、且不可被任何后续监听器翻盘。
 *
 * ⚠️ break-glass（spec §11）**不改 guard 的单调性**：放行发生在 `evaluateRules` 之后、
 *    返回 deny 之前 —— 即"规则说该拦，但放行表里有一条有效记录"。一旦真返回了 deny，
 *    仍然没有任何下游监听器能翻盘。这是有意的：逃生门只能开在**门禁自己的判定里**，
 *    不能变成一个"谁都能挂上去翻案"的后门。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg
 * @param {import('./bg-mirror.js').BreakGlassMirror} [bg] - 缺省 ⇒ 无放行（fail-closed）
 * @returns {() => void} 注销器
 */
export function installGuard(ctx, cfg, bg) {
  const applySemanticRules = cfg.mode === 'enforce'
  return ctx.tools.guard((exec) => evaluate(exec, cfg, applySemanticRules, bg).deny)
}
