/**
 * ontology 文件的结构解析 —— 只做**分级判定**需要的轻量提取。
 *
 * 为什么照抄 dsl 的 yamlsubset.js 而不引第三方库：gate 跨包不能 import dsl（本项目架构
 * 约束：四个插件独立、跨包不 import），且解析器自身的歧义就是合规攻击面 —— 第三方 yaml 库
 * 的"宽松接受"会静默放过结构错误。所以照抄 dsl 的「宁可报错、不可猜」YAML 子集解析器。
 *
 * 与 dsl 的 schema.js / actions-schema.js 的区别：那些解析器做**完整校验**（allowedTypes /
 * allowedMaturity / allowedEffects 等 D3 派生需要的类型收窄），本文件只做**轻量结构提取**——
 * 分级判定只需要标识键（objects[].name / attributes[].name / rules[].id / actions[].id /
 * guards[].ref）与关键字段（rules[].effect / reason / condition、attributes 的 enum/min/max），
 * 不需要完整类型校验。但**结构错误照样 fail-closed 抛错**（与 dsl 同口径：宁可报错、不可猜）。
 */

/**
 * 统一错误类型（照抄 dsl/lib/errors.js 的 DslError —— 跨包不能 import，故照抄）。
 */
export class DslError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'DslError'
    this.code = code
    this.detail = detail
  }
}

function fail(lineNo, why) {
  throw new DslError('YamlParseError', `第 ${lineNo} 行：${why}`)
}

/** 把原文切成有效行：丢空行与整行注释，记录缩进与行号。 */
function tokenize(text) {
  const tokens = []
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw.includes('\t')) fail(i + 1, '不允许使用 Tab 缩进（只认空格）')
    const stripped = raw.trim()
    if (stripped.length === 0 || stripped.startsWith('#')) continue

    if (stripped.startsWith('---') || stripped.startsWith('...')) {
      fail(i + 1, '不支持多文档标记（--- / ...）')
    }
    tokens.push({ indent: raw.length - raw.trimStart().length, content: raw.trim(), lineNo: i + 1 })
  }
  return tokens
}

/**
 * 解析标量或行内 JSON。
 * @param {string} raw - 冒号后面的内容
 * @param {number} lineNo
 */
function parseScalar(raw, lineNo) {
  const s = raw.trim()
  if (s.length === 0) return null

  // 行内 JSON —— 条件表达式、数组都走这条
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.parse(s)
    } catch (e) {
      fail(lineNo, `行内 JSON 解析失败（必须写合法 JSON）：${e.message}`)
    }
  }

  if (s.startsWith('|') || s.startsWith('>')) {
    fail(lineNo, '不支持多行字符串块（| / >）')
  }
  if (s.startsWith('&') || s.startsWith('*')) {
    fail(lineNo, '不支持锚点/别名（& / *）')
  }

  if (s === 'null' || s === '~' || s === 'Null' || s === 'NULL') return null

  // yes/no/on/off 在 YAML 里语义版本相关（1.1 是布尔、1.2 是字符串）—— 一律拒绝。
  if (/^(yes|no|on|off|Yes|No|On|Off)$/.test(s)) {
    fail(lineNo, `拒绝 "${s}"（YAML 1.1/1.2 语义不一致，请写 true/false 或加引号）`)
  }
  if (s === 'true' || s === 'True' || s === 'TRUE') return true
  if (s === 'false' || s === 'False' || s === 'FALSE') return false

  if (/^-?\d+$/.test(s) || /^-?\d+\.\d+$/.test(s)) return Number(s)

  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    if (s.length < 2) fail(lineNo, '引号不成对')
    return unquote(s.slice(1, -1), s[0], lineNo)
  }
  if (s.includes("'") || s.includes('"')) {
    fail(lineNo, '引号必须成对出现在标量首尾')
  }

  return s
}

