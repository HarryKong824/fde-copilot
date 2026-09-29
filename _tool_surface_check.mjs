/**
 * 工具面观测：判红仪器（P1-10）
 *
 * 背景（为什么单开一个文件，而不是改 `_cc_transcript_dump.mjs`）：
 *   现有 8 个 header 观测脚本**没有一个是判红仪器** —— 它们都是"给人看的"，
 *   零工具 / 字段缺席时或打一行 `header keys=[…]`、或直接 `continue` 跳过。
 *   `_cc_transcript_dump.mjs` 是通用查看器，把判红逻辑塞进去会让它同时有
 *   "给人看"和"给门禁判"两种用途 —— 正是我们连防两轮的混用。故单开本文件。
 *
 * 用法：
 *   node _tool_surface_check.mjs                 → 只跑自检（合成样本），退出码敏感
 *   node _tool_surface_check.mjs <会话前缀>       → 自检 + 读该会话最后一条 request/header 判红
 *   node _tool_surface_check.mjs <前缀> --require=read,pwsh,fde_phase_advance
 *                                                → 额外判"必需工具在不在"（n>0 不等于够用）
 *
 * 退出码：0 = 绿（有证据表明工具面非 0）；1 = 红（零工具 / 字段缺席 / 未找到 / 检查器自身失效）
 *
 * 三条硬约束（0026 §4.3，我加了第 ④⑤⑥ 条）：
 *   ① "字段缺席"判红（= 0 个工具），绝不判成"未知 ⇒ 跳过 / OK"
 *   ② 不靠崩溃当判据：显式 `?? ABSENT` 后判等，不许让 `tools.length` 抛 TypeError
 *   ③ 自带可证伪样本：本文件内置的 S2..S7 若被判绿 ⇒ 脚本自己 exit 1
 *   ④ 缺席与"真的 0"都红，但**文案必须能区分**（诊断价值：缺席 = canonicalHeader 整个省略字段）
 *   ⑤ 取"最后一条 request/header"时**不许停在第一个有工具的**（`_cc_tool_list.mjs:25/28` 的坑：
 *      `continue` + `break` 会让零工具的那条**根本不出现** ⇒ "最后一条"恒是有工具的 ⇒ 假绿）
 *   ⑥ 一条 request/header 都没找到 ⇒ **判红**，且文案说"未找到，无法判定"（不是"= 0"）。
 *      绿必须建立在证据上 —— "没验过"不等于"验过了通过"。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

/**
 * 只在"被直接运行"时才跑 main()。
 *
 * ⚠️ 这个守卫不是样板代码：本文件被 `_tool_surface_test.mjs` import 来断言判定函数。
 * 若无条件调 main()，import 的瞬间就会 `process.exit(0)` ⇒ **测试进程在跑任何断言之前
 * 就以 0 退出** ⇒ 套件变绿但一条都没验。那正是本文件整个存在意义所要防的形状
 * （"检查器对自己坏样本也说 OK"），只是换了个发生位置。
 */
export function isEntryModule() {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return import.meta.url === pathToFileURL(argv1).href
  } catch {
    return false
  }
}

/**
 * 会话根 —— **必须是全部根，不能只写一个**（P2-14）。
 *
 * 教训：ROOT 原本写死到 `--E-DSH-workspace--`，而我在回执里下的是"63 个会话"的结论
 * （62 + C 根 1）⇒ **统计范围小于我声称的范围**（"断言域 ≠ 验证域"那一族）。
 * 而且它是**仪器设计**造成的，不是某次手滑 ⇒ 不修就会**每次复发**。
 * ⇒ 现在：根写成列表、main() 里**打印**扫了哪几个根、且下面自带一条自断言（根数 ≥ 2）。
 */
export const SESSION_ROOTS = [
  'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--',
  'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--C-Users-DELL--'
]
/** 根的可读标签（打印用） */
export const sessionRootLabel = (root) => root.split('/').pop()
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 缺席哨兵：与 `[]` 严格区分（约束 ④） */
export const ABSENT = Symbol('tools-absent')

/**
 * 解析一条 request/header 事件里的 tools 数组。
 * @param {unknown} data - 事件的 `data` 字段
 * @returns {unknown[]|typeof ABSENT}
 */
export function resolveTools(data) {
  if (data === null || typeof data !== 'object') return ABSENT
  const header = data.header
  const raw =
    header !== null && typeof header === 'object' && 'tools' in header
      ? header.tools
      : 'tools' in data
        ? data.tools
        : undefined
  return raw === undefined || raw === null ? ABSENT : raw
}

/**
 * 判定工具面 —— 唯一的判红入口。
 * @param {unknown} data - request/header 事件的 data
 * @returns {{n:number, absent:boolean, malformed:boolean, verdict:'ok'|'red', why:string, names:string[]}}
 */
