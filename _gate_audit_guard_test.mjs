/**
 * gate 侧「审计目录进保护根」+「越界写要留痕」回归（0022 施工单 P0-1 / P0-2）。
 *
 * 背景：
 *  - 缺陷 B（0020 §7.1 / 0022 §2）：`fde_ontology_write` 的 `resolveWithinOntology()` 在
 *    **audit.record 之前**裸调用 ⇒ 越界被拒时抛错中断 ⇒ **整条调用零留痕**。
 *    读侧（tools.js:109-128 的 `probe` 范式）早已修好，写侧没跟上。
 *  - 缺陷 A①（0019 §4 / 0022 §1）：gate 的受保护根只有 `cfg.ontologyRoot` 一个，
 *    审计目录（`auditPath` 的 dirname）在它**之外** ⇒ 模型提权后可直接改写审计链。
 *
 * 本套件守三件事：
 *  ① 越界/非法 path ⇒ **原错误文案一字不改**地抛，且链上多一条 write-probe；
 *  ② 审计目录进保护根后，shell 直写审计链被拒，而 ontologyRoot 行为**零变化**；
 *  ③ 🔴 `auditPath` 为空串时**不得**把 `.`（cwd）当成保护根 —— `dirname('') === '.'`，
 *     不判空会让"只驻内存"的部署形态变成**所有写都被拒**的死门禁（同 0018 那个形状）。
 *
 * 跑法：node _gate_audit_guard_test.mjs
 * 结果另写 `_gate_audit_guard_out.txt`（规避控制台代码页乱码）。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import * as toolsMod from './dsh-fde-ontology-gate/lib/tools.js'
import { AuditChain } from './dsh-fde-ontology-gate/lib/audit.js'
import { evaluate } from './dsh-fde-ontology-gate/lib/guard.js'
// ⚠️ 同上：新增导出用命名空间取，改前拿到 undefined ⇒ 用例正常判红，而不是整个模块加载失败。
import * as guardMod from './dsh-fde-ontology-gate/lib/guard.js'
import * as pathsMod from './dsh-fde-ontology-gate/lib/paths.js'

// 受保护集的唯一定义处在 paths.js（guard 判定 + index 启动打印共用同一函数）
const protectedRootsOf = pathsMod.protectedRootsOf
const formatProtectedRootsLine = pathsMod.formatProtectedRootsLine
const assertProtectedExtraRoots = pathsMod.assertProtectedExtraRoots

const { installOntologyTools, ONTOLOGY_READ, ONTOLOGY_WRITE, READ_PROBE } = toolsMod
// ⚠️ 具名 import 一个**尚不存在**的导出会让整个模块加载失败 ⇒ 红灯变成"崩溃"而非"断言失败"。
//    这里取模块命名空间，改前拿到 undefined ⇒ 用例正常判红（这才是可证伪的红）。
const WRITE_PROBE = toolsMod.WRITE_PROBE
const AUDIT_PROTECTED_REASON = /受保护/

const lines = []
let passed = 0
let failed = 0

function check(name, ok, extra = '') {
  lines.push(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !extra ? '' : `\n      ${extra}`}`)
  ok ? passed++ : failed++
}

// ── 布局：ontology / 审计目录 / 普通工作区，三者互不包含 ────────────────────────
const base = mkdtempSync(join(tmpdir(), 'fde-auditguard-'))
const root = join(base, 'ontology')
const auditDir = join(base, 'fde-audit')
const auditPath = join(auditDir, 'gate.jsonl')
const plainDir = join(base, 'plain')
mkdirSync(root, { recursive: true })
mkdirSync(auditDir, { recursive: true })
mkdirSync(plainDir, { recursive: true })
writeFileSync(join(root, 'ok.yaml'), 'a: 1\n', 'utf8')

/** 与活体同构的最小 cfg（离线不引 schemastery，详见 _gate_readprobe_test.mjs 的说明）。 */
const cfgOf = (over = {}) => ({
  ontologyRoot: root,
  mode: 'enforce',
  denyRunCode: true,
  workspaceRoot: base,
  auditPath,
  allowedWriteSources: ['user', 'model'],
  minConfidence: 70,
  ...over
})

