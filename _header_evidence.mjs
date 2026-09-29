/**
 * 独立取会话 transcript 里的 request/header 原始证据（**只读**）。
 * 用法：node _header_evidence.mjs <sessionId 前缀…>
 *
 * ⚠️ transcript 是**多个 zstd 帧追加**写成的（每次 flush 一帧）。
 * `zstdDecompressSync(整个 buffer)` 与流式 `createZstdDecompress` 都**只解第一帧**
 * （后者还会在第二帧报 "Unknown frame descriptor"）—— 会让人误判"transcript 只有 1 行"。
 * 本脚本按 4 字节帧魔数切帧逐帧解。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/sessions/--E-DSH-workspace--'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function readTranscript(path) {
  const buf = readFileSync(path)
  const offs = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offs.push(i)
    i++
  }
  const parts = []
  let bad = 0
  for (const off of offs) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(off)))
    } catch {
      bad++
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offs.length, bad }
}

const want = process.argv.slice(2)
const dirs = readdirSync(ROOT).filter((d) => want.some((w) => d.includes(w)))
if (dirs.length === 0) console.log(`没找到匹配 ${want.join(',')} 的会话目录`)

for (const d of dirs) {
  console.log(`\n${'='.repeat(72)}\n会话: ${d}`)
  let r
  try {
    r = readTranscript(`${ROOT}/${d}/session.jsonl.zstd`)
  } catch (e) {
    console.log(`  读取失败: ${e.message}`)
    continue
  }
  const lines = r.text.split(/\r?\n/).filter((l) => l.trim() !== '')
  let jsonOk = 0
  const evs = []
  for (const l of lines) {
    try {
      evs.push(JSON.parse(l))
      jsonOk++
    } catch {}
  }
  console.log(`  zstd 帧=${r.frames} 坏帧=${r.bad} 行数=${lines.length} 可解析=${jsonOk}`)

  const headers = []
  for (const e of evs) {
    if (e.type !== 'request/header') continue
    const tools = e.header?.tools ?? e.data?.header?.tools ?? e.payload?.header?.tools ?? null
    const reason = e.reason ?? e.data?.reason ?? e.payload?.reason ?? '-'
    const names = Array.isArray(tools) ? tools.map((t) => t?.name ?? t?.function?.name) : null
    headers.push({
      seq: e.seq ?? '-',
      reason,
      n: names ? names.length : 'no-tools',
      pwsh: names ? names.includes('pwsh') : '?',
      read: names ? names.includes('read') : '?',
      fde: names ? names.filter((x) => String(x).startsWith('fde')) : null
    })
  }
  if (!headers.length) {
    console.log('  ⚠️ 无 request/header；列举所有 type 计数：')
    const c = {}
    for (const e of evs) c[e.type ?? '(无type)'] = (c[e.type ?? '(无type)'] ?? 0) + 1
    console.log('   ', JSON.stringify(c))
    continue
  }
  console.log('  seq    reason     tools pwsh  read  fde*')
  for (const h of headers) {
    console.log(
      `  ${String(h.seq).padEnd(6)} ${String(h.reason).padEnd(10)} ${String(h.n).padEnd(5)} ${String(h.pwsh).padEnd(5)} ${String(h.read).padEnd(5)} ${JSON.stringify(h.fde)}`
    )
  }
  console.log(`  ⇒ ${headers.length} 条 header；末条 ${JSON.stringify(headers[headers.length - 1])}`)
}
