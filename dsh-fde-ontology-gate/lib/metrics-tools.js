import * as dshTools from '@deepseek-ai/dsh-tools'
import { collectMetrics, formatMetricsReport } from './metrics.js'

const { defineTool } = dshTools

/**
 * `fde_metrics` —— spec v3 §14 六项验证指标的**只读**采集入口。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三个刻意的设计点（都会被"顺手改一下"改坏，故就地写清）：
 *
 * ① **分母为 0 报 `insufficient-data`，不报 0%。**
 *    §14 六条推翻条件全是阈值比较（`< 30%` / `> 20%` / `> 5` / `> 30%` / `> 15` / `< 70%`），
 *    而 `0 < 30%` 为真 ⇒ 报 0% 会让一条**从未被观测过**的指标当场触发推翻结论。
 *    工具输出的 `value` 在无数据时是 `'—（无样本，不报 0%）'`，**不是** `'0.0%'`。
 *
 * ② **总判决只由 `overturn` 驱动，`insufficient-data` 不算通过。**
 *    读者最容易被一个绿色总判决骗过去；`no-data` 是一个独立的判决，不是 `ok` 的变体。
 *
 * ③ **只读也入链**（与 `fde_ontology_read` / `fde_shadow_status` 同形态）。
 *    本项目的口径是"留痕即失效"——只要有一类访问不落链，"完整访问史"就不成立。
 *    但**指标数值本身不写进链**（只写 verdict 与命中的推翻项）：链是合规证据，
 *    不是报表缓存；把六个比值抄进去，链就会随样本增长而与真值漂移。
 * ─────────────────────────────────────────────────────────────────────
 */

export const METRICS = 'fde_metrics'

/** null ⇒ 文本（工具输出 schema 里没有 null，且"无数据"必须与"0"可分辨）。 */
function numText(v, unit) {
  if (v === null || v === undefined) return '—'
  if (unit === 'pct') return `${(v * 100).toFixed(1)}%`
  if (unit === 'count') return String(Number(v.toFixed(2)))
  return String(Number(v.toFixed(3)))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化配置
 * @param {import('./audit.js').AuditChain} audit
 * @returns {() => void} 注销器
 */
export function installMetricsTools(ctx, cfg, audit) {
  return ctx.tools.register(
    defineTool({
      name: METRICS,
      description:
        '采集 spec §14 的六项验证指标（deny 修复率 / break-glass 分类 / 变更触发率 / ' +
        'ask 跳过率 / Phase 停留时长 / 影子模式准确率）与各自的推翻条件。' +
        '只读：不改任何业务状态，只读两条审计链（gate + phase）。' +
        '⚠️ 无样本的指标报 "insufficient-data"，**不报 0%** —— 0% 会误触推翻条件。',
      parameters: {
        reason: {
          type: 'string',
          required: true,
          description: '本次采集的业务理由（写入审计）'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            verdict: { type: 'string', required: true },
            overturns: { type: 'array', required: true, items: { type: 'string' } },
            insufficient: { type: 'array', required: true, items: { type: 'string' } },
            metrics: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  value: { type: 'string', required: true },
                  numerator: { type: 'string', required: true },
                  denominator: { type: 'string', required: true },
                  verdict: { type: 'string', required: true },
                  confidence: { type: 'string', required: true },
                  overturnWhen: { type: 'string', required: true },
                  overturnHit: { type: 'boolean', required: true },
                  note: { type: 'string', required: true }
                }
              }
            },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
            message: { type: 'string', required: true }
          }
        },
        render(_args, value) {
          return [{ type: 'text', text: value.message }]
        }
      },
      async execute(args, exec) {
        const report = await collectMetrics(cfg)
        // 只读入链（见文件头 ③）。`.catch` 吞掉审计故障：审计坏了不该改变一次只读查询的结果。
        // ⚠️ 只写 verdict 与命中项，**不写六个比值**（理由见文件头 ③）。
        await audit
          .record({
            tool: METRICS,
            decision: 'allow',
            reason: args.reason,
            verdict: report.verdict,
            overturns: report.overturns,
            insufficient: report.insufficient,
            callId: exec?.callId
          })
          .catch(() => {})
        return {
          verdict: report.verdict,
          overturns: report.overturns,
          insufficient: report.insufficient,
          metrics: report.metrics.map((m) => ({
            id: m.id,
            name: m.name,
            value: numText(m.value, m.unit),
            numerator: m.numerator === null ? '—' : String(m.numerator),
            denominator: m.denominator === null ? '—' : String(m.denominator),
            verdict: m.verdict,
            confidence: m.confidence,
            overturnWhen: m.overturnWhen,
            overturnHit: m.overturnHit,
            note: m.note
          })),
          warnings: report.warnings,
          message: formatMetricsReport(report)
        }
      }
    })
  )
}
