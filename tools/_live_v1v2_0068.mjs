import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'

const ROOT = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18'
const phaseUrl = pathToFileURL(ROOT + '/dsh-fde-phase/lib/tools.js').href
const mirrorUrl = pathToFileURL(ROOT + '/dsh-fde-phase/lib/mirror.js').href
const { installPhaseTool } = await import(phaseUrl)
const { D1Mirror } = await import(mirrorUrl)

const STATE = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory/state.yaml'
const SNAP = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory/_snapshots/2026-09-28-pre-d5-live/state.yaml'

const cfg = {
  mode: 'enforce',
  projectRoot: 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state',
  ontologyRoot: 'E:/ontologyRoot',
  industry: '未声明',
  gateAuditPath: '',
  lockTtlMs: 5000
}

const auditLog = []
const audit = {
  async record(r) { auditLog.push(r); return { seq: auditLog.length } }
}

const mirror = new D1Mirror()

let toolRef = null
const ctx = {
  tools: {
    register(t) { toolRef = t; return () => {} }
  }
}

installPhaseTool(ctx, cfg, audit, mirror, null)

if (!toolRef) { console.error('FAIL: tool not registered'); process.exit(1) }
console.log('V0: tool registered name=' + toolRef.name)

const before = readFileSync(STATE, 'utf8')
console.log('V0 state.yaml BEFORE:'); console.log(before)

function sha(s) { return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex') }
const beforeSha = sha(before)

console.log('\n=== V2: to=8 (跳跃，期望被拒) ===')
try {
  await toolRef.execute({ to: '8', reason: 'V2 跳跃测试' }, { callId: 'V2', rootCallId: 'V2' })
  console.log('V2 FAIL: 应该 throw 却放行了')
} catch (e) {
  console.log('V2 OK: 被拒 — ' + e.message)
}

const afterV2 = readFileSync(STATE, 'utf8')
console.log('V2 state.yaml AFTER (应未变): current_phase=' + afterV2.match(/current_phase:\s*"?(\d+\.?\d*)"?/)?.[1])

console.log('\n=== V1: to=7 (缺陷A正面判据，期望放行 6→7) ===')
let v1Result = null
try {
  v1Result = await toolRef.execute({ to: '7', reason: 'V1 缺陷A正面判据活验' }, { callId: 'V1', rootCallId: 'V1' })
  console.log('V1 OK: 放行')
  console.log('  from=' + v1Result.from + ' to=' + v1Result.to + ' revision=' + v1Result.revision)
  console.log('  checks=' + JSON.stringify(v1Result.checks) + ' skipped=' + JSON.stringify(v1Result.skipped))
  console.log('  notApplicable=' + JSON.stringify(v1Result.notApplicable))
  if (v1Result.to !== '7' || v1Result.revision !== 50 || !Array.isArray(v1Result.notApplicable) || !v1Result.notApplicable.includes('D5')) {
    console.log('V1 FAIL: 判据不符')
  } else {
    console.log('V1 PASS: 缺陷A正面判据成立（6→7, rev 49→50, D5 notApplicable）')
  }
} catch (e) {
  console.log('V1 FAIL: 应该放行却 throw — ' + e.message)
}

const afterV1 = readFileSync(STATE, 'utf8')
console.log('V1 state.yaml AFTER: current_phase=' + afterV1.match(/current_phase:\s*"?(\d+\.?\d*)"?/)?.[1] + ' revision=' + afterV1.match(/revision:\s*(\d+)/)?.[1])

console.log('\n=== 复原 state.yaml（用核证人备份覆盖）===')
if (existsSync(SNAP)) {
  copyFileSync(SNAP, STATE)
  const restored = readFileSync(STATE, 'utf8')
  console.log('OK 复原完成')
  console.log('  current_phase=' + restored.match(/current_phase:\s*"?(\d+\.?\d*)"?/)?.[1] + ' revision=' + restored.match(/revision:\s*(\d+)/)?.[1])
  console.log('  sha16=' + sha(restored).slice(0, 16))
} else {
  console.log('FAIL 备份不存在: ' + SNAP)
}

console.log('\n=== audit 记录（V1+V2 期间）===')
for (const r of auditLog) {
  console.log(JSON.stringify(r))
}