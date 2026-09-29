/**
 * Stage 5.6 · D5 compliance.yaml 离线回归（0066 §7 整改 #7 重写，原 0 字节空文件）。
 *
 * 跑法：
 *   node _fde_d5_test.mjs            （正常：通过应 EXIT=0）
 *   FDE_INVERT=1 node _fde_d5_test.mjs   （故意做反：通过应 EXIT=1，验证断言有效）
 *
 * 结果写 _fde_d5_test_out.txt（不走控制台，防 Windows 代码页乱码）。
 *
 * 覆盖（对应 0064 施工单 §5.1 + 0066 §3.3 的 5 类缺口）：
 *   §1 isRegulatedIndustry 三态（medical-* 启用 / retail 不适用 / '未声明' 不适用 / '' 不适用）
 *   §2 parseComplianceYaml 真能报错（缺陷 D：垃圾行 ⇒ ok:false，不是 4 键全 missing）
 *   §3 verifyComplianceText 5 类反例（文件不存在 / 解析失败 / 缺 data_policy / reviewer 空串 / classified:false）
 *   §4 关键限定：只点缺失项，不把 4 键全报红（0064 §5.1 注）
 *   §5 正例：4 键齐全且非空 + classified:true ⇒ 通过
 *   §6 COMPLIANCE_KEYS 常量长度
 *   §7 isNonEmpty 单元（null/""/[]{}/{}=false, "x"/[1]/{a:1}=true）
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  D5_ANCHOR_ALG,
  COMPLIANCE_KEYS,
  UNSPECIFIED_INDUSTRY,
  isRegulatedIndustry,
  parseComplianceYaml,
  isNonEmpty,
  verifyComplianceText,
  complianceFingerprintSync,
  runD5Check
} from './dsh-fde-phase/lib/check-d5.js'

const INVERT = process.env.FDE_INVERT === '1'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '_fde_d5_test_out.txt')
const lines = []
let passed = 0
let failed = 0

// ---------------------------------------------------------------- 测试小工具
function t(name, fn) {
  try {
    const r = fn()
    if (r instanceof Promise) throw new Error('同步用例请传同步函数')
    const ok = !INVERT
    if (ok) { passed += 1; lines.push('  OK ' + name) }
    else { failed += 1; lines.push('  INVERT-FAIL ' + name) }
  } catch (e) {
    const ok = INVERT
    if (ok) { passed += 1; lines.push('  OK(INVERT) ' + name) }
    else { failed += 1; lines.push('  FAIL ' + name); lines.push('      ' + (e && e.message ? e.message : String(e))) }
  }
}

async function ta(name, fn) {
  try {
    await fn()
    const ok = !INVERT
    if (ok) { passed += 1; lines.push('  OK ' + name) }
    else { failed += 1; lines.push('  INVERT-FAIL ' + name) }
  } catch (e) {
    const ok = INVERT
    if (ok) { passed += 1; lines.push('  OK(INVERT) ' + name) }
    else { failed += 1; lines.push('  FAIL ' + name); lines.push('      ' + (e && e.message ? e.message : String(e))) }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败')
}
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error((msg || '不相等') + '：期望 ' + e + '，实际 ' + a)
}

// ---------------------------------------------------------------- 夹具
function mkDir() {
  return mkdtempSync(join(tmpdir(), 'fde-d5-'))
}

/** 完整合法 compliance.yaml（5 键齐全 + 非空 + classified:true + authorized:true） */
const GOOD_YAML = 'schema_version: 1\noutput_boundary:\n  statement: "本工具输出不作为唯一诊断依据"\nreview_chain:\n  reviewer: "Dr. Zhang"\n  reviewed_at: "2026-09-28"\n  conclusion: "approved"\n  original_snapshot_ref: "snap-001"\ndata_policy:\n  masking_rule: "MRI 脱敏"\n  authorization_basis: "患者知情同意"\n  retention_period: "30d"\n  minimal_scope: "min"\nchange_assessment:\n  classified: true\n  level: "L2"\n  assessed_at: "2026-09-28"\nrollback_preauth:\n  authorized: true\n'

function writeGood(dir) {
  const p = join(dir, 'compliance.yaml')
  writeFileSync(p, GOOD_YAML, 'utf8')
  return p
}

