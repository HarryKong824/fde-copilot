import { realpathSync, readlinkSync, lstatSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * 路径判定工具。
 *
 * 这里是全插件唯一"必须同步"的模块 —— `ctx.tools.guard()` 的签名是
 * `(exec) => string | undefined`，同步返回，所以不能出现任何 await。
 * 因此 canonicalize 用 `fs.realpathSync` 而非 `fs/promises`。
 */

/** Windows / macOS 的文件系统大小写不敏感，比较前统一小写。 */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

/**
 * 同步 canonicalize：解析符号链接，且对"尚不存在"的路径同样有效。
 *
 * `realpathSync` 遇到不存在的路径会抛，而写到 ontology 下的**新文件**恰恰是
 * 我们要拦的主要情形之一。所以从最深的已存在祖先开始 realpath，再把剩余的
 * 路径段原样拼回去 —— 这样 `ontology/evil.txt`（新文件）也能被正确解析到
 * ontology 的 canonical 路径之下。
 *
 * @param {string} p - 任意路径（相对路径按 process.cwd() 解析）
 * @returns {string} 绝对、已规范化、符号链接已解析的路径
 */
export function canonicalizeSync(p) {
  const abs = resolve(p)
  /** @type {string[]} 从叶子往上收集的、尚不存在的路径段 */
  const missing = []
  let cur = abs

  for (;;) {
    let real = null
    try {
      real = realpathSync.native(cur)
    } catch {
      // realpath 失败（如 Windows 上对"目录符号链接 + 新文件"抛 ENOENT），留待下方处理。
    }
    // Windows 上 realpathSync.native 对目录符号链接可能既不抛错也不跟随（直接返回符号链接自身路径）。
    // 因此显式用 lstat 判断是否符号链接，命中则改用 readlink 解析真实目标，两个方向都覆盖：
    //   - 区外符号链接 → ontology：解析后归一到 ontology，正确判为区内并拦截（防逃逸）；
    //   - ontology 内符号链接 → 区外：解析后归一到区外，正确判为区外（不误拒）。
    let isSymlink = false
    try {
      isSymlink = lstatSync(cur).isSymbolicLink()
    } catch {
      isSymlink = false
    }

    if (real !== null && !isSymlink) {
      return missing.length === 0 ? real : resolve(real, ...missing.reverse())
    }
    if (isSymlink) {
      const target = readlinkSync(cur)
      const resolvedTarget = resolve(dirname(cur), target)
      return missing.length === 0
        ? resolvedTarget
        : resolve(resolvedTarget, ...missing.reverse())
    }

    // 既非符号链接、realpath 又失败：向上走一级。
    const parent = dirname(cur)
    // 走到根仍然失败：整条路径都解析不了，退回纯字符串规范化。
    if (parent === cur) return abs
    missing.push(basename(cur))
    cur = parent
  }
}

/**
 * 用于比较的键：canonicalize 后再按平台决定是否折叠大小写。
 * @param {string} p
 * @returns {string}
 */
function comparisonKey(p) {
  const canonical = canonicalizeSync(p)
  return CASE_INSENSITIVE ? canonical.toLowerCase() : canonical
}

/**
 * target 是否落在 root 之内（含 root 自身）。canonicalize-then-contain。
 *
 * 注意末尾分隔符：只用 `startsWith` 会误判 —— `/a/ontology-evil` 会被
 * `/a/ontology` 判成"在内"。
 *
 * @param {string} target - 待判定的目标路径
 * @param {string} root - 受保护目录
 * @returns {boolean}
 */
export function isInside(target, root) {
  const t = comparisonKey(target)
  const r = comparisonKey(root)
  if (t === r) return true
  const prefix = r.endsWith(sep) ? r : r + sep
  return t.startsWith(prefix)
}

/**
 * 把工具参数里的一个路径字符串展开成候选绝对路径。
 *
 * 相对路径无法在 guard 里可靠还原成会话的真实 cwd（guard 只拿到 exec，
 * 拿不到会话 cwd 的稳定句柄），所以这里 **fail-closed**：对每个基准各解析一次，
 * 调用方对**全部候选**都判一次，任一命中 ontology 即拒绝。
 *
 * @param {unknown} raw - 参数里的原始值
 * @param {string[]} roots - 解析基准列表
 * @returns {string[]} 候选绝对路径
 */
export function toCandidates(raw, roots) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return []
  if (isAbsolute(raw)) return [raw]
  return roots.map((root) => resolve(root, raw))
}

