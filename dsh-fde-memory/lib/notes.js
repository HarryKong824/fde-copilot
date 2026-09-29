/**
 * notes.js —— 备注落盘 + frontmatter 强制 + 过期降级（A4 §4.1）。
 *
 * 文件形态：<projectRoot>/memory/notes/{date}-{slug}.md
 *   frontmatter（YAML 子集）：source / date / expires_at / reviewed_at / confidence / kind?
 *   body：markdown 正文
 *
 * 0084 §4.0 三处拍定（spec 未定，本单出单人拍定）：
 *   a) expires_at 一律由写入器按 TTL 算，不接受调用方传值（传了忽略并覆盖）
 *      —— spec 说 informal_commitment 强制 30 天，"强制"只有在调用方无法覆盖时才是强制
 *   b) confidence 由 deriveConfidence(facts) 推（复用 A2 纯函数），调用方传了忽略并覆盖
 *      —— spec 第六节：禁止模型写 confidence，与 decisions 同款禁令 ⇒ 两处实现必须一致
 *   c) TTL 来源：config 的 notesTtlDays（默认 90）/ informalCommitmentTtlDays（默认 30）
 *      —— A1 的 DEFAULTS 里已有这两个值，直接用。非正式承诺的 30 天不可被 config 调高（强制项）
 *
 * frontmatter 必含：source / date / expires_at / reviewed_at / confidence
 *   缺 source 或 date ⇒ 拒绝写入（fail-closed）。调用方不需提供 expires_at/confidence。
 *
 * 0084 §4.1 API 表：
 *   writeNote(projectRoot, { slug, content, source, kind?, date?, facts? }) -> { file, expires_at, confidence }
 *   readNote(projectRoot, file) -> { front, body }
 *   listNotes(projectRoot) -> { items, bad }（同 §3.2 形状）
 *   isExpired(note, now) -> boolean
 *   annotateForInjection(note, now) -> { text, expired }（过期文本含「历史备注（未复核）」+ 日期；文件绝不改写）
 *   reviewNote(projectRoot, file, { at }) -> { reviewed_at }（原子写）
 *
 * ⚠️ slug 白名单校验（同 §2.3 assertPhaseId 精神）：只允许 [a-z0-9-]，挡 ../、/、:、空格、大写
 *    —— A3 那条路径穿越缺陷的同类面，不要等下次被探针打出来
 *
 * 过期口径（§4.2 四组双向断言）：
 *   - 90 天默认：date=今天-89 ⇒ 未过期；date=今天-91 ⇒ 已过期
 *   - informal_commitment 30 天强制：date=今天-29 ⇒ 未过期；date=今天-31 ⇒ 已过期
 *   - informal 不能被 cfg 90 救活（强制项优先）
 *   - annotateForInjection 过期时文本含"历史备注（未复核）"与日期；未过期时不含（双向）
 */

import { mkdirSync, existsSync, writeFileSync, closeSync, openSync, fsyncSync, renameSync, unlinkSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serializeYaml } from './yaml-write.js'
import { parseYamlSubset } from './yamlsubset.js'
import { deriveConfidence } from './confidence.js'
import { appendChange } from './change-log.js'

const SLUG_RE = /^[a-z0-9-]+$/
// 0086 §2.3：note 文件名白名单（全名 = 日期前缀 + slug + .md）。读/复核两条路径与写路径同强度。
const NOTE_FILE_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/
const VALID_KINDS = new Set(['informal_commitment', 'observation', 'decision_ref'])
const VALID_SOURCES = new Set(['fde_confirmed', 'plugin_inferred', 'client_stated'])

// 0084 §4.0 c：TTL 来源。非正式承诺的 30 天不可被 cfg 调高（强制项优先）
const DEFAULT_TTL_DAYS = 90
const INFORMAL_TTL_DAYS = 30

/**
 * 校验 slug —— 防路径穿越（同 assertPhaseId 精神）。
 * 只允许 [a-z0-9-]，挡 ../、/、:、空格、大写。
 * @param {string} slug
 * @throws {Error} slug 非字符串或不匹配 SLUG_RE
 */
function assertSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(`notes: slug 只能是小写字母/数字/连字符（如 "design-review"），收到 ${JSON.stringify(slug)}`)
  }
}

