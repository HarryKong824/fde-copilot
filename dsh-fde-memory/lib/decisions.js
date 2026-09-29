/**
 * decisions.js —— 决策落盘 + 序号独占 + 调用方不可写 confidence。
 *
 * 文件形态：<projectRoot>/memory/decisions/{phase}-{seq}.yaml
 *   phase 可含 '.'（如 '0.1'），按**最后一个** '-' 切分（避免 '0.1-1' 被首 '-' 切错）
 *
 * 字段集被 §5.5 规则表的输入面约束（fde_confirmed / data_verified / phases_since_review
 * / last_reviewed / derived_from_confidence 五个必须逐字存在）。
 *
 * 序号分配（0079 §4 A2-3）：不用内存计数器（重启重号）、不用锁
 *   ① nextSeq: 扫 {phase}-*.yaml 取最大 + 1
 *   ② 抢号: openSync(final, 'wx') —— 原子排他创建；EEXIST ⇒ seq+1 重试（上限 50 次）
 *   ③ 落数据: 写 tmp → fsyncSync → closeSync → renameSync(tmp, final)（rename 同卷原子、可覆盖）
 *   ④ 任一步失败 ⇒ unlinkSync(final) 后抛，不许留空文件（污染 nextSeq）
 *
 * ⚠️ 比 dsh-fde-phase/lib/state.js 多一步 fsync —— 数据先落盘再改名（升级，非照抄）
 *
 * 调用方传 confidence 一律忽略（0076 §1.4 核心禁令）：
 *   写入前显式 delete input.confidence，再由 deriveConfidence(facts) 赋值
 *
 * 0082 §2.2-§2.3 修复：
 *   - readDecision 加双向断言（phase 必须字符串 / phase==文件名 / seq==文件名）—— 防 type drift
 *   - listDecisions 改签名 {items, bad}：坏文件进 bad 而非静默消失
 *   - 新增并导出 assertPhaseId（PHASE_ID_RE），四个入口共用 —— 防路径穿越（'../escaped'）
 *   - 序列化函数提取至 lib/yaml-write.js（A3 §3.1）
 */

import { mkdirSync, existsSync, openSync, writeFileSync, closeSync, renameSync, unlinkSync, readdirSync, readFileSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { parseYamlSubset } from './yamlsubset.js'
import { deriveConfidence } from './confidence.js'
import { serializeYaml } from './yaml-write.js'

/**
 * Phase id 白名单（0082 §2.3）。
 * 15 个合法 phase id 全部形如 数字 或 数字.数字（0.1 / 0.2 / 0.3 / 0.4 / 1..11）。
 * 任何调用方给的 phase（含 A3 的 checklist/stakeholders/maturity）都必须先过这一关。
 * 表在本插件里存一份（先例：ANCHOR_ALGS 各存一份）—— 否则将来 phase 表变了，
 * 这里静默挡掉合法 id。
 */
const PHASE_ID_RE = /^[0-9]+(\.[0-9]+)?$/

/**
 * 校验 phase id —— 防路径穿越（writeDecision 写 '../escaped' 会出 memory/）。
 * @param {string} phase
 * @throws {Error} phase 非字符串或不匹配 PHASE_ID_RE
 */
export function assertPhaseId(phase) {
  if (typeof phase !== 'string' || !PHASE_ID_RE.test(phase)) {
    throw new Error(`phase 只能是数字或 数字.数字 形式（如 "3" / "0.1"），收到 ${JSON.stringify(phase)}`)
  }
}

/**
 * 计算下一个 seq：扫 {phase}-*.yaml 取最大 seq + 1。
 * 目录不存在 ⇒ 1。
 * @param {string} projectRoot
 * @param {string} phase
 * @returns {number}
 */
export function nextSeq(projectRoot, phase) {
  assertPhaseId(phase)
  const dir = join(projectRoot, 'memory', 'decisions')
  if (!existsSync(dir)) return 1
  const prefix = phase + '-'
  let max = 0
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefix) || !f.endsWith('.yaml')) continue
    // 文件名形如 {phase}-{seq}.yaml，phase 已知，直接剥前缀剥后缀
    // 按首 '-' 切会切错含 '-' 的 phase；按已知前缀剥是唯一可靠做法
    const numPart = f.slice(prefix.length, -'.yaml'.length)
    const n = Number(numPart)
    if (Number.isInteger(n) && n > max) max = n
  }
  return max + 1
}

