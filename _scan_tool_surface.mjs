/** 临时勘察：扫会话，看"最后一条 request/header 的工具数"分布，找真零工具样本 */
import { readdirSync, readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import {
  judgeToolSurface,
  pickLastHeader,
  SESSION_ROOTS,
  assertRootScope,
  sessionRootLabel
} from './_tool_surface_check.mjs'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// P2-14：原来只有 E 根 ⇒ 统计范围小于声称范围（我据它下过"59 条"的结论，实际 60）。
// 现在按根汇总并**逐根打印条数**，让"少扫一个根"在输出里一眼可见。
const scope = assertRootScope()
console.log(`扫描范围（${scope.roots.length} 个根）：${scope.roots.join(' , ')}`)
if (!scope.ok) {
  console.log(`🔴 ${scope.why}`)
  process.exit(1)
}

const limit = Number(process.argv[2] ?? 20)
let scanned = 0
let zero = 0
let absent = 0
let noHeader = 0
const perRoot = new Map()

for (const ROOT of SESSION_ROOTS) {
  const dirs = readdirSync(ROOT).filter((d) => d.startsWith('session-'))
  let nRoot = 0
  console.log(`\n── 根 ${sessionRootLabel(ROOT)}（会话目录 ${dirs.length}）──`)

  for (const dir of dirs.slice(-limit)) {
    let buf
    try {
      buf = readFileSync(`${ROOT}/${dir}/session.jsonl.zstd`)
    } catch {
      continue
    }
    nRoot++
  const offs = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offs.push(i)
    i++
  }
  const parts = []
  for (const o of offs) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(o)))
    } catch {}
  }
  const events = []
  for (const l of Buffer.concat(parts).toString('utf8').split(/\r?\n/)) {
    if (!l.trim()) continue
    try {
      events.push(JSON.parse(l))
    } catch {}
  }
    const picked = pickLastHeader(events)
    scanned++
    if (!picked.found) {
      noHeader++
      console.log(`  — ${dir} 无 request/header`)
      continue
    }
    const j = judgeToolSurface(picked.data)
    if (j.verdict === 'red') {
      if (j.absent) absent++
      else zero++
      console.log(`  🔴 ${dir}  seq=${picked.seq} reason=${picked.reason} n=${j.n} absent=${j.absent}`)
    } else {
      console.log(`  ✅ ${dir}  seq=${picked.seq} reason=${picked.reason} n=${j.n}`)
    }
  }
  perRoot.set(sessionRootLabel(ROOT), nRoot)
}
console.log(
  `\n扫描 ${scanned} 个会话：红=${zero + absent}（其中 absent=${absent}、空数组=${zero}）  无 header=${noHeader}`
)
console.log(`逐根条数：${[...perRoot.entries()].map(([k, v]) => `${k}=${v}`).join(' , ')}`)
if (perRoot.size !== SESSION_ROOTS.length) {
  console.log(`🔴 扫到的根数（${perRoot.size}）≠ 声明的根数（${SESSION_ROOTS.length}）⇒ 少扫了根，本表不可信`)
  process.exit(1)
}
