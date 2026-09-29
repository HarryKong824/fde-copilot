// 落盘失败场景回归：交错失败 ⇒ 磁盘链是否仍然连续（0010 §4）
// 运行：node _audit_writefail_test.mjs
//
// 背景：`AuditChain.record()` 在 appendFile 失败时把行塞进**内存** outbox，
// 但 `#head`（链头）**无条件前进**。若后续记录抢先写盘成功，磁盘上会出现
// `A → C` 而 `C.prevHash` 指向只存在于内存的 `HB` —— 悬空 prevHash（假断链）。
import { AuditChain } from '../dsh-fde-phase/lib/audit.js'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync, chmodSync, mkdtempSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('./_audit_writefail_out.txt', import.meta.url))
const lines = []
let passed = 0
let failed = 0

const t = async (name, fn) => {
  try {
    await fn()
    passed += 1
    lines.push(`  ✅ ${name}`)
  } catch (e) {
    failed += 1
    lines.push(`  ✗ ${name}\n      ${e.message}`)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const assertEq = (a, b, msg) => {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (sa !== sb) throw new Error(`${msg}（实际 ${sa}，期望 ${sb}）`)
}

const GENESIS = '0'.repeat(64)
const linkHash = (prevHash, record) =>
  createHash('sha256').update(prevHash).update('\n').update(JSON.stringify(record)).digest('hex')

/** 读磁盘上的有效记录行（按文件顺序）。 */
function diskLines(p) {
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/**
 * 校验磁盘上的链**自身连续**：seq 从 1 单调 +1，且第 i 行 prevHash === 第 i-1 行 hash。
 * 这是最朴素的读法（任何外部校验器都这么读）。返回错误列表，空数组 = 连续。
 */
function breaks(p) {
  const errs = []
  const ls = diskLines(p)
  let prev = GENESIS
  ls.forEach((line, i) => {
    if (line.seq !== i + 1) errs.push(`第 ${i + 1} 行 seq=${line.seq}（应 ${i + 1}）`)
    if (line.prevHash !== prev) errs.push(`第 ${i + 1} 行 prevHash 悬空/错位（期望 ${prev.slice(0, 8)}…）`)
    prev = line.hash
  })
  return errs
}

/** 临时文件 + 可控的写失败开关。 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fde-wf-'))
  const p = join(dir, 'phase.jsonl')
  // 先落一个空文件 ⇒ chmod 永远有目标（否则"全程失败"的用例里文件根本不会存在）。
  writeFileSync(p, '', 'utf8')
  const api = {
    path: p,
    /** `writable(false)` = 置只读 ⇒ `appendFile` 失败 EPERM（Windows 实测成立）。 */
    writable(v) {
      chmodSync(p, v ? 0o644 : 0o444)
    },
    cleanup() {
      try {
        chmodSync(p, 0o644)
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  }
  return api
}

lines.push('# 落盘失败 ⇒ 磁盘链连续性回归（`_audit_writefail_test.mjs`）')
lines.push('')

// ============================================================ 1. 交错失败
lines.push('## 1. 交错失败（写失败被后续成功记录跨过）')

await t('前置：正常写入是连续的（基线）', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ type: 'restrict', decision: 'restrict-applied' })
    await c.record({ type: 'restrict', decision: 'restrict-applied' })
    assertEq(breaks(f.path), [], '正常路径不得有断口')
    assertEq(c.pending, 0)
  } finally {
    f.cleanup()
  }
})

await t('前置：注入确实有效 —— 只读时 `persisted:false` 且进 outbox', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ type: 'restrict', decision: 'a' })
    f.writable(false)
    const r = await c.record({ type: 'restrict', decision: 'b' })
    assertEq(r.persisted, false, '只读 ⇒ 必须 persisted:false')
    assert(c.pending === 1, `只读 ⇒ pending 必须为 1，实际 ${c.pending}`)
  } finally {
    f.cleanup()
  }
})

