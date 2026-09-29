/**
 * 部署前 smoke check：`cordis.patch.yml` 的 YAML 锚点 / 条目顺序 / 落点（0024 P1-6）
 *
 * 跑法：node _probe_yaml_anchor.mjs      ⇒ 全通过 exit 0，任一失败 exit 1
 *       （退出码敏感，可挂进部署流程：失败即停）
 *
 * 为什么要有这一道（0024 §4）：
 *   `loadOptionalPatches()`（@deepseek-ai/dsh-app-boot/lib/index.js:1104）的语义是
 *   "文件不存在 = 没有这一层，**解析失败一律抛**" ⇒ 配置写错的表现是 **DSH 起不来**（boot 期 fail loud）。
 *   那已经是"响亮失败"，但代价是运维在启动那一刻才挨一记。
 *   ⇒ 本脚本把它提前到**部署期**：一次解析就能在拷贝文件之前发现。
 *
 * 检查项（对活体文件）：
 *   ① 用 DSH **自家**的 js-yaml + `JSON_SCHEMA.extend(JsExpr)` 解析得通；
 *   ② gate 条目在 phase 条目**之前**（锚点必须定义在别名之前，否则 `unidentified alias` ⇒ boot 抛）；
 *   ③ `gate.protectedExtraRoots[0] === phase.projectRoot`（锚点真的同源，不是各写一遍）；
 *   ④ 落点存在：`protectedExtraRoots[0]` 是目录，且 `<projectRoot>/memory/state.yaml` 是文件
 *      —— 这一条专门防 0023 §2 那种"锚点挂错一层 ⇒ 静默错位"（当时会变成 `memory/memory/state.yaml`）。
 *
 * 自带可证伪性（不是"只会打印"）：
 *   末尾对三个合成样本断言**预期结果**（正常样本 ⇒ 通过；反序样本 ⇒ 必失败；错位样本 ⇒ 必失败）。
 *   若检查器对坏样本也说 OK ⇒ 脚本自己判红（exit 1）。
 *
 * 只读：不写 dsh-home 下任何文件；合成样本写在系统临时目录。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const lines = []
let failures = 0
const say = (s) => lines.push(s)

function expect(name, ok, extra = '') {
  if (ok) {
    say(`  ✓ ${name}`)
  } else {
    failures++
    say(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`)
  }
}

/**
 * 核心检查（活体文件与合成样本共用同一套判据）。
 *
 * @param {string} text YAML 文本
 * @param {{checkFs?: boolean}} opts - checkFs=false 时不校验"目录/文件真的存在"
 */
function checkPatchText(text, opts = {}) {
  const errors = []
  let parsed
  try {
    parsed = yaml.load(text, { schema })
  } catch (err) {
    return { ok: false, reason: `解析失败：${err.message.split('\n')[0]}`, gateIdx: -1, phaseIdx: -1 }
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: '顶层不是数组', gateIdx: -1, phaseIdx: -1 }
  }

  const entries = []
  for (const item of parsed) {
    if (Array.isArray(item?.insert)) entries.push(...item.insert)
  }
  const gateIdx = entries.findIndex((e) => e?.id === 'fde-ontology-gate')
  const phaseIdx = entries.findIndex((e) => e?.id === 'dsh-fde-phase')

  if (gateIdx < 0 || phaseIdx < 0) {
    return { ok: false, reason: `缺 fde 条目（gate=${gateIdx}, phase=${phaseIdx}）`, gateIdx, phaseIdx }
  }
  // ② 文档序：锚必须出现在别名之前
  if (gateIdx > phaseIdx) {
    errors.push(
      `条目顺序反了：phase(${phaseIdx}) 在 gate(${gateIdx}) 之前 ⇒ 别名引用不到锚点 ⇒ boot 抛 unidentified alias`
    )
  }

  const gateCfg = entries[gateIdx].config ?? {}
  const phaseCfg = entries[phaseIdx].config ?? {}
  const extraRoot = Array.isArray(gateCfg.protectedExtraRoots) ? gateCfg.protectedExtraRoots[0] : undefined
  const projectRoot = typeof phaseCfg.projectRoot === 'string' ? phaseCfg.projectRoot : undefined

  // ③ 锚点同源
  if (typeof extraRoot !== 'string' || extraRoot.length === 0) {
    errors.push('gate.protectedExtraRoots[0] 不是非空字符串（A2/A3 实际没被保护）')
  } else if (extraRoot !== projectRoot) {
    errors.push(
      `锚点不同源：protectedExtraRoots[0]=${JSON.stringify(extraRoot)} ≠ projectRoot=${JSON.stringify(projectRoot)}`
    )
  }

  // ④ 落点存在（防"锚点挂错一层"的静默错位）
  if (opts.checkFs !== false && typeof projectRoot === 'string') {
    if (typeof extraRoot === 'string' && (!existsSync(extraRoot) || !statSync(extraRoot).isDirectory())) {
      errors.push(`protectedExtraRoots[0] 不是存在的目录：${extraRoot}`)
    }
    const statePath = join(projectRoot, 'memory', 'state.yaml')
    if (!existsSync(statePath)) {
      errors.push(`落点错位：<projectRoot>/memory/state.yaml 不存在 ⇒ ${statePath}`)
    }
  }

  // ⑤ restrict 名单类配置：配了 ⇒ 每项必须 typeof 'string'（引号硬约束，施工单 §3.0.2 硬约束一）
  //
  // 为什么这一档要**并进本脚本**（0035 §7 提的待办，0037 §9 #5 又列了一次，本轮补上）：
  //   它会当场炸成 `fiberPhase: failed`，而**表现是"插件起不来"** ⇒ 排查会往错的地方找。
  //   原来只有 `_verify_batch2_config.mjs` / `_cc_config_restrict_check.mjs` 查它，
  //   而**每次改完 config 顺手跑的那支是这个 probe** ⇒ 它不查 ⇒ 等于闸装在了没人走的那扇门上。
  //   **守一个好的检查器，比守 N 条"记得跑那个脚本"的手动纪律便宜。**
  const NAME_LISTS = ['protectedPhases', 'denyTools']
  const nameLists = []
  const badNameLists = []
  for (const key of NAME_LISTS) {
    const v = phaseCfg?.[key]
    // 没配 ⇒ 落回插件默认值，本档不判（"是否显式写出"由调用方那条 expect 单独管）
    if (v === undefined) continue
    nameLists.push(key)
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) badNameLists.push(key)
  }

  return {
    ok: errors.length === 0,
    reason: errors.join('；'),
    gateIdx,
    phaseIdx,
    extraRoot,
    projectRoot,
    nameLists,
    badNameLists
  }
}

