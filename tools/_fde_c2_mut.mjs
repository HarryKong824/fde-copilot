/**
 * C2 变异注入 —— 证明 `_fde_c2_test.mjs` 的**具名断言**真能抓住各类缺陷。
 *
 * 跑法：
 *   node _fde_c2_mut.mjs
 *
 * 为什么需要它（本项目纪律）：`FDE_INVERT=1` 只证明"退出码随 failed 变"，
 * 那是**结构性敏感**，不证明任何具体断言有效。要证明断言面有效，必须逐条注入
 * 语义变异，并要求**具名断言**（能读出用例名的那种红）抓住它。
 *
 * 三类出口（与既有纪律一致）：
 *   RED    = 具名断言抓住（合格）           —— 记录被抓住的用例名
 *   GREEN  = 全绿（不合格，除非已证变异等价）—— 记录为"未被抓住"，脚本 exit 1
 *   INVALID= 套件崩了（out.txt 里没有 RESULT 行）—— 崩溃不是证据，记 INVALID，脚本 exit 1
 *
 * 安全：每个变异前把原文件备份到 `_mut/c2/<name>.bak`；**脚本启动时若发现残留备份先自愈还原**
 * （防 Ctrl-C 半途留下变异代码）；全部跑完（含异常路径）在 finally 里还原并删除备份。
 * ⚠️ 本脚本只改 `dsh-fde-phase/lib/{change-flow,tools}.js` 两个文件，绝不碰别处。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const LIB = join(ROOT, 'dsh-fde-phase', 'lib')
const BAKDIR = join(ROOT, '_mut', 'c2')
const TEST = join(ROOT, '_fde_c2_test.mjs')
const OUT = join(ROOT, '_fde_c2_out.txt')
const REPORT = join(ROOT, '_fde_c2_mut_out.txt')

const FILES = ['change-flow.js', 'tools.js']

mkdirSync(BAKDIR, { recursive: true })

// ---------------------------------------------------------------- 自愈
// 上次半途中断可能留下变异代码 ⇒ 备份还在就先还原。
for (const f of FILES) {
  const bak = join(BAKDIR, f + '.bak')
  if (existsSync(bak)) {
    writeFileSync(join(LIB, f), readFileSync(bak, 'utf8'), 'utf8')
    console.log(`[self-heal] ${f} 已从残留备份还原（上次未正常收尾）`)
    unlinkSync(bak)
  }
}

const ORIG = new Map(FILES.map((f) => [f, readFileSync(join(LIB, f), 'utf8')]))

function restoreAll() {
  for (const f of FILES) writeFileSync(join(LIB, f), ORIG.get(f), 'utf8')
}
function cleanupBaks() {
  for (const f of FILES) {
    const bak = join(BAKDIR, f + '.bak')
    if (existsSync(bak)) unlinkSync(bak)
  }
}

/**
 * 变异清单。每条：{ id, file, from, to, why, expect }
 * `from` 必须在该文件里**恰好出现一次**（脚本会断言，防止改错地方）。
 */
const MUTANTS = [
  {
    id: 'M1',
    file: 'change-flow.js',
    from: "L1: Object.freeze(['D1', 'D3'])",
    to: "L1: Object.freeze(['D3'])",
    why: 'L1 漏核 D1（规格：L1 必须 D1+D3）'
  },
  {
    id: 'M2',
    file: 'change-flow.js',
    from: "L2: Object.freeze(['D1', 'D3', 'D5'])",
    to: "L2: Object.freeze(['D1', 'D3'])",
    why: 'L2 漏核 D5（受监管变更不再做合规评估）'
  },
  {
    id: 'M3',
    file: 'change-flow.js',
    from: 'NEEDS_APPROVAL = Object.freeze({ L0: false, L1: false, L2: true })',
    to: 'NEEDS_APPROVAL = Object.freeze({ L0: false, L1: false, L2: false })',
    why: 'L2 免外部审批人确认'
  },
  {
    id: 'M4',
    file: 'change-flow.js',
    from: 'check: `unknown-level:${level}`, ok: false',
    to: 'check: `unknown-level:${level}`, ok: true',
    why: '未知级别放行（fail-open，本该不猜即拒）'
  },
  {
    id: 'M5',
    file: 'change-flow.js',
    from: "if (rec.tool !== WRITE_TOOL || rec.decision !== 'allow') continue",
    to: 'if (rec.tool !== WRITE_TOOL) continue',
    why: '把 deny/write-probe 也当成"最近一次变更"'
  },
  {
    id: 'M6',
    file: 'change-flow.js',
    from: "if (typeof rec.level !== 'string' || rec.level.trim() === '') {",
    to: 'if (false) {',
    why: '旧记录无 level 时不再 fail-closed（改为拿 undefined 往下走）'
  },
  {
    id: 'M7',
    file: 'change-flow.js',
    from: 'if (!st.isFile()) {',
    to: 'if (false) {',
    why: 'gateAuditPath 指向目录时误报 no-change（本模块刚修掉的那个真缺陷）'
  },
  {
    id: 'M8',
    file: 'tools.js',
    from: "if (outcome !== 'allowed-once') {",
    to: 'if (false) {',
    why: 'L2 审批不通过（rejected/unavailable）也照样闭环'
  },
  {
    id: 'M9',
    file: 'tools.js',
    from: 'const bad = results.filter((r) => !r.ok)',
    to: 'const bad = []',
    why: '检查未通过也照样闭环（闭环判定失效）'
  }
]

