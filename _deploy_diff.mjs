/**
 * 源↔活副本逐文件 SHA-256 对拍（递归；报告仅源有 / 仅副本有 / 内容不一致）。
 *
 * 用法：
 *   node _deploy_diff.mjs                              ← 无参数：对拍**全部 4 个插件**
 *   node _deploy_diff.mjs <源相对目录> <副本绝对目录>   ← 单插件模式（原用法，保留）
 *
 * 环境变量：
 *   FDE_DSH_HOME   本机 DSH 的 dsh-home 目录；不设时用默认位置。
 *                  没有那份部署时**不报 ALL_MATCH**，而是明确 SKIP（退出码 77）。
 *
 * 🔴 2026-09-29 修复：此前**只**有双参数模式，而 README / CONTRIBUTING /
 *    PULL_REQUEST_TEMPLATE / deployment.md / feature-matrix.md / releases.md
 *    以及 package.json 的 `npm run deploy:diff` **共 8 处**都写着无参数用法 ⇒
 *    照文档执行的人只会看到「用法: ...」+ 退出码 2，**永远看不到 ALL_MATCH**。
 *    修法不是改那 8 处文档，而是让被文档承诺的那条命令真的能用。
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, relative, sep, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGINS = ['dsh-fde-ontology-gate', 'dsh-fde-dsl', 'dsh-fde-phase', 'dsh-fde-memory']
const DSH_HOME = process.env.FDE_DSH_HOME ?? 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home'

const walk = (d, base = d, out = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p, base, out)
    else out.push(relative(base, p).split(sep).join('/'))
  }
  return out
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** 对拍一对目录；返回 { lines, verdict } */
function diffOne(SRC, DEP) {
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
  const ok = diff.length === 0 && onlyA.length === 0 && onlyB.length === 0
  L.push(`判定：${ok ? 'ALL_MATCH' : 'HAS-DIFF'}`)
  if (A.includes('lib/state.js')) {
    L.push(`state.js 源=${sha(join(SRC, 'lib/state.js')).slice(0, 16)} 副本=${sha(join(DEP, 'lib/state.js')).slice(0, 16)}`)
  }
  return { lines: L, verdict: ok ? 'ALL_MATCH' : 'HAS-DIFF' }
}

const out = []
// —— 单插件模式（原用法） ——
if (process.argv[2] && process.argv[3]) {
  const { lines, verdict } = diffOne(process.argv[2], process.argv[3])
  out.push(...lines)
  writeFileSync('_deploy_diff_out.txt', out.join('\n') + '\n', 'utf8')
  console.log(out.join('\n'))
  process.exit(verdict === 'ALL_MATCH' ? 0 : 1)
}

if (process.argv[2] && !process.argv[3]) {
  console.error('用法: node _deploy_diff.mjs [<源目录> <副本目录>]')
  console.error('  不传参数 = 对拍全部 4 个插件（推荐）；传两个参数 = 只对拍一对目录。')
  process.exit(2)
}

// —— 无参数：全部 4 个插件 ——
const DEPLOYED_ROOT = join(DSH_HOME, 'profiles/web/node_modules')
const tally = { ALL_MATCH: 0, 'HAS-DIFF': 0, SKIP: 0 }
for (const name of PLUGINS) {
  out.push(`=== ${name} ===`)
  const SRC = resolve(HERE, name)
  const DEP = join(DEPLOYED_ROOT, name)
  if (!existsSync(SRC)) {
    out.push(`判定：HAS-DIFF（源目录不存在：${SRC}）`)
    tally['HAS-DIFF']++
  } else if (!existsSync(DEP)) {
    out.push(`判定：SKIP（本机未部署：${DEP}）`)
    out.push(`  ⇒ 无法验证，因此**不报** ALL_MATCH。设 FDE_DSH_HOME=<你的 dsh-home> 后重跑。`)
    tally.SKIP++
  } else {
    const { lines, verdict } = diffOne(SRC, DEP)
    out.push(...lines)
    tally[verdict]++
  }
}
out.push('---')
out.push(`汇总：共 ${PLUGINS.length} 个插件；ALL_MATCH ${tally.ALL_MATCH}；HAS-DIFF ${tally['HAS-DIFF']}；未部署（无法验证）${tally.SKIP}`)
if (tally.SKIP === PLUGINS.length) {
  // 一个都没部署 ⇒ 这是「测不了」，不是「一致」。绝不能报 ALL_MATCH（fail-closed）。
  out.push('判定：SKIP（本机无任何部署，无法对拍；不是 ALL_MATCH）')
} else if (tally['HAS-DIFF'] === 0) {
  out.push('判定：ALL_MATCH')
} else {
  out.push('判定：HAS-DIFF')
}
out.push(`（FDE_DSH_HOME = ${DSH_HOME}）`)

writeFileSync('_deploy_diff_out.txt', out.join('\n') + '\n', 'utf8')
console.log(out.join('\n'))
if (tally.SKIP === PLUGINS.length) process.exit(77) // 跳过：无部署可测
process.exit(tally['HAS-DIFF'] === 0 ? 0 : 1)
