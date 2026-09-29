/**
 * 无模型探针：用**真** state.js + 真 restrict.js 验一条 fail-open ——
 * 「state.yaml 存在但内容坏」时，restrict 治理会不会**摘掉已挂的限制**。
 *
 * ⚠️⚠️ **本探针是 2026-09-25 修复前的取证快照，不能当作"修复与否"的验收仪器**（2026-09-25 注）。
 * 原因：下面第 31 行的 `currentPhaseLike()` 是**复刻**当时 `restrict.js:149-157` 的逐行逻辑、
 * 自己调 `readStateSync` 实现的 —— 它**没有**调用真实的 `RestrictGovernor.currentPhase()`。
 * 所以即便源码已改成严格读，本探针的 C / C2 仍会按老路径落成 OK —— **这不是"没修好"**。
 * 修复后的验收以 `_restrict_strictstate_test.mjs`（调用真 Governor）为准。
 * 保留本文件是为了让[C 文件存在但内容坏]这个缺口的存在史可追溯。
 *
 * 逻辑链（读码结论，这里把它跑成证据）：
 *   restrict.js:149 currentPhase()
 *     ├─ !existsSync(path) → null          ← 现有用例只覆盖这条
 *     └─ readStateSync(path)?.current_phase
 *          state.js:80  readStateSync 对**任何**读/解析失败都回落 DEFAULT_STATE
 *          （:84 与 :85 两条分支返回值**完全相同** ⇒ ENOENT 判断是死代码）
 *        → current_phase = '0.1'
 *   desiredDeny('0.1', 方案B) = []  ⇒  sync(agent, [], phase) ⇒ 摘掉限制
 *
 * 结论若为 HAS-FAIL/OBSERVED，即证明"坏 state.yaml 会静默解除保护"。
 */
import { writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STATE = './dsh-fde-phase/lib/state.js'
const RESTRICT = './dsh-fde-phase/lib/restrict.js'

const { readStateSync, DEFAULT_STATE } = await import(STATE)
const { desiredDeny } = await import(RESTRICT)

const CFG_B = { protectedPhases: ['4', '6', '10'], denyTools: ['pwsh'] }
const cases = []
const rec = (name, ok, detail) => cases.push({ name, ok, detail: String(detail) })

// 复刻 restrict.js:149-157 的 currentPhase() 逐行逻辑（用真的 readStateSync）
function currentPhaseLike(path) {
  try {
    if (!existsSync(path)) return null
    const v = readStateSync(path)?.current_phase
    return v === undefined || v === null ? null : String(v)
  } catch {
    return null
  }
}

const dir = mkdtempSync(join(tmpdir(), 'fde-failopen-'))

// ---------- A：基线——阶段 6（受保护，应挂 pwsh） ----------
const pProtected = join(dir, 'protected.yaml')
writeFileSync(pProtected, 'schema_version: 1\ncurrent_phase: "6"\nrevision: 3\n', 'utf8')
const phA = currentPhaseLike(pProtected)
rec(
  '基线：正常 state.yaml 读到 "6" 且 desiredDeny = ["pwsh"]',
  phA === '6' && JSON.stringify(desiredDeny(phA, CFG_B)) === '["pwsh"]',
  `phase=${phA} deny=${JSON.stringify(desiredDeny(phA, CFG_B))}`
)

// ---------- B：文件不存在（现有用例覆盖的那条） ----------
const pMissing = join(dir, 'nope', 'state.yaml')
rec(
  'B 文件不存在 → currentPhase 返回 null（走 existsSync 短路，fail-safe 生效）',
  currentPhaseLike(pMissing) === null,
  `phase=${JSON.stringify(currentPhaseLike(pMissing))}`
)

// ---------- C：文件存在但内容坏（现有用例**没**覆盖） ----------
const pCorrupt = join(dir, 'corrupt.yaml')
writeFileSync(pCorrupt, 'this is not yaml at all {{\n\tcurrent_phase: [unclosed\n', 'utf8')
const phC = currentPhaseLike(pCorrupt)
const denyC = desiredDeny(phC, CFG_B)
rec(
  'C 🔴 文件存在但内容坏 → 返回的不是 null 而是回落的 "0.1"',
  phC !== null,
  `phase=${JSON.stringify(phC)}（若为 "0.1" 即回落生效，not null）`
)
rec(
  'C2 🔴 于是 desiredDeny = []（**空名单 ⇒ 会摘掉已挂的限制**）',
  Array.isArray(denyC) && denyC.length === 0,
  `deny=${JSON.stringify(denyC)}`
)

// ---------- D：证明 readStateSync 两条分支返回值完全相同（ENOENT 判断是死代码） ----------
const a = JSON.stringify(readStateSync(pMissing))
const b = JSON.stringify(readStateSync(pCorrupt))
rec(
  'D readStateSync(不存在) 与 readStateSync(内容坏) 返回值完全相同 ⇒ ENOENT 分支是死代码',
  a === b,
  `不存在=${a.slice(0, 60)} 坏=${b.slice(0, 60)}`
)
rec(
  'D2 DEFAULT_STATE.current_phase 就是 "0.1"（非受保护）',
  DEFAULT_STATE.current_phase === '0.1',
  `DEFAULT_STATE.current_phase=${JSON.stringify(DEFAULT_STATE.current_phase)}`
)

// ---------- E：坏内容若"能解析但字段缺失"也应确认 ----------
const pPartial = join(dir, 'partial.yaml')
writeFileSync(pPartial, 'schema_version: 1\n', 'utf8') // 合法 yaml，但没有 current_phase
const phE = currentPhaseLike(pPartial)
rec(
  'E 合法但不含 current_phase → null（这条**是**安全的，走 v===undefined 分支）',
  phE === null,
  `phase=${JSON.stringify(phE)}`
)

const bad = cases.filter((c) => !c.ok)
const out = [
  '# 坏 state.yaml ⇒ 限制被摘（fail-open）证据',
  ...cases.map((c) => `${c.ok ? 'OK  ' : 'FAIL'} ${c.name}\n       → ${c.detail}`),
  '',
  `通过 ${cases.length - bad.length}/${cases.length}`,
  '',
  'C/C2 两条"OK"表示**缺口成立**（探针是在证实 fail-open 存在，不是在夸实现）。'
]
writeFileSync('_restrict_failopen_probe_out.txt', out.join('\n') + '\n', 'utf8')
console.log(out.join('\n'))
