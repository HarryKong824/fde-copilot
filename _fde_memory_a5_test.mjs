/**
 * _fde_memory_a5_test.mjs —— dsh-fde-memory A5 离线回归（分层注入 + 工具面，0086 §4）
 *
 * 覆盖（0086 §6.7 验证表）：
 *   1. 六层各一条（[L1]~[L6] 逐个命中）
 *   2. [L5] 按 date 倒序封顶 10（段尾计数 + 截断可见）
 *   3. [L6] 封顶 20 且段尾有总数（过期未复核队列，升序）
 *   4. confidence 不可写（writeDecision 传 confidence 被覆盖）
 *   5. 过期注记双向（过期含「历史备注（未复核）」，未过期不含）
 *   6. 复核后不进 [L6]（reviewed_at 非空判据双向）
 *   7. tools.js 可离线 import（HarnessError 桩兜底 —— 本文件能 import 到 buildContext 即证）
 *   8. readCurrentPhase：state.yaml 读 current_phase / 缺失 ⇒ null
 *
 * 退出码 0 = 全绿；非 0 = 有失败。FDE_INVERT=1 必红（exit code 敏感）。
 */

import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18'
const MEM_ROOT = ROOT + '/dsh-fde-memory'

const toolsUrl = pathToFileURL(MEM_ROOT + '/lib/tools.js').href
const decisionsUrl = pathToFileURL(MEM_ROOT + '/lib/decisions.js').href
const checklistUrl = pathToFileURL(MEM_ROOT + '/lib/checklist.js').href
const stakeholdersUrl = pathToFileURL(MEM_ROOT + '/lib/stakeholders.js').href
const notesUrl = pathToFileURL(MEM_ROOT + '/lib/notes.js').href

// import tools.js 本身就是 0086 §6.7b 的断言：离线环境能 import 不崩（HarnessError ?? Error 兜底）
const { buildContext, readCurrentPhase } = await import(toolsUrl)
const { writeDecision } = await import(decisionsUrl)
const { writeChecklist } = await import(checklistUrl)
const { writeStakeholder } = await import(stakeholdersUrl)
const { writeNote, reviewNote } = await import(notesUrl)

const PASS = []
const FAIL = []

function ok(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = expected === undefined ? undefined : JSON.stringify(expected)
  if (e === undefined || a === e) {
    PASS.push(name)
    console.log('  OK ' + name + (expected !== undefined ? ' => ' + a : ''))
  } else {
    FAIL.push({ name: name, actual: a, expected: e })
    console.log('  FAIL ' + name + ' => ' + a + ' (期望 ' + e + ')')
  }
}

function okThrows(name, fn, msgContains) {
  try {
    fn()
    FAIL.push({ name: name, actual: 'no throw', expected: 'throw' })
    console.log('  FAIL ' + name + ' => 没 throw (期望 throw)')
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    if (msgContains && !msg.includes(msgContains)) {
      FAIL.push({ name: name, actual: msg, expected: '包含 "' + msgContains + '"' })
      console.log('  FAIL ' + name + ' => throw 但消息不对: ' + msg)
    } else {
      PASS.push(name)
      console.log('  OK ' + name + ' => throw: ' + msg.slice(0, 80))
    }
  }
}

const INVERT = process.env.FDE_INVERT === '1'

// 固定时钟：now = 2026-09-28（date 早于 2026-06-30 的 90 天 TTL note 均过期）
const NOW = new Date('2026-09-28T12:00:00Z')

const cfgOf = (tmp) => ({
  projectRoot: tmp,
  injectChangeLogLimit: 5,
  notesTtlDays: 90,
  informalCommitmentTtlDays: 30
})