/**
 * 从 exec 上尽力取出会话 cwd；取不到就回退到配置的基准。
 *
 * ⚠️ 已对照 `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-tools`@0.1.2-rc.1 类型核实：
 *   - `ToolExecution.agent` 的类型是 `Agent`，其字段为
 *     `{ options, session, inbox, status, ctx }` —— **没有** `cwd`，也**没有** `workspace`。
 *   - `Agent.session` 是 `Session` 类型；运行时 `Session` 类型上**未暴露** `cwd`
 *     （`cwd` 只是会话构建期的入参，而非存活实例字段）。
 *   因此 `agent.cwd` / `agent.workspace.cwd` 必然取不到，`agent.session.cwd` 也通常取不到；
 *   sessionCwdOf 实际会回退到 `fallbackRoot`（默认 = `process.cwd()`）。
 *
 * 路径兜底因此必须 **fail-closed**：对每个基准各解析一次，调用方对全部候选都判一次，
 * 任一命中 ontology 即拒绝（见 guard.js 的 `roots` 多基准 + `isInside` 判定）。
 *
 * @param {unknown} exec - 工具执行对象（含 `agent` 字段）
 * @param {string} fallbackRoot - 配置的 workspaceRoot（解析基准，默认 process.cwd()）
 * @returns {string}
 */
export function sessionCwdOf(exec, fallbackRoot) {
  const agent = /** @type {any} */ (exec)?.agent
  // best-effort，未经运行时验证：个别 Session 实现可能携带 cwd
  const fromSession = agent?.session?.cwd
  for (const value of [fromSession, fallbackRoot, process.cwd()]) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return process.cwd()
}

/**
 * 🔴 受保护根集合的**唯一定义处**（0023 P0-4a / P0-6）。
 *
 * 三个消费者必须共用它，否则会各写一份、各自漂移：
 *   - `guard.js` 的路径兜底判定；
 *   - `index.js` 的启动期打印（P0-6：让漂移**可见**而非静默）；
 *   - 未来任何"当前受保护集"的查询。
 *
 * 组成：`ontologyRoot` + 审计链所在目录（`dirname(auditPath)`）+ 配置化扩展根。
 *
 * 三条**必须保留**的防御：
 *  ① `dirname('') === '.'` —— `auditPath` 留空（PoC 默认只驻内存）时若不跳过，
 *     保护根会变成**进程 cwd** ⇒ 工作区内一切写被拒 ⇒ 死门禁（同 0018 那个形状）；
 *  ② 扩展根里的空串/空白同罪，一律跳过；
 *  ③ 去重按 canonicalize 后的比较键，而不是字面量（`E:\x` 与 `E:\x\` 是同一个目录）。
 *
 * 🔴 返回的是 **{root,label,note,kind} 条目**，不是裸字符串（0024 P0-8）。
 *    为什么连 label / note 也必须从这里出：拒绝文案原先**写死**成
 *    "ontology 只能通过 …；审计链目录不接受任何直写" —— 保护集每扩一次，这句化石
 *    就多说一次谎（实测：写 `fde-state` 被拒时理由仍在讲审计链目录，见 0024 §5）。
 *    若把 label 另建一处映射，就会出现"打印的叫法 ≠ 拒绝的叫法"这个新分叉。
 *    ⇒ **root / label / note 三者同出自这一个函数**，分叉在结构上不可能发生。
 *
 * @param {object} cfg - 已规范化的配置
 * @returns {Array<{root: string, kind: string, label: string, note: string}>}
 */
