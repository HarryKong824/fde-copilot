/**
 * 0066 §8 活验模拟 —— 用真实代码路径（guard.evaluate + runD5Check + D1Mirror）
 * 验证 D5 在 Phase 6→7 推进的 4 个场景：
 *   2. 不适用（industry='未声明' + 无 compliance.yaml）⇒ 放行
 *   3. 真拦（industry='medical-aesthetics' + 无 compliance.yaml）⇒ deny
 *   4. 放行（industry='medical-aesthetics' + 合法 compliance.yaml + mirror 有 D5 结论）⇒ 放行
 *   5. 反例（删一个键 + mirror 结论过期）⇒ deny
 * 6. 复原 state.yaml（保留 revision/updated_at 计数器）
 */
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const lib = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18/dsh-fde-phase/lib'
const guardUrl = pathToFileURL(lib + '/guard.js').href
const stateUrl = pathToFileURL(lib + '/state.js').href
const mirrorUrl = pathToFileURL(lib + '/mirror.js').href
const checkD5Url = pathToFileURL(lib + '/check-d5.js').href
const configUrl = pathToFileURL(lib + '/config.js').href
const auditUrl = pathToFileURL(lib + '/audit.js').href

const { evaluate } = await import(guardUrl)
const { readStateSync } = await import(stateUrl)
const mirrorMod = await import(mirrorUrl)
const { runD5Check } = await import(checkD5Url)
const { normalizeConfig } = await import(configUrl)
const { AuditChain } = await import(auditUrl)

const D1Mirror = mirrorMod.D1Mirror

const projectRoot = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state'
const ontologyRoot = 'E:/ontologyRoot'
const statePath = join(projectRoot, 'memory', 'state.yaml')
const compliancePath = join(ontologyRoot, 'compliance.yaml')
const auditPath = join(projectRoot, 'memory', 'phase-audit.jsonl')

const stateBackup = readFileSync(statePath, 'utf8')
console.log('== §8 活验模拟 ==')
console.log('state.yaml 备份：', stateBackup.trim())

function makeCfg(industry) {
  return normalizeConfig({
    projectRoot,
    ontologyRoot,
    mode: 'enforce',
    gateAuditPath: 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/gate.jsonl',
    industry
  })
}

function seedPhase6() {
  const cur = readStateSync(statePath)
  writeFileSync(statePath, 'schema_version: 1\ncurrent_phase: "6"\nphase_status: in_progress\nontology_version: ' + (cur.ontology_version ?? 1) + '\nrevision: ' + (cur.revision ?? 49) + '\nupdated_at: "' + (cur.updated_at ?? new Date().toISOString()) + '"\n', 'utf8')
}

function restoreState() {
  writeFileSync(statePath, stateBackup, 'utf8')
  console.log('  state.yaml 已复原')
}

const GOOD_YAML = 'schema_version: 1\noutput_boundary:\n  statement: "x"\nreview_chain:\n  reviewer: "Dr."\ndata_policy:\n  masking_rule: "m"\nchange_assessment:\n  classified: true\n  level: "L2"\n'

// ===== §8.2 验"不适用" =====
console.log('\n[§8.2 不适用：industry=未声明 + 无 compliance.yaml]')
{
  seedPhase6()
  const hadCompliance = existsSync(compliancePath)
  if (hadCompliance) unlinkSync(compliancePath)
  
  const cfg = makeCfg('未声明')
  const mirror = new D1Mirror()
  
  const exec = { name: 'fde_phase_advance', arguments: { to: '7', reason: '§8.2 不适用测试' } }
  const r = evaluate(exec, cfg, mirror)
  console.log('  deny:', r.deny ?? '(undefined=放行)')
  console.log('  checks:', JSON.stringify(r.checks))
  
  if (r.deny === undefined) {
    console.log('  ✓ 不适用场景放行（缺陷 A 修复生效）')
  } else {
    console.log('  ✗ 应放行但被拒')
  }
}