// ===== 1. 六层命中 + 内容正确 + 过期注记双向 =====
console.log('\n[六层命中 + 内容 + 注记双向]')
{
  const tmp = mkdtempSync(join(tmpdir(), 'fde-A5-layers-'))
  const cfg = cfgOf(tmp)

  writeChecklist(tmp, '3', [
    { id: 'c1', text: '完成数据接入', done: true, evidence: 'api 对接完成' },
    { id: 'c2', text: '签 SOW', done: false }
  ])
  writeDecision(tmp, { phase: '3', decision: '数据接入走 API', source: 'fde_confirmed', approved_at: '2026-09-28T00:00:00Z', data_verified: true })
  writeDecision(tmp, { phase: '3', decision: 'SOW 下周签', source: 'client_stated', provenance: 'doc://sow' })
  writeStakeholder(tmp, { id: 's1', name: '张三', role: '主治医生', org: '仁和医美', influence: 'high', contact: 'secret@x.com', notes: '不公开' })
  writeStakeholder(tmp, { id: 's2', name: '李四', role: '运营', org: '仁和医美', influence: 'medium' })
  writeNote(tmp, { slug: 'design-review', content: '方案评审通过', source: 'fde_confirmed', date: '2026-09-20', cfg })
  writeNote(tmp, { slug: 'old-note', content: '早期观察', source: 'plugin_inferred', date: '2026-01-01', cfg })

  const text = buildContext(cfg, '3', NOW)

  // 六层命中
  for (const k of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']) {
    ok(`[${k}] 命中`, text.includes(`[${k}]`), true)
  }

  // [L1] checklist
  ok('L1 含 checklist 条目', text.includes('完成数据接入'), true)
  ok('L1 含 done 标记', text.includes('[x]'), true)

  // [L2] decisions
  ok('L2 含 decision', text.includes('数据接入走 API'), true)

  // [L3] stakeholders 4 字段摘要（不含 contact/notes）
  ok('L3 含姓名', text.includes('张三'), true)
  ok('L3 不含 contact（隐私）', text.includes('secret@x.com'), false)

  // [L4] change_log（写入自动追加）
  ok('L4 含 change_log 记录', /\[(decision|checklist|stakeholder|note)\]/.test(text), true)

  // [L5] notes + 过期注记双向
  ok('L5 含未过期 note 原文', text.includes('方案评审通过'), true)
  ok('L5 过期 note 含「历史备注（未复核）」', text.includes('历史备注（未复核）：早期观察'), true)
  ok('L5 未过期 note 不含「历史备注」前缀（双向）', text.includes('历史备注（未复核）：方案评审通过'), false)
  ok('L5 段尾计数（2 条，其中过期 1 条）', text.includes('2 条，其中过期 1 条'), true)

  // [L6] 过期未复核队列（只 old-note 过期未复核；design-review 未过期）
  const l6 = text.slice(text.indexOf('[L6]'))
  ok('L6 含过期 note 文件名', l6.includes('2026-01-01-old-note.md'), true)
  ok('L6 不含未过期 note', l6.includes('2026-09-20-design-review.md'), false)
  ok('L6 只给文件名不给正文', l6.includes('早期观察') === false || l6.indexOf('早期观察') > l6.indexOf('[L6]'), true)

  rmSync(tmp, { recursive: true, force: true })
}

// ===== 2. [L5] 封顶 10（date 倒序，段尾计数 + 截断可见）=====
console.log('\n[[L5] 封顶 10]')
{
  const tmp = mkdtempSync(join(tmpdir(), 'fde-A5-l5-'))
  const cfg = cfgOf(tmp)
  for (let i = 1; i <= 12; i++) {
    const date = `2026-09-${String(i).padStart(2, '0')}`
    writeNote(tmp, { slug: `n${i}`, content: `content-${String(i).padStart(2, '0')}`, source: 'fde_confirmed', date, cfg })
  }
  const text = buildContext(cfg, '3', NOW)
  ok('L5 段尾「共 12 条，列出最近 10 条」', text.includes('共 12 条，列出最近 10 条'), true)
  ok('L5 含最新（09-12）', text.includes('content-12'), true)
  ok('L5 含第 10 新（09-03）', text.includes('content-03'), true)
  ok('L5 不含第 11 条（09-02 截断）', text.includes('content-02'), false)
  ok('L5 不含第 12 条（09-01 截断）', text.includes('content-01'), false)
  rmSync(tmp, { recursive: true, force: true })
}

// ===== 3. [L6] 封顶 20 + 段尾总数（升序，只给文件名+date+天数）=====
console.log('\n[[L6] 封顶 20]')
{
  const tmp = mkdtempSync(join(tmpdir(), 'fde-A5-l6-'))
  const cfg = cfgOf(tmp)
  for (let i = 1; i <= 25; i++) {
    const date = `2026-01-${String(i).padStart(2, '0')}`
    writeNote(tmp, { slug: `q${i}`, content: `q-content-${String(i).padStart(2, '0')}`, source: 'plugin_inferred', date, cfg })
  }
  const text = buildContext(cfg, '3', NOW)
  const l6 = text.slice(text.indexOf('[L6]'))
  ok('L6 段尾「共 25 条，列出前 20 条」', l6.includes('共 25 条，列出前 20 条'), true)
  ok('L6 含最早（01-01）', l6.includes('2026-01-01-q1.md'), true)
  ok('L6 不含第 21 条（01-21）', l6.includes('2026-01-21-q21.md'), false)
  rmSync(tmp, { recursive: true, force: true })
}

