/**
 * D3 验证器与 DSH 的接线层 —— 文件加载 + `fde-run-validation` 工具注册。
 *
 * ## 为什么这里用原生 node:fs 直读，而不是走通用 read
 * 两个原因，缺一不可：
 *   1. ontology 在会话工作区**之外**，原生 fs 围栏在 workspace-write 下会把区外当只读；
 *   2. 更关键：**另一个插件（fde-ontology-gate）已经把通用 `read` 接管了** ——
 *      读 ontology 只能走 `fde_ontology_read`。本插件是同进程内的受控消费者，
 *      用 node:fs 直读是唯一现实可行的取数方式。
 *
 * ⚠️ 由此产生一条硬约束：**工具输出只能给"报告"，绝不能回显文件内容。**
 *    否则就等于给模型开了一条绕过 `fde_ontology_read` 的读通道 —— 把门禁自己的口子撕开。
 *    这条在 `_fde_dsl_test.mjs` 里有专门用例盯着。
 *
 * ## "用例不可删"是怎么落地的
 * 工具**只接受一个 `reason` 参数**（写审计用），没有任何 skip / only / expected 之类的口子 ——
 * 用例集完全由 objects.yaml 机械派生，模型在调用层面**无法**去掉任何一条用例。
 * 不可删不是靠约定，是靠"根本没有这个参数"实现，这一点可以直接测。
 */

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  applyMaturityOverrides,
  parseMaturityDoc,
  parseObjectsDoc,
  parseRulesDoc
} from './schema.js'
import { validateOntology } from './validate.js'
import { checkD1 } from './check-d1.js'

/** 工具名。v3 9.2 原文就把内部验证工具叫这个名字。 */
export const VALIDATION_TOOL = 'fde-run-validation'

/** D1 护栏校验工具名（Phase 3 的 deny 门禁依赖它广播结论）。 */
export const GUARDRAILS_TOOL = 'fde-run-guardrails-check'

/**
 * **按 check 分派的锚点算法表**。
 *
 * 🔴 这张表在 `dsh-fde-phase/lib/mirror.js` 里有一份同名字面量，两边必须逐项相同 ——
 * 由 `_fde_d2d3_test.mjs` 的"两侧 ANCHOR_ALGS 逐项相同"用例机器钉住。
 *
 * 为什么不能共享一份：dsl 与 phase 是两个**独立安装**的插件包，跨 import 等于引入
 * 包间运行时依赖（其中一个没装上 → 另一个直接加载失败）。宁可提高一致性要靠测试保证，
 * 也不要把两个插件的命运绑在一起。
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ANCHOR_ALGS = Object.freeze({
  D1: 'sha256(actions+\u0000+guards)@v2',
  D3: 'sha256(objects+\u0000+logic)@v1',
  D2: 'audit-chain(len+head)@v1',
  D5: 'compliance.yaml(sha256+len+nonempty)@v1'
})

/** ontology 里的约定文件名。缺 objects.yaml / logic.yaml 即视为配置错误。 */
export const ONTOLOGY_FILES = {
  objects: 'objects.yaml',
  logic: 'logic.yaml',
  maturity: 'maturity.yaml',
  // D1 独立加载路径：D1 不该因为 objects.yaml / logic.yaml 缺失而跑不了。
  actions: 'actions.yaml',
  guards: 'guards.yaml'
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw e
  }
}

/**
 * 从 ontologyRoot 读出并解析三个文件。
 *
 * @param {object} cfg - 规范化配置
 * @returns {Promise<{attributes: Map<string, object>, rules: object[], missing: string[]}>}
 */