// ---------------------------------------------------------------- 解析套件输出
function parseOut(text) {
  const resLine = text.split('\n').find((l) => l.startsWith('RESULT:'))
  const names = []
  for (const line of text.split('\n')) {
    const m = /^\s+✗ (.+)$/.exec(line)
    if (m) names.push(m[1].replace(/\s+$/, ''))
  }
  const pass = /PASS (\d+) \/ FAIL (\d+)/.exec(text)
  return {
    crashed: !resLine,
    names,
    pass: pass ? Number(pass[1]) : null,
    fail: pass ? Number(pass[2]) : null
  }
}

function runSuite() {
  // 🔴 **先删产物**（2026-09-29 修，与 E4/E3 变异脚本同一处缺陷）：套件崩在写 out.txt
  //    之前时，旧文件仍在磁盘上 ⇒ 读到**上一轮的 RESULT 行**。上一轮是绿的，于是
  //    `crashed=false` + `names.length===0` 正好落进 GREEN 分支 ⇒ **崩溃被读成"变异等价"**。
  //    删掉之后，"文件不存在"就是崩溃的证据。
  if (existsSync(OUT)) unlinkSync(OUT)
  const r = spawnSync(process.execPath, [TEST], { cwd: ROOT, encoding: 'utf8' })
  if (!existsSync(OUT)) {
    return { exit: r.status, crashed: true, names: [], pass: null, fail: null, stderr: (r.stderr || '').slice(0, 500) }
  }
  const text = readFileSync(OUT, 'utf8')
  return { exit: r.status, ...parseOut(text), stderr: (r.stderr || '').slice(0, 500) }
}

// ---------------------------------------------------------------- 主流程
const lines = []
let ok = true

// 基线：未变异时套件必须全绿，否则变异结果无从比较。
const base = runSuite()
lines.push(`[baseline] EXIT=${base.exit} PASS=${base.pass} FAIL=${base.fail} crashed=${base.crashed}`)
if (base.exit !== 0 || base.fail !== 0 || base.crashed) {
  lines.push('  ✗ 基线不是全绿 ⇒ 变异结果不可解释，终止。')
  ok = false
}

if (ok) {
  try {
    for (const m of MUTANTS) {
      const path = join(LIB, m.file)
      const src = ORIG.get(m.file)
      const hits = src.split(m.from).length - 1
      if (hits !== 1) {
        lines.push(`[${m.id}] ✗ 变异锚点在 ${m.file} 里出现 ${hits} 次（要求恰好 1 次）⇒ 本轮作废`)
        ok = false
        continue
      }
      writeFileSync(join(BAKDIR, m.file + '.bak'), src, 'utf8')
      writeFileSync(path, src.replace(m.from, m.to), 'utf8')
      let r
      try {
        r = runSuite()
      } finally {
        restoreAll()
        cleanupBaks()
      }

      let verdict
      if (r.crashed) {
        verdict = 'INVALID'
        ok = false
      } else if (r.exit === 0 || r.names.length === 0) {
        verdict = 'GREEN'
        ok = false
      } else {
        verdict = 'RED'
      }
      lines.push(
        `[${m.id}] ${verdict}  ${m.file}  ${m.why}\n` +
          `      EXIT=${r.exit} PASS=${r.pass} FAIL=${r.fail}` +
          (r.names.length ? `\n      抓住它的用例（${r.names.length} 条）：\n` + r.names.map((n) => `        · ${n}`).join('\n') : '') +
          (r.stderr ? `\n      stderr: ${r.stderr.split('\n')[0]}` : '')
      )
    }
  } finally {
    restoreAll()
    cleanupBaks()
  }
}

// 收尾核对：还原后必须与原始字节一致
const afterRestore = FILES.every((f) => readFileSync(join(LIB, f), 'utf8') === ORIG.get(f))
lines.push('')
lines.push(`还原核对：${afterRestore ? '源码已逐字还原' : '✗ 还原失败（源码仍是变异态！）'}`)
if (!afterRestore) ok = false

const red = lines.filter((l) => l.includes('] RED')).length
lines.push('')
lines.push(`变异 ${MUTANTS.length} 条：RED ${red} / GREEN ${lines.filter((l) => l.includes('] GREEN')).length} / INVALID ${lines.filter((l) => l.includes('] INVALID')).length}`)
lines.push('RESULT: ' + (ok ? 'ALL-MUTANTS-CAUGHT' : 'FAIL'))

writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8')
console.log(`[c2-mut] wrote ${REPORT}`)
console.log(lines.filter((l) => l.startsWith('[') || l.startsWith('RESULT') || l.startsWith('变异')).join('\n'))
process.exitCode = ok ? 0 : 1
