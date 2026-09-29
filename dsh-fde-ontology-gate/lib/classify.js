/**
 * L0/L1/L2 变更分级（spec v3 §4：看语义载荷，不看 diff 形状）。
 *
 * 纯同步函数，不碰 IO、不碰 ctx —— 输入 newText/oldText，输出级别 + 理由 + 计数，
 * 便于离线回归。分级判据见 `0091-C1-变更分级-施工单.md` §2，关键词表见 §3②（启发式）。
 */

import { parseOntologyText, DslError } from './ontology-parse.js'

// ---------------------------------------------------------------------------
// 受监管行业判定（照抄 phase/lib/check-d5.js 的 isRegulatedIndustry —— 跨包不 import）
// ---------------------------------------------------------------------------

export const UNSPECIFIED_INDUSTRY = '未声明'

/**
 * spec :246 —— 受监管行业启用 D5 类判定，非受监管行业自动关闭。
 * @param {string} industry
 * @returns {boolean} true = 受监管（medical-*）
 */
export function isRegulatedIndustry(industry) {
  const v = String(industry ?? '').trim()
  if (v === '' || v === UNSPECIFIED_INDUSTRY) return false
  return /^medical(-|$)/i.test(v)
}

// ---------------------------------------------------------------------------
// 受监管字段关键词表（施工单 §3②，启发式：可接受漏报，不冒充精确语义分析）
// ---------------------------------------------------------------------------

/** 临床判定 —— 禁忌症 / 适应症 / 剂量上限等。 */
const CLINICAL_KEYWORDS = [
  'dose', '剂量', '禁忌', 'contraindication', '适应', 'indication',
  'allergy', '过敏', 'egfr', 'creatinine', '肌酐', 'pregnancy', '孕妇', 'contra', '上限'
]

/** 适用范围 —— 部位 / 人群 / 年龄范围等。 */
const SCOPE_KEYWORDS = [
  'site', '部位', 'population', '人群', 'scope', '适用范围', 'age', '年龄', 'range'
]

/** 输出形式 —— 输出 / 格式 / 呈现。 */
const OUTPUT_KEYWORDS = ['output', '输出', 'format', '格式', 'form', '形式', '呈现']

const lower = (s) => String(s ?? '').toLowerCase()

function hitsAny(text, keywords) {
  const t = lower(text)
  return keywords.some((k) => t.includes(k))
}

// ---------------------------------------------------------------------------
// diff：按标识键对齐 + 键排序指纹
// ---------------------------------------------------------------------------

/** 键排序的 JSON —— 同语义同指纹，不受字段书写顺序影响。 */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']'
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  )
}

/**
 * 按 keyOf 对齐新旧单元，产出三组变化。
 * @param {unknown[]} newUnits
 * @param {unknown[]} oldUnits
 * @param {(unit:unknown)=>string} keyOf
 * @returns {{added:unknown[], modified:{before:unknown,after:unknown}[], deleted:unknown[]}}
 */
function diffByKey(newUnits, oldUnits, keyOf) {
  const oldMap = new Map()
  for (const u of oldUnits) oldMap.set(keyOf(u), u)
  const newMap = new Map()
  for (const u of newUnits) newMap.set(keyOf(u), u)

  const added = []
  const modified = []
  const deleted = []
  for (const [k, u] of newMap) {
    if (!oldMap.has(k)) added.push(u)
    else if (stableStringify(u) !== stableStringify(oldMap.get(k))) {
      modified.push({ before: oldMap.get(k), after: u })
    }
  }
  for (const [k, u] of oldMap) {
    if (!newMap.has(k)) deleted.push(u)
  }
  return { added, modified, deleted }
}

// ---------------------------------------------------------------------------
// 单元化 + 受监管字段识别
// ---------------------------------------------------------------------------

/**
 * objects.yaml → 属性单元（key = `对象名.属性名`）。
 *
 * 对象级的新增/删除由属性级体现（新对象的属性全是 added、删除对象的属性全是 deleted）。
 * 纯空对象（无 attributes）的增删在属性级抓不到，由 classifyChange 的
 * "文本变了但 diff 为空 ⇒ 至少 L1"兜底。
 */
function objectAttributeUnits(doc) {
  const units = []
  for (const o of doc.objects) {
    for (const a of o.attributes) {
      units.push({ _object: o.name, ...a })
    }
  }
  return units
}

/** 规则单元：直接就是 rules 数组。 */
const ruleUnits = (doc) => doc.rules
/** action 单元：直接就是 actions 数组。 */
const actionUnits = (doc) => doc.actions
/** guard 单元：直接就是 guards 数组。 */
const guardUnits = (doc) => doc.guards

