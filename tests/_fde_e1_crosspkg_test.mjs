/**
 * E1 跨包"逐字副本"回归 —— `deny-ids.js` / `bg-mirror.js` 在两个插件里必须**逐字节相同**。
 *
 * 跑法：`node _fde_e1_crosspkg_test.mjs`
 *      故意验证退出码：`FDE_INVERT=1 node _fde_e1_crosspkg_test.mjs`
 *
 * 结果写 `_e1_crosspkg_out.txt`（不走控制台）。
 *
 * 🔴 **为什么需要这个文件**：架构约束是"插件之间不能 import"（0076 §3.3），
 *    跨包共享只能"照抄 + 机器对拍"（`linkHash` / `yamlsubset` 已有先例）。
 *    而**凡是靠人记住去同步的东西，迟早漂移** —— 尤其是这两份文件：
 *      · `bg-mirror.js` 的漂移会让"phase 放行、gate 不放行"（或反之），
 *        症状是"同一个门禁，两个插件给出不同结论"，而且**两边各自的单测都是绿的**；
 *      · `deny-ids.js` 的漂移会让"工具认为可绕、消费侧认为不可绕"（或反之）。
 *    ⇒ 用 sha256 把"两份必须一样"这句话变成一条会红的断言。
 *
 * ⚠️ 本文件**不**替代 `_deploy_diff.mjs`：那个管"源 ↔ 部署副本"（含 README），
 *    本文件管"phase 源 ↔ gate 源"。两者是**不同的域**，谁也盖不住谁。
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deepStrictEqual } from 'node:assert'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '_e1_crosspkg_out.txt')
const lines = []
let passed = 0
let failed = 0

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败')
}

function check(name, fn) {
  try {
    fn()
    passed += 1
    lines.push(`  ✓ ${name}`)
  } catch (e) {
    failed += 1
    lines.push(`  ✗ ${name}`)
    lines.push(`      ${e && e.message ? e.message : String(e)}`)
  }
}

/**
 * 必须逐字相同的文件清单。
 *
 * ⚠️ **加文件到这里 = 声明"它必须两边一致"**。反过来，任何**有意**两边不同
 * （例如 `break-glass.js` 只在 phase、gate 只持内存镜像）的文件**不得**进这张表 ——
 * 把它加进来只会逼着后来的人去消除一个**本来正确的**差异。
 */
const VERBATIM = ['deny-ids.js', 'bg-mirror.js']

const PHASE = join(HERE, '..', 'dsh-fde-phase', 'lib')
const GATE = join(HERE, '..', 'dsh-fde-ontology-gate', 'lib')

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

lines.push('== E1 跨包逐字副本对拍（phase 源 ↔ gate 源）==')
lines.push('')

for (const f of VERBATIM) {
  const a = join(PHASE, f)
  const b = join(GATE, f)

  check(`两份都存在：${f}`, () => {
    assert(existsSync(a), `缺 ${a}`)
    assert(existsSync(b), `缺 ${b}`)
  })

  check(`sha256 逐字相同：${f}`, () => {
    const ha = sha256(a)
    const hb = sha256(b)
    assert(
      ha === hb,
      `两份内容不同（这份漂移了，请同步后再跑）：\n        phase: ${ha}\n        gate : ${hb}\n` +
        `      同步命令：cp dsh-fde-phase/lib/${f} dsh-fde-ontology-gate/lib/${f}`
    )
  })
}

// ── 用**两个副本各自**算一遍同样的判定，结果必须一致 ──
// 上面比的是字节；这一段比的是**行为**。字节相同而行为不同只可能来自模块解析差异
// （例如相对 import 指到了不同的 `./audit.js`），而那种差异 sha256 看不出来。
lines.push('')
lines.push('[行为等价抽查]')

const phaseDeny = await import(pathToFileURL(join(PHASE, 'deny-ids.js')).href)
const gateDeny = await import(pathToFileURL(join(GATE, 'deny-ids.js')).href)
const phaseBg = await import(pathToFileURL(join(PHASE, 'bg-mirror.js')).href)
const gateBg = await import(pathToFileURL(join(GATE, 'bg-mirror.js')).href)

check('deny-ids 的导出名集合一致，且关键常量值一致', () => {
  const namesOf = (m) => Object.keys(m).sort()
  deepStrictEqual(namesOf(gateDeny), namesOf(phaseDeny), '导出名集合不同')
  deepStrictEqual([...gateDeny.BYPASSABLE_DENY_IDS], [...phaseDeny.BYPASSABLE_DENY_IDS])
  deepStrictEqual([...gateDeny.ANCHORED_DENY_IDS], [...phaseDeny.ANCHORED_DENY_IDS])
  assert(gateDeny.BYPASSABLE_DENY_IDS.includes('GATE-PATH'), 'GATE-PATH 应可绕')
  assert(!gateDeny.BYPASSABLE_DENY_IDS.includes('GATE-PTC'), 'GATE-PTC 不该可绕')
})

check('bg-mirror 的导出名集合一致', () => {
  const namesOf = (m) => Object.keys(m).sort()
  deepStrictEqual(namesOf(gateBg), namesOf(phaseBg), '导出名集合不同')
  deepStrictEqual(gateBg.BG_CHAIN_TYPES, phaseBg.BG_CHAIN_TYPES)
})

check('同一串输入喂给两份 BreakGlassMirror，放行判定一致', () => {
  const seq = [
    { id: 'a', denyId: 'D2', at: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' },
    { id: 'b', denyId: 'GATE-PTC', at: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' },
    { id: 'c', denyId: 'D1', at: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z', anchor: 'deadbeef' }
  ]
  const mk = (M) => {
    const bg = new M.BreakGlassMirror()
    for (const r of seq) bg.update(r)
    return bg
  }
  const p = mk(phaseBg)
  const g = mk(gateBg)
  const cases = [
    ['D2', undefined],
    ['GATE-PTC', undefined],
    ['D1', () => 'deadbeef'], // 锚点相符
    ['D1', () => 'other'], // 锚点不符
    ['D1', () => null], // 算不出锚点
    ['D9', undefined]
  ]
  for (const [id, fn] of cases) {
    assert(
      p.isBypassed(id, fn) === g.isBypassed(id, fn),
      `${id} 在两份实现里判定不同：phase=${p.isBypassed(id, fn)} gate=${g.isBypassed(id, fn)}`
    )
  }
  assert(p.isBypassed('D2', undefined) === true, '对照：D2 应放行（证明抽查不是全 false）')
  assert(p.openRecords().length === g.openRecords().length)
})

// ================================================================ 收尾
lines.push('')
if (process.env.FDE_INVERT === '1') {
  check('[INVERT] 故意失败以验证退出码敏感', () => assert(false, 'injected by FDE_INVERT'))
}

lines.push(`通过 ${passed} / 失败 ${failed}`)
lines.push(failed > 0 ? 'RESULT: FAIL' : 'RESULT: PASS')
writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')

console.log(`[e1-crosspkg] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