export async function loadOntology(cfg) {
  const root = resolve(cfg.ontologyRoot)

  const objectsText = await readFile(join(root, ONTOLOGY_FILES.objects), 'utf8').catch((e) => {
    if (e && e.code === 'ENOENT') return null
    throw e
  })
  const logicText = await readFile(join(root, ONTOLOGY_FILES.logic), 'utf8').catch((e) => {
    if (e && e.code === 'ENOENT') return null
    throw e
  })

  const missing = []
  if (objectsText === null) missing.push(ONTOLOGY_FILES.objects)
  if (logicText === null) missing.push(ONTOLOGY_FILES.logic)
  if (missing.length > 0) {
    throw new Error(
      `ontology 目录缺少必需文件（${missing.join('、')}）。` +
        `请在 ${root} 下先建 objects.yaml / logic.yaml —— D3 没有规则可验，宁可不跑，也不静默放行。`
    )
  }

  const maturityText = await readOptional(join(root, ONTOLOGY_FILES.maturity))
  if (maturityText !== null && maturityText.trim().length === 0) {
    throw new Error(`${ONTOLOGY_FILES.maturity} 存在但为空：请删掉文件或写全 nodes 映射`)
  }

  const { attributes } = parseObjectsDoc(objectsText, cfg)
  const overrides = parseMaturityDoc(maturityText, cfg)
  applyMaturityOverrides(attributes, overrides)
  const rules = parseRulesDoc(logicText, cfg)

  return { attributes, rules, missing }
}

/**
 * 失败/提示项末尾的"去哪个文件改"标记。
 *
 * README §10.1：只给**文件名**，不给内容、不给行号。
 * 文件名是 §2 已经公开的固定三名之一，不是秘密；红线是"不回显 ontology 内容"，文件名不在红线内。
 *
 * @param {{file?: string}} item
 * @returns {string}
 */
function locOf(item) {
  return typeof item?.file === 'string' && item.file.length > 0 ? `　⟨改：${item.file}⟩` : ''
}

/** 把报告压成一段人能直接读的话（也是工具回执的正文）。 */
export function renderReport(report) {
  const s = report.summary
  const head =
    `D3 校验：${report.passed ? '通过' : '不通过'}　` +
    `规则 ${s.rules} 条 / 反例 ${s.cases} 条 / 失败 ${s.failures} 项 / 提示 ${s.warnings} 项　` +
    `用例集指纹 ${s.fingerprint}`

  const lines = [head]
  if (report.failures.length > 0) {
    lines.push('失败项：')
    for (const f of report.failures) {
      lines.push(`  · ${f.ruleId ? `[${f.ruleId}] ` : ''}${f.code}：${f.message}${locOf(f)}`)
    }
  }
  if (report.warnings.length > 0) {
    lines.push('提示项：')
    for (const w of report.warnings) {
      lines.push(`  · ${w.ruleId ? `[${w.ruleId}] ` : ''}${w.code}：${w.message}${locOf(w)}`)
    }
  }
  return lines.join('\n')
}

/**
 * 注册 `fde-run-validation`。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 规范化配置
 * @returns {() => void} 注销器
 */