export function protectedRootsOf(cfg) {
  /** @type {Array<{root: string, kind: string, label: string, note: string}>} */
  const out = []
  /** @type {Set<string>} */
  const seen = new Set()

  const push = (value, kind) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    let key
    try {
      key = comparisonKey(trimmed)
    } catch {
      key = trimmed
    }
    if (seen.has(key)) return
    seen.add(key)
    out.push({ root: trimmed, kind, label: PROTECTED_KINDS[kind].label, note: PROTECTED_KINDS[kind].note })
  }

  push(cfg?.ontologyRoot, 'ontology')
  if (typeof cfg?.auditPath === 'string' && cfg.auditPath.trim().length > 0) {
    push(dirname(cfg.auditPath), 'audit')
  }
  if (Array.isArray(cfg?.protectedExtraRoots)) {
    for (const root of cfg.protectedExtraRoots) push(root, 'extra')
  }
  return out
}

/**
 * 受保护区域的**名称与说明**表（与 `protectedRootsOf` 同一份事实源，勿另建映射）。
 *
 * ⚠️ `ontology` 的 note 里写了工具名，改名时**必须**同步 —— 离线套件
 *    `_gate_audit_guard_test.mjs` D 组有一条拿 `tools.js` 真实导出对拍的断言守着。
 */
export const PROTECTED_KINDS = {
  ontology: {
    label: 'ontology',
    // 🔴 口径必须同时覆盖读与写：本守卫对读写**不作区分**（`guard.js` ③ 段没按动作分叉），
    //    而早期文案只写「直写」⇒ 模型用 read 撞上时会读到"为什么在讲写"，并推断"读该被允许"。
    //    活体实证见 gate.jsonl seq 11（`tool=read`，旧文案却说"直写绕过…"）。
    note:
      'ontology 只能通过 fde_ontology_read / fde_ontology_write 访问 —— ' +
      '读与写都得走这个通道，直连文件会绕过入口的语义判定。'
  },
  audit: {
    label: '审计链目录',
    note:
      '审计链目录不接受任何直接读与写 —— 写入会伪造留痕，读取同样被拒' +
      '（本守卫对读与写不作区分）。'
  },
  extra: {
    label: '额外受保护目录',
    // ⚠️ 这里**不提** fde_ontology_read / write 的名字：它们是 ontology 的专用通道，
    //    与本区域无关；写出来（哪怕是"访问不到"这种否定句式）也会让模型去试这两个工具。
    note: '该目录由 protectedExtraRoots 显式配置：不接受任何直接读与写，也没有专用工具通道。'
  }
}

/**
 * 兜底条目的说明（`guard.js` 里 `hits[0]` 未命中任何已知 kind 时才用）。
 *
 * 实际上不可达（`hits` 就是按"命中某条"筛出来的），留它只为不让"万一"变成进程内抛错。
 * ⚠️ 但它是**第四处**文案：P0-9 改三类 note 时它被漏过一次（0025 自查才发现），
 *    所以这里导出成常量，由离线套件一并断言，不再藏在 guard.js 的字面量里。
 *
 * 口径同样必须覆盖读与写 —— 否则一旦真走到兜底，就又是"读被拒却讲写"。
 */
export const UNKNOWN_PROTECTED_NOTE = '该区域不接受任何直接读与写（守卫对读与写不作区分）。'

/**
 * 启动期那一行"受保护根"的格式化 —— **单独成函数**是为了让它可测（0024 §6）。
 *
 * 之前它只是 index.js 里的一句 `roots.join(' | ')`：与判定同源是**设计声明**，
 * 但"打印到底打对了没有"没人测过（活体上也观测不到 stdout ⇒ 无法背书）。
 * 提成函数后，离线套件能直接断言"打印行含全部 root 与全部 label、且条数一致"。
 *
 * @param {object} cfg - 已规范化的配置
 * @returns {string}
 */
