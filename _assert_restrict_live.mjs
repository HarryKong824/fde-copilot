/**
 * 对活体 transcript 的 `request/header` 原文断言 restrict 是否生效。
 *
 * **为什么不听模型自报工具清单**：那份清单是模型转述，可以被它自己改写/省略。
 * `request/header` 是**宿主机写进 transcript** 的事件，`header.tools` 就是该次请求发给模型的
 * 完整工具清单（`canonicalHeader` 原样保留 `tools`，`dsh-session/lib/index.js:380-388`），
 * 且**只在 header 变化时才追加**（`reason: initial | resume | change | series`，
 * `dsh-agent-loop/lib/index.js:742-754`）。这是原文级证据。（照 `_assert_lock_msg.mjs` 的先例）
 *
 * 🔴 必须**双向断言**：
 *    - 「目标名字不在 tools 里」—— 只看这一条会假绿：如果 restrict 压根没生效、
 *      压根没产生新 header，旧 header 里那个工具**本来就不在**（比如会话在别的 preset 下建的）。
 *    - 因此还要断「**确实新出现了一条 header（最好 reason:'change'）**」—— 那才是"清单真变了"的直接证据。
 *    - 给了 baselineSeq 时，还要反锁「baseline 那条 header **有**该工具」（证明是"从有到无"，不是天生没有）。
 *
 * ⚠️ 用法：
 *   node _assert_restrict_live.mjs <sessionId> <with|without> [baselineSeq] [toolName] [--require=a,b,c] [--strict-diff]
 *     without + baselineSeq = 判据 5（已存在会话被即时覆盖）：必须有 change、必须有→无
 *     without（无 baseline）= 判据 2（受保护阶段新开的会话）
 *     with                  = 判据 4（退出受保护阶段，工具回来）
 *     --require=a,b,c       = 额外判"点名的工具都在"（**只从参数进，本文件不内置任何默认清单**）
 *     --strict-diff         = 额外判"baseline→最后一条 **只有目标工具一个**发生变动"（P1-18，默认关）
 * 输出：_assert_restrict_live_out.txt
 * 退出码：**0=ALL-PASS，1=HAS-FAIL，2=用法错误，3=WINDOW-CONTAMINATED（P1-17）**
 *   ⚠️ 3 是**第三种结果**，不是红也不是绿：新 header 里没有 `reason:"change"`
 *   （真数据里 `resume` 也会改清单，多半是重启/重载）⇒ 无从归因 ⇒ **重做活验**，
 *   **不许判过也不许判红**（判红会把归因引到"restrict 没生效"上，那是错的）。
 *
 * ── P1-11（0027 §4）补的三处 ────────────────────────────────────────────────
 * ① **显式缺席判红**：原 `:116` 只靠 `hasRead(last)` 间接捕获"`tools` 键缺席"（缺席 ⇒ read 也不在 ⇒ 红）。
 *    这是**隐式**的：一旦有人改/删那一行，缺口就开。现在改成显式一条
 *    「`tools` 键缺席 ⇒ 判红」，判定复用 `_tool_surface_check.mjs` 的 `judgeToolSurface`
 *    （缺席/空数组/malformed 三态的唯一定义处，避免两份实现走偏）。
 * ② **不传 baselineSeq 时也要有判据**：原来 `:120` 的 `if (baselineSeq !== null)` 块内才有判据，
 *    不传 baseline 时**"清单压根没变"这条完全没人抓**（只剩「最后一条没有 target」一条，
 *    而它天生就成立）。现在不传 baseline 时断言「最后一条 header 的 reason ∈ {initial,resume}」——
 *    ⚠️ 这是**代理判据**，不是直接判据：新开的会话，它的清单就是建会话时那一条（initial/resume）；
 *    出现 `change`/`series` 说明中途变过，那"天生如此"的解释就不成立，必须人工看。
 * ③ **`--require=` 清单只从参数进**：`parseRequire()` 取自 `_tool_surface_check.mjs`，
 *    不传 ⇒ `[]` ⇒ **一条 require 检查都不加**。理由（0027 §3）：63 个会话里有 7 个 n=1 的
 *    专用会话（子代理/专用 agent），**任何内置默认清单都会把它们打成误报**。
 *
 * 🔴 本文件的判定逻辑抽成了纯函数 `buildChecks()`，由 `_assert_restrict_live_test.mjs`
 * （第 18 套）用**合成坏样本**断言它真的会红 —— 与 `_tool_surface_check.mjs` 同一条纪律：
 * **仪器必须对自己的坏样本判红**，否则"通过"不算数。
 */
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { resolveTools, judgeToolSurface, parseRequire } from './_tool_surface_check.mjs'

const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const BASE = 'http://127.0.0.1:3080'
let n = 0

/** 「新开会话」该有的 reason（`initial`= 新建、`resume`= 恢复）。见 P1-11 ② */
export const FRESH_REASONS = ['initial', 'resume']