const cfg = cfgOf()
const audit = new AuditChain(auditPath)

const captured = {}
installOntologyTools({ tools: { register: (d) => { captured[d.name] = d; return () => {} } } }, cfg, audit)

async function writeIt(path, content = 'x: 1\n') {
  try {
    const out = await captured[ONTOLOGY_WRITE].execute(
      { path, content, source: 'user', reason: '回归：越界写留痕' },
      { callId: 'w-1' }
    )
    return { threw: false, out }
  } catch (e) {
    return { threw: true, err: e }
  }
}

/**
 * ⚠️ 链文件**可能根本不存在** —— 那正是缺陷 B 的症状（越界写零留痕 ⇒ 从未落盘）。
 * 所以这里必须容错返回空数组，让"没留痕"表现为**一条红掉的断言**，
 * 而不是让脚本崩在 readFileSync（崩了就看不出是哪条用例红）。
 */
function readAudit() {
  if (!existsSync(auditPath)) return []
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
}

// ══════════ A 组：缺陷 B —— 越界写必须留痕（P0-1） ══════════
lines.push('A 组：越界写留痕（缺陷 B / P0-1）')

const outside = await writeIt('../outside.yaml')
check('越界写仍然被拒（判定语义不变）', outside.threw, '没有被拒')
check(
  '抛出的仍是原错误文案「路径越界」（一字不改）',
  /路径越界/.test(outside.err?.message ?? ''),
  `实际：${outside.err?.message}`
)

const bad = await writeIt('   ')
check('空 path 仍然被拒', bad.threw, '没有被拒')
check(
  '空 path 抛的仍是原错误文案（path 必须是非空字符串）',
  /非空字符串/.test(bad.err?.message ?? ''),
  `实际：${bad.err?.message}`
)

const rows1 = readAudit()
const writeProbes = rows1.filter((r) => r.decision === WRITE_PROBE)
check(
  `越界写在链上留下 ${writeProbes.length} 条 write-probe（改前应为 0 ⇒ 本条必红）`,
  writeProbes.length === 2,
  `链上现有 decision：${JSON.stringify(rows1.map((r) => r.decision))}`
)
check(
  'write-probe 记的是 ONTOLOGY_WRITE，不冒充 allow/deny',
  writeProbes.every((r) => r.tool === ONTOLOGY_WRITE),
  JSON.stringify(writeProbes[0] ?? null)
)
check(
  'write-probe 带 target（被拒的那个路径）',
  writeProbes.some((r) => typeof r.target === 'string' && r.target.length > 0),
  JSON.stringify(writeProbes.map((r) => r.target))
)
check(
  'write-probe 与读侧 read-probe 是**不同**类别（可分别统计）',
  typeof WRITE_PROBE === 'string' && WRITE_PROBE.length > 0 && WRITE_PROBE !== READ_PROBE,
  `WRITE_PROBE=${String(WRITE_PROBE)} READ_PROBE=${String(READ_PROBE)}`
)

// 合法写：行为零变化（只记 allow，不变成 probe）
const okWrite = await writeIt('ok.yaml', 'a: 2\n')
check('合法写仍然成功', !okWrite.threw, JSON.stringify(okWrite.err?.message ?? okWrite.out))
const rows2 = readAudit()
const allows = rows2.filter((r) => r.decision === 'allow' && r.tool === ONTOLOGY_WRITE)
check('合法写仍然只记一条 allow', allows.length === 1, `allow=${allows.length}`)

let chainOk = true
let chainWhy = ''
for (let i = 1; i < rows2.length; i++) {
  if (rows2[i].prevHash !== rows2[i - 1].hash) { chainOk = false; chainWhy = `第 ${i + 1} 行 prevHash 断链` }
  if (rows2[i].seq !== rows2[i - 1].seq + 1) { chainOk = false; chainWhy = `第 ${i + 1} 行 seq 不连续` }
}
check('哈希链仍然连续（seq 递增 1 且 prevHash 衔接）', chainOk, chainWhy)

// ══════════ B 组：缺陷 A① —— 审计目录进保护根（P0-2） ══════════
lines.push('')
lines.push('B 组：审计目录进保护根（缺陷 A① / P0-2）')