const emptyDoc = (kind) =>
  kind === 'objects'
    ? { kind: 'objects', objects: [] }
    : kind === 'logic'
      ? { kind: 'logic', rules: [] }
      : kind === 'actions'
        ? { kind: 'actions', actions: [] }
        : { kind: 'guards', guards: [] }

/** 空对象的标识键（objects 空时仍要能取到 kind）。 */
const BASENAME_OF = {
  objects: 'objects.yaml',
  logic: 'logic.yaml',
  actions: 'actions.yaml',
  guards: 'guards.yaml'
}

/** 取一个 unit 的标识键。 */
function keyOf(kind) {
  switch (kind) {
    case 'objects':
      return (u) => `${u._object}.${u.name}`
    case 'logic':
      return (u) => u.id
    case 'actions':
      return (u) => u.id
    case 'guards':
      return (u) => u.ref
    default:
      return (u) => stableStringify(u)
  }
}

/** 取一个 kind 的单元列表。 */
function unitsOf(kind, doc) {
  switch (kind) {
    case 'objects':
      return objectAttributeUnits(doc)
    case 'logic':
      return ruleUnits(doc)
    case 'actions':
      return actionUnits(doc)
    case 'guards':
      return guardUnits(doc)
    default:
      return []
  }
}

/**
 * 受监管字段识别 —— 对一组单元逐个判「临床 / 范围 / 输出」是否命中。
 *
 * @param {string} kind
 * @param {unknown[]} units 只含 added / deleted 单元，或 modified 单元的 `after`
 * @returns {{clinical:boolean, scope:boolean, output:boolean}}
 */