export function formatProtectedRootsLine(cfg) {
  const entries = protectedRootsOf(cfg)
  const body = entries.map((e) => `${e.label}=${e.root}`).join(' | ')
  const line = `受保护根（${entries.length}）：${body}`

  // 沙箱（spec §7）也必须打出来，理由与 P0-6 同：**豁免**比保护更需要在启动期可见 ——
  // 一个配错的沙箱等于保护根上开了个洞，而"洞开着"这件事在运行期没有任何症状。
  // 与判定同源（同一个 `sandboxPathsOf`），故"打印的沙箱"与"豁免的沙箱"不可能不一致。
  const boxes = sandboxPathsOf(cfg)
  if (boxes.length === 0) return line
  const boxBody = boxes.map((b) => `${b.path}（豁免自 ${b.root}）`).join(' | ')
  return `${line} ｜ 沙箱（${boxes.length}）：${boxBody}`
}

/**
 * `protectedExtraRoots` 的加载期校验（fail-closed）。
 *
 * 配错就**加载失败**，而不是静默丢弃：写错一个受保护根，最坏结果是
 * "以为堵上了、其实敞着"，而这类缺口没有任何东西会发现（A② 尤其如此 ——
 * 改 `state.yaml` 之后 `fde_phase_advance` 的 deny 一次都不会跑到）。
 *
 * @param {unknown} value - schema 应用默认值后的 `protectedExtraRoots`
 * @throws {Error} 类型或条目不合法
 */
export function assertProtectedExtraRoots(value) {
  if (value === undefined || value === null) return
  if (!Array.isArray(value)) {
    throw new Error(
      `fde-ontology-gate: protectedExtraRoots 必须是字符串数组，收到 ${JSON.stringify(value)}`
    )
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(
        `fde-ontology-gate: protectedExtraRoots[${index}] 必须是非空字符串，收到 ${JSON.stringify(item)}`
      )
    }
  })
}

/**
 * 沙箱子目录名的合法形态：**单段**（禁 `/ \ :` 与 NUL），且不是 `.` / `..`。
 *
 * 🔴 为什么必须卡"单段"而不是"相对路径"：`sandboxPathsOf()` 用 `join(root, sub)`
 *    把名字拼成绝对路径。若允许 `../memory`，拼出来就是 `<root>/../memory`
 *    —— 那等于给保护根开一个**任意位置**的洞，而这个洞是靠配置文件写出来的，
 *    没有任何判定会质疑它。单段名在结构上排除了穿越。
 */
const SANDBOX_SUBDIR_RE = /^[^/\\:\u0000]+$/

/**
 * `sandboxSubdirs` 的加载期校验（fail-closed，spec v3 §7 探索沙箱）。
 *
 * @param {unknown} value - schema 应用默认值后的 `sandboxSubdirs`
 * @param {unknown} extraRoots - 同批次的 `protectedExtraRoots`
 * @throws {Error} 形态非法，或配了沙箱却没有宿主保护根
 */
export function assertSandboxSubdirs(value, extraRoots) {
  if (value === undefined || value === null) return
  if (!Array.isArray(value)) {
    throw new Error(`fde-ontology-gate: sandboxSubdirs 必须是字符串数组，收到 ${JSON.stringify(value)}`)
  }
  if (value.length === 0) return
  // 沙箱是"保护根内的一个豁免子目录"⇒ 没有保护根就没有宿主，配了也无法生效。
  // 静默忽略会让部署方以为沙箱开着（模型写沙箱仍被拒），而错因指向"保护根"，
  // 排查方向完全跑偏 ⇒ 宁可不加载。
  if (!Array.isArray(extraRoots) || extraRoots.length === 0) {
    throw new Error(
      'fde-ontology-gate: sandboxSubdirs 非空但 protectedExtraRoots 为空 —— ' +
        '沙箱是保护根内的豁免子目录，没有宿主保护根时无法生效（fail-closed）'
    )
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(
        `fde-ontology-gate: sandboxSubdirs[${index}] 必须是非空字符串，收到 ${JSON.stringify(item)}`
      )
    }
    const name = item.trim()
    if (!SANDBOX_SUBDIR_RE.test(name) || name === '.' || name === '..' || isAbsolute(name)) {
      throw new Error(
        `fde-ontology-gate: sandboxSubdirs[${index}] 必须是**单段**子目录名（禁 / \\ : 与 . / ..），` +
          `收到 ${JSON.stringify(item)}`
      )
    }
  })
}