function unquote(inner, quote, lineNo) {
  if (quote === "'") {
    // 单引号：'' 是转义的单引号，其它转义一概不接受（避免静默误解）
    if (inner.includes('\\')) fail(lineNo, "单引号字符串里不允许反斜杠转义")
    return inner.replace(/''/g, "'")
  }
  return inner.replace(/\\(["\\/nrtbfu])/g, (m, ch) => {
    switch (ch) {
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 't':
        return '\t'
      case 'b':
        return '\b'
      case 'f':
        return '\f'
      case '"':
        return '"'
      case '\\':
        return '\\'
      case '/':
        return '/'
      default:
        fail(lineNo, `不支持的转义序列 \\${ch}（暂不支持 \\u）`)
        return m
    }
  })
}

const MAP_KEY = /^([A-Za-z_][\w.-]*)\s*:(?:\s+(.*))?$/

function isDash(t) {
  return t.content === '-' || t.content.startsWith('- ')
}

/**
 * 解析一个块（映射或列表）。
 * @returns {[unknown, number]} [解析结果, 下一个未消费的 token 下标]
 */
function parseBlock(tokens, i, indent) {
  if (i >= tokens.length) return [null, i]
  return isDash(tokens[i]) ? parseList(tokens, i, indent) : parseMap(tokens, i, indent)
}

function parseMap(tokens, i, indent) {
  const result = {}
  while (i < tokens.length && tokens[i].indent === indent) {
    const t = tokens[i]
    if (isDash(t)) fail(t.lineNo, '同一层级里不允许混用映射与列表')

    const m = t.content.match(MAP_KEY)
    if (!m) fail(t.lineNo, `无法识别的键（期望 "键: 值"）：${t.content}`)

    const key = m[1]
    if (key in result) fail(t.lineNo, `重复键 "${key}"`)

    const rawValue = (m[2] ?? '').trim()
    if (rawValue.length === 0) {
      const next = tokens[i + 1]
      if (next && next.indent > indent) {
        const [child, ni] = parseBlock(tokens, i + 1, next.indent)
        result[key] = child
        i = ni
      } else {
        result[key] = null
        i += 1
      }
    } else {
      result[key] = parseScalar(rawValue, t.lineNo)
      i += 1
    }
  }
  return [result, i]
}

function parseList(tokens, i, indent) {
  const result = []
  while (i < tokens.length && tokens[i].indent === indent && isDash(tokens[i])) {
    const t = tokens[i]
    const rest = t.content === '-' ? '' : t.content.slice(1).trim()

    if (rest.length === 0) {
      const next = tokens[i + 1]
      if (!next || next.indent <= indent) {
        fail(t.lineNo, '列表项为空，且没有缩进的子内容')
      }
      const [child, ni] = parseBlock(tokens, i + 1, next.indent)
      result.push(child)
      i = ni
      continue
    }

    if (MAP_KEY.test(rest)) {
      // "- name: treatment" —— 把 '- ' 之后的内容当成一条更深两格的虚拟行
      const synthetic = { indent: indent + 2, content: rest, lineNo: t.lineNo }
      const shifted = [synthetic, ...tokens.slice(i + 1)]
      const [child, consumed] = parseBlock(shifted, 0, synthetic.indent)
      result.push(child)
      i += consumed // consumed 含 synthetic，正好等于原数组起点偏移
      continue
    }

    result.push(parseScalar(rest, t.lineNo))
    i += 1
  }
  return [result, i]
}

/**
 * 解析 YAML 子集文本（照抄 dsl/lib/yamlsubset.js 的 parseYamlSubset）。
 *
 * @param {string} text - 文件内容
 * @param {string} [where] - 报错里显示的文件名
 * @returns {unknown} 顶层容器（对象）
 */
export function parseYamlSubset(text, where = '文档') {
  const tokens = tokenize(text)
  if (tokens.length === 0) {
    throw new DslError('YamlParseError', `${where}：内容为空`)
  }
  const [value, consumed] = parseBlock(tokens, 0, tokens[0].indent)
  if (consumed !== tokens.length) {
    const t = tokens[consumed]
    fail(t.lineNo, `无法归位的行（缩进层级跳变）：${t.content}`)
  }
  // 顶层必须是映射：否则后续按 objects/rules 取值时报错会很难读
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DslError('YamlParseError', `${where}：顶层必须是映射（形如 "objects:" / "rules:"）`)
  }
  return value
}

// ---------------------------------------------------------------------------
// 轻量结构提取 —— fail-closed 结构校验 + **完整保留**每个单元的所有字段
// ---------------------------------------------------------------------------
//
// 为什么"完整保留"而不是"只取分级判定要的几个字段"：diff 的"修改"判定靠单元指纹
// （stableStringify）。若这里只留 name/hasEnum/hasRange，改 attribute 的 type/maturity/
// status、改 action 的 writes/guardrails、改 guard 的 impl/tests 都会被当成"没变化"，
// 分级判 L0 —— 而"改既有属性语义"本该 L1。所以校验只做 fail-closed 的"键在不在、是不是
// 字符串"，字段值**原样透传**给 classify.js 做指纹与关键词匹配。

