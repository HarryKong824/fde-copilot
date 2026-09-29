/**
 * E1 变异注入 —— 证明 `_fde_e1_test.mjs`（离线逻辑）与 `_fde_e1_crosspkg_test.mjs`
 * （跨包逐字副本）的**具名断言**真能抓住各类缺陷。
 *
 * 跑法：node _fde_e1_mut.mjs  ｜ 报告：_fde_e1_mut_out.txt
 *
 * 为什么需要它（本项目纪律）：`FDE_INVERT=1` 只证明"退出码随 failed 变"——那是**结构性敏感**，
 * 不证明任何具体断言有效。要证明断言面有效，必须**逐条注入语义变异**，并要求**具名断言**抓住。
 *
 * 三类出口（有效变异只有三种结局）：
 *   RED    = 具名断言抓住（合格）
 *   GREEN  = 全绿（不合格，**除非**已证明该变异在语义上等价）
 *   INVALID= 套件崩了 / 锚点没命中 / 锚点不唯一（**崩溃与没改到都不是证据**，本轮作废）
 *
 * 变异注入前过两关（本项目既有纪律）：
 *   ① **类型/结构仍成立** —— 不能让套件因为 TypeError 崩掉（那就成了"结构性红"）
 *   ② **语义真不等价** —— 例如把 `>=` 改成 `>` 若在被测数据上恒取同值，就是等价变异
 *
 * 安全：每变异前备份到 `_mut/e1/<name>.bak`，启动时若发现残留备份先自愈还原
 * （防 Ctrl-C 半途留下变异代码），收尾逐字还原并核对 sha256。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const BAKDIR = join(ROOT, '_mut', 'e1')
const REPORT = join(ROOT, '_fde_e1_mut_out.txt')

const SUITES = {
  e1: { test: join(ROOT, '_fde_e1_test.mjs'), out: join(ROOT, '_e1_test_out.txt') },
  xpkg: { test: join(ROOT, '_fde_e1_crosspkg_test.mjs'), out: join(ROOT, '_e1_crosspkg_out.txt') }
}

const P = 'dsh-fde-phase/lib/'
const G = 'dsh-fde-ontology-gate/lib/'

/**
 * 变异清单。`from` 必须在目标文件里**恰好出现一次**（脚本断言，防止改错地方）。
 *
 * 分组按"错在哪一类判断上"：
 *   ① 放行表的准入与失效   ② 闸门顺序与方向   ③ 留痕的如实性   ④ 跨包漂移
 */