// ══════════ 1. 活体文件 ══════════
say('== 活体 cordis.patch.yml ==')
say(`     ${LIVE_PATCH}`)
try {
  const live = checkPatchText(readFileSync(LIVE_PATCH, 'utf8'), { checkFs: true })
  expect(
    '① 用 DSH 自家的 js-yaml + JSON_SCHEMA.extend(!!js) 解析得通',
    !/解析失败|顶层不是数组|缺 fde 条目/.test(live.reason ?? ''),
    live.reason
  )
  expect('② gate 条目在 phase 条目之前（锚点在别名之前）', live.gateIdx >= 0 && live.gateIdx < live.phaseIdx, `gate=${live.gateIdx} phase=${live.phaseIdx}`)
  expect(
    '③ 锚点同源：protectedExtraRoots[0] === projectRoot',
    typeof live.extraRoot === 'string' && live.extraRoot === live.projectRoot,
    `${JSON.stringify(live.extraRoot)} vs ${JSON.stringify(live.projectRoot)}`
  )
  expect('④ 落点存在：受保护根是目录且 <projectRoot>/memory/state.yaml 存在', live.ok, live.reason)
  say(`     protectedExtraRoots[0] = ${JSON.stringify(live.extraRoot)}`)
  expect(
    '⑤ restrict 名单类配置每项 typeof === "string"（🔴 引号硬约束）',
    live.badNameLists.length === 0,
    `不合格项 = ${JSON.stringify(live.badNameLists)}（写成 [4, 6, 10] ⇒ 解析成 number ⇒ 插件 failed）`
  )
  expect(
    '⑤ 这两项**显式**写在 config 里（缺 ⇒ 只剩默认值可依，不可复核 —— §3.0.2）',
    live.nameLists.length === 2,
    `实际见到 ${JSON.stringify(live.nameLists)}`
  )
  say(`     restrict 名单 = ${JSON.stringify(live.nameLists)}`)
} catch (err) {
  failures++
  say(`  ✗ 活体文件读不了：${err.message}`)
}

// ══════════ 2. 自带可证伪性：坏样本必须被判红 ══════════
say('')
say('== 自证：检查器对坏样本必须判红（否则本脚本自己失效） ==')

const tmp = mkdtempSync(join(tmpdir(), 'fde-patchsmoke-'))
const stateRoot = join(tmp, 'fde-state')
mkdirSync(join(stateRoot, 'memory'), { recursive: true })
writeFileSync(join(stateRoot, 'memory', 'state.yaml'), 'current_phase: "11"\n', 'utf8')

