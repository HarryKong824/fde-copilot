/**
 * `_fde_e2_test.mjs` 的**变异验证** —— 证明那 41 条断言真会红，而不是"恰好全绿"。
 *
 * 跑法：`node _fde_e2_mut.mjs`；结果写 `_e2_mut_out.txt`。
 *
 * 变异目标是**工作区源码**（本套件 import 的就是它），所以备份/还原比改部署副本简单，
 * 但仍按同一条纪律来：跑前记 sha256、每条 `finally` 无条件还原、收尾整体核对，
 * 不一致 ⇒ EXIT=2 并显式写出"源码已被污染"。
 *
 * 🔴 判据（每条变异都必须满足，缺任一 ⇒ 本轮作废）：
 *   ① 期望的**具名**断言出现在红名单里；
 *   ② 报告**完整产出**（out.txt 存在且含 `通过 N / 失败 M`）—— 崩溃不是证据：
 *      崩溃会让整份报告消失，与"断言抓住了"看起来都是"没通过"；
 *   ③ 该轮的进程退出码 **!= 0** —— 顺带证明"退出码随失败变化"，而不是恒 0。
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '_e2_mut_out.txt')
const TEST = join(HERE, '_fde_e2_test.mjs')
const TEST_OUT = join(HERE, '_e2_out.txt')
const BACKUP = join(HERE, '_mut', 'e2')

const GATE_PATHS = join(HERE, 'dsh-fde-ontology-gate', 'lib', 'paths.js')
const GATE_GUARD = join(HERE, 'dsh-fde-ontology-gate', 'lib', 'guard.js')
const GATE_CONFIG = join(HERE, 'dsh-fde-ontology-gate', 'lib', 'config.js')
const MEM_EXP = join(HERE, 'dsh-fde-memory', 'lib', 'experiments.js')
const MEM_TOOLS = join(HERE, 'dsh-fde-memory', 'lib', 'tools.js')

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
/** 备份文件名：先把 `\` 归一成 `/` 再切，否则 Windows 上会得到"一个超长文件名"。 */
const bname = (f) => f.replace(/\\/g, '/').split('/').slice(-3).join('_')

/**
 * 变异表。`from` 必须在目标文件里**恰好出现一次**；出现 0 次或多次 ⇒ 无效变异，本轮作废。
 */
