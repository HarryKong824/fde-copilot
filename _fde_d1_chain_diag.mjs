// 只读诊断：审计链那 3 处「断链/哈希不符」到底是链坏了还是我重算的方式不对。
// 判据纪律：先分清「仪器错」与「实现错」，别拿一个自己没验过的重算去指控正确实现。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname
const EVENTS = 'E:\\DSH-desktop\\DeepSeek Harness\\data\\dsh-home\\fde-state\\memory\\audit\\events.jsonl'

if (!existsSync(EVENTS)) { console.log('没有 events.jsonl'); process.exit(1) }
const lines = readFileSync(EVENTS, 'utf8').split('\n').filter((l) => l.trim())
const rows = lines.map((l, i) => {
  try { return { i: i + 1, raw: l, j: JSON.parse(l) } } catch { return { i: i + 1, raw: l, j: null } }
})

const audit = await import('file://' + join(HERE, 'dsh-fde-memory', 'lib', 'audit.js').replace(/\\/g, '/'))
let head = audit.GENESIS
const bad = []
for (const r of rows) {
  if (!r.j) { bad.push({ ...r, why: 'unparsable' }); continue }
  const { prevHash, hash, ...record } = r.j
  const linkOK = prevHash === head
  const recomputed = audit.linkHash(head, record)
  const hashOK = recomputed === hash
  if (!linkOK || !hashOK) {
    bad.push({
      n: r.i, seq: r.j.seq, type: r.j.type ?? r.j.kind, ts: r.j.ts,
      linkOK, hashOK,
      prevHashInFile: prevHash, headIExpected: head,
      hashInFile: hash, hashRecomputed: recomputed,
      keysInFileOrder: Object.keys(r.j).join(','),
      keysAfterRest: Object.keys(record).join(','),
    })
  }
  head = hash
}

console.log(`链共 ${rows.length} 行，坏 ${bad.length} 行\n`)
for (const b of bad) {
  console.log(`── 第 ${b.n} 行  seq=${b.seq}  type=${b.type}  ts=${b.ts}`)
  console.log(`   prevHash 接得上？ ${b.linkOK}`)
  if (!b.linkOK) {
    console.log(`     文件里 prevHash = ${b.prevHashInFile}`)
    console.log(`     我算的 head     = ${b.headIExpected}`)
  }
  console.log(`   hash 对得上？ ${b.hashOK}`)
  if (!b.hashOK) {
    console.log(`     文件里 hash     = ${b.hashInFile}`)
    console.log(`     我重算的 hash   = ${b.hashRecomputed}`)
  }
  console.log(`   落盘键序：${b.keysInFileOrder}`)
  console.log(`   解构后键序：${b.keysAfterRest}`)
  console.log('')
}

// 附带：把坏行的**前一行**也打出来（看是不是"前一行才是问题"）
const idx = new Set(bad.map((b) => b.n))
for (const n of idx) {
  const prev = rows.find((r) => r.i === n - 1)
  if (prev?.j) console.log(`第 ${n - 1} 行（坏行的前一行）：seq=${prev.j.seq} type=${prev.j.type ?? prev.j.kind} ts=${prev.j.ts} 键序=${Object.keys(prev.j).join(',')}`)
  const next = rows.find((r) => r.i === n + 1)
  if (next?.j) console.log(`第 ${n + 1} 行（坏行的后一行）：seq=${next.j.seq} type=${next.j.type ?? next.j.kind} ts=${next.j.ts} 键序=${Object.keys(next.j).join(',')}`)
}