export function judgeToolSurface(data, opts) {
  const require = Array.isArray(opts?.require) ? opts.require : []
  const raw = resolveTools(data)
  const names = (t) => {
    if (t === null || t === undefined) return '?'
    if (typeof t === 'string') return t
    return String(t?.name ?? t?.function?.name ?? JSON.stringify(t).slice(0, 40))
  }

  if (raw === ABSENT) {
    return {
      n: 0,
      absent: true,
      malformed: false,
      verdict: 'red',
      why:
        'header 里没有 tools 键。按 canonicalHeader（`dsh-session/lib/index.js:386`）零工具时' +
        '整个字段被省略 ⇒ **字段缺席即零工具**，绝不可判成"未知 ⇒ 跳过"。',
      names: [],
      missing: require.slice()
    }
  }
  if (!Array.isArray(raw)) {
    return {
      n: 0,
      absent: false,
      malformed: true,
      verdict: 'red',
      why: `tools 字段存在但不是数组（typeof=${typeof raw}）⇒ 无法判定工具面 ⇒ fail-closed 判红。`,
      names: [],
      missing: require.slice()
    }
  }
  const list = raw.map(names)
  if (raw.length === 0) {
    return {
      n: 0,
      absent: false,
      malformed: false,
      verdict: 'red',
      why: 'tools 是空数组（字段在、长度为 0）⇒ 零工具。与"字段缺席"都红，但成因不同。',
      names: [],
      missing: require.slice()
    }
  }
  const missing = require.filter((name) => !list.includes(name))
  if (missing.length > 0) {
    return {
      n: raw.length,
      absent: false,
      malformed: false,
      verdict: 'red',
      why: `工具面非 0（n=${raw.length}），但必需工具缺失：${missing.join(', ')}。`,
      names: list,
      missing
    }
  }
  return {
    n: raw.length,
    absent: false,
    malformed: false,
    verdict: 'ok',
    why: '工具面非 0。',
    names: list,
    missing: []
  }
}

/**
 * 取**最后一条** request/header（约束 ⑤：不许停在第一个有工具的）。
 * @param {unknown[]} events
 * @returns {{found:boolean, data:unknown, seq:unknown, reason:unknown}}
 */
export function pickLastHeader(events) {
  let last = null
  for (const e of events) {
    const ev = e?.event ?? e
    const t = ev?.type ?? ''
    if (t !== 'request/header') continue
    last = { found: true, data: ev?.data ?? {}, seq: ev?.seq ?? e?.seq, reason: ev?.data?.reason ?? e?.data?.reason }
  }
  return last ?? { found: false, data: null, seq: undefined, reason: undefined }
}

// ── 合成样本：自带可证伪（约束 ③） ──────────────────────────────────────────
// verdict 是**预期**；judge 若退化成"永远 ok"，S2..S7 会立刻失配 ⇒ 脚本自己 exit 1。
export const SAMPLES = [
  {
    id: 'S1',
    desc: '有工具（正常）',
    data: { header: { tools: [{ name: 'read' }, { name: 'pwsh' }] } },
    expect: { verdict: 'ok', n: 2, absent: false }
  },
  {
    id: 'S2',
    desc: 'tools = []（字段在、长度 0）',
    data: { header: { tools: [] } },
    expect: { verdict: 'red', n: 0, absent: false }
  },
  {
    id: 'S3',
    desc: 'header 存在但无 tools 键（canonicalHeader 的零工具形状）',
    data: { header: { config: { model: 'x' } } },
    expect: { verdict: 'red', n: 0, absent: true }
  },
  {
    id: 'S4',
    desc: 'data 为空对象',
    data: {},
    expect: { verdict: 'red', n: 0, absent: true }
  },
  {
    id: 'S5',
    desc: 'header 为 null（不得靠 TypeError 崩，约束 ②）',
    data: { header: null },
    expect: { verdict: 'red', n: 0, absent: true }
  },
  {
    id: 'S6',
    desc: 'tools 不是数组（不崩、判红）',
    data: { header: { tools: 'oops' } },
    expect: { verdict: 'red', n: 0, absent: false }
  },
  {
    id: 'S7',
    desc: 'data 根本不是对象',
    data: 'not-an-object',
    expect: { verdict: 'red', n: 0, absent: true }
  }
]