function requireObject(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DslError('BadStructure', `${where}：期望一个对象`)
  }
  return value
}

function requireArray(value, where) {
  if (!Array.isArray(value)) {
    throw new DslError('BadStructure', `${where}：期望一个列表`)
  }
  return value
}

function requireString(value, where) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DslError('BadStructure', `${where}：必须是非空字符串`)
  }
  return value.trim()
}

/**
 * 提取 objects.yaml —— 保留对象名与每个属性的完整字段。
 *
 * @returns {{kind:'objects', objects:{name:string, attributes:object[]}[]}}
 */
function extractObjects(doc) {
  const raw = requireArray(doc.objects ?? [], 'objects.yaml 的 objects')
  const objects = []
  for (const [oi, rawO] of raw.entries()) {
    const o = requireObject(rawO, `objects[${oi}]`)
    const name = requireString(o.name, `objects[${oi}].name`)
    const rawAttrs = requireArray(o.attributes ?? [], `objects[${oi}].attributes`)
    const attributes = []
    for (const [ai, rawA] of rawAttrs.entries()) {
      const where = `objects[${oi}].attributes[${ai}]`
      const a = requireObject(rawA, where)
      requireString(a.name, `${where}.name`) // 只校验标识键，字段值原样保留
      attributes.push(a)
    }
    objects.push({ name, attributes })
  }
  return { kind: 'objects', objects }
}

/**
 * 提取 logic.yaml —— 保留每个规则的完整字段。
 *
 * @returns {{kind:'logic', rules:object[]}}
 */
function extractLogic(doc) {
  const raw = requireArray(doc.rules ?? [], 'logic.yaml 的 rules')
  const rules = []
  for (const [ri, rawR] of raw.entries()) {
    const where = `rules[${ri}]`
    const r = requireObject(rawR, where)
    requireString(r.id, `${where}.id`)
    requireString(r.effect, `${where}.effect`)
    rules.push(r) // 字段值原样保留（含 reason / condition）
  }
  return { kind: 'logic', rules }
}

/**
 * 提取 actions.yaml —— 保留每个 action 的完整字段。
 *
 * @returns {{kind:'actions', actions:object[]}}
 */
function extractActions(doc) {
  const raw = requireArray(doc.actions ?? [], 'actions.yaml 的 actions')
  const actions = []
  for (const [ai, rawA] of raw.entries()) {
    const a = requireObject(rawA, `actions[${ai}]`)
    requireString(a.id, `actions[${ai}].id`)
    actions.push(a) // 字段值原样保留（含 writes / guardrails）
  }
  return { kind: 'actions', actions }
}

/**
 * 提取 guards.yaml —— 保留每个 guard 的完整字段。
 *
 * @returns {{kind:'guards', guards:object[]}}
 */
function extractGuards(doc) {
  const raw = requireArray(doc.guards ?? [], 'guards.yaml 的 guards')
  const guards = []
  for (const [gi, rawG] of raw.entries()) {
    const g = requireObject(rawG, `guards[${gi}]`)
    requireString(g.ref, `guards[${gi}].ref`)
    guards.push(g) // 字段值原样保留（含 impl / tests）
  }
  return { kind: 'guards', guards }
}

/**
 * 按文件路径分发解析 ontology 文本，返回完整结构化对象（字段原样保留）。
 *
 * ⚠️ 非受管 ontology 文件（不在 objects/logic/actions/guards 四类里）⇒ 抛 DslError，
 *    由 classifyChange 兜成 L2（fail-closed：看不透载荷就按最坏档）。
 *
 * @param {string} path - 文件路径（用 basename 匹配）
 * @param {string} text - 文件内容
 */
export function parseOntologyText(path, text) {
  const base = String(path ?? '').replace(/\\/g, '/').split('/').pop()
  const doc = parseYamlSubset(text, base)
  if (base === 'objects.yaml') return extractObjects(doc)
  if (base === 'logic.yaml') return extractLogic(doc)
  if (base === 'actions.yaml') return extractActions(doc)
  if (base === 'guards.yaml') return extractGuards(doc)
  throw new DslError('UnmanagedOntologyFile', `非受管 ontology 文件（${base}），无法分级`)
}
