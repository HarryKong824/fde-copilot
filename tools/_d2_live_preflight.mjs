/**
 * ③ 活验的**离线预演**：用部署**真实 cfg** 跑 `guard.evaluate`，看现在差什么。
 * 只读 —— 不写任何状态、不碰审计链。目的是把"该出现什么"先写死（C28 教训：
 * 发活体指令前先自己跑一遍，把预期输出写进结论，而不是事后解释）。
 */
import { existsSync, statSync } from 'node:fs'
import { D1Mirror } from '../dsh-fde-phase/lib/mirror.js'
import { evaluate } from '../dsh-fde-phase/lib/guard.js'
import { readStateSync } from '../dsh-fde-phase/lib/state.js'
import { auditChainFingerprintSync } from '../dsh-fde-phase/lib/check-d2.js'

const D = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/'
const cfg = {
  projectRoot: 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state',
  ontologyRoot: 'E:/ontologyRoot',
  auditPath: D + 'phase.jsonl',
  gateAuditPath: D + 'gate.jsonl',
  mode: 'enforce',
  lockTtlMs: 30000
}

const st = readStateSync(cfg.projectRoot + '/memory/state.yaml')
console.log('state.current_phase =', JSON.stringify(st.current_phase), ' revision =', st.revision)

// gate 链基线指纹（活验全程必须不变 —— 变了说明有东西写了 gate 链，D2 锚点必然过期）
console.log('gate 链指纹 =', JSON.stringify(auditChainFingerprintSync(cfg.gateAuditPath)))
const lockPath = cfg.projectRoot + '/memory/.state.lock'
console.log('残留锁 =', existsSync(lockPath) ? `有（${statSync(lockPath).size} B）` : '无')

const m = new D1Mirror()
m.restoreSync(cfg.auditPath)
for (const c of ['D1', 'D2', 'D3']) {
  const x = m.get(c)
  console.log(
    `镜像 ${c}: ` +
      (x
        ? `passed=${x.passed} alg=${x.anchor?.alg} len=${x.anchor?.len} sha=${String(x.anchor?.sha256).slice(0, 12)} at=${x.at}`
        : '(无结论)')
  )
}

const r = evaluate(
  { name: 'fde_phase_advance', arguments: { to: '5', reason: 'preflight' } },
  cfg,
  m
)
console.log('\n--- evaluate(to="5") ---')
console.log('deny    =', r.deny ?? '(放行)')
console.log('checks  =', JSON.stringify(r.checks), ' skipped =', JSON.stringify(r.skipped))
