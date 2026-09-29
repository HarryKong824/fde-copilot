/**
 * 对**已部署**的 guard.js / mirror.js 直接探测 —— 绕过模型、绕过 DSH 会话，直接喂假 exec。
 * 验的是"判定函数本身"（DSH 接线由 pluginInventory 的 active + 活体端到端证明）。
 *
 * v2 锚点形态：{ alg:'sha256(actions+\u0000+guards)@v2', files:[actions,guards], sha256:<复合> }
 *
 * 输出走文件（Windows 代码页乱码规避）。
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const DEPLOY = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/node_modules/dsh-fde-phase/lib'
const { evaluate } = await import(`file:///${DEPLOY}/guard.js`)
const { D1Mirror, ANCHOR_ALG } = await import(`file:///${DEPLOY}/mirror.js`)
const { writeState } = await import(`file:///${DEPLOY}/state.js`)

const projectRoot = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state'
const ontologyRoot = 'E:/ontologyRoot'
const cfg = { projectRoot, ontologyRoot, auditPath: '', mode: 'enforce', lockTtlMs: 30000 }
const statePath = join(projectRoot, 'memory', 'state.yaml')
const lockPath = join(projectRoot, 'memory', '.state.lock')
const actionsPath = join(ontologyRoot, 'actions.yaml')
const guardsPath = join(ontologyRoot, 'guards.yaml')

const seed = (phase) => writeState(statePath, lockPath, (c) => ({ ...c, current_phase: phase }), 30000, null)
const run = (to) => evaluate({ name: 'fde_phase_advance', arguments: { to } }, cfg, new D1Mirror())
const withAnchor = (anchor, passed = true) => {
  const m = new D1Mirror()
  m.update({ check: 'D1', passed, anchor, at: 'probe' })
  return (to) => evaluate({ name: 'fde_phase_advance', arguments: { to } }, cfg, m)
}

const aText = readFileSync(actionsPath, 'utf8')
const gText = readFileSync(guardsPath, 'utf8')
const sha = (s) => createHash('sha256').update(s).digest('hex')
const FRESH = { alg: ANCHOR_ALG, files: [actionsPath, guardsPath], sha256: sha(aText + '\u0000' + gText) }
const STALE_ACTIONS = { ...FRESH, sha256: sha(aText + '\n# tampered\n' + '\u0000' + gText) }
const STALE_GUARDS = { ...FRESH, sha256: sha(aText + '\u0000' + gText + '\n# tampered\n') }
const LEGACY = { file: actionsPath, sha256: sha(aText) }              // P1-1 之前的旧形态
const NO_ALG = { files: [actionsPath, guardsPath], sha256: FRESH.sha256 } // 有 files 但缺 alg

const cases = []
const rec = (name, wantDeny, got) => {
  const denied = got.deny !== undefined
  cases.push({ name, wantDeny, ok: denied === wantDeny, detail: got.deny ?? '(放行)' })
}

await seed('3')
rec('A 无结论 → 应 deny', true, run('4'))

await seed('3')
rec('B 新鲜 v2 锚点（两文件都匹配）→ 应放行', false, withAnchor(FRESH)('4'))

rec('C actions.yaml 已改（复合哈希失配）→ 应 deny', true, withAnchor(STALE_ACTIONS)('4'))
rec('D guards.yaml 已改（复合哈希失配）→ 应 deny', true, withAnchor(STALE_GUARDS)('4'))
rec('E 旧形态锚点（仅 file/sha256，无 alg）→ 应 deny', true, withAnchor(LEGACY)('4'))
rec('F 有 files 但缺 alg → 应 deny', true, withAnchor(NO_ALG)('4'))
rec('G 结论为未通过 → 应 deny', true, withAnchor(FRESH, false)('4'))

await seed('1')
rec('H 跳跃 (1→5) → 应 deny', true, withAnchor(FRESH)('5'))

await seed('0.1')
rec('I 无门禁阶段 (0.1→0.2) → 应放行', false, run('0.2'))

await seed('11')
rec('J 末阶段 (11) → 应 deny', true, run('11'))

await seed('3')
rec('K 非 fde_phase_advance 工具 → 应放行', false,
  evaluate({ name: 'fde_ontology_write', arguments: {} }, cfg, new D1Mirror()))
rec('L 目标阶段为空/未知 (to=9) → 应 deny', true, withAnchor(FRESH)('9'))

const failed = cases.filter((c) => !c.ok)
const out = [
  ...cases.map((c) => `${c.ok ? 'OK  ' : 'FAIL'} ${c.name}\n       → ${c.detail}`),
  '',
  `通过 ${cases.length - failed.length}/${cases.length}`,
  `RESULT: ${failed.length === 0 ? 'ALL-PASS' : 'HAS-FAIL'}`
]
writeFileSync('_guard_probe_out.txt', out.join('\n') + '\n', 'utf8')
process.exitCode = failed.length === 0 ? 0 : 1
