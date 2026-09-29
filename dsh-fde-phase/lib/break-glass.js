/**
 * break-glass 记录表 —— 持久化（只在本插件；gate 侧只持内存镜像，不写这张表）+ 同步锚点计算。
 *
 * ## 为什么是 `break-glass.json` 而不是 `state.yaml` 那种 YAML
 *   - 这张表是**机器写、嵌套（记录数组）、从不手改**；而 `state.yaml` 是扁平标量、给人看的。
 *   - 链上是 **JSONL** ⇒ 用 JSON 存盘意味着**同一个对象零转换往返**（chain ↔ file ↔ mirror），
 *     少一层字段名映射就少一类静默 bug。
 *   - `JSON.parse` 的失败可以干净地 fail-closed；自己手写嵌套 YAML 解析器则是自找的失败模式
 *     （本项目在 `state.js` 只敢写扁平标量解析，就是同一顾虑）。
 *
 * ## 字段名一律 **camelCase**
 *   与链记录（`gate.jsonl` / `phase.jsonl` 既有 `autoLevel` / `callId` 风格）**逐字一致**，
 *   于是链↔文件↔镜像之间不需要任何改名。
 *
 * 🔴 本文件**只在 `dsh-fde-phase`** —— gate 不持有这张表（它只有从自己链恢复的内存镜像）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { compositeAnchorSha } from './mirror.js'
import { complianceFingerprintSync } from './check-d5.js'
import { sha256Hex } from './deny-ids.js'

/** 文件里的 schema 版本 —— 将来要迁移时用它分流，别去猜结构。 */
export const BG_SCHEMA_VERSION = 1

/** 记录表相对 `projectRoot` 的位置。 */
export const BG_RELATIVE_PATH = join('memory', 'break-glass.json')

/**
 * 一个空的记录表。
 * @returns {{schemaVersion:number, records:Array<object>}}
 */
export function emptyDoc() {
  return { schemaVersion: BG_SCHEMA_VERSION, records: [] }
}

/**
 * 从磁盘文本解析记录表。**fail-closed**：
 *   解析失败 / 结构不对 / 版本不认识 ⇒ 返回 `{ok:false}`，调用方**必须**当作空表处理
 *   （空表 = 不放行任何东西）。绝不"尽量读出几条"—— 那等于用坏掉的证据给人开门。
 *
 * @param {string} text
 * @returns {{ok:true, doc:{schemaVersion:number, records:Array<object>}} | {ok:false, reason:string}}
 */
export function parseBreakGlassDoc(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, reason: 'JSON 解析失败：' + String(e?.message ?? e) }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '顶层不是对象' }
  }
  if (typeof raw.schemaVersion !== 'number') {
    return { ok: false, reason: 'schemaVersion 缺失或不是数字' }
  }
  if (raw.schemaVersion !== BG_SCHEMA_VERSION) {
    return { ok: false, reason: `schemaVersion=${raw.schemaVersion} 不认识（本版只认 ${BG_SCHEMA_VERSION}）` }
  }
  if (!Array.isArray(raw.records)) {
    return { ok: false, reason: 'records 不是数组' }
  }
  const records = []
  for (let i = 0; i < raw.records.length; i++) {
    const r = raw.records[i]
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      return { ok: false, reason: `records[${i}] 不是对象` }
    }
    if (typeof r.id !== 'string' || r.id === '') return { ok: false, reason: `records[${i}].id 缺失` }
    if (typeof r.denyId !== 'string' || r.denyId === '') {
      return { ok: false, reason: `records[${i}].denyId 缺失` }
    }
    records.push({
      id: r.id,
      denyId: r.denyId,
      category: String(r.category ?? ''),
      reason: String(r.reason ?? ''),
      at: String(r.at ?? ''),
      expiresAt: String(r.expiresAt ?? ''),
      anchor: typeof r.anchor === 'string' ? r.anchor : null,
      status: r.status === 'resolved' ? 'resolved' : 'open',
      resolvedAt: typeof r.resolvedAt === 'string' ? r.resolvedAt : null,
      callId: typeof r.callId === 'string' ? r.callId : null
    })
  }
  return { ok: true, doc: { schemaVersion: raw.schemaVersion, records } }
}

