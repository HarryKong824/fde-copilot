/**
 * 全部 DSH 会话 transcript 里找出"哪一个是 WorkBuddy"（只读）。
 * 判据：它的 tool call 参数里出现 WorkBuddy 工作区路径。
 * ⚠️ 多帧 zstd：按魔数 28B52FFD 切帧逐帧解（单帧解压只给第 1 行）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const MARKERS = [/WorkBuddy/i, /2026-09-22-18-30-18/]

function rd(p) {
  const b = readFileSync(p)
  const offs = []
  let i = 0
  while ((i = b.indexOf(MAGIC, i)) !== -1) {
    offs.push(i)
    i++
  }
  const parts = []
  for (const o of offs) {
    try {
      parts.push(zstdDecompressSync(b.subarray(o)))
    } catch {}
  }
  return Buffer.concat(parts).toString('utf8')
}

const hits = []
for (const proj of readdirSync(ROOT)) {
  const projDir = `${ROOT}/${proj}`
  let subs
  try {
    subs = readdirSync(projDir)
  } catch {
    continue
  }
  for (const sid of subs) {
    const f = `${projDir}/${sid}/session.jsonl.zstd`
    let st
    try {
      st = statSync(f)
    } catch {
      continue
    }
    let text
    try {
      text = rd(f)
    } catch {
      continue
    }
    if (!MARKERS.some((m) => m.test(text))) continue
    // 统计命中次数与首次出现上下文
    const first = text.search(/WorkBuddy/i)
    const ctx = first >= 0 ? text.slice(Math.max(0, first - 120), first + 120).replace(/\s+/g, ' ') : ''
    const n = (text.match(/WorkBuddy/gi) ?? []).length
    let created = null,
      turnCount = 0,
      toolCalls = 0
    for (const l of text.split(/\r?\n/)) {
      if (!l.trim()) continue
      let e
      try {
        e = JSON.parse(l)
      } catch {
        continue
      }
      if (e.type === 'session' && created === null) created = new Date(e.createdAt).toISOString()
      if (e.type === 'turn/start') turnCount++
      if (e.type === 'tool/call') toolCalls++
    }
    hits.push({ proj, sid, n, created, turnCount, toolCalls, size: st.size, ctx })
  }
}

hits.sort((a, b) => b.n - a.n)
console.log(`命中 WorkBuddy 字样的会话数: ${hits.length}\n`)
for (const h of hits) {
  console.log(`${h.sid}`)
  console.log(`   project=${h.proj}  WorkBuddy 出现 ${h.n} 次  createdAt=${h.created}  turns=${h.turnCount}  toolCalls=${h.toolCalls}  ${(h.size / 1024).toFixed(0)}KB`)
  if (h.ctx) console.log(`   首次上下文: …${h.ctx}…`)
}
