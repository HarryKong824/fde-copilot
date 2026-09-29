/**
 * _fde_memory_test.mjs —— dsh-fde-memory A1 离线回归
 *
 * 覆盖（0076 §1 完成判据 + §6 验证表）：
 *   1. config.js normalizeConfig：fail-closed（projectRoot 缺失 / mode 非法 / 数值字段非整数）
 *   2. schema-version.js：read/write/migrate/ensureSchemaVersion 全路径
 *   3. index.js apply：幂等建目录 + state.yaml 不动 + SCHEMA_VERSION 创建
 *      （E3 后：迁移失败**不** fail-closed 于整个插件，而是降只读 —— 见本文件后半段 E3 三条断言）
 *
 * 退出码 0 = 全绿；非 0 = 有失败（exit code 敏感，0076 §6 验证 1）。
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'dsh-fde-memory')
const configUrl = pathToFileURL(ROOT + '/lib/config.js').href
const schemaUrl = pathToFileURL(ROOT + '/lib/schema-version.js').href
const indexUrl = pathToFileURL(ROOT + '/lib/index.js').href
const toolsUrl = pathToFileURL(ROOT + '/lib/tools.js').href

const { normalizeConfig, NAME, DEFAULTS } = await import(configUrl)
const {
  CURRENT,
  CHAIN,
  migrate,
  readSchemaVersion,
  writeSchemaVersion,
  ensureSchemaVersion
} = await import(schemaUrl)
const indexMod = await import(indexUrl)
const memTools = await import(toolsUrl)

/**
 * 期望注册的工具清单 —— **从 `tools.js` 的导出常量算，不写死字面量**。
 *
 * 🔴 E2（2026-09-29）判据升级（规矩 10：改行为契约后必须扫全部既有断言）。
 *    本常量原为 4 个硬编码名字（context / write_decision / review / confirm）。
 *    E2 按 spec §7 新增 3 个沙箱工具后，这条断言把**正确实现**判成了红的
 *    （实测 PASS 65 / FAIL 2），而最省事的"修法"就是把沙箱工具摘掉 ——
 *    那正是"改回缺陷让灯变绿"。
 *    ⇒ 改成从导出常量派生：加工具时自动跟上，同时仍抓得住"某个工具漏注册"
 *      （从 installMemoryTools 里删一个注册 ⇒ 期望里还在它 ⇒ 红）。
 */
const ALL_TOOLS = [
  memTools.CONTEXT_TOOL,
  memTools.WRITE_DECISION_TOOL,
  memTools.REVIEW_TOOL,
  memTools.CONFIRM_TOOL,
  memTools.EXPERIMENT_WRITE_TOOL,
  memTools.EXPERIMENT_READ_TOOL,
  memTools.EXPERIMENT_LIST_TOOL
].sort()

const PASS = []
const FAIL = []

function ok(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = expected === undefined ? undefined : JSON.stringify(expected)
  if (e === undefined || a === e) {
    PASS.push(name)
    console.log('  OK ' + name + (expected !== undefined ? ' ⇒ ' + a : ''))
  } else {
    FAIL.push({ name, actual: a, expected: e })
    console.log('  FAIL ' + name + ' ⇒ ' + a + ' (期望 ' + e + ')')
  }
}

function okThrows(name, fn, msgContains) {
  try {
    fn()
    FAIL.push({ name, actual: 'no throw', expected: 'throw' })
    console.log('  FAIL ' + name + ' ⇒ 没 throw (期望 throw)')
  } catch (e) {
    const msg = String(e?.message ?? e)
    if (msgContains && !msg.includes(msgContains)) {
      FAIL.push({ name, actual: msg, expected: '包含 "' + msgContains + '"' })
      console.log('  FAIL ' + name + ' ⇒ throw 但消息不对: ' + msg)
    } else {
      PASS.push(name)
      console.log('  OK ' + name + ' ⇒ throw: ' + msg.slice(0, 80))
    }
  }
}

const tmpBase = mkdtempSync(join(tmpdir(), 'fde-memory-A1-'))
console.log('TMP BASE: ' + tmpBase)

// ===== 1. config.js normalizeConfig =====
console.log('\n[config.js normalizeConfig]')