// ================================================================ 测试体
lines.push('== Stage 5.6 D5 compliance.yaml offline ==')

// ---------- §1 isRegulatedIndustry 三态（缺陷 C 的核心） ----------
lines.push('[isRegulatedIndustry 三态]')
t("isRegulatedIndustry('medical-aesthetics') => true（受监管启用）", () => {
  assertEq(isRegulatedIndustry('medical-aesthetics'), true)
})
t("isRegulatedIndustry('medical') => true（仅前缀也启用）", () => {
  assertEq(isRegulatedIndustry('medical'), true)
})
t("isRegulatedIndustry('retail') => false（非受监管不适用）", () => {
  assertEq(isRegulatedIndustry('retail'), false)
})
t("isRegulatedIndustry('未声明') => false（哨兵值不适用）", () => {
  assertEq(isRegulatedIndustry('未声明'), false)
})
t("isRegulatedIndustry('') => false（空串不适用）", () => {
  assertEq(isRegulatedIndustry(''), false)
})
t("isRegulatedIndustry(undefined) => false", () => {
  assertEq(isRegulatedIndustry(undefined), false)
})
t("isRegulatedIndustry(null) => false", () => {
  assertEq(isRegulatedIndustry(null), false)
})
t("UNSPECIFIED_INDUSTRY === '未声明'", () => {
  assertEq(UNSPECIFIED_INDUSTRY, '未声明')
})

// ---------- §2 parseComplianceYaml 真能报错（缺陷 D 方案 a） ----------
lines.push('[parseComplianceYaml 真能报错]')
t('🔴 垃圾行（非键非注释非缩进）⇒ ok:false + parse-error（不是 4 键 missing）', () => {
  const r = parseComplianceYaml('this is not yaml\n  - just garbage')
  assert(!r.ok, '应 ok:false，实际 ' + JSON.stringify(r))
  assert(r.error && r.error.includes('无法解析'), '应含"无法解析"，实际 ' + JSON.stringify(r.error))
})
t('空串 ⇒ ok:true + obj:{}（空文件不是错误，只是 4 键都缺）', () => {
  const r = parseComplianceYaml('')
  assertEq(r.ok, true)
  assertEq(r.obj, {})
})
t('纯注释 ⇒ ok:true + obj:{}', () => {
  const r = parseComplianceYaml('# just a comment\n# another')
  assertEq(r.ok, true)
  assertEq(r.obj, {})
})
t('合法 YAML ⇒ ok:true + 5 键', () => {
  const r = parseComplianceYaml(GOOD_YAML)
  assertEq(r.ok, true)
  assert(Object.keys(r.obj).length >= 5, '应至少 5 键，实际 ' + Object.keys(r.obj).length)
})

// ---------- §3 verifyComplianceText 5 类反例 ----------
lines.push('[verifyComplianceText 5 类反例]')

ta('🔴 文件不存在场景（通过 runD5Check 验）⇒ passed:false + unreadable', async () => {
  const dir = mkDir()
  const p = join(dir, 'compliance.yaml')  // 不创建
  const r = await runD5Check(p)
  assertEq(r.passed, false)
  assert(r.failures.some((f) => f.code === 'unreadable'), '应有 unreadable 失败码')
})

t('🔴 YAML 解析失败（垃圾行）⇒ passed:false + parse-error（不是 4 键 missing）', () => {
  const r = verifyComplianceText('garbage line not yaml\n  - bad')
  assertEq(r.passed, false)
  const codes = r.failures.map((f) => f.code)
  assert(codes.includes('parse-error'), '应有 parse-error，实际 ' + JSON.stringify(codes))
  assert(!codes.includes('missing-key'), '不应有 missing-key（文件不是缺键，是不合法 YAML）')
})

t('🔴 缺 data_policy ⇒ passed:false + 只点 data_policy（不把 4 键全报红）', () => {
  const yaml = 'output_boundary:\n  statement: "x"\nreview_chain:\n  reviewer: "Dr."\nchange_assessment:\n  classified: true\n  level: "L2"\nrollback_preauth:\n  authorized: true\n'
  const r = verifyComplianceText(yaml)
  assertEq(r.passed, false)
  const missing = r.failures.filter((f) => f.code === 'missing-key').map((f) => f.key)
  assertEq(missing, ['data_policy'])
  assertEq(r.failures.length, 1, '应只有 1 条失败（只缺 data_policy），实际 ' + r.failures.length)
})

