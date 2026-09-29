/**
 * 受限 JSON Logic 子集 —— 解析器 + 求值器。
 *
 * **零依赖**（只准 import 同目录模块），保证这一层可以离线回归测试。
 *
 * 设计取向：**fail-closed**。
 * 这是给合规场景做判定用的 DSL，任何"看不懂就猜/就跳过"的行为都会变成静默漏洞。
 * 所以：未知算子报错、不等于焦油量 mismatch 报错、var 查不到报错、条件结果非布尔报错。
 * 宁可让一条写得含糊的规则**过不了 D3**，也不能让它带着歧义上线。
 */

import { DslError } from './errors.js'

/** 比较算子（二元）。 */
const COMPARISONS = ['==', '!=', '>', '>=', '<', '<=']

/** 逻辑算子。 */
const LOGIC = ['and', 'or', '!']

/** 成员算子。 */
const MEMBER = ['in']

/** 取值算子。 */
const VAR = ['var']

/** 全量算子白名单（README 会原样列出，加算子必须同步改这里 + 回归测试）。 */
export const OPERATORS = [...COMPARISONS, ...LOGIC, ...MEMBER, ...VAR]

/** 允许出现在 DSL 里的字面量类型。 */
function isLiteralScalar(v) {
  return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'
}

/**
 * 是否是`{"算子": 参数}`形态的节点。
 * @param {unknown} node
 * @returns {node is Record<string, unknown>}
 */
function isOperatorNode(node) {
  return node !== null && typeof node === 'object' && !Array.isArray(node)
}

/**
 * 取出唯一键。多键在 JSON Logic 里语义依赖对象遍历顺序，这里一律视为写法错误。
 */
function singleKey(node, where) {
  const keys = Object.keys(node)
  if (keys.length === 0) throw new DslError('EmptyNode', `${where}：算子节点为空对象`)
  if (keys.length > 1) {
    throw new DslError('MultipleKeys', `${where}：只允许一个算子键，收到 ${keys.join(', ')}`)
  }
  return keys[0]
}

/**
 * 把 JSON 条件编译成 AST。同时**顺带收集叶子**（派��反例要用）。
 *
 * @param {unknown} node - logic.yaml 里 rule.condition 的原值
 * @param {string} where - 报错定位用的路径描述
 * @param {object} ctx - 编译上下文
 * @param {Array} ctx.leaves - 收集到的叶子（会被就地 push）
 * @param {Array} ctx.nonDerivable - 无法机械派生的子条件（会被就地 push）
 * @returns {object} AST 节点
 */
export function compileCondition(node, where, ctx) {
  if (node === null || node === undefined) {
    throw new DslError('EmptyCondition', `${where}：条件不能为空`)
  }
  if (Array.isArray(node)) {
    throw new DslError('UnexpectedArray', `${where}：数组只能出现在 and/or/in 的参数里`)
  }
  // 布尔字面量可以直接当条件 —— JSON Logic 允许 `{and: [cond, true]}` 这种写法，
  // 写成 `{and: [cond]}` 又太长时这是常规表达。
  // ⚠️ 只放行 boolean：数字/字符串/SQL NULL 当条件一定是笔误，让它摔在 NonBooleanResult 上。
  if (typeof node === 'boolean') {
    return { kind: 'lit', value: node, where }
  }
  if (!isOperatorNode(node)) {
    throw new DslError('NonOperatorCondition', `${where}：条件必须是 {"算子": 参数} 形态`)
  }

  const op = singleKey(node, where)
  if (!OPERATORS.includes(op)) {
    throw new DslError('UnknownOperator', `${where}：算子 "${op}" 不在白名单内`, { op })
  }

  const args = node[op]

  if (COMPARISONS.includes(op)) return compileComparison(op, args, where, ctx)
  if (MEMBER.includes(op)) return compileMember(op, args, where, ctx)
  if (op === '!') return compileNot(args, where, ctx)
  if (LOGIC.includes(op)) return compileLogic(op, args, where, ctx)
  return compileVar(args, where)
}

function operandsOf(op, args, where) {
  if (!Array.isArray(args)) {
    throw new DslError('BadArity', `${where}：${op} 的参数必须是数组，收到 ${typeof args}`)
  }
  if (args.length !== 2) {
    throw new DslError('BadArity', `${where}：${op} 需要 2 个参数，收到 ${args.length} 个`)
  }
  return args
}

