/**
 * `_fde_e5_test.mjs` 的**变异验证** —— 证明那 62 条断言真会红，而不是"恰好全绿"。
 *
 * 跑法：`node _fde_e5_mut.mjs`；结果写 `_e5_mut_out.txt`。
 *
 * 变异目标 = 工作区源码 `dsh-fde-ontology-gate/lib/metrics.js`（测试 import 的就是它）。
 * 纪律与 `_fde_e2_mut.mjs` 逐条相同：跑前记 sha256、每条 `finally` 无条件还原、
 * 收尾整体核对，不一致 ⇒ EXIT=2 并显式写出"源码已被污染"。
 *
 * 🔴 判据（每条变异都必须满足，缺任一 ⇒ 本轮作废）：
 *   ① 期望的**具名**断言出现在红名单里；
 *   ② 报告**完整产出**（含 `PASS n / FAIL m` 收尾行）—— 崩溃不是证据：
 *      崩溃会让整份报告消失，与"断言抓住了"看起来都是"没通过"；
 *   ③ 期望断言**没红**时不许改写成"是真缺口"—— 只许报"变异未被抓住"，
 *      并给出实际红名单（那才是可核的事实）。
 *
 * ⚠️ 变异注入前过两关（本项目既有纪律）：① 类型/结构仍成立；② 语义**真不等价**。
 *    改完 `from` 找不到 / 找到多次 ⇒ 无效变异，本轮作废重做，不算红也不算绿。
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '_e5_mut_out.txt')
const TEST = join(HERE, '_fde_e5_test.mjs')
const METRICS = join(HERE, 'dsh-fde-ontology-gate', 'lib', 'metrics.js')
const BACKUP = join(HERE, '_mut', 'e5')

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/**
 * 变异表。`from` 必须在目标文件里**恰好出现一次**。
 *
 * 每一条都对着 `_fde_e5_test.mjs` 里的一条**具名**断言 —— 变异若没被它抓住，
 * 说明那条断言是摆设（"能观测到"≠"会被判红"）。
 */