const shellExec = (command) => ({ name: 'pwsh', arguments: { command } })

// B1 审计链本身
const hitAudit = evaluate(shellExec(`echo hi > ${auditPath}`), cfg, true)
check(
  'shell 直写**审计链**被拒（改前无保护 ⇒ 本条必红）',
  typeof hitAudit.deny === 'string' && hitAudit.deny.length > 0,
  `deny=${JSON.stringify(hitAudit.deny)}`
)
check(
  '拒绝理由说明命中的是受保护目录',
  AUDIT_PROTECTED_REASON.test(hitAudit.deny ?? ''),
  `deny=${JSON.stringify(hitAudit.deny)}`
)
check(
  'hits 里带回被命中的候选路径',
  Array.isArray(hitAudit.hits) && hitAudit.hits.length > 0,
  JSON.stringify(hitAudit.hits)
)

// B1b 审计目录里的**其它**文件（不只是 gate.jsonl，改名也拦）
const hitAudit2 = evaluate(shellExec(`del ${join(auditDir, 'anything.jsonl')}`), cfg, true)
check('审计目录内的其它文件同样被拒（不是只认 gate.jsonl）', typeof hitAudit2.deny === 'string', JSON.stringify(hitAudit2.deny))

// B2 ontologyRoot：行为零变化（回归，不是新增）
const hitOnto = evaluate(shellExec(`echo hi > ${join(root, 'actions.yaml')}`), cfg, true)
check('ontologyRoot 内仍然被拒（回归：老行为不得回退）', typeof hitOnto.deny === 'string', JSON.stringify(hitOnto.deny))
check(
  'ontologyRoot 拒绝理由仍是「ontology 目录」那条（文案不改）',
  /ontology/.test(hitOnto.deny ?? ''),
  JSON.stringify(hitOnto.deny)
)

// B3 普通路径：不得误伤（防过度拦截）
const plain = evaluate(shellExec(`echo hi > ${join(plainDir, 'notes.txt')}`), cfg, true)
check('审计目录 / ontology 之外的普通路径仍然放行（防过度拦截）', plain.deny === undefined, JSON.stringify(plain.deny))

// B4 🔴 auditPath 为空串 ⇒ 不得把 '.' 当保护根（死门禁陷阱）
const cfgNoAudit = cfgOf({ auditPath: '' })
const emptyAudit = evaluate(shellExec(`echo hi > ${join(plainDir, 'notes.txt')}`), cfgNoAudit, true)
check(
  `auditPath 为空串时不得把 dirname('')='.' 当保护根（否则 cwd 全被拦 ⇒ 死门禁）`,
  emptyAudit.deny === undefined,
  `deny=${JSON.stringify(emptyAudit.deny)}（auditPath='' 时 dirname='${dirname('')}'）`
)

// B5 shadow 模式（applySemanticRules=false）⇒ 路径兜底不拦（与现有一致）
const shadow = evaluate(shellExec(`echo hi > ${auditPath}`), cfg, false)
check('shadow 模式下路径兜底不拦（与 ontologyRoot 那段同口径）', shadow.deny === undefined, JSON.stringify(shadow.deny))

// B6 modeIndependent 的那条（run_code）不受本改动影响
const runCode = evaluate({ name: 'run_code', arguments: { code: 'print(1)' } }, cfg, false)
check('run_code 仍是无条件拒（modeIndependent，shadow 下也拦）', typeof runCode.deny === 'string' && runCode.modeIndependent === true, JSON.stringify(runCode))

// ══════════ C 组：P0-4a —— protectedExtraRoots（A2/A3：state.yaml / .state.lock） ══════════
lines.push('')
lines.push('C 组：配置化扩展受保护根（缺陷 A②A③ / P0-4a）')

// 与活体同构：state 落在 projectRoot/memory 下，且**不在** ontologyRoot / auditDir 之内
const stateRoot = join(base, 'fde-state')
const stateDir = join(stateRoot, 'memory')
mkdirSync(stateDir, { recursive: true })
writeFileSync(join(stateDir, 'state.yaml'), 'current_phase: "11"\n', 'utf8')
const statePath = join(stateDir, 'state.yaml')
const lockPath = join(stateDir, '.state.lock')

