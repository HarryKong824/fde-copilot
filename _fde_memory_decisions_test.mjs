/**
 * _fde_memory_decisions_test.mjs —— dsh-fde-memory A2 离线回归
 *
 * 覆盖（0079 §6 验证表 第 1-12 + 14 条；13/15 由 _deploy_diff.mjs 和 DSH 活验负责）：
 *   1. confidence.js deriveConfidence：6 条基础档（含补写第 6 档）+ ≥3 条叠加组合
 *   2. decisions.js：序号独占、文件名切分、连续写无重号、失败清理、fail-closed 读、source 枚举
 *   3. 跨包等价：本插件 linkHash vs phase linkHash、本插件 parseYamlSubset vs dsl parseYamlSubset（含错误分支）
 *   4. SRC_SHA 哨兵：源件 sha256 变 ⇒ 提示不判红
 *   5. exit code 敏感：FDE_INVERT=1 ⇒ 必红
 *
 * 退出码 0 = 全绿；非 0 = 有失败。
 */

import { pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const ROOT = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18'
const MEM_ROOT = ROOT + '/dsh-fde-memory'
const DSL_ROOT = ROOT + '/dsh-fde-dsl'
const PHASE_ROOT = ROOT + '/dsh-fde-phase'

// ===== SRC_SHA 哨兵（0079 §6 第 11 条）=====
const SRC_SHA_PATH = MEM_ROOT + '/_a2_src_sha.json'
const SRC_SHA = JSON.parse(readFileSync(SRC_SHA_PATH, 'utf8'))
const SRC_FILES = [
  { key: 'dsh-fde-dsl/lib/errors.js', path: DSL_ROOT + '/lib/errors.js' },
  { key: 'dsh-fde-dsl/lib/yamlsubset.js', path: DSL_ROOT + '/lib/yamlsubset.js' },
  { key: 'dsh-fde-phase/lib/audit.js', path: PHASE_ROOT + '/lib/audit.js' }
]
console.log('\n[SRC_SHA 哨兵]')
for (const item of SRC_FILES) {
  const actual = createHash('sha256').update(readFileSync(item.path)).digest('hex')
  const expected = SRC_SHA[item.key]
  if (actual !== expected) {
    console.log('  WARN ' + item.key + ' sha256 变了（记入=' + expected.slice(0, 16) + '... 实际=' + actual.slice(0, 16) + '...）—— 请重新对拍')
  } else {
    console.log('  OK ' + item.key + ' sha16=' + actual.slice(0, 16))
  }
}

// ===== 加载本插件模块 =====
const confidenceUrl = pathToFileURL(MEM_ROOT + '/lib/confidence.js').href
const decisionsUrl = pathToFileURL(MEM_ROOT + '/lib/decisions.js').href
const auditUrl = pathToFileURL(MEM_ROOT + '/lib/audit.js').href
const yamlsubsetUrl = pathToFileURL(MEM_ROOT + '/lib/yamlsubset.js').href
const { deriveConfidence } = await import(confidenceUrl)
const decisionsMod = await import(decisionsUrl)
const { writeDecision, readDecision, listDecisions, nextSeq } = decisionsMod
const { linkHash, GENESIS, AuditChain } = await import(auditUrl)
const { parseYamlSubset } = await import(yamlsubsetUrl)

// ===== 加载源件用于跨包对拍 =====
const dslYamlUrl = pathToFileURL(DSL_ROOT + '/lib/yamlsubset.js').href
const phaseAuditUrl = pathToFileURL(PHASE_ROOT + '/lib/audit.js').href
const dslMod = await import(dslYamlUrl)
const phaseMod = await import(phaseAuditUrl)

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

// ===== 1. confidence.js deriveConfidence =====
console.log('\n[confidence.js deriveConfidence]')

// §6 第 1 条：6 条基础档逐条断言（含补写第 6 档）
const baseCases = [
  ['plugin_inferred => low', 'plugin_inferred', false, false, 'low'],
  ['client_stated, !fde_confirmed => low', 'client_stated', false, false, 'low'],
  ['client_stated, fde_confirmed, !data_verified => medium', 'client_stated', true, false, 'medium'],
  ['client_stated, fde_confirmed, data_verified => high', 'client_stated', true, true, 'high'],
  ['fde_confirmed, data_verified => high', 'fde_confirmed', false, true, 'high'],
  ['fde_confirmed, !data_verified => medium (补写档)', 'fde_confirmed', false, false, 'medium']
]
for (const c of baseCases) {
  const r = deriveConfidence({
    source: c[1],
    fde_confirmed: c[2],
    data_verified: c[3],
    phases_since_review: 0,
    last_reviewed: '2026-09-28T00:00:00.000Z',
    derived_from_confidence: null
  })
  ok('§6.1 基础档: ' + c[0], r, c[4])
}

// §6 第 1 条：叠加组合 ≥3 条
ok('§6.1 叠加1: client_stated+fde+!data + psr=1,last_reviewed=null => low',
  deriveConfidence({ source: 'client_stated', fde_confirmed: true, data_verified: false, phases_since_review: 1, last_reviewed: null, derived_from_confidence: null }), 'low')
ok('§6.1 叠加2: client_stated+fde+data + psr=3 => low',
  deriveConfidence({ source: 'client_stated', fde_confirmed: true, data_verified: true, phases_since_review: 3, last_reviewed: '2026-09-28T00:00:00.000Z', derived_from_confidence: null }), 'low')
ok('§6.1 叠加3: fde_confirmed+data=high + derived_from=low => medium',
  deriveConfidence({ source: 'fde_confirmed', fde_confirmed: false, data_verified: true, phases_since_review: 0, last_reviewed: '2026-09-28T00:00:00.000Z', derived_from_confidence: 'low' }), 'medium')
ok('§6.1 叠加4: high+psr=3 压 low + derived_from=low => low',
  deriveConfidence({ source: 'fde_confirmed', fde_confirmed: false, data_verified: true, phases_since_review: 3, last_reviewed: '2026-09-28T00:00:00.000Z', derived_from_confidence: 'low' }), 'low')

// §6 第 2 条：补写档（再钉一遍）
ok('§6.2 补写档 fde_confirmed+!data => medium',
  deriveConfidence({ source: 'fde_confirmed', fde_confirmed: false, data_verified: false, phases_since_review: 0, last_reviewed: '2026-09-28T00:00:00.000Z', derived_from_confidence: null }), 'medium')

// §6 第 9 条：source 枚举外值 ⇒ 抛
okThrows('§6.9 source=unknown => throw', () => deriveConfidence({ source: 'unknown' }), 'source 必须是')
okThrows('§6.9 source=null => throw', () => deriveConfidence({ source: null }), 'source 必须是')
okThrows('§6.9 source=undefined => throw', () => deriveConfidence({ source: undefined }), 'source 必须是')
okThrows('§6.9 source=number => throw', () => deriveConfidence({ source: 123 }), 'source 必须是')
okThrows('§6.9 source=空串 => throw', () => deriveConfidence({ source: '' }), 'source 必须是')

// ===== 2. decisions.js =====
console.log('\n[decisions.js]')

const tmpBase = mkdtempSync(join(tmpdir(), 'fde-memory-A2-'))
console.log('TMP BASE: ' + tmpBase)

// §6 第 3 条：confidence 不可写
{
  const r = writeDecision(tmpBase, { phase: '3', decision: '用 X 方案', rationale: '因为 Y', source: 'plugin_inferred', confidence: 'high' })
  ok('§6.3a writeDecision 传 confidence:high + source:plugin_inferred => 落盘 low', r.confidence, 'low')
  const read = readDecision(tmpBase, '3', r.seq)
  ok('§6.3b 落盘文件 confidence 字段 == low', read.confidence, 'low')
  ok('§6.3c 落盘文件 source 字段 == plugin_inferred', read.source, 'plugin_inferred')
}

// §6 第 4 条：序号重启不重号
{
  const phase = '4'
  const dir = join(tmpBase, 'memory', 'decisions')
  writeFileSync(join(dir, phase + '-7.yaml'), 'phase: "4"\nseq: 7\ndecision: "占位"\nsource: fde_confirmed\n', 'utf8')

  const r1 = writeDecision(tmpBase, { phase: phase, decision: '测试1', source: 'fde_confirmed', approved_at: '2026-09-28T00:00:00Z', data_verified: true })
  ok('§6.4a 先放 4-7.yaml => 新写 seq=8', r1.seq, 8)
  ok('§6.4a 文件名 4-8.yaml', r1.file, '4-8.yaml')

  // 删掉 4-8，重新 import 模块（ESM 用 query 重新加载）后再写，应仍 8
  rmSync(join(dir, '4-8.yaml'), { force: true })
  const decisionsUrl2 = decisionsUrl + '?t=' + Date.now()
  const mod2 = await import(decisionsUrl2)
  const r2 = mod2.writeDecision(tmpBase, { phase: phase, decision: '重新import后写', source: 'fde_confirmed', approved_at: '2026-09-28T00:00:00Z', data_verified: true })
  ok('§6.4b 重新 import 后再写，seq 仍=8', r2.seq, 8)
  ok('§6.4b 文件名仍是 4-8.yaml', r2.file, '4-8.yaml')
}

// §6 第 5 条：phase=0.1 => 文件名 0.1-1.yaml
{
  const phase = '0.1'
  const r = writeDecision(tmpBase, { phase: phase, decision: '小数phase', source: 'client_stated', provenance: 'doc://test', fde_confirmed: true, data_verified: true })
  ok('§6.5a phase=0.1 => 文件名 0.1-1.yaml', r.file, '0.1-1.yaml')
  const read = readDecision(tmpBase, '0.1', 1)
  ok('§6.5b readDecision(0.1, 1) 取回 seq=1', read.seq, 1)
  ok('§6.5c readDecision(0.1, 1) 取回 phase="0.1"', read.phase, '0.1')
}

// §6 第 6 条：连续 5 次写同 phase => 5 文件、seq 连续无重复、无空文件
// 注：writeDecision 是同步函数（openSync/writeFileSync），JS 单线程串行调用，
// 本条验证 nextSeq + openSync('wx') 抢号在串行连续调用下能正确分配 seq。
{
  const phase = '5'
  const results = []
  for (let i = 0; i < 5; i++) {
    results.push(writeDecision(tmpBase, { phase: phase, decision: '并发' + i, source: 'fde_confirmed', approved_at: '2026-09-28T00:00:00Z', data_verified: true }))
  }
  const seqs = results.map(r => r.seq).sort((a, b) => a - b)
  const uniqueSeqs = new Set(seqs)
  ok('§6.6a 连续 5 次写同 phase => seq 数量=5', seqs.length, 5)
  ok('§6.6b 连续 5 次写同 phase => seq 无重复', uniqueSeqs.size, 5)
  ok('§6.6c 连续 5 次写同 phase => seq 连续 1..5', JSON.stringify(seqs), JSON.stringify([1, 2, 3, 4, 5]))

  const dir = join(tmpBase, 'memory', 'decisions')
  let emptyCount = 0
  let totalCount = 0
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('5-') || !f.endsWith('.yaml')) continue
    totalCount++
    const sz = readFileSync(join(dir, f)).length
    if (sz === 0) emptyCount++
  }
  ok('§6.6d 连续 5 次写同 phase => 文件数=5', totalCount, 5)
  ok('§6.6e 连续 5 次写同 phase => 无空文件', emptyCount, 0)
}

