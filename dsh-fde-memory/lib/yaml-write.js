/**
 * yaml-write.js —— 简单 YAML 序列化（A3 §3.1 提取，原私有于 decisions.js:209-268）。
 *
 * 逐字搬迁自 decisions.js 的 serializeYaml/formatValue/formatInline，行为不变。
 * 搬迁理由：A3 的三个写入器（checklist/stakeholders/maturity）都要用同一份序列化，
 * 不提取会出现两份（漂移风险）。
 *
 * 不引第三方库 —— 只支持本插件写入的字段类型（string/number/boolean/null/array/object）。
 */

/**
 * 简单 YAML 序列化（本插件的 decision 文件格式固定）。
 * 不引第三方库 —— 只支持本插件写入的字段类型（string/number/boolean/null/array/object）。
 */
export function serializeYaml(obj) {
  const lines = []
  for (const [k, v] of Object.entries(obj)) {
    lines.push(`${k}:${formatValue(v, 0)}`)
  }
  return lines.join('\n') + '\n'
}

export function formatValue(v, indent) {
  if (v === null) return ' null'
  if (typeof v === 'boolean') return ` ${v}`
  if (typeof v === 'number') return ` ${v}`
  if (typeof v === 'string') {
    if (v.length === 0) return ' ""'
    // 含特殊字符 / 布尔字面量 / null 字面量 / 数字字面量 都加引号
    // —— 避免 YAML 类型推断把 "0.1" 当数字、把 "true" 当布尔（破坏 phase 字符串语义）
    const looksNumeric = v.trim() !== '' && !isNaN(Number(v)) && isFinite(Number(v))
    if (/[:\n\r#"'\[\]{}]|^\s|\s$/.test(v) || /^(yes|no|on|off|true|false|null|~)$/i.test(v) || looksNumeric) {
      // 用 JSON 字符串（双引号 + 转义）—— 与 yamlsubset 的 unquote 兼容
      return ` ${JSON.stringify(v)}`
    }
    return ` ${v}`
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return ' []'
    const pad = ' '.repeat(indent + 2)
    return '\n' + v.map((x) => `${pad}-${formatInline(x, indent + 2)}`).join('\n')
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v)
    if (keys.length === 0) return ' {}'
    const pad = ' '.repeat(indent + 2)
    return '\n' + keys.map((k) => `${pad}${k}:${formatValue(v[k], indent + 2)}`).join('\n')
  }
  return ` ${String(v)}`
}

export function formatInline(v, indent) {
  if (v === null) return ' null'
  if (typeof v === 'boolean') return ` ${v}`
  if (typeof v === 'number') return ` ${v}`
  if (typeof v === 'string') {
    if (v.length === 0) return ' ""'
    // 同 formatValue：数字字面量也加引号
    const looksNumeric = v.trim() !== '' && !isNaN(Number(v)) && isFinite(Number(v))
    if (/[:\n\r#"'\[\]{}]|^\s|\s$/.test(v) || /^(yes|no|on|off|true|false|null|~)$/i.test(v) || looksNumeric) {
      return ` ${JSON.stringify(v)}`
    }
    return ` ${v}`
  }
  if (Array.isArray(v) || typeof v === 'object') {
    // 行内 JSON（与 yamlsubset 的 parseScalar 对齐）
    return ` ${JSON.stringify(v)}`
  }
  return ` ${String(v)}`
}
