/**
 * dsh-fde-memory —— FDE Copilot v3 的记忆系统 v2 插件。
 *
 * 0076 A1（本批）只做：
 *   - 骨架：apply() 里幂等建 <projectRoot>/memory/{ontology,decisions,checklist,notes,audit}/ 目录
 *   - SCHEMA_VERSION：缺失视为 v1 并写入；不匹配走 migrate；无路径 ⇒ fail-closed
 *   - state.yaml 不动（phase 插件财产，本插件只读不写）
 *
 * 后续 A2-A5 在此基础上加：
 *   - A2 decisions（一条一文件 + {phase}-{seq} 序号）
 *   - A3 checklist + stakeholders + maturity
 *   - A4 notes + 过期降级
 *   - A5 置信度引擎 + 分层注入（只读工具 fde_memory_context）
 *
 * 0076 §3.3：插件之间不能互相 import —— 本插件自带 linkHash / yamlsubset（照抄 + 加头部注明出处），A2-A5 落地。
 * 0076 §3.5：本插件需要自己的 config 段（key: fdeMemory），改 cordis.patch.yml 后必须重启 DSH 才生效。
 *
 * 能力边界（必须对客户讲清）：
 *   本插件是**进程内软约束** —— 防的是模型无意的失误与漂移，不是有意的恶意绕过。
 *   confidence 不可由调用方写入（spec 第六节禁令，A5 落地）。
 *
 * 0084 §2 + 0086 §3-§4 + 0077 §4：顶部静态 import 全部 15 个相对库 —— 让"插件仍加载"判据有验证力。
 *   任一库有语法/解析/依赖错误 ⇒ fiber failed（fail-closed）。
 *   ⚠️ 加载成功 ≠ 运行时正确：active 只证明 15 个文件在进程内可解析；
 *      行为正确性靠离线断言（A1 68 + A2 47 + A3 115 + A4 61 + A5 33 + E3 19）。
 *   不改成动态 import()：动态 import 的失败可被 try/catch 吞掉，失去 fail-closed。
 *   下方 `void` 数组明确引用这些符号，避免工具链误删"未使用 import"。
 */

import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeConfig, NAME } from './config.js'
import { ensureSchemaVersion, CURRENT as SCHEMA_CURRENT } from './schema-version.js'

// 0084 §2 + 0086 §3-§4 + 0077 §4：静态 import 全部 15 个相对库（加载期求值 ⇒ 任一坏掉 fiber failed）
import { serializeYaml, formatValue, formatInline } from './yaml-write.js'
import { deriveConfidence } from './confidence.js'
import { writeDecision, readDecision, listDecisions, nextSeq, assertPhaseId } from './decisions.js'
import { appendChange, readRecentChanges } from './change-log.js'
import { readChecklist, writeChecklist } from './checklist.js'
import { readStakeholders, writeStakeholder, summarize } from './stakeholders.js'
import { readMaturity, setMaturity, historyOf } from './maturity.js'
import { parseYamlSubset } from './yamlsubset.js'
import { DslError, isDslError, toReportedError } from './errors.js'
import { AuditChain, GENESIS, TAIL_BYTES, linkHash } from './audit.js'
import { writeNote, readNote, listNotes, isExpired, annotateForInjection, reviewNote } from './notes.js'
import { installMemoryTools } from './tools.js'
import { installSessionAudit } from './session-audit.js'
import { askApproval } from './approval.js'
// 0077 §4 B3 / spec §8（D1）：审计外置 L2/L3 + 降级模式
import { installTelemetrySink, evaluateRemote, AUDIT_KINDS, HEARTBEAT_KIND } from './telemetry-sink.js'
import { outboxRootOf, OUTBOX_SUBDIR, STATE_FILE, emptyState, readStateSync } from './outbox.js'

