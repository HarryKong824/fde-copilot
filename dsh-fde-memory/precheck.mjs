/**
 * 离线 precheck —— DSH 加载插件前的预检。
 *
 * A5 阶段串行跑九个套件：
 *   1. _fde_memory_import_cover_test.mjs（0086 §3.2 import 覆盖断言 + 坏样本自证）
 *   2. _fde_memory_test.mjs（A1 config/schema-version/index）
 *   3. _fde_memory_decisions_test.mjs（A2 confidence/decisions/照抄件等价 + §2 三条补丁）
 *   4. _fde_memory_a3_test.mjs（A3 checklist/stakeholders/maturity/change_log + assertPhaseId 双向 + §3.2 readRecentChanges {items,bad}）
 *   5. _fde_memory_a4_test.mjs（A4 notes + 过期降级 + slug 白名单 + confidence/expires_at 不可写）
 *   6. _fde_memory_a5_test.mjs（A5 分层注入 + 工具面：六层/封顶/注记双向/confidence 不可写）
 *   7. _fde_memory_session_audit_test.mjs（0077 审计外置 L1：脱敏真阳性 + 监听器不阻塞 + 链完整性）
 *   8. _fde_memory_source_test.mjs（0090 B1 source 防污染 + B2 confirm 工具三态）
 *   9. _fde_memory_e3_test.mjs（E3 schema 迁移失败降只读：写入 fail-closed / 读取照常）
 * 任一非 0 ⇒ 非 0 退出（让 fiber failed 显形）。
 *
 * ⚠️ 不要在循环里直接 process.exit —— 会让后续套件永不执行。
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const tests = [
  '_fde_memory_import_cover_test.mjs', // 放最前：最快，且是结构前提（0086 §9 拍定 4）
  '_fde_memory_test.mjs',
  '_fde_memory_decisions_test.mjs',
  '_fde_memory_a3_test.mjs',
  '_fde_memory_a4_test.mjs',
  '_fde_memory_a5_test.mjs',
  '_fde_memory_session_audit_test.mjs',
  '_fde_memory_source_test.mjs',
  '_fde_memory_e3_test.mjs'
]
let code = 0
for (const t of tests) {
  const testFile = resolve(process.cwd(), t)
  const r = spawnSync(process.execPath, [testFile], { stdio: 'inherit' })
  if (r.status !== 0) {
    code = r.status ?? 1
    break // 失败即停（后续套件不跑），但不要在循环里 process.exit
  }
}
process.exit(code)
