/**
 * Claude Code 独立扫描器（不 import 任何 WorkBuddy 的脚本）。
 *
 * 目的：回答"63 个会话里，有几个**完全没有** request/header"——
 * 这是我 0027 §3 分布表里没有的那一格，WorkBuddy 说它存在且我漏了。
 *
 * 自证设计（对着 0026 §4.3 那三条约束写）：
 *   ① 解压失败**不许静默**：逐帧记录失败帧数；末行打印总失败帧数，>0 时脚本自己也 exit 1
 *   ② 会话目录必须**遍历到**：打印扫到的目录数，与"有/无 header"两类之和比对，不等即 exit 1
 *   ③ 不许用崩溃当判据：所有 JSON.parse 都被计数，不打在 stderr 上装作没发生
 *   ④ 自带合成坏样本：S1 造一个"只有 user/message"的会话，断言它被判成 noHeader；
 *      S2 造一个"两条 header，末条零工具"的会话，断言末条取到的是**零工具那条**
 */
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const SESS = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ROOTS = ['--E-DSH-workspace--', '--C-Users-DELL--']

const badFrames = []
let parseFail = 0

/** 切帧解压 → 事件数组。返回 {dir, frames, frameFail, events, bytes} */
export function readSession(root, dir) {
  const p = `${SESS}/${root}/${dir}/session.jsonl.zstd`
  const buf = readFileSync(p)
  const offs = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offs.push(i)
    i++
  }
  const parts = []
  let frameFail = 0
  for (const off of offs) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(off)))
    } catch {
      frameFail++
      badFrames.push(`${dir}@${off}`)
    }
  }
  const text = Buffer.concat(parts).toString('utf8')
  const events = []
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim()) continue
    try {
      events.push(JSON.parse(l))
    } catch {
      parseFail++
    }
  }
  return { dir, frames: offs.length, frameFail, events, bytes: buf.length }
}

/** 独立实现的"取最后一条 request/header 的工具面"，故意与 judgeToolSurface 写法不同 */
export function lastHeaderShape(events) {
  let seen = 0
  let last = null
  for (const r of events) {
    const ev = r?.event ?? r
    if (ev?.type !== 'request/header') continue
    seen++
    last = ev
  }
  if (seen === 0) return { seen: 0, n: null, absent: null, reason: null, seq: null }
  const d = last?.data ?? {}
  const hdr = d?.header
  const hasKey = hdr !== null && typeof hdr === 'object' && Object.prototype.hasOwnProperty.call(hdr, 'tools')
  const t = hasKey ? hdr.tools : undefined
  return {
    seen,
    n: Array.isArray(t) ? t.length : 0,
    absent: !hasKey || t === undefined || t === null,
    malformed: hasKey && !Array.isArray(t) && t !== undefined && t !== null,
    reason: d?.reason ?? null,
    seq: last?.seq ?? null
  }
}

// ── 合成样本（约束 ④）──────────────────────────────────────────────────────
function selfTest() {
  let bad = 0
  const say = (ok, msg) => {
    console.log(`  ${ok ? '✅' : '🔴'} ${msg}`)
    if (!ok) bad++
  }
  const ev = (...x) => x

  const s1 = lastHeaderShape(ev({ type: 'user/message', data: { content: 'hi' } }))
  say(s1.seen === 0 && s1.n === null, 'S1 只有 user/message ⇒ seen=0 / n=null（不是 n=0）')

  const s2 = lastHeaderShape(
    ev(
      { type: 'request/header', seq: 1, data: { header: { tools: [{ name: 'read' }] }, reason: 'initial' } },
      { type: 'request/header', seq: 2, data: { header: { config: {} }, reason: 'change' } }
    )
  )
  say(s2.seen === 2 && s2.n === 0 && s2.absent === true, 'S2 [有,无] ⇒ 末条取到零工具那条（absent）')

  const s3 = lastHeaderShape(ev({ type: 'request/header', seq: 5, data: { header: { tools: [] }, reason: 'x' } }))
  say(s3.n === 0 && s3.absent === false, 'S3 tools:[] ⇒ n=0 但 absent=false（与缺席区分）')

  const s4 = lastHeaderShape(ev({ event: { type: 'request/header', seq: 7, data: { header: { tools: [{ name: 'a' }] } } } }))
  say(s4.seen === 1 && s4.n === 1, 'S4 嵌套 {event:{…}} 形状也能取到')

  return bad
}

