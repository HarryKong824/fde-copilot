/**
 * dsh-fde-dsl 离线回归。
 *
 * 跑法：
 *   node _fde_dsl_test.mjs
 *
 * 结果**自己写文件**（`_dsl_test_out.txt`）—— 不走控制台。
 * 原因：Windows 控制台代码页会把中文打成乱码，看着像"没输出/程序挂了"，
 * 而这个项目的第一条纪律就是"只信实测"，输出不可读等于没跑。
 *
 * @deepseek-ai/dsh-tools 用的是工作区根的本地桩（只有 defineTool），
 * 所以 tools.js 能被真实 import；config-schema.js 依赖 schemastery，**不在本测试覆盖内**。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync, writeFileSync as writeFile } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../dsh-fde-dsl/lib/config.js'
import { parseYamlSubset } from '../dsh-fde-dsl/lib/yamlsubset.js'
import {
  applyMaturityOverrides,
  parseMaturityDoc,
  parseObjectsDoc,
  parseRulesDoc
} from '../dsh-fde-dsl/lib/schema.js'
import { collectVars, compileRuleCondition, evaluate } from '../dsh-fde-dsl/lib/dsl.js'
import { candidatesForLeaf, deriveCases, expectedTruth, makeCaseId } from '../dsh-fde-dsl/lib/derive.js'
import { validateOntology } from '../dsh-fde-dsl/lib/validate.js'
import { installValidationTool, renderReport } from '../dsh-fde-dsl/lib/tools.js'

const lines = []
let passed = 0
let failed = 0

function t(name, fn) {
  try {
    const r = fn()
    if (r instanceof Promise) throw new Error('同步用例请传同步函数')
    passed += 1
    lines.push(`  ✓ ${name}`)
  } catch (e) {
    failed += 1
    lines.push(`  ✗ ${name}`)
    lines.push(`      ${e && e.message ? e.message : String(e)}`)
  }
}

async function ta(name, fn) {
  try {
    await fn()
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

function assertThrowsCode(pattern, fn, msg) {
  let threw = null
  try {
    fn()
  } catch (e) {
    threw = e
  }
  if (!threw) throw new Error(`${msg || '期望抛错'}：没有抛`)
  const hay = `${threw.code ?? ''} ${threw.message ?? ''}`
  if (!hay.includes(pattern)) {
    throw new Error(`${msg || '错误码不符'}：期望包含 "${pattern}"，实际 ${hay}`)
  }
}

// ---------------------------------------------------------------- 测试夹具

const OBJECTS_YAML = `objects:
  - name: treatment
    attributes:
      - name: dose_mg
        type: number
        step: 1
        min: 0
        max: 200
        maturity: verified
      - name: site
        type: string
        enum: ["face", "body", "neck", "hands"]
        maturity: verified
      - name: is_first_visit
        type: boolean
        maturity: verified
      - name: note
        type: string
`

const LOGIC_YAML = `rules:
  - id: R001
    effect: deny
    reason: 剂量超过单次上限
    condition: {">": [{"var": "treatment.dose_mg"}, 100]}
  - id: R002
    effect: warn
    reason: 面部项目需二次确认
    condition: {"==": [{"var": "treatment.site"}, "face"]}
  - id: R003
    effect: deny
    reason: 首访且剂量非零需复核
    condition: {"and": [{"==": [{"var": "treatment.is_first_visit"}, true]}, {"!=": [{"var": "treatment.dose_mg"}, 0]}]}
`

function cfgOf(over = {}) {
  return normalizeConfig({ ontologyRoot: 'E:/ontologyRoot', ...over })
}

function loadFixture(cfg = cfgOf(), objectsText = OBJECTS_YAML, logicText = LOGIC_YAML) {
  const { attributes } = parseObjectsDoc(objectsText, cfg)
  const rules = parseRulesDoc(logicText, cfg)
  return { attributes, rules }
}

lines.push('== dsh-fde-dsl 离线回归 ==')
lines.push('')

// ---------------------------------------------------------------- A. config

t('config: ontologyRoot 缺失必须抛错（fail-closed）', () => {
  assertThrowsCode('ontologyRoot', () => normalizeConfig({}))
})

t('config: mode 非法值必须抛错', () => {
  assertThrowsCode('mode', () => normalizeConfig({ ontologyRoot: 'x', mode: 'maybe' }))
})

t('config: 默认值符合 v3 Stage 4 完成判据口径', () => {
  const c = cfgOf()
  assertEq(c.minRules, 3, 'minRules')
  assertEq(c.minCasesPerRule, 5, 'minCasesPerRule')
  assert(typeof c.maxCombos === 'number' && c.maxCombos > 0, 'maxCombos 应为正数')
})

// ---------------------------------------------------------------- B. YAML 子集

t('yaml: 能解析 attributes 嵌套列表与行内 JSON 数组', () => {
  const doc = parseYamlSubset(OBJECTS_YAML, 'objects.yaml')
  assertEq(doc.objects[0].name, 'treatment', '对象名')
  assertEq(doc.objects[0].attributes[0].step, 1, 'step')
  assertEq(doc.objects[0].attributes[1].enum, ['face', 'body', 'neck', 'hands'], 'enum')
})

t('yaml: 条件写行内 JSON 能原样取出', () => {
  const doc = parseYamlSubset(LOGIC_YAML, 'logic.yaml')
  assertEq(doc.rules[0].condition['>'][1], 100, '阈值')
})

t('yaml: Tab 缩进必须报错', () => {
  assertThrowsCode('Tab', () => parseYamlSubset('objects:\n\t- name: x\n'))
})

t('yaml: yes/no 必须报错（YAML 1.1/1.2 语义不一致）', () => {
  assertThrowsCode('语义不一致', () => parseYamlSubset('objects:\n  flag: yes\n'))
})

t('yaml: 多文档标记必须报错', () => {
  assertThrowsCode('多文档', () => parseYamlSubset('---\nobjects: []\n'))
})

t('yaml: 行内 JSON 不合法必须报错并带行号', () => {
  assertThrowsCode('第 2 行', () => parseYamlSubset('rules:\n  cond: {">": [1,\n'))
})

t('yaml: 重复键必须报错', () => {
  assertThrowsCode('重复键', () => parseYamlSubset('objects: []\nobjects: []\n'))
})

t('yaml: 顶层必须是映射', () => {
  assertThrowsCode('顶层必须是映射', () => parseYamlSubset('- a\n- b\n'))
})

t('yaml: 双引号支持 \\n 转义', () => {
  const doc = parseYamlSubset('reason: "a\\nb"\n')
  assertEq(doc.reason, 'a\nb', '转义换行')
})

t('yaml: 键为单 Key 且有值时正确解析标量类型', () => {
  const doc = parseYamlSubset('n: 3\ns: abc\nb: true\nz: null\n')
  assertEq([doc.n, doc.s, doc.b, doc.z], [3, 'abc', true, null], '标量类型')
})

// ---------------------------------------------------------------- C. schema

t('schema: attributes 索引为 对象.属性，成熟度按声明取', () => {
  const { attributes } = loadFixture()
  assert(attributes.has('treatment.dose_mg'), '应有 dose_mg')
  assertEq(attributes.get('treatment.dose_mg').maturity, 'verified', 'dose_mg 成熟度')
})

t('schema: 未写 maturity 的属性一律当 draft（fail-closed）', () => {
  const { attributes } = loadFixture()
  assertEq(attributes.get('treatment.note').maturity, 'draft', 'note 成熟度')
})

t('schema: 重复属性必须报错', () => {
  assertThrowsCode('DuplicateAttribute', () =>
    parseObjectsDoc('objects:\n  - name: a\n    attributes:\n      - name: x\n        type: number\n      - name: x\n        type: number\n', cfgOf())
  )
})

t('schema: 未知类型必须报错', () => {
  assertThrowsCode('UnknownType', () =>
    parseObjectsDoc('objects:\n  - name: a\n    attributes:\n      - name: x\n        type: blob\n', cfgOf())
  )
})

t('schema: min > max 必须报错', () => {
  assertThrowsCode('min(10) 大于 max(1)', () =>
    parseObjectsDoc('objects:\n  - name: a\n    attributes:\n      - name: x\n        type: number\n        min: 10\n        max: 1\n', cfgOf())
  )
})

t('schema: step 非正数必须报错', () => {
  assertThrowsCode('必须为正数', () =>
    parseObjectsDoc('objects:\n  - name: a\n    attributes:\n      - name: x\n        type: number\n        step: 0\n', cfgOf())
  )
})

t('schema: maturity.yaml 覆盖生效', () => {
  const { attributes } = loadFixture()
  const overrides = parseMaturityDoc('nodes:\n  treatment.note: verified\n', cfgOf())
  applyMaturityOverrides(attributes, overrides)
  assertEq(attributes.get('treatment.note').maturity, 'verified', '覆盖后成熟度')
})

t('schema: maturity.yaml 引用未知属性必须报错', () => {
  const { attributes } = loadFixture()
  const overrides = parseMaturityDoc('nodes:\n  treatment.nope: verified\n', cfgOf())
  assertThrowsCode('UnknownAttribute', () => applyMaturityOverrides(attributes, overrides))
})

t('schema: 规则 id 重复必须报错', () => {
  assertThrowsCode('DuplicateRuleId', () =>
    parseRulesDoc(
      'rules:\n  - id: A\n    effect: deny\n    reason: r\n    condition: {"==": [1,1]}\n  - id: A\n    effect: deny\n    reason: r2\n    condition: {"==": [1,1]}\n',
      cfgOf()
    )
  )
})

t('schema: 未知 effect 必须报错', () => {
  assertThrowsCode('UnknownEffect', () =>
    parseRulesDoc('rules:\n  - id: A\n    effect: explode\n    reason: r\n    condition: {"==": [1,1]}\n', cfgOf())
  )
})

t('schema: 缺 condition 必须报错', () => {
  assertThrowsCode('条件必填', () =>
    parseRulesDoc('rules:\n  - id: A\n    effect: deny\n    reason: r\n', cfgOf())
  )
})

// ---------------------------------------------------------------- D. DSL 引擎

t('dsl: 白名单内算子可求值', () => {
  const c = compileRuleCondition({ '>': [{ var: 'a' }, 1] })
  assertEq(c.eval({ a: 2 }), true, '2 > 1')
  assertEq(c.eval({ a: 0 }), false, '0 > 1')
})

t('dsl: 未知算子必须报错（这是白名单的核心）', () => {
  assertThrowsCode('UnknownOperator', () => compileRuleCondition({ map: [{ var: 'a' }] }))
})

t('dsl: 一个对象多个算��键必须报错', () => {
  assertThrowsCode('MultipleKeys', () =>
    compileRuleCondition({ '>': [{ var: 'a' }, 1], '<': [{ var: 'a' }, 9] })
  )
})

t('dsl: 比较元数不对必须报错', () => {
  assertThrowsCode('BadArity', () => compileRuleCondition({ '>': [{ var: 'a' }] }))
})

t('dsl: 两侧类型不一致必须报错（不猜语义）', () => {
  assertThrowsCode('TypeMismatch', () => compileRuleCondition({ '>': [{ var: 'a' }, 'x'] }).eval({ a: 1 }))
})

t('dsl: 变量未出现在输入里必须报错', () => {
  assertThrowsCode('UnknownVariable', () => compileRuleCondition({ '>': [{ var: 'a' }, 1] }).eval({}))
})

t('dsl: 条件结果非布尔必须报错', () => {
  assertThrowsCode('NonBooleanResult', () => compileRuleCondition({ var: 'a' }).eval({ a: 1 }))
})

t('dsl: and / or / ! / in 语义正确', () => {
  assertEq(compileRuleCondition({ and: [{ '>': [{ var: 'a' }, 1] }, true] }).eval({ a: 2 }), true, 'and')
  assertEq(compileRuleCondition({ and: [{ '>': [{ var: 'a' }, 5] }, true] }).eval({ a: 2 }), false, 'and 假')
  assertEq(compileRuleCondition({ or: [{ '>': [{ var: 'a' }, 5] }, true] }).eval({ a: 2 }), true, 'or')
  assertEq(compileRuleCondition({ '!': { '>': [{ var: 'a' }, 5] } }).eval({ a: 2 }), true, '!')
  assertEq(compileRuleCondition({ in: [{ var: 's' }, ['a', 'b']] }).eval({ s: 'b' }), true, 'in 命中')
  assertEq(compileRuleCondition({ in: [{ var: 's' }, ['a', 'b']] }).eval({ s: 'z' }), false, 'in 未命中')
})

t('dsl: 布尔字面量可作条件（JSON Logic 常规写法），但数字不行', () => {
  assertEq(compileRuleCondition(true).eval({}), true, '顶层 true')
  assertEq(compileRuleCondition({ and: [true, true] }).eval({}), true, 'and 全字面量')
  // 数字当条件在**编译期**就拒（比拖到求值期报错更早、定位更准）
  assertThrowsCode('NonOperatorCondition', () => compileRuleCondition(1))
})

t('dsl: 常量在左要翻转算子（100 < dose ⇒ dose > 100）', () => {
  const c = compileRuleCondition({ '<': [100, { var: 'treatment.dose_mg' }] })
  assertEq(c.leaves.length, 1, '叶子数')
  assertEq(c.leaves[0].op, '>', '翻转后的算子')
  assertEq(c.leaves[0].path, 'treatment.dose_mg', '叶子路径')
  assertEq(c.leaves[0].value, 100, '阈值')
})

t('dsl: collectVars 能取出全部变量路径', () => {
  const c = compileRuleCondition({ and: [{ '>': [{ var: 'a' }, 1] }, { '==': [{ var: 'b' }, 2] }] })
  assertEq([...collectVars(c.ast)].sort(), ['a', 'b'], '变量集合')
})

// ---------------------------------------------------------------- E. 派生

t('derive: 数值叶子的候选值含阈值三件套与值域两端', () => {
  const cfg = cfgOf()
  const { attributes } = loadFixture(cfg)
  const attr = attributes.get('treatment.dose_mg')
  const got = candidatesForLeaf({ path: 'treatment.dose_mg', op: '>', value: 100 }, attr)
  assertEq(got, [99, 100, 101, 0, -1, 200, 201], '候选值序列')
})

t('derive: 字符串 enum 派生全部成员 + 哨兵非成员', () => {
  const cfg = cfgOf()
  const { attributes } = loadFixture(cfg)
  const got = candidatesForLeaf({ path: 'treatment.site', op: '==', value: 'face' }, attributes.get('treatment.site'))
  assertEq(got, ['face', 'body', 'neck', 'hands', '__fde_out_of_enum__'], '候选值序列')
})

t('derive: expectedTruth 覆盖六类比较', () => {
  assertEq(expectedTruth('>', 101, 100), true, '>')
  assertEq(expectedTruth('>', 100, 100), false, '> 边界')
  assertEq(expectedTruth('>=', 100, 100), true, '>= 边界')
  assertEq(expectedTruth('<', 99, 100), true, '<')
  assertEq(expectedTruth('<=', 100, 100), true, '<= 边界')
  assertEq(expectedTruth('==', 100, 100), true, '==')
  assertEq(expectedTruth('!=', 99, 100), true, '!=')
  assertEq(expectedTruth('in', 'a', ['a', 'b']), true, 'in 命中')
  assertEq(expectedTruth('in', 'z', ['a', 'b']), false, 'in 未命中')
})

t('derive: 同路径不同阈值的用例 id 必须不同（防撞号丢用例）', () => {
  const leafA = { path: 'x', op: '>', value: 100 }
  const leafB = { path: 'x', op: '<', value: 200 }
  const data = { x: 150 }
  const idA = makeCaseId('R', 'x', leafA, data)
  const idB = makeCaseId('R', 'x', leafB, data)
  assert(idA !== idB, `同输入不同阈值的用例 id 撞了：${idA}`)
})

t('derive: 多叶子规则会产出组合用例（焦点为 *）', () => {
  const cfg = cfgOf()
  const { attributes, rules } = loadFixture(cfg)
  const r003 = rules.find((r) => r.id === 'R003')
  const { cases } = deriveCases({
    rule: r003,
    compiled: compileRuleCondition(r003.condition, 'R003'),
    attributes,
    maxCombos: cfg.maxCombos
  })
  assert(cases.some((c) => c.focus === '*'), '应存在组合用例')
  assert(cases.some((c) => c.expectedLeaf === null), '组合用例不做叶子级断言')
})

// ---------------------------------------------------------------- F. D3 编排

t('D3: 合规样例整体通过，且满足 v3「3 规则 ≥15 反例」', () => {
  const cfg = cfgOf()
  const { attributes, rules } = loadFixture(cfg)
  const report = validateOntology({ attributes, rules, cfg })
  assert(report.passed, `应当通过，失败项：${report.failures.map((f) => f.code).join(',')}`)
  assert(report.summary.cases >= 15, `反例总数应 ≥15，实际 ${report.summary.cases}`)
  const minPerRule = Math.min(...report.rules.map((r) => r.cases))
  assert(minPerRule >= cfg.minCasesPerRule, `每条规则应 ≥${cfg.minCasesPerRule} 条，最少 ${minPerRule}`)
})

t('D3: 每条规则都要有触发与不触发两种用例', () => {
  const cfg = cfgOf()
  const { attributes, rules } = loadFixture(cfg)
  const report = validateOntology({ attributes, rules, cfg })
  for (const r of report.rules) {
    assert(r.firesTrue > 0, `${r.id} 没有触发用例`)
    assert(r.firesFalse > 0, `${r.id} 没有不触发用例`)
  }
})

t('D3: and 规则不得被误判成 RuleNeverFires（多叶子组合覆盖）', () => {
  const cfg = cfgOf()
  const { attributes, rules } = loadFixture(cfg)
  const report = validateOntology({ attributes, rules, cfg })
  const codes = report.failures.filter((f) => f.ruleId === 'R003').map((f) => f.code)
  assert(!codes.includes('RuleNeverFires'), `R003 被误判：${codes.join(',')}`)
})

t('D3: deny 规则引用 draft 属性必须失败（v3 铁律）', () => {
  const cfg = cfgOf()
  const { attributes, rules } = loadFixture(cfg)
  rules[0] = {
    ...rules[0],
    condition: { '>': [{ var: 'treatment.note' }, ''] }
  }
  const report = validateOntology({ attributes, rules, cfg })
  assert(report.failures.some((f) => f.code === 'DraftReference'), '应报 DraftReference')
})

t('D3: 非 deny 规则引用 draft 属性不算失败', () => {
  const cfg = cfgOf()
  const { attributes, rules } = loadFixture(cfg)
  rules[1] = { ...rules[1], condition: { '==': [{ var: 'treatment.note' }, 'x'] } }
  const report = validateOntology({ attributes, rules, cfg })
  assert(!report.failures.some((f) => f.code === 'DraftReference'), '不应报 DraftReference')
})

t('D3: 规则数不足必须失败', () => {
  const cfg = cfgOf()
  const { attributes, rules } = loadFixture(cfg)
  const report = validateOntology({ attributes, rules: rules.slice(0, 2), cfg })
  assert(report.failures.some((f) => f.code === 'TooFewRules'), '应报 TooFewRules')
})

t('D3: 反例数不足必须失败且给出补齐办法', () => {
  const cfg = cfgOf()
  const objectsText =
    'objects:\n  - name: a\n    attributes:\n      - name: x\n        type: number\n        maturity: verified\n'
  const logicText =
    'rules:\n' +
    '  - id: A\n    effect: deny\n    reason: r1\n    condition: {">": [{"var": "a.x"}, 1]}\n' +
    '  - id: B\n    effect: deny\n    reason: r2\n    condition: {"<": [{"var": "a.x"}, 9]}\n' +
    '  - id: C\n    effect: deny\n    reason: r3\n    condition: {">=": [{"var": "a.x"}, 5]}\n'
  const { attributes, rules } = loadFixture(cfg, objectsText, logicText)
  const report = validateOntology({ attributes, rules, cfg })
  const hit = report.failures.find((f) => f.code === 'TooFewCases')
  assert(!!hit, '应报 TooFewCases')
  assert(hit.message.includes('min'), '失败信息里应给出补齐办法')
})

t('D3: 自相矛盾的复合规则必须报 RuleNeverFires', () => {
  // ⚠️ 为什么不用单叶子规则测：候选值**刻意包含阈值两侧**（t-step / t+step），
  //    所以单叶子比较天然既有命中也有未命中，结构上不可能"永不触发"。
  //    真正会触发这条判据的是**复合条件互相矛盾** —— 这是取оговор的前提。
  const cfg = cfgOf()
  const objectsText =
    'objects:\n  - name: a\n    attributes:\n      - name: x\n        type: number\n        min: 0\n        max: 200\n        maturity: verified\n'
  const logicText =
    'rules:\n' +
    '  - id: A\n    effect: deny\n    reason: r1\n    condition: {"and": [{">": [{"var": "a.x"}, 150]}, {"<": [{"var": "a.x"}, 50]}]}\n' +
    '  - id: B\n    effect: deny\n    reason: r2\n    condition: {"<": [{"var": "a.x"}, 5]}\n' +
    '  - id: C\n    effect: deny\n    reason: r3\n    condition: {">=": [{"var": "a.x"}, 2]}\n'
  const { attributes, rules } = loadFixture(cfg, objectsText, logicText)
  const report = validateOntology({ attributes, rules, cfg })
  assert(
    report.failures.some((f) => f.code === 'RuleNeverFires' && f.ruleId === 'A'),
    `应报 A 永不触发，实际失败项：${report.failures.map((f) => `${f.ruleId}:${f.code}`).join(',')}`
  )
})

t('D3: 恒真的复合规则必须报 RuleAlwaysFires', () => {
  const cfg = cfgOf()
  const objectsText =
    'objects:\n  - name: a\n    attributes:\n      - name: x\n        type: number\n        min: 0\n        max: 200\n        maturity: verified\n'
  const logicText =
    'rules:\n' +
    '  - id: A\n    effect: deny\n    reason: r1\n    condition: {"or": [{">": [{"var": "a.x"}, -1]}, {"<": [{"var": "a.x"}, 1000]}]}\n' +
    '  - id: B\n    effect: deny\n    reason: r2\n    condition: {"<": [{"var": "a.x"}, 5]}\n' +
    '  - id: C\n    effect: deny\n    reason: r3\n    condition: {">=": [{"var": "a.x"}, 2]}\n'
  const { attributes, rules } = loadFixture(cfg, objectsText, logicText)
  const report = validateOntology({ attributes, rules, cfg })
  assert(
    report.failures.some((f) => f.code === 'RuleAlwaysFires' && f.ruleId === 'A'),
    `应报 A 恒真，实际失败项：${report.failures.map((f) => `${f.ruleId}:${f.code}`).join(',')}`
  )
})

t('D3: 引用未声明属性必须报 UnknownAttribute', () => {
  const cfg = cfgOf()
  const { attributes, rules } = loadFixture(cfg)
  rules[0] = { ...rules[0], condition: { '>': [{ var: 'treatment.ghost' }, 1] } }
  const report = validateOntology({ attributes, rules, cfg })
  assert(report.failures.some((f) => f.code === 'UnknownAttribute'), '应报 UnknownAttribute')
})

t('D3: deny 规则的不可派生分支判失败，非 deny 只提示', () => {
  const cfg = cfgOf()
  const { attributes, rules } = loadFixture(cfg)
  const both = { '==': [{ var: 'treatment.dose_mg' }, { var: 'treatment.site' }] }
  rules[0] = { ...rules[0], condition: both }
  rules[1] = { ...rules[1], condition: both }
  const report = validateOntology({ attributes, rules, cfg })
  assert(report.failures.some((f) => f.code === 'NonDerivable' && f.ruleId === 'R001'), 'deny 应判失败')
  assert(report.warnings.some((w) => w.code === 'NonDerivable' && w.ruleId === 'R002'), 'warn 应只提示')
})

t('D3: 同一份输入产出同一个用例集指纹（可复现）', () => {
  const cfg = cfgOf()
  const a = loadFixture(cfg)
  const b = loadFixture(cfg)
  const ra = validateOntology({ attributes: a.attributes, rules: a.rules, cfg })
  const rb = validateOntology({ attributes: b.attributes, rules: b.rules, cfg })
  assertEq(ra.summary.fingerprint, rb.summary.fingerprint, '指纹应稳定')
  assert(ra.summary.fingerprint.length > 0, '指纹不应为空')
})

t('D3: examples/ 里的样例文件真的能过（用户会直接复制上线，不能只靠夹具）', () => {
  const cfg = cfgOf()
  const dir = new URL('../dsh-fde-dsl/examples/', import.meta.url)
  const objectsText = readFileSync(new URL('objects.yaml', dir), 'utf8')
  const logicText = readFileSync(new URL('logic.yaml', dir), 'utf8')
  const { attributes, rules } = loadFixture(cfg, objectsText, logicText)
  const report = validateOntology({ attributes, rules, cfg })
  assert(report.passed, `样例应通过，失败项：${report.failures.map((f) => `${f.ruleId}:${f.code}`).join(',')}`)
  assert(report.summary.cases >= 15, `样例反例数应 ≥15，实际 ${report.summary.cases}`)
})

// ---------------------------------------------------------------- G. 工具层（桩）

const SENTINEL = 'ZZ_classified_content_ZZ'

async function toolLayer() {
  const dir = mkdtempSync(join(tmpdir(), 'fde-dsl-'))
  const objectsText = OBJECTS_YAML.replace('maturity: verified', `maturity: verified\n        # ${SENTINEL}`)
  writeFile(join(dir, 'objects.yaml'), objectsText, 'utf8')
  writeFile(join(dir, 'logic.yaml'), LOGIC_YAML, 'utf8')

  const captured = {}
  const ctx = {
    tools: {
      register(def) {
        captured.def = def
        return () => {}
      }
    }
  }

  const cfg = cfgOf({ ontologyRoot: dir })
  installValidationTool(ctx, cfg)
  return { dir, captured, cfg }
}

await ta('tools: 工具参数里没有任何跳过用例的口子（用例不可删靠"没有参数"实现）', async () => {
  const { captured } = await toolLayer()
  const params = Object.keys(captured.def.parameters ?? {})
  assertEq(params, ['reason'], '参数清单')
  for (const forbidden of ['skip', 'only', 'exclude', 'expected', 'cases']) {
    assert(!params.includes(forbidden), `不该存在参数 ${forbidden}`)
  }
})

await ta('tools: 通过时返回报告且不出错', async () => {
  const { captured } = await toolLayer()
  const out = await captured.def.execute({ reason: '回归' })
  assertEq(out.passed, true, '应通过')
  assert(out.summary.cases >= 15, `反例数应 ≥15，实际 ${out.summary.cases}`)
})

await ta('tools: 输出不回显 ontology 内容（否则等于给模型开读通道）', async () => {
  const { captured } = await toolLayer()
  const out = await captured.def.execute({ reason: '回归' })
  const text = JSON.stringify(out)
  assert(!text.includes(SENTINEL), '回显里混进了 ontology 文件内容')
  const rendered = captured.def.output.render({}, out)
  assert(!JSON.stringify(rendered).includes(SENTINEL), '渲染文本里混进了 ontology 内容')
  assert(JSON.stringify(rendered).includes('D3 校验'), '渲染文本应含校验结论')
})

await ta('tools: shadow 模式失败只报告、不抛错', async () => {
  const { dir, captured } = await toolLayer()
  writeFile(join(dir, 'logic.yaml'), 'rules:\n  - id: A\n    effect: deny\n    reason: r\n    condition: {"!=": [{"var": "treatment.dose_mg"}, 0]}\n', 'utf8')
  const cfg = cfgOf({ ontologyRoot: dir, mode: 'shadow' })
  const ctx = { tools: { register: (d) => (captured.def = d) && (() => {}) } }
  installValidationTool(ctx, cfg)
  const out = await captured.def.execute({ reason: '影子' })
  assertEq(out.passed, false, '应为不通过')
  assert(out.summary.failures > 0, '失败项应大于 0')
})

await ta('tools: enforce 模式失败必须抛错（isError）', async () => {
  const { dir, captured } = await toolLayer()
  writeFile(join(dir, 'logic.yaml'), 'rules:\n  - id: A\n    effect: deny\n    reason: r\n    condition: {"!=": [{"var": "treatment.dose_mg"}, 0]}\n', 'utf8')
  const cfg = cfgOf({ ontologyRoot: dir, mode: 'enforce' })
  let threw = null
  const ctx = { tools: { register: (d) => (captured.def = d) && (() => {}) } }
  installValidationTool(ctx, cfg)
  try {
    await captured.def.execute({ reason: '正式' })
  } catch (e) {
    threw = e
  }
  assert(!!threw, 'enforce 下失败应抛错')
  assert(threw.message.includes('D3 校验'), '抛出信息应含校验结论')
})

await ta('tools: 缺必需文件时明确报错，不静默放行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fde-dsl-missing-'))
  writeFile(join(dir, 'objects.yaml'), OBJECTS_YAML, 'utf8')
  const captured = {}
  const cfg = cfgOf({ ontologyRoot: dir })
  installValidationTool({ tools: { register: (d) => (captured.def = d) && (() => {}) } }, cfg)
  let threw = null
  try {
    await captured.def.execute({})
  } catch (e) {
    threw = e
  }
  assert(!!threw, '应抛错')
  assert(threw.message.includes('缺少必需文件'), `错误应说明缺文件：${threw.message}`)
})

// ------------------------------------------------ §10.1 报告必须能自助定位（只给文件名）

const PUBLIC_FILES = new Set(['logic.yaml', 'objects.yaml', 'maturity.yaml'])

t('§10.1: 每条失败/提示都带 file 字段，且只可能是已公开的文件名', () => {
  const cfg = cfgOf()
  const { attributes, rules } = loadFixture(cfg)
  rules[0] = { ...rules[0], condition: { '>': [{ var: 'treatment.note' }, ''] } }
  const report = validateOntology({ attributes, rules, cfg })
  assert(report.failures.length > 0, '这一夹具应产出失败项')
  for (const f of [...report.failures, ...report.warnings]) {
    assert(PUBLIC_FILES.has(f.file), `${f.code} 的 file 字段非法：${JSON.stringify(f.file)}`)
  }
})

t('§10.1: 指路要指到**真正该改**的那个文件', () => {
  const cfg = cfgOf()

  // ① DraftReference 的根因是属性成熟度 → objects.yaml
  const a = loadFixture(cfg)
  a.rules[0] = { ...a.rules[0], condition: { '>': [{ var: 'treatment.note' }, ''] } }
  const r1 = validateOntology({ attributes: a.attributes, rules: a.rules, cfg })
  const draft = r1.failures.find((f) => f.code === 'DraftReference')
  assert(!!draft, '应报 DraftReference')
  assertEq(draft.file, 'objects.yaml', 'DraftReference 应指到 objects.yaml')

  // ② TooFewCases 靠补 min/max/enum 就能解决 → objects.yaml
  // 注意 objects 是**列表**不是映射（第一次写成映射，YAML 子集直接报"期望一个列表"）
  const objectsText =
    'objects:\n  - name: a\n    attributes:\n      - name: x\n        type: number\n        maturity: verified\n'
  const logicText =
    'rules:\n' +
    '  - id: A\n    effect: deny\n    reason: r1\n    condition: {">": [{"var": "a.x"}, 1]}\n' +
    '  - id: B\n    effect: deny\n    reason: r2\n    condition: {"<": [{"var": "a.x"}, 9]}\n' +
    '  - id: C\n    effect: deny\n    reason: r3\n    condition: {">=": [{"var": "a.x"}, 5]}\n'
  const b = loadFixture(cfg, objectsText, logicText)
  const r2 = validateOntology({ attributes: b.attributes, rules: b.rules, cfg })
  const few = r2.failures.find((f) => f.code === 'TooFewCases')
  assert(!!few, '应报 TooFewCases')
  assertEq(few.file, 'objects.yaml', 'TooFewCases 应指到 objects.yaml')

  // ③ 编译类失败根因在条件写法 → logic.yaml
  //    ⚠️ 只盯这条规则自己的失败项：编译时 `continue` 了，但**别的规则**仍会继续跑，
  //    它们可能另外报 TooFewCases（objects.yaml）—— 用"全部"去断言会把别人的结论算进来。
  const c = loadFixture(cfg)
  c.rules[0] = { ...c.rules[0], condition: { nope: [1] } }
  const r3 = validateOntology({ attributes: c.attributes, rules: c.rules, cfg })
  const compileFail = r3.failures.find((f) => f.ruleId === c.rules[0].id)
  assert(!!compileFail, `${c.rules[0].id} 应有失败项`)
  assertEq(compileFail.file, 'logic.yaml', '编译类失败应指到 logic.yaml')
})

t('§10.1: renderReport 把文件名打进回执正文，且仍不回显内容', () => {
  const cfg = cfgOf()
  const { attributes, rules } = loadFixture(cfg)
  rules[0] = { ...rules[0], condition: { '>': [{ var: 'treatment.note' }, ''] } }
  const report = validateOntology({ attributes, rules, cfg })
  const text = renderReport(report)
  assert(text.includes('objects.yaml'), `回执正文应出现文件名，实际：${text}`)
  assert(!text.includes('undefined'), '不得出现空文件名占位')
  assert(!text.includes(SENTINEL), '红线不变：回执仍不得含 ontology 内容')
})

// 方向要反过来写：不是"正文里出现 ≥1 次文件名"（那对**重复**完全不敏感），
// 而是"message 里出现 **0 次**" —— 文件名只能由 file 字段承担，这样改反了才会红。
// 由来：4.2 修掉 DraftReference 后，derive.js 的 UnknownAttribute 是同型漏网
// （message 与 ⟨改：⟩ 各说一次 objects.yaml），而 62/62 照不出来。
t('§10.1: message 只讲"为什么错"，已公开文件名出现 **零次**（唯一事实源 = file 字段）', () => {
  const cfg = cfgOf()

  // 三个场景凑出不同 code 的失败项：属性声明类、未声明属性、条件写法类。
  const scen = (cond) => {
    const fx = loadFixture(cfg)
    fx.rules[0] = { ...fx.rules[0], condition: cond }
    return validateOntology({ attributes: fx.attributes, rules: fx.rules, cfg })
  }
  const reports = [
    scen({ '>': [{ var: 'treatment.note' }, ''] }), // DraftReference / NoCandidate / TooFewCases
    scen({ '>': [{ var: 'treatment.ghost' }, 0] }), // UnknownAttribute（4.2 漏网的那类）
    scen({ nope: [1] }) // 编译错误
  ]

  const items = reports.flatMap((r) => [...r.failures, ...r.warnings])
  assert(items.length >= 3, `样本太少（${items.length} 条）—— 这条断言会变假绿`)

  const codes = new Set(items.map((i) => i.code))
  assert(
    codes.has('UnknownAttribute'),
    `样本必须覆盖 UnknownAttribute（它就是本条要盯的那类），实际 codes=${[...codes].join(',')}`
  )

  for (const it of items) {
    const msg = String(it.message ?? '')
    for (const name of PUBLIC_FILES) {
      assert(
        !msg.includes(name),
        `${it.code} 的 message 里出现了文件名 ${name} —— 「去哪改」只能由 file 字段承担：${msg}`
      )
    }
  }
})

// 故意反一次以验证退出码真的会变红（手册 §8 第二条纪律）。
// 口径：**所有回归一视同仁** —— 不存在「只管新增回归」的豁免。
// 理由是这条纪律的目的：证明本套件**有能力失败**。不能变红的套件无法被证伪，
// 真出事时会把 FAILED 记成 PASS，与本项目「63/63 全绿照样照不出阻断缺陷」同源。
if (process.env.FDE_INVERT === '1') {
  t('[INVERT] 故意失败以验证退出码敏感', () => {
    throw new Error('injected by FDE_INVERT')
  })
}

// ---------------------------------------------------------------- 汇总

lines.push('')
lines.push(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) lines.push('状态：FAILED')
else lines.push('状态：ALL GREEN')

// FDE_OUT（0030 §7）：跑轮次时显式给输出名 ⇒ 两轮不互相覆盖（缺省沿用原名）
writeFileSync(process.env.FDE_OUT ?? new URL('./_dsl_test_out.txt', import.meta.url), lines.join('\n'), 'utf8')

// 🔴 退出码必须随失败变：本脚本不走控制台（Windows 代码页会把中文打成乱码，
// 结果只落在 _dsl_test_out.txt），外面（基线脚本、CI）**只能靠退出码判成败**。
// 不设就是"永远 exit 0"—— 排查时 FAILED 也会被记成 exit=0，与 §3 #6 同源：测量工具本身在说谎。
process.exitCode = failed > 0 ? 1 : 0
