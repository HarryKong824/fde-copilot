/**
 * 边界值反例派生（v3 Stage 4）。
 *
 * 一句话：**每条叶子都榨出一组输入，让你能证明"这条规则既拦得住、也放得过"**。
 *
 * 关于"期望值"怎么来的 —— 这是本文件最关键的取舍：
 * 每条用例都带一个 `expectedLeaf`，它是**用边界值算术直接算出来的**（下面 expectedTruth 那一坨 switch），
 * **完全不经过 dsl.js 的求值器**。于是运行时可以拿它跟引擎输出对拍：
 *   算术说这里该为真 → 引擎也必须说真
 * 两边都是各自独立的写法，对不上就是有一边有 bug。
 * ⚠️ 诚实声明：这是**两条实现路径交叉校验**，既不是形式化验证，也不是"与被测产品代码的一致性检查"
 *    —— 后者要求有一份独立实现存在（v3 里的场景是"生成的校验函数"），本阶段还没有。
 */

import { createHash } from 'node:crypto'
import { collectVars } from './dsl.js'
import { declaredValueFor } from './schema.js'

/** 非成员的哨兵值：必须在常见取值里"绝不可能自然出现"。 */
const OUT_OF_ENUM = '__fde_out_of_enum__'

/**
 * 用**纯算术**算出"焦点叶子在该取值下应该为真还是为假"。
 *
 * ⚠️ 这里刻意不用 `===` 之外的相等语义：JS 的 `==` 会做类型转换，在合规判定里
 *    那是灾难（`'0' == 0` 为真）。比较一律走强类型。
 *
 * @param {string} op - 已翻转归一到"变量在左"的算子
 * @param {unknown} candidate - 给焦点变量的值
 * @param {unknown} threshold - 规则里的阈值字面量
 * @returns {boolean}
 */
export function expectedTruth(op, candidate, threshold) {
  switch (op) {
    case '>':
      return candidate > threshold
    case '>=':
      return candidate >= threshold
    case '<':
      return candidate < threshold
    case '<=':
      return candidate <= threshold
    case '==':
      return sameScalar(candidate, threshold)
    case '!=':
      return !sameScalar(candidate, threshold)
    case 'in':
      return Array.isArray(threshold) && threshold.some((item) => sameScalar(item, candidate))
    default:
      // 到不了：dsl.js 白名单已卡过。真到了说明白名单被改宽了但这里没跟上。
      throw new Error(`expectedTruth: 未处理的算子 ${op}`)
  }
}

function sameScalar(a, b) {
  // 不做任何类型转换；NaN 与自身不等也保留（'-' 算术自带的语义）
  return Object.is(a, b)
}

/**
 * 为一个叶子生成候选输入值。全部来自**属性声明**，不接受任何外部输入。
 *
 * @param {object} leaf - dsl.js 收集到的叶子
 * @param {object} attr - 该路径对应的属性声明
 * @returns {unknown[]} 去重后的候选值列表（顺序确定）
 */
export function candidatesForLeaf(leaf, attr) {
  const out = []
  const push = (v) => {
    if (!out.some((existing) => sameScalar(existing, v))) out.push(v)
  }

  if (leaf.op === 'in' || Array.isArray(leaf.value)) {
    const members = Array.isArray(leaf.value) ? leaf.value : []
    for (const m of members) push(m)
    if (Array.isArray(attr.enum)) {
      for (const e of attr.enum) push(e)
    }
    push(OUT_OF_ENUM)
    return out
  }

  const threshold = leaf.value

  if (attr.type === 'boolean') {
    push(true)
    push(false)
    if (typeof threshold === 'boolean') push(threshold)
    return out
  }

  if (attr.type === 'number' && typeof threshold === 'number') {
    const step = attr.step ?? 1
    // 阈值三件套：边界下、边界、边界上
    push(threshold - step)
    push(threshold)
    push(threshold + step)
    // 声明值域的两端（这是"≤5 条反例"通常不够时的主要来源）
    if (attr.min !== undefined) {
      push(attr.min)
      push(attr.min - step)
    }
    if (attr.max !== undefined) {
      push(attr.max)
      push(attr.max + step)
    }
    return out
  }

  if (attr.type === 'string' || typeof threshold === 'string') {
    if (Array.isArray(attr.enum)) {
      for (const e of attr.enum) push(e)
      push(OUT_OF_ENUM)
      return out
    }
    if (typeof threshold === 'string') {
      push(threshold)
      push(`${threshold}_x`)
      push('')
      return out
    }
  }

  return out
}

/** 稳定序列化：对象键排序，保证同一份输入永远得到同一个 id。 */
function stableKey(data) {
  const keys = Object.keys(data).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(data[k])}`).join(',')}}`
}

/**
 * 用例 id：规则 id + 焦点路径 + **算子与阈值** + 输入指纹。
 *
 * ⚠️ 算子与阈值必须在种子里：同一条规则里两个叶子可以指向同一个属性（`dose > 100` 且 `dose < 200`），
 *    它们的输入向量可能完全相同，少了这两个字段就会算出同一个 id —— 表现为"少了用例"。
 */
export function makeCaseId(ruleId, focusPath, leaf, data) {
  const seedTail = leaf
    ? `${leaf.op}|${Array.isArray(leaf.value) ? JSON.stringify(leaf.value) : String(leaf.value)}`
    : 'combo'
  return createHash('sha1')
    .update(`${ruleId}|${focusPath}|${seedTail}|${stableKey(data)}`)
    .digest('hex')
    .slice(0, 12)
}