/**
 * 只在"被直接运行"时才跑 main()。
 *
 * ⚠️ 与 `_tool_surface_check.mjs:isEntryModule()` 同一个理由：本文件被
 * `_assert_restrict_live_test.mjs` import 来断言 `buildChecks()`。若顶层直接 await RPC，
 * import 的瞬间就会在没 cookie / 没 DSH 的环境里抛错 ⇒ 测试进程一条断言都跑不到。
 * 又因为 `isEntryModule()` 比的是**它自己所在模块**的 url，这里不能共用，必须按本文件 url 判。
 */
export function isEntryModule(url = import.meta.url) {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return url === pathToFileURL(argv1).href
  } catch {
    return false
  }
}

function cookieHeader() {
  if (!existsSync(JAR)) return ''
  const parts = []
  for (const raw of readFileSync(JAR, 'utf8').split('\n')) {
    let line = raw.trim()
    if (!line) continue
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const cols = line.split('\t')
    if (cols.length < 7) continue
    parts.push(`${cols[5]}=${cols[6]}`)
  }
  return parts.join('; ')
}

async function rpc(method, argsObj) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `rh${++n}`, method, payload: { args: argsObj } })
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body
  })
  const text = await res.text()
  let j
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(`${method}: 回包不是 JSON（多半缺 auth cookie）→ ${text.slice(0, 120)}`)
  }
  if (j.result?.ok === false) throw new Error(`${method}: ${JSON.stringify(j.result.error)}`)
  return j.result?.value
}

// ---------------------------------------------------------------- 纯逻辑（可被测试 import）

/** 从 `session/page` 的 records 里抽出全部 `request/header`（保留原始 `data`，缺席信息不丢） */
export function extractHeaders(recs) {
  const out = []
  for (const r of recs ?? []) {
    const ev = r?.event ?? r
    if (ev?.type !== 'request/header') continue
    out.push({
      seq: ev.seq ?? r?.seq ?? null,
      // P1-13：配对要按**时间**，所以 `time` 必须和 `data` 一样原样保留
      // （丢了它，后面"审计 ts 早于 header time"这条就无从计算）。
      // 实测 `time` = epoch **毫秒**的 number（`843e3bee` seq=4741 → 1790425633884）。
      time: typeof ev.time === 'number' ? ev.time : null,
      reason: ev.data?.reason ?? null,
      data: ev.data ?? {}
    })
  }
  return out
}

/**
 * P1-13 的配对原语：审计那条是否**早于** header 那条（先跑挂点、后变清单）。
 *
 * 🔴 为什么不用 seq 比大小（Claude 0028 §7.3 原话，0029 §1 他自己认了）：
 * 两条链的 `seq` 是**不同命名空间**（header seq=会话事件序号，实测到 22579；审计 seq=该链行号，15/2）
 * ⇒ `header.seq > audit.seq` **恒真 ⇒ 系统性偏绿**。
 *
 * ⚠️ 两侧单位/类型不同：审计 `ts` 是 **ISO 8601 字符串**（`"2026-09-27T02:19:49.946Z"`），
 * header `time` 是 **epoch 毫秒 number**。两者都归一成 number 再比。
 * **任一不可解析 ⇒ 返回 false**（fail-closed：宁可判红，不许拿 NaN 比较静默变绿）。
 */
export function auditBeforeHeader(auditTs, headerTime) {
  const a = typeof auditTs === 'number' ? auditTs : Date.parse(auditTs)
  const h = typeof headerTime === 'number' ? headerTime : Date.parse(headerTime)
  if (!Number.isFinite(a) || !Number.isFinite(h)) return false
  return a < h
}

/** 取一个 header 的工具名数组（`tools` 缺席 / 非数组 ⇒ `[]`，形状判定交给 judgeToolSurface） */
export function toolsOf(h) {
  const raw = resolveTools(h?.data)
  if (!Array.isArray(raw)) return []
  return raw.map((t) => (typeof t === 'string' ? t : String(t?.name ?? t?.function?.name ?? '?')))
}

/**
 * 组装断言 —— 纯函数，不碰网络/磁盘。
 * @param {object} o
 * @param {{seq:unknown,reason:unknown,data:unknown}[]} o.headers
 * @param {'with'|'without'} o.expect
 * @param {string} [o.target] - 目标工具名（命令行第 4 个位置参数，默认 `pwsh`）
 * @param {number|null} [o.baselineSeq]
 * @param {string[]} [o.require] - 点名必须存在的工具（**不传 ⇒ 一条都不加**）
 * @param {boolean} [o.strictDiff] - 开逐名 diff 断言（P1-18，**默认关**）
 * @param {object|null} [o.window] - 视窗信息 `{firstSeq, hasMore, records}`（P1-16）
 * @returns {{checks: [string, boolean][], last: object|undefined, judged: object|null, bad: number,
 *            contaminated: string|null, verdict: 'pass'|'fail'|'contaminated', diff: object|null}}
 */