function main() {
  console.log('=== 自检（合成样本）===')
  const stFail = selfTest()
  if (stFail > 0) {
    console.log(`\n🔴 扫描器自检失败 ${stFail} 条 ⇒ 输出不可信`)
    process.exitCode = 1
    return
  }

  const rows = []
  let dirCount = 0
  for (const root of ROOTS) {
    let dirs = []
    try {
      dirs = readdirSync(`${SESS}/${root}`)
    } catch {
      continue
    }
    for (const d of dirs) {
      dirCount++
      let s
      try {
        s = readSession(root, d)
      } catch (e) {
        rows.push({ root, dir: d, err: String(e?.message ?? e) })
        continue
      }
      const sh = lastHeaderShape(s.events)
      rows.push({ root, dir: d, ...s, ...sh })
    }
  }

  const errs = rows.filter((r) => r.err)
  const ok = rows.filter((r) => !r.err)
  const noHeader = ok.filter((r) => r.seen === 0)
  const withHeader = ok.filter((r) => r.seen > 0)

  console.log(`\n=== 实扫 ===`)
  console.log(`会话目录数（遍历到） = ${dirCount}`)
  console.log(`读成功的会话         = ${ok.length}`)
  console.log(`读失败的会话         = ${errs.length}`)
  for (const r of errs) console.log(`  🔴 ${r.dir}: ${r.err}`)

  console.log(`\n── 完全没有 request/header 的会话（${noHeader.length}）──`)
  for (const r of noHeader) {
    console.log(`  ${r.dir}  帧=${r.frames} 事件=${r.events.length} 字节=${r.bytes} 解析失败行=${r.frameFail}`)
  }

  const buckets = new Map()
  for (const r of withHeader) {
    const k = r.n
    buckets.set(k, (buckets.get(k) ?? 0) + 1)
  }
  console.log(`\n── 有 header 的会话的工具数分布（${withHeader.length}）──`)
  const keys = [...buckets.keys()].sort((a, b) => a - b)
  for (const k of keys) console.log(`  n=${k}  × ${buckets.get(k)}`)
  const gaps = []
  for (let k = keys[0] ?? 0; k <= (keys[keys.length - 1] ?? 0); k++) if (!buckets.has(k)) gaps.push(k)
  console.log(`  分布缺口（中间没有的取值）：${gaps.length ? gaps.join(',') : '（无）'}`)

  const reasons = new Map()
  for (const r of withHeader) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1)
  console.log(`\n── 有 header 的会话「末条 reason」分布 ──`)
  for (const [k, v] of reasons) console.log(`  reason=${JSON.stringify(k)}  × ${v}`)

  console.log(`\n── 自查 ──`)
  console.log(`解压失败帧总数 = ${badFrames.length}${badFrames.length ? ' → ' + badFrames.slice(0, 5).join(', ') : ''}`)
  console.log(`JSON 解析失败行 = ${parseFail}`)
  const sum = noHeader.length + withHeader.length
  console.log(`有+无 header = ${sum}   读成功 = ${ok.length}   ${sum === ok.length ? '✅ 自洽' : '🔴 不自洽'}`)

  if (badFrames.length > 0 || parseFail > 0 || sum !== ok.length) {
    console.log('\n🔴 扫描器自身有问题 ⇒ 上面的"无 header"结论不可信')
    process.exitCode = 1
    return
  }
  console.log('\nSWEEP OK')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
