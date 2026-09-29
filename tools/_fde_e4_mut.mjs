/**
 * E4 变异注入 —— 证明 `_fde_e4_test.mjs`（纯函数）与 `_fde_e4_tools_test.mjs`（工具）
 * 的**具名断言**真能抓住各类缺陷。
 *
 * 跑法：node _fde_e4_mut.mjs  ｜ 报告：_fde_e4_mut_out.txt
 *
 * 为什么需要它（本项目纪律）：`FDE_INVERT=1` 只证明"退出码随 failed 变"，那是**结构性敏感**，
 * 不证明任何具体断言有效。要证明断言面有效，必须逐条注入语义变异，并要求**具名断言**抓住它。
 *
 * 三类出口：
 *   RED    = 具名断言抓住（合格）
 *   GREEN  = 全绿（不合格，除非已证变异等价）
 *   INVALID= 套件崩了（out.txt 里没有 RESULT 行）—— **崩溃不是证据**
 *
 * 与 E3 版的差异（本文件按 E4 的形状改的两处）：
 *   ① E4 有**两个**套件（stats 纯函数 / tools 工具），故每个变异要指定 `suite`；
 *   ② 本项目 `_fde_e4_*` 套件用的失败标记是 `❌`（E3 用 `✗`）—— 解析器跟着套件走。
 *
 * 安全：每变异前备份到 `_mut/e4/<name>.bak`，启动时若发现残留备份先自愈还原
 * （防 Ctrl-C 半途留下变异代码），收尾逐字还原并核对。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const LIB = join(ROOT, 'dsh-fde-ontology-gate', 'lib')
const BAKDIR = join(ROOT, '_mut', 'e4')
const REPORT = join(ROOT, '_fde_e4_mut_out.txt')

const SUITES = {
  stats: { test: join(ROOT, '_fde_e4_test.mjs'), out: join(ROOT, '_fde_e4_out.txt') },
  tools: { test: join(ROOT, '_fde_e4_tools_test.mjs'), out: join(ROOT, '_fde_e4_tools_out.txt') }
}

const FILES = ['shadow-stats.js', 'shadow-tools.js']
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
 *
 * 分组按"错在哪一类判断上"，覆盖两个方向：
 *   ① 准入判据（该拦的没拦）② 缺席分档（把"读不到"说成"没有"）③ 逃生方向（该放行的拦了）
 *   ④ 闸门顺序与 R2（逐条确认的语义被削弱）
 */