// C1 改前：state.yaml 在受保护集之外 ⇒ 放行（本条改后必须翻红 ⇒ 现在先记录"敞着"这个事实）
const cfgExtra = cfgOf({ protectedExtraRoots: [stateRoot] })

const hitState = evaluate(shellExec(`echo hi > ${statePath}`), cfgExtra, true)
check(
  `shell 直写 state.yaml 被拒（改前 A② 敞着 ⇒ 本条必红）`,
  typeof hitState.deny === 'string' && hitState.deny.length > 0,
  `deny=${JSON.stringify(hitState.deny)}`
)

const hitLock = evaluate(shellExec(`del ${lockPath}`), cfgExtra, true)
check(
  'shell 动 .state.lock 被拒（改前 A③ 敞着 ⇒ 本条必红）',
  typeof hitLock.deny === 'string' && hitLock.deny.length > 0,
  `deny=${JSON.stringify(hitLock.deny)}`
)

// C3 单一事实源：判定与启动期打印必须共用同一个函数（否则"打印的和判的不一样"= 新漂移）
check(
  'protectedRootsOf(cfg) 存在且与判定同源（供 index.js 启动打印复用）',
  typeof protectedRootsOf === 'function',
  `typeof=${typeof protectedRootsOf}`
)
const rootsList = typeof protectedRootsOf === 'function' ? protectedRootsOf(cfgExtra) : []
const rootStrings = Array.isArray(rootsList) ? rootsList.map((e) => (typeof e === 'string' ? e : e?.root)) : []
check(
  'protectedRootsOf 返回 ontologyRoot + 审计目录 + 扩展根三条（去重后）',
  rootStrings.length === 3,
  JSON.stringify(rootsList)
)
check(
  'protectedRootsOf 去重：扩展根重复配置不产生重复项',
  new Set(rootStrings).size === rootStrings.length,
  JSON.stringify(rootStrings)
)
check(
  '去重按**目录**而非对象标识（重复配置同一目录只保留一条）',
  (() => {
    if (typeof protectedRootsOf !== 'function') return false
    const dup = protectedRootsOf(cfgOf({ protectedExtraRoots: [stateRoot, stateRoot, root] }))
    const rs = dup.map((e) => (typeof e === 'string' ? e : e?.root))
    return rs.length === 3 && new Set(rs).size === 3
  })(),
  JSON.stringify(typeof protectedRootsOf === 'function' ? protectedRootsOf(cfgOf({ protectedExtraRoots: [stateRoot, stateRoot, root] })) : null)
)

// C4 🔴 与 B4 同族陷阱：扩展根里的空串/空白不得变成 '.'（cwd）⇒ 死门禁
const cfgBlank = cfgOf({ protectedExtraRoots: ['', '   '] })
const blankPlain = evaluate(shellExec(`echo hi > ${join(plainDir, 'notes.txt')}`), cfgBlank, true)
check(
  '扩展根里的空串/空白被跳过（不得退化成 cwd ⇒ 死门禁）',
  blankPlain.deny === undefined,
  `deny=${JSON.stringify(blankPlain.deny)}`
)

// C5 未配置时行为零变化（老部署升级后不得被新字段误伤）
const noExtra = evaluate(shellExec(`echo hi > ${statePath}`), cfgOf(), true)
check(
  'protectedExtraRoots 缺省（undefined）时行为零变化：state 目录仍不在保护集内（回归，非缺陷）',
  noExtra.deny === undefined,
  `deny=${JSON.stringify(noExtra.deny)}`
)
const plainStillOk = evaluate(shellExec(`echo hi > ${join(plainDir, 'notes.txt')}`), cfgExtra, true)
check('配置扩展根后，普通路径仍然放行（防过度拦截）', plainStillOk.deny === undefined, JSON.stringify(plainStillOk.deny))

