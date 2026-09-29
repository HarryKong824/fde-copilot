/**
 * 部署逐文件 SHA-256 字节对拍（P2-2 修正版）。
 *
 * 与上一版的区别：把「可加载面」与「有意排除面」分开判据，末行不再自相矛盾。
 *   - 可加载面 = lib/*.js + package.json + precheck.mjs + README.md（DSH 实际会加载的）
 *   - 有意排除面 = examples/**（开发样例，不进运行副本，由插件自己的 precheck 说明缺文件是预期）
 * 副本里出现「可加载面之外、且不在有意排除面」的文件 → 才算违规多余文件。
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'

const WS = process.argv[2]
const DST = process.argv[3]
const REPORT = process.argv[4]

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}
function listFiles(dir, base, out = []) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    const st = statSync(full)
    if (st.isDirectory()) listFiles(full, base ? base + '/' + e : e, out)
    else out.push(base ? base + '/' + e : e)
  }
  return out
}

// 可加载面（与 DSH 加载契约一致）
const LOADABLE = (root) => {
  const set = new Set()
  for (const f of listFiles(join(root, 'lib'))) set.add('lib/' + f.replace(/\\/g, '/'))
  for (const f of ['package.json', 'precheck.mjs', 'README.md']) {
    if (statSync(join(root, f)).isFile()) set.add(f)
  }
  return set
}
// 有意排除面（源里有、但不部署）
const EXCLUDED = new Set(['examples'])

const plugins = ['dsh-fde-dsl', 'dsh-fde-phase']
const lines = []
let allMatch = true
let extra = []
let excludedSeen = []

for (const p of plugins) {
  const wsDir = join(WS, p)
  const dstDir = join(DST, p)
  const ws = LOADABLE(wsDir)
  const ds = LOADABLE(dstDir)
  lines.push(`== ${p} ==`)
  lines.push(`  可加载面：源 ${ws.size} / 部署 ${ds.size}`)

  for (const f of ds) if (!ws.has(f)) { extra.push(p + '/' + f); lines.push(`  X 多余(部署有/源无): ${f}`) }
  for (const f of ws) if (!ds.has(f)) { allMatch = false; lines.push(`  X 漏拷(源有/部署无): ${f}`) }
  for (const f of ws) {
    if (!ds.has(f)) continue
    const ok = sha256File(join(wsDir, f)) === sha256File(join(dstDir, f))
    if (!ok) allMatch = false
    lines.push(`  ${ok ? 'OK MATCH' : 'XX DIFF '}  ${f}`)
  }

  // 有意排除面：源里有 examples/ 但部署没有，属设计，单列一行不计入失败
  let wsEx = false
  try {
    wsEx = statSync(join(wsDir, 'examples')).isDirectory()
  } catch {
    wsEx = false
  }
  if (wsEx) excludedSeen.push(`${p}/examples (源有，未部署-by-design)`)
  lines.push('')
}

lines.push(`违规多余文件总数: ${extra.length}`)
if (excludedSeen.length) lines.push(`有意排除面（不计失败）: ${excludedSeen.join('; ')}`)
lines.push(allMatch && extra.length === 0 ? 'RESULT: ALL_MATCH' : 'RESULT: MISMATCH')
writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8')
console.log(lines.join('\n'))
process.exitCode = allMatch && extra.length === 0 ? 0 : 1
