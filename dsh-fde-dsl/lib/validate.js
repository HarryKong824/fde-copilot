/**
 * D3 编排 —— 把"规则能不能信"压成一份可判定的报告。
 *
 * 六项硬判据（任一项失败即整体不通过）：
 *   ① 规则条数 ≥ cfg.minRules（v3 原文：少于 3 条不通过）
 *   ② 条件能编译（算子在白名单、类型不自相矛盾）
 *   ③ **draft 保护**：effect: deny 的规则不得引用 maturity=draft / status=pending 的属性
 *   ④ 每条规则派生出的反例数 ≥ cfg.minCasesPerRule
 *   ⑤ 至少有一条用例让规则**触发**，也至少有一条让它**不触发**（可反驳性）
 *   ⑥ 引擎求值结果与边界算术期望一致（两条实现路径对拍）
 *
 * ⚠️ 这份校验管的是**规则本身的可执行性 + 可反驳性 + 用例集完整性**，
 *    它不做、也不能做这两件事（README 里会写进能力边界）：
 *    · 不判定规则的**临床正确性**（v3 对 D3 的免责边界原话）
 *    · 不校验"另一份产品实现与规则一致" —— 那要求被测实现先存在，属于后续 Stage
 *
 * 零依赖（除 node:crypto），可离线回归。
 */

import { createHash } from 'node:crypto'
import { collectVars, compileRuleCondition, evaluate } from './dsl.js'
import { deriveCases } from './derive.js'
import { toReportedError } from './errors.js'

/**
 * 报告里"指路"用的文件名（README §10.1）。
 *
 * 为什么敢给：文件名是 §2 文件约定里**已经公开**的三个固定名之一，本来就不是秘密；
 * 红线是"不回显**内容**"（那样会给模型开一条绕过 fde_ontology_read 的读通道），文件名不在红线内。
 * 为什么必须给：不给，模型就只能靠猜文件名或反问人来定位（2026-09-24 活体实测：
 * 它猜了 5 个候选名、全部 ENOENT，最后放弃并反问）—— 每次多轮会话都要重演一遍。
 *
 * 给到哪个文件，取决于**修它要去哪改**：属性声明类问题（`min`/`max`/`enum`/`maturity` 缺失）→ objects.yaml，
 * 条件写法类问题（算子、结构、触发面）→ logic.yaml。
 */
const FILE = { logic: 'logic.yaml', objects: 'objects.yaml' }

// 职责分离（2026-09-24 收敛，别再合回去）：
//   file    = 机器字段，只由 renderReport 渲染成结尾的 ⟨改：xxx.yaml⟩ —— 它是"去哪改"的**唯一事实源**。
//   message = 只讲**为什么错**（铁律依据、后果、建议动作），**不再重复说去哪改**。
// 合在一起的后果：DraftReference 曾同时写「属性成熟度在 objects.yaml 里改」和 ⟨改：objects.yaml⟩，
// 同一信息两处，日后改映射漏改一处就会自相矛盾 —— 这是给未来挖的坑，不是文案啰嗦的问题。

/** 靠"补属性声明"就能修的派生类判据 → 指到 objects.yaml。 */
const ATTRIBUTE_LEVEL_CODES = new Set(['UnknownAttribute', 'NoCandidate', 'NonDerivable'])

function renderValue(v) {
  if (Array.isArray(v)) return `[${v.map(renderValue).join(', ')}]`
  if (typeof v === 'string') return JSON.stringify(v)
  return String(v)
}

/**
 * @param {object} args
 * @param {Map<string, object>} args.attributes - parseObjectsDoc 产出
 * @param {object[]} args.rules - parseRulesDoc 产出
 * @param {object} args.cfg - 规范化配置
 * @returns {object} 校验报告
 */
