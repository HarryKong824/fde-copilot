/**
 * 源↔活副本逐文件 SHA-256 对拍（递归；报告仅源有 / 仅副本有 / 内容不一致）。
 * 用法：node _deploy_diff.mjs <源相对目录> <副本绝对目录>
 *   node _deploy_diff.mjs dsh-fde-phase "E:/.../node_modules/dsh-fde-phase"
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const SRC = process.argv[2]
const DEP = process.argv[3]
if (!SRC || !DEP) { console.error('用法: node _deploy_diff.mjs <源目录> <副本目录>'); process.exit(2) }

const walk = (d, base = d, out = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p, base, out)
    else out.push(relative(base, p).split(sep).join('/'))
  }
  return out
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const A = walk(SRC).sort()
const B = walk(DEP).sort()
const onlyA = A.filter((x) => !B.includes(x))
const onlyB = B.filter((x) => !A.includes(x))
const diff = A.filter((x) => B.includes(x)).filter((f) => sha(join(SRC, f)) !== sha(join(DEP, f)))

const L = []
L.push(`源 ${SRC} → ${A.length} 个文件`)
L.push(`副本 ${DEP} → ${B.length} 个文件`)
L.push(`仅源有：${onlyA.length ? onlyA.join(', ') : '无'}`)
L.push(`仅副本有：${onlyB.length ? onlyB.join(', ') : '无'}`)
L.push(`内容不一致：${diff.length ? diff.join(', ') : '0'}`)
L.push(`判定：${diff.length === 0 && onlyA.length === 0 && onlyB.length === 0 ? 'ALL_MATCH' : 'HAS-DIFF'}`)
if (A.includes('lib/state.js')) {
  L.push(`state.js 源=${sha(join(SRC, 'lib/state.js')).slice(0, 16)} 副本=${sha(join(DEP, 'lib/state.js')).slice(0, 16)}`)
}
writeFileSync('_deploy_diff_out.txt', L.join('\n') + '\n', 'utf8')
console.log(L.join('\n'))
process.exitCode = diff.length === 0 && onlyA.length === 0 && onlyB.length === 0 ? 0 : 1