await t('🔴 交错失败 ⇒ 磁盘链**不得出现悬空 prevHash / seq 跳号**', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ type: 'restrict', decision: 'A' }) // ✅
    f.writable(false)
    await c.record({ type: 'restrict', decision: 'B' }) // ❌ 进 outbox
    f.writable(true)
    await c.record({ type: 'restrict', decision: 'C' }) // ✅
    const errs = breaks(f.path)
    assertEq(
      errs,
      [],
      '磁盘上每条记录的 prevHash 必须在同一份磁盘数据里找得到 —— ' +
        'C 跨过 B 先落盘 ⇒ C.prevHash 指向只存在于内存的 HB，读者会误判篡改/损坏'
    )
  } finally {
    f.cleanup()
  }
})

await t('🔴 交错失败 + `flush()` ⇒ 磁盘上是 **A,B,C 顺序且连续**', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ type: 'restrict', decision: 'A' })
    f.writable(false)
    await c.record({ type: 'restrict', decision: 'B' })
    f.writable(true)
    await c.record({ type: 'restrict', decision: 'C' })
    await c.flush()
    const seen = diskLines(f.path).map((l) => l.decision)
    assertEq(seen, ['A', 'B', 'C'], 'flush 必须按原始顺序补齐，不得把 B 追加到 C 之后')
    assertEq(breaks(f.path), [], 'flush 之后必须完全连续')
    assertEq(c.pending, 0)
  } finally {
    f.cleanup()
  }
})

// ============================================================ 2. 反向（改前就该绿）
lines.push('')
lines.push('## 2. [反向] 不得改过的部分')

await t('连续失败（无交错）+ `flush()` ⇒ A,B,C 顺序且连续', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ type: 'restrict', decision: 'A' })
    f.writable(false)
    await c.record({ type: 'restrict', decision: 'B' })
    await c.record({ type: 'restrict', decision: 'C' })
    f.writable(true)
    await c.flush()
    assertEq(diskLines(f.path).map((l) => l.decision), ['A', 'B', 'C'])
    assertEq(breaks(f.path), [], '连续失败本就无害 ⇒ 这条改动前后都必须绿')
  } finally {
    f.cleanup()
  }
})

await t('失败期间 `pending` 诚实计数，`flush()` 后归零', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    f.writable(false)
    await c.record({ type: 'restrict', decision: 'A' })
    await c.record({ type: 'restrict', decision: 'B' })
    assert(c.pending >= 2, `两条都没落盘 ⇒ pending ≥ 2，实际 ${c.pending}`)
    f.writable(true)
    await c.flush()
    assertEq(c.pending, 0)
  } finally {
    f.cleanup()
  }
})

await t('`record()` 失败的 seq 仍然单调（不因排队而重号）', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    const r1 = await c.record({ type: 'restrict', decision: 'A' })
    f.writable(false)
    const r2 = await c.record({ type: 'restrict', decision: 'B' })
    const r3 = await c.record({ type: 'restrict', decision: 'C' })
    assertEq([r1.seq, r2.seq, r3.seq], [1, 2, 3], 'seq 不得因进 outbox 而复用')
    f.writable(true)
    await c.flush()
    const c2 = new AuditChain(f.path)
    const r4 = await c2.record({ type: 'restrict', decision: 'D' })
    assertEq(r4.seq, 4, '重启后必须从 4 续接')
  } finally {
    f.cleanup()
  }
})

// ============================================================ 收尾
lines.push('')
if (process.env.FDE_INVERT === '1') {
  try {
    assert(false, 'injected by FDE_INVERT')
  } catch (e) {
    failed += 1
    lines.push(`  ✗ [INVERT] ${e.message}`)
  }
}

lines.push(`通过 ${passed} / 失败 ${failed}`)
lines.push(failed > 0 ? 'RESULT: FAIL' : 'RESULT: PASS')
try {
  // FDE_OUT（0030 §7）：跑轮次时显式给输出名 ⇒ 两轮不互相覆盖（缺省沿用原名）
  writeFileSync(process.env.FDE_OUT ?? OUT, lines.join('\n') + '\n', 'utf8')
} catch {}
console.log(lines.join('\n'))
console.log(`[audit-writefail-test] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
