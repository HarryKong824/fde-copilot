import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import * as dshTools from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { isInside } from './paths.js'
import { classifyChange, resolveManualLevel } from './classify.js'

// HarnessError 的正确来源是 @deepseek-ai/dsh-llm（dsh-tools 不 re-export，见 phase/tools.js 同修）。
const { defineTool } = dshTools

/**
 * 专用工具：模型操作 ontology 的唯一合法通道。
 *
 * 按架构决议（6.7 推论 1），专用工具用**原生 `node:fs` 直写**，而不是走 `ctx.fs`：
 * ontology 在区外，workspace-write 围栏会把"专用工具自己的合法写"一起误杀。
 * 插件跑在核心进程内，天然有该权限 —— 这把专用工具变成"唯一被授权绕过原生
 * 围栏的合法通道"，合规由 guard 在入口把守。
 *
 * ⚠️ 因此 guard 是这条通道上的**唯一**闸门：专用工具的 execute 里只做路径
 * 复核（防绕过 guard 的直接调用），语义合规判定不在这里重复实现。
 */

export const ONTOLOGY_READ = 'fde_ontology_read'
export const ONTOLOGY_WRITE = 'fde_ontology_write'

/**
 * 审计里的**独立决策类别**：读通道发起过但没读成的访问（越界 / ENOENT / 指向目录）。
 *
 * 为什么单列一类、不写成 `deny`：它**没有拦任何东西**（当初本来就直接抛错返回了），
 * 写成 deny 会把"模型自己失败的探测"记成"门禁的拦截"，污染 enforcer 语义。
 * 它就是一条访问史 —— 存在性探测本身即为要管的行为。
 */
export const READ_PROBE = 'read-probe'

/**
 * 审计里的第二个**独立决策类别**：写通道发起过但没写成的访问（越界 / path 非法）。
 *
 * 为什么要补这一条（2026-09-26，0020 §7.1 / 0022 §2）：`fde_ontology_write` 里
 * `resolveWithinOntology()` 是**裸调用**（抛错就中断），而 `audit.record({decision:'allow'})`
 * 排在写文件之后 ⇒ **越界被拒时整条调用零留痕**。而本项目口径（`tools.js:105` 原话）是：
 *
 * > 只要有一类访问不落链，"完整访问史"这个说法就不成立（本项目口径：留痕即失效）。
 *
 * ⇒ 写侧没跟上，这句口径在写侧就不成立；且越界写**恰是最该留痕的那一类**（攻击信号）。
 *
 * 为什么单列 `write-probe` 而不复用 `read-probe`：读写两侧要能分别统计 ——
 * "谁在读、猜了哪些文件"与"谁在试图写出去"是两类不同的信号，混在一起就没法分辨。
 * 语义与读侧严格同形态：**记而不拦**（照抛原错、判定语义一行不改）。
 */
export const WRITE_PROBE = 'write-probe'

/** payload 来源。防污染：不同来源适用不同置信度门槛。 */
export const SOURCES = ['user', 'model', 'tool', 'import']

/**
 * 把模型给的 path 收敛到 ontology 之内。
 *
 * guard 已经拦过一次，这里是纵深防御：万一 guard 的规则被改坏、或工具被
 * 内部通道直接调用，execute 这一层仍然不许越界。
 *
 * @param {string} rawPath - 工具参数里的路径（相对则按 ontologyRoot 解析）
 * @param {string} ontologyRoot
 * @returns {string} ontology 内的绝对路径
 */
function resolveWithinOntology(rawPath, ontologyRoot) {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new Error('path 必须是非空字符串')
  }
  const root = resolve(ontologyRoot)
  const absolute = resolve(root, rawPath)
  if (!isInside(absolute, root)) {
    throw new Error(`路径越界：${rawPath} 不在 ontology 目录内`)
  }
  return absolute
}

/**
 * 注册两个专用工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化的配置
 * @param {import('./audit.js').AuditChain} audit
 * @returns {() => void} 注销器
 */