const MUTANTS = [
  {
    id: 'M1',
    desc: '❌红线 分母为 0 时不报缺席（`den === 0` 判据失效）⇒ 无样本指标会报 0%',
    from: '  if (!Number.isFinite(den) || den === 0) {',
    to: '  if (!Number.isFinite(den) || den === -1) { // MUT M1',
    expect: 'A1b 六项全部 insufficient-data 且 value === null'
  },
  {
    id: 'M2',
    desc: '❌红线 绝对值型指标忽略 hasData ⇒ Phase 停留时长在无数据时报 0 天 + ok（恒真判据）',
    from: '  if (!hasData) {\n    return { value: null, verdict: \'insufficient-data\', confidence: \'absent\', absentReason: dataNote }',
    to: '  if (false) { // MUT M2\n    return { value: null, verdict: \'insufficient-data\', confidence: \'absent\', absentReason: dataNote }',
    expect: 'F3 ★★ Phase 1–4 无可配对段 ⇒ insufficient-data（**不是 0 天 + ok** —— 那是恒真判据）'
  },
  {
    id: 'M3',
    desc: '① 绕过配对不再优先（同一条 deny 既被绕过又有后续写时算"修复"）',
    from: '    if (laterBypass) {\n      bypassed++\n      continue\n    }',
    to: '    if (laterBypass) {\n      bypassed++\n    } // MUT M3: 去掉 continue',
    expect: 'B6 ★ 同一条 deny 既被绕过又有后续写 ⇒ **优先算绕过**（conservative）'
  },
  {
    id: 'M4',
    desc: '① 只读通道也算"修复"（REPAIR_CHANNELS 塞进 fde_ontology_read）',
    from: "export const REPAIR_CHANNELS = Object.freeze(['fde_ontology_write', 'fde_phase_advance'])",
    to: "export const REPAIR_CHANNELS = Object.freeze(['fde_ontology_write', 'fde_phase_advance', 'fde_ontology_read']) // MUT M4",
    expect: 'B4 ★反向 只读通道的 allow **不算**修复（仍 0）'
  },
  {
    id: 'M5',
    desc: '① 修复不论时间方向（allow 在 deny 之前也算）',
    from: '      return rt !== null && rt >= dts\n    })',
    // ⚠️ 替换串**必须含闭合的 `\n    })`** —— 第一版这里只写了半句（把闭合括号丢了），
    //    改完是 **SyntaxError 崩溃**、不是断言红；变异套件正确判成"无效变异"（崩溃不是证据）。
    to: '      return rt !== null // MUT M5: 去掉时间方向\n    })',
    expect: 'B5 ★反向 allow 在 deny **之前** ⇒ 不算修复（时间方向）'
  },
  {
    id: 'M6',
    desc: '② 三类比例的分母把 unknown 也算进去（未知分类稀释比例）',
    from: '  const defectDen = counts.deny_defect + counts.scope_edge + counts.evasion',
    to: '  const defectDen = den // MUT M6: 含 unknown',
    expect: 'C4 ★未知 category 进 unknown 桶且**不计入**三类分母'
  },
  {
    id: 'M7',
    desc: '② 推翻判据用 `>=`（恰好 20% 也推翻 —— 与 spec 的 "> 20%" 相反）',
    from: '    defectDen > 0 && counts.deny_defect * 100 > OVERTURN.denyDefectPct * defectDen,',
    to: '    defectDen > 0 && counts.deny_defect * 100 >= OVERTURN.denyDefectPct * defectDen, // MUT M7',
    expect: 'C2b ★边界 恰好 20% **不**触发推翻（spec 写的是 > 20%）'
  },
  {
    id: 'M8',
    desc: '② gate 链的同事件镜像也数一遍（重复计数）',
    from: "  const opens = recs.filter((r) => r && r.type === 'break-glass')",
    to: "  const opens = recs.filter((r) => r && r.type === 'break-glass').concat((Array.isArray(opts.gateRecords) ? opts.gateRecords : []).filter((r) => r && r.type === 'break-glass')) // MUT M8",
    expect: 'C5 ★gate 链的同事件镜像**不计入**（否则重复计数）'
  },
  {
    id: 'M9',
    desc: '③ 平均的分母换成"有变更的 Phase 数"⇒ 零变更时报"无数据"而不是 0',
    from: '  const den = rows.length',
    to: '  const den = rows.filter((r) => r.l0 + r.l1 + r.l2 + r.noLevel > 0).length // MUT M9',
    expect: 'D2 ★ 有 Phase 段但零变更 ⇒ 报 0 + ok（**不是** insufficient-data；分母是 Phase 段数）'
  },
  {
    id: 'M10',
    desc: '③ 没有 level 字段的 ontology 写入被静默丢弃（真链 seq 4/5 的形态）',
    from: '    else b.noLevel++ // 无 level 字段：**计数并报出**，但不计入 L0+L1（判不出级别就不许猜）',
    to: '    else { /* MUT M10: 静默丢弃 */ }',
    expect: 'D5 ★★ 无 level 的写入**不静默丢**：单列 noLevel、不计入、note 给出上界'
  },
  {
    id: 'M11',
    desc: '③ Phase 4 缺席时报 0 而不是 null（"没走到"被说成"走了但零变更"）',
    // ⚠️ 第一版这条变异是**等价变异**（实测全绿）：它改的是 `perPhase` 播种时的初值，
    //    而播种循环随后会用 `cur.truncated || s.truncated` 覆盖它 ⇒ 语义没变。
    //    等价变异**不是"没抓住"**，是本轮作废 —— 换成直接打在 D6 判据量上的变异。
    from: '  const p4l0l1 = p4 ? p4.l0 + p4.l1 : null',
    to: '  const p4l0l1 = p4 ? p4.l0 + p4.l1 : 0 // MUT M11',
    expect: 'D6 ★ Phase 4 缺席 ⇒ phase4L0L1 === null 且 note 写明"未被评估"'
  },
  {
    id: 'M12',
    desc: '④ rejected 被当成"跳过"（把认真回答的项污名化）',
    from: "  effective: Object.freeze(['confirmed', 'rejected'])",
    to: "  effective: Object.freeze(['confirmed']) // MUT M12: rejected 掉出有效档",
    expect: 'E2b ★ rejected **不算跳过**（它是有效结论）且仍在分母里'
  },
  {
    id: 'M13',
    desc: '④ 跳过率的分母剔掉"其它档"（失败档被排除 ⇒ 分母变小、比例虚高）',
    from: '  const den = asks.length',
    to: '  const den = buckets.skipped + buckets.effective // MUT M13',
    expect: 'E3 ★ write-failed 单列（既非跳过也非有效）且**在分母里**'
  },
  {
    id: 'M14',
    desc: '④ 推翻判据用 `>=`（恰好 30% 也推翻）',
    from: '    den > 0 && buckets.skipped * 100 > OVERTURN.askSkipPct * den,',
    to: '    den > 0 && buckets.skipped * 100 >= OVERTURN.askSkipPct * den, // MUT M14',
    expect: 'E4b ★边界 恰好 30% **不**推翻'
  },
  {
    id: 'M15',
    desc: '⑤ 推进不连续时照样配对（跳号段被臆造成一段停留）',
    from: '    if (dated[i - 1].to !== dated[i].from) {\n      unpaired++ // 不连续：判不出这段停留属于谁\n      continue\n    }',
    to: '    if (false) { // MUT M15\n      unpaired++\n      continue\n    }',
    expect: 'F3b 跳号段被丢弃并计数'
  },
  {
    id: 'M16',
    desc: '⑤ 推翻判据用 `>=`（恰好 15 天也推翻）',
    from: '    has14 && sum14 > OVERTURN.dwell14Days,',
    to: '    has14 && sum14 >= OVERTURN.dwell14Days, // MUT M16',
    expect: 'F4 ★边界 Phase 1–4 合计恰好 15 天 ⇒ 不推翻'
  },
  {
    id: 'M17',
    desc: '⑥ 影子准确率缺席判据退回历史 bug 形态（rated 缺失时产出"ok 却没有值"）',
    // ⚠️ 第一版只改 `ratedOk` 一行是**等价变异**（实测全绿）：后面那道
    //    `typeof s.accuracyPct !== 'number'` 守卫仍然把 `{}` 判成缺席 ⇒ 语义没变。
    //    要打中 G1 必须把**整段**缺席判据退回到那个真出过 bug 的形态
    //    （`s.rated === 0` 对 `undefined` 为假）。
    from:
      '  const absent =\n' +
      "    !ratedOk ||\n" +
      "    typeof s.accuracyPct !== 'number' ||\n" +
      '    !Number.isFinite(s.accuracyPct) ||\n' +
      "    s.verdict === 'unreadable' ||\n" +
      "    s.verdict === 'no-data'",
    to:
      '  const absent = // MUT M17: 退回 `rated === 0`（undefined 时为假 ⇒ 产出 ok+null）\n' +
      "    s.rated === 0 || s.verdict === 'unreadable' || s.verdict === 'no-data'",
    expect: 'G1 空 stats ⇒ insufficient-data'
  },
  {
    id: 'M18',
    desc: '⑥ 影子准确率改成自己重算（不再转调 shadow-stats 的权威值）',
    from: '    value: absent ? null : (s.accuracyPct ?? null),',
    to: "    value: absent ? null : 42, // MUT M18: 自造一个值",
    expect: 'G3 ★ value 原样来自 shadow-stats（证明是转调不是重算）'
  },
  {
    id: 'M19',
    desc: '红线在**呈现层**失守：无数据显示成 0.0%（报告里看不出是缺席）',
    from: "  if (m.value === null) return `—（${m.buckets.absentReason ?? '无样本，不报 0%'}）`",
    to: "  if (m.value === null) return '0.0%' // MUT M19",
    expect: 'H5 message 里没有人话形式的 0.0%（红线在呈现层也成立）'
  },
  {
    id: 'M20',
    desc: '总判决把 no-data 当成 ok（一个绿色总判决掩盖"六项全无数据"）',
    from: "    verdict: overturns.length > 0 ? 'overturn' : insufficient.length === metrics.length ? 'no-data' : 'ok'",
    to: "    verdict: overturns.length > 0 ? 'overturn' : 'ok' // MUT M20",
    expect: 'A3 空输入总判决 = no-data，不是 ok'
  },
  {
    id: 'M21',
    desc: '⑤ 链尾字段改回 `inProgress` —— 字段名重新变成"现在正处在这个阶段"的断言',
    // F5b 是**双向**判据（必须不含旧名 + 必须含权威声明），这条打的是第一半。
    from: '      chainTail: chainTail ? { phase: chainTail.phase, days: Number((chainTail.ms / DAY_MS).toFixed(3)) } : null,',
    to: '      inProgress: chainTail ? { phase: chainTail.phase, days: Number((chainTail.ms / DAY_MS).toFixed(3)) } : null, // MUT M21',
    expect: 'F5b ★★ 链尾字段**必须不叫** inProgress，且 note 必须声明它不是权威（含"权威是 state.yaml"）'
  },
  {
    id: 'M22',
    desc: '⑤ note 里丢掉"权威是 state.yaml"这句 ⇒ 读者会以为链尾就是当前 Phase',
    // F5b 的第二半。少了这条，即使字段名改了，note 也不再劝阻误读。
    from: '—— 权威是 state.yaml 的 current_phase；',
    to: '—— （MUT M22：删掉权威声明）；',
    expect: 'F5b ★★ 链尾字段**必须不叫** inProgress，且 note 必须声明它不是权威（含"权威是 state.yaml"）'
  }
]