const MUTANTS = [
  // ── ① 放行表：准入 / 失效 / 短路 ──
  {
    id: 'M1', suite: 'e1', file: P + 'bg-mirror.js',
    from: '    if (!BYPASSABLE_DENY_IDS.includes(denyId)) return false',
    to: '    if (false) return false',
    why: '不可绕的 id 短路失效 ⇒ 只要表里出现 GATE-PTC/RULE-*，消费侧就放行（工具 enum 成了唯一屏障）'
  },
  {
    id: 'M2', suite: 'e1', file: P + 'bg-mirror.js',
    from: "      if (r.status !== 'open') continue",
    to: '      if (false) continue',
    why: '不看状态 ⇒ 已补正的记录仍然放行（补正变成一句空话）'
  },
  {
    // 🔴 本变异改过**两版**，前两版实测都 **GREEN** —— 两次都是**变异自身是空操作**，
    //    不是断言弱。过程存档在报告末尾的"已证等价"一节，这里留结论：
    //      · 只删第一行（`r.anchor === ''` 那档）：被第三行的 `cur === ''` 那档兜住；
    //      · 只删第三行（`cur === ''` 那档）：被第一行的 `r.anchor === ''` 那档兜住。
    //    ⇒ 两行在"anchor==='' 且 cur===''"这一点上**互为冗余**（纵深防御），
    //      任何只删一行的变异都必然全绿。**必须两档一起删**才是真不等价。
    id: 'M3', suite: 'e1', file: P + 'bg-mirror.js',
    from: [
      "        if (typeof r.anchor !== 'string' || r.anchor === '') return false",
      '        let cur = null',
      '        try {',
      '          cur = typeof anchorFn === \'function\' ? anchorFn(denyId) : null',
      '        } catch {',
      '          return false',
      '        }',
      "        if (typeof cur !== 'string' || cur === '' || cur !== r.anchor) return false"
    ].join('\n'),
    to: [
      '        if (false) return false',
      '        let cur = null',
      '        try {',
      '          cur = typeof anchorFn === \'function\' ? anchorFn(denyId) : null',
      '        } catch {',
      '          return false',
      '        }',
      '        if (cur !== r.anchor) return false'
    ].join('\n'),
    why: '两档锚点守卫一起失效 ⇒ anchor 为 null/空串的记录只要"算出来的也是 null/空串"就直接放行 —— 等于给"没有锚点"发通配通行证'
  },
  {
    id: 'M4', suite: 'e1', file: P + 'bg-mirror.js',
    from: '    if (payload.resolved === true) {',
    to: '    if (payload.denyId && payload.resolved === true) {',
    why: 'resolved 分支也要求 denyId ⇒ 补正广播（只带 id）静默不生效，镜像永远 open'
  },
  {
    id: 'M5', suite: 'e1', file: P + 'bg-mirror.js',
    from: '      const t = Date.parse(r.expiresAt)\n      return Number.isFinite(t) && nowMs > t',
    to: '      return false',
    why: '超期永不判定 ⇒ R7 的红色警告与指标永远为零'
  },
  {
    id: 'M6', suite: 'e1', file: P + 'bg-mirror.js',
    from: "              cur.status = 'resolved'",
    to: '              void 0',
    why: '重启恢复时忽略 resolved ⇒ 已补正的放行在重启后**复活**'
  },
  {
    id: 'M7', suite: 'e1', file: P + 'deny-ids.js',
    from: "  'GATE-PATH'\n])",
    to: "  'GATE-PATH',\n  'GATE-PTC'\n])",
    why: '把部署级通道开关（PTC）也做成可绕 ⇒ 等于把"关掉 PTC 策略"伪装成一次紧急绕过'
  },

  // ── ② 闸门顺序与方向 ──
  {
    id: 'M8', suite: 'e1', file: P + 'break-glass-tool.js',
    from: '        if (!BYPASSABLE_DENY_IDS.includes(denyId)) {',
    to: '        if (false) {',
    why: 'id 白名单失效 ⇒ 模型可以绕流程规则（跳跃推进等），那是新开一个洞'
  },
  {
    id: 'M9', suite: 'e1', file: P + 'break-glass-tool.js',
    from: '          if (failures.length === 0) {',
    to: '          if (false) {',
    why: '纵深防御失效 ⇒ 门禁**没在拦**时也能砸玻璃（预先给未来所有调用发通行证）'
  },
  {
    id: 'M10', suite: 'e1', file: P + 'break-glass-tool.js',
    from: "        if (outcome !== 'allowed-once') {",
    to: "        if (outcome === 'rejected') {",
    why: 'unavailable / cancelled 被当成同意 ⇒ 没有 answerer 时也能绕过门禁（逃生门方向反了）'
  },
  {
    id: 'M11', suite: 'e1', file: P + 'break-glass-tool.js',
    from: '        if (!prev.ok) {',
    to: '        if (false) {',
    why: '表损坏时不再拒绝 ⇒ 用空表覆盖坏证据（无痕绕过，且毁掉原始证据）'
  },

  // ── ③ 留痕的如实性 ──
  {
    id: 'M12', suite: 'e1', file: P + 'audit-listener.js',
    from: '          callAllowed: !willDeny,',
    to: '          callAllowed: true,',
    why: '放行没换来成功推进（别的检查仍拦）却记成"生效" ⇒ E5 指标虚高'
  },
  {
    id: 'M13', suite: 'e1', file: P + 'audit-listener.js',
    from: '      bg.update({ id: rid, at, resolved: true })',
    to: '      void 0',
    why: '只改盘与链、不改镜像 ⇒ 盘上已补正、内存里还在放行（分叉）'
  },
  {
    id: 'M14', suite: 'e1', file: P + 'audit-listener.js',
    from: "        ctx.emit('fde/break-glass', { id: rid, at, resolved: true })",
    to: '        void 0',
    why: '补正不广播 ⇒ gate 的镜像永远 open，且**只在重启后才看得出来**'
  },
  {
    id: 'M15', suite: 'e1', file: P + 'audit-listener.js',
    from: '      if (!cur.ok) {',
    to: '      if (false) {',
    why: '读表失败不再中止 ⇒ 用空记录集覆盖，坏证据被抹掉且镜像被错误标为已补正'
  },
  {
    id: 'M16', suite: 'e1', file: G + 'pre-execute.js',
    from: '          callAllowed: enforcing,',
    to: '          callAllowed: true,',
    why: 'shadow 下这条路本来就不拦，却记成"这次放行改变了结果" ⇒ 指标虚高'
  },

  // ── ④ gate 的放行与 denyId ──
  {
    id: 'M17', suite: 'e1', file: G + 'guard.js',
    from: "      denyId: 'GATE-PATH',",
    to: "      denyId: 'GATE-CLASSIFY',",
    why: '路径命中记成分类失败 ⇒ 砸了 GATE-PATH 的玻璃却放行了 GATE-CLASSIFY（串台）'
  },
  {
    id: 'M18', suite: 'e1', file: G + 'guard.js',
    from: '  if (bg && bg.isBypassed(res.denyId)) {',
    to: '  if (false) {',
    why: 'gate 侧完全不查放行表 ⇒ 逃生门在 gate 上等于不存在'
  },

  // ── ⑤ 跨包漂移（只动一份）──
  {
    id: 'M19', suite: 'xpkg', file: G + 'deny-ids.js',
    from: "  'GATE-PATH'\n])",
    to: "  'GATE-PATH',\n  'D9'\n])",
    why: '只改 gate 那一份 ⇒ 逐字对拍必须红（否则"两份必须一致"只是一句话）'
  },
  {
    id: 'M20', suite: 'xpkg', file: P + 'bg-mirror.js',
    from: '      if (r.denyId !== denyId) continue',
    to: '      if (false) continue',
    why: '只改 phase 那一份的实现 ⇒ sha256 对拍必须红（证明对拍管的是内容而非行为抽查）'
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
  const cnt = /通过 (\d+) \/ 失败 (\d+)/.exec(text)
  return { crashed: !resLine, names, pass: cnt ? Number(cnt[1]) : null, fail: cnt ? Number(cnt[2]) : null }
}

function runSuite(suite) {
  const s = SUITES[suite]
  // 🔴 **先删产物**：套件崩在写 out.txt 之前时，旧文件仍在磁盘上，读它会读到**上一轮的 RESULT 行**
  //    ⇒ 崩溃被读成"通过"（最坏的一类假绿：它专门在"被变异弄崩"这个场景下骗人）。
  //    删掉之后，"文件不存在"就成了崩溃的证据。
  if (existsSync(s.out)) unlinkSync(s.out)
  const r = spawnSync(process.execPath, [s.test], { cwd: ROOT, encoding: 'utf8' })
  if (!existsSync(s.out)) {
    return { exit: r.status, crashed: true, names: [], pass: null, fail: null, stderr: (r.stderr || '').slice(0, 400) }
  }
  return { exit: r.status, ...parseOut(readFileSync(s.out, 'utf8')), stderr: (r.stderr || '').slice(0, 400) }
}

// ---------------------------------------------------------------- 自愈 + 备份
const FILES = [...new Set(MUTANTS.map((m) => m.file))]
mkdirSync(BAKDIR, { recursive: true })
const bakOf = (f) => join(BAKDIR, f.replace(/[\\/]/g, '__') + '.bak')

for (const f of FILES) {
  const bak = bakOf(f)
  if (existsSync(bak)) {
    writeFileSync(join(ROOT, f), readFileSync(bak, 'utf8'), 'utf8')
    console.log(`[self-heal] ${f} 已从残留备份还原（上次未正常收尾）`)
    unlinkSync(bak)
  }
}

const sha = (f) => createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex')
const ORIG = new Map(FILES.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]))
const ORIG_SHA = new Map(FILES.map((f) => [f, sha(f)]))
const restoreAll = () => {
  for (const f of FILES) writeFileSync(join(ROOT, f), ORIG.get(f), 'utf8')
}
const cleanupBaks = () => {
  for (const f of FILES) {
    const bak = bakOf(f)
    if (existsSync(bak)) unlinkSync(bak)
  }
}