// C6 fail-closed：类型写错必须加载期就炸，而不是静默丢弃
const callAssert = (v) => {
  if (typeof assertProtectedExtraRoots !== 'function') return { unavailable: true, threw: false }
  try {
    assertProtectedExtraRoots(v)
    return { threw: false }
  } catch (e) {
    return { threw: true, msg: e.message }
  }
}
// ⚠️ 这几条一律**不允许**靠"函数不存在"蒙混过关（unavailable ⇒ 判红）：
//    否则"还没实现"会被算成"实现正确"，正是本项目反复踩的"绿≠完整"。
const a1 = callAssert(undefined)
check('缺省 undefined 合法（不抛）', a1.threw === false && !a1.unavailable, JSON.stringify(a1))
const a2 = callAssert([stateRoot])
check('合法数组不抛', a2.threw === false && !a2.unavailable, JSON.stringify(a2))
const a3 = callAssert([''])
check('含空串 ⇒ 抛（fail-closed：宁可不起，也不带着"配了但等于没配"运行）', a3.threw === true && !a3.unavailable, JSON.stringify(a3))
const a4 = callAssert('E:\\x')
check('非数组 ⇒ 抛', a4.threw === true && !a4.unavailable, JSON.stringify(a4))
const a5 = callAssert([123])
check('数组内非字符串 ⇒ 抛', a5.threw === true && !a5.unavailable, JSON.stringify(a5))

// ══════════ D 组：P0-8 —— 拒绝文案按**命中的根**生成（不再把"ontology / 审计链"写死） ══════════
lines.push('')
lines.push('D 组：拒绝文案按命中的受保护区域生成（0024 P0-8）')

const denyOf = (p) => evaluate(shellExec(`echo hi > ${p}`), cfgExtra, true).deny ?? ''

// D1 🔴 改前必红：`fde-state` 既不是 ontology 也不是审计链目录，但文案写死 ⇒ 两句都在
const dState = denyOf(statePath)
check(
  '写 fde-state 的拒绝理由**不含**「审计链目录」（改前写死 ⇒ 必红）',
  dState.length > 0 && !/审计链目录/.test(dState),
  `deny=${JSON.stringify(dState)}`
)
check(
  '写 fde-state 的拒绝理由**不暗示**可用 fde_ontology_* 访问（它根本没有专用通道）',
  !/fde_ontology_read/.test(dState),
  `deny=${JSON.stringify(dState)}`
)
check(
  '写 fde-state 的拒绝理由点名「受保护区域」+ 命中的区域名',
  /受保护区域/.test(dState) && /额外受保护目录/.test(dState),
  `deny=${JSON.stringify(dState)}`
)

// D2 回归：ontology / 审计链的老断言**必须**还成立（只泛化，不许丢信息）
const dOnto = denyOf(join(root, 'actions.yaml'))
check('命中 ontology 的理由仍点名 ontology', /ontology/.test(dOnto), JSON.stringify(dOnto))
check(
  '命中 ontology 的理由仍给出专用工具名（且是 tools.js 里真的那个）',
  dOnto.includes(ONTOLOGY_READ) && dOnto.includes(ONTOLOGY_WRITE),
  JSON.stringify(dOnto)
)
check('命中 ontology 的理由不含「审计链目录」（文案不再串台）', !/审计链目录/.test(dOnto), JSON.stringify(dOnto))

const dAudit = denyOf(auditPath)
check('命中审计目录的理由仍点名审计链目录', /审计链目录/.test(dAudit), JSON.stringify(dAudit))
check('命中审计目录的理由不含 fde_ontology_read', !/fde_ontology_read/.test(dAudit), JSON.stringify(dAudit))

// D3 条目形态：{root,label,note} —— label/note 与 root 出自**同一个函数** ⇒ 打印与判定不可能分叉
const entries = typeof protectedRootsOf === 'function' ? protectedRootsOf(cfgExtra) : []
const isEntry = (e) =>
  !!e && typeof e === 'object' && typeof e.root === 'string' && typeof e.label === 'string' && typeof e.note === 'string'
