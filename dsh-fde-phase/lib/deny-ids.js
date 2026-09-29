/**
 * deny-id 权威表 —— break-glass 逃生门（spec §11）的 `--deny-id` 取值域与语义常量。
 *
 * 🔴 **本文件在 `dsh-fde-phase` 与 `dsh-fde-ontology-gate` 各有一份，必须逐字相同。**
 *    理由是既有的架构约束：**插件之间不能互相 import**（0076 §3.3），跨包共享只能
 *    "照抄 + 机器对拍"（本项目在 `linkHash` / `yamlsubset` 上已有先例）。
 *    对拍由回归 `_fde_e1_crosspkg_test.mjs` 用 **sha256 逐字比对**，不靠人肉同步 ——
 *    凡"两边必须一致"的约定，只要靠人记，迟早漂移。
 *
 * ⚠️ 本文件**只依赖 `node:crypto`**（与 `mirror.js` 的 `compositeAnchorSha` 同一写法）。
 *    ⛔ 刻意**不自己实现 sha256**：两个插件本来就在用 `node:crypto`，再引入第二份哈希
 *    实现只会多出一个"两份必须一致"的漂移点，而且它算出来的值还要和
 *    `compositeAnchorSha` 对得上 —— 那是自找的失败模式。
 */

import { createHash } from 'node:crypto'

/**
 * **可被 break-glass 绕过的** deny-id。
 *
 * 🔴 有意排除三类**流程结构** deny（`RULE-JUMP` 跳跃推进 / `RULE-LAST` 已是末阶段 /
 *    `RULE-OBSERVATION` 回滚观察期冻结）：spec §11 列的三个适用场景（门禁 bug / 现场紧急 /
 *    规则没覆盖）**都不是流程结构问题**；而本项目的既有依据明确写着"跳过 Phase 3 = 跳过 D1
 *    = 门禁漏洞"。把结构规则也做成可绕，等于把整个 Phase 门禁体系变成可绕 ——
 *    那是**新开一个洞**，不是"砸玻璃"。
 *    ⇒ 它们不在这个数组里，模型压根传不进 `enum`（guard 之外的第二道闸）。
 *
 * @type {readonly string[]}
 */
export const BYPASSABLE_DENY_IDS = Object.freeze([
  'D1',
  'D2',
  'D3',
  'D5',
  'GATE-CLASSIFY',
  'GATE-PATH'
])

/**
 * **带内容锚点**的 deny-id —— 锚点与记录创建时不一致 ⇒ 放行**自动失效**。
 *
 * 为什么 D1/D3/D5 带锚而 D2/GATE-* 不带：
 *   - D1/D3/D5 锚的是**文件内容**（actions+guards / objects+logic / compliance）。
 *     内容一变说明"有人在动它" ⇒ 旧放行必须失效，否则会**静默覆盖一个全新的失败**。
 *   - D2 锚的是 **gate 审计链的 (行数, 链头)** —— 那是个**本来就会增长**的容器，
 *     拿它当锚会让 D2 的放行因为**无关的审计写入**而失效，放行等于没用。
 *   - `GATE-*` 判的是**载荷语义**（分类等级 / 命中哪个保护区），根本没有文件可锚。
 *     ⇒ 这两类只按 deny-id 比对，风险已写进两边 README 的诚实清单。
 *
 * @type {readonly string[]}
 */
export const ANCHORED_DENY_IDS = Object.freeze(['D1', 'D3', 'D5'])

/** deny-id 的人话名字 —— 用于确认弹窗（spec §11 R2："你即将绕过 deny 门禁 [D3 …]"）。 */
export const DENY_LABEL = Object.freeze({
  D1: 'D1 护栏未通过（actions.yaml/guards.yaml 的护栏绑定）',
  D2: 'D2 gate 审计链完整性未通过',
  D3: 'D3 规则未通过（objects.yaml/logic.yaml 的规则↔实现一致性）',
  D5: 'D5 合规未通过（compliance.yaml，受监管行业）',
  'GATE-CLASSIFY': 'gate 变更分级判定（L0/L1/L2，按语义载荷）',
  'GATE-PATH': 'gate 受保护区域命中'
})

/**
 * spec §11 R4 的三类分类。
 *
 * ⚠️ 本项目**只记录、不自动判级**：spec 给了三类的含义与优先级，但没给自动判据
 *    （"理由充不充分"是语义判断）。由发起人自选，指标里按类分列。见 README 诚实清单。
 *
 * @type {readonly string[]}
 */
export const BREAK_GLASS_CATEGORIES = Object.freeze(['deny_defect', 'scope_edge', 'evasion'])

/** 分类的人话含义 + 指标颜色（spec §11 表格原样）。 */
export const CATEGORY_META = Object.freeze({
  deny_defect: { label: '门禁本身有 bug，拦错了', priority: 'high', color: 'red' },
  scope_edge: { label: '边界场景，规则没覆盖到', priority: 'medium', color: 'yellow' },
  evasion: { label: '为了省事故意绕过（理由不充分）', priority: 'high', color: 'red' }
})

/** spec §11 R5：「break-glass 后进入 7 天补正期」。 */
export const CORRECTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** 事件 ID 前缀（spec §11 R8 的 `evt_bg_7f3a2c` 形态）。 */
export const EVENT_ID_PREFIX = 'evt_bg_'

/**
 * 生成事件 ID（`evt_bg_` + 6 位十六进制）。
 *
 * **可复算**是刻意的：用 `sha256(callId|at)` 而不是随机数 —— 随机 ID 只能"信我说的"，
 * 确定性 ID 让第三方拿 `callId` + 时间戳就能**独立验证**这一条确实由那次调用产生。
 * 代价：同一 `callId` + 同一毫秒会产生同一个 ID（可接受，那本来就是同一次调用）。
 *
 * @param {string} callId
 * @param {string} at - ISO 时间串
 * @returns {string}
 */
export function makeEventId(callId, at) {
  return EVENT_ID_PREFIX + sha256Hex(`${callId}|${at}`).slice(0, 6)
}

/** 算一段文本的 sha256（与 `mirror.js` 的 `sha256Text` 同算法，避免两处各写一遍）。 */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