// ---------------------------------------------------------------- 主流程
const lines = []
let ok = true
let red = 0
let green = 0
let invalid = 0

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
lines.push('')

/** 每个变异**期望被抓它的那条具名断言**（子串匹配；写全名太长，用唯一可辨的片段）。 */
const EXPECT = {
  M1: '不可绕的 id',
  M2: 'resolved 分支**只认 id**',
  M3: '记录 anchor 是空**串**',
  M4: 'resolved 分支**只认 id**',
  M5: '超期不撤销放行',
  M6: 'open → resolved 顺序',
  M7: 'BYPASSABLE 恰为 6 个',
  M8: '闸门 1',
  M9: '闸门 4',
  M10: '闸门 5：approval 返回 unavailable',
  M11: '记录表已损坏',
  M12: '仍被别的检查拦住',
  M13: '自动补正：文件 + 镜像 + 链三处同改',
  M14: '自动补正会广播 resolved',
  M15: '补正时**文件写失败**',
  M16: 'shadow 模式下放行',
  M17: 'evaluateRules 给出三个 denyId',
  M18: 'GATE-PATH 有 open',
  M19: 'sha256 逐字相同：deny-ids.js',
  M20: 'sha256 逐字相同：bg-mirror.js'
}

if (ok) {
  try {
    for (const m of MUTANTS) {
      const path = join(ROOT, m.file)
      const src = ORIG.get(m.file)
      const hits = src.split(m.from).length - 1
      if (hits !== 1) {
        lines.push(`[${m.id}] INVALID —— 锚点在 ${m.file} 里出现 ${hits} 次（要求恰好 1 次）⇒ 本轮作废`)
        invalid += 1
        continue
      }
      writeFileSync(bakOf(m.file), src, 'utf8')
      writeFileSync(path, src.replace(m.from, m.to), 'utf8')

      let r
      try {
        r = runSuite(m.suite)
      } finally {
        writeFileSync(path, src, 'utf8') // 每轮立即还原，避免中途 Ctrl-C 留下变异代码
        const bak = bakOf(m.file)
        if (existsSync(bak)) unlinkSync(bak)
      }

      const want = EXPECT[m.id]
      const caught = r.names.some((n) => n.includes(want))

      if (r.crashed) {
        lines.push(`[${m.id}] INVALID —— 套件崩了（不是证据）。stderr: ${r.stderr.split('\n')[0] ?? ''}`)
        lines.push(`      变异：${m.why}`)
        invalid += 1
      } else if (caught) {
        lines.push(`[${m.id}] RED ✅ 被「${r.names.find((n) => n.includes(want))}」抓住（本套件红 ${r.fail} 条）`)
        lines.push(`      变异：${m.why}`)
        red += 1
      } else if (r.fail > 0) {
        lines.push(`[${m.id}] INVALID —— 有 ${r.fail} 条红，但**没有**期望的具名断言「${want}」`)
        lines.push(`      实际红的：${JSON.stringify(r.names)}`)
        lines.push(`      变异：${m.why}`)
        invalid += 1
      } else {
        lines.push(`[${m.id}] GREEN ⚠️ 全绿 —— 该变异未被任何断言覆盖（除非能证明它语义等价，否则是真缺口）`)
        lines.push(`      变异：${m.why}`)
        green += 1
      }
      lines.push('')
    }
  } finally {
    restoreAll()
    cleanupBaks()
  }
}