export function buildChecks(o) {
  const headers = o?.headers ?? []
  const expect = o?.expect
  const target = o?.target ?? 'pwsh'
  const baselineSeq = o?.baselineSeq ?? null
  const require = Array.isArray(o?.require) ? o.require : []
  const strictDiff = o?.strictDiff === true
  // P2-21 --through：钉终点。throughSeq=null ⇒ 退化为"最后一条"（时点性、会漂移）；
  //   throughSeq 给了 ⇒ 终点必须是 seq===throughSeq 的那条；找不到 ⇒ fail-closed 红
  //   （不许悄悄退化成"最后一条" —— 那正是 0037 C21 假绿的根因：漂移到旧 header ⇒ tool 还在 ⇒ 假红/假绿）。
  const throughSeq = o?.throughSeq ?? null
  const last = headers[headers.length - 1]
  const endpoint = throughSeq === null
    ? last
    : (headers.find((h) => h.seq === throughSeq) ?? null)
  const endpointLabel = throughSeq === null
    ? '最后一条 header'
    : `锚(seq=${throughSeq}) header`

  const checks = []

  // ── 通用：必须有证据，且证据本身是"能读的形状"
  checks.push(['至少读到一条 request/header', headers.length > 0])

  // P2-21 fail-closed：throughSeq 给了但找不到对应 header ⇒ 加一条红（且后续依赖 endpoint 的检查都自然红）
  if (throughSeq !== null) {
    checks.push([
      `终点锚(seq=${throughSeq}) 在 headers 内（找不到 ⇒ fail-closed，不许悄悄退化成"最后一条"）`,
      !!endpoint
    ])
  }

  // P1-11 ①：显式缺席判红（原来是靠 hasRead 间接捕获）
  const judged = endpoint ? judgeToolSurface(endpoint.data, { require }) : null
  const has = (h, t) => toolsOf(h).includes(t)
  checks.push([
    `${endpointLabel} 的 tools 键**存在**（缺席 ⇒ 判红；不再靠 "read 仍在" 间接捕获）`,
    !!judged && !judged.absent
  ])
  checks.push([`${endpointLabel} 的 tools 是数组（malformed ⇒ 判红）`, !!judged && !judged.malformed])
  checks.push([`清单没被整体搞空（read 仍在）`, has(endpoint, 'read')])

  // P1-11 ③：--require 只从参数进；不传 ⇒ 这里什么都不加（不许内置默认清单）
  if (require.length > 0) {
    checks.push([
      `点名的必需工具都在${endpointLabel}里（${require.join(', ')}）`,
      !!judged && judged.missing.length === 0
    ])
  }

  // ── 共同：切出 baseline 前后两段（两条分支、diff、污染判定都在这上面）
  // P2-21：throughSeq 给了 ⇒ "after" 只取到 throughSeq（含）为止 —— 否则 throughSeq 之后的旧 header
  //   会带 target 回来 ⇒ 假红（这正是 0037 C21 的形状：漂移到 seq=30 ⇒ pwsh 还在）。
  const before = baselineSeq !== null ? headers.filter((h) => h.seq !== null && h.seq <= baselineSeq) : []
  const after = baselineSeq !== null
    ? headers.filter((h) => h.seq !== null && h.seq > baselineSeq && (throughSeq === null || h.seq <= throughSeq))
    : []
  const base = before[before.length - 1]

  // ── P1-17 🔴 窗口污染：新增了 header，但**没有一条 reason:"change"**
  // 真数据依据（`843e3bee` 磁盘全量）：`seq=1374 reason="resume" n=31 pwsh=out` ——
  // **清单变化不只伴随 change，也伴随 resume**（重启 / 重新载入会话同样会产生一条 header）。
  // ⇒ 这时判**绿**是假绿（变的成因可能是重启），判**红**又把归因引到"restrict 没生效"上（错的）。
  // ⇒ 所以它不是断言，是**第三种结果**：`verdict='contaminated'`，退出码 **3**，重做活验。
  let contaminated = null
  if (baselineSeq !== null && after.length > 0 && !after.some((h) => h.reason === 'change')) {
    const kinds = [...new Set(after.map((h) => JSON.stringify(h.reason)))].join(' / ')
    contaminated =
      `新增的 ${after.length} 条 header 里没有一条 reason:"change"（全是 ${kinds}）⇒ ` +
      `清单确实变了，但成因可能是**重启/重载会话**，无从归因 ⇒ 判"窗口污染"，重做活验`
  }

  // ── P1-19 🔴 与**方向无关**的 baseline 判据：两个方向共用（原来只写在 `without` 里）
  // 实测缺陷（0030 §1）：`with 10`（baseline 落在 RPC 视窗外）⇒ **通过 7/7 / ALL-PASS / exit=0**，
  // 而同一 baseline 的 `without 10` ⇒ 4 条 FAIL / exit=1。**仪器自己打印了视窗截断警告然后照样给绿。**
  // ⇒ 第二批必然要验"dispose 后掩码放宽、pwsh 回来"那一跳，正是 `with` 方向 ⇒ 这半边裸奔 = 假绿。
  //
  // ⚠️ **反锁挡不住"视窗外 baseline"，只有视窗检查挡得住** —— 别把两条当成"顺带一起加的"：
  //   base === undefined 时，`with` 方向的反锁是 `!has(undefined, target)` = **true ⇒ 通过**。
  //   （`without` 方向恰好相反：`has(undefined,…)` = false ⇒ 顺带红了 ⇒ 才没暴露这个洞。）
  if (baselineSeq !== null) {
    checks.push([`确实新增了 header（seq>${baselineSeq}${throughSeq !== null ? ` 且 seq<=${throughSeq}` : ''}）`, after.length > 0])

    // P1-16：视窗 fail-closed —— **唯一**能挡住"baseline 根本没被读到"的那条
    const w = o?.window !== null && typeof o?.window === 'object' ? o.window : null
    const wKnown = !!w && w.firstSeq !== null && w.firstSeq !== undefined
    checks.push([
      // 0031 §1 建议：把**方向**也点名，否则读者要停顿一下才知道"谁天生就有"
      `baseline（seq=${baselineSeq}）在视窗内（首条 seq=${wKnown ? w.firstSeq : '未知'}；` +
        `视窗外 ⇒ "没读到" ≠ "天生${expect === 'without' ? '没有' : '就有'}"（方向：${expect}）⇒ 判红）`,
      wKnown && !(baselineSeq < w.firstSeq)
    ])

    // 0053 §2 改动 ②：反锁检查分叉两种情形
    //   ① base 不存在（整条 baseline header 缺席）⇒ 反锁无对象可反
    //   ② base 存在但缺 target ⇒ 反锁不成立
    //   原写法把两种塌进同一行，且文案读起来像"通过"，只看 grep FAIL 会读反。
    //   现在文案统一写成"判红"语义，布尔值保持原来的双向逻辑。
    const noBase = !base
    const wantBaseHas = expect === 'without'
    checks.push([
      noBase
        ? `🔴 baseline（seq<=${baselineSeq}）**一条 header 都没有** ⇒ 反锁无对象可反（判红，不是"通过"）`
        : `🔴 baseline 那条 header（seq<=${baselineSeq}）里**${wantBaseHas ? '没有' : '有'}** ${target}` +
          `（反锁要求"${wantBaseHas ? '有' : '没有'}" ⇒ 判红）`,
      noBase ? false : (wantBaseHas ? has(base, target) : !has(base, target))
    ])
  }

  if (expect === 'without') {
    checks.push([`${endpointLabel} 的 tools 里**没有** ${target}`, !has(endpoint, target)])
    if (baselineSeq !== null) {
      // P1-17：只在**没污染**时才把"必须有 change"当成断言；污染时它不该算红（红=错误归因）
      if (!contaminated) {
        checks.push([`新增的 header 里出现 reason:"change"（清单确实变过）`, after.some((h) => h.reason === 'change')])
      }
      checks.push([`新增的每条 header 都没有 ${target}`, after.every((h) => !has(h, target))])
    } else {
      // P1-11 ②：不传 baseline 时也不能"没给就没检查"
      checks.push([
        `未给 baseline ⇒ ${endpointLabel} 的 reason ∈ {${FRESH_REASONS.join(',')}}` +
          `（新开会话本就是建会话那条；出现 change/series ⇒ 中途变过，"天生如此"不成立）`,
        FRESH_REASONS.includes(endpoint?.reason)
      ])
    }
  } else {
    checks.push([`${endpointLabel} 的 tools 里**有** ${target}`, has(endpoint, target)])
    if (baselineSeq !== null) {
      // P1-17：同上，污染时不把"必须有 change"算成红（"新增"与视窗/反锁已在上面共用块里）
      if (!contaminated) {
        checks.push([`新增的 header 里出现 reason:"change"（工具确实回来了）`, after.some((h) => h.reason === 'change')])
      }
    } else {
      checks.push([
        `未给 baseline ⇒ ${endpointLabel} 的 reason ∈ {${FRESH_REASONS.join(',')}}`,
        FRESH_REASONS.includes(endpoint?.reason)
      ])
    }
  }

  // ── P1-18 逐名 diff（**永远算、永远打印**；断言只在 `--strict-diff` 时才加）
  // 依据：真数据里 IN→out 每次 `n` 正好差 1 ⇒ 消失的就是 `pwsh` 这一个。
  // ⇒ 但"只有它变"是**更强的主张**（另一个机制也可能恰好摘掉别的工具），
  //   不开 --strict-diff 时只作**信息**呈现，不许默默变成断言（不擅自发明判据）。
  // P2-21：diff 用 base → endpoint（不是 base → last）；throughSeq 给了 endpoint 可能 null ⇒ diffTools 自然返回 null
  const diff = diffTools(base, endpoint)
  if (strictDiff) {
    if (!diff) {
      checks.push(['--strict-diff 要求逐名 diff，但 baseline/endpoint 的 tools 拿不到数组型 ⇒ **判红**（fail-closed）', false])
    } else {
      const wantRemoved = expect === 'without' ? [target] : []
      const wantAdded = expect === 'with' ? [target] : []
      checks.push([
        `逐名 diff：baseline→${endpointLabel} **只有 ${target} 一个工具发生变动**` +
          `（期望 -[${wantRemoved.join(',')}] +[${wantAdded.join(',')}];` +
          `实测 -[${diff.removed.join(',')}] +[${diff.added.join(',')}])`,
        sameSet(diff.removed, wantRemoved) && sameSet(diff.added, wantAdded)
      ])
    }
  }

  const bad = checks.filter(([, ok]) => !ok).length
  const verdict = contaminated ? 'contaminated' : bad === 0 ? 'pass' : 'fail'
  return { checks, last, endpoint, judged, bad, hasRequireCheck: require.length > 0, contaminated, verdict, diff }
}

