/**
 * `_fde_e1_wiring_test.mjs` 的**变异验证** —— 证明那 19 条断言真会红，而不是"恰好全绿"。
 *
 * 跑法：`node _fde_e1_wiring_mut.mjs`
 * 结果写 `_e1_wiring_mut_out.txt`。
 *
 * 🔴 变异目标是**部署副本**（因为接线测试 import 的就是它），不是工作区源码。
 *    因此本脚本对"还原"的要求比改工作区更高：
 *      ① 开跑前记录每个被改文件的 sha256；
 *      ② 每个变异跑完立刻逐字还原（try/finally，任何异常路径都还原）；
 *      ③ 全部跑完再核一遍 sha256，不一致 ⇒ EXIT=2 并**显式写出"部署副本已被污染"**。
 *
 * 🔴 判据（每条变异都必须满足，缺任一 ⇒ 本轮作废）：
 *      ① 具名期望断言**出现在红名单里**；
 *      ② 报告**完整产出**（out.txt 存在且含 `通过 N / 失败 M`）—— 崩溃不是证据：
 *         崩溃会让整份报告消失，与"断言抓住了"看起来一样是"没通过"。
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '_e1_wiring_mut_out.txt')
const TEST = join(HERE, '_fde_e1_wiring_test.mjs')
const TEST_OUT = join(HERE, '_e1_wiring_out.txt')
const BACKUP = join(HERE, '_mut', 'e1wiring')
const DEPLOYED = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/node_modules'

const GATE_INDEX = join(DEPLOYED, 'dsh-fde-ontology-gate/lib/index.js')
const PHASE_INDEX = join(DEPLOYED, 'dsh-fde-phase/lib/index.js')

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/**
 * 备份文件名。⚠️ 必须先把 `\` 归一成 `/` 再切 —— Windows 上用 `/` 切整条路径会得到
 * "一个超长文件名"，`copyFileSync` 当场 ENOENT（实测第一轮就是这么崩的）。
 */
const bname = (f) => f.replace(/\\/g, '/').split('/').slice(-3).join('_')

/**
 * 变异表。`from` 必须**在目标文件里唯一**（不唯一 ⇒ 直接判无效，不静默替换第一处）。
 */
const MUTANTS = [
  {
    id: 'M1',
    file: GATE_INDEX,
    desc: 'gate 不读自己的链恢复放行表（删 bg.restoreSync）',
    from: '  bg.restoreSync(cfg.auditPath)\n',
    to: '  // MUT M1: bg.restoreSync(cfg.auditPath) 被移除\n',
    expect: '[B1] 重启恢复：链上预置的 break-glass 让 GATE-PATH 真被放行'
  },
  {
    id: 'M2',
    file: GATE_INDEX,
    desc: 'gate 收到 open 事件后不落自己的链（重启即丢放行）',
    from: '      } else if (payload?.id) {',
    to: '      } else if (payload?.id && false) {',
    expect: '[C] 收到事件 ⇒ **写进自己的链**（否则重启后放行全丢）'
  },
  {
    id: 'M3',
    file: GATE_INDEX,
    desc: 'P0-1 同型：把注销器当回调直接交给 effect ⇒ 监听器在 apply 期当场注销',
    from: '  ctx.effect(() => disposeBG,',
    to: '  ctx.effect(disposeBG,',
    expect: '[A] `fde/break-glass` 监听器注册且**存活**（没在 apply 期被当场注销）'
  },
  {
    id: 'M4',
    file: GATE_INDEX,
    desc: 'gate 收到 resolved 时不更新放行表（放行永不失效）',
    from: '      bg.update(payload)\n',
    to: '      if (payload?.resolved !== true) bg.update(payload) // MUT M4\n',
    expect: '[D] 收到 resolved ⇒ 不再放行'
  },
  {
    id: 'M5',
    file: GATE_INDEX,
    desc: 'gate 收到 resolved 时不落链（重启后放行复活）',
    from: '      if (payload?.resolved === true) {',
    to: '      if (false && payload?.resolved === true) {',
    expect: '[D] 收到 resolved ⇒ 本链新增一条 resolved（供下次重启恢复）'
  },
  {
    id: 'M6',
    file: PHASE_INDEX,
    desc: 'phase 不读自己的链恢复放行表（D1 放行重启即丢）',
    from: '  bg.restoreSync(cfg.auditPath)\n',
    to: '  // MUT M6: bg.restoreSync(cfg.auditPath) 被移除\n',
    expect: '[F1] 重启恢复：链上预置的 D1 break-glass 让 fde_phase_advance 真被放行'
  }
]