/**
 * 同步读记录表。文件不存在 ⇒ **空表 + ok:true**（不是错误：还没砸过玻璃是正常状态）。
 * 文件存在但坏 ⇒ **空表 + ok:false**（调用方要 warn + 绝不据此放行）。
 *
 * @param {string} path
 * @returns {{ok:boolean, records:Array<object>, reason?:string}}
 */
export function readBreakGlassSync(path) {
  if (!existsSync(path)) return { ok: true, records: [] }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    return { ok: false, records: [], reason: '读文件失败：' + String(e?.message ?? e) }
  }
  const p = parseBreakGlassDoc(text)
  if (!p.ok) return { ok: false, records: [], reason: p.reason }
  return { ok: true, records: p.doc.records }
}

/**
 * **原子写**（`.tmp` + `rename`，同 `state.js` 的取舍）。
 *
 * ⚠️ 本进程内**不加锁**：`break-glass` 与 `fde_phase_advance` 都会写 state 侧文件，
 *    但 break-glass 的写入只发生在**工具 execute 里**（模型串行调用、且已过 approval），
 *    不存在两个写者并发抢同一张表的路径。跨进程才需要锁 —— 那是 `state.js` 的
 *    `.state.lock` 管的事，而本表**不需要跨进程写**（谁砸玻璃谁写）。
 *    ⇒ 有意不引锁：多一把锁就多一个"锁没释放"的失败模式，而这里没有对应的并发。
 *
 * @param {string} path
 * @param {Array<object>} records
 */
export function writeBreakGlassAtomic(path, records) {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = path + '.tmp'
  const text = JSON.stringify({ schemaVersion: BG_SCHEMA_VERSION, records }, null, 2) + '\n'
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw e
  }
}

/**
 * **同步**算某个 deny-id 当前的**内容锚点**（guard 在放行那一刻要重算它）。
 *
 * 返回 `null` 表示"这个 id 不带锚点 / 算不出来"。**两者都导致不放行**（见 `bg-mirror.isBypassed`），
 * 但语义不同：带锚却算不出来 = 文件读不动（最坏情形），必须 fail-closed。
 *
 * 算法与 `mirror.js` 的 `ANCHOR_ALGS` 保持**同一口径**（同样调 `compositeAnchorSha` /
 * `complianceFingerprintSync`）—— 两边若各写一遍"怎么算指纹"，迟早会漂。
 *
 * ⚠️ 依赖注入：`calc` 参数只为**可测性**存在（离线断言可喂假指纹验"锚点变了就不放行"），
 *    生产路径一律用默认实现。
 *
 * @param {string} denyId
 * @param {{ontologyRoot:string, gateAuditPath?:string}} cfg
 * @returns {string|null}
 */
export function currentAnchorSync(denyId, cfg) {
  const onto = cfg?.ontologyRoot
  if (typeof onto !== 'string' || onto === '') return null
  try {
    if (denyId === 'D1') {
      return compositeAnchorSha([readFileSync(join(onto, 'actions.yaml'), 'utf8'), readFileSync(join(onto, 'guards.yaml'), 'utf8')])
    }
    if (denyId === 'D3') {
      return compositeAnchorSha([readFileSync(join(onto, 'objects.yaml'), 'utf8'), readFileSync(join(onto, 'logic.yaml'), 'utf8')])
    }
    if (denyId === 'D5') {
      const fp = complianceFingerprintSync(join(onto, 'compliance.yaml'))
      return sha256Hex(JSON.stringify({ sha256: fp.sha256, len: fp.len, nonempty: fp.nonempty }))
    }
  } catch {
    return null
  }
  // D2 / GATE-*：不带锚点（理由见 deny-ids.js 的 ANCHORED_DENY_IDS）。
  return null
}
