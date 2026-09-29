/**
 * _fde_memory_a4_test.mjs —— dsh-fde-memory A4 离线回归（notes + 过期降级）
 *
 * 覆盖（0084 §4.2 + §6.4-§6.7 验证表）：
 *   1. writeNote / readNote / listNotes 基础
 *   2. §4.2 四组双向过期断言：
 *      ① 90 天默认：-89 未过期 / -91 已过期
 *      ② informal_commitment 30 天：-29 未过期 / -31 已过期
 *      ③ informal 不能被 cfg 90 救活（强制项优先）
 *      ④ annotateForInjection 过期含"历史备注（未复核）"+日期 / 未过期不含（双向）
 *   3. §6.5 confidence 不可写（传 confidence:'high' + source: plugin_inferred ⇒ low）
 *   4. §6.6 expires_at 不可写（传 expires_at:'2099-01-01' ⇒ 被 TTL 覆盖）
 *   5. §6.7 slug 路径穿越（'../x' / 'a/b' / 'A B' ⇒ 逐个抛）
 *   6. readNote 缺 frontmatter ⇒ 抛
 *   7. listNotes 坏文件进 bad
 *   8. reviewNote 原子写 + reviewed_at 更新
 *   9. notes 写完成功后 appendChange（kind=note）
 *
 * 退出码 0 = 全绿；非 0 = 有失败。
 */

import { pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18'
const MEM_ROOT = ROOT + '/dsh-fde-memory'

const notesUrl = pathToFileURL(MEM_ROOT + '/lib/notes.js').href
const changeLogUrl = pathToFileURL(MEM_ROOT + '/lib/change-log.js').href

const { writeNote, readNote, listNotes, isExpired, annotateForInjection, reviewNote, todayLocal, assertNoteFile } = await import(notesUrl)
const { readRecentChanges } = await import(changeLogUrl)

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

// 工具：算 N 天前的 YYYY-MM-DD（UTC）
function daysAgo(n) {
  const d = new Date(Date.UTC(2026, 8, 28) - n * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

// ===== 1. writeNote / readNote 基础 =====
console.log('\n[notes 基础 write/read]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A4-base-'))

  const r = writeNote(tmpBase, {
    slug: 'design-review',
    content: '讨论了模块边界与数据流',
    source: 'fde_confirmed',
    kind: 'observation',
    date: '2026-09-28',
    facts: { fde_confirmed: true, data_verified: true }
  })
  ok('§4.1 writeNote 文件名=2026-09-28-design-review.md', r.file, '2026-09-28-design-review.md')
  ok('§4.1 writeNote confidence=high（fde_confirmed + data_verified）', r.confidence, 'high')
  ok('§4.1 writeNote expires_at 含 2026-12-27（+90 天）', r.expires_at.includes('2026-12-27'), true)

  // readNote
  const note = readNote(tmpBase, '2026-09-28-design-review.md')
  ok('§4.1 readNote front.source=fde_confirmed', note.front.source, 'fde_confirmed')
  ok('§4.1 readNote front.date=2026-09-28', note.front.date, '2026-09-28')
  ok('§4.1 readNote front.confidence=high', note.front.confidence, 'high')
  ok('§4.1 readNote front.kind=observation', note.front.kind, 'observation')
  ok('§4.1 readNote front.reviewed_at=null（新建未复核）', note.front.reviewed_at, null)
  ok('§4.1 readNote body 含正文', note.body.includes('讨论了模块边界'), true)

  // 文件确实落盘
  ok('§4.1 writeNote 文件存在', existsSync(join(tmpBase, 'memory', 'notes', r.file)), true)

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 2. §4.2 四组双向过期断言 =====
console.log('\n[§4.2 过期口径四组双向]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A4-exp-'))
  // 固定 now = 2026-09-28T00:00:00.000Z
  const NOW = '2026-09-28T00:00:00.000Z'

  // ① 90 天默认：-89 未过期 / -91 已过期
  const r89 = writeNote(tmpBase, {
    slug: 'note-89', content: 'x', source: 'fde_confirmed',
    date: daysAgo(89), facts: { fde_confirmed: true, data_verified: true }
  })
  const n89 = readNote(tmpBase, r89.file)
  ok('§4.2 ① 90天 -89 未过期', isExpired(n89.front, NOW), false)

  const r91 = writeNote(tmpBase, {
    slug: 'note-91', content: 'x', source: 'fde_confirmed',
    date: daysAgo(91), facts: { fde_confirmed: true, data_verified: true }
  })
  const n91 = readNote(tmpBase, r91.file)
  ok('§4.2 ① 90天 -91 已过期', isExpired(n91.front, NOW), true)

  // ② informal_commitment 30 天：-29 未过期 / -31 已过期
  const r29 = writeNote(tmpBase, {
    slug: 'informal-29', content: 'x', source: 'fde_confirmed',
    kind: 'informal_commitment', date: daysAgo(29), facts: { fde_confirmed: true, data_verified: true }
  })
  const n29 = readNote(tmpBase, r29.file)
  ok('§4.2 ② informal 30天 -29 未过期', isExpired(n29.front, NOW), false)

  const r31 = writeNote(tmpBase, {
    slug: 'informal-31', content: 'x', source: 'fde_confirmed',
    kind: 'informal_commitment', date: daysAgo(31), facts: { fde_confirmed: true, data_verified: true }
  })
  const n31 = readNote(tmpBase, r31.file)
  ok('§4.2 ② informal 30天 -31 已过期', isExpired(n31.front, NOW), true)

  // ③ informal 不能被 cfg 90 救活（强制项优先）
  //   把 cfg.notesTtlDays=90 + cfg.informalCommitmentTtlDays=90（调高）⇒ informal 仍 30 天
  const r33 = writeNote(tmpBase, {
    slug: 'informal-cfg90', content: 'x', source: 'fde_confirmed',
    kind: 'informal_commitment', date: daysAgo(33), facts: { fde_confirmed: true, data_verified: true },
    cfg: { notesTtlDays: 90, informalCommitmentTtlDays: 90 } // 故意调高
  })
  const n33 = readNote(tmpBase, r33.file)
  ok('§4.2 ③ informal 不能被 cfg 90 救活（-33 已过期）', isExpired(n33.front, NOW), true)

  // ④ annotateForInjection 过期含"历史备注（未复核）"+日期 / 未过期不含（双向）
  const annExpired = annotateForInjection({ body: '旧备注内容', date: '2026-06-01', expires_at: n91.front.expires_at }, NOW)
  ok('§4.2 ④ annotate 过期 expired=true', annExpired.expired, true)
  ok('§4.2 ④ annotate 过期含"历史备注（未复核）"', annExpired.text.includes('历史备注（未复核）'), true)
  ok('§4.2 ④ annotate 过期含日期', annExpired.text.includes('2026-06-01'), true)

  const annFresh = annotateForInjection({ body: '新备注内容', date: '2026-09-28', expires_at: r89.expires_at }, NOW)
  ok('§4.2 ④ annotate 未过期 expired=false', annFresh.expired, false)
  ok('§4.2 ④ annotate 未过期不含"历史备注"', annFresh.text.includes('历史备注'), false)
  ok('§4.2 ④ annotate 未过期原文', annFresh.text, '新备注内容')

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 3. §6.5 confidence 不可写 =====
console.log('\n[§6.5 confidence 不可写]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A4-conf-'))

  // 传 confidence:'high' 且 source: plugin_inferred ⇒ frontmatter 里是 low（plugin_inferred 基础档）
  const r = writeNote(tmpBase, {
    slug: 'conf-test', content: 'x', source: 'plugin_inferred',
    facts: { fde_confirmed: false, data_verified: false },
    confidence: 'high' // 调用方试图覆盖，应被忽略
  })
  ok('§6.5 传 confidence=high 但 source=plugin_inferred ⇒ 实际 low', r.confidence, 'low')

  const note = readNote(tmpBase, r.file)
  ok('§6.5 frontmatter confidence=low（调用方 high 被忽略）', note.front.confidence, 'low')

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 4. §6.6 expires_at 不可写 =====
console.log('\n[§6.6 expires_at 不可写]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A4-exp-'))

  // 传 expires_at:'2099-01-01' ⇒ 被 TTL 覆盖
  // informal_commitment 必须是 30 天（强制项）
  const r = writeNote(tmpBase, {
    slug: 'exp-test', content: 'x', source: 'fde_confirmed',
    kind: 'informal_commitment', date: '2026-09-28',
    facts: { fde_confirmed: true, data_verified: true },
    expires_at: '2099-01-01' // 调用方试图覆盖，应被忽略
  })
  ok('§6.6 传 expires_at=2099 但 informal 强制 30 天 ⇒ 不含 2099', r.expires_at.includes('2099'), false)
  // 2026-09-28 + 30 天 = 2026-10-28
  ok('§6.6 informal expires_at 含 2026-10-28（30 天）', r.expires_at.includes('2026-10-28'), true)

  const note = readNote(tmpBase, r.file)
  ok('§6.6 frontmatter expires_at 不含 2099', String(note.front.expires_at).includes('2099'), false)

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 5. §6.7 slug 路径穿越 =====
console.log('\n[§6.7 slug 路径穿越]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A4-slug-'))

  // '../x' / 'a/b' / 'A B' ⇒ 逐个抛
  okThrows('§6.7 slug="../x" => throw', () =>
    writeNote(tmpBase, { slug: '../x', content: 'x', source: 'fde_confirmed' }), 'slug')

  okThrows('§6.7 slug="a/b" => throw', () =>
    writeNote(tmpBase, { slug: 'a/b', content: 'x', source: 'fde_confirmed' }), 'slug')

  okThrows('§6.7 slug="A B" （空格+大写）=> throw', () =>
    writeNote(tmpBase, { slug: 'A B', content: 'x', source: 'fde_confirmed' }), 'slug')

  okThrows('§6.7 slug="a:b" （冒号）=> throw', () =>
    writeNote(tmpBase, { slug: 'a:b', content: 'x', source: 'fde_confirmed' }), 'slug')

  okThrows('§6.7 slug="" （空）=> throw', () =>
    writeNote(tmpBase, { slug: '', content: 'x', source: 'fde_confirmed' }), 'slug')

  okThrows('§6.7 slug=null => throw', () =>
    writeNote(tmpBase, { slug: null, content: 'x', source: 'fde_confirmed' }), 'slug')

  // 合法 slug
  const r = writeNote(tmpBase, { slug: 'valid-slug-1', content: 'x', source: 'fde_confirmed' })
  ok('§6.7 合法 slug=valid-slug-1 文件落盘', r.file.includes('valid-slug-1'), true)

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 6. readNote 缺 frontmatter ⇒ 抛 =====
console.log('\n[readNote fail-closed]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A4-read-'))
  const dir = join(tmpBase, 'memory', 'notes')
  mkdirSync(dir, { recursive: true })

  // 无 frontmatter（文件名须过 assertNoteFile 白名单，才能走到内容检查）
  writeFileSync(join(dir, '2026-09-28-no-front.md'), '只有正文，没有 frontmatter\n', 'utf8')
  okThrows('§4.1 readNote 缺 frontmatter => throw', () =>
    readNote(tmpBase, '2026-09-28-no-front.md'), 'frontmatter')

  // frontmatter 缺字段
  writeFileSync(join(dir, '2026-09-28-missing-field.md'), '---\nsource: fde_confirmed\ndate: 2026-09-28\n---\nbody\n', 'utf8')
  okThrows('§4.1 readNote frontmatter 缺 expires_at => throw', () =>
    readNote(tmpBase, '2026-09-28-missing-field.md'), '缺字段')

  // 空文件
  writeFileSync(join(dir, '2026-09-28-empty.md'), '', 'utf8')
  okThrows('§4.1 readNote 空文件 => throw', () =>
    readNote(tmpBase, '2026-09-28-empty.md'), '为空')

  // file 路径穿越（0086 §2.3 白名单 assertNoteFile）
  okThrows('§4.1 readNote file 含 .. => throw', () =>
    readNote(tmpBase, '../escaped.md'), '形态')

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 7. listNotes 坏文件进 bad =====
console.log('\n[listNotes 坏文件进 bad]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A4-list-'))
  const dir = join(tmpBase, 'memory', 'notes')
  mkdirSync(dir, { recursive: true })

  // 2 个好文件 + 1 个坏文件
  writeNote(tmpBase, { slug: 'good-1', content: 'x', source: 'fde_confirmed' })
  writeNote(tmpBase, { slug: 'good-2', content: 'y', source: 'fde_confirmed' })
  writeFileSync(join(dir, 'bad.md'), '无 frontmatter\n', 'utf8')

  const result = listNotes(tmpBase)
  ok('§4.1 listNotes items 数量=2（坏的不进 items）', result.items.length, 2)
  ok('§4.1 listNotes bad 数量=1（坏的不消失）', result.bad.length, 1)
  ok('§4.1 listNotes bad[0].file 含 bad.md', result.bad[0].file.includes('bad'), true)
  ok('§4.1 listNotes bad[0].error 是字符串', typeof result.bad[0].error, 'string')

  // 空目录
  const tmpEmpty = mkdtempSync(join(tmpdir(), 'fde-A4-empty-'))
  const e = listNotes(tmpEmpty)
  ok('§4.1 listNotes 空目录 items=[]', e.items.length, 0)
  ok('§4.1 listNotes 空目录 bad=[]', e.bad.length, 0)

  rmSync(tmpBase, { recursive: true, force: true })
  rmSync(tmpEmpty, { recursive: true, force: true })
}