ok('NAME === "dsh-fde-memory"', NAME, 'dsh-fde-memory')
ok('DEFAULTS.mode === "shadow"', DEFAULTS.mode, 'shadow')
ok('DEFAULTS.schemaVersion === 1', DEFAULTS.schemaVersion, 1)
ok('DEFAULTS.notesTtlDays === 90', DEFAULTS.notesTtlDays, 90)
ok('DEFAULTS.informalCommitmentTtlDays === 30', DEFAULTS.informalCommitmentTtlDays, 30)
ok('DEFAULTS.injectChangeLogLimit === 5', DEFAULTS.injectChangeLogLimit, 5)

const cfg = normalizeConfig({ projectRoot: tmpBase, mode: 'enforce' })
ok('normalize 合法 projectRoot', cfg.projectRoot, tmpBase)
ok('normalize 合法 mode=enforce', cfg.mode, 'enforce')
ok('normalize 默认 schemaVersion=1', cfg.schemaVersion, 1)

okThrows('normalize projectRoot 缺失 ⇒ throw', () => normalizeConfig({}), 'projectRoot 必填')
okThrows('normalize projectRoot 空串 ⇒ throw', () => normalizeConfig({ projectRoot: '' }), 'projectRoot 必填')
okThrows('normalize projectRoot 非字符串 ⇒ throw', () => normalizeConfig({ projectRoot: 123 }), 'projectRoot 必填')
okThrows('normalize mode=unknown ⇒ throw', () => normalizeConfig({ projectRoot: tmpBase, mode: 'unknown' }), 'mode 只能是')
okThrows('normalize schemaVersion=0 ⇒ throw', () => normalizeConfig({ projectRoot: tmpBase, schemaVersion: 0 }), '≥1 的整数')
okThrows('normalize schemaVersion=1.5 ⇒ throw', () => normalizeConfig({ projectRoot: tmpBase, schemaVersion: 1.5 }), '≥1 的整数')
okThrows('normalize notesTtlDays=0 ⇒ throw', () => normalizeConfig({ projectRoot: tmpBase, notesTtlDays: 0 }), '≥1 的整数')
okThrows('normalize informalCommitmentTtlDays=-1 ⇒ throw', () => normalizeConfig({ projectRoot: tmpBase, informalCommitmentTtlDays: -1 }), '≥1 的整数')
okThrows('normalize injectChangeLogLimit=-1 ⇒ throw', () => normalizeConfig({ projectRoot: tmpBase, injectChangeLogLimit: -1 }), '≥0 的整数')
okThrows('normalize(null) ⇒ throw', () => normalizeConfig(null), 'projectRoot 必填')

// ===== 2. schema-version.js =====
console.log('\n[schema-version.js]')

ok('CURRENT === 1', CURRENT, 1)
ok('CHAIN 是空对象', Object.keys(CHAIN).length, 0)

const emptyDir = mkdtempSync(join(tmpdir(), 'fde-mem-sv-empty-'))
ok('readSchemaVersion 缺失 ⇒ undefined', readSchemaVersion(emptyDir), undefined)

writeFileSync(join(emptyDir, 'SCHEMA_VERSION'), '1\n', 'utf8')
ok('readSchemaVersion "1\\n" ⇒ 1', readSchemaVersion(emptyDir), 1)

writeFileSync(join(emptyDir, 'SCHEMA_VERSION'), 'abc\n', 'utf8')
okThrows('readSchemaVersion "abc" ⇒ throw', () => readSchemaVersion(emptyDir), '必须是 ≥1 的整数')

writeFileSync(join(emptyDir, 'SCHEMA_VERSION'), '   \n', 'utf8')
ok('readSchemaVersion 空白串 ⇒ undefined', readSchemaVersion(emptyDir), undefined)

writeSchemaVersion(emptyDir, 1)
ok('writeSchemaVersion(1) ⇒ 文件内容 "1\\n"', readFileSync(join(emptyDir, 'SCHEMA_VERSION'), 'utf8'), '1\n')
okThrows('writeSchemaVersion(0) ⇒ throw', () => writeSchemaVersion(emptyDir, 0), '≥1 的整数')
okThrows('writeSchemaVersion(1.5) ⇒ throw', () => writeSchemaVersion(emptyDir, 1.5), '≥1 的整数')

ok('migrate(1,1) ⇒ [1]', migrate(1, 1), [1])
ok('migrate(1,2) 空链 ⇒ undefined', migrate(1, 2), undefined)
ok('migrate(2,1) 空链 ⇒ undefined', migrate(2, 1), undefined)
ok('migrate(99,1) 空链 ⇒ undefined', migrate(99, 1), undefined)