/**
 * 读单条 decision。空文件 / 解析失败 ⇒ 抛（fail-closed）。
 * 0082 §2.2：加双向断言 —— phase 必须字符串 / phase==文件名 / seq==文件名
 * （防止手写文件未加引号导致 YAML 把 0.1 解析成 number，破坏 phase 字符串语义）。
 * @param {string} projectRoot
 * @param {string} phase
 * @param {number} seq
 * @returns {object}
 */
export function readDecision(projectRoot, phase, seq) {
  assertPhaseId(phase)
  if (!Number.isInteger(seq)) {
    throw new Error(`readDecision: seq 必须是整数，收到 ${JSON.stringify(seq)}（${typeof seq}）`)
  }
  const p = join(projectRoot, 'memory', 'decisions', `${phase}-${seq}.yaml`)
  if (!existsSync(p)) {
    throw new Error(`readDecision: 文件不存在 ${p}`)
  }
  const text = readFileSync(p, 'utf8')
  if (text.trim().length === 0) {
    throw new Error(`readDecision: 文件为空 ${p}`)
  }
  // parseYamlSubset 空内容/坏 YAML 都会抛 DslError，这里不吞
  const obj = parseYamlSubset(text, p)
  // 双向断言：文件名 ↔ 内容必须互相印证
  if (typeof obj.phase !== 'string') {
    throw new Error(`readDecision: ${p} 的 phase 必须是字符串（读到 ${typeof obj.phase}: ${JSON.stringify(obj.phase)}）—— 未加引号的数字被 YAML 推断成了 number`)
  }
  if (obj.phase !== phase) {
    throw new Error(`readDecision: ${p} 内 phase=${JSON.stringify(obj.phase)} 与文件名不符（${phase}）`)
  }
  if (obj.seq !== seq) {
    throw new Error(`readDecision: ${p} 内 seq=${JSON.stringify(obj.seq)} 与文件名不符（${seq}）`)
  }
  return obj
}

/**
 * 列某 phase 的全部 decision，按 seq 升序。
 * 0082 §2.2：改签名 -> { items, bad }：坏文件进 bad 而非静默消失。
 * 原签名是 object[]（外部调用方按老签名用会拿到对象而非数组 —— 当前无外部调用方）。
 * @param {string} projectRoot
 * @param {string} phase
 * @returns {{ items: object[], bad: { file: string, seq: number, error: string }[] }}
 */
export function listDecisions(projectRoot, phase) {
  assertPhaseId(phase)
  const dir = join(projectRoot, 'memory', 'decisions')
  if (!existsSync(dir)) return { items: [], bad: [] }
  const prefix = phase + '-'
  const items = []
  const bad = []
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefix) || !f.endsWith('.yaml')) continue
    const numPart = f.slice(prefix.length, -'.yaml'.length)
    const n = Number(numPart)
    if (!Number.isInteger(n)) continue
    try {
      const obj = readDecision(projectRoot, phase, n)
      items.push({ ...obj, _file: f, _seq: n })
    } catch (e) {
      // 坏文件进 bad 列表（0082 §2.2：缺席第三层 —— 整条记录缺席最易漏）
      bad.push({ file: f, seq: n, error: String(e && e.message ? e.message : e) })
    }
  }
  items.sort((a, b) => a._seq - b._seq)
  return { items, bad }
}

/**
 * 写一条 decision。调用方传 confidence 一律忽略。
 * @param {string} projectRoot
 * @param {object} input - 必须含 phase / decision / source；其余可选
 * @returns {{ file: string, seq: number, confidence: 'low'|'medium'|'high' }}
 */