const MUTANTS = [
  {
    id: 'M1',
    file: GATE_PATHS,
    desc: '沙箱派生源从 protectedExtraRoots 换成 ontologyRoot（= 给 ontology 开豁免）',
    from: '  const roots = Array.isArray(cfg?.protectedExtraRoots) ? cfg.protectedExtraRoots : []',
    to: '  const roots = [cfg?.ontologyRoot] // MUT M1',
    expect: '[C8] 写 <ontologyRoot>/experiments/x.yaml ⇒ 拒（ontology 类根拿不到豁免 —— 结构性收窄）'
  },
  {
    id: 'M2',
    file: GATE_GUARD,
    desc: 'guard 不做沙箱豁免（沙箱内也被拒 ⇒ 沙箱不可用）',
    from: '    .filter((candidate) => !sandboxes.some((box) => isInside(candidate, box.path)))',
    to: '    // MUT M2: 沙箱豁免被移除',
    expect: '[C1] 写 <projectRoot>/experiments/x.yaml ⇒ 放行（无 deny、无 hits）'
  },
  {
    id: 'M3',
    file: GATE_PATHS,
    desc: '沙箱子目录名放开穿越（允许 .. 段）',
    // ⚠️ 锚点取**调用处**而不是那个正则字面量：正则里含字面的 `\u0000`，
    //    而 `\u0000` 写在 JS 字符串字面量里会被解释成真的 NUL 字符 ⇒ 匹配不上（实测踩过）。
    from: "    if (!SANDBOX_SUBDIR_RE.test(name) || name === '.' || name === '..' || isAbsolute(name)) {",
    to: '    if (false) { // MUT M3',
    expect: '[B1] 子目录名含 .. ⇒ 加载期抛错（否则 join 出来就是保护根外的任意位置）'
  },
  {
    id: 'M4',
    file: GATE_PATHS,
    desc: '不查"沙箱是否压在别的保护根上"',
    from: '  const sandboxes = sandboxPathsOf(cfg)\n  if (sandboxes.length === 0) return\n  const entries = protectedRootsOf(cfg)',
    to: '  const sandboxes = sandboxPathsOf(cfg)\n  if (sandboxes.length === 0) return\n  if (true) return // MUT M4\n  const entries = protectedRootsOf(cfg)',
    expect: '[B6] 沙箱压在**审计目录**内 ⇒ 加载期抛错（否则等于在合规证据上开可写洞）'
  },
  {
    id: 'M5',
    file: MEM_EXP,
    desc: '沙箱路径不拒 .. 段（边界可穿越）',
    from: "    if (seg === '.' || seg === '..') {",
    to: "    if (seg === '..never') { // MUT M5",
    expect: '[D5] 沙箱内 .. 段 ⇒ 拒（沙箱边界不可穿越）'
  },
  {
    id: 'M6',
    file: MEM_EXP,
    desc: '沙箱内不查符号链接（可借链接写到 memory/）',
    from: '    if (lstatSync(cur).isSymbolicLink()) {',
    to: '    if (false && lstatSync(cur).isSymbolicLink()) { // MUT M6',
    expect: '[D7] 沙箱内符号链接 ⇒ 读写都拒（分段校验挡不住它，靠逐级 lstat）'
  },
  {
    id: 'M7',
    file: MEM_TOOLS,
    desc: '沙箱写入落审计（违反 spec §7 第 4 条"无审计要求"）',
    from: '            return writeExperiment(cfg.projectRoot, args?.name, args?.content)',
    to: "            await audit?.record({ type: 'experiment-write' }) // MUT M7\n            return writeExperiment(cfg.projectRoot, args?.name, args?.content)",
    expect: '[D9] 写沙箱**不落审计**（spec §7 第 4 条）：真审计链的字节数前后不变'
  },
  {
    id: 'M8',
    file: GATE_PATHS,
    desc: '启动打印不显示沙箱（洞开着而启动期看不见）',
    from: '  const boxBody = boxes.map((b) => `${b.path}（豁免自 ${b.root}）`).join(\' | \')\n  return `${line} ｜ 沙箱（${boxes.length}）：${boxBody}`',
    to: '  return line // MUT M8',
    expect: '[G1] 开了沙箱 ⇒ 打印行含沙箱路径与宿主 root'
  },
  {
    id: 'M9',
    file: GATE_CONFIG,
    desc: 'normalizeConfig 不调沙箱校验（B 组全绿而线上毫无作用）',
    from: '  assertSandboxSubdirs(raw.sandboxSubdirs, raw.protectedExtraRoots)',
    to: '  // MUT M9: assertSandboxSubdirs 调用被移除',
    expect: '[F3] normalizeConfig **真的调了**两个沙箱校验（否则 B 组全绿而线上毫无作用 —— 静态断言，可被变异证伪）'
  },
  {
    id: 'M10',
    file: MEM_EXP,
    desc: '沙箱写入不限大小（可一次撑爆）',
    from: '  if (bytes > MAX_CONTENT_BYTES) {',
    to: '  if (false && bytes > MAX_CONTENT_BYTES) { // MUT M10',
    expect: '[D8] 内容超 256 KiB ⇒ 拒（fail-closed，不截断 —— 截断会让模型拿到"看起来完整"的半份草稿）'
  }
]

const lines = []
let red = 0
let green = 0
let invalid = 0

/** 跑一次测试，返回 {exit, reds, complete, raw}。 */
function runTest() {
  if (existsSync(TEST_OUT)) unlinkSync(TEST_OUT)
  let exit = 0
  try {
    execFileSync(process.execPath, [TEST], { cwd: HERE, stdio: 'pipe' })
  } catch (e) {
    exit = typeof e.status === 'number' ? e.status : -1
  }
  const raw = existsSync(TEST_OUT) ? readFileSync(TEST_OUT, 'utf8') : ''
  const reds = new Set(
    raw
      .split('\n')
      .filter((l) => l.includes('✗ '))
      .map((l) => l.slice(l.indexOf('✗ ') + 2).trim())
  )
  return { exit, reds, complete: /通过 \d+ \/ 失败 \d+/.test(raw), raw }
}