function regulatedHits(kind, units) {
  const hits = { clinical: false, scope: false, output: false }
  for (const u of units) {
    if (u === null || typeof u !== 'object') continue
    if (kind === 'objects') {
      const name = String(u.name ?? '')
      if (hitsAny(name, CLINICAL_KEYWORDS)) hits.clinical = true
      // 适用范围：属性名命中范围词，或带 enum（枚举取值 = 明确的离散范围）。
      if (hitsAny(name, SCOPE_KEYWORDS)) hits.scope = true
      if (u.enum !== undefined && u.enum !== null) hits.scope = true
      if (hitsAny(name, OUTPUT_KEYWORDS)) hits.output = true
    } else if (kind === 'logic') {
      const reason = String(u.reason ?? '')
      const conditionText = u.condition === undefined ? '' : stableStringify(u.condition)
      if (hitsAny(reason, CLINICAL_KEYWORDS) || hitsAny(conditionText, CLINICAL_KEYWORDS)) {
        hits.clinical = true
      }
      // 规则 id 一般不承载临床语义，但 reason 里可能写输出形式；保守起见也扫 id/reason。
      if (hitsAny(String(u.id ?? ''), OUTPUT_KEYWORDS) || hitsAny(reason, OUTPUT_KEYWORDS)) {
        hits.output = true
      }
      if (hitsAny(String(u.id ?? ''), SCOPE_KEYWORDS) || hitsAny(reason, SCOPE_KEYWORDS)) {
        hits.scope = true
      }
    }
    // actions / guards 的 id/ref 是标识符，不承载受监管语义，不扫。
  }
  return hits
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 分级判定主函数。
 *
 * @param {object} args
 * @param {string} args.path - 文件路径（用 basename 判定是否受管 ontology 文件）
 * @param {string} args.newText - 新文件内容
 * @param {string} [args.oldText] - 旧文件内容（文件不存在/读不到时传空串 ⇒ 视为全新创建）
 * @param {string} [args.industry] - 部署行业（受监管行业 + deny 规则 ⇒ L2）
 * @returns {{level:'L0'|'L1'|'L2', reasons:string[], added:number, modified:number, deleted:number}}
 */
export function classifyChange({ path, newText, oldText, industry }) {
  const base = String(path ?? '').replace(/\\/g, '/').split('/').pop()
  const reasons = []

  const kind =
    base === 'objects.yaml'
      ? 'objects'
      : base === 'logic.yaml'
        ? 'logic'
        : base === 'actions.yaml'
          ? 'actions'
          : base === 'guards.yaml'
            ? 'guards'
            : null

  // 非受管 ontology 文件 ⇒ 无法分级 ⇒ 最坏档（fail-closed）。
  if (kind === null) {
    return {
      level: 'L2',
      reasons: [`非受管 ontology 文件（${base}），无法分级，按最坏档 L2`],
      added: 0,
      modified: 0,
      deleted: 0
    }
  }

  // 解析失败（新或旧）⇒ 看不透载荷 ⇒ 最坏档。
  let newDoc
  try {
    newDoc = parseOntologyText(base, newText)
  } catch (e) {
    return {
      level: 'L2',
      reasons: [`新文件解析失败 ⇒ 判 L2：${String(e?.message ?? e)}`],
      added: 0,
      modified: 0,
      deleted: 0
    }
  }
  let oldDoc
  if (oldText && String(oldText).trim().length > 0) {
    try {
      oldDoc = parseOntologyText(base, oldText)
    } catch (e) {
      return {
        level: 'L2',
        reasons: [`旧文件解析失败 ⇒ 判 L2：${String(e?.message ?? e)}`],
        added: 0,
        modified: 0,
        deleted: 0
      }
    }
  } else {
    oldDoc = emptyDoc(kind)
  }

  // diff
  const kf = keyOf(kind)
  const { added, modified, deleted } = diffByKey(unitsOf(kind, newDoc), unitsOf(kind, oldDoc), kf)

  const changedCount = added.length + modified.length + deleted.length

  // 兜底：文本变了但 diff 抓不到（如空对象的增删）⇒ 至少按"修改"处理。
  if (changedCount === 0 && newText !== oldText) {
    return {
      level: 'L1',
      reasons: ['文本有变化但未按标识键对齐到任何单元（如空对象增删），按修改语义判 L1'],
      added: 0,
      modified: 1,
      deleted: 0
    }
  }

  // 受监管字段识别：只看"变更过的"单元（added + modified.after + deleted）。
  const changedUnits = [
    ...added,
    ...modified.map((m) => m.after),
    ...deleted
  ]
  const hits = regulatedHits(kind, changedUnits)

  // 分级（取最高档，逐条记理由）。
  let level = 'L0'

  const denyAdded = added.filter((u) => u && String(u.effect) === 'deny')
  const hasDenyChange =
    denyAdded.length > 0 ||
    modified.some((m) => String(m.before?.effect) === 'deny' || String(m.after?.effect) === 'deny') ||
    deleted.some((u) => u && String(u.effect) === 'deny')

  if (hits.clinical) {
    level = 'L2'
    reasons.push('触及临床判定（禁忌症/适应症/剂量上限等关键词命中）')
  }
  if (hits.scope) {
    level = 'L2'
    reasons.push('改动适用范围（部位/人群/年龄范围等，或带 enum 的取值边界）')
  }
  if (hits.output) {
    level = 'L2'
    reasons.push('改动输出形式（输出/格式/呈现）')
  }
  if (level !== 'L2' && isRegulatedIndustry(industry) && kind === 'logic' && hasDenyChange) {
    level = 'L2'
    reasons.push(`受监管行业（${industry}）且改动涉及 logic.yaml 的 deny 规则`)
  }
  if (level === 'L0' && denyAdded.length > 0) {
    level = 'L1'
    reasons.push('新增 deny 规则（不涉及临床语义）')
  }
  if (level === 'L0' && (modified.length > 0 || deleted.length > 0)) {
    level = 'L1'
    reasons.push('改动既有语义（修改/删除）')
  }
  if (level === 'L0') {
    reasons.push('仅新增非 deny、不涉及受监管字段')
  }

  return {
    level,
    reasons,
    added: added.length,
    modified: modified.length,
    deleted: deleted.length
  }
}

const LEVEL_RANK = { L0: 0, L1: 1, L2: 2 }

/**
 * 手动级别解析：只能升级、不能降级（spec §4「FDE 只能升级不能降级」）。
 *
 * @param {string} autoLevel 自动判定级别
 * @param {string|undefined} requestedLevel 手动指定级别（缺省则用自动）
 * @returns {{level:string, downgraded:boolean, requestedLevel?:string, autoLevel?:string}}
 *   downgraded=true 表示请求低于自动级别 ⇒ 调用方应拒绝（LEVEL_DOWNGRADE_DENIED）。
 */
export function resolveManualLevel(autoLevel, requestedLevel) {
  if (!requestedLevel) return { level: autoLevel, downgraded: false }
  if (LEVEL_RANK[requestedLevel] < LEVEL_RANK[autoLevel]) {
    return { level: autoLevel, downgraded: true, requestedLevel, autoLevel }
  }
  return { level: requestedLevel, downgraded: false }
}