/**
 * 0086 §2.1：取**本机时区**的今天（YYYY-MM-DD）。now 可注入以便断言。
 * 原实现用 toISOString()（UTC），本机 +8 时北京 00:00-08:00 写 note 日期会早一天。
 * @param {Date} [now]
 * @returns {string}
 */
export function todayLocal(now) {
  const d = now instanceof Date ? now : new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 0086 §2.3：校验 note 文件名（全名，含日期前缀与 .md）—— 白名单，挡 / .. \ : 空格 大写。
 * 与 writeNote 的 assertSlug 同精神，但作用于完整文件名（readNote / reviewNote 入口）。
 * @param {string} file
 * @throws {Error} file 非字符串或不匹配 NOTE_FILE_RE
 */
export function assertNoteFile(file) {
  if (typeof file !== 'string' || !NOTE_FILE_RE.test(file)) {
    throw new Error(`notes: file 必须是 YYYY-MM-DD-slug.md 形态（如 "2026-09-28-design-review.md"），收到 ${JSON.stringify(file)}`)
  }
}

/**
 * 算过期时间（ISO 字符串，UTC 0 点）。
 * 0084 §4.0 c：informal_commitment 强制 30 天，不可被 cfg 调高；
 *   其余 kind 走 cfg.notesTtlDays（默认 90）。
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} kind
 * @param {object} cfg - config（含 notesTtlDays / informalCommitmentTtlDays）
 * @returns {string} ISO 字符串
 */
function computeExpiresAt(dateStr, kind, cfg) {
  // 解析 dateStr 为 UTC 0 点的毫秒数
  const [y, m, d] = dateStr.split('-').map(Number)
  const start = Date.UTC(y, m - 1, d)
  // 0084 §4.0 c：informal_commitment 强制 30 天，不可被 cfg 调高（强制项优先）
  let ttlDays
  if (kind === 'informal_commitment') {
    // 强制项：取 cfg 与 30 的较小值（cfg 调高也不许超过 30）
    const cfgInformal = cfg?.informalCommitmentTtlDays ?? INFORMAL_TTL_DAYS
    ttlDays = Math.min(cfgInformal, INFORMAL_TTL_DAYS)
  } else {
    ttlDays = cfg?.notesTtlDays ?? DEFAULT_TTL_DAYS
  }
  const expires = start + ttlDays * 24 * 60 * 60 * 1000
  return new Date(expires).toISOString()
}

/**
 * 写一条 note。调用方传 confidence/expires_at 一律忽略并覆盖（§4.0 a/b）。
 * @param {string} projectRoot
 * @param {{ slug: string, content: string, source: string, kind?: string, date?: string, facts?: object, cfg?: object }} input
 * @returns {{ file: string, expires_at: string, confidence: 'low'|'medium'|'high' }}
 */
export function writeNote(projectRoot, input) {
  const slug = input?.slug
  assertSlug(slug) // 防路径穿越（白名单）
  if (typeof input.content !== 'string' || input.content.length === 0) {
    throw new Error(`notes: content 必填且必须是非空字符串，收到 ${JSON.stringify(input?.content)}`)
  }
  if (!VALID_SOURCES.has(input.source)) {
    throw new Error(`notes: source 必须是 fde_confirmed|plugin_inferred|client_stated，收到 ${JSON.stringify(input?.source)}`)
  }
  const kind = input.kind ?? 'observation'
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`notes: kind 必须是 informal_commitment|observation|decision_ref，收到 ${JSON.stringify(kind)}`)
  }
  // date 缺省 = 今天（YYYY-MM-DD，本机时区）—— 0086 §2.1：改用 todayLocal（toISOString 是 UTC，会早一天）
  const date = input.date ?? todayLocal()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`notes: date 必须是 YYYY-MM-DD 格式，收到 ${JSON.stringify(date)}`)
  }

  // 0084 §4.0 a：expires_at 一律由写入器按 TTL 算，调用方传了忽略并覆盖
  // 0084 §4.0 b：confidence 由 deriveConfidence(facts) 推，调用方传了忽略并覆盖
  const facts = input.facts ?? {}
  const confidence = deriveConfidence({
    source: input.source,
    fde_confirmed: facts.fde_confirmed === true,
    data_verified: facts.data_verified === true,
    phases_since_review: facts.phases_since_review,
    last_reviewed: facts.last_reviewed ?? null,
    derived_from_confidence: facts.derived_from_confidence ?? null
  })
  const cfg = input.cfg ?? {}
  const expiresAt = computeExpiresAt(date, kind, cfg)

  // 落 memory/notes/{date}-{slug}.md（spec 目录树原样）
  const dir = join(projectRoot, 'memory', 'notes')
  mkdirSync(dir, { recursive: true })
  const file = `${date}-${slug}.md`
  const finalPath = join(dir, file)

  // frontmatter：复用 serializeYaml 的 key: value 行（不另写一份序列化）
  const frontmatter = {
    source: input.source,
    date,
    expires_at: expiresAt,
    reviewed_at: null, // 新建时未复核
    confidence,
    kind
  }
  const yamlText = serializeYaml(frontmatter)
  const body = input.content
  // frontmatter 与 body 之间用 --- 分隔（markdown 规范）
  const fileContent = `---\n${yamlText}---\n${body}\n`

  // 原子写（tmp + fsync + rename，同 decisions/checklist/stakeholders/maturity 约定）
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
  let tmpFd = null
  try {
    tmpFd = openSync(tmpPath, 'w')
    writeFileSync(tmpPath, fileContent, 'utf8')
    closeSync(tmpFd)
    tmpFd = null
    tmpFd = openSync(tmpPath, 'r+')
    fsyncSync(tmpFd)
    closeSync(tmpFd)
    tmpFd = null
    renameSync(tmpPath, finalPath)
  } catch (e) {
    try { if (tmpFd !== null) closeSync(tmpFd) } catch {}
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch {}
    throw new Error(`notes: 写盘失败: ${e?.message ?? e}`)
  }
  // 写完成功后追加 change_log（同三写入器约定）
  appendChange(projectRoot, {
    kind: 'note',
    target: file,
    summary: `${kind} (${confidence})`
  })
  return { file, expires_at: expiresAt, confidence }
}