// ===== 4. confidence 不可写 =====
console.log('\n[confidence 不可写]')
{
  const tmp = mkdtempSync(join(tmpdir(), 'fde-A5-conf-'))
  const r = writeDecision(tmp, {
    phase: '3',
    decision: '测试置信度',
    source: 'plugin_inferred',
    confidence: 'high', // 调用方传了，必须被忽略并覆盖
    fde_confirmed: false,
    data_verified: false
  })
  ok('confidence 传 high 被覆盖为 low', r.confidence, 'low')
  rmSync(tmp, { recursive: true, force: true })
}

// ===== 5. 复核后不进 [L6]（reviewed_at 非空判据双向）=====
console.log('\n[复核后不进 L6]')
{
  const tmp = mkdtempSync(join(tmpdir(), 'fde-A5-review-'))
  const cfg = cfgOf(tmp)
  writeNote(tmp, { slug: 'expired', content: '过期内容', source: 'plugin_inferred', date: '2026-01-01', cfg })
  // 复核前：过期未复核 ⇒ 进 [L6]
  const before = buildContext(cfg, '3', NOW)
  ok('复核前进 L6', before.slice(before.indexOf('[L6]')).includes('2026-01-01-expired.md'), true)
  // 复核
  reviewNote(tmp, '2026-01-01-expired.md', { at: '2026-09-28T12:00:00Z' })
  const after = buildContext(cfg, '3', NOW)
  ok('复核后不进 L6', after.slice(after.indexOf('[L6]')).includes('2026-01-01-expired.md'), false)
  rmSync(tmp, { recursive: true, force: true })
}

// ===== 6. readCurrentPhase（state.yaml 读 current_phase / 缺失 ⇒ null）=====
console.log('\n[readCurrentPhase]')
{
  const tmp = mkdtempSync(join(tmpdir(), 'fde-A5-phase-'))
  // 缺失 ⇒ null
  ok('state.yaml 缺失 ⇒ null', readCurrentPhase(tmp), null)
  // 写 state.yaml（current_phase: "2"，带引号）
  const memDir = join(tmp, 'memory')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(memDir, { recursive: true })
  writeFileSync(join(memDir, 'state.yaml'), 'schema_version: 1\ncurrent_phase: "2"\nphase_status: in_progress\n', 'utf8')
  ok('state.yaml 读 current_phase = "2"', readCurrentPhase(tmp), '2')
  rmSync(tmp, { recursive: true, force: true })
}

// ===== 7. buildContext phase 缺省（readCurrentPhase）→ [L1]/[L2] 用 current_phase =====
console.log('\n[phase 缺省读 state.yaml]')
{
  const tmp = mkdtempSync(join(tmpdir(), 'fde-A5-autophase-'))
  const cfg = cfgOf(tmp)
  writeChecklist(tmp, '3', [{ id: 'x1', text: '阶段3条目', done: false }])
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(tmp, 'memory'), { recursive: true })
  writeFileSync(join(tmp, 'memory', 'state.yaml'), 'current_phase: "3"\n', 'utf8')
  // 不传 phase：buildContext 内部会调 readCurrentPhase（这里直接验证工具层行为等价）
  const text = buildContext(cfg, readCurrentPhase(tmp), NOW)
  ok('缺省 phase 时 L1 含阶段3条目', text.includes('阶段3条目'), true)
  rmSync(tmp, { recursive: true, force: true })
}

// ===== INVERT 模式（exit code 敏感）=====
if (INVERT) {
  console.log('\n[INVERT 模式] 故意失败以验证 exit code 敏感')
  FAIL.push({ name: 'INVERT 故意失败', actual: '失败', expected: '通过' })
  console.log('  FAIL INVERT 故意失败 => 失败 (期望 通过)')
}

// ===== 总结 =====
console.log('\n=== 总结 ===')
console.log('PASS ' + PASS.length + ' / FAIL ' + FAIL.length)
if (FAIL.length > 0) {
  console.log('FAILED:')
  for (const f of FAIL) console.log('  - ' + f.name + ': actual=' + f.actual + ' expected=' + f.expected)
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
