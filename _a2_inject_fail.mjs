/**
 * _a2_inject_fail.mjs —— A2 失败清理测试的子脚本（0079 §6 第 7 条）
 *
 * 由 _fde_memory_decisions_test.mjs 通过 spawnSync 调用，独立进程跑以隔离环境变量。
 *
 * 做法：
 *   1. 设 process.env.FDE_INJECT_WRITE_FAIL='1'（decisions.js 内置测试钩子）
 *      —— 实测 Node.js ESM-CJS interop 中 monkey-patch fs.writeFileSync 不影响
 *         ESM `import { writeFileSync } from 'node:fs'` 的 binding，故走环境变量钩子
 *   2. 调 writeDecision，期望抛 + final 已被 unlinkSync 清理
 *   3. 输出 JSON：{ err, emptyCount, allCount }
 *
 * decisions.js 的写盘流程（FDE_INJECT_WRITE_FAIL=1 时）：
 *   ① openSync(final, 'wx') 抢号 —— 留空文件
 *   ② 进入 try 块，钩子立即抛 "mock write fail: 注入测试"
 *   ③ catch 块：closeSync(tmpFd=null 跳过) + unlinkSync(tmpPath 不存在跳过) + unlinkSync(finalPath 生效)
 *   ④ 抛 "写盘失败（已清理）: mock write fail: 注入测试"
 *
 * 期望：writeDecision 抛 "写盘失败"；目录里无 6-*.yaml 拋留空 final。
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// 从**脚本自身位置**推导，不写作者本机路径 —— 否则换台机器 / CI 上必挂。
// 实测：CI 上 `_fde_memory_decisions_test.mjs` 的 §6.7 就是被这一行拖红的
//       （子脚本退出码非 0 ⇒ 父套件判红）。
const ROOT = process.env.FDE_TEST_ROOT ?? dirname(fileURLToPath(import.meta.url))

// 设测试钩子环境变量（在 import decisions.js 之前）
process.env.FDE_INJECT_WRITE_FAIL = '1'

// 加载 decisions
const decisionsUrl = pathToFileURL(ROOT + '/dsh-fde-memory/lib/decisions.js').href
const { writeDecision } = await import(decisionsUrl)

const tmpBase = mkdtempSync(join(tmpdir(), 'fde-mem-inject-'))
mkdirSync(join(tmpBase, 'memory', 'decisions'), { recursive: true })

let errCaught = null
try {
  writeDecision(tmpBase, { phase: '6', decision: '失败测试', source: 'fde_confirmed', approved_at: '2026-09-28T00:00:00Z', data_verified: true })
} catch (e) {
  errCaught = e
}

// 清掉钩子（让后续 readFileSync 正常）
delete process.env.FDE_INJECT_WRITE_FAIL

const dir = join(tmpBase, 'memory', 'decisions')
let emptyCount = 0
let allCount = 0
for (const f of readdirSync(dir)) {
  if (!f.startsWith('6-') || !f.endsWith('.yaml')) continue
  allCount++
  const sz = readFileSync(join(dir, f)).length
  if (sz === 0) emptyCount++
}

const result = {
  err: errCaught ? String(errCaught.message) : null,
  emptyCount: emptyCount,
  allCount: allCount
}
process.stdout.write(JSON.stringify(result))

rmSync(tmpBase, { recursive: true, force: true })