// §6 第 7 条：失败清理 —— 用 spawnSync 跑独立子脚本 _a2_inject_fail.mjs（隔离 monkey-patch）
{
  const injectScript = join(ROOT, '_a2_inject_fail.mjs')
  const r = spawnSync(process.execPath, [injectScript], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) {
    FAIL.push({ name: '§6.7 注入失败子脚本退出码', actual: r.status, expected: 0 })
    console.log('  FAIL §6.7 注入失败子脚本退出码 => ' + r.status + ' (期望 0)')
    console.log('    stdout: ' + (r.stdout || '').slice(0, 300))
    console.log('    stderr: ' + (r.stderr || '').slice(0, 300))
  } else {
    let j = null
    try {
      j = JSON.parse(r.stdout)
    } catch (e) {
      FAIL.push({ name: '§6.7 子脚本输出 JSON 解析', actual: (r.stdout || '').slice(0, 200), expected: 'JSON' })
      console.log('  FAIL §6.7 子脚本输出不是 JSON: ' + (r.stdout || '').slice(0, 200))
    }
    if (j) {
      ok('§6.7a 注入写失败 => writeDecision 抛', j.err !== null, true)
      ok('§6.7b 注入写失败 => 抛 message 含"写盘失败"', String(j.err).includes('写盘失败'), true)
      ok('§6.7c 注入写失败 => 无残留空 final', j.emptyCount, 0)
    }
  }
}

