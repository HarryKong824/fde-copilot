/**
 * 最小 YAML 子集解析器 —— **宁可报错，不可猜**。
 *
 * 为什么不引第三方 yaml 库：这一层要判的是合规规则，解析器自身的歧义就是攻击面。
 * 本模块只认两类写法，其余一律抛 `YamlParseError` 并带上行号：
 *
 *   ① 缩进块（entities 列表、嵌套映射）—— 用 2 空格缩进，禁止 Tab
 *   ② 行内必须是**合法 JSON** —— `condition: {">": [{"var": "x"}, 100]}`、`enum: ["a","b"]`
 *
 * 不支持（会明确报错，不会静默接受）：多行字符串 `|` / `>`、锚点与别名 `&`/`*`、
 * 多文档 `---`、复杂键、`key: value # 注释` 里的行尾注释、`yes/no/on/off`。
 *
 * ⚠️ 行尾注释特意不支持：`reason: 剂量超上限 # 见规范 2.3` 会被整体当成字符串，
 *    这是刻意选择 —— 支持它就得引入"井号是否在引号内"的状态机，收益远小于风险。
 */

import { DslError } from './errors.js'

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
 * 解析 YAML 子集文本。
 *
 * @param {string} text - 文件内容
 * @param {string} [where] - 报错里显示的文件名
 * @returns {unknown} 顶层容器（对象或数组）
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
