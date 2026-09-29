/**
 * ontology 文件的结构解析 —— objects.yaml / logic.yaml / maturity.yaml。
 *
 * 职责边界：这里**只管结构**（字段在不在、类型对不对、能不能取出来用），
 * 不管条件能不能求值（那是 dsl.js 的事），也不管规则该不该让你过（那是 validate.js 的事）。
 *
 * 默认值取向：**未知一律从严**。属性没有写 maturity 就当 `draft`，
 * 于是它一旦被 deny 规则引用，D3 直接判失败 —— 强迫作者显式声明成熟度。
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

function optionalNumber(value, where) {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DslError('BadStructure', `${where}：必须是数值，收到 ${describe(value)}`)
  }
  return value
}

function describe(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return '数组'
  if (typeof v === 'object') return '对象'
  return String(v)
}

/**
 * 解析 objects.yaml。
 *
 * 形态：
 * ```yaml
 * objects:
 *   - name: treatment
 *     attributes:
 *       - name: dose_mg
 *         type: number
 *         step: 1
 *         min: 0
 *         max: 200
 *         maturity: verified
 * ```
 *
 * @param {unknown} text - 文件文本（已经过 YAML 子集解析则直接传对象也行）
 * @param {object} cfg - 规范化配置
 * @returns {{objects: object[], attributes: Map<string, object>}} attributes 的键是 `对象.属性`
 */
export function parseObjectsDoc(text, cfg) {
  const doc = typeof text === 'string' ? parseYamlSubset(text, 'objects.yaml') : text
  requireObject(doc, 'objects.yaml')

  const rawObjects = requireArray(doc.objects, 'objects.yaml 的 objects')
  const objects = []
  const attributes = new Map()

  for (const [oi, rawObject] of rawObjects.entries()) {
    const objWhere = `objects[${oi}]`
    const o = requireObject(rawObject, objWhere)
    const objectName = requireString(o.name, `${objWhere}.name`)
    const rawAttrs = requireArray(o.attributes ?? [], `${objWhere}.attributes`)

    const attrs = []
    for (const [ai, rawAttr] of rawAttrs.entries()) {
      const where = `objects[${oi}].attributes[${ai}]`
      const a = requireObject(rawAttr, where)
      const name = requireString(a.name, `${where}.name`)
      const type = requireString(a.type, `${where}.type`)
      if (!cfg.allowedTypes.includes(type)) {
        throw new DslError('UnknownType', `${where}.type：类型 "${type}" 不在允许列表内（${cfg.allowedTypes.join('/')}）`)
      }

      const maturityRaw = a.maturity ?? 'draft'
      if (!cfg.allowedMaturity.includes(maturityRaw)) {
        throw new DslError(
          'UnknownMaturity',
          `${where}.maturity：成熟度 "${maturityRaw}" 不在允许列表内（${cfg.allowedMaturity.join('/')}）`
        )
      }

      const attr = {
        object: objectName,
        name,
        path: `${objectName}.${name}`,
        type,
        // fail-closed：没写就是 draft
        maturity: maturityRaw,
        status: typeof a.status === 'string' ? a.status : undefined,
        enum: undefined,
        step: undefined,
        min: undefined,
        max: undefined
      }

      if (a.enum !== undefined && a.enum !== null) {
        attr.enum = requireArray(a.enum, `${where}.enum`)
        if (attr.enum.length === 0) {
          throw new DslError('BadStructure', `${where}.enum：不能是空数组`)
        }
      }

      if (type === 'number') {
        const step = optionalNumber(a.step, `${where}.step`)
        if (step !== undefined && step <= 0) {
          throw new DslError('BadStructure', `${where}.step：必须为正数，收到 ${step}`)
        }
        attr.step = step ?? 1
        attr.min = optionalNumber(a.min, `${where}.min`)
        attr.max = optionalNumber(a.max, `${where}.max`)
        if (attr.min !== undefined && attr.max !== undefined && attr.min > attr.max) {
          throw new DslError('BadStructure', `${where}：min(${attr.min}) 大于 max(${attr.max})`)
        }
      } else if (a.step !== undefined || a.min !== undefined || a.max !== undefined) {
        throw new DslError('BadStructure', `${where}：step/min/max 只能用于 number 类型`)
      }

      if (attributes.has(attr.path)) {
        throw new DslError('DuplicateAttribute', `${where}：属性 ${attr.path} 重复定义`)
      }
      attributes.set(attr.path, attr)
      attrs.push(attr)
    }

    objects.push({ name: objectName, attributes: attrs })
  }

  return { objects, attributes }
}