// §6 第 8 条：fail-closed 读
{
  const phase = '7'
  const dir = join(tmpBase, 'memory', 'decisions')
  mkdirSync(dir, { recursive: true })
  // 空文件
  const emptyPath = join(dir, '7-1.yaml')
  const fd = openSync(emptyPath, 'w')
  closeSync(fd)
  okThrows('§6.8a 空文件 => readDecision 抛', () => readDecision(tmpBase, '7', 1), '文件为空')
  // 坏 YAML
  writeFileSync(join(dir, '7-2.yaml'), 'this is: [unterminated\n  bad', 'utf8')
  okThrows('§6.8b 坏 YAML => readDecision 抛', () => readDecision(tmpBase, '7', 2), undefined)
}

okThrows('§6.8c readDecision 文件不存在 => 抛', () => readDecision(tmpBase, '99', 99), '文件不存在')

// listDecisions 测试
{
  const phase = '8'
  writeDecision(tmpBase, { phase: phase, decision: 'd1', source: 'fde_confirmed', approved_at: '2026-09-28T00:00:00Z', data_verified: true })
  writeDecision(tmpBase, { phase: phase, decision: 'd2', source: 'fde_confirmed', approved_at: '2026-09-28T00:00:00Z', data_verified: true })
  writeDecision(tmpBase, { phase: phase, decision: 'd3', source: 'fde_confirmed', approved_at: '2026-09-28T00:00:00Z', data_verified: true })
  const list = listDecisions(tmpBase, phase)
  // 0082 §2.2：listDecisions 签名改为 {items, bad}，原两条断言改读 .items
  ok('listDecisions 数量=3', list.items.length, 3)
  ok('listDecisions 按 seq 升序', JSON.stringify(list.items.map(d => d._seq)), JSON.stringify([1, 2, 3]))
  ok('listDecisions bad 数量=0（无坏文件）', list.bad.length, 0)
}