/**
 * 读单条 note。frontmatter 缺失或字段不全 ⇒ 抛（fail-closed，不返回半成品）。
 * @param {string} projectRoot
 * @param {string} file - 文件名（如 "2026-09-28-design-review.md"）
 * @returns {{ front: object, body: string, file: string }}
 */
export function readNote(projectRoot, file) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error(`notes: file 必须是非空字符串，收到 ${JSON.stringify(file)}`)
  }
  // 0086 §2.3：防 path traversal —— 白名单校验（与 writeNote 的 assertSlug 同强度）
  assertNoteFile(file)
  const p = join(projectRoot, 'memory', 'notes', file)
  if (!existsSync(p)) {
    throw new Error(`notes: 文件不存在 ${p}`)
  }
  const text = readFileSync(p, 'utf8')
  if (text.trim().length === 0) {
    throw new Error(`notes: 文件为空 ${p}`)
  }
  // 解析 frontmatter（--- 之间的 YAML 子集）
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) {
    throw new Error(`notes: ${p} 缺 frontmatter（期望 ---\\n<yaml>\\n---\\n<body>）`)
  }
  const front = parseYamlSubset(m[1], p + ' (frontmatter)')
  const body = m[2]
  // 字段不全 ⇒ 抛（fail-closed）
  const REQUIRED = ['source', 'date', 'expires_at', 'reviewed_at', 'confidence']
  for (const k of REQUIRED) {
    if (!(k in front)) {
      throw new Error(`notes: ${p} frontmatter 缺字段 ${k}`)
    }
  }
  return { front, body, file }
}

/**
 * 列全部 notes。坏文件进 bad 而非静默消失（同 §3.2 形状）。
 * @param {string} projectRoot
 * @returns {{ items: object[], bad: { file: string, error: string }[] }}
 */
export function listNotes(projectRoot) {
  const dir = join(projectRoot, 'memory', 'notes')
  if (!existsSync(dir)) return { items: [], bad: [] }
  const items = []
  const bad = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    try {
      const note = readNote(projectRoot, f)
      items.push({ ...note.front, _file: f, _body: note.body })
    } catch (e) {
      bad.push({ file: f, error: String(e && e.message ? e.message : e) })
    }
  }
  // 按 date 升序
  items.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
  return { items, bad }
}

