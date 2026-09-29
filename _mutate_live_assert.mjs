/**
 * 临时变异注入器（用完即删）：把当前三件套拷到 /tmp/mut_<id>/，注入一处变异，跑第 18 套，
 * 报告「是否变红」+「红的是具名断言还是 TypeError」。
 *
 * 用法：node _tmp_mutate.mjs <M1|M2|M3|M7>
 */
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const id = process.argv[2]
const FILES = ['_assert_restrict_live.mjs', '_assert_restrict_live_test.mjs', '_tool_surface_check.mjs']

const MUT = {
  // P1-12 的主角：整块删掉「tools 键存在」那条 push
  M1: {
    file: '_assert_restrict_live.mjs',
    from: `  checks.push([
    \`最后一条 header 的 tools 键**存在**（缺席 ⇒ 判红；不再靠 "read 仍在" 间接捕获）\`,
    !!judged && !judged.absent
  ])`,
    to: `  // [M1] 删掉了缺席判红那条`
  },
  // P1-11 ②：删掉「未给 baseline」那条 push
  M2: {
    file: '_assert_restrict_live.mjs',
    from: `      checks.push([
        \`未给 baseline ⇒ 最后一条 header 的 reason ∈ {\${FRESH_REASONS.join(',')}}\` +
          \`（新开会话本就是建会话那条；出现 change/series ⇒ 中途变过，"天生如此"不成立）\`,
        FRESH_REASONS.includes(last?.reason)
      ])`,
    to: `      // [M2] 删掉了未给 baseline 那条`
  },
  // P1-11 ③：给 require 一个内置默认清单（最危险的退化方向）
  M3: {
    file: '_assert_restrict_live.mjs',
    from: `  const require = Array.isArray(o?.require) ? o.require : []`,
    to: `  const require = Array.isArray(o?.require) && o.require.length ? o.require : ['read', 'pwsh']`
  },
  // P2-15 的主角：extractHeaders 只留算好的 tools、把 data 压平（缺席 ⇒ 变 []）
  M7: {
    file: '_assert_restrict_live.mjs',
    from: `    out.push({
      seq: ev.seq ?? r?.seq ?? null,
      reason: ev.data?.reason ?? null,
      data: ev.data ?? {}
    })`,
    to: `    // [M7] 只留算好的 tools，丢掉 data ⇒ 缺席被压成 []
    out.push({
      seq: ev.seq ?? r?.seq ?? null,
      reason: ev.data?.reason ?? null,
      data: { header: { tools: (ev.data?.header?.tools ?? ev.data?.tools ?? []) } }
    })`
  },
  // P1-17：把污染判定整块短路掉（退回"没有 change 就判红"）
  M8: {
    file: '_assert_restrict_live.mjs',
    from: `  if (baselineSeq !== null && after.length > 0 && !after.some((h) => h.reason === 'change')) {`,
    to: `  if (false) { // [M8] 污染判定被短路`
  },
  // P1-18：diffTools 在 tools 缺席时返回"什么都没变"，而不是 null
  M9: {
    file: '_assert_restrict_live.mjs',
    from: `  if (!Array.isArray(A) || !Array.isArray(B)) return null`,
    to: `  if (!Array.isArray(A) || !Array.isArray(B)) return { removed: [], added: [], nFrom: 0, nTo: 0 } // [M9]`
  },
  // P1-13：配对原语退化成恒真（系统性偏绿，正是要防的那一族）
  M10: {
    file: '_assert_restrict_live.mjs',
    from: `  if (!Number.isFinite(a) || !Number.isFinite(h)) return false
  return a < h`,
    to: `  if (!Number.isFinite(a) || !Number.isFinite(h)) return false
  return true // [M10] 恒真 ⇒ 偏绿`
  },
  // P1-13 前置：extractHeaders 把 time 丢了 ⇒ 后面根本无从配对
  M11: {
    file: '_assert_restrict_live.mjs',
    from: `      time: typeof ev.time === 'number' ? ev.time : null,`,
    to: `      time: null, // [M11] 丢了 time`
  },
  // P1-19 主角：把共用块里的**视窗**检查删掉（退回 P1-19 的缺陷：`with` 半边裸奔）
  M12: {
    file: '_assert_restrict_live.mjs',
    from: `    checks.push([
      \`baseline（seq=\${baselineSeq}）在视窗内（首条 seq=\${wKnown ? w.firstSeq : '未知'}；\` +
        \`视窗外 ⇒ "没读到" ≠ "\${expect === 'without' ? '天生没有' : '天生就有'}" ⇒ 判红）\`,
      wKnown && !(baselineSeq < w.firstSeq)
    ])`,
    to: `    // [M12] 视窗检查被删`
  },
  // P1-19 反锁不按方向取反（`with` 也要求 baseline **有** target ⇒ "天生就有"会假绿）
  M13: {
    file: '_assert_restrict_live.mjs',
    from: `      wantBaseHas ? has(base, target) : !has(base, target)`,
    to: `      has(base, target) // [M13] 没按方向取反`
  },
  // P2-18 污染吞红：提示函数恒返回空 ⇒ 红重新消失在"重做活验"里
  M14: {
    file: '_assert_restrict_live.mjs',
    from: `  if (!(bad > 0)) return []`,
    to: `  return [] // [M14] 恒空 ⇒ 污染吞红`
  },
  // 0032 §7.1「每一个计算出来的数组，都配一个把它变空的变异」—— 补齐 `after`（第 2 个）
  // `after` 变空 ⇒ 「确实新增了 header」红 + 污染判定被 `after.length > 0 &&` 短路 ⇒ 两个后果一起验
  M16: {
    file: '_assert_restrict_live.mjs',
    from: `  const after = baselineSeq !== null ? headers.filter((h) => h.seq !== null && h.seq > baselineSeq) : []`,
    to: `  const after = [] // [M16] 新增集合恒空`
  },
  // 0032 §7.1 第 3 个：`diffTools` 的 removed/added 恒空 ⇒ --strict-diff 的「只有 pwsh 变」会假绿
  M17: {
    file: '_assert_restrict_live.mjs',
    from: `  return { removed: a.filter((x) => !b.includes(x)), added: b.filter((x) => !a.includes(x)), nFrom: a.length, nTo: b.length }`,
    to: `  return { removed: [], added: [], nFrom: a.length, nTo: b.length } // [M17] diff 恒空`
  },
  // P2-18 的另一半：RESULT 不带红条数 ⇒ 只 grep ^RESULT 的人仍然看不见
  M15: {
    file: '_assert_restrict_live.mjs',
    from: `  const suffix = verdict === 'contaminated' && bad > 0 ? \`（另含 \${bad} 条红，见上）\` : ''`,
    to: `  const suffix = '' // [M15] RESULT 不带条数`
  },
  // ── 0033 §6：0032 报的分母只有 7，漏了 16 处。下面把这 7 处从「未测」补成「实测」 ──
  // 0033 §6.1：0028-reply 报「#3 kinds 是真缺口」—— 实测**不是**（污染文案断言接住）
  M18: {
    file: '_assert_restrict_live.mjs',
    from: `    const kinds = [...new Set(after.map((h) => JSON.stringify(h.reason)))].join(' / ')`,
    to: `    const kinds = [].join(' / ') // [M18] kinds 变空`
  },
  // 0033 §6.1：0028-reply 报「#7 pos 未验」—— 实测**已被接住**（parseArgs 完整形态）
  M19: {
    file: '_assert_restrict_live.mjs',
    from: `  const pos = all.filter((a) => typeof a === 'string' && !a.startsWith('--'))`,
    to: `  const pos = [] // [M19] pos 变空`
  },
  // 🔴 最危险的退化方向：bad 恒 0 ⇒ 永远 ALL-PASS、永远 exit 0
  M20: {
    file: '_assert_restrict_live.mjs',
    from: `  const bad = checks.filter(([, ok]) => !ok).length`,
    to: `  const bad = 0 // [M20] bad 恒 0 ⇒ 永远绿`
  },
  // P2-18 的名列：names 恒空 ⇒ 污染提示列不出红条名字（退化成"只报个数"）
  M21: {
    file: '_assert_restrict_live.mjs',
    from: `  const names = (checks ?? []).filter(([, ok]) => !ok).map(([nm]) => nm)`,
    to: `  const names = [] // [M21] names 恒空`
  },
  // 集合比较的去重恒空 ⇒ 任何两个清单都"作为集合相同" ⇒ --strict-diff 假绿
  M22: {
    file: '_assert_restrict_live.mjs',
    from: `  const s = (x) => [...new Set(x ?? [])].sort()`,
    to: `  const s = (x) => [] // [M22] 去重恒空 ⇒ 恒等`
  },
  // 分页载荷恒空 ⇒ headers 恒空（"没有 header" 与 "读不到" 同形）
  M23: {
    file: '_assert_restrict_live.mjs',
    from: `  const recs = page?.records ?? []`,
    to: `  const recs = [] // [M23] 分页载荷恒空`
  },
  // toolsOf 恒空 ⇒ 所有 header 的工具面都是空数组（缺席/空数组/有工具 三态塌陷成一态）
  M24: {
    file: '_assert_restrict_live.mjs',
    from: `  return raw.map((t) => (typeof t === 'string' ? t : String(t?.name ?? t?.function?.name ?? '?')))`,
    to: `  return [] // [M24] toolsOf 恒空`
  },
  // before 恒空 ⇒ baseline 那侧永远"没有"（与 P1-16 视窗检查交互，是最容易假绿的一侧）
  M25: {
    file: '_assert_restrict_live.mjs',
    from: `  const before = baselineSeq !== null ? headers.filter((h) => h.seq !== null && h.seq <= baselineSeq) : []`,
    to: `  const before = [] // [M25] before 恒空`
  }
}

const m = MUT[id]
if (!m) {
  console.error(`未知变异 ${id}（可选：${Object.keys(MUT).join(', ')}）`)
  process.exit(2)
}

// ⚠️ 落点在**仓库内**而不是 os.tmpdir()：沙箱里 spawnSync 到临时目录会 EBUSY，
// 放在仓库内由 bash 用 `node …/_tmp_mut/<id>/_assert_restrict_live_test.mjs` 跑。
const dir = join('_mut', id)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
for (const f of FILES) copyFileSync(f, join(dir, f))

const p = join(dir, m.file)
const src = readFileSync(p, 'utf8')
if (!src.includes(m.from)) {
  console.error(`🔴 变异 ${id} 的锚点没命中 ⇒ 变异没注入（不能拿"绿"当"没被抓住"）`)
  process.exit(3)
}
writeFileSync(p, src.replace(m.from, m.to), 'utf8')

console.log(`变异 ${id} 已注入 ⇒ ${dir}（用 bash 跑：node ${dir}/_assert_restrict_live_test.mjs）`)
