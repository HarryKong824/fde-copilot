/**
 * C3 回滚预授权 —— 真 SDK 活验（import 副本 lib，让 lib 内部解析真 SDK）。
 * 用真实 ontologyRoot（E:/ontologyRoot）+ projectRoot（fde-state），跑完复原。
 *
 * 四个场景：
 *   1. 无预授权（compliance.yaml 缺 rollback_preauth）⇒ throw ROLLBACK_NO_PREAUTH
 *   2. 有预授权 ⇒ 回滚成功 + state.rollback_at 落盘
 *   3. 观察期内重复回滚 ⇒ throw ROLLBACK_ALREADY_OBSERVING
 *   4. 观察期内 fde_phase_advance ⇒ throw ROLLBACK_OBSERVATION_ACTIVE
 *
 * 审计用 auditPath=''（仅内存），不污染真实 phase 审计链。
 */
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEP = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/node_modules/dsh-fde-phase'
const lib = (f) => pathToFileURL(join(DEP, 'lib', f)).href

const { normalizeConfig } = await import(lib('config.js'))
const { AuditChain } = await import(lib('audit.js'))
const { D1Mirror } = await import(lib('mirror.js'))
const { installRollbackTool, installPhaseTool, ROLLBACK_TOOL } = await import(lib('tools.js'))
const { readStateSync } = await import(lib('state.js'))

const projectRoot = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state'
const ontologyRoot = 'E:/ontologyRoot'
const compliancePath = join(ontologyRoot, 'compliance.yaml')
const statePath = join(projectRoot, 'memory', 'state.yaml')

const complianceBackup = readFileSync(compliancePath, 'utf8')
const stateBackup = readFileSync(statePath, 'utf8')
console.log('[1] 备份完成')
console.log('    state.current_phase =', readStateSync(statePath).current_phase, ' revision =', readStateSync(statePath).revision)
console.log('    compliance 有无 rollback_preauth:', complianceBackup.includes('rollback_preauth') ? '有' : '无')

const cfg = normalizeConfig({
  projectRoot,
  ontologyRoot,
  mode: 'enforce',
  gateAuditPath: 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/gate.jsonl',
  industry: 'medical-aesthetics',
  auditPath: '' // 仅内存
})

const tools = {}
const ctx = {
  tools: { register: (t) => { tools[t.name] = t; return () => {} } },
  effect: (fn) => fn(),
  logger: console
}
const audit = new AuditChain(cfg.auditPath)
const mirror = new D1Mirror()

installRollbackTool(ctx, cfg, audit)
installPhaseTool(ctx, cfg, audit, mirror, undefined)
console.log('[2] 已注册工具:', Object.keys(tools).join(', '))

const rollback = tools[ROLLBACK_TOOL]
const advance = tools['fde_phase_advance']
let ok = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}
const errCode = (e) => e?.code ?? '(无 code)'

// 场景 1：无预授权
console.log('\n[场景1] 无预授权（compliance.yaml 无 rollback_preauth）')
{
  let threw = null
  try { await rollback.execute({ reason: '活验：无预授权拒绝' }, { callId: 'c3-live-1' }) } catch (e) { threw = e }
  check('应抛错', !!threw)
  const msg = threw?.message ?? ''
  check('文案含「回滚预授权缺失」', msg.includes('回滚预授权缺失'), msg.slice(0, 70))
  check('code = ROLLBACK_NO_PREAUTH', errCode(threw) === 'ROLLBACK_NO_PREAUTH', 'code=' + errCode(threw))
}

// 场景 2：有预授权 → 成功
console.log('\n[场景2] 有预授权 → 回滚成功 + rollback_at 落盘')
{
  writeFileSync(compliancePath, complianceBackup + 'rollback_preauth:\n  authorized: true\n', 'utf8')
  let r = null
  let threw = null
  try { r = await rollback.execute({ reason: '活验：部署出错紧急回滚' }, { callId: 'c3-live-2' }) } catch (e) { threw = e }
  check('应成功（不抛错）', !threw, threw ? String(threw.message).slice(0, 70) : '')
  check('preauthorized = true', r?.preauthorized === true)
  check('observation_hours = 24', r?.observation_hours === 24)
  check('rolled_back_to 以 rev- 开头', typeof r?.rolled_back_to === 'string' && r.rolled_back_to.startsWith('rev-'), r?.rolled_back_to)
  const s = readStateSync(statePath)
  check('state.rollback_at 已落盘', typeof s.rollback_at === 'string' && s.rollback_at !== '', 'rollback_at=' + s.rollback_at)
}

// 场景 3：观察期内重复回滚
console.log('\n[场景3] 观察期内重复回滚')
{
  let threw = null
  try { await rollback.execute({ reason: '再次回滚' }, { callId: 'c3-live-3' }) } catch (e) { threw = e }
  check('应抛错', !!threw)
  check('code = ROLLBACK_ALREADY_OBSERVING', errCode(threw) === 'ROLLBACK_ALREADY_OBSERVING', 'code=' + errCode(threw))
}

// 场景 4：观察期内推进冻结
console.log('\n[场景4] 观察期内 fde_phase_advance 冻结')
{
  let threw = null
  try { await advance.execute({ to: '11', reason: '观察期内推进' }, { callId: 'c3-live-4' }) } catch (e) { threw = e }
  check('应抛错', !!threw)
  check('code = ROLLBACK_OBSERVATION_ACTIVE', errCode(threw) === 'ROLLBACK_OBSERVATION_ACTIVE', 'code=' + errCode(threw))
}

// 复原
writeFileSync(compliancePath, complianceBackup, 'utf8')
writeFileSync(statePath, stateBackup, 'utf8')
const s2 = readStateSync(statePath)
console.log('\n[复原] compliance.yaml + state.yaml 已复原')
console.log('   state.rollback_at =', JSON.stringify(s2.rollback_at ?? null), ' revision =', s2.revision)
const restored = (s2.rollback_at ?? '') === '' && s2.revision === 60
check('复原干净（rollback_at 空 + revision 不变）', restored)

console.log('\nRESULT: ' + (fail === 0 ? 'ALL-PASS' : 'HAS-FAIL') + `（${ok} 通过 / ${fail} 失败）`)
process.exitCode = fail > 0 ? 1 : 0