/**
 * P2-21：终点锚的**标签对象**（规矩 9：判据要可复算 ⇒ 终点不许漂移）。
 *
 * 现象（0037 C21 假绿根因）：原仪器终点锚在"最后一条 header"，该量会随任何后续请求翻转
 *   ⇒ 历史判据的绿**不可复算**（判据 2 当时 6/6 ALL-PASS，收盘后复跑 4/6 HAS-FAIL）。
 * 修法：两端都钉 —— `--baseline <seq>`（已有）+ `--through <seq>`（本批新加）。
 *
 * 该函数只**写标签**，不判红；判红由 buildChecks 里那条"终点锚在 headers 内"负责。
 * 标签的双向要求（_assert_restrict_live_test.mjs TO 组逐条断言）：
 *   - throughSeq === null ⇒ pinned=false，label 必须当场写清它是**时点性**的
 *     （别让人以为可复算 —— 它会随任何后续请求漂移）
 *   - throughSeq 给了 ⇒ pinned=true，seq=throughSeq，label 含该 seq
 *
 * @param {{headers:object[], throughSeq:number|null}} o
 * @returns {{pinned:boolean, seq?:number, label:string}}
 */
export function endpointOf({ headers, throughSeq } = {}) {
  if (throughSeq === null || throughSeq === undefined) {
    return {
      pinned: false,
      label: '时点性（终点 = 当前最后一条 header；任何后续请求都会让它漂移 ⇒ 该量不可复算）'
    }
  }
  return {
    pinned: true,
    seq: throughSeq,
    label: `钉在 seq=${throughSeq}（终点锚；不漂移 ⇒ 历史判据可复算）`
  }
}