const lines = []
let red = 0
let green = 0
let invalid = 0

/**
 * 跑一次测试，返回 {exit, reds, complete, raw}。
 *
 * ⚠️ 本套件读的是**子进程的 stdout**（`_fde_e5_test.mjs` 直接 console.log），
 *    不是产物文件 —— 测试没有写 out.txt 的约定。`execFileSync` 在非 0 退出时
 *    会把 stdout 挂在 error 对象上，两条路径都要取。
 */
function runTest() {
  let exit = 0
  let raw = ''
  try {
    raw = execFileSync(process.execPath, [TEST], { cwd: HERE, encoding: 'utf8' })
  } catch (e) {
    exit = typeof e.status === 'number' ? e.status : -1
    raw = String(e.stdout ?? '')
  }
  // 🔴 判据必须**从行首**匹配 `FAIL `。第一版写成 `l.includes('FAIL ')` ⇒
  //    把收尾的汇总行 `PASS 62 / FAIL 0` 也当成了失败（红名单 = {"0"}）⇒
  //    基线被误判成"不是全绿"，整套变异**一条都没跑**就作废了。
  //    这正是"我自己的仪器也会撒谎"：解析器把"0 条失败"读成了"一条失败"。
  const reds = new Set(
    raw
      .split('\n')
      .filter((l) => l.trimStart().startsWith('FAIL '))
      .map((l) => l.trim().slice(5).split('  ⇒')[0].trim())
  )
  return { exit, reds, complete: /PASS \d+ \/ FAIL \d+/.test(raw), raw }
}

