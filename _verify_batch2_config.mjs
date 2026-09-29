/**
 * 第二批 · config 落点验收（活体文件，只读）
 *
 * 为什么单列一个脚本（而不是靠 _probe_yaml_anchor.mjs 顺带）：
 *   _probe_yaml_anchor.mjs 只管「锚点/顺序/落点」，它**不认识** protectedPhases / denyTools。
 *   而 §3.0.2 硬约束一（引号是硬要求）的判据落在**元素 typeof** 上——
 *   写成 [4, 6, 10] 时 YAML 照样解析得通、锚点照样同源、smoke 照样 OK，
 *   只有 typeof 是 number ⇒ normalizeNameList 抛 ⇒ 插件 failed。
 *   ⇒ 这是一条 smoke **覆盖不到**的失败模式，必须有自己的断言。
 *
 * 检查项：
 *   ① dsh-fde-phase.config.protectedPhases 存在、是数组、长度 3、每项 typeof === 'string'、值 = 4/6/10
 *   ② dsh-fde-phase.config.denyTools 存在、是数组、每项 typeof === 'string'、值 = 当前 profile 的期望名单
 *   ③ 其它必填项没被这次追加挤掉（projectRoot / ontologyRoot / mode / auditPath / gateAuditPath / lockTtlMs 仍在）
 *   ④ 反证（可证伪）：同一段配置换成 [4, 6, 10] 不带引号 ⇒ 每项 typeof === 'number'
 *      ——若反证不红，说明①在放空（恒真断言）
 *
 * ── 🔴 profile：为什么一个脚本两个期望值（不是"为了变绿改断言"）──────────────────
 *   施工单 §2.6：`bash` 是**判据 3 故意**塞进 denyTools 的未知名（验"点不上 ⇒ 跳过 + skipped 审计"），
 *   并明确要求**活验结束后把 denyTools 改回 `['pwsh']`**。
 *   ⇒ 于是 denyTools 有**两个合法态**，对同一份活体文件**不可能同时成立**：
 *
 *     profile=judge3  （判据 3 那一轮）    期望 ['pwsh','bash'] —— 故意的临时态
 *     profile=final   （§2.6 收尾 / 交付态）期望 ['pwsh']        —— 默认，bash 必须消失
 *
 *   ⇒ 两者互为对方的反证：把 final 期望拿去跑 judge3 态的文件必然红，反之亦然。
 *     这不是改断言迁就代码，而是**把两个都已拍板的口径各自固化**，且改值后旧口径仍能一键复跑。
 *   用法：node _verify_batch2_config.mjs [--profile judge3|final]（默认 final）
 *
 * 只读：不写 dsh-home 下任何文件。合成反证样本只在内存里。
 * 退出码：0 = 全过；1 = 有失败。
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const JSYAML = 'E:/DSH-desktop/DeepSeek Harness/data/node_modules/js-yaml/index.js'
const LIVE_PATCH = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/cordis.patch.yml'

const yaml = await import(pathToFileURL(JSYAML).href)
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data })
})
const schema = yaml.JSON_SCHEMA.extend(JsExpr)

let failures = 0
const out = []
function expect(name, ok, extra = '') {
  if (ok) out.push(`  ✓ ${name}`)
  else {
    failures++
    out.push(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`)
  }
}

/** 从 patch 文本里取 dsh-fde-phase 的 config（与 _probe_yaml_anchor.mjs 同一套取法）。 */
function phaseConfig(text) {
  const parsed = yaml.load(text, { schema })
  const entries = []
  for (const item of parsed ?? []) if (Array.isArray(item?.insert)) entries.push(...item.insert)
  return entries.find((e) => e?.id === 'dsh-fde-phase')?.config ?? null
}

// ══════════ profile：判据 3 轮 vs §2.6 交付态 ══════════
const PROFILES = {
  judge3: { denyTools: ['pwsh', 'bash'] },
  final: { denyTools: ['pwsh'] }
}
const argProfile = (process.argv.indexOf('--profile') >= 0 ? process.argv[process.argv.indexOf('--profile') + 1] : null) ?? process.env.FDE_CFG_PROFILE ?? 'final'
const PROFILE = Object.prototype.hasOwnProperty.call(PROFILES, argProfile) ? argProfile : null
if (PROFILE === null) {
  console.log(`✗ 未知 profile：${argProfile}（可用：${Object.keys(PROFILES).join(' | ')}）`)
  process.exit(1)
}
const EXPECT_DT = PROFILES[PROFILE].denyTools
// 判据 3 的临时未知名：只在 judge3 态被允许出现，final 态必须没有。
const TEMP_UNKNOWN = 'bash'

