/**
 * dsh-fde-ontology-gate C1 变更分级（L0/L1/L2）离线回归。
 *
 * 跑法： node _fde_classify_test.mjs
 *       故意验证退出码会变红： FDE_INVERT=1 node _fde_classify_test.mjs
 *
 * 结果自己写文件（`_classify_test_out.txt`）—— 不走控制台（Windows 代码页纪律）。
 *
 * 覆盖（施工单 0091 §5）：
 *   L0 正（新增 allow）／L0 反（新增 deny → L1）
 *   L1 正（改阈值）／L1 反（改适用范围 → L2）
 *   L2 正（触剂量 / 改 site enum / 受监管行业改 deny）
 *   L2 反（非受监管行业改 deny → L1）
 *   fail-closed（坏 YAML → L2；非 ontology 文件 → L2）
 *   resolveManualLevel（升级 / 降级 / 同档 / 缺省）
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyChange, resolveManualLevel, isRegulatedIndustry } from './dsh-fde-ontology-gate/lib/classify.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_classify_test_out.txt')
const lines = []
let passed = 0
let failed = 0

function t(name, fn) {
  try {
    fn()
    passed += 1
    lines.push(`  ✓ ${name}`)
  } catch (e) {
    failed += 1
    lines.push(`  ✗ ${name}`)
    lines.push(`      ${e && e.message ? e.message : String(e)}`)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败')
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg || '不相等'}：期望 ${e}，实际 ${a}`)
}

// ---------------------------------------------------------------- 夹具
// ⚠️ 行内值必须是**合法 JSON**（parseYamlSubset 的要求）；字段名避开关键词表
//    （dose/剂量/上限/site/range/…），否则中性用例会误中 L2。
const LOGIC_ALLOW = `rules:
  - id: r1
    effect: allow
    reason: 常规建议
    condition: {">": [{"var": "treatment.score"}, 0]}
`

const LOGIC_ALLOW_PLUS_ALLOW = `rules:
  - id: r1
    effect: allow
    reason: 常规建议
    condition: {">": [{"var": "treatment.score"}, 0]}
  - id: r2
    effect: allow
    reason: 常规建议二
    condition: {">": [{"var": "treatment.score"}, 5]}
`

const LOGIC_ALLOW_PLUS_DENY = `rules:
  - id: r1
    effect: allow
    reason: 常规建议
    condition: {">": [{"var": "treatment.score"}, 0]}
  - id: r2
    effect: deny
    reason: 分数超限
    condition: {">": [{"var": "treatment.score"}, 100]}
`

const LOGIC_CHANGE_THRESHOLD = `rules:
  - id: r1
    effect: allow
    reason: 常规建议
    condition: {">": [{"var": "treatment.score"}, 10]}
`

const LOGIC_DENY = `rules:
  - id: r1
    effect: deny
    reason: 分数超限
    condition: {">": [{"var": "treatment.score"}, 100]}
`

const LOGIC_DENY_CHANGED = `rules:
  - id: r1
    effect: deny
    reason: 分数超限
    condition: {">": [{"var": "treatment.score"}, 90]}
`

const OBJECTS_BASE = `objects:
  - name: treatment
    attributes:
      - name: score
        type: number
`

const OBJECTS_ADD_DOSE = `objects:
  - name: treatment
    attributes:
      - name: score
        type: number
      - name: dose_mg
        type: number
        min: 0
        max: 100
`

const OBJECTS_ADD_SITE_ENUM = `objects:
  - name: treatment
    attributes:
      - name: score
        type: number
      - name: site
        type: string
        enum: ["面部", "胸部"]
`

// ---------------------------------------------------------------- 测试体
lines.push('== dsh-fde-ontology-gate C1 变更分级回归 ==')

// ---- isRegulatedIndustry（照抄自 phase/check-d5，核对语义一致） ----
t('isRegulatedIndustry：medical-* 受监管，其余不受监管', () => {
  assertEq(isRegulatedIndustry('medical-aesthetics'), true)
  assertEq(isRegulatedIndustry('medical'), true)
  assertEq(isRegulatedIndustry('retail'), false)
  assertEq(isRegulatedIndustry('未声明'), false)
  assertEq(isRegulatedIndustry(''), false)
  assertEq(isRegulatedIndustry(undefined), false)
})

// ---- L0 ----
t('L0 正：仅新增 effect:allow 规则 → L0', () => {
  const r = classifyChange({ path: 'logic.yaml', newText: LOGIC_ALLOW_PLUS_ALLOW, oldText: LOGIC_ALLOW })
  assertEq(r.level, 'L0')
  assertEq(r.added, 1)
  assertEq(r.modified, 0)
  assertEq(r.deleted, 0)
})

t('L0 正：全新创建（oldText 空）单条 allow → L0', () => {
  const r = classifyChange({ path: 'logic.yaml', newText: LOGIC_ALLOW, oldText: '' })
  assertEq(r.level, 'L0')
  assertEq(r.added, 1)
})

t('L0 反：新增 effect:deny 规则 → L1', () => {
  const r = classifyChange({ path: 'logic.yaml', newText: LOGIC_ALLOW_PLUS_DENY, oldText: LOGIC_ALLOW })
  assertEq(r.level, 'L1')
})

// ---- L1 ----
t('L1 正：改阈值（同 id、condition 变）→ L1', () => {
  const r = classifyChange({ path: 'logic.yaml', newText: LOGIC_CHANGE_THRESHOLD, oldText: LOGIC_ALLOW })
  assertEq(r.level, 'L1')
  assertEq(r.modified, 1)
  assertEq(r.added, 0)
})

t('L1 正：新增 deny 不触临床语义 → L1', () => {
  const r = classifyChange({ path: 'logic.yaml', newText: LOGIC_ALLOW_PLUS_DENY, oldText: LOGIC_ALLOW })
  assertEq(r.level, 'L1')
})

// ---- L2 ----
t('L2 正：新增 dose_mg 属性（触临床判定）→ L2', () => {
  const r = classifyChange({ path: 'objects.yaml', newText: OBJECTS_ADD_DOSE, oldText: OBJECTS_BASE })
  assertEq(r.level, 'L2')
  assert(r.reasons.some((x) => x.includes('临床')), `应含临床理由，实际 ${JSON.stringify(r.reasons)}`)
})

t('L2 正：新增 site 属性带 enum（触适用范围）→ L2', () => {
  const r = classifyChange({ path: 'objects.yaml', newText: OBJECTS_ADD_SITE_ENUM, oldText: OBJECTS_BASE })
  assertEq(r.level, 'L2')
})

t('L2 正：受监管行业 + 改 deny 规则 → L2', () => {
  const r = classifyChange({
    path: 'logic.yaml',
    newText: LOGIC_DENY_CHANGED,
    oldText: LOGIC_DENY,
    industry: 'medical-aesthetics'
  })
  assertEq(r.level, 'L2')
})

t('L2 反：非受监管行业 + 改 deny 规则 → L1', () => {
  const r = classifyChange({
    path: 'logic.yaml',
    newText: LOGIC_DENY_CHANGED,
    oldText: LOGIC_DENY,
    industry: '未声明'
  })
  assertEq(r.level, 'L1')
})

// ---- fail-closed ----
t('fail-closed：坏 YAML（Tab 缩进）→ L2', () => {
  const bad = 'rules:\n\t- id: r1\n\t  effect: allow\n'
  const r = classifyChange({ path: 'logic.yaml', newText: bad, oldText: LOGIC_ALLOW })
  assertEq(r.level, 'L2')
  assert(r.reasons.some((x) => x.includes('解析失败')), `应含解析失败理由，实际 ${JSON.stringify(r.reasons)}`)
})

t('fail-closed：非 ontology 文件（compliance.yaml）→ L2', () => {
  const r = classifyChange({ path: 'compliance.yaml', newText: 'output_boundary: x\n', oldText: '' })
  assertEq(r.level, 'L2')
})

// ---- resolveManualLevel（手动升降级） ----
t('手动升降级：自动 L0 + 请求 L1 → 升级（downgraded=false）', () => {
  const r = resolveManualLevel('L0', 'L1')
  assertEq(r, { level: 'L1', downgraded: false })
})

t('手动升降级：自动 L2 + 请求 L1 → 降级（downgraded=true）', () => {
  const r = resolveManualLevel('L2', 'L1')
  assertEq(r.level, 'L2')
  assertEq(r.downgraded, true)
  assertEq(r.requestedLevel, 'L1')
  assertEq(r.autoLevel, 'L2')
})

t('手动升降级：自动 L2 + 请求 L2 → 同档（downgraded=false）', () => {
  const r = resolveManualLevel('L2', 'L2')
  assertEq(r, { level: 'L2', downgraded: false })
})

t('手动升降级：缺省（无请求）→ 用自动级别', () => {
  const r = resolveManualLevel('L0', undefined)
  assertEq(r, { level: 'L0', downgraded: false })
})

// ================================================================ 收尾
lines.push('')
if (process.env.FDE_INVERT === '1') {
  t('[INVERT] 故意失败以验证退出码敏感', () => assert(false, 'injected by FDE_INVERT'))
}
lines.push(`通过 ${passed} / 失败 ${failed}`)
lines.push(failed > 0 ? 'RESULT: FAIL' : 'RESULT: PASS')
writeFileSync(process.env.FDE_OUT ?? OUT, lines.join('\n') + '\n', 'utf8')

console.log(`[classify-test] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
