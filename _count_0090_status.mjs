/**
 * 逐条枚举 0090 第一节（结论先行）那张表的状态档，**不写总数以外的任何推断**。
 * 起因：我口头答"只剩三处未验"，而那张表里还有两处写着「仅离线」—— 说明我用关键词 grep 代替了逐条枚举。
 * 判据口径（写死，避免我临时改口径）—— **逐级降级，顺序即优先级**：
 *   ① 列文本含「部分活验」                          ⇒ `部分活验`
 *      （2026-09-29 新增档：D3 接线与 A2 锁的部分分支已活验。
 *        ⚠️ 这两行括号里**同时**含「仅离线」字样 ⇒ ①必须排在②前面，否则会被误归「仅离线」。）
 *   ② 否则含「仅离线」                            ⇒ `仅离线`
 *   ③ 否则含「未验」「未…跑过」「未做」「未完成」之一 ⇒ `部分未验`
 *   ④ 否则含「已实现」                              ⇒ `活验完整`
 *   ⑤ 都不含                                        ⇒ `未分类`（**必须为 0**）
 *
 * 🔴 口径第一版只认「未验」两字 ⇒ 第 47 行（D1）状态列写的是「端到端**未在真实进程里跑过**」，
 *    不含那两个字，于是被误归成"活验完整"。**分类维度装不下语料**（同族：grep 不能当判据）。
 *    ⇒ 除了补模式，**每一行都把它状态列里所有含「未」字的片段原样打出来**：
 *    读者不必相信我的分类，能自己判这一行归得对不对。
 */
import { readFileSync } from 'node:fs'

const P = new URL('./0090-PoC-to-spec-v3-差距清单.md', import.meta.url)
const lines = readFileSync(P, 'utf8').split('\n')

// 第一节那张表：从「## 一、结论先行」到「## 二、差距清单」；只要以 `|` 开头且不是表头/分隔行的
const start = lines.findIndex((l) => l.startsWith('## 一、结论先行'))
const end = lines.findIndex((l) => l.startsWith('## 二、差距清单'))
if (start < 0 || end < 0) { console.error('没找到章节边界'); process.exit(2) }

const rows = []
for (let i = start; i < end; i++) {
  const l = lines[i]
  if (!l.startsWith('|')) continue
  if (/^\|\s*-+/.test(l) || l.includes('|---|---|')) continue
  if (l.includes('| spec 节 |')) continue // 表头
  const cells = l.split('|').map((c) => c.trim())
  const name = cells[1] ?? ''
  const status = cells[cells.length - 2] ?? '' // 最后一格（split 后末位是空串）
  rows.push({ lineNo: i + 1, name, status })
}

/** 状态列里所有含「未」字的片段 —— 原样打出来，读者可自行核对我的归类。 */
const negatives = (s) => (s.match(/[^，。；|]*未[^，。；|]*/g) ?? []).map((x) => x.trim()).filter(Boolean)

const bucket = (s) =>
  s.includes('部分活验') ? '部分活验'
    : s.includes('仅离线') ? '仅离线'
      : /未验|未在真实进程里跑过|未做|未完成|未跑过/.test(s) ? '部分未验'
        : s.includes('已实现') ? '活验完整'
          : '未分类'

const counts = {}
for (const r of rows) {
  const b = bucket(r.status)
  counts[b] = (counts[b] ?? 0) + 1
  const short = r.name.replace(/\*\*/g, '').replace(/\s*（.*$/, '').slice(0, 40)
  const neg = negatives(r.status)
  console.log(`${b.padEnd(6)} | 第${String(r.lineNo).padStart(3)}行 | ${short.padEnd(42)} | ${neg.length ? neg.join(' ／ ').slice(0, 120) : '（无「未」字）'}`)
}

console.log('\n──── 汇总（逐条枚举，非 grep 计数）────')
for (const k of Object.keys(counts)) console.log(`  ${k}: ${counts[k]}`)
console.log(`  合计: ${rows.length}`)
const sum = Object.values(counts).reduce((a, b) => a + b, 0)
console.log(`  校验 合计 == 各项之和 ? ${rows.length === sum}`)
process.exitCode = counts['未分类'] ? 1 : 0
