#!/usr/bin/env node
/**
 * 从 Claude Code 的会话记录里汇总真实 token 用量。
 *
 * 为什么要这个脚本：本项目的纪律是「判据必须可复算」——
 * 成本文档里的数字不该是手抄的，应当**任何人拿同样的输入都能算出同样的结果**。
 *
 * 用法：
 *   node _token_usage_report.mjs <projectsRoot> [会话 id 前缀...]
 *
 * 例：
 *   node _token_usage_report.mjs ~/.claude/projects
 *   node _token_usage_report.mjs ~/.claude/projects c0be4de1 14c85869
 *
 * 不传会话 id ⇒ 汇总该目录下**全部**会话；传了 ⇒ 只统计匹配的会话
 * （匹配是**前缀匹配**，且会自动带上它们的 subagents/ 子代理记录）。
 *
 * 口径（三条，缺一不可）：
 *   ① 按 message.id 去重 —— 流式传输会让同一次调用出现多条记录，不去重会重复计数。
 *   ② 输入 / 输出 / 缓存读取 **分列**，不合并 —— 三者单价不同，合并后无法换算金额。
 *   ③ 缓存写入（cache_creation）本项目实测恒为 0，故不单列；若你的环境非 0，
 *      它会并入「输入」列打印（见下面的 cw）。
 *
 * ⚠️ 退出码：0 = 正常；2 = 参数/目录错误。**本脚本不做任何"判定"**，
 *    它只报数 —— 判定由读它的人做。
 */
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2)
if (argv.length === 0) {
  console.error('用法：node _token_usage_report.mjs <projectsRoot> [会话 id 前缀...]')
  process.exit(2)
}

let root = argv[0]
if (root.startsWith('~')) root = path.join(os.homedir(), root.slice(1))
const filters = argv.slice(1)

try {
  const st = await stat(root)
  if (!st.isDirectory()) throw new Error('不是目录')
} catch (e) {
  console.error(`❌ 打不开目录：${root}（${e.message}）`)
  process.exit(2)
}

async function listJsonl(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await listJsonl(p))
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

async function tally(f) {
  const seen = new Map()
  let firstTs = null, lastTs = null, bad = 0, lines = 0
  const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    lines++
    let o
    try { o = JSON.parse(line) } catch { bad++; continue }
    const ts = o.timestamp || o.time
    if (ts) {
      const t = Date.parse(ts)
      if (!Number.isNaN(t)) {
        if (firstTs === null || t < firstTs) firstTs = t
        if (lastTs === null || t > lastTs) lastTs = t
      }
    }
    const u = o.message?.usage
    // ① 按 message.id 去重
    if (u) seen.set(o.message?.id || o.requestId || `line-${lines}`, { model: o.message?.model || 'unknown', u })
  }
  const byModel = new Map()
  for (const { model, u } of seen.values()) {
    const a = byModel.get(model) || { n: 0, in: 0, out: 0, cw: 0, cr: 0 }
    a.n++
    a.in += u.input_tokens || 0
    a.out += u.output_tokens || 0
    a.cw += u.cache_creation_input_tokens || 0
    a.cr += u.cache_read_input_tokens || 0
    byModel.set(model, a)
  }
  return { byModel, firstTs, lastTs, bad, lines }
}

const all = await listJsonl(root)
// 匹配整个路径（不只是文件名）：会话的子代理记录在 `<sessionId>/subagents/agent-*.jsonl`，
// 文件名不以会话 id 开头 ⇒ 只匹配 basename 会**漏掉全部子代理**。
const chosen = filters.length === 0
  ? all
  : all.filter(f => filters.some(x => f.includes(x)))

if (chosen.length === 0) {
  console.error(`❌ 没有匹配的会话记录（目录共 ${all.length} 个 JSONL）。`)
  process.exit(2)
}

const merged = new Map()
let gFirst = null, gLast = null, gBad = 0, gLines = 0
for (const f of chosen) {
  const { byModel, firstTs, lastTs, bad, lines } = await tally(f)
  gBad += bad; gLines += lines
  if (firstTs !== null) gFirst = gFirst === null ? firstTs : Math.min(gFirst, firstTs)
  if (lastTs !== null) gLast = gLast === null ? lastTs : Math.max(gLast, lastTs)
  for (const [m, a] of byModel) {
    const t = merged.get(m) || { n: 0, in: 0, out: 0, cw: 0, cr: 0 }
    t.n += a.n; t.in += a.in; t.out += a.out; t.cw += a.cw; t.cr += a.cr
    merged.set(m, t)
  }
}

const N = (x) => x.toLocaleString('en-US')
const iso = (t) => t === null ? '（无时间戳）' : new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z'

console.log(`目录        ：${root}`)
console.log(`会话文件    ：${chosen.length} 个（该目录共 ${all.length} 个）`)
console.log(`时间跨度    ：${iso(gFirst)} → ${iso(gLast)}`)
console.log(`总行数      ：${N(gLines)}${gBad > 0 ? `（其中 ${N(gBad)} 行无法解析，已跳过）` : ''}`)
if (filters.length) console.log(`筛选前缀    ：${filters.join(', ')}`)
console.log('')

let T = { n: 0, in: 0, out: 0, cw: 0, cr: 0 }
console.log('| 模型 | API 调用 | 输入 | 输出 | 缓存写入 | 缓存读取 | 合计 |')
console.log('|---|---|---|---|---|---|---|')
for (const [m, a] of [...merged].sort((x, y) => (y[1].in + y[1].out) - (x[1].in + x[1].out))) {
  const tot = a.in + a.out + a.cw + a.cr
  console.log(`| ${m} | ${N(a.n)} | ${N(a.in)} | ${N(a.out)} | ${N(a.cw)} | ${N(a.cr)} | ${N(tot)} |`)
  T.n += a.n; T.in += a.in; T.out += a.out; T.cw += a.cw; T.cr += a.cr
}
console.log(`| **合计** | **${N(T.n)}** | **${N(T.in)}** | **${N(T.out)}** | **${N(T.cw)}** | **${N(T.cr)}** | **${N(T.in + T.out + T.cw + T.cr)}** |`)

console.log('')
console.log(`缓存读取占比：${(T.cr / (T.in + T.out + T.cw + T.cr) * 100).toFixed(2)}%`)
console.log('⚠️ 换算金额时三者单价不同，**不要**用同一个单价乘总 Token 数。')