// ---------------------------------------------------------------- 还原核对
let restored = true
for (const f of FILES) {
  if (sha(f) !== ORIG_SHA.get(f)) {
    restored = false
    lines.push(`✗ 还原失败：${f}`)
  }
}
lines.push(`[还原核对] ${restored ? '✅ 全部源文件 sha256 与变异前逐字一致' : '❌ 有文件未还原'}`)
lines.push(`[计数] RED=${red}  GREEN=${green}  INVALID=${invalid}  共 ${MUTANTS.length}`)
lines.push('')

const verdict = ok && restored && green === 0 && invalid === 0 && red === MUTANTS.length
lines.push(verdict ? 'RESULT: PASS（全部变异被具名断言抓住）' : 'RESULT: FAIL')
lines.push('')

// ---------------------------------------------------------------- 已证等价的变异（存档，不再注入）
lines.push('[已证等价、故未纳入的变异（存档）]')
lines.push('  M3 的前两版都实测 GREEN，**两次都是变异自身是空操作，不是断言弱**：')
lines.push('  · v1：`if (typeof cur !== \'string\' || cur === \'\' || cur !== r.anchor) return false`')
lines.push('        → `if (cur !== r.anchor) return false`')
lines.push('    证明：同一函数上一行已保证 `r.anchor` 是**非空字符串**，故 `cur === r.anchor`')
lines.push('    已蕴含 `typeof cur === \'string\' && cur !== \'\'` ⇒ 前两个 disjunct 永不可能在')
lines.push('    "最终会放行"的那一支上单独成立。')
lines.push('    枚举复核：cur ∈ {null, undefined, "", "a", "b", "deadbeef"} ×')
lines.push('              anchor ∈ {"a", "b", "deadbeef", "0"×64} = 24 组 ⇒ 判定分歧 0。')
lines.push('  · v2：只删第一行 `r.anchor === \'\'` 那一档 → 仍 GREEN。')
lines.push('    证明：**两档互为冗余** —— 要放行必须 `cur === r.anchor`。')
lines.push('      · 若 anchor 非空 ⇒ 第一行不触发；第三行的 `cur !== r.anchor` 已拦。')
lines.push('      · 若 anchor 为空 ⇒ 第三行的 `cur === \'\'`（或 `typeof cur !== \'string\'`）必触发。')
lines.push('    ⇒ 只删任一行都是空操作；**必须两档一起删**。')
lines.push('    ⚠️ 这条冗余是**纵深防御**、不是死代码：它让"将来某天有人只改一处"仍然安全。')
lines.push('  ⇒ 最终 M3 两档一起删（真不等价），并补了断言「记录 anchor 是空**串**、当前也算出空串」。')
writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8')

console.log(`[e1-mut] 报告已写入 ${REPORT}：RED=${red} GREEN=${green} INVALID=${invalid} 还原=${restored}`)
process.exitCode = verdict ? 0 : 1