/**
 * P2-18：**污染吞红** —— 污染时 `verdict='contaminated'`，exit=3，
 * 于是 `bad>0` 的红**不会走到 RESULT / 退出码上**，只留一句"重做活验"。
 * 实测（0031 §2）：`with 22578` ⇒ `通过 7/8`（1 条 FAIL）却只报 `WINDOW-CONTAMINATED`；
 * 而我在 0030 §1.4 把它记成"✅ exit=3"的干净回归 ⇒ **已经造成一次真实漏报**。
 *
 * ⇒ 修法：把红条数 + 红的名字**显式列出来**（污染**解释不了**这些红，重做之后要单独确认）。
 * 抽成函数是为了可测：呈现逻辑也必须进套件，不许只在 main 里加几行 print。
 *
 * @param {[string, boolean][]} checks
 * @param {number} bad
 * @returns {string[]} `bad===0` ⇒ 空数组（不打扰干净样本）
 */
export function contaminationNotice(checks, bad) {
  if (!(bad > 0)) return []
  const names = (checks ?? []).filter(([, ok]) => !ok).map(([nm]) => nm)
  const out = [`   ⚠️ **注意：污染的同时还有 ${bad} 条红** —— 重做活验后要单独确认（污染不解释它们）：`]
  for (const nm of names) out.push(`      · ${nm}`)
  return out
}

/**
 * RESULT 行。P2-18：污染且 `bad>0` 时把红条数**写进 RESULT 本身** ——
 * 针对 0031 §5 第 14 次那个动作（"只 grep `^FAIL|^通过|^RESULT`"）：
 * `通过 7/8` 里的那个 8 才是该看的差，光看 RESULT 会以为"重做就行"。
 *
 * @param {'pass'|'fail'|'contaminated'} verdict
 * @param {number} bad
 */
export function verdictLine(verdict, bad) {
  const base = verdict === 'pass' ? 'ALL-PASS' : verdict === 'fail' ? 'HAS-FAIL' : 'WINDOW-CONTAMINATED'
  const suffix = verdict === 'contaminated' && bad > 0 ? `（另含 ${bad} 条红，见上）` : ''
  return `RESULT: ${base}${suffix}`
}