// 0084 §2：故意引用，避免工具链误删"未使用 import"——这些符号的真正使用面在 A5 工具注册
const _LOADED_LIBS = [
  serializeYaml, formatValue, formatInline, deriveConfidence,
  writeDecision, readDecision, listDecisions, nextSeq, assertPhaseId,
  appendChange, readRecentChanges, readChecklist, writeChecklist,
  readStakeholders, writeStakeholder, summarize,
  readMaturity, setMaturity, historyOf, parseYamlSubset,
  DslError, isDslError, toReportedError,
  AuditChain, GENESIS, TAIL_BYTES, linkHash,
  writeNote, readNote, listNotes, isExpired, annotateForInjection, reviewNote,
  installSessionAudit, askApproval,
  installTelemetrySink, evaluateRemote, AUDIT_KINDS, HEARTBEAT_KIND,
  outboxRootOf, OUTBOX_SUBDIR, STATE_FILE, emptyState, readStateSync
]
void _LOADED_LIBS

/**
 * Config（schemastery schema）—— 动态 import 兜底离线测试环境。
 *
 * DSH 运行时 schemastery 在 node_modules，import 成功；
 * 离线测试环境（WorkBuddy 根目录无 node_modules/@deepseek-ai/schemastery）import 失败 ⇒ Config 留 null。
 *
 * 离线测试只测 apply / normalizeConfig / ensureSchemaVersion（不访问 Config），
 * DSH 配置面板才访问 Config（运行时一定有 schemastery）。
 */
let Config = null
try {
  Config = (await import('./config-schema.js')).Config
} catch (e) {
  // schemastery 不可用 —— 离线测试环境兜底
}

const name = NAME

/**
 * inject = ['tools']：A1 不注册工具，但保持 inject 形态为后续 A2-A5 准备
 * （A5 会注册 fde_memory_context / fde_memory_write_decision / fde_memory_review 三个工具）。
 */
const inject = ['tools']

/**
 * 幂等建目录骨架。已存在的文件绝不覆盖。
 *
 * 0076 §4 目录树：
 *   <projectRoot>/
 *   ├─ SCHEMA_VERSION                   # 本单新增（schema-version.js 管）
 *   └─ memory/
 *      ├─ state.yaml                    # ⚠️ phase 插件财产，本插件只读不写
 *      ├─ ontology/                     # A3
 *      ├─ decisions/                    # A2
 *      ├─ checklist/                    # A3
 *      ├─ stakeholders.yaml             # A3
 *      ├─ notes/                        # A4
 *      ├─ change_log.jsonl              # 0076 §5.2b：新增（spec 目录树外加文件，README 单列）
 *      └─ audit/                        # ⚠️ B 单（0077）落点，A1 只建空目录
 *         └─ events.jsonl
 *
 * @param {string} projectRoot
 * @returns {string[]} 实际创建的目录列表（已存在的不会重新创建）
 */
