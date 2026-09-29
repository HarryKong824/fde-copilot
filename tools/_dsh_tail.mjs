/**
 * 读 DSH 会话 transcript 的尾部事件（只读）——活验时看模型说了/调了什么。
 * 用法：node _dsh_tail.mjs [sessionId 前缀=b0f5f60e] [条数=30]
 * ⚠️ 多帧 zstd：按魔数 28B52FFD 切帧逐帧解（单帧解压只给第 1 行）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const PREFIX = process.argv[2] ?? 'b0f5f60e'
const N = Number(process.argv[3] ?? 30)

const dir = readdirSync(ROOT).find((d) => d.includes(PREFIX))
if (!dir) throw new Error(`找不到 ${PREFIX}*`)
const buf = readFileSync(`${ROOT}/${dir}/session.jsonl.zstd`)
const offs = []
let i = 0
while ((i = buf.indexOf(MAGIC, i)) !== -1) {
  offs.push(i)
  i++
}
const parts = []
for (const off of offs) {
  try {
    parts.push(zstdDecompressSync(buf.subarray(off)))
  } catch {}
}
const lines = Buffer.concat(parts).toString('utf8').split(/\r?\n/).filter((l) => l.trim())
console.log(`会话 ${dir}  总行数 ${lines.length}  显示末 ${N} 条\n${'─'.repeat(76)}`)

const clip = (s, n = 300) => {
  const t = String(s ?? '').replace(/\r?\n/g, ' ⏎ ').replace(/\s+/g, ' ')
  return t.length > n ? t.slice(0, n) + ' …' : t
}

for (const l of lines.slice(-N)) {
  let e
  try {
    e = JSON.parse(l)
  } catch {
    console.log('[坏行] ' + clip(l, 120))
    continue
  }
  const t = e.type ?? '(无 type)'
  const seq = e.seq ?? e.data?.seq ?? ''
  const d = e.data ?? e.payload ?? e
  let body = ''
  if (t === 'tool/call' || t === 'tool_call') body = `${d.name ?? d.tool}  ${clip(d.arguments ?? d.args, 200)}`
  else if (t === 'tool/result' || t === 'tool_result')
    body = `isError=${d.isError ?? d.error ? 'YES' : 'no'}  ${clip(JSON.stringify(d.output ?? d.result ?? d.content), 240)}`
  else if (t === 'turn/start' || t === 'turn/end') body = clip(JSON.stringify(d), 150)
  else if (t === 'message' || t === 'message/user' || t === 'message/assistant')
    body = `${d.role ?? ''}  ${clip(typeof d.content === 'string' ? d.content : JSON.stringify(d.content), 320)}`
  else body = clip(JSON.stringify(d), 220)
  console.log(`[${String(seq).padStart(6)}] ${String(t).padEnd(18)} ${body}`)
}