/**
 * 沙箱绝对路径集合 —— **只从 `protectedExtraRoots` 派生**。
 *
 * 🔴 为什么宿主只能是 `extra` 类根：`ontologyRoot`（权威 ontology）与审计目录
 *    （合规证据）都**不允许**出现"可自由读写的子目录"—— 前者一开就等于绕过
 *    `fde_ontology_write` 的语义判定（source 溯源 / 置信度门槛），后者一开就等于
 *    允许伪造留痕。把派生源钉死在 extra 类上，这两个洞在**结构上**不可能出现，
 *    而不是靠"部署方别配错"。
 *
 * @param {object} cfg - 已规范化的配置
 * @returns {Array<{root: string, sub: string, path: string}>}
 */
export function sandboxPathsOf(cfg) {
  /** @type {Array<{root: string, sub: string, path: string}>} */
  const out = []
  const roots = Array.isArray(cfg?.protectedExtraRoots) ? cfg.protectedExtraRoots : []
  const subs = Array.isArray(cfg?.sandboxSubdirs) ? cfg.sandboxSubdirs : []

  for (const root of roots) {
    if (typeof root !== 'string' || root.trim().length === 0) continue
    for (const sub of subs) {
      if (typeof sub !== 'string' || sub.trim().length === 0) continue
      const entry = { root: root.trim(), sub: sub.trim(), path: join(root.trim(), sub.trim()) }
      // join() 本身不产生穿越（`..` 已被 assertSandboxSubdirs 拒），这里再核一次
      // "拼出来的东西真在宿主内" —— 判据是 isInside 本身，不是"我相信 join"。
      if (!isInside(entry.path, entry.root)) continue
      out.push(entry)
    }
  }
  return out
}

/**
 * 沙箱**不得**落在任何**其它**保护根之内（加载期断言，fail-closed）。
 *
 * 场景：`protectedExtraRoots = ['<p>']` 而 `auditPath` 恰好配在 `<p>/experiments/x.jsonl`。
 * 此时把 `<p>/experiments` 设为沙箱，等于在**审计目录**上开了个可写洞 ——
 * 而沙箱数组里只有一格，没人会觉得它和审计有关。
 *
 * @param {object} cfg - 已规范化的配置（protectedExtraRoots / sandboxSubdirs / ontologyRoot / auditPath）
 * @throws {Error} 某条沙箱路径落在其宿主之外的任何保护根内
 */
export function assertSandboxNotInOtherRoots(cfg) {
  const sandboxes = sandboxPathsOf(cfg)
  if (sandboxes.length === 0) return
  const entries = protectedRootsOf(cfg)

  for (const box of sandboxes) {
    for (const entry of entries) {
      // 宿主自身不算"其它" —— 沙箱按定义就在宿主的里面。
      if (comparisonKey(entry.root) === comparisonKey(box.root)) continue
      if (isInside(box.path, entry.root)) {
        throw new Error(
          `fde-ontology-gate: 沙箱 ${box.path} 落在保护根「${entry.label}」= ${entry.root} 之内 —— ` +
            '沙箱只能是其宿主 extra 根内的豁免子目录，不得与其它受保护区域重叠（fail-closed）'
        )
      }
    }
  }
}