/**
 * 为一条规则派生全部反例。
 *
 * @param {object} args
 * @param {object} args.rule - parseRulesDoc 产出的规则
 * @param {object} args.compiled - compileRuleCondition 的产物（含 ast / leaves / nonDerivable）
 * @param {Map<string, object>} args.attributes - `对象.属性` → 属性声明
 * @returns {{cases: object[], issues: object[]}} cases 顺序确定（按叶子顺序 + 候选顺序）
 */
export function deriveCases({ rule, compiled, attributes, maxCombos = 0 }) {
  const allPaths = collectVars(compiled.ast)
  const varPaths = [...allPaths].filter((p) => attributes.has(p))
  const unknownPaths = [...allPaths].filter((p) => !attributes.has(p))

  /** 非焦点变量的固定回填值：一次只变一个叶子，保证用例可复现。 */
  const baseline = {}
  for (const path of varPaths) {
    baseline[path] = declaredValueFor(attributes.get(path))
  }

  const cases = []
  const issues = []
  const seenIds = new Set()
  const push = (c) => {
    if (seenIds.has(c.id)) return false // 组合用例可能撞上焦点用例，同一份输入不重复计数
    seenIds.add(c.id)
    cases.push(c)
    return true
  }

  for (const path of unknownPaths) {
    issues.push({
      code: 'UnknownAttribute',
      // ⚠️ 这里**不写 objects.yaml**：本条会被 validate.js 挂上 file 字段，
      // renderReport 再渲染一次 ⟨改：objects.yaml⟩ —— 写进去就是同一信息出现两次。
      // 「去哪改」的唯一事实源是 file 字段，message 只讲"为什么错"（见 validate.js 的 FILE 注释）。
      // 同理，本文件里任何进 failures/warnings 的 message 都不许出现已公开文件名，回归有断言守着。
      message: `规则 ${rule.id} 引用了未在本体属性表里声明的属性：${path}`
    })
  }

  /** 按路径聚合候选值，组合用例要用。 */
  const candidatesByPath = new Map()

  for (const leaf of compiled.leaves) {
    const attr = attributes.get(leaf.path)
    if (!attr) continue // 已在 unknownPaths 里报过

    const candidates = candidatesForLeaf(leaf, attr)
    if (candidates.length === 0) {
      issues.push({
        code: 'NoCandidate',
        message: `规则 ${rule.id} 的 ${leaf.path} 派生不出边界候选值（检查 type/阈值类型是否一致）`
      })
      continue
    }
    const existing = candidatesByPath.get(leaf.path) ?? []
    for (const v of candidates) {
      if (!existing.some((e) => sameScalar(e, v))) existing.push(v)
    }
    candidatesByPath.set(leaf.path, existing)

    for (const candidate of candidates) {
      const input = { ...baseline, [leaf.path]: candidate }
      push({
        id: makeCaseId(rule.id, leaf.path, leaf, input),
        ruleId: rule.id,
        focus: leaf.path,
        input,
        expectedLeaf: expectedTruth(leaf.op, candidate, leaf.value),
        leafOp: leaf.op,
        leafThreshold: Array.isArray(leaf.value) ? [...leaf.value] : leaf.value,
        // 带叶子 AST：校验时要拿它单独求值，跟 expectedLeaf 对拍（不跑整条规则）
        leafAst: leaf.ast
      })
    }
  }

  // ---- 组合用例 ----
  //
  // 为什么需要它们：光做"一次只动一个叶子"，`and` 起来的规则可能**永远凑不出触发输入**
  // —— 非焦点叶子停在声明默认值上把路堵死了，于是 D3 会报 `RuleNeverFires`，
  // 而这条规则其实完全能触发。那是**假失败**，比漏报更伤：它逼作者去改一条没问题的规则。
  //
  // 所以叶子数 ≥2 时，再跑一遍候选值的笛卡尔积（有上限）。
  // 超过上限就**明说没跑**（CombinatorialSkip 提示），绝不明知 œuvre 不全还装作验过。
  const paths = [...candidatesByPath.keys()]
  if (paths.length >= 2 && maxCombos > 0) {
    const size = paths.reduce((acc, p) => acc * candidatesByPath.get(p).length, 1)
    if (size <= maxCombos) {
      for (const combo of cartesian(paths.map((p) => candidatesByPath.get(p)))) {
        const input = { ...baseline }
        paths.forEach((p, i) => {
          input[p] = combo[i]
        })
        push({
          id: makeCaseId(rule.id, '*', null, input),
          ruleId: rule.id,
          focus: '*',
          input,
          // 组合用例**不做叶子级断言**：它是给整条规则补覆盖的，不是验证某个叶子的语义。
          expectedLeaf: null,
          leafOp: null,
          leafThreshold: null,
          leafAst: null
        })
      }
    } else {
      issues.push({
        code: 'CombinatorialSkip',
        message:
          `规则 ${rule.id} 有 ${paths.length} 个参与比较的属性，候选组合共 ${size} 种，` +
          `超过上限 ${maxCombos}：整规则层面的覆盖没有跑（逐叶子层面已验）。` +
          '要么拆规则，要么调大 maxCombos —— 但别把这个提示当成"验过了"。'
      })
    }
  }

  for (const nd of compiled.nonDerivable) {
    issues.push({
      code: 'NonDerivable',
      message: `规则 ${rule.id} 有子条件无法机械派生反例：${nd.where}（${nd.reason}）`
    })
  }

  return { cases, issues }
}

/** 笛卡尔积（顺序确定：最后一个轴变化最快）。 */
function cartesian(axes) {
  let result = [[]]
  for (const axis of axes) {
    const next = []
    for (const prefix of result) {
      for (const v of axis) next.push([...prefix, v])
    }
    result = next
  }
  return result
}

// eslint-disable-next-line no-unused-vars -- 保留：below 用不上但保留给未来的合并策略
export { OUT_OF_ENUM }