/**
 * P2-20：从 `session/page` 的回包派生**视窗**。
 *
 * 为什么要抽出来：这段原来写在 `main()` 里 ⇒ 变异注入器改它时套件**全绿**（M23 实测 147/0），
 * 因为套件只覆盖 `buildChecks` / `extractHeaders`，**不覆盖 `main()` 的 RPC 胶水**。
 * 而它恰好是 P1-16 那条 fail-closed 判据的**唯一数据来源** ⇒ 数据源不可测 = 判据不可信。
 *
 * P1-16 实测依据（`843e3bee`）：磁盘 14 条 header，RPC 只给 12 条
 *（`hasMore=true`、首条 seq=4409，丢的是**最早**两条）
 * ⇒ 任何"条数 / 第 k 条 / 最早那条"在截断下都不可信，必须显式标出来。
 *
 * @returns {{recs: object[], firstSeq: number|null, lastSeq: number|null, hasMore: boolean, records: number}}
 */
export function windowOf(page) {
  const recs = page?.records ?? []
  const seqOf = (r) => r?.event?.seq ?? r?.seq ?? null
  return {
    recs,
    firstSeq: recs.length ? seqOf(recs[0]) : null,
    lastSeq: recs.length ? seqOf(recs[recs.length - 1]) : null,
    hasMore: page?.hasMore === true,
    records: recs.length
  }
}

/** 两个名字数组是否**作为集合**相同（顺序无关、去重后比） */
function sameSet(a, b) {
  const s = (x) => [...new Set(x ?? [])].sort()
  const A = s(a)
  const B = s(b)
  return A.length === B.length && A.every((x, i) => x === B[i])
}

/**
 * baseline → 最后一条 的**逐名**工具变动。
 * @returns {{removed: string[], added: string[], nFrom: number, nTo: number}|null}
 *   `null` = 算不了（没 baseline、没最后一条、或任一侧 `tools` 不是数组 ⇒ 不许拿 [] 冒充"没变动"）
 */
export function diffTools(base, last) {
  if (!base || !last) return null
  const A = resolveTools(base?.data)
  const B = resolveTools(last?.data)
  // 🔴 不许把"缺席/非数组"压成 [] —— 那会算出"什么都没变"的假象（与 M7 同一个坑）
  if (!Array.isArray(A) || !Array.isArray(B)) return null
  const a = A.map((t) => (typeof t === 'string' ? t : String(t?.name ?? t?.function?.name ?? '?')))
  const b = B.map((t) => (typeof t === 'string' ? t : String(t?.name ?? t?.function?.name ?? '?')))
  return { removed: a.filter((x) => !b.includes(x)), added: b.filter((x) => !a.includes(x)), nFrom: a.length, nTo: b.length }
}

// ─────────────────────────────────────────────────────────────────
// P2-22 --offline：直读 $DSH_HOME/sessions/<projectKey>/<sessionId>/session.jsonl.zstd
// 不走 RPC ⇒ DSH 停机也能核（与"判据可复算"配套；RPC 路径会因 ECONNREFUSED 完全不可用）
// ─────────────────────────────────────────────────────────────────

/** 多帧 zstd 的魔数（实测 transcript 一个文件里有 30+ 帧；单帧解只给第一段） */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 多帧 zstd 直读 session.jsonl.zstd。
 *
 * ⚠️ transcript 是「多帧 zstd」（实测 `843e3bee` 一个文件里有 30+ 帧）：
 *   - 单帧解压只能得到第一段（流式还会报 `Unknown frame descriptor`）
 *   - 必须按魔数 `28 B5 2F FD` 切帧、逐帧解（参考 `_cc_transcript_dump.mjs`）
 *
 * 垃圾帧（魔数开头但不是真 zstd）必须**跳过且不崩**，跳过的帧数如实计数（`dropped`）。
 * 这是为了让判红仪器在「文件部分损坏」时仍能给出已读到的部分，而不是整份红掉 ——
 * 后续 buildChecks 会因为 records 缺关键 seq 自然判红（fail-closed）。
 *
 * @param {string} file session.jsonl.zstd 的绝对路径
 * @returns {{frames:number, records:object[], dropped:number}}
 *   - frames = 实际成功解出的帧数（不含跳过的）
 *   - records = 解出来的事件记录（每行 JSON.parse；行损坏也跳过）
 *   - dropped = 解失败被跳过的帧数
 */
export function readTranscriptFile(file) {
  const buf = readFileSync(file)
  const offsets = []
  let i = 0
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    offsets.push(i)
    i++
  }
  const records = []
  let frames = 0
  let dropped = 0
  for (const off of offsets) {
    try {
      const part = zstdDecompressSync(buf.subarray(off))
      frames++
      for (const line of part.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          records.push(JSON.parse(line))
        } catch {
          // 行损坏 ⇒ 跳过（不抛；后续 buildChecks 会因为缺关键 seq 自然判红）
        }
      }
    } catch {
      dropped++
    }
  }
  return { frames, records, dropped }
}

