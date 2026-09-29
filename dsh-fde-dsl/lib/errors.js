/**
 * DSL / D3 模块的错误类型。
 *
 * 统一带 `code` 的原因：D3 报告要给规则作者看，机器可读的 code 才能做分类
 * （UnknownOperator / TypeMismatch / DraftReference …），靠中文消息做匹配太脆。
 */
export class DslError extends Error {
  /**
   * @param {string} code - 机器可读的错误码
   * @param {string} message - 给人看的中文说明
   * @param {object} [detail] - 结构化附加信息（算子名、属性路径等）
   */
  constructor(code, message, detail) {
    super(message)
    this.name = 'DslError'
    this.code = code
    this.detail = detail
  }
}

/** 类型收窄用。 */
export function isDslError(e) {
  return e instanceof DslError
}

/**
 * 把任意抛出的东西收敛成 {code, message}。
 * 校验流程里任何位置都可能抛非 DslError（比如 YAML 解析器、fs），
 * 报告里必须保留证据，不能吞掉。
 */
export function toReportedError(e) {
  if (isDslError(e)) return { code: e.code, message: e.message, detail: e.detail }
  if (e instanceof Error) return { code: 'UnexpectedError', message: e.message }
  return { code: 'UnexpectedError', message: String(e) }
}