export function installValidationTool(ctx, cfg) {
  return ctx.tools.register(
    defineTool({
      name: VALIDATION_TOOL,
      description:
        '跑 D3 校验：对 ontology 里的规则做受限 DSL 检查 + 边界值反例派生 + 用例执行，返回通过/不通过报告。' +
        '注意：返回的是**校验报告**，不含 ontology 文件内容 —— 读文件请用 fde_ontology_read。',
      parameters: {
        reason: {
          type: 'string',
          description: '本次跑校验的业务理由（写入回执，便于追溯）'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            passed: { type: 'boolean', required: true },
            // ⚠️ 嵌套 object **必须**显式声明 additionalProperties —— 顶层写了不够。
            // DSH 真实的 @deepseek-ai/dsh-tools 会校验到每一层，缺了就抛
            // `unsupported JSON schema: schema.properties.summary.additionalProperties
            //  must be explicitly true or false`；而那个错误发生在 defineTool() 里，
            // 等于插件加载即失败、工具根本注册不上。
            //
            // 这里取 `true` 而不是 `false`：summary 是随报告版本增长的字段袋
            // （rules / cases / failures / warnings / fingerprint / reason …），
            // 写 false 又不列 properties 会在**运行时**拒绝返回值。
            summary: { type: 'object', additionalProperties: true, required: true },
            rules: { type: 'array', required: true },
            failures: { type: 'array', required: true },
            warnings: { type: 'array', required: true }
          }
        },
        render(_args, value) {
          return [{ type: 'text', text: renderReport(value) }]
        }
      },
      async execute(args, exec) {
        const { attributes, rules } = await loadOntology(cfg)
        const report = validateOntology({ attributes, rules, cfg })
        const text = renderReport(report)

        // —— D3 广播（Stage 5.5 接线）——
        // 锚点 = objects.yaml + logic.yaml 的复合 sha256（alg 见 ANCHOR_ALGS.D3）。
        // 🔴 为什么锚这两个文件：D3 验的是"规则↔实现一致"，规则就写在 objects/logic 里。
        //    若照搬 D1 那套锚 actions/guards，改了 objects 却不动 actions ⇒ D3 还"新鲜" ⇒ 形同虚设。
        // ⚠️ 广播失败不得让校验本身失败（与 GUARDRAILS_TOOL 同一模式，tools.js:303-307）。
        try {
          const root = resolve(cfg.ontologyRoot)
          const objectsPath = join(root, ONTOLOGY_FILES.objects)
          const logicPath = join(root, ONTOLOGY_FILES.logic)
          const objectsText = await readFile(objectsPath, 'utf8').catch(() => null)
          const logicText = await readFile(logicPath, 'utf8').catch(() => null)
          const anchorSha =
            objectsText !== null && logicText !== null
              ? createHash('sha256').update(objectsText + '\u0000' + logicText).digest('hex')
              : null
          ctx.emit('fde/check-result', {
            check: 'D3',
            passed: report.passed,
            anchor:
              anchorSha !== null
                ? { alg: ANCHOR_ALGS.D3, files: [objectsPath, logicPath], sha256: anchorSha }
                : null,
            detail:
              report.failures.length > 0
                ? report.failures.map((f) => `[${f.code}] ${f.ruleId ?? '-'}: ${f.message}`).join('; ')
                : 'ok',
            at: new Date().toISOString(),
            callId: exec?.callId
          })
        } catch (e) {
          ctx.logger?.warn?.(`[${VALIDATION_TOOL}] 广播 fde/check-result(D3) 失败（已忽略）：${e?.message ?? e}`)
        }

        if (!report.passed && cfg.mode === 'enforce') {
          // enforce：让工具调用失败（tool/result 的 isError=true），模型看到的就是拦住了。
          // ⚠️ shadow 模式下**故意不抛** —— 影子模式的意义就是"看见了但先不拦"。
          throw new Error(text)
        }
        return {
          passed: report.passed,
          summary: { ...report.summary, reason: args?.reason ?? '' },
          rules: report.rules,
          failures: report.failures,
          warnings: report.warnings
        }
      }
    })
  )
}

/**
 * 把 D1 校验结果压成一段人话（也是工具回执正文）。不回显 ontology 内容。
 * @param {{passed:boolean, failures:object[], anchor_sha256:string}} r
 */
function renderGuardrails(r) {
  const head = `D1 护栏校验：${r.passed ? '通过' : '不通过'}`
  const lines = [head, `  actions/guards 复合锚点 sha256：${r.anchor_sha256 || '（无）'}`, `  失败项：${r.failures.length} 条`]
  if (r.failures.length > 0) {
    for (const f of r.failures) {
      lines.push(`  · [${f.code}] ${f.where}：${f.message}`)
    }
  }
  return lines.join('\n')
}

