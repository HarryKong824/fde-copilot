/**
 * dsh-fde-phase 接线回归（捕获 P0-1：fde/check-result 监听器被当场注销）。
 *
 * 为什么单独一个文件：本测试会 import 已部署的 index.js（拉真 SDK），离线纯逻辑测试
 * `_fde_phase_test.mjs` 故意不碰 SDK 依赖层。这里专测"apply 之后的接线是否正确"。
 *
 * 跑法（必须在已部署副本旁跑，才能解析到真 SDK）：
 *   node _fde_phase_wiring_test.mjs
 * 结果写 _phase_wiring_out.txt（不走控制台）。
 *
 * 🔴 关键：本测试桩忠实模拟 Cordis 的 effect 语义 —— cb() 的返回值若是函数，
 * 该函数被登记为"注销器"，且仅在 teardown 时调用。旧代码写成
 * `ctx.effect(() => disposeCheckResult(), ...)` 会在 apply 期当场把监听器注销，
 * 于是 checkResultCb 在 apply 后变成 null → 断言失败。修复后（去掉括号）监听器存活。
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// ══════════════════════════════════════════════════════════════════════
// ⚠️ 这套**不是纯离线套件**：它 import 的是**部署副本**，判的是部署副本的 effect 语义
//    （源 ↔ 副本是两回事）。没有那份部署的机器上跑不了 ⇒ **明确跳过**。
//    设 FDE_DSH_HOME 指向你的 dsh-home 即可跑；退出码 77 = 跳过（由 _run_all_tests.sh 计数）。
// ══════════════════════════════════════════════════════════════════════
const DSH_HOME = process.env.FDE_DSH_HOME ?? 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home'
const DEPLOYED = join(DSH_HOME, 'profiles/web/node_modules/dsh-fde-phase/lib/index.js')
if (!existsSync(DEPLOYED)) {
  const why = [
    `SKIP: 未找到已部署的 dsh-fde-phase（${DEPLOYED}）`,
    '  这套判的是**部署副本**的 effect 语义，没有部署就没有被测对象。',
    '  设 FDE_DSH_HOME 指向你的 dsh-home 后可跑；退出码 77 = 跳过。',
    '  ⚠️ 本文件是被**跳过**的结果，不要当成通过。',
  ].join('\n')
  // 覆盖旧产物：否则上次跑出来的"通过"会被当成这次的结果
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '_phase_wiring_out.txt'), why + '\n', 'utf8')
  console.log(why)
  process.exit(77)
}
const { apply } = await import(pathToFileURL(DEPLOYED).href)

// FDE_INVERT：故意把期望做反，验证本测试确实能抓 bug（手册 §8 第二条纪律）。
// 正常：监听器应存活（断言非 null）；INVERT：期望它已被注销（断言为 null）。
const INVERT = process.env.FDE_INVERT === '1'

// ---- 忠实模拟 Cordis 的 effect 语义 ----
const disposers = []
let checkResultCb = null
const fakeCtx = {
  on(name, cb) {
    if (name === 'fde/check-result') checkResultCb = cb
    return () => {
      if (name === 'fde/check-result') checkResultCb = null
    }
  },
  effect(fn) {
    const r = fn()
    if (typeof r === 'function') disposers.push(r) // 仅在 teardown 调用，apply 期不调用
    return r
  },
  emit() {},
  tools: {
    guard: () => () => {},
    register: () => () => {}
  },
  logger: { info() {}, warn() {}, error() {} }
}

const tmp = mkdtempSync(join(tmpdir(), 'fde-wire-'))
mkdirSync(join(tmp, 'memory'), { recursive: true })
writeFileSync(
  join(tmp, 'memory', 'state.yaml'),
  'schema_version: 1\ncurrent_phase: "0.1"\nphase_status: in_progress\nontology_version: 1\nrevision: 0\n'
)

let passed = 0
let failed = 0
const out = []
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

try {
  // gateAuditPath：Stage 5.5 起与 projectRoot / ontologyRoot 同为必填（D2 用）；
// 少了它 `apply()` 会在 normalizeConfig 里抛错 ⇒ 插件加载失败 ⇒ 这正是活体升级必须同步改
// cordis.patch.yml 的原因（见 phase README §5.1）。
apply(fakeCtx, {
  projectRoot: tmp,
  ontologyRoot: tmp,
  mode: 'enforce',
  auditPath: '',
  gateAuditPath: join(tmp, 'gate.jsonl'),
  lockTtlMs: 30000
})

  // P0-1 核心：apply 之后 check-result 监听器必须仍然活着（没被当场注销）
  if (INVERT) {
    // 故意做反：若 P0-1 仍潜伏（监听器被当场注销），这里应断言成功；修复后监听器存活 → 断言失败 → exit 1
    assert(checkResultCb === null, 'FDE_INVERT: 期望 bug 态（监听器已被注销）但实测存活 —— 测试可能假绿')
    passed++
    out.push('  ✓ FDE_INVERT: 已构造 bug 态断言（监听器为 null）')
  } else {
    assert(checkResultCb !== null, 'P0-1: fde/check-result 监听器被当场注销 —— 判据⑥⑦永远通过不了')

    // 触发一次，确认能进入回调体（且未抛）
    checkResultCb({
      check: 'D1',
      passed: true,
      anchor: {
        alg: 'sha256(actions+\u0000+guards)@v2',
        files: ['a', 'b'],
        sha256: createHash('sha256').update('x\u0000y').digest('hex')
      },
      detail: 'ok',
      at: new Date().toISOString()
    })
    passed++
    out.push('  ✓ P0-1: apply 后 check-result 监听器存活且可触发')
  }
} catch (e) {
  failed++
  out.push('  ✗ P0-1: ' + (e && e.message ? e.message : String(e)))
}

// teardown：调用收集到的注销器（模拟 Cordis dispose）
for (const d of disposers) {
  try {
    d()
  } catch {
    /* 忽略 */
  }
}

out.push('')
out.push(`通过 ${passed} / 失败 ${failed}`)
out.push(failed > 0 ? 'RESULT: FAIL' : 'RESULT: PASS')

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_phase_wiring_out.txt')
// FDE_OUT（0030 §7）：跑轮次时显式给输出名 ⇒ 两轮不互相覆盖（缺省沿用原名）
writeFileSync(process.env.FDE_OUT ?? OUT, out.join('\n') + '\n', 'utf8')
console.log(`[phase-wiring-test] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