function ensureSkeleton(projectRoot) {
  const created = []
  const dirs = [
    'memory',
    'memory/ontology',
    'memory/decisions',
    'memory/checklist',
    'memory/notes',
    'memory/audit',
    // spec §8 L2：`memory/outbox/{seq}.json`。**只有在配了端点时才建**（见 apply）。
    // 配了却不建，第一条记录会由 writeOutboxSync 自己 mkdir —— 但那样目录的出现时机
    // 就取决于"有没有会话事件"，运维看不到一个稳定的落点。所以已配置时在 apply 期就建好。
  ]
  for (const d of dirs) {
    const full = join(projectRoot, d)
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true })
      created.push(d)
    }
  }
  return created
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const log = ctx.logger ?? console

  // 1) SCHEMA_VERSION（0076 §5 A1.3；E3 修正见下）
  //
  // 🔴 E3（2026-09-29）修正：**迁移失败不再让插件整体不加载**。
  //
  // 旧实现在 `status === 'failed'` 时直接 `throw` ⇒ fiber failed ⇒ 工具全部不注册 ⇒
  // **连读取都没了**。那正是 spec 第七节要修的问题，原文：
  //   「schema 版本 …… 加 迁移失败 = **写入 fail-closed，读取降级为只读模式（数据不扣人质）**」
  // 即"迁移失败"该扣的是**写**，不该扣**读** —— 把数据扣成人质恰恰是 v3 要消灭的形态。
  //
  // 现在的语义：保留读、封掉写（`readOnly` 传给 installMemoryTools，只拦三个写工具）。
  const sv = ensureSchemaVersion(cfg.projectRoot)
  const readOnly = sv.status === 'failed' ? { active: true, error: sv.error, from: sv.from } : null

  // 2) 幂等建目录骨架（已存在的文件绝不覆盖，state.yaml 是 phase 财产不动）
  const createdDirs = ensureSkeleton(cfg.projectRoot)

  // 3) 审计链（B1/B2 要拿它记 source 污染拒绝 + confirm 三态，故提前建；session-audit 复用同一条链）。
  //    链头从磁盘尾部恢复（AuditChain 构造期做）；重启后接续旧链而非重开。
  const audit = new AuditChain(join(cfg.projectRoot, 'memory', 'audit', 'events.jsonl'))

  // 3b) 降只读这件事**必须留痕**（否则"系统什么时候开始只读的"就成了静默点）。
  //     顺带一个刻意的取舍：**只读模式下审计链照常写** ——
  //       ① 审计是 append-only 的运行痕迹，不是被 schema 版本管辖的**用户数据**；
  //       ② 停写审计会让"只读期间发生过什么"完全无痕迹，那是比格式混杂更坏的后果。
  //     理由与残余风险写进 README（§E3）。
  if (readOnly) {
    audit
      .record({
        type: 'schema-readonly',
        from: sv.from,
        // ⚠️ 这里刻意用插件支持的 CURRENT，**不是** sv.version：
        //    failed 分支的 sv.version 就是磁盘上的版本（= sv.from），照搬会让记录出现
        //    「from:2, current:2」—— 读者看不出到底卡在哪，像是"从 2 迁到 2 却失败"的自相矛盾记录。
        //    写 CURRENT 才读得出真相：磁盘是 2、本插件只支持 1、中间无迁移路径。
        current: SCHEMA_CURRENT,
        error: sv.error,
        note: 'SCHEMA_VERSION 迁移失败 ⇒ 写入 fail-closed、读取照常（spec 第七节）。本记录说明只读模式自此次 apply 起生效。'
      })
      .catch(() => {})
    log.warn?.(
      `[${name}] ⚠️ SCHEMA_VERSION 迁移失败 ⇒ **降级为只读模式**（写入 fail-closed，读取照常）。` +
        `原因：${sv.error}`
    )
  }

  // 4) 注册工具（B1/B2 后四个：fde_memory_context / fde_memory_write_decision / fde_memory_confirm / fde_memory_review）
  //    readOnly 时只拦写工具，fde_memory_context 照常（E3）。
  installMemoryTools(ctx, cfg, audit, readOnly)

  // 5) 审计外置 L1（0077 B 单）：监听 session/event → 脱敏 → 落 memory/audit/events.jsonl。
  const sink = installTelemetrySink(ctx, cfg, audit)
  // 只读模式（E3）封的是**用户数据写入**；审计是运行痕迹、照常写（同 3b 的取舍）。
  // 但外置投递要把本地审计**送出进程**，那是另一个决定 —— 只读期间不送，
  // 免得"系统已经降级了还在往外部送数据"。队列照常攒着，恢复后由下次 apply 补传。
  const deliverEnabled = sink.enabled && !readOnly
  if (sink.enabled) {
    ensureOutboxDir(cfg.projectRoot)
    if (!deliverEnabled) {
      log.warn?.(`[${name}] ⚠️ 只读模式：审计外置投递**本轮不启动**（队列照常落盘，恢复后由下次 apply 补传）`)
    }
  }
  ctx.effect(() => installSessionAudit(ctx, cfg, audit, deliverEnabled ? sink : undefined), `${name} 审计外置 L1（session/event）`)
  ctx.effect(() => () => sink.dispose(), `${name} 审计外置 L3（投递器）`)

  log.info?.(
    `[${name}] 已挂载（A1 骨架）：mode=${cfg.mode}, projectRoot=${cfg.projectRoot}, ` +
    `SCHEMA_VERSION=${sv.version}（${sv.status}）, ` +
    `新建目录=${createdDirs.length ? createdDirs.join(', ') : '无（已存在）'}` +
    `, 审计外置=${sink.enabled ? `已配置（队列 ${outboxRootOf(cfg.projectRoot)}）` : '未配置（仅本地链）'}` +
    (readOnly ? '，🔴 只读模式（写入已封、读取照常）' : '')
  )
}

/** 建 outbox 目录（仅在配了外置端点时调用）。 */
function ensureOutboxDir(projectRoot) {
  const root = outboxRootOf(projectRoot)
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
}

export { Config, apply, inject, name }
