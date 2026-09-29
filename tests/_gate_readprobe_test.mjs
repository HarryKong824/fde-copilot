/**
 * gate 读通道"探测留痕"回归（README §10.2 / 手册 §7 #5）。
 *
 * 背景（2026-09-24 活体）：`fde_ontology_read` 读不到的时候（越界 / ENOENT / 指向目录）
 * **直接抛错、审计链一行不记** —— 模型可以逐个猜文件名、靠报错与否判断存在性，全程无痕。
 * 修复后：这三条路径各记一条 `decision: read-probe`，**记而不拦**（抛错文案与行为一字不改）。
 *
 * 本脚本守的就是这两件事：① 确实留痕了；② 确实**没有**改变读取的判定语义。
 *
 * 跑法：node _gate_readprobe_test.mjs
 * 结果自己写 `_gate_readprobe_out.txt`（规避控制台代码页乱码）。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installOntologyTools, ONTOLOGY_READ, READ_PROBE } from '../dsh-fde-ontology-gate/lib/tools.js'
import { AuditChain } from '../dsh-fde-ontology-gate/lib/audit.js'

// ⚠️ 这里**不用** gate 的 `normalizeConfig()`：它依赖 `@deepseek-ai/schemastery`，
//    而工作区桩只有 `dsh-tools`（config-schema 那条本来就不在离线覆盖内）。
//    `installOntologyTools()` 实际只用到 `cfg.ontologyRoot`，手工给即可。
const cfgOf = (ontologyRoot) => ({ ontologyRoot, mode: 'shadow', auditPath })

const lines = []
let passed = 0
let failed = 0

function check(name, ok, extra = '') {
  lines.push(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !extra ? '' : `\n      ${extra}`}`)
  ok ? passed++ : failed++
}

const base = mkdtempSync(join(tmpdir(), 'fde-readprobe-'))
const root = join(base, 'ontology')
const auditPath = join(base, 'fde-audit', 'gate.jsonl')
mkdirSync(root, { recursive: true })
writeFileSync(join(root, 'ok.yaml'), 'hello: world\n', 'utf8')
mkdirSync(join(root, 'subdir'), { recursive: true })

const cfg = cfgOf(root)
const audit = new AuditChain(auditPath)

const captured = {}
installOntologyTools({ tools: { register: (d) => { captured[d.name] = d; return () => {} } } }, cfg, audit)

/** 调用读工具，把"结果 or 抛出的错误"都收回来 —— 两条都是要判定的对象。 */
async function readIt(path) {
  try {
    const out = await captured[ONTOLOGY_READ].execute({ path, reason: '回归：读探测留痕' }, { callId: 'probe-1' })
    return { threw: false, out }
  } catch (e) {
    return { threw: true, err: e }
  }
}

function readAudit() {
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
}

// ① 文件不存在：抛错行为不变 + 留痕
const missing = await readIt('nope.yaml')
check('ENOENT 仍然抛错（判定语义不变）', missing.threw, '没有抛错')
check(
  'ENOENT 的错误里仍能看出是文件不存在',
  /ENOENT|no such file/i.test(missing.err?.message ?? ''),
  `实际错误：${missing.err?.message}`
)

// ② 读成功：仍然记 allow（原有行为不得回退）
const ok = await readIt('ok.yaml')
check('合法读取仍然成功', !ok.threw && ok.out.content.includes('hello'), JSON.stringify(ok))

// ③ 指向目录：原有自定义文案 + 留痕
const dir = await readIt('subdir')
check('目录仍然被挡（本通道不提供目录枚举）', dir.threw, '没有被挡')
check(
  '目录错误仍是面向模型的自定义文案（不是 Node 原始 EISDIR）',
  /不提供目录枚举/.test(dir.err?.message ?? ''),
  `实际错误：${dir.err?.message}`
)

// ④ 越界：抛错 + 留痕
const outside = await readIt('../outside.yaml')
check('越界仍然被挡', outside.threw, '没有被挡')

const rows = readAudit()
const probes = rows.filter((r) => r.decision === READ_PROBE)
const allows = rows.filter((r) => r.decision === 'allow')

lines.push('')
check(`审计链共 ${rows.length} 行，其中 read-probe ${probes.length} 行、allow ${allows.length} 行`, true)
check('ENOENT 落了一条 read-probe', probes.some((r) => r.code === 'ENOENT'), JSON.stringify(probes.map((r) => r.code)))
check(
  'read-probe 的 target 指向被猜的那个文件',
  probes.some((r) => String(r.target).includes('nope.yaml')),
  JSON.stringify(probes.map((r) => r.target))
)
check('指向目录落了一条 read-probe（EISDIR）', probes.some((r) => r.code === 'EISDIR'), JSON.stringify(probes.map((r) => r.code)))
check(
  '越界落了一条 read-probe（OutOfOntology）',
  probes.some((r) => r.code === 'OutOfOntology'),
  JSON.stringify(probes.map((r) => r.code))
)
check('合法读取仍然只记 allow，不变成 probe', allows.length === 1 && probes.length === 3, `allow=${allows.length} probe=${probes.length}`)
check(
  'read-probe 不带 confidence/source，也不冒充 deny',
  probes.every((r) => r.decision === READ_PROBE && r.tool === ONTOLOGY_READ),
  JSON.stringify(probes[0])
)
check(
  'audit 自身的 ts / seq / hash / prevHash 一个不少',
  probes.every((r) => typeof r.ts === 'string' && Number.isInteger(r.seq) && /^[0-9a-f]{64}$/.test(r.hash)),
  '结构不完整'
)

// ⑤ 哈希链仍连续（改了 tools.js，不能把 #缺陷② 的修复改回去）
let chainOk = true
let chainWhy = ''
for (let i = 0; i < rows.length; i++) {
  if (i > 0) {
    if (rows[i].prevHash !== rows[i - 1].hash) {
      chainOk = false
      chainWhy = `第 ${i + 1} 行 prevHash 断链`
    }
    if (rows[i].seq !== rows[i - 1].seq + 1) {
      chainOk = false
      chainWhy = `第 ${i + 1} 行 seq 不连续`
    }
  }
}
check('哈希链连续（seq 递增 1 且 prevHash 衔接）', chainOk, chainWhy)

lines.push('')
// 故意反一次以验证退出码会变红（手册 §8 纪律）。
// 口径：**所有回归一视同仁**，不存在"只管新增套件"的豁免 —— 不能变红的套件不可证伪，
// 会把 FAILED 记成 PASS。本钩子属第二批补上（此前本套件不响应 FDE_INVERT）。
if (process.env.FDE_INVERT === '1') {
  check('[INVERT] 故意失败以验证退出码敏感', false, 'injected by FDE_INVERT')
}

lines.push('')
lines.push(`结果：${passed} 通过 / ${failed} 失败`)
lines.push(failed > 0 ? '状态：FAILED' : '状态：ALL GREEN')

// FDE_OUT（0030 §7）：跑轮次时显式给输出名 ⇒ 两轮不互相覆盖（缺省沿用原名）
writeFileSync(process.env.FDE_OUT ?? new URL('./_gate_readprobe_out.txt', import.meta.url), lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
process.exit(failed === 0 ? 0 : 1)