function compileComparison(op, args, where, ctx) {
  const [rawLeft, rawRight] = operandsOf(op, args, where)
  const left = compileOperand(rawLeft, `${where}.左`, ctx)
  const right = compileOperand(rawRight, `${where}.右`, ctx)

  const ast = { kind: 'cmp', op, left, right, where }

  // 只有「一边是 var、另一边是字面量」才能机械派生边界值。
  // 两边都是 var（关系比较）或两边都是字面量（常量比较）不产生叶子，
  // 但要记进 nonDerivable —— 否则规则作者以为它被测了，实际没有。
  if (left.kind === 'var' && right.kind === 'lit') {
    ctx.leaves.push(makeLeaf(left.path, op, right.value, ast))
  } else if (right.kind === 'var' && left.kind === 'lit') {
    // 常量在左要翻转算子：`100 < dose` 等价于 `dose > 100`
    ctx.leaves.push(makeLeaf(right.path, flipOperator(op), left.value, ast))
  } else {
    ctx.nonDerivable.push({ where, reason: describeNonDerivable(left, right) })
  }

  return ast
}

function describeNonDerivable(left, right) {
  if (left.kind === 'var' && right.kind === 'var') return '两边都是变量（关系比较），无固定阈值'
  if (left.kind === 'lit' && right.kind === 'lit') return '两边都是常量，与输入无关'
  return '含嵌套表达式或数组，无法取单一阈值'
}

/** 交换左右操作数时的算子翻转。 */
function flipOperator(op) {
  switch (op) {
    case '>':
      return '<'
    case '<':
      return '>'
    case '>=':
      return '<='
    case '<=':
      return '>='
    default:
      return op
  }
}

function makeLeaf(path, op, value, ast) {
  return {
    path,
    op,
    value,
    valueType: Array.isArray(value) ? 'array' : (typeof value ?? 'null'),
    ast
  }
}

function compileMember(op, args, where, ctx) {
  const [rawNeedle, rawHaystack] = operandsOf(op, args, where)
  const needle = compileOperand(rawNeedle, `${where}.元素`, ctx)
  const haystack = compileOperand(rawHaystack, `${where}.集合`, ctx)

  const ast = { kind: 'member', op, needle, haystack, where }

  if (needle.kind === 'var' && haystack.kind === 'lit' && Array.isArray(haystack.value)) {
    // 叶子要带上**真实 AST**：后面做叶子级求值（边界极值断言）时需要对它单独 evaluate，
    // 传占位节点会让求值直接炸，看着像“用例失败”，其实是自己的 bug。
    ctx.leaves.push(makeLeaf(needle.path, 'in', haystack.value, ast))
  } else {
    ctx.nonDerivable.push({ where, reason: 'in 的集合侧不是字面量数组，无法枚举成员' })
  }

  return ast
}

function compileNot(args, where, ctx) {
  if (Array.isArray(args)) {
    if (args.length !== 1) {
      throw new DslError('BadArity', `${where}：! 需要 1 个参数，收到 ${args.length} 个`)
    }
    args = args[0]
  }
  return { kind: 'not', arg: compileCondition(args, `${where}!`, ctx), where }
}

function compileLogic(op, args, where, ctx) {
  if (!Array.isArray(args)) {
    throw new DslError('BadArity', `${where}：${op} 的参数必须是数组，收到 ${typeof args}`)
  }
  if (args.length === 0) {
    throw new DslError('BadArity', `${where}：${op} 至少要 1 个参数`)
  }
  return {
    kind: 'logic',
    op,
    args: args.map((a, i) => compileCondition(a, `${where}[${i}]`, ctx)),
    where
  }
}

function compileVar(args, where) {
  let path = args
  if (Array.isArray(args)) {
    if (args.length === 0) throw new DslError('BadArity', `${where}：var 缺少路径`)
    path = args[0]
  }
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new DslError('BadVarPath', `${where}：var 的路径必须是非空字符串`)
  }
  return { kind: 'var', path, where }
}

/** 编译"值位置"（比较的两侧、集合侧）—— 允许字面量、var、嵌套表达式。 */
function compileOperand(node, where, ctx) {
  if (isLiteralScalar(node)) return { kind: 'lit', value: node }
  if (node === null) return { kind: 'lit', value: null }
  if (Array.isArray(node)) {
    // in 的第二个参数允许是字面量数组（成员检查）；其余位置不允许。
    if (node.every(isLiteralScalar)) return { kind: 'lit', value: [...node] }
    throw new DslError('UnexpectedArray', `${where}：不允许的数组参数`)
  }
  if (isOperatorNode(node)) {
    return compileCondition(node, where, ctx)
  }
  throw new DslError('BadOperand', `${where}：不支持的操作数类型 ${typeof node}`)
}

// ---------------------------------------------------------------- 求值

