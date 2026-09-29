/**
 * P1-1 最小复现：**末行缺 seq 时 #seq 回落到 0** → 新记录从 seq=1 重开、与文件里已有的 seq=1 撞号。
 *
 * ⚠️ 必须**绕过 record() 直接写原始行**：修复后的 record() 会从入口剥掉调用方 seq 再盖章，
 *    用 record({seq: undefined}) 铺数据永远造不出缺 seq 的行，因此测不到这个洞
 *    （`_fde_phase_test.mjs` 里原来那两条分叉回归就是这种情况）。
 *
 * 跑法：
 *   node _audit_seq_reset_probe.mjs            # 默认打**已部署副本**（= 实际生效的那份代码）
 *   node _audit_seq_reset_probe.mjs deployed   # 同上，显式写
 *   node _audit_seq_reset_probe.mjs source     # 打工作区源码（仅用于"源已改、副本未同步"的对照）
 *   node _audit_seq_reset_probe.mjs <路径>      # 打任意一份 audit.js
 *
 * ⚠️ 默认为什么必须是 deployed：本探针的全部价值在于验证**实际生效的代码**。
 *    默认 source 会在"源已修、副本没同步"时给出假绿（补丁 2 提过、补丁 3 定案）。
 * ⚠️ 目标不可达时**硬失败 exit 2**，绝不静默回退到 source —— 静默回退本身就是第二条假绿路径。
 *
 *   退出码 0 = 未复现（已修复）；1 = 复现成功（有洞）；2 = 目标不可达/用法错误。
 *   结果写 `_audit_seq_reset_out.txt`（不走控制台，Windows 代码页乱码纪律）。
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18/dsh-fde-phase/lib/audit.js'
const DEPLOYED =
  'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/node_modules/dsh-fde-phase/lib/audit.js'
/** 审计回执落点：脚本所在目录（相对路径会随 CWD 漂走，曾导致读到上一轮的陈旧回执）。 */
const OUT_FILE = join(dirname(fileURLToPath(import.meta.url)), '_audit_seq_reset_out.txt')

// argv[2]：deployed(默认) | source | 绝对/相对自定义路径（用于拿旧版本做前后对照）
const arg = process.argv[2] ?? 'deployed'
const resolveTarget = () => {
  if (arg === 'source') return SRC
  if (arg === 'deployed') return DEPLOYED
  return arg
}
const target = resolveTarget()
let AuditChain
try {
  ;({ AuditChain } = await import(pathToFileURL(target).href))
} catch (e) {
  // 硬失败：目标不可达（沙箱 / DSH 未挂载 / 路径写错）时**绝不回退到 source**。
  // 回退会把"副本没同步"包装成"副本已修好"，正是本探针要防的假绿。
  const msg =
    `目标不可达，已中止（不回退到 source，避免假绿）：${target}\n` +
    `  原因：${e?.message ?? e}\n` +
    `  若确实要打源码请显式传：node _audit_seq_reset_probe.mjs source`
  writeFileSync(OUT_FILE, msg + '\n', 'utf8')
  console.log(msg)
  process.exit(2)
}

const p = join(mkdtempSync(join(tmpdir(), 'seqreset-')), 'audit.jsonl')
const link = (prev, rec) => createHash('sha256').update(prev).update('\n').update(JSON.stringify(rec)).digest('hex')
const G = '0'.repeat(64)

// 手工铺 3 行：seq 1、seq 2、末行**故意缺 seq**（模拟修复前落盘的历史 check-result）
const r1 = { seq: 1, ts: 't1', type: 'phase-advance' }
const h1 = link(G, r1)
const r2 = { seq: 2, ts: 't2', type: 'phase-advance' }
const h2 = link(h1, r2)
const legacy = { ts: 't3', type: 'check-result', check: 'D1', passed: true } // ← 无 seq（历史行）
const h3 = link(h2, legacy)
writeFileSync(
  p,
  JSON.stringify({ ...r1, prevHash: G, hash: h1 }) + '\n' +
    JSON.stringify({ ...r2, prevHash: h1, hash: h2 }) + '\n' +
    JSON.stringify({ ...legacy, prevHash: h2, hash: h3 }) + '\n'
)

// ⚠️ 必须**先取恢复态再 record** —— record 会把 count/head 一起推进，
//    顺序反了就拿记录后的值当"重启后"读数（本站踩过：count=3 / head=新记录 hash，误报分叉）。
const a = new AuditChain(p)
const restoredCount = a.count
const restoredHead = a.head
const r = await a.record({ type: 'phase-advance', from: '4', to: '5' })
await a.flush()

// ---- 判定：三条硬性质 ----
// ① 链头必须是真正的末行（否则与末行争抢 prevHash → 分叉）
const chainOk = restoredHead === h3
// ② 序号必须继承窗口内最大值 2，不得回落 0（回落 0 → 新记录从 1 重开、与已有 seq=1 撞号）
const seqRestored = restoredCount === 2
// ③ 新记录必须接续为 seq 3
const seqOk = r.seq === 3

const out = []
out.push(`目标：${target}`)
out.push(`历史行 seq: [1, 2, (缺)]，末行 hash=${h3.slice(0, 8)}…`)
out.push(`重启后（恢复态）count = ${restoredCount}   head = ${String(restoredHead).slice(0, 8)}…`)
out.push(`  → 链头 ${chainOk ? '✓ 落在真正末行（无分叉）' : '✗ 不在末行（分叉）'}`)
out.push(`  → 序号 ${seqRestored ? '✓ 继承 maxSeq=2' : `🔴 回落为 ${restoredCount}（应为 2）`}`)
out.push(`新记录 seq = ${r.seq}`)
out.push(`  → ${seqOk ? '✓ 续号为 3' : `🔴 回落到 ${r.seq} —— 文件里已有 seq=${r.seq}，撞号`}`)
const seqs = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l).seq)
out.push(`落盘后 seq 序列: ${JSON.stringify(seqs)}`)
const ok = chainOk && seqRestored && seqOk
out.push(ok ? 'RESULT: PASS（未复现，#seq 收尾正确）' : 'RESULT: FAIL（复现成功：#seq 收尾有洞）')

writeFileSync(OUT_FILE, out.join('\n') + '\n', 'utf8')
process.exitCode = ok ? 0 : 1