export function writeDecision(projectRoot, input) {
  const phase = input?.phase
  // 0082 §2.3：用 assertPhaseId 替代原"非空字符串"判 —— 防路径穿越
  assertPhaseId(phase)
  const dir = join(projectRoot, 'memory', 'decisions')
  mkdirSync(dir, { recursive: true })

  // 调用方传 confidence 一律忽略（0076 §1.4）
  const payload = { ...input }
  delete payload.confidence

  // 必填字段
  if (typeof payload.decision !== 'string' || payload.decision.length === 0) {
    throw new Error('writeDecision: input.decision 必填')
  }
  if (typeof payload.source !== 'string') {
    throw new Error('writeDecision: input.source 必填')
  }

  // B1（spec §7 source 防污染）：三分标记的污染防线，落在写入器（唯一入口）。
  //   · source=client_stated 必带 provenance（来源出处：文档路径 / session ID / 对话引用）
  //   · source=fde_confirmed 只能经 approval 产生：必须带 approved_at（由 fde_memory_confirm 写入）
  //     模型直接写 fde_confirmed（无 approved_at）⇒ 拒绝。这里拒绝 = 全链路拒绝。
  //   provenance / approved_at 都会随 payload 序列化进 decision 文件（serializeYaml 全字段写）。
  if (payload.source === 'client_stated') {
    if (typeof payload.provenance !== 'string' || payload.provenance.trim().length === 0) {
      throw new Error('writeDecision: source=client_stated 必须带 provenance（来源出处：文档路径/session ID/对话引用）')
    }
  }
  if (payload.source === 'fde_confirmed') {
    if (typeof payload.approved_at !== 'string' || payload.approved_at.trim().length === 0) {
      throw new Error('writeDecision: source=fde_confirmed 只能经 approval 确认产生，模型不得直接写入（source 防污染）')
    }
  }

  // 补默认值（字段集被 §5.5 规则表约束）
  if (payload.fde_confirmed === undefined) payload.fde_confirmed = false
  if (payload.data_verified === undefined) payload.data_verified = false
  if (payload.derived_from === undefined) payload.derived_from = []
  if (payload.derived_from_confidence === undefined) payload.derived_from_confidence = null
  if (payload.phases_since_review === undefined) payload.phases_since_review = 0
  if (payload.last_reviewed === undefined) payload.last_reviewed = null

  // 计算置信度（调用方不可写）
  const confidence = deriveConfidence({
    source: payload.source,
    fde_confirmed: payload.fde_confirmed,
    data_verified: payload.data_verified,
    phases_since_review: payload.phases_since_review,
    last_reviewed: payload.last_reviewed,
    derived_from_confidence: payload.derived_from_confidence
  })
  payload.confidence = confidence

  // 序号 + ISO 时间戳在写盘前定下来
  const createdAt = new Date().toISOString()
  payload.created_at = payload.created_at ?? createdAt
  // 写盘的 seq（payload.seq 不允许调用方写）
  delete payload.seq

  // ── 序号独占 + tmp+fsync+rename ──
  const MAX_RETRY = 50
  let seq
  let finalPath
  let occupied = false // 抢号占位（openSync 'wx'）成功后立即关 fd，rename 前不能让 fd 还开着（Windows 下 rename 被打开的文件会失败）
  for (let attempt = 0; attempt < MAX_RETRY; attempt += 1) {
    seq = nextSeq(projectRoot, phase)
    finalPath = join(dir, `${phase}-${seq}.yaml`)
    try {
      const fd = openSync(finalPath, 'wx') // 原子排他创建
      closeSync(fd) // 立即关：占位已生效，后续用 tmp+rename 覆盖
      occupied = true
      break
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        // 被抢了，重试
        continue
      }
      // 其他错误（权限/磁盘满等）：抛
      throw new Error(`writeDecision: 抢号失败 ${finalPath}: ${e?.message ?? e}`)
    }
  }
  if (!occupied) {
    throw new Error(`writeDecision: ${MAX_RETRY} 次抢号均 EEXIST，怀疑 nextSeq 与实际并发不匹配`)
  }

  // 写 tmp 文件 + fsync + rename 覆盖 final
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
  let tmpFd = null
  try {
    // 测试钩子（0079 §6 第 7 条）：FDE_INJECT_WRITE_FAIL=1 时模拟写盘失败
    // 用于验证 catch 块的 unlinkSync 清理逻辑 —— 生产环境不设此变量即不触发
    if (process.env.FDE_INJECT_WRITE_FAIL === '1') {
      throw new Error('mock write fail: 注入测试')
    }
    // 用独立的 tmp fd 写内容
    tmpFd = openSync(tmpPath, 'w')
    const yamlText = serializeYaml({ ...payload, seq, phase })
    writeFileSync(tmpPath, yamlText, 'utf8')
    // tmp 文件需重新打开以 fsync（writeFileSync 用的是自己的 fd）
    closeSync(tmpFd)
    tmpFd = null
    tmpFd = openSync(tmpPath, 'r+')
    fsyncSync(tmpFd)
    closeSync(tmpFd)
    tmpFd = null
    // rename 覆盖 final（Windows 同卷 rename 原子、可覆盖）
    renameSync(tmpPath, finalPath)
    return { file: `${phase}-${seq}.yaml`, seq, confidence }
  } catch (e) {
    // 失败清理：tmp 与 final 都不许留空文件
    try { if (tmpFd !== null) closeSync(tmpFd) } catch {}
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch {}
    try { if (existsSync(finalPath)) unlinkSync(finalPath) } catch {}
    throw new Error(`writeDecision: 写盘失败（已清理）: ${e?.message ?? e}`)
  } finally {
    // fd 在抢号阶段已立即关掉（见上），这里不再处理
    // 失败路径的 tmp/final 清理已在 catch 块完成
  }
}