// ===== 3. 跨包等价 =====
console.log('\n[跨包等价]')

// §6 第 10 条 a：本插件 linkHash vs phase linkHash —— 同 prevHash+record => 同 hash
// phase audit.js 没导出 linkHash，从源码 eval 提取
{
  const phaseSrc = readFileSync(PHASE_ROOT + '/lib/audit.js', 'utf8')
  const m = phaseSrc.match(/function linkHash\(prevHash, record\) \{[\s\S]*?\n\}/)
  if (!m) {
    FAIL.push({ name: '§6.10a 提取 phase linkHash 源码', actual: '未找到', expected: 'function linkHash 定义' })
    console.log('  FAIL §6.10a 提取 phase linkHash 源码 => 未找到 function linkHash 定义')
  } else {
    // 用 new Function 把 createHash 注入，eval 出 phase 的 linkHash
    const phaseLinkHash = new Function('createHash', m[0] + '\nreturn linkHash;')(createHash)
    const prevHash = GENESIS
    const record = { kind: 'test', at: '2026-09-28T00:00:00.000Z', seq: 1, decision: 'X' }
    const hashFromPhase = phaseLinkHash(prevHash, record)
    const hashFromMem = linkHash(prevHash, record)
    ok('§6.10a 本插件 linkHash vs phase linkHash (record1)', hashFromMem, hashFromPhase)

    const record2 = { kind: 'restrict-applied', at: '2026-09-28T10:00:00.000Z', seq: 2, agent: 'claude', denied: ['x'] }
    const h2phase = phaseLinkHash(prevHash, record2)
    const h2mem = linkHash(prevHash, record2)
    ok('§6.10a 本插件 linkHash vs phase linkHash (record2)', h2mem, h2phase)

    // 用非 GENESIS 的 prevHash 再测一组
    const prevHash2 = hashFromMem
    const record3 = { kind: 'restrict-restored', at: '2026-09-28T11:00:00.000Z', seq: 3, from: 2 }
    ok('§6.10a 本插件 linkHash vs phase linkHash (链式 prevHash)', linkHash(prevHash2, record3), phaseLinkHash(prevHash2, record3))
  }
}

