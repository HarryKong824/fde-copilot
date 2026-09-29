/**
 * 工具面判红仪器 · 离线回归套件（P1-10，第 17 套）
 *
 * 断言的是 `_tool_surface_check.mjs` 的判定函数本身 —— 不是"它会跑"，而是
 * **它对坏样本会说红**。8 个 header 观测脚本之所以全族 fail-open，正是因为没有
 * 一个被这样断言过。
 *
 * 纪律：套件必须能被证伪（`FDE_INVERT=1` ⇒ 必须变红）。
 */
import { writeFileSync } from 'node:fs'
import {
  ABSENT,
  isEntryModule,
  judgeToolSurface,
  parseRequire,
  pickLastHeader,
  resolveTools,
  SAMPLES,
  PICK_SAMPLES,
  REQUIRE_SAMPLES
} from './_tool_surface_check.mjs'

const lines = []
let passed = 0
let failed = 0

function check(name, cond, detail) {
  if (cond) {
    passed++
    lines.push(`  ✅ ${name}`)
  } else {
    failed++
    lines.push(`  🔴 ${name}${detail === undefined ? '' : `  ← ${JSON.stringify(detail)}`}`)
  }
}

// 前置：被 import 的模块**不得**自作主张跑 main()/硬退出。
// 我曾在这里踩过一次（main() 无条件调 process.exit(0) ⇒ import 的瞬间测试进程以 0 退出，
// 一条断言都没跑却显示绿）—— 正是本套件要防的那个形状，换个位置又犯一次。
check(
  'import 本模块不会触发 main()（isEntryModule() === false）',
  isEntryModule() === false,
  isEntryModule()
)

lines.push('')
lines.push('A 组 · 合成样本：坏样本必须判红（自带可证伪）')
for (const s of SAMPLES) {
  const got = judgeToolSurface(s.data)
  check(
    `${s.id} ${s.desc} ⇒ ${s.expect.verdict}/n=${s.expect.n}/absent=${s.expect.absent}`,
    got.verdict === s.expect.verdict && got.n === s.expect.n && got.absent === s.expect.absent,
    got
  )
}

lines.push('')
lines.push('B 组 · 缺席与「真的 0」必须可区分（都红，但成因不同）')
const emptyArr = judgeToolSurface({ header: { tools: [] } })
const absentKey = judgeToolSurface({ header: { config: {} } })
check('两者都判红', emptyArr.verdict === 'red' && absentKey.verdict === 'red', { emptyArr: emptyArr.verdict, absentKey: absentKey.verdict })
check('tools=[] ⇒ absent=false', emptyArr.absent === false, emptyArr)
check('无 tools 键 ⇒ absent=true', absentKey.absent === true, absentKey)
check('resolveTools 对缺席返回 ABSENT 哨兵（不是 []）', resolveTools({}) === ABSENT && resolveTools({ header: {} }) === ABSENT)
check('resolveTools 对 [] 返回真数组（与 ABSENT 不同）', Array.isArray(resolveTools({ header: { tools: [] } })))
check('判定不抛异常（约束 ②：不靠 TypeError 崩）', (() => {
  const shapes = [null, undefined, 0, 'x', [], { header: null }, { header: 1 }, { tools: 'x' }]
  try {
    for (const s of shapes) judgeToolSurface(s)
    return true
  } catch {
    return false
  }
})())

lines.push('')
lines.push('C 组 · 取最后一条不许被"跳过"污染（`_cc_tool_list.mjs:25/28` 的坑）')
for (const p of PICK_SAMPLES) {
  const picked = pickLastHeader(p.events)
  const j = picked.found ? judgeToolSurface(picked.data) : { verdict: 'n/a', n: 0, absent: false }
  const ok =
    picked.found === p.expect.found &&
    (p.expect.verdict === undefined || j.verdict === p.expect.verdict) &&
    (p.expect.absent === undefined || j.absent === p.expect.absent) &&
    (p.expect.n === undefined || j.n === p.expect.n)
  check(`${p.id} ${p.desc}`, ok, { found: picked.found, ...j })
}
// 反向：若实现退化成"停在第一个有工具的"，P1 会误判绿 —— 上面 P1 已覆盖。
// 这里再钉一条更强的：最后一条是零工具时，**整条都不许被过滤掉**。
const mixed = [
  { type: 'request/header', data: { header: { tools: [{ name: 'a' }] } } },
  { type: 'request/header', data: { header: {} } },
  { type: 'request/header', data: { header: {} } }
]
const lastMixed = pickLastHeader(mixed)
check('多个尾随零工具 header ⇒ 仍取最后一条（不回退到有工具的那条）', lastMixed.found === true && judgeToolSurface(lastMixed.data).absent === true, lastMixed)

lines.push('')
lines.push('D 组 · 「够不够」是 opt-in（`n > 0` 不等于够用）')
for (const r of REQUIRE_SAMPLES) {
  const got = judgeToolSurface(r.data, { require: r.require })
  const ok =
    got.verdict === r.expect.verdict &&
    got.n === r.expect.n &&
    JSON.stringify(got.missing) === JSON.stringify(r.expect.missing)
  check(
    `${r.id} ${r.desc} ⇒ ${r.expect.verdict}/missing=${JSON.stringify(r.expect.missing)}`,
    ok,
    got
  )
}
check('parseRequire("--require=a,b") ⇒ [a,b]', JSON.stringify(parseRequire(['--require=a,b'])) === '["a","b"]')
check('parseRequire 无参数 ⇒ []（默认不设阈值）', JSON.stringify(parseRequire([])) === '[]')
check('不传 require 时 n=1 判绿（不擅自发明阈值）', judgeToolSurface({ header: { tools: [{ name: 'run_code' }] } }).verdict === 'ok')

lines.push('')
lines.push('E 组 · 文案本身（模型/人会读到它，不得自相矛盾）')
const rAbsent = judgeToolSurface({ header: {} })
const rEmpty = judgeToolSurface({ header: { tools: [] } })
check('缺席的 why 里明说"字段缺席即零工具"', rAbsent.why.includes('字段缺席'), rAbsent.why)
check('缺席的 why 里明说"不得判未知跳过"', /不得|绝不/.test(rAbsent.why), rAbsent.why)
check('空数组的 why 与缺席的 why **不是同一句**（诊断价值）', rEmpty.why !== rAbsent.why, { empty: rEmpty.why, absent: rAbsent.why })
check('判红文案非空（纪律：断言内容前先断言非空）', rAbsent.why.length > 10 && rEmpty.why.length > 10)

// 按纪律：套件必须能被证伪（FDE_INVERT=1 ⇒ 必须变红）
if (process.env.FDE_INVERT === '1') {
  check('[INVERT] 故意失败以验证退出码敏感', false, 'injected by FDE_INVERT')
}

lines.push('')
lines.push(`结果：${passed} 通过 / ${failed} 失败`)
lines.push(failed > 0 ? '状态：FAILED' : '状态：ALL GREEN')

// FDE_OUT（0030 §7）：跑轮次时显式给输出名 ⇒ 两轮不互相覆盖（缺省沿用原名）
writeFileSync(process.env.FDE_OUT ?? new URL('./_tool_surface_out.txt', import.meta.url), lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
process.exit(failed === 0 ? 0 : 1)
