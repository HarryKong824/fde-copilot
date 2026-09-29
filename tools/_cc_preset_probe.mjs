/**
 * 判决性对比：扫最近 N 个会话的首个 request/header，看模型被给了几个工具。
 * 若"最近一个 = 1（run_code）"而"更早的一批 >> 1" ⇒ 是本次启动起的变化。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const N = Number(process.argv[2] ?? 12)

function lines(p) {
  const buf = readFileSync(p)
  const offs = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i++ }
  const parts = []
  for (const o of offs) { try { parts.push(zstdDecompressSync(buf.subarray(o))) } catch {} }
  return Buffer.concat(parts).toString('utf8').split(/\r?\n/).filter((l) => l.trim())
}

const dirs = readdirSync(ROOT)
  .map((d) => ({ d, m: statSync(`${ROOT}/${d}`).mtimeMs }))
  .sort((a, b) => b.m - a.m)
  .slice(0, N)

console.log(`扫最近 ${dirs.length} 个会话（按目录 mtime 降序）\n`)
for (const { d, m } of dirs) {
  let out = { mtime: new Date(m).toISOString(), tools: '?', names: [], preset: '?' }
  try {
    const ls = lines(`${ROOT}/${d}/session.jsonl.zstd`)
    for (const l of ls) {
      let e; try { e = JSON.parse(l) } catch { continue }
      const t = e.type ?? ''
      const dd = e.data ?? {}
      if (t === 'request/header' && dd.reason === 'initial' && out.tools === '?') {
        const tools = dd.header?.tools ?? dd.tools ?? []
        out.tools = Array.isArray(tools) ? tools.length : 'n/a'
        out.names = (Array.isArray(tools) ? tools : []).slice(0, 6)
          .map((x) => x?.name ?? x?.function?.name ?? '?')
      }
      if (/preset/i.test(t) && out.preset === '?') out.preset = JSON.stringify(dd).slice(0, 160)
    }
  } catch (err) { out.tools = `ERR ${err.message.slice(0, 40)}` }
  console.log(`${out.mtime}  ${d.slice(0, 42)}`)
  console.log(`   工具数=${out.tools}  ${out.names.join(', ')}`)
  if (out.preset !== '?') console.log(`   preset事件: ${out.preset}`)
  console.log()
}