// ===== 8. reviewNote 原子写 + reviewed_at 更新 =====
console.log('\n[reviewNote 原子写]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A4-rev-'))

  const r = writeNote(tmpBase, { slug: 'review-test', content: '待复核', source: 'fde_confirmed' })
  const before = readNote(tmpBase, r.file)
  ok('§4.1 reviewNote 前 reviewed_at=null', before.front.reviewed_at, null)

  const at = '2026-09-28T12:00:00.000Z'
  const rev = reviewNote(tmpBase, r.file, { at })
  ok('§4.1 reviewNote 返回 reviewed_at', rev.reviewed_at, at)

  const after = readNote(tmpBase, r.file)
  ok('§4.1 reviewNote 后 reviewed_at=指定时间', after.front.reviewed_at, at)
  ok('§4.1 reviewNote 后 body 不变（只改 frontmatter）', after.body.includes('待复核'), true)

  // reviewNote 也追加 change_log
  const recent = readRecentChanges(tmpBase, 5)
  ok('§4.1 reviewNote 追加 change_log 数量=2（write+review）', recent.items.length, 2)
  ok('§4.1 change_log 最新 kind=note（review）', recent.items[0].kind, 'note')

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 9. notes 写完 appendChange（kind=note）=====
console.log('\n[notes 写完 appendChange]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A4-cl-'))

  writeNote(tmpBase, { slug: 'cl-test', content: 'x', source: 'fde_confirmed' })
  const recent = readRecentChanges(tmpBase, 5)
  ok('§4.1 writeNote 追加 change_log 数量=1', recent.items.length, 1)
  ok('§4.1 change_log kind=note', recent.items[0].kind, 'note')
  ok('§4.1 change_log target 含文件名', recent.items[0].target.includes('cl-test'), true)

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 10. §2 三条修（0086：todayLocal / isExpired 双向 / assertNoteFile 双向）=====
console.log('\n[§2 三条修]')