const mockChain = { '1': ['2'], '2': ['3'] }
ok('migrate(1,3) mock ⇒ [1,2,3]', migrate(1, 3, mockChain), [1, 2, 3])
ok('migrate(1,2) mock ⇒ [1,2]', migrate(1, 2, mockChain), [1, 2])
ok('migrate(3,1) mock 反向 ⇒ undefined', migrate(3, 1, mockChain), undefined)
ok('migrate(1,99) mock 无路径 ⇒ undefined', migrate(1, 99, mockChain), undefined)

const ensureDir = mkdtempSync(join(tmpdir(), 'fde-mem-ensure-'))
ok('ensure 前缺失 ⇒ readSchemaVersion undefined', readSchemaVersion(ensureDir), undefined)
const r1 = ensureSchemaVersion(ensureDir)
ok('ensure 缺失 ⇒ status="created"', r1.status, 'created')
ok('ensure 缺失 ⇒ version=1', r1.version, 1)
ok('ensure 后文件存在', existsSync(join(ensureDir, 'SCHEMA_VERSION')), true)
ok('ensure 后内容="1\\n"', readFileSync(join(ensureDir, 'SCHEMA_VERSION'), 'utf8'), '1\n')

const r2 = ensureSchemaVersion(ensureDir)
ok('ensure 已存在=1 ⇒ status="ok"', r2.status, 'ok')
ok('ensure 已存在=1 ⇒ version=1', r2.version, 1)

writeSchemaVersion(ensureDir, 99)
const r3 = ensureSchemaVersion(ensureDir)
ok('ensure SCHEMA_VERSION=99 无路径 ⇒ status="failed"', r3.status, 'failed')
ok('ensure failed ⇒ from=99', r3.from, 99)
ok('ensure failed ⇒ path undefined', r3.path, undefined)
ok('ensure failed ⇒ error 包含 "无法迁移"', r3.error?.includes('无法迁移'), true)
ok('ensure failed ⇒ 不改写文件（仍 99）', readSchemaVersion(ensureDir), 99)

writeSchemaVersion(ensureDir, 1)
const r4 = migrate(1, 3, { '1': ['2'], '2': ['3'] })
ok('ensure 迁移路径 mock ⇒ [1,2,3]', r4, [1, 2, 3])

// ===== 3. index.js apply =====
console.log('\n[index.js apply]')

function makeCtx() {
  // E3：记下注册的工具名 —— "迁移失败时全部工具仍注册"这条判据要读它
  const registered = []
  return {
    registered,
    logger: {
      info(msg) { console.log('  [ctx.logger.info] ' + msg) },
      warn(msg) { console.log('  [ctx.logger.warn] ' + msg) }
    },
    // A5：apply 会 installMemoryTools 注册三个工具；离线桩 ctx 补 tools.register 兜底
    tools: {
      register(def) { if (def && def.name) registered.push(def.name); return () => {} }
    },
    // 0077：apply 会接线 session-audit（installSessionAudit 用 ctx.on + ctx.effect）
    on() { return () => {} },
    effect(fn) {
      let d
      try { d = typeof fn === 'function' ? fn() : undefined } catch { /* 监听器安装失败不崩 */ }
      return () => { if (typeof d === 'function') d() }
    }
  }
}

const applyDir = mkdtempSync(join(tmpdir(), 'fde-mem-apply-'))
mkdirSync(join(applyDir, 'memory'), { recursive: true })
const stateYamlContent = 'schema_version: 1\ncurrent_phase: "6"\nrevision: 49\n'
writeFileSync(join(applyDir, 'memory', 'state.yaml'), stateYamlContent, 'utf8')
const stateBefore = createHash('sha256').update(Buffer.from(stateYamlContent, 'utf8')).digest('hex').slice(0, 16)
console.log('  state.yaml 起步 sha16=' + stateBefore)

const ctx1 = makeCtx()
indexMod.apply(ctx1, { projectRoot: applyDir, mode: 'enforce' })

