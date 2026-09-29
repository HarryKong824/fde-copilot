import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
const ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--'
const MAGIC = Buffer.from([0x28,0xb5,0x2f,0xfd])
const dir = readdirSync(ROOT).find((d) => d.includes('b0f5f60e'))
const buf = readFileSync(`${ROOT}/${dir}/session.jsonl.zstd`)
const offs = []
let i = 0
while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i++ }
const parts = []
for (const off of offs) { try { parts.push(zstdDecompressSync(buf.subarray(off))) } catch {} }
const text = Buffer.concat(parts).toString('utf8')
const lines = text.split(/\r?\n/).filter((l) => l.trim())
// 统计 fde_memory 出现次数 + 最后一次 request/header 的结构
let cnt = 0
let lastHeader = null
for (const l of lines) {
  if (l.includes('fde_memory')) cnt++
  try {
    const e = JSON.parse(l)
    if (e.type === 'request/header') lastHeader = e
  } catch {}
}
console.log(`fde_memory 在 transcript 里出现 ${cnt} 次`)
if (lastHeader) {
  const h = lastHeader.data?.header ?? lastHeader.header ?? lastHeader.data
  console.log(`最后 request/header 顶层键 = ${JSON.stringify(Object.keys(h ?? {}))}`)
  // tools 可能在各处
  const tools = h?.tools ?? h?.toolset ?? h?.config?.tools
  console.log(`tools 字段类型 = ${tools === undefined ? 'undefined' : Array.isArray(tools) ? 'array['+tools.length+']' : typeof tools}`)
  if (Array.isArray(tools)) {
    const names = tools.map((t) => t?.name ?? t?.function?.name ?? t?.id ?? '?')
    const mem = names.filter((n) => String(n).startsWith('fde_memory'))
    console.log(`工具清单共 ${names.length} 个，fde_memory* 有 ${mem.length} 个：`)
    for (const m of mem) console.log(`   ${m}`)
    const fdeAll = names.filter((n) => String(n).startsWith('fde_'))
    console.log(`fde_* 工具共 ${fdeAll.length} 个：${fdeAll.join(', ')}`)
  } else {
    console.log(`tools 原始片段: ${JSON.stringify(tools).slice(0, 500)}`)
  }
} else {
  console.log('未找到 request/header 事件')
}