/** 取最后一条的样本（约束 ⑤）：零工具那条在**后面**，必须被选到 */
export const PICK_SAMPLES = [
  {
    id: 'P1',
    desc: '[有工具, 无工具] ⇒ 必须取到最后一条（无工具）⇒ 红',
    events: [
      { type: 'request/header', data: { header: { tools: [{ name: 'read' }] } }, seq: 1 },
      { type: 'request/header', data: { header: { config: {} } }, seq: 2 }
    ],
    expect: { found: true, verdict: 'red', absent: true }
  },
  {
    id: 'P2',
    desc: '[无工具, 有工具] ⇒ 取到最后一条（有工具）⇒ 绿（防"取第一条"的反向 bug）',
    events: [
      { type: 'request/header', data: { header: { config: {} } }, seq: 1 },
      { type: 'request/header', data: { header: { tools: [{ name: 'pwsh' }] } }, seq: 2 }
    ],
    expect: { found: true, verdict: 'ok', absent: false, n: 1 }
  },
  {
    id: 'P3',
    desc: '一条都没有 ⇒ found=false（未找到，不是"= 0"）',
    events: [{ type: 'user/message', data: { content: 'hi' } }],
    expect: { found: false }
  },
  {
    id: 'P4',
    desc: '嵌套形状 {event:{type,data}} 也要能取到',
    events: [{ event: { type: 'request/header', data: { header: { tools: [{ name: 'read' }] } } } }],
    expect: { found: true, verdict: 'ok', n: 1 }
  }
]

/** 「够不够」样本（opt-in --require）：n>0 但必需工具缺失 ⇒ 红 */
export const REQUIRE_SAMPLES = [
  {
    id: 'R1',
    desc: 'n=1 但缺 read/pwsh ⇒ 红（实测出现过"整个工具面只剩 run_code"的会话）',
    data: { header: { tools: [{ name: 'run_code' }] } },
    require: ['read', 'pwsh'],
    expect: { verdict: 'red', n: 1, missing: ['read', 'pwsh'] }
  },
  {
    id: 'R2',
    desc: '点名的都在 ⇒ 绿',
    data: { header: { tools: [{ name: 'read' }, { name: 'pwsh' }, { name: 'fde_phase_advance' }] } },
    require: ['read', 'pwsh'],
    expect: { verdict: 'ok', n: 3, missing: [] }
  },
  {
    id: 'R3',
    desc: '不传 require ⇒ 只看"有没有"，n=1 也绿（不擅自设阈值）',
    data: { header: { tools: [{ name: 'run_code' }] } },
    require: [],
    expect: { verdict: 'ok', n: 1, missing: [] }
  },
  {
    id: 'R4',
    desc: '零工具 + require ⇒ missing 列出全部必需项（不为空数组）',
    data: { header: {} },
    require: ['read'],
    expect: { verdict: 'red', n: 0, missing: ['read'] }
  }
]

function readSessionEvents(prefix) {
  // P2-14：在所有根里找（原来只找 E 根 ⇒ C 根那条会话"从来没进过统计"）
  let dir = null
  let root = null
  for (const r of SESSION_ROOTS) {
    const hit = readdirSync(r).find((d) => d.includes(prefix))
    if (hit) {
      dir = hit
      root = r
      break
    }
  }
  if (!dir) throw new Error(`找不到会话 ${prefix}*（已扫 ${SESSION_ROOTS.length} 个根：${SESSION_ROOTS.map(sessionRootLabel).join(', ')}）`)
  const buf = readFileSync(`${root}/${dir}/session.jsonl.zstd`)
  const offs = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offs.push(i)
    i++
  }
  const parts = []
  for (const off of offs) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(off)))
    } catch {}
  }
  const events = []
  for (const l of Buffer.concat(parts).toString('utf8').split(/\r?\n/)) {
    if (!l.trim()) continue
    try {
      events.push(JSON.parse(l))
    } catch {}
  }
  return { dir, root, rootLabel: sessionRootLabel(root), frames: offs.length, events }
}

/**
 * 自断言：本文件的扫描范围**至少覆盖两个根**（P2-14）。
 * 只写一个根是"统计范围 < 声称范围"的复发源；仪器自己报出它的范围，比读的人记得可靠。
 */
export function assertRootScope() {
  const ok = Array.isArray(SESSION_ROOTS) && SESSION_ROOTS.length >= 2
  return {
    ok,
    roots: SESSION_ROOTS.map(sessionRootLabel),
    why: ok ? '' : `SESSION_ROOTS 只有 ${SESSION_ROOTS?.length ?? 0} 个根 ⇒ 扫描范围小于声称范围。`
  }
}

/**
 * 解析 `--require=a,b,c`。
 *
 * 为什么要有它：**"n > 0"不等于"工具面够用"**。实测到过 `n=1`（整个工具面只剩 `run_code`）
 * 的会话 —— 按"有没有"判它是绿的，但它与 0018 那个零工具现场只差一步。
 * 判"够不够"必须**显式点名**，不能靠猜一个阈值（多少算够？没有依据），
 * 所以它是 opt-in：不传就只看"有没有"。
 */