export function validateOntology({ attributes, rules, cfg }) {
  /** @type {{ruleId?: string, code: string, message: string}[]} */
  const failures = []
  /** @type {{ruleId?: string, code: string, message: string}[]} */
  const warnings = []
  const ruleReports = []
  const allCaseIds = []

  if (rules.length < cfg.minRules) {
    failures.push({
      code: 'TooFewRules',
      file: FILE.logic,
      message: `规则数为 ${rules.length}，少于要求的最少 ${cfg.minRules} 条（v3：少于 3 条不通过）`
    })
  }

  for (const rule of rules) {
    let compiled
    try {
      compiled = compileRuleCondition(rule.condition, `${rule.id}.condition`)
    } catch (e) {
      failures.push({ ruleId: rule.id, ...toReportedError(e), file: FILE.logic })
      ruleReports.push({ id: rule.id, effect: rule.effect, cases: 0, firesTrue: 0, firesFalse: 0, error: true })
      continue
    }

    // ---- ③ draft 保护（v3 铁律）----
    for (const path of collectVars(compiled.ast)) {
      const attr = attributes.get(path)
      if (!attr) continue // 未声明属性由 deriveCases 报 UnknownAttribute，不重复
      if (rule.effect !== 'deny') continue
      if (attr.maturity === 'draft' || attr.status === 'pending') {
        const detail =
          attr.maturity === 'draft'
            ? `maturity=draft`
            : `status=${attr.status}`
        failures.push({
          ruleId: rule.id,
          code: 'DraftReference',
          file: FILE.objects,
          message:
            `规则 ${rule.id}（effect: deny）引用了未成熟属性 ${path}（${detail}）。` +
            'v3 铁律：deny 规则不得引用 draft / pending 属性 —— 草稿属性没经数据验证，' +
            '用它做临床判定等于把未验证假设当成门禁依据。请先转成 verified。'
          // ↑ 结尾不再写"去哪改"：由 file 字段 + renderReport 统一渲染 ⟨改：⟩，
          //   避免同一事实两处表达（详见上方 FILE 的职责分离注释）。
        })
      }
    }

    // ---- 派生 + 执行用例 ----
    const { cases, issues } = deriveCases({ rule, compiled, attributes, maxCombos: cfg.maxCombos })

    for (const issue of issues) {
      // 判据指向"属性声明不全"→ 指到 objects.yaml；否则是规则写法问题 → logic.yaml
      const at = ATTRIBUTE_LEVEL_CODES.has(issue.code) ? FILE.objects : FILE.logic
      if (issue.code === 'NonDerivable') {
        // 全生命周期 Anlaytics：非 deny 规则允许有测不到的分支，只提示；
        // deny 规则一旦有盲区就是门禁漏洞 —— 判失败。
        if (rule.effect === 'deny') failures.push({ ruleId: rule.id, ...issue, file: at })
        else warnings.push({ ruleId: rule.id, ...issue, file: at })
      } else {
        failures.push({ ruleId: rule.id, ...issue, file: at })
      }
    }

    let firesTrue = 0
    let firesFalse = 0
    for (const c of cases) {
      allCaseIds.push(c.id)
      // 组合用例没有焦点叶子，跳过叶子级对拍（它只贡献整规则覆盖）
      if (c.expectedLeaf !== null) {
        try {
          const leafActual = evaluate(c.leafAst, c.input)
          if (leafActual !== c.expectedLeaf) {
            failures.push({
              ruleId: rule.id,
              code: 'OracleMismatch',
              file: FILE.logic,
              message:
                `用例 ${c.id}（${c.focus} ${c.leafOp} ${renderValue(c.leafThreshold)}，输入 ${renderValue(c.input[c.focus])}）：` +
                `边界算术期望 ${c.expectedLeaf}，引擎给出 ${leafActual} —— 两条实现路径对不上，其中一边有 bug`
            })
          }
        } catch (e) {
          failures.push({
            ruleId: rule.id,
            code: 'LeafEvalError',
            file: FILE.logic,
            message: `用例 ${c.id} 叶子求值失败：${toReportedError(e).message}`
          })
          continue
        }
      }

      try {
        if (evaluate(compiled.ast, c.input)) firesTrue += 1
        else firesFalse += 1
      } catch (e) {
        failures.push({
          ruleId: rule.id,
          code: 'EvalError',
          file: FILE.logic,
          message: `用例 ${c.id} 整条规则求值失败：${toReportedError(e).message}`
        })
      }
    }

    // ---- ④ 用例数量够不够 ----
    if (cases.length < cfg.minCasesPerRule) {
      failures.push({
        ruleId: rule.id,
        code: 'TooFewCases',
        file: FILE.objects,
        message:
          `规则 ${rule.id} 只派生出 ${cases.length} 条反例，少于要求的 ${cfg.minCasesPerRule} 条。` +
          '补齐办法（纯声明层面，不改条件）：给参与比较的 number 属性补 `min:` / `max:`，' +
          '给 string 属性补 `enum:`，即可机械多出下界/上界/非成员 等用例。'
      })
    }

    // ---- ⑤ 可反驳性 ----
    if (cases.length > 0 && firesTrue === 0) {
      failures.push({
        ruleId: rule.id,
        code: 'RuleNeverFires',
        file: FILE.logic,
        message: `规则 ${rule.id} 在所有派生的用例里都不触发 —— 它是一条死规则（门槛永远够不着），写它不会拦住任何东西`
      })
    }
    if (cases.length > 0 && firesFalse === 0) {
      failures.push({
        ruleId: rule.id,
        code: 'RuleAlwaysFires',
        file: FILE.logic,
        message: `规则 ${rule.id} 在所有派生的用例里都触发 —— 它是一条永真规则，会拦住一切，包括合法输入`
      })
    }

    ruleReports.push({
      id: rule.id,
      effect: rule.effect,
      cases: cases.length,
      firesTrue,
      firesFalse
    })
  }

  // 用例集指纹：删掉/改掉任意一条用例都会让它变化 —— "用例不可删"的证据就在这里。
  const fingerprint = createHash('sha256')
    .update(allCaseIds.slice().sort().join('|'))
    .digest('hex')
    .slice(0, 16)

  return {
    passed: failures.length === 0,
    summary: {
      rules: rules.length,
      cases: allCaseIds.length,
      failures: failures.length,
      warnings: warnings.length,
      fingerprint
    },
    rules: ruleReports,
    failures,
    warnings
  }
}