// 样本 A：正确（锚在 fde-state 这一层）
const SAMPLE_OK = `- insert:
    - id: fde-ontology-gate
      config:
        ontologyRoot: 'E:\\ontologyRoot'
        protectedExtraRoots: [ &fde_root '${stateRoot}' ]

    - id: dsh-fde-phase
      config:
        projectRoot: *fde_root
        # ⑤ 档要在样本里有货才能自证；引号故意写全（这是硬约束一要求的写法）
        protectedPhases: ['4', '6', '10']
        denyTools: ['pwsh']
`
// 样本 B：反序（别名在锚之前）
const SAMPLE_REVERSED = `- insert:
    - id: dsh-fde-phase
      config:
        projectRoot: *fde_root
    - id: fde-ontology-gate
      config:
        protectedExtraRoots: [ &fde_root '${stateRoot}' ]
`
// 样本 C：锚挂错一层（0023 §2 实测的那种静默错位 ⇒ memory/memory/state.yaml）
const SAMPLE_MISANCHORED = `- insert:
    - id: fde-ontology-gate
      config:
        protectedExtraRoots: [ &fde_root '${join(stateRoot, 'memory')}' ]

    - id: dsh-fde-phase
      config:
        projectRoot: *fde_root
`

const okCase = checkPatchText(SAMPLE_OK, { checkFs: true })
expect('样本 A（正确写法）⇒ 判通过', okCase.ok, okCase.reason)
expect('样本 A ⇒ ⑤ 判通过（否则 OK 样本就不合格，下面的 D 无从对照）', okCase.badNameLists.length === 0 && okCase.nameLists.length === 2, `bad=${JSON.stringify(okCase.badNameLists)} seen=${JSON.stringify(okCase.nameLists)}`)

// 样本 D：restrict 名单**去掉引号**（施工单 §3.0.2 点名"会当场炸"的那个坑）
const NO_QUOTE_ANCHOR = "protectedPhases: ['4', '6', '10']"
const SAMPLE_NO_QUOTE = SAMPLE_OK.replace(NO_QUOTE_ANCHOR, 'protectedPhases: [4, 6, 10]')
const noQuoteCase = checkPatchText(SAMPLE_NO_QUOTE, { checkFs: true })
expect(
  '样本 D（restrict 名单去引号）⇒ ⑤ 判**失败**（否则说明⑤没在检查）',
  SAMPLE_NO_QUOTE !== SAMPLE_OK && noQuoteCase.badNameLists.includes('protectedPhases'),
  `锚点命中=${SAMPLE_NO_QUOTE !== SAMPLE_OK} bad=${JSON.stringify(noQuoteCase.badNameLists)}`
)

const reversedCase = checkPatchText(SAMPLE_REVERSED, { checkFs: true })
expect('样本 B（条目反序）⇒ 判**失败**（否则说明②没在检查）', reversedCase.ok === false, `实际 ok=${reversedCase.ok}`)

const misCase = checkPatchText(SAMPLE_MISANCHORED, { checkFs: true })
expect('样本 C（锚挂错一层）⇒ 判**失败**（否则说明④没在检查）', misCase.ok === false, `实际 ok=${misCase.ok}`)
say(`     C 的落点：${JSON.stringify(join(String(misCase.projectRoot ?? ''), 'memory', 'state.yaml'))}`)

// ══════════ 2b. 决定性实验：⑤ 挡住的，是①~④**全通过**的东西 ══════════
//
// 0035 §7 的原话：**探针照样 PASS** —— 这句话必须能被复算，不能只留在回执里。
// 做法：拿**活体文本**当场改坏（去引号 + 塞一个 number），①用旧口径（①②③④）跑一遍 ⇒ 必须仍 PASS；
// ②用新口径（⑤）跑一遍 ⇒ 必须判红。两条同时成立，才证明 ⑤ 补的是一条真缝，而不是重复劳动。
const liveText = readFileSync(LIVE_PATCH, 'utf8')
const LIVE_E = liveText
  .replace("protectedPhases: ['4', '6', '10']", 'protectedPhases: [4, 6, 10]')
  .replace("denyTools: ['pwsh']", 'denyTools: [pwsh, 42]')
const anchorHit = LIVE_E !== liveText && LIVE_E.includes('[4, 6, 10]') && LIVE_E.includes('[pwsh, 42]')
const growthCase = checkPatchText(LIVE_E, { checkFs: true })
expect('样本 E 构造成功（两个锚点都命中）', anchorHit, '活体文件字面量变了 ⇒ 本实验失去对照意义，请更新锚点')
expect(
  '样本 E ⇒ 旧口径（①②③④）**照样 PASS** —— 印证 0035 §7「探针挡不住它」',
  growthCase.ok === true,
  `实际 ok=${growthCase.ok} reason=${growthCase.reason}`
)
expect(
  '样本 E ⇒ 新口径（⑤）**判红，且两项都抓到**',
  growthCase.badNameLists.length === 2,
  `实际 bad=${JSON.stringify(growthCase.badNameLists)}`
)
say(`     E 的实际后果：protectedPhases 解析出 number ⇒ config.js:104 normalizeNameList 抛 ⇒ 插件 failed`)

// ══════════ 3. 结论 ══════════
say('')
say(failures === 0 ? 'PATCH SMOKE OK（0 失败）' : `PATCH SMOKE FAILED（${failures} 失败）`)
console.log(lines.join('\n'))
process.exit(failures === 0 ? 0 : 1)