// ──────────────────────────────────────────────────────────── 备份
mkdirSync(BACKUP, { recursive: true })
const bname = 'metrics.js'
const originalSha = sha(METRICS)
copyFileSync(METRICS, join(BACKUP, bname))

lines.push('== `_fde_e5_test.mjs` 变异验证（目标 = dsh-fde-ontology-gate/lib/metrics.js）==')
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
    lines.push(`-- ${m.id}：${m.desc} --`)
    const src = readFileSync(METRICS, 'utf8')
    const occurrences = src.split(m.from).length - 1
    if (occurrences !== 1) {
      invalid += 1
      lines.push(`  ⚠️ 无效变异：锚点出现 ${occurrences} 次（要求恰好 1 次）⇒ 本轮作废重做`)
      lines.push('')
      continue
    }
    try {
      writeFileSync(METRICS, src.replace(m.from, m.to), 'utf8')
      const r = runTest()
      if (!r.complete) {
        invalid += 1
        lines.push(`  ⚠️ 无效变异：报告未产出（exit=${r.exit}）⇒ 是崩溃不是断言红，本轮作废重做`)
      } else if (r.reds.has(m.expect)) {
        red += 1
        const others = [...r.reds].filter((x) => x !== m.expect).length
        lines.push(
          `  ✓ 期望断言红：「${m.expect}」` +
            `${others > 0 ? `（另有 ${others} 条红：${[...r.reds].filter((x) => x !== m.expect).join(' / ')}）` : ''}` +
            `${r.exit !== 0 ? `，exit=${r.exit}` : '，⚠️ 但 exit=0 ⇒ 退出码没跟着变'}`
        )
      } else {
        green += 1
        lines.push('  ✗ 期望断言**没红**：变异未被抓住 ⇒ 该判据对这条缺陷是盲的')
        lines.push(`      实际红名单：${[...r.reds].map((s) => `「${s}」`).join(' / ') || '（空）'}`)
      }
    } finally {
      // 无条件还原：任何路径（含抛错）都不许把源码留在变异态
      copyFileSync(join(BACKUP, bname), METRICS)
    }
    lines.push('')
  }
}

// ──────────────────────────────────────────────────────────── 还原核对
lines.push('-- 还原核对 --')
const nowSha = sha(METRICS)
const restored = nowSha === originalSha
lines.push(`  ${restored ? '✓' : '✗'} ${METRICS}`)
if (!restored) lines.push(`      ${originalSha}\n      现已变成 ${nowSha} ⇒ 源码被污染，必须手工还原`)

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
console.log(`[e5-mut] 结果已写入 ${OUT}：红 ${red} / 绿 ${green} / 无效 ${invalid}`)
process.exitCode = exitCode
