/**
 * ⚠️ 这是**查看器，不是判红仪器**：本脚本 `continue` 掉工具数为 0 的 header（第 25 行）
 * 并在第一条**有工具**的 header 处 `break`（第 28 行）⇒ **零工具的 header 根本不会出现**。
 * ⇒ 若拿它执行"取最后一条 request/header 看工具数"，你看到的"最后一条"恒是有工具的那条
 *    ⇒ 假绿（0018 那个形状）。
 * ⇒ 要判红请用 `_tool_surface_check.mjs`（缺席判红 + 取真正的最后一条 + 自带可证伪样本）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { SESSION_ROOTS, sessionRootLabel } from './_tool_surface_check.mjs'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const pre = process.argv[2]
// P2-14：与判红仪器同一份根列表，不再各写一份（只扫 E 根 ⇒ C 根会话永远查不到）
console.log(`扫描范围（${SESSION_ROOTS.length} 个根）：${SESSION_ROOTS.map(sessionRootLabel).join(' , ')}`)
let d = null
let ROOT = null
for (const r of SESSION_ROOTS) {
  const hit = readdirSync(r).find((x) => x.includes(pre))
  if (hit) {
    d = hit
    ROOT = r
    break
  }
}
if (!d) {
  console.error(`找不到会话 ${pre}*（已扫 ${SESSION_ROOTS.length} 个根）`)
  process.exit(1)
}
const buf = readFileSync(`${ROOT}/${d}/session.jsonl.zstd`)
const offs = []; let i = 0
while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i++ }
const parts = []
for (const o of offs) { try { parts.push(zstdDecompressSync(buf.subarray(o))) } catch {} }
for (const l of Buffer.concat(parts).toString('utf8').split(/\r?\n/)) {
  if (!l.trim()) continue
  let e; try { e = JSON.parse(l) } catch { continue }
  if ((e.type ?? '') !== 'request/header') continue
  const dd = e.data ?? {}
  const tools = dd.header?.tools ?? dd.tools ?? []
  if (!Array.isArray(tools) || !tools.length) continue
  console.log(`── reason=${dd.reason}  工具数=${tools.length}`)
  tools.map((x) => x?.name ?? x?.function?.name ?? '?').sort().forEach((n) => console.log(`   ${n}`))
  break
}