/**
 * 求值。**任何一步不合法都抛 DslError**（fail-closed）。
 *
 * @param {object} ast - compileCondition 的产物（或它的任意子树）
 * @param {Record<string, unknown>} data - 输入数据，形如 {'对象.属性': 值}
 * @returns {boolean}
 */
export function evaluate(ast, data) {
  const result = evalNode(ast, data ?? {})
  if (typeof result !== 'boolean') {
    throw new DslError('NonBooleanResult', `${ast.where ?? '条件'}：求值结果必须是布尔，收到 ${JSON.stringify(result) ?? typeof result}`)
  }
  return result
}

function evalNode(node, data) {
  switch (node.kind) {
    case 'lit':
      return node.value
    case 'var': {
      if (!(node.path in data)) {
        throw new DslError('UnknownVariable', `${node.where ?? '条件'}：变量 "${node.path}" 在输入里不存在`, {
          path: node.path
        })
      }
      return data[node.path]
    }
    case 'cmp': {
      const l = evalNode(node.left, data)
      const r = evalNode(node.right, data)
      return compare(node.op, l, r, node.where)
    }
    case 'member': {
      const needle = evalNode(node.needle, data)
      const haystack = evalNode(node.haystack, data)
      if (!Array.isArray(haystack)) {
        throw new DslError('TypeMismatch', `${node.where ?? 'in'}：in 的集合侧必须是数组`)
      }
      return haystack.some((item) => sameValue(item, needle))
    }
    case 'not': {
      const v = evalNode(node.arg, data)
      if (typeof v !== 'boolean') {
        throw new DslError('NonBooleanResult', `${node.where ?? '!'}：! 的参数必须是布尔`)
      }
      return !v
    }
    case 'logic': {
      const values = node.args.map((a) => {
        const v = evalNode(a, data)
        if (typeof v !== 'boolean') {
          throw new DslError('NonBooleanResult', `${node.where ?? node.op}：${node.op} 的参数必须是布尔`)
        }
        return v
      })
      if (node.op === 'and') return values.every(Boolean)
      return values.some(Boolean)
    }
    default:
      throw new DslError('BadNode', `${node.where ?? '条件'}：未知 AST 节点 ${String(node.kind)}`)
  }
}

function compare(op, l, r, where) {
  // 类型必须一致才比较 —— JSON Logic 的松散语义在合规判定里太容易出歧义。
  const sameType = typeof l === typeof r || (l === null && r === null)
  if (!sameType) {
    throw new DslError(
      'TypeMismatch',
      `${where ?? '比较'}：两侧类型不一致（${describeType(l)} vs ${describeType(r)}），拒绝猜测语义`
    )
  }
  switch (op) {
    case '==':
      return sameValue(l, r)
    case '!=':
      return !sameValue(l, r)
    case '>':
      return l > r
    case '>=':
      return l >= r
    case '<':
      return l < r
    case '<=':
      return l <= r
    default:
      throw new DslError('UnknownOperator', `${where ?? '比较'}：不支持的比较算子 ${op}`)
  }
}

function sameValue(a, b) {
  if (a === b) return true
  // null 只在同为 null 时相等（上面 === 已覆盖）；其余跨类型一律不等。
  return false
}

function describeType(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/**
 * 收集条件里引用的全部变量路径 —— draft 保护（v3 铁律）要用它做引用检查。
 *
 * @param {object} ast
 * @param {Set<string>} [out]
 * @returns {Set<string>}
 */
export function collectVars(ast, out = new Set()) {
  switch (ast.kind) {
    case 'var':
      out.add(ast.path)
      break
    case 'cmp':
      collectVars(ast.left, out)
      collectVars(ast.right, out)
      break
    case 'member':
      collectVars(ast.needle, out)
      collectVars(ast.haystack, out)
      break
    case 'not':
      collectVars(ast.arg, out)
      break
    case 'logic':
      for (const a of ast.args) collectVars(a, out)
      break
    default:
      break // lit / nop
  }
  return out
}

/**
 * 一次性编译 + 收集叶子。这是外部最常使用的入口。
 *
 * @param {unknown} condition - rule.condition 原值
 * @param {string} [where] - 报错定位描述
 * @returns {{ast: object, leaves: object[], nonDerivable: object[], eval: (data: object) => boolean}}
 */
export function compileRuleCondition(condition, where = 'condition') {
  const ctx = { leaves: [], nonDerivable: [] }
  const ast = compileCondition(condition, where, ctx)
  return {
    ast,
    leaves: ctx.leaves,
    nonDerivable: ctx.nonDerivable,
    eval: (data) => evaluate(ast, data)
  }
}