// ──────────────────────────────────────────────────────────── 备份
mkdirSync(BACKUP, { recursive: true })
const targets = [...new Set(MUTANTS.map((m) => m.file))]
const originalSha = new Map()
for (const f of targets) {
  copyFileSync(f, join(BACKUP, bname(f)))
  originalSha.set(f, sha(f))
}

lines.push('== `_fde_e2_test.mjs` 变异验证（目标 = 工作区源码）==')
lines.push('')
lines.push('-- 基线（无变异）--')
let exitCode = 0
try {
  const base = runTest()
  if (!base.complete || base.reds.size > 0 || base.exit !== 0) {
    lines.push(`  ✗ 基线不是全绿：exit=${base.exit} 红=${base.reds.size} 完整=${base.complete}`)
    lines.push('  ⇒ 基线不成立，本轮作废（先修测试再谈变异）')
    exitCode = 2
  } else {
    lines.push('  ✓ 基线全绿（exit=0，报告完整）')
  }
} catch (e) {
  lines.push(`  ✗ 基线崩溃：${e && e.message}`)
  exitCode = 2
}

if (exitCode === 0) {
  lines.push('')
  for (const m of MUTANTS) {
    const short = m.file.replace(/\\/g, '/').split('/').slice(-2).join('/')
    lines.push(`-- ${m.id} ${short}：${m.desc} --`)
    const src = readFileSync(m.file, 'utf8')
    const occurrences = src.split(m.from).length - 1
    if (occurrences !== 1) {
      invalid += 1
      lines.push(`  ⚠️ 无效变异：锚点出现 ${occurrences} 次（要求恰好 1 次）⇒ 本轮作废重做`)
      lines.push('')
      continue
    }
    try {
      writeFileSync(m.file, src.replace(m.from, m.to), 'utf8')
      const r = runTest()
      if (!r.complete) {
        invalid += 1
        lines.push(`  ⚠️ 无效变异：报告未产出（exit=${r.exit}）⇒ 是崩溃不是断言红，本轮作废重做`)
      } else if (r.reds.has(m.expect)) {
        red += 1
        const others = [...r.reds].filter((x) => x !== m.expect).length
        lines.push(
          `  ✓ 期望断言红：「${m.expect}」` +
            `${others > 0 ? `（另有 ${others} 条红）` : ''}` +
            `${r.exit !== 0 ? `，exit=${r.exit}` : '，⚠️ 但 exit=0 ⇒ 退出码没跟着变'}`
        )
      } else {
        green += 1
        lines.push(`  ✗ 期望断言**没红**：变异未被抓住 ⇒ 该判据对这条缺陷是盲的`)
        lines.push(`      实际红名单：${[...r.reds].map((s) => `「${s}」`).join(' / ') || '（空）'}`)
      }
    } finally {
      // 无条件还原：任何路径（含抛错）都不许把源码留在变异态
      copyFileSync(join(BACKUP, bname(m.file)), m.file)
    }
    lines.push('')
  }
}

// ──────────────────────────────────────────────────────────── 还原核对
lines.push('-- 还原核对（工作区源码）--')
let restored = true
for (const f of targets) {
  const now = sha(f)
  const ok = now === originalSha.get(f)
  if (!ok) restored = false
  lines.push(`  ${ok ? '✓' : '✗'} ${f}`)
  if (!ok) lines.push(`      ${originalSha.get(f)}\n      现已变成 ${now} ⇒ 源码被污染，必须手工还原`)
}

lines.push('')
lines.push(`红 ${red} / 绿 ${green} / 无效 ${invalid}（共 ${MUTANTS.length} 条）`)
if (!restored || exitCode === 2) {
  lines.push('RESULT: INVALID（基线不成立或源码未还原）')
  if (exitCode === 0) exitCode = 2
} else if (green > 0 || invalid > 0) {
  lines.push('RESULT: FAIL')
  exitCode = 1
} else {
  lines.push('RESULT: PASS（全部变异被期望的具名断言抓住，且源码已逐字还原）')
}

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(`[e2-mut] 结果已写入 ${OUT}：红 ${red} / 绿 ${green} / 无效 ${invalid}`)
process.exitCode = exitCode
