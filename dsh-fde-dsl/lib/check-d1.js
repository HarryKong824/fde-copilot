/**
 * D1 四项检查 —— 「护栏绑没绑好」的判定核心（spec v2 9.2，Phase 3 的 deny 门禁）。
 *
 * 依赖：`compileRuleCondition`（`dsl.js`，复用受限 DSL 的编译/求值）；`parseActionsDoc` /
 * `parseGuardRegistry`（`actions-schema.js`）；`DslError`。
 *
 * 🔴 PoC 降级（诚实写，README 已记）：spec 要求 `ref` 解析到**已注册的可执行函数**；
 * 本轮 `impl` 是 **DSL 表达式**，用 `compileRuleCondition` 编译、`compiled.eval(input)` 求值。
 * 动态 `import()` 任意路径 = 开出代码执行面，且 PoC 期没有真实代码库可绑，故降级。
 *
 * 锚点（anchor）：由调用方基于 `actions.yaml` + `guards.yaml` 的**原始文本**算复合 `sha256` 传入（本函数不读文件）。
 * 这样 D1 结论与「当前 ontology 内容」绑定，actions/guards 任一文件一改结论即失效——
 * 这是 phase 插件 `fde_phase_advance` 在 guard 里 fail-closed 比对的基础（堵住只改 guards 放宽 impl 的绕过）。
 *
 * 返回 `{ passed, failures }`，`failures` 为 `[{code, where, message}]`，供报告与审计使用。
 */

import { compileRuleCondition } from './dsl.js'
import { parseActionsDoc, parseGuardRegistry } from './actions-schema.js'

/**
 * @param {string|null} actionsText - actions.yaml 原始文本（null = 文件缺失）
 * @param {string|null} guardsText - guards.yaml 原始文本（null = 文件缺失）
 * @returns {{passed: boolean, failures: {code:string, where:string, message:string}[]}}
 */
export function checkD1(actionsText, guardsText) {
  // 文件缺失直接 fail-closed：D1 无法评估即视为不通过（绝不假装通过）。
  if (actionsText === null) {
    return { passed: false, failures: [{ code: 'MissingFile', where: 'actions.yaml', message: 'actions.yaml 不存在，D1 无法评估' }] }
  }
  if (guardsText === null) {
    return { passed: false, failures: [{ code: 'MissingFile', where: 'guards.yaml', message: 'guards.yaml 不存在，D1 无法评估' }] }
  }

  let actions
  let guards
  try {
    actions = parseActionsDoc(actionsText)
  } catch (e) {
    return { passed: false, failures: [{ code: 'ActionsParse', where: 'actions.yaml', message: e.message }] }
  }
  try {
    guards = parseGuardRegistry(guardsText)
  } catch (e) {
    return { passed: false, failures: [{ code: 'GuardsParse', where: 'guards.yaml', message: e.message }] }
  }

  const failures = []
  const registry = new Map(guards.map((g) => [g.ref, g]))

  // ① ref 可解析且 impl 可编译（复用 compileRuleCondition；纯字符串 impl 编译必失败）
  for (const act of actions) {
    for (const gb of act.guardrails) {
      const g = registry.get(gb.ref)
      if (!g) {
        failures.push({ code: 'RefUnresolved', where: `${act.id} → ${gb.ref}`, message: `引用了未注册的护栏 ${gb.ref}` })
        continue
      }
      const implEmpty =
        g.impl === undefined ||
        g.impl === null ||
        (typeof g.impl === 'string' && g.impl.trim().length === 0)
      if (implEmpty) {
        failures.push({ code: 'ImplEmpty', where: `guards.${gb.ref}`, message: `护栏 ${gb.ref} 没有可编译的 impl（impl 为空）` })
        continue
      }
      try {
        compileRuleCondition(g.impl, `guards.${gb.ref}.impl`)
      } catch (e) {
        failures.push({ code: 'ImplNotCompilable', where: `guards.${gb.ref}.impl`, message: `impl 无法编译：${e.message}` })
      }
    }
  }

  // ② 测试通过率 = 100%（每个 test 的 input 喂给 impl 求值，与 expect 全等）
  for (const g of guards) {
    if (g.impl === undefined || g.impl === null) continue
    let compiled
    try {
      compiled = compileRuleCondition(g.impl, `guards.${g.ref}.impl`)
    } catch {
      continue // 已在①记过，这里不重复
    }
    if (!Array.isArray(g.tests) || g.tests.length === 0) {
      failures.push({ code: 'NoTests', where: `guards.${g.ref}`, message: `护栏 ${g.ref} 没有任何测试` })
      continue
    }
    for (const t of g.tests) {
      const where = `guards.${g.ref}.tests.${t.id ?? '?'}`
      try {
        const got = compiled.eval(t.input ?? {})
        if (got !== t.expect) {
          failures.push({ code: 'TestFailed', where, message: `期望 ${t.expect}，实际 ${JSON.stringify(got)}` })
        }
      } catch (e) {
        failures.push({ code: 'TestEvalError', where, message: `求值出错：${e.message}` })
      }
    }
  }

  // ③ 覆盖写操作分支：writes:true 的 action，其每个 guardrail 的 guard 测试集须同时含 expect:true 与 expect:false
  for (const act of actions) {
    if (!act.writes) continue
    for (const gb of act.guardrails) {
      const g = registry.get(gb.ref)
      if (!g || !Array.isArray(g.tests) || g.tests.length === 0) {
        failures.push({
          code: 'GuardrailNoTests',
          where: `${act.id} → ${gb.ref}`,
          message: `写操作 ${act.id} 的护栏 ${gb.ref} 缺测试集，无法验证可反驳性`
        })
        continue
      }
      const hasTrue = g.tests.some((t) => t.expect === true)
      const hasFalse = g.tests.some((t) => t.expect === false)
      if (!(hasTrue && hasFalse)) {
        failures.push({
          code: 'NotRefutable',
          where: `${act.id} → ${gb.ref}`,
          message: `写操作 ${act.id} 的护栏 ${gb.ref} 测试集须同时含 expect:true 与 expect:false（可反驳性）`
        })
      }
    }
  }

  // ④ deny 护栏存在：writes:true 的 action 至少有 1 个 guardrail 的 effect === 'deny'
  for (const act of actions) {
    if (!act.writes) continue
    const hasDeny = act.guardrails.some((gb) => gb.effect === 'deny')
    if (!hasDeny) {
      failures.push({ code: 'NoDenyGuardrail', where: `${act.id}`, message: `写操作 ${act.id} 没有任何 effect:deny 的护栏（D1④）` })
    }
  }

  return { passed: failures.length === 0, failures }
}