const MUTANTS = [
  // ── ① 准入/推翻两个阈值的边界（严格 vs 非严格）──
  {
    id: 'M1', suite: 'stats', file: 'shadow-stats.js',
    from: 'const admitOk = rated > 0 && agree * 100 > ADMIT_PCT * rated',
    to: 'const admitOk = rated > 0 && agree * 100 >= ADMIT_PCT * rated',
    why: '准入从"严格大于"放宽成"≥" ⇒ 恰好 80% 会被放行（spec 写的是 > 80%）'
  },
  {
    id: 'M2', suite: 'stats', file: 'shadow-stats.js',
    from: 'const overturnHit = rated > 0 && agree * 100 < OVERTURN_PCT * rated',
    to: 'const overturnHit = rated > 0 && agree * 100 <= OVERTURN_PCT * rated',
    why: '推翻线从"严格小于"放宽成"≤" ⇒ 恰好 70% 被误判为门禁不成熟'
  },
  {
    id: 'M3', suite: 'stats', file: 'shadow-stats.js',
    from: 'const windowOk = spanMs >= WINDOW_MS',
    to: 'const windowOk = spanMs > WINDOW_MS',
    why: '窗口从"≥7 天"收紧成">7 天" ⇒ 恰好 7 天被误判为不达标'
  },
  {
    id: 'M4', suite: 'stats', file: 'shadow-stats.js',
    from: 'const accuracyPct = rated === 0 ? null : (agree * 100) / rated',
    to: 'const accuracyPct = rated === 0 ? 0 : (agree * 100) / rated',
    why: '无样本时准确率报 0（会被读成"准确率 0%"而不是"没有数据"）'
  },
  {
    id: 'M5', suite: 'stats', file: 'shadow-stats.js',
    from: "else if (admitOk && windowOk && pending === 0 && anomalies === 0) verdict = 'ready'",
    to: "else if (admitOk && windowOk) verdict = 'ready'",
    why: 'ready 不再要求"全部确认 + 链无异常" ⇒ 有未标注项也能切'
  },

  // ── ② 缺席分档 ──
  {
    id: 'M6', suite: 'stats', file: 'shadow-stats.js',
    from: "if (opts.readError) verdict = 'unreadable'",
    to: "if (opts.readError) verdict = 'no-data'",
    why: '把"链读不到"压成"没有样本"（缺席第三层）—— 读者会得出完全错误的结论'
  },
  {
    id: 'M7', suite: 'tools', file: 'shadow-stats.js',
    from: 'return { ok: false, reason: \'enoent\', error: `审计链文件不存在：${chainPath}` }',
    to: 'return { ok: true, records: [], badLines: 0, bytes: 0 }',
    why: '文件不存在时返回"空链"⇒ 同样是分档失效'
  },
  {
    id: 'M8', suite: 'tools', file: 'shadow-stats.js',
    from: '      badLines++',
    to: '      void 0',
    why: '坏行不计数 ⇒ 链上坏行静默吞掉样本'
  },
  {
    id: 'M9', suite: 'tools', file: 'shadow-stats.js',
    from: '  for (const r of Array.isArray(records) ? records : []) {',
    to: '  for (const r of records) {',
    why: '去掉非数组防御 ⇒ 读不到链时判据函数崩溃、整份报告消失'
  },

  // ── ③ 标注的归并语义 ──
  {
    id: 'M10', suite: 'stats', file: 'shadow-stats.js',
    from: '    if (byRef.has(j.refSeq)) {\n      duplicateJudged++\n      continue\n    }',
    to: '    if (byRef.has(j.refSeq)) {\n      duplicateJudged++\n    }',
    why: '重复确认不再"取第一条"而是"取最后一条" ⇒ append-only 的既成结论被改判'
  },
  {
    id: 'M11', suite: 'stats', file: 'shadow-stats.js',
    from: '    if (!seqs.has(refSeq)) {\n      orphanJudged++\n      continue\n    }',
    to: '    if (!seqs.has(refSeq)) {\n      orphanJudged++\n    }',
    why: '指向不存在样本的确认也计入分子 ⇒ 分子可被无中生有地刷高'
  },
  {
    id: 'M12', suite: 'stats', file: 'shadow-stats.js',
    from: '    if (Number.isFinite(t)) times.push(t)\n    else undated++',
    to: '    if (Number.isFinite(t)) times.push(t)',
    why: '缺 ts 的样本静默不进窗口、也不计数 ⇒ 跨度被悄悄算小'
  },

  // ── ④ attestation 的"最后一条"语义 ──
  {
    // ⚠️ 本条替换过一个**等价变异**：原先写的是把 `s >= bestSeq` 改成 `s > bestSeq`，实测 GREEN。
    //    查清后判为**等价**（不是断言弱）：链是 append-only、seq 递增，`>` 与 `>=` 在这种链上
    //    选出同一条记录，只有"数组顺序与 seq 相反"才分叉。⇒ 换成真·语义弱化：
    //    把"最后一条是批准"降级成"**存在过**一条批准"。
    id: 'M13', suite: 'tools', file: 'shadow-stats.js',
    from: "  if (last.to === 'enforce' && last.approved === true) return { attested: true, why: 'approved', record: last }",
    to: "  if (records.some((r) => r.decision === MODE_SWITCH && r.to === 'enforce' && r.approved === true))\n    return { attested: true, why: 'approved', record: last }",
    why: '把"最后一条模式切换是批准"降级成"存在过一条批准" ⇒ 批准后切回 observe，旧批准仍算数'
  },
  {
    id: 'M14', suite: 'tools', file: 'shadow-stats.js',
    from: "  if (last.to === 'observe') return { attested: false, why: 'observe', record: last }",
    to: '',
    why: '切回 observe 不再使旧批准失效（门漏一档）'
  },

  // ── ⑤ 闸门顺序与 R2 ──
  {
    id: 'M15', suite: 'tools', file: 'shadow-tools.js',
    from: '        if (!pre.windowOk) {',
    to: '        if (false && !pre.windowOk) {',
    why: '窗口闸门失效 ⇒ 影子期只有 3 小时也能进逐条确认（并且真的会被批准）'
  },
  {
    id: 'M16', suite: 'tools', file: 'shadow-tools.js',
    from: "          if (outcome !== 'allowed-once' && outcome !== 'rejected') {",
    to: "          if (outcome === 'cancelled') {",
    why: 'unavailable 被当成"同意"⇒ 没有 answerer 时也能把门拧到 enforce'
  },
  {
    id: 'M17', suite: 'tools', file: 'shadow-tools.js',
    from: '        if (pending.length > batch.length) {',
    to: '        if (false) {',
    why: '单次上限失效 ⇒ 未确认完的项被静默跳过（R2 变成空话）'
  },
  {
    id: 'M18', suite: 'tools', file: 'shadow-tools.js',
    from: '        if (!post.ready) {',
    to: '        if (false) {',
    why: '裁决失效 ⇒ 不达标也照批（统计与门脱钩）'
  },
  {
    id: 'M19', suite: 'tools', file: 'shadow-tools.js',
    from: "        if (args.to === 'observe') {",
    to: "        if (false) {",
    why: '逃生方向也被设门 ⇒ 切不回 observe（把门禁变成单向棘轮）'
  },
  {
    id: 'M20', suite: 'tools', file: 'shadow-tools.js',
    from: "          await reject(\n            'SHADOW_STATS_UNAVAILABLE',",
    to: "          await reject(\n            'SHADOW_NO_SAMPLES',",
    why: '"读不到链"被报成"没有样本"（错误码层，调用方按 code 分支会误判）'
  }
]