check(
  'protectedRootsOf 返回 {root,label,note} 条目（改前是裸字符串 ⇒ 必红）',
  Array.isArray(entries) && entries.length === 3 && entries.every(isEntry),
  JSON.stringify(entries)
)
check(
  '三个区域的 label 互不相同（防 0023 §5.3 那种"叫法同形"重演）',
  entries.every(isEntry) && new Set(entries.map((e) => e.label)).size === 3,
  JSON.stringify(entries.map((e) => e?.label))
)
check(
  '三个区域的 note 互不相同（每个区域给的是自己的那句说明）',
  entries.every(isEntry) && new Set(entries.map((e) => e.note)).size === 3,
  JSON.stringify(entries.map((e) => e?.note?.slice(0, 24)))
)
check(
  'ontology 条目的 note 里的工具名 == tools.js 真实导出的工具名（防改名后文案说谎）',
  entries.some((e) => e?.kind === 'ontology' && e.note.includes(ONTOLOGY_READ) && e.note.includes(ONTOLOGY_WRITE)),
  JSON.stringify(entries.find((e) => e?.kind === 'ontology') ?? null)
)

// D4 启动打印：与判定同源，且**可测**（否则"打印对不对"永远只是设计声明）
check(
  'formatProtectedRootsLine(cfg) 存在（启动打印复用它 ⇒ 可离线断言）',
  typeof formatProtectedRootsLine === 'function',
  `typeof=${typeof formatProtectedRootsLine}`
)
const printLine = typeof formatProtectedRootsLine === 'function' ? formatProtectedRootsLine(cfgExtra) : ''
check(
  '启动打印行含**全部**受保护根（打印的 = 判的）',
  entries.every(isEntry) && entries.every((e) => printLine.includes(e.root)),
  JSON.stringify(printLine)
)
check(
  '启动打印行含**全部** label（"打印的叫法" = "拒绝的叫法"）',
  entries.every(isEntry) && entries.every((e) => printLine.includes(e.label)),
  JSON.stringify(printLine)
)
check(
  '启动打印行数 = 判定条目数（不多不少，防多打印一个没判的 / 少打印一个判了的）',
  typeof formatProtectedRootsLine === 'function' && printLine.includes(`（${entries.length}）`),
  JSON.stringify(printLine)
)

// ══════════ E 组：P0-9 —— 文案口径必须覆盖「读」（守卫读写都拦，note 却只讲"直写"） ══════════
lines.push('')
lines.push('E 组：拒绝文案的读写口径（0025 P0-9）')

// 🔴 缺陷实证（活体 gate.jsonl seq 9/10/11）：三个动作**全是 read**，
//    而三条 note 分别说的是「直写绕过…」「不接受任何直写」「不接受任何直写」——
//    ⇒ 模型读到的是"我只是读一下，为什么在讲写"，进而可能推断"读应该被允许"再去试。
//    HANDOFF.md:431 早就记了「读取也被管（超出原设计的"直写"范围）」，但文案一直没跟上。

// E1 读向量：read 工具形状的 exec（与活体 seq 9-11 同形）
// ⚠️ 参数键必须是 `file_path`：KNOWN_PATH_KEYS.read = ['file_path']（`guard.js:17`），
//    写成 `path` 会取不到候选 ⇒ deny 恒为 '' ⇒ 后面的"不含直写"会**空过**（假绿）。
//    这条踩过一次，所以上面三条"确实被拒"的前提断言必须先于口径断言。
const readExec = (p) => ({ name: 'read', arguments: { file_path: p } })

const rState = evaluate(readExec(statePath), cfgExtra, true).deny ?? ''
const rAudit = evaluate(readExec(auditPath), cfgExtra, true).deny ?? ''
const rOnto = evaluate(readExec(join(root, 'actions.yaml')), cfgExtra, true).deny ?? ''

check(
  'read 打 fde-state 确实被拒（守卫对读也拦 —— 这是前提，不成立则下面全无意义）',
  rState.length > 0,
  `deny=${JSON.stringify(rState)}`
)
check(
  'read 打审计链目录被拒',
  rAudit.length > 0,
  `deny=${JSON.stringify(rAudit)}`
)
check(
  'read 打 ontology 被拒',
  rOnto.length > 0,
  `deny=${JSON.stringify(rOnto)}`
)