t('🔴 review_chain.reviewer 空串 ⇒ passed:false + empty-subfield（只点 review_chain）', () => {
  const yaml = 'output_boundary:\n  statement: "x"\nreview_chain:\n  reviewer: ""\ndata_policy:\n  masking_rule: "m"\nchange_assessment:\n  classified: true\n  level: "L2"\nrollback_preauth:\n  authorized: true\n'
  const r = verifyComplianceText(yaml)
  assertEq(r.passed, false)
  const subs = r.failures.filter((f) => f.code === 'empty-subfield').map((f) => f.key)
  assertEq(subs, ['review_chain'])
  assertEq(r.failures.length, 1)
})

t('🔴 change_assessment.classified: false ⇒ passed:false + not-classified（缺陷 E）', () => {
  const yaml = 'output_boundary:\n  statement: "x"\nreview_chain:\n  reviewer: "Dr."\ndata_policy:\n  masking_rule: "m"\nchange_assessment:\n  classified: false\n  level: "L2"\nrollback_preauth:\n  authorized: true\n'
  const r = verifyComplianceText(yaml)
  assertEq(r.passed, false)
  const codes = r.failures.map((f) => f.code)
  assert(codes.includes('not-classified'), '应有 not-classified，实际 ' + JSON.stringify(codes))
})

t('🔴 change_assessment.classified 缺失 ⇒ passed:false + not-classified', () => {
  const yaml = 'output_boundary:\n  statement: "x"\nreview_chain:\n  reviewer: "Dr."\ndata_policy:\n  masking_rule: "m"\nchange_assessment:\n  level: "L2"\nrollback_preauth:\n  authorized: true\n'
  const r = verifyComplianceText(yaml)
  assertEq(r.passed, false)
  assert(r.failures.some((f) => f.code === 'not-classified'), '应有 not-classified')
})

t('🔴 change_assessment.classified 非布尔（"true" 字符串）⇒ passed:false + not-classified', () => {
  const yaml = 'output_boundary:\n  statement: "x"\nreview_chain:\n  reviewer: "Dr."\ndata_policy:\n  masking_rule: "m"\nchange_assessment:\n  classified: "true"\n  level: "L2"\nrollback_preauth:\n  authorized: true\n'
  const r = verifyComplianceText(yaml)
  assertEq(r.passed, false)
  assert(r.failures.some((f) => f.code === 'not-classified'), '字符串 "true" 不是布尔 true')
})

// ---------- §3b rollback_preauth 反例（C3 第 5 键） ----------
lines.push('[rollback_preauth 反例]')
const PREAUTH_BASE = 'output_boundary:\n  statement: "x"\nreview_chain:\n  reviewer: "Dr."\ndata_policy:\n  masking_rule: "m"\nchange_assessment:\n  classified: true\n  level: "L2"\n'

t('🔴 rollback_preauth 整键缺失 ⇒ passed:false + missing-key（只点 rollback_preauth）', () => {
  const r = verifyComplianceText(PREAUTH_BASE)
  assertEq(r.passed, false)
  const missing = r.failures.filter((f) => f.code === 'missing-key').map((f) => f.key)
  assertEq(missing, ['rollback_preauth'])
  assertEq(r.failures.length, 1)
})

t('🔴 rollback_preauth.authorized: false ⇒ passed:false + not-authorized', () => {
  const yaml = PREAUTH_BASE + 'rollback_preauth:\n  authorized: false\n'
  const r = verifyComplianceText(yaml)
  assertEq(r.passed, false)
  assert(r.failures.some((f) => f.code === 'not-authorized'), '应有 not-authorized')
})

t('🔴 rollback_preauth.authorized 缺失 ⇒ passed:false + not-authorized', () => {
  const yaml = PREAUTH_BASE + 'rollback_preauth:\n  note: "x"\n'
  const r = verifyComplianceText(yaml)
  assertEq(r.passed, false)
  assert(r.failures.some((f) => f.code === 'not-authorized'), 'authorized 缺失应判 not-authorized')
})