{
  // §2.1 todayLocal 用本机时区（可注入时钟）
  // ⚠️ 区分力依赖本机 UTC+8：在 UTC 机器上 toISOString 版也返回 '2026-09-28' ⇒ 恒绿。
  //    本机确为 +8，故当前有效。
  const t = new Date(2026, 8, 28, 0, 30) // 月 0-based：8 = 九月，本机 +8 时 00:30 仍是 28 号
  ok('§2.1 todayLocal 用本机时区（2026-09-28 00:30）', todayLocal(t), '2026-09-28')
  ok('§2.1 todayLocal 缺省返回字符串', typeof todayLocal(), 'string')

  // §2.2 isExpired 双向 NaN 抛（fail-closed，不再静默判"未过期"）
  okThrows('§2.2 isExpired now="乱码" => throw', () =>
    isExpired({ expires_at: '2026-12-27T00:00:00.000Z' }, '乱码'), '不可解析')
  okThrows('§2.2 isExpired expires_at="乱码" => throw', () =>
    isExpired({ expires_at: '乱码' }, '2026-09-28T00:00:00.000Z'), '不可解析')

  // §2.3 assertNoteFile 双向（白名单，与 writeNote 的 assertSlug 同强度）
  okThrows('§2.3 assertNoteFile "../x" => throw', () => assertNoteFile('../x'), '形态')
  okThrows('§2.3 assertNoteFile "a/b.md" => throw', () => assertNoteFile('a/b.md'), '形态')
  okThrows('§2.3 assertNoteFile "2026-09-28-A.md"（大写）=> throw', () => assertNoteFile('2026-09-28-A.md'), '形态')
  okThrows('§2.3 assertNoteFile "2026-09-28-a.txt"（非 .md）=> throw', () => assertNoteFile('2026-09-28-a.txt'), '形态')
  let okValid = true
  try { assertNoteFile('2026-09-28-valid-slug-1.md') } catch { okValid = false }
  ok('§2.3 assertNoteFile 合法名不抛', okValid, true)
}

// ===== 不动既有状态 =====
console.log('\n[不动既有状态]')
{
  if (existsSync(MEM_ROOT + '/SCHEMA_VERSION')) {
    const sv = readFileSync(MEM_ROOT + '/SCHEMA_VERSION', 'utf8')
    ok('§5.5 dsh-fde-memory/SCHEMA_VERSION 仍是 "1\\n"', sv, '1\n')
  }
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
