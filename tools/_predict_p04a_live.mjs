/**
 * P0-7 预演：用**活体 cordis.patch.yml 的真实解析结果**喂给 protectedRootsOf()，
 * 预演"重启后 A①/A②/A③ 以及正常路径分别会被怎么判"（只读，不写任何活体文件）。
 *
 * 为什么不用手抄的配置：手抄 = 又一份事实源，抄错就会出现"预演说堵上了、实际敞着"。
 * 这里直接用 DSH 自己的解析器（js-yaml + JSON_SCHEMA.extend(!!js)）读活体文件。
 *
 * 跑法：node _predict_p04a_live.mjs
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { isInside, protectedRootsOf } from '../dsh-fde-ontology-gate/lib/paths.js'

const PATCH = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/cordis.patch.yml'
const JSYAML = 'E:/DSH-desktop/DeepSeek Harness/data/node_modules/js-yaml/index.js'

const yaml = await import(pathToFileURL(JSYAML).href)
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (d) => typeof d === 'string',
  construct: (d) => ({ __jsExpr: d })
})
const schema = yaml.JSON_SCHEMA.extend(JsExpr)

const parsed = yaml.load(readFileSync(PATCH, 'utf8'), { schema })
const inserted = (parsed.find((e) => e?.insert)?.insert ?? []).filter((e) => /fde/.test(e?.id ?? ''))

const gate = inserted.find((e) => e.id === 'fde-ontology-gate')?.config ?? {}
const phase = inserted.find((e) => e.id === 'dsh-fde-phase')?.config ?? {}

console.log('== P0-7 预演：活体配置 → 生效受保护根 → 判定 ==')
console.log(`gate.protectedExtraRoots = ${JSON.stringify(gate.protectedExtraRoots)}`)
console.log(`phase.projectRoot        = ${JSON.stringify(phase.projectRoot)}`)
console.log(
  `同源（===）: ${gate.protectedExtraRoots?.[0] === phase.projectRoot}` +
    '　← 锚点生效则必然 true；false 说明锚点没解析或两条路径被改开了'
)

const roots = protectedRootsOf(gate)
console.log(`\n生效受保护根（${roots.length}）：`)
for (const e of roots) {
  const r = typeof e === 'string' ? e : e.root
  console.log(`  - ${r}${typeof e === 'string' ? '' : `　[${e.kind} / ${e.label}]`}`)
}

const home = 'E:\\DSH-desktop\\DeepSeek Harness\\data\\dsh-home'
// ⚠️ label 与 path 必须是**两个字段**：写成一个模板串会把 "A② " 也当成路径前缀，
//    isInside 于是永远 false ⇒ 预演会假报"放行"（我第一版就踩了这个）。
const probes = [
  { label: 'A②', path: `${home}\\fde-state\\memory\\state.yaml`, note: '改阶段 ⇒ 门禁被整个跳过' },
  { label: 'A③', path: `${home}\\fde-state\\memory\\.state.lock`, note: '制造/删锁 ⇒ 绕过单写者互斥' },
  { label: 'A①', path: `${home}\\fde-audit\\gate.jsonl`, note: '改写审计链 ⇒ 留痕失效' },
  { label: 'A①', path: `${home}\\fde-audit\\phase.jsonl`, note: '同上（phase 链）' },
  { label: '回归', path: 'E:\\ontologyRoot\\actions.yaml', note: 'ontology（应有保护）' },
  { label: '误伤', path: 'E:\\DSH-workspace\\demo\\notes.txt', note: '工作区内普通文件（必须放行）' },
  { label: '误伤', path: `${home}\\profiles\\web\\cordis.yml`, note: 'dsh-home 下但不在三个根内（必须放行）' }
]

console.log('\n判定预演（❌= 会被拒，✅= 放行）：')
for (const { label, path: p, note } of probes) {
  if (process.env.FDE_DEBUG === '1') {
    console.log(`  [debug] p=${JSON.stringify(p)}`)
    for (const e of roots) {
      const r = typeof e === 'string' ? e : e.root
      console.log(`          isInside(${JSON.stringify(r)}) = ${isInside(p, r)}`)
    }
  }
  const hit = roots.find((e) => isInside(p, typeof e === 'string' ? e : e.root))
  console.log(`  ${hit ? '❌ 拒  ' : '✅ 放行'} [${label}] ${p}${hit ? `　← 命中 ${typeof hit === 'string' ? hit : hit.label}` : ''}`)
  console.log(`           ${note}`)
  // P0-8：把**将要出现的拒绝文案原文**预演出来（活验时逐字对拍用）
  if (hit && typeof hit !== 'string') {
    console.log(`           文案原文：目标路径命中受保护区域（${hit.label}）：${p}。${hit.note}`)
  }
}

const { formatProtectedRootsLine } = await import('../dsh-fde-ontology-gate/lib/paths.js')
console.log(`\n启动打印行（P0-6 / 0024 §6 未观测项，此处给出逐字预期）：`)
console.log(`  [dsh-fde-ontology-gate] ${formatProtectedRootsLine(gate)}${gate.mode === 'shadow' ? '（⚠️ shadow 模式下**不拦**）' : ''}`)

console.log('\n⚠️ 读法提醒：判定发生在工具 dispatch 之前，且不区分读/写 ⇒ 受保护目录内的')
console.log('   **读**同样被拒（与审计目录既有行为一致）。要读这些文件请在 DSH 之外的终端读。')
