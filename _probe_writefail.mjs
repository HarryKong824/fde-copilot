// 探测：在 Windows 上如何稳定制造 appendFile 失败（用于构造"落盘失败"场景）
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'fde-fail-probe-'))

// --- 方式 1：把目标文件替换成同名目录 ⇒ append 到目录应失败 ---
const p1 = join(dir, 'v1.jsonl')
writeFileSync(p1, 'first\n', 'utf8')
rmSync(p1)
mkdirSync(p1)
let r1
try {
  appendFileSync(p1, 'second\n', 'utf8')
  r1 = 'NO_ERROR（方式1 无效）'
} catch (e) {
  r1 = `OK 失败 ${e.code}`
}
console.log('方式1 路径替换成目录 ⇒', r1)

// --- 方式 2：只读属性 ---
const p2 = join(dir, 'v2.jsonl')
writeFileSync(p2, 'first\n', 'utf8')
let r2
try {
  chmodSync(p2, 0o444)
  appendFileSync(p2, 'second\n', 'utf8')
  r2 = 'NO_ERROR（方式2 无效）'
} catch (e) {
  r2 = `OK 失败 ${e.code}`
} finally {
  try {
    chmodSync(p2, 0o644)
  } catch {}
}
console.log('方式2 只读属性 ⇒', r2)

// --- 方式 3：目录只读 ---
const d3 = join(dir, 'ro')
mkdirSync(d3)
const p3 = join(d3, 'v3.jsonl')
let r3
try {
  writeFileSync(p3, 'first\n', 'utf8')
  chmodSync(d3, 0o555)
  appendFileSync(p3, 'second\n', 'utf8')
  r3 = 'NO_ERROR（方式3 无效）'
} catch (e) {
  r3 = `OK 失败 ${e.code}`
} finally {
  try {
    chmodSync(d3, 0o755)
  } catch {}
}
console.log('方式3 目录只读 ⇒', r3)

console.log('existsSync(p1-dir)', existsSync(p1))
rmSync(dir, { recursive: true, force: true })