// §6 第 10 条 b：本插件 parseYamlSubset vs dsl parseYamlSubset —— 同输入同输出，含错误分支
{
  const cases = [
    { name: '正常 YAML', input: 'a: 1\nb: hello\n' },
    { name: '空内容', input: '' },
    { name: '顶层非映射', input: '- item1\n- item2\n' },
    { name: '缩进错', input: 'a:\n  b: 1\n c: 2\n' }
  ]
  for (const c of cases) {
    let memR, dslR, memErr, dslErr
    try { memR = parseYamlSubset(c.input, 'test.yaml') } catch (e) { memErr = String(e && e.message ? e.message : e) }
    try { dslR = dslMod.parseYamlSubset(c.input, 'test.yaml') } catch (e) { dslErr = String(e && e.message ? e.message : e) }
    const memStr = JSON.stringify(memR) === undefined ? 'undefined' : JSON.stringify(memR)
    const dslStr = JSON.stringify(dslR) === undefined ? 'undefined' : JSON.stringify(dslR)
    const memFull = memStr + '|' + (memErr || '')
    const dslFull = dslStr + '|' + (dslErr || '')
    ok('§6.10b parseYamlSubset 跨包等价: ' + c.name, memFull, dslFull)
  }
}

// ===== 4. 不动既有状态（§6 第 14 条） =====
console.log('\n[不动既有状态]')
// A2 套件全程在临时目录里跑，不接触 dsh-fde-memory 真实部署
// state.yaml sha16 仍 5a3abd483b5ff949（A1 已钉，由 _fde_memory_test.mjs 验证；本套件不重测）
{
  if (existsSync(MEM_ROOT + '/SCHEMA_VERSION')) {
    const sv = readFileSync(MEM_ROOT + '/SCHEMA_VERSION', 'utf8')
    ok('§6.14 dsh-fde-memory/SCHEMA_VERSION 仍是 "1\\n"', sv, '1\n')
  } else {
    console.log('  (skip) dsh-fde-memory/SCHEMA_VERSION 不存在（A1 未活验）')
  }
}

// ===== 5. 清理 =====
rmSync(tmpBase, { recursive: true, force: true })

// ===== INVERT 模式（§6 第 12 条 exit code 敏感）=====
if (INVERT) {
  // 故意失败以验证 exit code 真的会非 0
  console.log('\n[INVERT 模式] 故意失败以验证 exit code 敏感（0079 §6 第 12 条）')
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
