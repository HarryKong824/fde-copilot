/** E5 勘察：看某个会话 transcript 里 record 的 type 分布 + 工具调用/结果各一条样本。 */
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
const ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const prefix = process.argv[2]
let file = null
for (const proj of readdirSync(ROOT)) {
  let subs; try { subs = readdirSync(`${ROOT}/${proj}`) } catch { continue }
  for (const sid of subs) if (sid.includes(prefix)) file = `${ROOT}/${proj}/${sid}/session.jsonl.zstd`
}
if (!file) throw new Error('找不到 ' + prefix)
const buf = readFileSync(file)
const offs = []; let i = 0
while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i++ }
const parts = []
for (const off of offs) { try { parts.push(zstdDecompressSync(buf.subarray(off))) } catch {} }
const lines = Buffer.concat(parts).toString('utf8').split(/\r?\n/).filter((l) => l.trim())
console.log('文件', file)
console.log('帧', offs.length, '行', lines.length)
const recs = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const m = new Map()
for (const r of recs) { const k = r.type ?? '<无 type>'; m.set(k, (m.get(k) || 0) + 1) }
console.log('type 分布:', JSON.stringify([...m.entries()].sort((a, b) => b[1] - a[1]), null, 0))
// 打印含 tool 的样本各一条
for (const want of ['tool/call', 'tool/result', 'request/header']) {
  const hit = recs.find((r) => String(r.type).includes(want.split('/')[1]) && String(r.type).includes(want.split('/')[0]))
  if (!hit) { console.log(`\n--- ${want}: 没有 ---`); continue }
  const s = JSON.parse(JSON.stringify(hit))
  for (const k of ['prevHash', 'hash']) if (s[k]) s[k] = String(s[k]).slice(0, 8) + '…'
  console.log(`\n--- ${want} 样本 ---`)
  console.log(JSON.stringify(s, null, 1).slice(0, 1400))
}