/**
 * 注册 `fde-run-guardrails-check`（D1）。
 *
 * 与 `fde-run-validation` 平行：独立加载 actions.yaml / guards.yaml（不依赖 objects/logic），
 * 跑 check-d1 四项，并将结论**广播**给 phase 插件。
 *
 * ⚠️ **广播必须 try/catch 包住**：事件监听器若同步抛错会直接冒泡给本调用方，
 * 导致"校验本身失败"的误报。广播失败只影响 phase 的镜像更新，校验结论仍正常返回。
 * ⚠️ **不动** `fde-run-validation` 的现有行为；本工具是新增通道。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化配置
 * @returns {() => void} 注销器
 */
export function installGuardrailsTool(ctx, cfg) {
  return ctx.tools.register(
    defineTool({
      name: GUARDRAILS_TOOL,
      description:
        '跑 D1 校验：检查 ontology 的护栏（guardrails）是否绑好——ref 是否可解析、impl 是否可编译、' +
        '测试是否 100% 通过、写操作是否覆盖 true/false 分支、是否至少有 1 个 deny 护栏。' +
        '注意：返回的是校验报告，不含 ontology 文件内容。跑过后会把结论广播给阶段机插件。',
      parameters: {
        reason: {
          type: 'string',
          required: true,
          description: '本次跑 D1 校验的业务理由（写入回执，便于追溯）'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            passed: { type: 'boolean', required: true },
            anchor_sha256: { type: 'string', required: true },
            failure_count: { type: 'number', required: true },
            failures: { type: 'array', required: true }
          }
        },
        render(_args, value) {
          return [{ type: 'text', text: renderGuardrails(value) }]
        }
      },
      async execute(args, exec) {
        const root = resolve(cfg.ontologyRoot)
        const actionsPath = join(root, ONTOLOGY_FILES.actions)
        const guardsPath = join(root, ONTOLOGY_FILES.guards)

        // 独立加载（缺 objects/logic 不影响 D1）；文件缺失 → 传 null（checkD1 会 fail-closed）。
        const actionsText = await readFile(actionsPath, 'utf8').catch((e) =>
          e && e.code === 'ENOENT' ? null : (() => {
            throw e
          })()
        )
        const guardsText = await readFile(guardsPath, 'utf8').catch((e) =>
          e && e.code === 'ENOENT' ? null : (() => {
            throw e
          })()
        )

        // P1-1：锚点 = actions.yaml + guards.yaml 原始文本的复合 sha256（两文件任一变更即失效，
        // 堵住「只改 guards 放宽 impl」的绕过）。两文件以 \u0000 连接后取 sha256；
        // 算法必须与 dsh-fde-phase/lib/mirror.js 的 ANCHOR_ALGS.D1 / compositeAnchorSha 保持一致
        //（那边的 D1 alg 仍是同一字面量；不一致时 guard 会判"锚点算法过期"并拒绝推进）。
        const anchorSha =
          actionsText !== null && guardsText !== null
            ? createHash('sha256').update(actionsText + '\u0000' + guardsText).digest('hex')
            : null

        const { passed, failures } = checkD1(actionsText, guardsText)

        // 广播结论给 phase 插件（fde_phase_advance 的 guard 据此比对锚点）。
        try {
          ctx.emit('fde/check-result', {
            check: 'D1',
            passed,
            anchor:
              anchorSha !== null
                ? { alg: ANCHOR_ALGS.D1, files: [actionsPath, guardsPath], sha256: anchorSha }
                : null,
            detail: failures.length > 0 ? failures.map((f) => `[${f.code}] ${f.where}: ${f.message}`).join('; ') : 'ok',
            at: new Date().toISOString(),
            callId: exec?.callId
          })
        } catch (e) {
          // 广播失败不得让校验本身失败；仅记一条日志，结论仍正常返回。
          ctx.logger?.warn?.(`[${GUARDRAILS_TOOL}] 广播 fde/check-result 失败（已忽略）：${e?.message ?? e}`)
        }

        const result = { passed, anchor_sha256: anchorSha ?? '', failure_count: failures.length, failures }

        if (!passed && cfg.mode === 'enforce') {
          throw new Error(renderGuardrails(result))
        }
        return result
      }
    })
  )
}
