/**
 * Claude Code 的 A2/A3 核证探针（独立于 WorkBuddy 的 _fde_memory_*_test.mjs）。
 *
 * 角色：打他那批断言覆盖不到的面。0082 的三条补丁就是按它的输出写的。
 *   §①  叠加规则手算对照（4 case）              补丁前：绿
 *   §②  psr 非整数：抛 / null,undefined 走默认   补丁前：🔴（静默当 0，fail-open）
 *   §③  confidence 不可写                        补丁前：绿
 *   §④  手写文件 phase 读回类型漂移               补丁前：🔴
 *   §⑤  phase 路径穿越                           补丁前：🔴
 * ⇒ 期望：0082 补丁落地后 红 0 条。
 * ⚠️ v2（2026-09-28）：v1 把 §② 写成"期望返回 high" —— 补丁后该分支改为 throw，
 *    v1 因此在 §② 崩掉、§③④⑤ 根本没跑到。探针随被测语义一起更新（这也证明补丁生效）。
 * ⚠️ 只读：全部跑在 mkdtempSync 临时目录，不碰部署态。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const B = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18/dsh-fde-memory/lib/'
const { deriveConfidence } = await import(pathToFileURL(B + 'confidence.js').href)
const { writeDecision, readDecision } = await import(pathToFileURL(B + 'decisions.js').href)

const root = mkdtempSync(join(tmpdir(), 'a2-indep-'))
let red = 0
const chk = (name, got, want) => {
  const ok = Object.is(got, want); if (!ok) red++
  console.log(`  ${ok ? 'OK  ' : '🔴 '} ${name} => ${JSON.stringify(got)}${ok ? '' : ` (期望 ${JSON.stringify(want)})`}`)
}
const mustThrow = (name, fn) => {
  try { const v = fn(); red++; console.log(`  🔴 ${name} => 未抛，返回 ${JSON.stringify(v)}`) }
  catch (e) { console.log(`  OK   ${name} => 抛：${String(e.message).slice(0, 46)}`) }
}

console.log('[① 叠加规则手算对照]')
chk('fde_confirmed+!data + psr=1,noreview', deriveConfidence({ source: 'fde_confirmed', data_verified: false, phases_since_review: 1, last_reviewed: null }), 'low')
chk('fde_confirmed+!data + psr=1,已复核', deriveConfidence({ source: 'fde_confirmed', data_verified: false, phases_since_review: 1, last_reviewed: '2026-09-01T00:00:00Z' }), 'medium')
chk('client+fde+data + psr=3,noreview', deriveConfidence({ source: 'client_stated', fde_confirmed: true, data_verified: true, phases_since_review: 3, last_reviewed: null }), 'low')
chk('client+fde+data + psr=2,已复核', deriveConfidence({ source: 'client_stated', fde_confirmed: true, data_verified: true, phases_since_review: 2, last_reviewed: '2026-09-01T00:00:00Z' }), 'high')

console.log('[② psr 校验：非整数抛 / null,undefined 走默认 0（双向）]')
mustThrow('psr="3"（字符串）', () => deriveConfidence({ source: 'client_stated', fde_confirmed: true, data_verified: true, phases_since_review: '3', last_reviewed: null }))
mustThrow('psr=1.5（浮点）', () => deriveConfidence({ source: 'client_stated', fde_confirmed: true, data_verified: true, phases_since_review: 1.5, last_reviewed: null }))
mustThrow('psr=true（布尔）', () => deriveConfidence({ source: 'client_stated', fde_confirmed: true, data_verified: true, phases_since_review: true, last_reviewed: null }))
chk('psr=null ⇒ 不抛走默认0', deriveConfidence({ source: 'client_stated', fde_confirmed: true, data_verified: true, phases_since_review: null, last_reviewed: null }), 'high')
chk('psr=undefined ⇒ 不抛走默认0', deriveConfidence({ source: 'client_stated', fde_confirmed: true, data_verified: true, last_reviewed: null }), 'high')

console.log('[③ confidence 不可写]')
const r = writeDecision(root, { phase: '9', decision: 'x', source: 'plugin_inferred', confidence: 'high' })
chk('落盘 confidence', readDecision(root, '9', r.seq).confidence, 'low')

console.log('[④ 手写文件不带引号：phase 读回必须抛（不再静默 number）]')
mkdirSync(join(root, 'memory', 'decisions'), { recursive: true })
writeFileSync(join(root, 'memory', 'decisions', '0.1-9.yaml'), 'phase: 0.1\nseq: 9\ndecision: 手写\nsource: fde_confirmed\n', 'utf8')
mustThrow('手写 phase: 0.1 读回', () => readDecision(root, '0.1', 9))

console.log('[⑤ phase 路径穿越必须被挡]')
mustThrow("phase='../../escaped'", () => writeDecision(root, { phase: '../../escaped', decision: 'x', source: 'fde_confirmed' }))

console.log(`\n== 核证探针：红 ${red} 条 ==`)
process.exit(red === 0 ? 0 : 1)
