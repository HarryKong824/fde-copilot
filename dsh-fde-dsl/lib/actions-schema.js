/**
 * actions.yaml / guards.yaml 的结构解析 —— D1 护栏校验（PoC 降级）的数据入口。
 *
 * ⚠️ **D1 本轮是 PoC 降级**：spec 要求 `ref` 解析到已注册的**可执行函数**，
 * 本轮 `impl` 是 **DSL 表达式**（如 `{'>': [{'var':'treatment.dose_mg'}, 100]}`），
 * 由 `dsl.js` 的 `compileRuleCondition` 求值，**不是**真 JS/TS 函数。
 * 这条降级不得在任何交付文案里被说成"已按 spec 实现"（README 诚实清单已记）。
 *
 * 解析器风格照抄 `schema.js`：fail-closed、`requireString/requireArray/requireObject` 帮手、
 * 错误走 `DslError`。独立的解析器：D1 不该因为 objects.yaml / logic.yaml 缺失而跑不了
 * （`loadOntology` 缺那两个文件会抛错；D1 走独立加载路径）。
 */

import { DslError } from './errors.js'
import { parseYamlSubset } from './yamlsubset.js'

function requireArray(value, where) {
  if (!Array.isArray(value)) {
    throw new DslError('BadStructure', `${where}：期望一个列表，收到 ${describe(value)}`)
  }
  return value
}

function requireObject(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DslError('BadStructure', `${where}：期望一个对象，收到 ${describe(value)}`)
  }
  return value
}

function requireString(value, where) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DslError('BadStructure', `${where}：必须是非空字符串`)
  }
  return value.trim()
}

function describe(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return '数组'
  if (typeof v === 'object') return '对象'
  return String(v)
}

/**
 * 解析 actions.yaml。
 *
 * 形态：
 * ```yaml
 * actions:
 *   - id: suggest_treatment_plan
 *     writes: true
 *     guardrails:
 *       - ref: guard.dose_upper_bound
 *         effect: deny
 * ```
 *
 * @param {string|object} text
 * @returns {{id:string, writes:boolean, guardrails:{ref:string, effect:string}[]}[]}
 */
export function parseActionsDoc(text) {
  const doc = typeof text === 'string' ? parseYamlSubset(text, 'actions.yaml') : text
  requireObject(doc, 'actions.yaml')
  const raw = requireArray(doc.actions ?? [], 'actions.yaml 的 actions')

  const actions = []
  for (const [i, rawA] of raw.entries()) {
    const where = `actions[${i}]`
    const a = requireObject(rawA, where)
    const id = requireString(a.id, `${where}.id`)
    const writes = a.writes === true
    const guardrails = requireArray(a.guardrails ?? [], `${where}.guardrails`).map((g, gi) => {
      const gw = `${where}.guardrails[${gi}]`
      const go = requireObject(g, gw)
      const ref = requireString(go.ref, `${gw}.ref`)
      const effect = requireString(go.effect, `${gw}.effect`)
      return { ref, effect }
    })
    actions.push({ id, writes, guardrails })
  }
  return actions
}

/**
 * 解析 guards.yaml（guard registry）。
 *
 * 形态：
 * ```yaml
 * guards:
 *   - ref: guard.dose_upper_bound
 *     impl: {">": [{"var": "treatment.dose_mg"}, 100]}   # 可编译的 DSL 表达式（⚠️ 必须双引号，单引号会被 JSON.parse 拒）
 *     tests:
 *       - {"id": "g1-trigger", "input": {"treatment.dose_mg": 150}, "expect": true}
 *       - {"id": "g1-pass",    "input": {"treatment.dose_mg": 50},  "expect": false}
 * ```
 *
 * 🔴 `impl` 不做类型收窄（允许 object 表达式，也允许纯字符串——纯字符串会在 check-d1 的
 * 编译阶段被判为不可编译，正是要的性质）。`tests[].expect` 必须是布尔。
 *
 * @param {string|object} text
 * @returns {{ref:string, impl:unknown, tests:{id:string, input:object, expect:boolean}[]}[]}
 */
export function parseGuardRegistry(text) {
  const doc = typeof text === 'string' ? parseYamlSubset(text, 'guards.yaml') : text
  requireObject(doc, 'guards.yaml')
  const raw = requireArray(doc.guards ?? [], 'guards.yaml 的 guards')

  const guards = []
  for (const [i, rawG] of raw.entries()) {
    const where = `guards[${i}]`
    const g = requireObject(rawG, where)
    const ref = requireString(g.ref, `${where}.ref`)
    const impl = g.impl // 任意类型；后续编译阶段判定是否可编译
    const tests = requireArray(g.tests ?? [], `${where}.tests`).map((t, ti) => {
      const tw = `${where}.tests[${ti}]`
      const to = requireObject(t, tw)
      const id = requireString(to.id, `${tw}.id`)
      let expect
      if (to.expect === true || to.expect === false) expect = to.expect
      else throw new DslError('BadStructure', `${tw}.expect：必须是布尔（true/false），收到 ${describe(to.expect)}`)
      const input = to.input && typeof to.input === 'object' && !Array.isArray(to.input) ? to.input : {}
      return { id, input, expect }
    })
    guards.push({ ref, impl, tests })
  }
  return guards
}