// ===== §8.3 验"真拦" =====
console.log('\n[§8.3 真拦：industry=medical-aesthetics + 无 compliance.yaml]')
{
  seedPhase6()
  if (existsSync(compliancePath)) unlinkSync(compliancePath)
  
  const cfg = makeCfg('medical-aesthetics')
  const mirror = new D1Mirror()
  
  const exec = { name: 'fde_phase_advance', arguments: { to: '7', reason: '§8.3 真拦测试' } }
  const r = evaluate(exec, cfg, mirror)
  console.log('  deny:', r.deny ? r.deny.slice(0, 80) + '...' : '(undefined=放行)')
  
  if (r.deny && r.deny.includes('compliance')) {
    console.log('  ✓ 真拦场景被拒（读 compliance.yaml 失败）')
  } else {
    console.log('  ✗ 应被拒但放行了')
  }
}

// ===== §8.4 验"放行" =====
console.log('\n[§8.4 放行：industry=medical-aesthetics + 合法 compliance.yaml + mirror 有 D5 结论]')
{
  seedPhase6()
  writeFileSync(compliancePath, GOOD_YAML, 'utf8')
  
  const cfg = makeCfg('medical-aesthetics')
  const mirror = new D1Mirror()
  
  const d5r = await runD5Check(compliancePath)
  console.log('  runD5Check.passed:', d5r.passed, 'nonemptyCount:', d5r.nonemptyCount)
  mirror.update({
    check: 'D5',
    passed: d5r.passed,
    anchor: {
      alg: 'compliance.yaml(sha256+len+nonempty)@v1',
      files: [compliancePath],
      sha256: d5r.sha256,
      len: d5r.lineCount,
      nonempty: d5r.nonemptyCount
    },
    at: new Date().toISOString()
  })
  
  const exec = { name: 'fde_phase_advance', arguments: { to: '7', reason: '§8.4 放行测试' } }
  const r = evaluate(exec, cfg, mirror)
  console.log('  deny:', r.deny ?? '(undefined=放行)')
  console.log('  checks:', JSON.stringify(r.checks))
  
  if (r.deny === undefined) {
    console.log('  ✓ 放行场景通过（D5 结论新鲜）')
  } else {
    console.log('  ✗ 应放行但被拒:', r.deny.slice(0, 80))
  }
}

// ===== §8.5 反例：删一个键 =====
console.log('\n[§8.5 反例：删 data_policy + mirror 结论过期]')
{
  seedPhase6()
  const badYaml = 'schema_version: 1\noutput_boundary:\n  statement: "x"\nreview_chain:\n  reviewer: "Dr."\nchange_assessment:\n  classified: true\n  level: "L2"\n'
  writeFileSync(compliancePath, badYaml, 'utf8')
  
  const cfg = makeCfg('medical-aesthetics')
  const mirror = new D1Mirror()
  
  const d5r = await runD5Check(compliancePath)
  console.log('  runD5Check.passed:', d5r.passed, 'failures:', d5r.failures.length)
  console.log('  failure codes:', d5r.failures.map(f => f.code).join(', '))
  
  mirror.update({
    check: 'D5',
    passed: d5r.passed,
    anchor: {
      alg: 'compliance.yaml(sha256+len+nonempty)@v1',
      files: [compliancePath],
      sha256: d5r.sha256,
      len: d5r.lineCount,
      nonempty: d5r.nonemptyCount
    },
    at: new Date().toISOString()
  })
  
  const exec = { name: 'fde_phase_advance', arguments: { to: '7', reason: '§8.5 反例测试' } }
  const r = evaluate(exec, cfg, mirror)
  console.log('  deny:', r.deny ? r.deny.slice(0, 80) + '...' : '(undefined=放行)')
  
  if (r.deny) {
    console.log('  ✓ 反例场景被拒（compliance.yaml 缺 data_policy）')
  } else {
    console.log('  ✗ 应被拒但放行了')
  }
}

// ===== §8.6 复原 =====
console.log('\n[§8.6 复原]')
{
  writeFileSync(compliancePath, GOOD_YAML, 'utf8')
  console.log('  compliance.yaml 已恢复为合法版本')
  
  restoreState()
  const final = readStateSync(statePath)
  console.log('  最终 state: current_phase=' + final.current_phase + ' revision=' + final.revision)
}

console.log('\n== §8 活验模拟结束 ==')