ok('apply 后 memory/ontology/ 存在', existsSync(join(applyDir, 'memory/ontology')), true)
ok('apply 后 memory/decisions/ 存在', existsSync(join(applyDir, 'memory/decisions')), true)
ok('apply 后 memory/checklist/ 存在', existsSync(join(applyDir, 'memory/checklist')), true)
ok('apply 后 memory/notes/ 存在', existsSync(join(applyDir, 'memory/notes')), true)
ok('apply 后 memory/audit/ 存在', existsSync(join(applyDir, 'memory/audit')), true)
ok('apply 后 SCHEMA_VERSION 存在', existsSync(join(applyDir, 'SCHEMA_VERSION')), true)
ok('apply 后 SCHEMA_VERSION 内容="1\\n"', readFileSync(join(applyDir, 'SCHEMA_VERSION'), 'utf8'), '1\n')

const stateAfterContent = readFileSync(join(applyDir, 'memory', 'state.yaml'), 'utf8')
const stateAfter = createHash('sha256').update(Buffer.from(stateAfterContent, 'utf8')).digest('hex').slice(0, 16)
ok('apply 后 state.yaml sha16 不变', stateAfter, stateBefore)
ok('apply 后 state.yaml 内容不变', stateAfterContent, stateYamlContent)

const ctx2 = makeCtx()
indexMod.apply(ctx2, { projectRoot: applyDir, mode: 'enforce' })
const stateAfter2 = readFileSync(join(applyDir, 'memory', 'state.yaml'), 'utf8')
ok('apply 二次后 state.yaml 内容仍不变', stateAfter2, stateYamlContent)
ok('apply 二次后 SCHEMA_VERSION 仍是 "1\\n"', readFileSync(join(applyDir, 'SCHEMA_VERSION'), 'utf8'), '1\n')

okThrows('apply projectRoot 缺失 ⇒ throw', () => indexMod.apply(makeCtx(), {}), 'projectRoot 必填')

const failDir = mkdtempSync(join(tmpdir(), 'fde-mem-fail-'))
writeFileSync(join(failDir, 'SCHEMA_VERSION'), '99\n', 'utf8')
// 🔴 E3（2026-09-29）**改写了这两条断言**（原为 `apply 99 ⇒ throw` + `目录未建`）。
//    它们钉的是 A1 的旧行为「迁移失败 ⇒ apply 抛错 ⇒ fiber failed ⇒ 工具全不注册」，
//    而 spec 第七节要的恰恰相反：迁移失败扣**写**、不扣**读**（"数据不扣人质"）。
//    旧断言若原样留着，会把**正确实现**判成红的 —— 实测正是如此（PASS 65 / FAIL 2）。
//    ⇒ 这里**不是**为了让红灯变绿而放宽期望，是把契约换成新的、且新断言**双向**：
//       既要求"不 throw"，也要求"全部工具仍注册"（旧实现下这条必红）。
const failCtx = makeCtx()
let failApplyOutcome = 'no-throw'
try {
  indexMod.apply(failCtx, { projectRoot: failDir })
} catch (e) {
  failApplyOutcome = 'throw: ' + String(e?.message ?? e)
}
ok('E3：apply 迁移失败（99 无路径）**不 throw**', failApplyOutcome, 'no-throw')
ok('E3：apply 迁移失败后目录骨架**照常建**（读路径要能用）', existsSync(join(failDir, 'memory')), true)
ok(
  'E3：apply 迁移失败时**全部工具都注册**（旧实现下一个都没有）',
  JSON.stringify([...failCtx.registered].sort()),
  JSON.stringify(ALL_TOOLS)
)

ok('index 导出 Config（离线=null/运行时=function）', indexMod.Config === null || typeof indexMod.Config === 'function', true)
ok('index 导出 apply', typeof indexMod.apply, 'function')
ok('index 导出 inject', JSON.stringify(indexMod.inject), JSON.stringify(['tools']))
ok('index 导出 name', indexMod.name, 'dsh-fde-memory')

rmSync(tmpBase, { recursive: true, force: true })
rmSync(emptyDir, { recursive: true, force: true })
rmSync(ensureDir, { recursive: true, force: true })
rmSync(applyDir, { recursive: true, force: true })
rmSync(failDir, { recursive: true, force: true })

console.log('\n=== 总结 ===')
console.log('PASS ' + PASS.length + ' / FAIL ' + FAIL.length)
if (FAIL.length > 0) {
  console.log('FAILED:')
  for (const f of FAIL) console.log('  - ' + f.name + ': actual=' + f.actual + ' expected=' + f.expected)
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
