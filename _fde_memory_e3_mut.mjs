/**
 * E3 变异注入 —— 证明 `_fde_memory_e3_test.mjs` 的**具名断言**真能抓住各类缺陷。
 *
 * 跑法：node _fde_memory_e3_mut.mjs
 *
 * 为什么需要它（本项目纪律）：`FDE_INVERT=1` 只证明"退出码随 failed 变"，那是**结构性敏感**，
 * 不证明任何具体断言有效。要证明断言面有效，必须逐条注入语义变异，并要求**具名断言**抓住它。
 *
 * 三类出口：
 *   RED    = 具名断言抓住（合格）
 *   GREEN  = 全绿（不合格，除非已证变异等价）
 *   INVALID= 套件崩了（out.txt 里没有 RESULT 行）—— 崩溃不是证据
 *
 * 安全：只改 `dsh-fde-memory/lib/{index.js,tools.js}`；每变异前备份到 `_mut/e3/<name>.bak`，
 * 启动时若发现残留备份先自愈还原（防 Ctrl-C 半途留下变异代码），收尾逐字还原并核对。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const LIB = join(ROOT, 'dsh-fde-memory', 'lib')
const BAKDIR = join(ROOT, '_mut', 'e3')
const TEST = join(ROOT, '_fde_memory_e3_test.mjs')
const OUT = join(ROOT, '_fde_memory_e3_out.txt')
const REPORT = join(ROOT, '_fde_memory_e3_mut_out.txt')

const FILES = ['index.js', 'tools.js']
mkdirSync(BAKDIR, { recursive: true })

// ---------------------------------------------------------------- 自愈
for (const f of FILES) {
  const bak = join(BAKDIR, f + '.bak')
  if (existsSync(bak)) {
    writeFileSync(join(LIB, f), readFileSync(bak, 'utf8'), 'utf8')
    console.log(`[self-heal] ${f} 已从残留备份还原（上次未正常收尾）`)
    unlinkSync(bak)
  }
}

const ORIG = new Map(FILES.map((f) => [f, readFileSync(join(LIB, f), 'utf8')]))
const restoreAll = () => {
  for (const f of FILES) writeFileSync(join(LIB, f), ORIG.get(f), 'utf8')
}
const cleanupBaks = () => {
  for (const f of FILES) {
    const bak = join(BAKDIR, f + '.bak')
    if (existsSync(bak)) unlinkSync(bak)
  }
}

/**
 * 变异清单。`from` 必须在文件里**恰好出现一次**（脚本断言，防止改错地方）。
 * 三组：① 守卫失效（该拒的没拒）② 降级失效（该封的没封）③ 过度封锁（该放行的拒了）
 */
const MUTANTS = [
  // ── ① 守卫失效 ──
  { id: 'M1', file: 'tools.js', from: 'if (!readOnly?.active) return', to: 'return',
    why: '只读守卫失效 ⇒ 迁移失败后写工具照样落盘' },
  { id: 'M2', file: 'tools.js', from: "          assertWritable('写入决策')", to: '',
    why: 'write_decision 少了守卫（另两个写工具仍有 ⇒ 只有具名断言能分辨）' },
  { id: 'M3', file: 'tools.js', from: "          assertWritable('逐条确认')", to: '',
    why: 'confirm 少了守卫（R2 不可逆层在只读期被写穿）' },
  { id: 'M4', file: 'tools.js', from: "          assertWritable('复核 note')", to: '',
    why: 'review 少了守卫' },
  { id: 'M5', file: 'tools.js', from: "'MEMORY_SCHEMA_READ_ONLY'", to: "'MEMORY_READ_ONLY_RENAMED'",
    why: '错误码被改名 ⇒ 调用方按 code 分支会失效（静默，不报错的那种坏）' },

  // ── ② 降级失效 ──
  { id: 'M6', file: 'index.js',
    from: 'const readOnly = sv.status === \'failed\' ? { active: true, error: sv.error, from: sv.from } : null',
    to: 'const readOnly = null',
    why: '迁移失败不再置只读（等于退回旧行为：读写在，只是没标记）' },
  { id: 'M7', file: 'index.js', from: '  // 2) 幂等建目录骨架',
    to: '  if (sv.status === \'failed\') throw new Error(\'回归旧行为：迁移失败即抛\')\n  // 2) 幂等建目录骨架',
    why: '迁移失败又 throw ⇒ 插件整体不加载、连读也没了（spec 要修的就是这条）' },
  { id: 'M8', file: 'index.js', from: "type: 'schema-readonly',", to: "type: 'schema-readonly-typo',",
    why: '降只读不留痕 ⇒「系统何时开始只读」成了静默点' },
  { id: 'M9', file: 'index.js', from: 'current: SCHEMA_CURRENT,', to: 'current: sv.from,',
    why: '审计里 current 写成磁盘版本 ⇒ from===current，读不出卡在哪' },
  { id: 'M10', file: 'index.js', from: 'log.warn?.(', to: 'void 0 && log.warn?.(',
    why: '只读降级改成静默（无 warn）' },
  { id: 'M11', file: 'index.js', from: "(readOnly ? '，🔴 只读模式（写入已封、读取照常）' : '')", to: "''",
    why: 'info 汇总行不再标只读 ⇒ 只翻 info 的人看不到' },

  // ── ③ 过度封锁（另一方向：该放行的拒了）──
  { id: 'M12', file: 'tools.js', from: 'return { text: buildContext(cfg, phase, new Date()) }',
    to: "assertWritable('读取'); return { text: buildContext(cfg, phase, new Date()) }",
    why: '读工具也被只读守卫拦 ⇒ 数据扣人质（正是 spec 要消灭的形态）' }
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
  return { crashed: !resLine, names, pass: pass ? Number(pass[1]) : null, fail: pass ? Number(pass[2]) : null }
}

function runSuite() {
  // 🔴 **先删产物**（2026-09-29 修）：套件崩在写 out.txt 之前时，旧文件仍在磁盘上，
  //    读它会读到**上一轮的 RESULT 行**。后果比"缺判据"更坏 —— 上一轮是绿的，
  //    于是 `crashed=false` + `names.length===0` + `exit!==0` 正好落进
  //    `r.exit === 0 || r.names.length === 0` 的 GREEN 分支 ⇒ **崩溃被读成"变异等价"**。
  //    这类假绿专门在"被变异弄崩"这个场景下骗人。删掉之后，"文件不存在"就是崩溃的证据。
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

const afterRestore = FILES.every((f) => readFileSync(join(LIB, f), 'utf8') === ORIG.get(f))
lines.push('')
lines.push(`还原核对：${afterRestore ? '源码已逐字还原' : '✗ 还原失败（源码仍是变异态！）'}`)
if (!afterRestore) ok = false

const red = lines.filter((l) => l.includes('] RED')).length
lines.push('')
lines.push(
  `变异 ${MUTANTS.length} 条：RED ${red} / GREEN ${lines.filter((l) => l.includes('] GREEN')).length} / INVALID ${lines.filter((l) => l.includes('] INVALID')).length}`
)
lines.push('RESULT: ' + (ok ? 'ALL-MUTANTS-CAUGHT' : 'FAIL'))

writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8')
console.log(`[e3-mut] wrote ${REPORT}`)
console.log(lines.filter((l) => l.startsWith('[') || l.startsWith('RESULT') || l.startsWith('变异')).join('\n'))
process.exitCode = ok ? 0 : 1