t('🔴 rollback_preauth.authorized 非布尔（"true" 字符串）⇒ passed:false + not-authorized', () => {
  const yaml = PREAUTH_BASE + 'rollback_preauth:\n  authorized: "true"\n'
  const r = verifyComplianceText(yaml)
  assertEq(r.passed, false)
  assert(r.failures.some((f) => f.code === 'not-authorized'), '字符串 "true" 不是布尔 true')
})

// ---------- §4 关键限定：只点缺失项（0064 §5.1 注） ----------
lines.push('[只点缺失项，不报 4 键全红]')
t('🔴 只缺 data_policy 时 failures.length === 1（不把 4 键全报红）', () => {
  const yaml = 'output_boundary:\n  statement: "x"\nreview_chain:\n  reviewer: "Dr."\nchange_assessment:\n  classified: true\n  level: "L2"\nrollback_preauth:\n  authorized: true\n'
  const r = verifyComplianceText(yaml)
  assertEq(r.failures.length, 1)
  assertEq(r.failures[0].key, 'data_policy')
})

// ---------- §5 正例 ----------
lines.push('[正例：4 键齐全 + 非空 + classified:true]')
t('4 键齐全且非空且 classified:true ⇒ passed:true', () => {
  const r = verifyComplianceText(GOOD_YAML)
  assertEq(r.passed, true)
  assertEq(r.failures, [])
})

t('complianceFingerprintSync 返回 sha256 + len + nonempty=5', () => {
  const dir = mkDir()
  const p = writeGood(dir)
  const fp = complianceFingerprintSync(p)
  assert(fp.sha256 && fp.sha256.length === 64, 'sha256 应是 64 位')
  assert(fp.len > 0, 'len 应 > 0')
  assertEq(fp.nonempty, 5)
})

ta('runD5Check(合法文件) ⇒ passed:true + keyCount≥5 + nonemptyCount=5', async () => {
  const dir = mkDir()
  const p = writeGood(dir)
  const r = await runD5Check(p)
  assertEq(r.passed, true)
  assertEq(r.nonemptyCount, 5)
  assert(r.keyCount >= 5, 'keyCount 应 ≥5')
})

t('D5_ANCHOR_ALG 字面量', () => {
  assertEq(D5_ANCHOR_ALG, 'compliance.yaml(sha256+len+nonempty)@v1')
})

// ---------- §6 常量 ----------
lines.push('[常量]')
t('COMPLIANCE_KEYS 有 5 键', () => {
  assertEq(COMPLIANCE_KEYS.length, 5)
  assertEq([...COMPLIANCE_KEYS].sort(), ['change_assessment', 'data_policy', 'output_boundary', 'review_chain', 'rollback_preauth'])
})

// ---------- §7 isNonEmpty 单元 ----------
lines.push('[isNonEmpty 单元]')
t('isNonEmpty(null)=false', () => assertEq(isNonEmpty(null), false))
t('isNonEmpty(undefined)=false', () => assertEq(isNonEmpty(undefined), false))
t('isNonEmpty("")=false', () => assertEq(isNonEmpty(''), false))
t('isNonEmpty([])=false', () => assertEq(isNonEmpty([]), false))
t('isNonEmpty({})=false', () => assertEq(isNonEmpty({}), false))
t('isNonEmpty("x")=true', () => assertEq(isNonEmpty('x'), true))
t('isNonEmpty([1])=true', () => assertEq(isNonEmpty([1]), true))
t('isNonEmpty({a:1})=true', () => assertEq(isNonEmpty({ a: 1 }), true))
t('isNonEmpty({classified:false})=true（对象非空，classified 判定在 verify 里单独做）', () => {
  assertEq(isNonEmpty({ classified: false }), true)
})

// ---------------------------------------------------------------- 收尾
lines.push('')
lines.push('PASS ' + passed + ' / FAIL ' + failed)
lines.push('RESULT: ' + (failed === 0 ? 'PASS' : 'FAIL'))

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log('wrote ' + OUT)

process.exitCode = failed > 0 ? 1 : 0