// ══════════ 活体文件 ══════════
out.push(`== 活体 cordis.patch.yml  [profile=${PROFILE}，期望 denyTools=${JSON.stringify(EXPECT_DT)}] ==`)
const text = readFileSync(LIVE_PATCH, 'utf8')
const cfg = phaseConfig(text)

expect('dsh-fde-phase 条目存在且有 config', cfg !== null && typeof cfg === 'object', `cfg=${JSON.stringify(cfg)?.slice(0, 120)}`)

// ① protectedPhases
const pp = cfg?.protectedPhases
expect(
  '① protectedPhases 是长度 3 的数组',
  Array.isArray(pp) && pp.length === 3,
  `实际 ${JSON.stringify(pp)}`
)
expect(
  '① protectedPhases 每项 typeof === "string"（🔴 引号硬要求）',
  Array.isArray(pp) && pp.length === 3 && pp.every((x) => typeof x === 'string'),
  `实际 types=${JSON.stringify((pp ?? []).map((x) => typeof x))}`
)
expect(
  "① protectedPhases 值 = ['4','6','10']",
  Array.isArray(pp) && pp.length === 3 && pp.join(',') === '4,6,10',
  `实际 ${JSON.stringify(pp)}`
)

// ② denyTools
const dt = cfg?.denyTools
expect('② denyTools 是数组且非空', Array.isArray(dt) && dt.length > 0, `实际 ${JSON.stringify(dt)}`)
expect(
  '② denyTools 每项 typeof === "string"',
  Array.isArray(dt) && dt.every((x) => typeof x === 'string'),
  `实际 types=${JSON.stringify((dt ?? []).map((x) => typeof x))}`
)
expect(
  `② denyTools 值 = ${JSON.stringify(EXPECT_DT)}（profile=${PROFILE}）`,
  Array.isArray(dt) && dt.join(',') === EXPECT_DT.join(','),
  `实际 ${JSON.stringify(dt)}`
)
if (PROFILE === 'final') {
  expect(
    `② §2.6 收尾：临时未知名 '${TEMP_UNKNOWN}' 已从 denyTools 移除（它只属于判据 3 那一轮）`,
    Array.isArray(dt) && !dt.includes(TEMP_UNKNOWN),
    `实际 ${JSON.stringify(dt)}`
  )
} else {
  expect(
    `② judge3 态：临时未知名 '${TEMP_UNKNOWN}' 必须还在（否则判据 3 的前提不成立）`,
    Array.isArray(dt) && dt.includes(TEMP_UNKNOWN),
    `实际 ${JSON.stringify(dt)}`
  )
}

// ③ 既有必填项仍在（防追加时挤掉/缩进错层）
for (const key of ['projectRoot', 'ontologyRoot', 'mode', 'auditPath', 'gateAuditPath', 'lockTtlMs']) {
  expect(`③ 既有项仍在：${key}`, cfg?.[key] !== undefined, `实际 undefined`)
}

// ══════════ 反证：不带引号必须解析成 number ══════════
out.push('')
out.push('== 反证：同一位置写 [4, 6, 10] 不带引号 ⇒ 必须解析成 number（否则①在放空）==')
const BAD = text.replace("protectedPhases: ['4', '6', '10']", 'protectedPhases: [4, 6, 10]')
expect('反证样本确实替换成功（锚点没漂移）', BAD !== text, '替换未命中 —— 活体文件里的字面量变了')
const badPp = phaseConfig(BAD)?.protectedPhases
expect(
  '④ 不带引号 ⇒ 每项 typeof === "number"（印证硬约束一）',
  Array.isArray(badPp) && badPp.length === 3 && badPp.every((x) => typeof x === 'number'),
  `实际 ${JSON.stringify(badPp)} types=${JSON.stringify((badPp ?? []).map((x) => typeof x))}`
)

out.push('')
out.push(failures === 0 ? 'BATCH2 CONFIG OK（0 失败）' : `BATCH2 CONFIG FAILED（${failures} 失败）`)
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