/**
 * 判过期。now > expires_at。
 * 0084 §4.2：都用 ISO 字符串比较（时区不影响天数比较）。
 * @param {{ expires_at: string }} note
 * @param {string|Date} [now] - ISO 字符串或 Date；缺省 = new Date()
 * @returns {boolean}
 */
export function isExpired(note, now) {
  if (!note || typeof note.expires_at !== 'string') {
    throw new Error(`notes: isExpired 需要 note.expires_at（ISO 字符串），收到 ${JSON.stringify(note?.expires_at)}`)
  }
  const nowMs = now instanceof Date ? now.getTime() : (now ? new Date(now).getTime() : Date.now())
  const expMs = new Date(note.expires_at).getTime()
  // 0086 §2.2：两侧 NaN 都抛（fail-closed）—— 非法 now/expires_at 不再静默判「未过期」
  if (Number.isNaN(expMs)) {
    throw new Error(`notes: isExpired 的 expires_at 不可解析，收到 ${JSON.stringify(note.expires_at)}`)
  }
  if (Number.isNaN(nowMs)) {
    throw new Error(`notes: isExpired 的 now 不可解析，收到 ${JSON.stringify(now)}`)
  }
  return nowMs > expMs
}

/**
 * 为注入面生成文本。过期 ⇒ 文本含「历史备注（未复核）」+ 日期；未过期 ⇒ 原文。
 * 文件本身绝不改写（A5 注入面调它，A5 才真正影响模型看到的上下文）。
 * @param {{ body: string, date: string, expires_at: string }} note
 * @param {string|Date} [now]
 * @returns {{ text: string, expired: boolean }}
 */
export function annotateForInjection(note, now) {
  if (!note || typeof note.body !== 'string' || typeof note.date !== 'string') {
    throw new Error(`notes: annotateForInjection 需要 note.body 与 note.date，收到 ${JSON.stringify(note)}`)
  }
  const expired = isExpired(note, now)
  const text = expired
    ? `历史备注（未复核）：${note.body}（记录于 ${note.date}）`
    : note.body
  return { text, expired }
}

/**
 * 复核 note（只更新 frontmatter 的 reviewed_at，原子写）。
 * A5 的 fde_memory_review 工具用它。
 * @param {string} projectRoot
 * @param {string} file
 * @param {{ at?: string }} [opts]
 * @returns {{ reviewed_at: string }}
 */
export function reviewNote(projectRoot, file, opts) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error(`notes: reviewNote 的 file 必须是非空字符串，收到 ${JSON.stringify(file)}`)
  }
  assertNoteFile(file)
  const at = (opts && typeof opts.at === 'string') ? opts.at : new Date().toISOString()
  const p = join(projectRoot, 'memory', 'notes', file)
  if (!existsSync(p)) {
    throw new Error(`notes: 文件不存在 ${p}`)
  }
  const text = readFileSync(p, 'utf8')
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) {
    throw new Error(`notes: ${p} 缺 frontmatter`)
  }
  const front = parseYamlSubset(m[1], p + ' (frontmatter)')
  // 字段不全 ⇒ 抛（fail-closed）
  const REQUIRED = ['source', 'date', 'expires_at', 'reviewed_at', 'confidence']
  for (const k of REQUIRED) {
    if (!(k in front)) {
      throw new Error(`notes: ${p} frontmatter 缺字段 ${k}`)
    }
  }
  // 只更新 reviewed_at
  front.reviewed_at = at
  const yamlText = serializeYaml(front)
  const newContent = `---\n${yamlText}---\n${m[2]}`

  // 原子写
  const tmpPath = `${p}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
  let tmpFd = null
  try {
    tmpFd = openSync(tmpPath, 'w')
    writeFileSync(tmpPath, newContent, 'utf8')
    closeSync(tmpFd)
    tmpFd = null
    tmpFd = openSync(tmpPath, 'r+')
    fsyncSync(tmpFd)
    closeSync(tmpFd)
    tmpFd = null
    renameSync(tmpPath, p)
  } catch (e) {
    try { if (tmpFd !== null) closeSync(tmpFd) } catch {}
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch {}
    throw new Error(`notes: reviewNote 写盘失败: ${e?.message ?? e}`)
  }
  // 复核也追加 change_log
  appendChange(projectRoot, {
    kind: 'note',
    target: file,
    summary: `reviewed at ${at}`
  })
  return { reviewed_at: at }
}