/**
 * 扫 $DSH_HOME/sessions/<projectKey>/<sessionId>/ 下的所有匹配目录。
 *
 * 实测 DSH 一个进程可能有多个 projectKey（实测 2 个：`--C-Users-DELL--` 与 `--E-DSH-workspace--`）。
 * ⇒ 只写死一个根 ⇒ 另一根下的会话永远"找不到"。
 *
 * @param {string} home $DSH_HOME（或本地等价路径）
 * @param {string} sid 会话 ID
 * @returns {string[]} 找到的所有目录（绝对路径）；home/sessions 缺席 ⇒ []
 */
export function findSessionDirs(home, sid) {
  if (!home || !sid) return []
  const sessionsRoot = join(home, 'sessions')
  if (!existsSync(sessionsRoot)) return []
  let projectKeys = []
  try {
    projectKeys = readdirSync(sessionsRoot).filter((d) => {
      try {
        return statSync(join(sessionsRoot, d)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
  const out = []
  for (const pk of projectKeys) {
    const d = join(sessionsRoot, pk, sid)
    try {
      if (statSync(d).isDirectory()) out.push(d)
    } catch {
      // 不存在 ⇒ skip
    }
  }
  return out
}

/**
 * 把离线读出的 records 包成 `session/page` 回包的形状 —— 让 `windowOf` 能直接用。
 *
 * 关键差异：离线读的是**全量** ⇒ `hasMore=false`（与 RPC 的分页视窗不同 ——
 * 这正是离线的价值：不用再担心"baseline 落在 RPC 视窗外" ⇒ P1-16 那条 fail-closed
 * 在离线下恒绿，因为 firstSeq 就是磁盘首条）。
 *
 * 排序：按 seq 升序（保险起见，windowOf 取 recs[0] 作 firstSeq）。
 *
 * @param {object[]} records
 * @returns {{records:object[], hasMore:false}}
 */
export function pageFromOffline(records) {
  const sorted = [...(records ?? [])].sort((a, b) => {
    const sa = a?.event?.seq ?? a?.seq ?? Number.POSITIVE_INFINITY
    const sb = b?.event?.seq ?? b?.seq ?? Number.POSITIVE_INFINITY
    return sa - sb
  })
  return { records: sorted, hasMore: false }
}

/** 命令行解析：位置参数 + `--require=` + `--through=`（位置参数要先把 `--` 开头的剔掉，否则会被当成 expect） */
export function parseArgs(argv) {
  const all = argv ?? []
  const require = parseRequire(all)
  // P2-21：--through=<seq>；不传 ⇒ null（不是 0 —— 0 会被当成"钉在 seq=0" ⇒ 假红）
  const throughArg = all.find((a) => typeof a === 'string' && a.startsWith('--through='))
  let throughSeq = null
  if (throughArg) {
    const v = throughArg.slice('--through='.length)
    if (/^\d+$/.test(v)) throughSeq = Number(v)
  }
  const pos = all.filter((a) => typeof a === 'string' && !a.startsWith('--'))
  const baseline = /^\d+$/.test(pos[2] ?? '') ? Number(pos[2]) : null
  // 注意用 `||` 不是 `??`：命令行里第 4 位可能是空串，`??` 会把空串当有效值收下
  return {
    sid: pos[0],
    expect: pos[1],
    baselineSeq: baseline,
    target: pos[3] || 'pwsh',
    require,
    throughSeq,
    strictDiff: all.some((a) => a === '--strict-diff'),
    offline: all.some((a) => a === '--offline')
  }
}

// ---------------------------------------------------------------- CLI
async function main() {
  const { sid, expect, baselineSeq, target, require, strictDiff, throughSeq, offline } = parseArgs(process.argv.slice(2))
  if (!sid || (expect !== 'with' && expect !== 'without')) {
    console.error(
      '用法: node _assert_restrict_live.mjs <sessionId> <with|without> [baselineSeq] [toolName] [--require=a,b,c] [--through=<seq>] [--offline] [--strict-diff]'
    )
    process.exit(2)
  }

  // P2-22 --offline：直读磁盘，跳过 RPC（DSH 停机也能核）
  let page, asOfSeq
  if (offline) {
    const home = process.env.DSH_HOME ?? 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home'
    const dirs = findSessionDirs(home, sid)
    if (dirs.length === 0) {
      console.error(`离线模式：在 ${home}/sessions/*/${sid}/ 下找不到会话目录`)
      process.exit(2)
    }
    const file = join(dirs[0], 'session.jsonl.zstd')
    if (!existsSync(file)) {
      console.error(`离线模式：${file} 不存在`)
      process.exit(2)
    }
    const { frames, records, dropped } = readTranscriptFile(file)
    page = pageFromOffline(records)
    asOfSeq = '—(offline) frames=' + frames + (dropped ? ' dropped=' + dropped : '')
  } else {
    const list = await rpc('session/list', { _request: {} })
    const it = (list?.items ?? []).find((x) => (x.sessionId ?? x.id) === sid)
    if (!it) {
      console.error(`找不到会话 ${sid}`)
      process.exit(2)
    }
    page = await rpc('session/page', {
      request: { address: { kind: 'session', sessionId: sid }, throughSeq: it?.projections?.asOfSeq ?? 0 }
    })
    asOfSeq = it?.projections?.asOfSeq ?? '—'
  }
  // P2-20：视窗派生抽成可导出函数（原来这段在 `main()` 里 ⇒ 变异测不到，见 M23）
  const { recs, firstSeq, lastSeq, hasMore } = windowOf(page)
  const headers = extractHeaders(recs)
  const window = { firstSeq, hasMore, records: recs.length }

  const L = []
  L.push(`session = ${sid}`)
  L.push(
    `分页视窗 = records=${recs.length} 首条 seq=${firstSeq ?? '—'} 末条 seq=${lastSeq ?? '—'} hasMore=${hasMore}` +
      `（asOfSeq=${asOfSeq}）`
  )
  if (hasMore) {
    L.push('⚠️ 视窗**截断**：本页只覆盖最近这些记录 ⇒ "header 条数 / 最早那条 / baseline 反锁"都不可信；')
    L.push('   只有"最后一条"仍然有效（末条 seq = asOfSeq ⇒ 视窗一定含最新）。')
  }
  L.push(`期望 = ${expect === 'with' ? `tools 里**有** ${target}` : `tools 里**没有** ${target}`}`)
  L.push(`baselineSeq = ${baselineSeq ?? '（未给）'}`)
  L.push(`--require = ${require.length ? require.join(', ') : '（未给 ⇒ 不加该检查）'}`)
  L.push(`--through = ${throughSeq === null ? '（未给 ⇒ 终点 = 当前最后一条；时点性，会漂移）' : throughSeq + '（终点钉在 seq=' + throughSeq + '；可复算）'}`)
  L.push(`--offline = ${offline ? '开（直读磁盘，不走 RPC）' : '关（走 RPC session/page）'}`)
  L.push(`--strict-diff = ${strictDiff ? '开（逐名 diff 也当断言）' : '关（diff 只作信息，不成断言）'}`)
  L.push(`request/header 条数 = ${headers.length}${hasMore ? '（视窗截断 ⇒ 该条数不可信）' : ''}`)
  for (const h of headers) {
    const j = judgeToolSurface(h.data)
    L.push(
      `  seq=${h.seq} reason=${JSON.stringify(h.reason)} n=${j.n} absent=${j.absent} ` +
        `${target}=${toolsOf(h).includes(target) ? 'IN' : 'out'} read=${toolsOf(h).includes('read') ? 'IN' : 'out'}`
    )
  }
  L.push('--- 断言 ---')

  const { checks, bad, contaminated, verdict, diff } = buildChecks({
    headers,
    expect,
    target,
    baselineSeq,
    require,
    strictDiff,
    throughSeq,
    window
  })
  for (const [name, ok] of checks) L.push(`${ok ? 'OK  ' : 'FAIL'} ${name}`)
  L.push(`通过 ${checks.length - bad}/${checks.length}`)

  // P1-18：逐名 diff **永远打印**（即使没开 --strict-diff），人眼要能看见"还有谁也变了"
  if (diff) {
    L.push(
      `逐名 diff（baseline seq<=${baselineSeq} → ${throughSeq === null ? '最后一条' : `钉在 seq=${throughSeq}`}）：n ${diff.nFrom} → ${diff.nTo}；` +
        `移除 [${diff.removed.join(', ')}]；新增 [${diff.added.join(', ')}]`
    )
  } else if (baselineSeq !== null) {
    L.push('逐名 diff：算不了（baseline / 最后一条 的 tools 不是数组，或缺 baseline）⇒ 不呈现、也不许当"没变动"')
  }

  if (contaminated) {
    L.push('')
    L.push(`🔴 WINDOW-CONTAMINATED（既不是红也不是绿）：${contaminated}`)
    L.push('   ⇒ 重做活验：重启/重载必须落在**取 baseline 之前**，或重启后重新取一次 baseline。')
    // P2-18：别让 bad>0 消失在"重做活验"里
    for (const line of contaminationNotice(checks, bad)) L.push(line)
  }
  L.push(verdictLine(verdict, bad))

  writeFileSync('_assert_restrict_live_out.txt', L.join('\n') + '\n', 'utf8')
  console.log(L.join('\n'))
  process.exitCode = verdict === 'pass' ? 0 : verdict === 'fail' ? 1 : 3
}

if (isEntryModule()) main()