export function parseRequire(argv) {
  const hit = (argv ?? []).find((a) => typeof a === 'string' && a.startsWith('--require='))
  if (!hit) return []
  return hit
    .slice('--require='.length)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function main() {
  const prefix = process.argv[2]
  const requireList = parseRequire(process.argv.slice(3))
  let selfFail = 0

  // P2-14：先报出自己的扫描范围，再干活（读的人不必记得它有范围）
  const scope = assertRootScope()
  console.log(`=== 扫描范围（${scope.roots.length} 个根）：${scope.roots.join(' , ')} ===`)
  if (!scope.ok) {
    console.log(`🔴 ${scope.why}`)
    process.exitCode = 1
    return
  }

  console.log('=== 自检（合成样本：证明本检查器对坏样本会红）===')
  for (const s of SAMPLES) {
    const got = judgeToolSurface(s.data)
    const ok =
      got.verdict === s.expect.verdict && got.n === s.expect.n && got.absent === s.expect.absent
    if (!ok) selfFail++
    console.log(
      `  ${ok ? '✅' : '🔴'} ${s.id} ${s.desc} → 期望 ${s.expect.verdict}/n=${s.expect.n}/absent=${s.expect.absent}，` +
        `实得 ${got.verdict}/n=${got.n}/absent=${got.absent}`
    )
  }
  for (const p of PICK_SAMPLES) {
    const picked = pickLastHeader(p.events)
    const j = picked.found ? judgeToolSurface(picked.data) : { verdict: 'n/a', n: 0, absent: false }
    const ok =
      picked.found === p.expect.found &&
      (p.expect.verdict === undefined || j.verdict === p.expect.verdict) &&
      (p.expect.absent === undefined || j.absent === p.expect.absent) &&
      (p.expect.n === undefined || j.n === p.expect.n)
    if (!ok) selfFail++
    console.log(
      `  ${ok ? '✅' : '🔴'} ${p.id} ${p.desc} → found=${picked.found} verdict=${j.verdict} n=${j.n} absent=${j.absent}`
    )
  }
  for (const r of REQUIRE_SAMPLES) {
    const got = judgeToolSurface(r.data, { require: r.require })
    const ok =
      got.verdict === r.expect.verdict &&
      got.n === r.expect.n &&
      JSON.stringify(got.missing) === JSON.stringify(r.expect.missing)
    if (!ok) selfFail++
    console.log(
      `  ${ok ? '✅' : '🔴'} ${r.id} ${r.desc} → 期望 ${r.expect.verdict}/n=${r.expect.n}/missing=${JSON.stringify(r.expect.missing)}，` +
        `实得 ${got.verdict}/n=${got.n}/missing=${JSON.stringify(got.missing)}`
    )
  }
  console.log(selfFail === 0 ? '  自检通过（本检查器可证伪）' : `  🔴 自检失败 ${selfFail} 条`)

  if (selfFail > 0) {
    console.log('\n🔴 TOOL-SURFACE 检查器自身失效 —— 它的输出不再是可信证据，必须修它，不能绕过。')
    process.exitCode = 1
    return
  }

  if (!prefix) {
    console.log('\n（未给会话前缀 ⇒ 只跑自检）用法：node _tool_surface_check.mjs <会话前缀>')
    console.log('TOOL-SURFACE SELF-CHECK OK')
    process.exitCode = 0
    return
  }

  const { dir, rootLabel, frames, events } = readSessionEvents(prefix)
  console.log(`\n=== 活体：会话 ${dir}（根 ${rootLabel} / 帧 ${frames} / 事件 ${events.length}）===`)
  const picked = pickLastHeader(events)
  if (!picked.found) {
    console.log('🔴 未找到任何 request/header ⇒ **无证据**，判红（不是"= 0"）。')
    console.log('   绿必须建立在证据上；"没验过"不等于"验过了通过"。')
    console.log('TOOL-SURFACE RED')
    process.exitCode = 1
    return
  }
  const j = judgeToolSurface(picked.data, { require: requireList })
  console.log(`最后一条 request/header：seq=${picked.seq} reason=${picked.reason}`)
  console.log(`工具数 = ${j.n}   absent=${j.absent}   malformed=${j.malformed}`)
  if (j.n > 0) console.log(`名单：${j.names.sort().join(', ')}`)
  if (j.verdict === 'ok') {
    console.log('TOOL-SURFACE OK')
    process.exitCode = 0
    return
  }
  console.log(`🔴 ${j.why}`)
  console.log('TOOL-SURFACE RED')
  process.exitCode = 1
    return
}

if (isEntryModule()) main()
