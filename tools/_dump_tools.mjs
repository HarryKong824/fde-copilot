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
let lastHeader = null
for (const l of text.split(/\r?\n/)) {
  try { const e = JSON.parse(l); if (e.type === 'request/header') lastHeader = e } catch {}
}
const tools = lastHeader?.data?.header?.tools ?? lastHeader?.header?.tools ?? []
console.log(`共 ${tools.length} 个工具：`)
for (const t of tools) console.log(`  ${t?.name ?? t?.function?.name ?? JSON.stringify(t).slice(0,60)}`)
