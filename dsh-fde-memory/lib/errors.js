// 照抄自 dsh-fde-dsl/lib/errors.js（1186 B，源件 sha256=08598d30f3e33b7f1c6b7881534b252662d23a75d16100de797d86aaf2b85f4f）
// 照抄原因：0076 §3.3 —— 插件独立安装，跨包 import 会互相拖垮（先例：ANCHOR_ALGS 各存一份）
// 与源件的等价性由 _fde_memory_decisions_test.mjs 的「跨包等价」用例钉住（行为对拍，非文本 diff）

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
