/**
 * _fde_memory_import_cover_test.mjs —— import 覆盖断言（0086 §3.2）
 *
 * 判据：lib/*.js 中，除 index.js 自身与显式例外名单外，每个文件都必须出现在
 * index.js 的 import 上（`from './<file>'`）。例外名单必须带理由注释。
 *
 * 坏样本自证（否则是恒绿断言）：去掉 config-schema.js 豁免 ⇒ 必须判出 config-schema.js 缺失。
 * config-schema.js 走动态 import（`import('./config-schema.js')`），因为它 import
 * `@deepseek-ai/schemastery`，离线测试环境没有（index.js 已写明）。
 *
 * 退出码 0 = 全绿；非 0 = 有失败。
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB_DIR = join(ROOT, 'dsh-fde-memory', 'lib')

// 例外名单（0086 §3.2）：config-schema.js 动态 import（import @deepseek-ai/schemastery，离线环境没有）。
const EXEMPT = ['config-schema.js']

const indexText = readFileSync(join(LIB_DIR, 'index.js'), 'utf8')
const libFiles = readdirSync(LIB_DIR).filter((f) => f.endsWith('.js'))

const PASS = []
const FAIL = []

function ok(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = expected === undefined ? undefined : JSON.stringify(expected)
  if (e === undefined || a === e) {
    PASS.push(name)
    console.log('  OK ' + name + (expected !== undefined ? ' => ' + a : ''))
  } else {
    FAIL.push({ name: name, actual: a, expected: e })
    console.log('  FAIL ' + name + ' => ' + a + ' (期望 ' + e + ')')
  }
}

/**
 * 沿 `index.js` 的**本地静态 import** 递归收集可达的 lib 文件。
 *
 * E2（2026-09-29）判据升级：原判据是"每个 lib 文件都出现在 **index.js** 的 import 上"。
 * 新增的 `experiments.js` 由 `tools.js` import（index.js 不直接用它的导出）⇒ 旧判据
 * 把它判成"缺失"。判据的**目的**是"没有写了没接线的孤儿模块"，而在 tools.js 也 import
 * 模块这个事实下，只看 index.js 一层**手段不够** ⇒ 手段升级为"装配链上出现过"。
 *
 * ⚠️ 这不是放宽：第 3 条的坏样本（`config-schema.js` 去掉豁免）在升级后**仍然判红** ——
 *    它既不在 index.js、也不在任何静态 import 链上（走的是 `import('./config-schema.js')`
 *    动态形态，本函数刻意只跟静态 `from`/`import` 两式）。
 */
function reachableLibs(startFile) {
  const seen = new Set()
  const queue = [startFile]
  while (queue.length > 0) {
    const f = queue.pop()
    if (seen.has(f)) continue
    seen.add(f)
    let text
    try {
      text = readFileSync(join(LIB_DIR, f), 'utf8')
    } catch {
      continue
    }
    for (const re of [/from '\.\/([^']+)'/g, /import '\.\/([^']+)'/g]) {
      for (const m of text.matchAll(re)) {
        if (m[1].endsWith('.js')) queue.push(m[1])
      }
    }
  }
  return seen
}

/** 返回「未出现在装配链上」的 lib 文件（不含 index.js 自身与豁免名单）。 */
function missingFiles(_startText, files, exempt) {
  const reachable = reachableLibs('index.js')
  const missing = []
  for (const f of files) {
    if (f === 'index.js') continue
    if (exempt.includes(f)) continue
    if (!reachable.has(f)) missing.push(f)
  }
  return missing
}

// ===== 1. 正常：EXEMPT 含 config-schema.js ⇒ 无缺失 =====
console.log('\n[import 覆盖]')
const missing = missingFiles(indexText, libFiles, EXEMPT)
ok('import 覆盖：名单外无缺失', missing.length, 0)
if (missing.length > 0) {
  console.log('  缺失文件：' + missing.join(', '))
}

// ===== 2. config-schema.js 动态 import 单独核（不在 from 检查里，但要证明它确实在图上）=====
ok("config-schema.js 动态 import 存在", indexText.includes(`import('./config-schema.js')`), true)

// ===== 3. 坏样本自证：去掉豁免 ⇒ 必须判出 config-schema.js 缺失 =====
const missingNoExempt = missingFiles(indexText, libFiles, [])
ok('坏样本：去掉豁免后 config-schema.js 判为缺失', missingNoExempt.includes('config-schema.js'), true)

// ===== 4. notes.js / tools.js 真进图（0086 §3.2 + §6.5）=====
ok("notes.js 进图（from './notes.js'）", indexText.includes(`from './notes.js'`), true)
ok("tools.js 进图（from './tools.js'）", indexText.includes(`from './tools.js'`), true)

// ===== 5. _LOADED_LIBS 含 6 个 notes 符号（0086 §3.2）=====
const loadedMatch = indexText.match(/const _LOADED_LIBS = \[([\s\S]*?)\]/)
const loadedText = loadedMatch ? loadedMatch[1] : ''
for (const sym of ['writeNote', 'readNote', 'listNotes', 'isExpired', 'annotateForInjection', 'reviewNote']) {
  ok(`_LOADED_LIBS 含 ${sym}`, loadedText.includes(sym), true)
}

// ===== 总结 =====
console.log('\n=== 总结 ===')
console.log('PASS ' + PASS.length + ' / FAIL ' + FAIL.length)
if (FAIL.length > 0) {
  console.log('FAILED:')
  for (const f of FAIL) console.log('  - ' + f.name + ': actual=' + f.actual + ' expected=' + f.expected)
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
