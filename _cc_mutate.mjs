/**
 * Claude Code 变异注入器（临时实验，不属交付物）。
 * 用法：node _cc_mutate.mjs <mutId>   —— 在 cwd 里把 _assert_restrict_live.mjs.orig 变异成 _assert_restrict_live.mjs
 *
 * 目的：证明 P1-11 三处补丁**各自**可证伪（WorkBuddy 只做了"旧模块 ⇒ 链接错误"的结构性红，
 * 那证明的是"新测试不能跑在旧代码上"，不是"新测试能抓住旧代码的 bug"）。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const orig = readFileSync('_assert_restrict_live.mjs.orig', 'utf8')

const MUT = {
  // ① P1-11①：删掉「tools 键**存在**」那条 push
  M1: [
    `  checks.push([
    \`最后一条 header 的 tools 键**存在**（缺席 ⇒ 判红；不再靠 "read 仍在" 间接捕获）\`,
    !!judged && !judged.absent
  ])
`,
    ''
  ],
  // ② P1-11②：删掉 without 分支里那条「未给 baseline」push
  M2: [
    `      checks.push([
        \`未给 baseline ⇒ 最后一条 header 的 reason ∈ {\${FRESH_REASONS.join(',')}}\` +
          \`（新开会话本就是建会话那条；出现 change/series ⇒ 中途变过，"天生如此"不成立）\`,
        FRESH_REASONS.includes(last?.reason)
      ])
`,
    ''
  ],
  // ③ P1-11③：让 require 有个"内置默认清单"
  M3: [
    `  const require = Array.isArray(o?.require) ? o.require : []`,
    `  const require = Array.isArray(o?.require) && o.require.length ? o.require : ['read', 'pwsh']`
  ],
  // ④ extractHeaders 改成只读顶层 reason（模拟 WorkBuddy §6.2 那个真实形状错法）
  M4: [`      reason: ev.data?.reason ?? null,`, `      reason: ev.reason ?? null,`],
  // ⑤ 让「缺席」不再判红（judgeToolSurface 退化成永远不 absent）—— 跨文件，改 _tool_surface_check
  M5: null,
  // ⑥ extractHeaders 的 tools 抽取把"缺席"压成 []（WorkBuddy §4.1 说的旧 :88 那个形状）
  M6: [`  const raw = resolveTools(h?.data)\n  if (!Array.isArray(raw)) return []`, `  const raw = h?.data?.header?.tools ?? []\n  if (!Array.isArray(raw)) return []`]
}

const id = process.argv[2]
if (id === 'M5') {
  const f = '_tool_surface_check.mjs'
  const s = readFileSync(f, 'utf8')
  writeFileSync(f + '.orig', s)
  const from = `  if (raw === ABSENT) {`
  if (!s.includes(from)) throw new Error('M5 锚点找不到')
  writeFileSync(f, s.replace(from, `  if (false) {`))
  console.log('M5 已注入（judgeToolSurface: 缺席分支短路）')
} else {
  const m = MUT[id]
  if (!m) throw new Error(`未知变异 ${id}`)
  if (!orig.includes(m[0])) throw new Error(`${id} 锚点找不到`)
  writeFileSync('_assert_restrict_live.mjs', orig.replace(m[0], m[1]))
  console.log(`${id} 已注入`)
}