export function installOntologyTools(ctx, cfg, audit) {
  const disposeRead = ctx.tools.register(
    defineTool({
      name: ONTOLOGY_READ,
      // 2026-09-24 活验发现：不列文件名时，模型只能盲猜（实测一次会话里错猜 7 个名字、
      // 1 次 glob 被拒，最后靠 grep 我们自己的插件源码拿到 logic.yaml —— 隔了 1173 个 seq）。
      // 这三个名字是 dsl README §2 已公开的约定，不是秘密；列出来不产生任何新泄漏，
      // 反而消掉一整类盲探。教训：**写在插件实现里的字符串不是秘密**（隐藏没用，只会逼模型绕路）。
      description:
        '读取 ontology 目录内的文件。这是读取 ontology 的唯一合法通道。' +
        '可用文件名：objects.yaml（对象与属性声明）、logic.yaml（规则表）、' +
        'maturity.yaml（成熟度覆盖，**可选**，可能不存在）。',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: '相对 ontology 根目录的路径（如 objects.yaml）'
        },
        reason: {
          type: 'string',
          required: true,
          description: '本次读取的业务理由（写入审计）'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            content: { type: 'string', required: true },
            bytes: { type: 'number', required: true }
          }
        },
        render(_args, value) {
          return [{ type: 'text', text: `ontology/${value.path}\n${value.content}` }]
        }
      },
      async execute(args, exec) {
        // 🔴 读探测也要留痕（2026-09-24 活体发现；README §10.2 / 手册 §7 #5）：
        //    在此之前，"读不到"的三条路径（越界 / 文件不存在 / 指向目录）都是**直接抛错、一行不记**
        //    —— 模型可以逐个猜文件名、靠报错与否判断文件是否存在，审计完全无痕。
        //    硬证据：审计文件 mtime 停在 15:22:21.262，那三次探测发生在 15:22:22.604/615/622。
        //    只要有一类访问不落链，"完整访问史"这个说法就不成立（本项目口径：留痕即失效）。
        //
        //    这里是 **记而不拦**：只补可见性，**判定语义一行不改** —— 照样抛原来的错误、
        //    照样不改变 allow/deny 结论。防刷屏靠独立类别 `read-probe` 区分，后续要节流再说。
        const probe = (fields) =>
          audit
            .record({
              tool: ONTOLOGY_READ,
              decision: READ_PROBE,
              reason: args.reason,
              callId: exec?.callId,
              ...fields
            })
            .catch(() => {
              // 审计自身故障不得改变读取结果 —— 沿用本项目既有取舍（audit fail-open）
            })

        let absolute
        try {
          absolute = resolveWithinOntology(args.path, cfg.ontologyRoot)
        } catch (e) {
          await probe({ target: String(args.path ?? ''), code: 'OutOfOntology' })
          throw e
        }

        // 目录要单独挡：否则 readFile 会抛原始 EISDIR（`illegal operation on a directory`），
        // 模型看到的是 Node 内部报错，既不像门禁说的、也读不出该怎么做。
        let info
        try {
          info = await stat(absolute)
        } catch (e) {
          // ENOENT 最常见：模型在猜文件名。照旧**原样抛**（不改文案、不改行为），只多留一条痕。
          await probe({ target: absolute, code: e?.code ?? 'STAT_FAILED' })
          throw e
        }
        if (info.isDirectory()) {
          await probe({ target: absolute, code: 'EISDIR' })
          throw new Error(
            `path 指向目录（${args.path}）：本通道只读文件，不提供目录枚举。请给出具体文件名。`
          )
        }
        const content = await readFile(absolute, 'utf8')
        await audit.record({
          tool: ONTOLOGY_READ,
          decision: 'allow',
          reason: args.reason,
          target: absolute,
          callId: exec?.callId
        })
        return { path: args.path, content, bytes: Buffer.byteLength(content, 'utf8') }
      }
    })
  )

  const disposeWrite = ctx.tools.register(
    defineTool({
      name: ONTOLOGY_WRITE,
      description:
        '写入 ontology 目录内的文件。这是修改 ontology 的唯一合法通道；语义合规由门禁在入口判定。',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: '相对 ontology 根目录的路径'
        },
        content: {
          type: 'string',
          required: true,
          description: '完整的新文件内容'
        },
        source: {
          type: 'string',
          required: true,
          enum: SOURCES,
          description: '本次内容的来源，用于防污染判定'
        },
        confidence: {
          type: 'number',
          description: '对本次内容的置信度 0–100；source 为 model 时必填'
        },
        reason: {
          type: 'string',
          required: true,
          description: '本次写入的业务理由（写入审计）'
        },
        level: {
          type: 'string',
          enum: ['L0', 'L1', 'L2'],
          description:
            '手动指定变更级别（可选）。缺省按语义载荷自动判定。只能升级不能降级：' +
            '低于自动判定级别会被拒绝（LEVEL_DOWNGRADE_DENIED）。'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            operation: { type: 'string', required: true },
            level: { type: 'string', enum: ['L0', 'L1', 'L2'] },
            bytes: { type: 'number', required: true }
          }
        },
        render(_args, value) {
          const verb = value.operation === 'create' ? '已创建' : '已更新'
          return [
            { type: 'text', text: `${verb} ontology/${value.path}（${value.bytes} 字节，级别 ${value.level}）` }
          ]
        }
      },
      async execute(args, exec) {
        // 🔴 与读侧（:109-128）严格同形态的写侧探测留痕（0022 P0-1）。
        //    在改动之前，`resolveWithinOntology()` 是**裸调用**：越界/非法 path 抛错 ⇒ 函数中断
        //    ⇒ 排在写文件之后的那条 `audit.record({decision:'allow'})` 永远不执行
        //    ⇒ **"有人试图写出 ontology"这件事在链上完全看不见**。
        //    与读侧保持三条一致：① 独立类别 WRITE_PROBE（不冒充 allow/deny）；
        //    ② 记而不拦 —— 照抛原错、文案一字不改；③ 审计自身故障不得改变写入结果（.catch）。
        const writeProbe = (fields) =>
          audit
            .record({
              tool: ONTOLOGY_WRITE,
              decision: WRITE_PROBE,
              reason: args.reason,
              callId: exec?.callId,
              ...fields
            })
            .catch(() => {
              // 审计自身故障不得改变写入结果 —— 沿用本项目既有取舍（audit fail-open）
            })

        let absolute
        try {
          absolute = resolveWithinOntology(args.path, cfg.ontologyRoot)
        } catch (e) {
          // 先落痕，再抛**原错误**（判定语义一行不改）。
          // ⚠️ code 一律 'OutOfOntology'：读侧对"越界"与"path 非法"也是同一个 code
          //    （读侧 :124 的 try 同时覆盖两者）⇒ 两侧保持一致，便于配对统计。
          await writeProbe({ target: String(args.path ?? ''), code: 'OutOfOntology' })
          throw e
        }

        // 读旧文件**内容**（分级需要旧内容做 diff）；读不到 ⇒ 视为全新创建。
        let oldText = ''
        let existed = false
        try {
          oldText = await readFile(absolute, 'utf8')
          existed = true
        } catch {
          existed = false
        }

        // 分级判定（先判级再写，降级拒绝时不落任何文件）。判定本身是纯函数，
        // 不碰 IO；解析失败 / 非受管文件一律 fail-closed 判 L2（classifyChange 内部兜）。
        const classification = classifyChange({
          path: args.path,
          newText: args.content,
          oldText,
          industry: cfg.industry
        })

        // 手动升降级：只能升级，不能降级（降级尝试写审计 + 拒绝，不落文件）。
        const manual = resolveManualLevel(classification.level, args.level)
        if (manual.downgraded) {
          await audit
            .record({
              tool: ONTOLOGY_WRITE,
              decision: 'deny',
              reason: `降级尝试：自动判 ${manual.autoLevel}，请求 ${manual.requestedLevel}`,
              target: absolute,
              level: manual.requestedLevel,
              autoLevel: manual.autoLevel,
              callId: exec?.callId
            })
            .catch(() => {
              // 审计自身故障不得改变拒绝结论
            })
          throw new HarnessError(
            `拒绝降级：本次变更自动判为 ${manual.autoLevel}，不能降为 ${manual.requestedLevel}。` +
              `（分级理由：${classification.reasons.join('；')}）`,
            'LEVEL_DOWNGRADE_DENIED'
          )
        }
        const finalLevel = manual.level

        await mkdir(dirname(absolute), { recursive: true })
        await writeFile(absolute, args.content, 'utf8')

        await audit.record({
          tool: ONTOLOGY_WRITE,
          decision: 'allow',
          reason: args.reason,
          source: args.source,
          confidence: args.confidence,
          target: absolute,
          operation: existed ? 'update' : 'create',
          level: finalLevel,
          autoLevel: classification.level,
          added: classification.added,
          modified: classification.modified,
          deleted: classification.deleted,
          classifyReasons: classification.reasons,
          bytes: Buffer.byteLength(args.content, 'utf8'),
          callId: exec?.callId
        })

        return {
          path: args.path,
          operation: existed ? 'update' : 'create',
          level: finalLevel,
          bytes: Buffer.byteLength(args.content, 'utf8')
        }
      }
    })
  )

  return () => {
    disposeRead()
    disposeWrite()
  }
}

/** ontology 内的规范路径（供 shell 兜底的路径比对使用）。 */
export function ontologyFilePath(rawPath, ontologyRoot) {
  return join(resolve(ontologyRoot), rawPath)
}