// E2 🔴 改前必红：读动作的拒绝理由里**不得**出现只覆盖写的「直写」
for (const [name, text] of [
  ['fde-state', rState],
  ['审计链目录', rAudit],
  ['ontology', rOnto]
]) {
  check(
    `read 打 ${name} 的理由不含「直写」（改前 note 全只讲写 ⇒ 必红）`,
    !/直写/.test(text),
    `deny=${JSON.stringify(text)}`
  )
  check(
    `read 打 ${name} 的理由明确覆盖「读」（否则模型会以为只是不让写）`,
    /读/.test(text),
    `deny=${JSON.stringify(text)}`
  )
}

// E3 三类仍要说**不同的话**（P0-8 的分工不许被这次统一口径抹平）
const kindNote = (k) => entries.find((e) => e?.kind === k)?.note ?? ''
check(
  'ontology 的 note 仍点名专用通道（它有通道，只是必须走通道）',
  kindNote('ontology').includes(ONTOLOGY_READ) && kindNote('ontology').includes(ONTOLOGY_WRITE),
  JSON.stringify(kindNote('ontology'))
)
check(
  '审计链目录的 note 仍**不**提 fde_ontology_*（它没有通道）',
  !/fde_ontology_/.test(kindNote('audit')),
  JSON.stringify(kindNote('audit'))
)
check(
  '额外受保护目录的 note 仍**不**提 fde_ontology_*（否定句式也会诱导模型去试）',
  !/fde_ontology_/.test(kindNote('extra')),
  JSON.stringify(kindNote('extra'))
)
check(
  '三条 note 仍互不相同（口径统一 ≠ 三区说同一句话）',
  new Set([kindNote('ontology'), kindNote('audit'), kindNote('extra')]).size === 3,
  JSON.stringify([kindNote('ontology'), kindNote('audit'), kindNote('extra')])
)

// E3b 🔴 穷尽实例（0025 §6 的教训：说出"根因是 X"之后要**把 X 推到所有实例**）：
//      除了三类 note，`guard.js` 里还有**第四处**兜底文案（未命中任何 kind 时）。
//      P0-9 第一版只改了三类、漏了它 ⇒ 已提成导出常量，这里一并断言。
const unknownNote = pathsMod.UNKNOWN_PROTECTED_NOTE
check(
  '兜底文案 UNKNOWN_PROTECTED_NOTE 已导出（不再藏在 guard.js 的字面量里 ⇒ 可被断言）',
  typeof unknownNote === 'string' && unknownNote.length > 0,
  `typeof=${typeof unknownNote}`
)
check(
  '兜底文案同样不含「直写」且覆盖「读」（改前是"该区域不接受直写。" ⇒ 必红）',
  typeof unknownNote === 'string' && !/直写/.test(unknownNote) && /读/.test(unknownNote),
  JSON.stringify(unknownNote)
)

// E4 写向量回归：改完口径后，写动作的拒绝理由同样成立（不得只顾读忘了写）
const wState = evaluate(shellExec(`echo hi > ${statePath}`), cfgExtra, true).deny ?? ''
check(
  'write 打 fde-state 的理由仍成立且同样覆盖读与写（读写同口径，不分叉）',
  wState.length > 0 && /读/.test(wState) && /写/.test(wState),
  `deny=${JSON.stringify(wState)}`
)

lines.push('')
// 按纪律：套件必须能被证伪（FDE_INVERT=1 ⇒ 必须变红）
if (process.env.FDE_INVERT === '1') {
  check('[INVERT] 故意失败以验证退出码敏感', false, 'injected by FDE_INVERT')
}

lines.push('')
lines.push(`结果：${passed} 通过 / ${failed} 失败`)
lines.push(failed > 0 ? '状态：FAILED' : '状态：ALL GREEN')

// FDE_OUT（0030 §7）：跑轮次时显式给输出名 ⇒ 两轮不互相覆盖（缺省沿用原名）
writeFileSync(
  process.env.FDE_OUT ?? new URL('./_gate_audit_guard_out.txt', import.meta.url),
  lines.join('\n'),
  'utf8'
)
console.log(lines.join('\n'))
process.exit(failed === 0 ? 0 : 1)