// ---------------------------------------------------------------- 解析套件输出
function parseOut(text) {
  const resLine = text.split('\n').find((l) => l.startsWith('RESULT:'))
  const names = []
  for (const line of text.split('\n')) {
    const m = /^\s+❌ (.+)$/.exec(line)
    if (m) names.push(m[1].replace(/\s+$/, ''))
  }
  const pass = /PASS (\d+) \/ FAIL (\d+)/.exec(text)
  return { crashed: !resLine, names, pass: pass ? Number(pass[1]) : null, fail: pass ? Number(pass[2]) : null }
}

function runSuite(suite) {
  const s = SUITES[suite]
  // 🔴 **先删产物**：套件崩在写 out.txt 之前时，旧文件仍在磁盘上，
  //    读它会读到**上一轮的 RESULT 行** ⇒ 崩溃被读成"通过"（最坏的一类假绿：
  //    它专门在"被变异弄崩"这个场景下骗人）。删掉之后，"文件不存在"就成了崩溃的证据。
  if (existsSync(s.out)) unlinkSync(s.out)
  const r = spawnSync(process.execPath, [s.test], { cwd: ROOT, encoding: 'utf8' })
  if (!existsSync(s.out)) {
    return { exit: r.status, crashed: true, names: [], pass: null, fail: null, stderr: (r.stderr || '').slice(0, 300) }
  }
  const text = readFileSync(s.out, 'utf8')
  return { exit: r.status, ...parseOut(text), stderr: (r.stderr || '').slice(0, 300) }
}

// ---------------------------------------------------------------- 主流程
const lines = []
let ok = true

// 基线：两个套件都要全绿，否则变异结果不可解释
const bases = {}
for (const k of Object.keys(SUITES)) {
  bases[k] = runSuite(k)
  const b = bases[k]
  lines.push(`[baseline:${k}] EXIT=${b.exit} PASS=${b.pass} FAIL=${b.fail} crashed=${b.crashed}`)
  if (b.exit !== 0 || b.fail !== 0 || b.crashed) {
    lines.push(`  ✗ 基线不是全绿 ⇒ 变异结果不可解释，终止。`)
    ok = false
  }
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
        r = runSuite(m.suite)
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
        `[${m.id}] ${verdict}  【${m.suite}】${m.file}  ${m.why}\n` +
          `      EXIT=${r.exit} PASS=${r.pass} FAIL=${r.fail}` +
          (r.names.length
            ? `\n      抓住它的用例（${r.names.length} 条）：\n` + r.names.map((n) => `        · ${n}`).join('\n')
            : '') +
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
console.log(`[e4-mut] wrote ${REPORT}`)
console.log(lines.filter((l) => l.startsWith('[') || l.startsWith('RESULT') || l.startsWith('变异')).join('\n'))
process.exitCode = ok ? 0 : 1