/**
 * 解析可选的 maturity.yaml（节点级成熟度覆盖）。文件不存在时返回空 Map。
 *
 * 形态：
 * ```yaml
 * nodes:
 *   treatment.dose_mg: verified
 *   treatment.site: draft
 * ```
 *
 * @param {string|object|null} text
 * @param {object} cfg
 * @returns {Map<string, string>}
 */
export function parseMaturityDoc(text, cfg) {
  if (text === null || text === undefined) return new Map()
  const doc = typeof text === 'string' ? parseYamlSubset(text, 'maturity.yaml') : text
  requireObject(doc, 'maturity.yaml')
  const nodes = doc.nodes ?? {}
  requireObject(nodes, 'maturity.yaml 的 nodes')

  const map = new Map()
  for (const [path, maturity] of Object.entries(nodes)) {
    if (!cfg.allowedMaturity.includes(maturity)) {
      throw new DslError(
        'UnknownMaturity',
        `maturity.yaml 的 nodes.${path}：成熟度 "${String(maturity)}" 不在允许列表内`
      )
    }
    map.set(path, maturity)
  }
  return map
}

/**
 * 把 maturity.yaml 的覆盖应用到属性表。
 * ⚠️ maturity.yaml 里出现的**未知路径**一律报错 —— 说明有人在给不存在的节点定成熟度，
 *    这要么是笔误、要么是残留，静默忽略会让"这条属性到底是 draft 还是 verified"变成悬案。
 */
export function applyMaturityOverrides(attributes, overrides) {
  for (const [path, maturity] of overrides) {
    const attr = attributes.get(path)
    if (!attr) {
      throw new DslError('UnknownAttribute', `maturity.yaml 引用了未声明的属性：${path}`)
    }
    attr.maturity = maturity
  }
}

/**
 * 解析 logic.yaml 的规则表。此处**不编译条件** —— 编译放在 validate 里，
 * 因为一条规则的编译失败不应该让整个文件解析失败（报��才有用）。
 *
 * @param {string|object} text
 * @param {object} cfg
 * @returns {object[]} rules
 */
export function parseRulesDoc(text, cfg) {
  const doc = typeof text === 'string' ? parseYamlSubset(text, 'logic.yaml') : text
  requireObject(doc, 'logic.yaml')
  const rawRules = requireArray(doc.rules, 'logic.yaml 的 rules')

  const rules = []
  const seen = new Set()
  for (const [i, raw] of rawRules.entries()) {
    const where = `rules[${i}]`
    const r = requireObject(raw, where)
    const id = requireString(r.id, `${where}.id`)
    if (seen.has(id)) throw new DslError('DuplicateRuleId', `${where}：规则 id "${id}" 重复`)
    seen.add(id)

    const effect = requireString(r.effect, `${where}.effect`)
    if (!cfg.allowedEffects.includes(effect)) {
      throw new DslError(
        'UnknownEffect',
        `${where}.effect："${effect}" 不在允许列表内（${cfg.allowedEffects.join('/')}）`
      )
    }

    if (r.condition === undefined) {
      throw new DslError('BadStructure', `${where}.condition：条件必填（哪怕写 {"==": [1,1]}）`)
    }

    rules.push({
      id,
      effect,
      reason: requireString(r.reason, `${where}.reason`),
      condition: r.condition,
      index: i
    })
  }
  return rules
}

/**
 * 给"非焦点叶子"挑一个确定的回填值。
 *
 * 边界值用例一次只**扫一个叶子**，其余叶子必须固定，否则用例不可复现。
 * 取值完全由声明机械决定（不接受模型给的例子），保证同一份 objects.yaml 永远派生同一批用例。
 *
 * @param {object} attr
 * @returns {unknown}
 */
export function declaredValueFor(attr) {
  if (attr.type === 'boolean') return false
  if (attr.type === 'number') {
    if (attr.min !== undefined) return attr.min
    if (attr.max !== undefined) return attr.max
    return 0
  }
  if (Array.isArray(attr.enum) && attr.enum.length > 0) return attr.enum[0]
  return ''
}
