/**
 * 扫单个会话 transcript 里所有 `session/end-seed` 标记（按帧切分 zstd 多帧）。
 *
 * 用途：`session/end-seed` 是「会话日志被重新加载/重建」的唯一痕迹，
 *      但它受 dsh-session:1322 的「末条已是 end-seed 就不重复写」约束 ⇒
 *      **没有 end-seed 不等于没有重建**。本脚本只负责把"确实写了"的那些列出来。
 *
 * 用法：node _scan_endseed.mjs [会话前缀=b0f5f60e]
 * 输出：_scan_endseed_out.txt
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const PREFIX = process.argv[2] ?? 'b0f5f60e'

const dir = readdirSync(ROOT).find((d) => d.includes(PREFIX))
if (!dir) throw new Error('找不到会话 ' + PREFIX)
const buf = readFileSync(ROOT + '/' + dir + '/session.jsonl.zstd')

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

const L = []
L.push('会话 ' + dir)
L.push('帧数=' + offs.length + '  总行=' + lines.length)

let maxSeq = -1
const seeds = []
for (const l of lines) {
  let e
  try {
    e = JSON.parse(l)
  } catch {
    continue
  }
  if (typeof e.seq === 'number' && e.seq > maxSeq) maxSeq = e.seq
  if (e.type === 'session/end-seed') {
    seeds.push({ seq: e.seq, time: e.time ? new Date(e.time).toISOString() : null })
  }
}
L.push('最大 seq = ' + maxSeq)
L.push('session/end-seed 出现 ' + seeds.length + ' 次：')
for (const s of seeds) L.push('   seq=' + s.seq + '  time=' + (s.time ?? '(无 time)'))

writeFileSync('_scan_endseed_out.txt', L.join('\n') + '\n', 'utf8')
console.log(L.join('\n'))