const lines = []
let red = 0
let green = 0
let invalid = 0

/** 跑一次测试，返回 {exit, reds: Set, complete: boolean, raw: string}。 */
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

// ---------------------------------------------------------------- 备份
mkdirSync(BACKUP, { recursive: true })
const targets = [...new Set(MUTANTS.map((m) => m.file))]
const originalSha = new Map()
for (const f of targets) {
  copyFileSync(f, join(BACKUP, bname(f)))
  originalSha.set(f, sha(f))
}

lines.push('== `_fde_e1_wiring_test.mjs` 变异验证（目标 = 部署副本）==')
lines.push('')
lines.push('-- 基线（无变异）--')
let exitCode = 0
try {
  const base = runTest()
  if (!base.complete || base.reds.size > 0) {
    lines.push(`  ✗ 基线不是全绿：exit=${base.exit} 红=${base.reds.size} 完整=${base.complete}`)
    lines.push('  ⇒ 基线不成立，本轮作废（先修测试再谈变异）')
    exitCode = 2
  } else {
    lines.push(`  ✓ 基线全绿（exit=${base.exit}，报告完整）`)
  }
} catch (e) {
  lines.push(`  ✗ 基线崩溃：${e && e.message}`)
  exitCode = 2
}

if (exitCode === 0) {
  lines.push('')
  for (const m of MUTANTS) {
    const idx = m.file === GATE_INDEX ? 'gate/index.js' : 'phase/index.js'
    lines.push(`-- ${m.id} ${idx}：${m.desc} --`)
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
        lines.push(`  ✓ 期望断言红：「${m.expect}」${others > 0 ? `（另有 ${others} 条红）` : ''}`)
      } else {
        green += 1
        lines.push(`  ✗ 期望断言**没红**：变异未被抓住 ⇒ 该判据对这条缺陷是盲的`)
        lines.push(`      实际红名单：${[...r.reds].map((s) => `「${s}」`).join(' / ') || '（空）'}`)
      }
    } finally {
      // 无条件还原：任何路径（含抛错）都不许把部署副本留在变异态
      copyFileSync(join(BACKUP, bname(m.file)), m.file)
    }
    lines.push('')
  }
}

// ---------------------------------------------------------------- 还原核对
lines.push('-- 还原核对（部署副本）--')
let restored = true
for (const f of targets) {
  const now = sha(f)
  const ok = now === originalSha.get(f)
  if (!ok) restored = false
  lines.push(`  ${ok ? '✓' : '✗'} ${f}`)
  lines.push(`      ${originalSha.get(f)}${ok ? '' : `\n      现已变成 ${now} ⇒ 部署副本被污染，必须手工还原`}`)
}

lines.push('')
lines.push(`红 ${red} / 绿 ${green} / 无效 ${invalid}`)
if (!restored || exitCode === 2) {
  lines.push('RESULT: INVALID（基线不成立或部署副本未还原）')
  if (exitCode === 0) exitCode = 2
} else if (green > 0 || invalid > 0) {
  lines.push('RESULT: FAIL')
  exitCode = 1
} else {
  lines.push('RESULT: PASS（全部变异被期望的具名断言抓住，且部署副本已逐字还原）')
}

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(`[e1-wiring-mut] 结果已写入 ${OUT}：红 ${red} / 绿 ${green} / 无效 ${invalid}`)
process.exitCode = exitCode
