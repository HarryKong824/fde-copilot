// gate 插件 `AuditChain` 回归：与 phase 那份同源，但缺三处已修 objednání（0011 §3）
// 运行：node _audit_gate_test.mjs
//
// 0011 §3 裁定：gate 该修，Claude 列了**两处**：
//   ① `#degraded` 排队闸（假断链）—— phase 2026-09-26 补丁 3 已修，gate 无；
//   ② `record()` 的 seq 剥离防御（P2-3）—— phase 有，gate 无。
// 我在逐行对照时发现**第三处**（见 0011-reply §4）：恢复端的两遍取 ——
//   ③ 恢复时「链头」与「seq 起点」必须**分两遍取**：链头只认 hash（不强制 seq），
//      seq 取窗口内最大值。gate 仍是单遍且要求 seq ⇒ 末行缺 seq 时会被跳过 ⇒ 真分叉。
//
// 纪律：改 lib/ 之前先跑本文件，①② ③ 的正向用例必须是红的。
import { AuditChain } from './dsh-fde-ontology-gate/lib/audit.js'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync, chmodSync, mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('./_audit_gate_out.txt', import.meta.url))
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
 * 最朴素的外部校验器读法：seq 从 1 单调 +1，且第 i 行 prevHash === 第 i-1 行 hash。
 * 返回错误列表；空数组 = 连续。
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

/**
 * **只校验 prevHash 链接**（不管 seq 编号）。
 * 用途：老格式/别的写入方写下的记录可能没有 seq，那种行不能算断口 ——
 * 判断它是否被正确接续，**只看下一条的 prevHash 是不是它的 hash**。
 */
function linksOnly(p) {
  const errs = []
  const ls = diskLines(p)
  let prev = GENESIS
  ls.forEach((line, i) => {
    if (line.prevHash !== prev) errs.push(`第 ${i + 1} 行 prevHash 悬空/错位（期望 ${prev.slice(0, 8)}…）`)
    prev = line.hash
  })
  return errs
}

/** 同父检测：同一 prevHash 被两条记录引用 ⇒ 真分叉（不是"顺序反了"）。 */
function forks(p) {
  const seen = new Map()
  const errs = []
  for (const l of diskLines(p)) {
    if (seen.has(l.prevHash)) errs.push(`prevHash ${String(l.prevHash).slice(0, 8)}… 被两条记录引用 ⇒ 分叉`)
    seen.set(l.prevHash, true)
  }
  return errs
}

/** 临时文件 + 可控写失败开关（Windows 实测：文件 chmod 0o444 ⇒ appendFile EPERM）。 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fde-gate-'))
  const p = join(dir, 'gate.jsonl')
  writeFileSync(p, '', 'utf8')
  return {
    path: p,
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
}

/** 手工构造一条链（可指定某条不给 seq，模拟老格式/别的写入方）。 */
function writeRaw(p, records) {
  let prev = GENESIS
  const out = []
  for (const rec of records) {
    const hash = linkHash(prev, rec)
    out.push(JSON.stringify({ ...rec, prevHash: prev, hash }))
    prev = hash
  }
  writeFileSync(p, out.join('\n') + '\n', 'utf8')
  return prev
}

lines.push('# gate `AuditChain` 回归（`_audit_gate_test.mjs`，0011 §3）')
lines.push('')

// ==================================================== 1. ① `#degraded` 排队闸
lines.push('## 1. ① 落盘失败 ⇒ 磁盘链不得出现假断链')

await t('前置：注入有效 —— 只读时 `persisted:false` 且进 outbox', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ decision: 'a' })
    f.writable(false)
    const r = await c.record({ decision: 'b' })
    assertEq(r.persisted, false, '只读 ⇒ 必须 persisted:false')
    assert(c.pending === 1, `只读 ⇒ pending 必须为 1，实际 ${c.pending}`)
  } finally {
    f.cleanup()
  }
})

await t('🔴 交错失败 ⇒ 磁盘链不得出现悬空 prevHash / seq 跳号', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ decision: 'A' }) // ✅
    f.writable(false)
    await c.record({ decision: 'B' }) // ❌ 进 outbox
    f.writable(true)
    await c.record({ decision: 'C' }) // ✅
    assertEq(breaks(f.path), [], 'C 不得跨过内存里的 B 抢先落盘（读者会误判篡改/损坏）')
    assertEq(forks(f.path), [], '且不得出现同父双记录')
  } finally {
    f.cleanup()
  }
})

await t('🔴 交错失败 + `flush()` ⇒ 磁盘上是 **A,B,C 原序且连续**', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ decision: 'A' })
    f.writable(false)
    await c.record({ decision: 'B' })
    f.writable(true)
    await c.record({ decision: 'C' })
    await c.flush()
    assertEq(diskLines(f.path).map((l) => l.decision), ['A', 'B', 'C'], 'flush 必须按原序补齐')
    assertEq(breaks(f.path), [], 'flush 之后必须完全连续')
    assertEq(c.pending, 0)
  } finally {
    f.cleanup()
  }
})

await t('🔴 失败期间到达的记录必须一并排队（不得抢先写盘）⇒ flush 后连续', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ decision: 'A' })
    f.writable(false)
    await c.record({ decision: 'B' })
    await c.record({ decision: 'C' }) // 仍在失败期 ⇒ 必须与 B 一起排队
    f.writable(true)
    await c.flush()
    assertEq(diskLines(f.path).map((l) => l.decision), ['A', 'B', 'C'])
    assertEq(breaks(f.path), [])
  } finally {
    f.cleanup()
  }
})

// ==================================================== 2. ② seq 剥离
lines.push('')
lines.push('## 2. ② `record()` 不得让调用方注入 seq')

await t('🔴 `record({ seq: undefined })` ⇒ 落盘记录仍必须有整型 seq', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    const r = await c.record({ seq: undefined, decision: 'A' })
    assertEq(r.seq, 1, '返回值不得是 undefined')
    assertEq(diskLines(f.path)[0]?.seq, 1, '展开顺序错误 ⇒ entry.seq 覆盖了自动编号')
  } finally {
    f.cleanup()
  }
})

await t('🔴 `record({ seq: 9999 })` ⇒ 必须被忽略，且下一条从 2 继续', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    const r1 = await c.record({ seq: 9999, decision: 'A' })
    const r2 = await c.record({ decision: 'B' })
    assertEq([r1.seq, r2.seq], [1, 2], 'seq 永远由 AuditChain 单调自增，调用方不得注入')
  } finally {
    f.cleanup()
  }
})

await t('🔴 注入 seq 后的链仍能通过外部校验器（seq 单调 + prevHash 连续）', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ seq: undefined, decision: 'A' })
    await c.record({ decision: 'B' })
    const c2 = new AuditChain(f.path) // 重启 ⇐ 注入留下的坑在这一步才爆
    await c2.record({ decision: 'C' })
    assertEq(breaks(f.path), [], '缺 seq 的末行会让恢复跳过去 ⇒ 在错的地方续接')
  } finally {
    f.cleanup()
  }
})

// ==================================================== 3. ③ 恢复：两遍取
lines.push('')
lines.push('## 3. ③ 恢复时「链头」与「seq 起点」必须分两遍取')

await t('🔴 末行缺 seq（老格式/别的写入方）⇒ 必须接在它之后，不得跳过它', async () => {
  const f = fixture()
  try {
    writeRaw(f.path, [
      { seq: 1, ts: '2026-01-01T00:00:00.000Z', decision: 'A' },
      { seq: 2, ts: '2026-01-01T00:00:01.000Z', decision: 'B' },
      { ts: '2026-01-01T00:00:02.000Z', decision: 'C' } // ← 无 seq
    ])
    const c = new AuditChain(f.path)
    const r = await c.record({ decision: 'D' })
    assertEq(r.seq, 3, 'seq 起点取窗口内最大值（2）⇒ 下一条是 3，不得回落')
    // 这里**只能**校验 prevHash 链接：第三条是手工构造的"无 seq"老记录，
    // 它自己没有 seq 不算断口 —— 关键是 D 必须挂在**它**之后而不是它的前一条之后。
    assertEq(linksOnly(f.path), [], '跳过缺 seq 的末行 ⇒ 与它同为前一条的孩子 ⇒ 真分叉')
    assertEq(forks(f.path), [], '同父双记录 = 分叉')
  } finally {
    f.cleanup()
  }
})

await t('🔴 同上场景：`prevHash` 必须正好等于缺 seq 那条的 hash', async () => {
  const f = fixture()
  try {
    const tail = writeRaw(f.path, [
      { seq: 1, ts: '2026-01-01T00:00:00.000Z', decision: 'A' },
      { ts: '2026-01-01T00:00:01.000Z', decision: 'B' } // ← 无 seq
    ])
    const c = new AuditChain(f.path)
    await c.record({ decision: 'C' })
    const written = diskLines(f.path)
    assertEq(written.length, 3, '原有 2 条 + 新写 1 条')
    assertEq(written[2].prevHash, tail, '必须挂在末行之后（tail = 缺 seq 那条的 hash）')
  } finally {
    f.cleanup()
  }
})

// ==================================================== 4. [反向] 不得改过的部分
lines.push('')
lines.push('## 4. [反向] 改动前后都必须绿（防改过头）')

await t('正常写入全连续、`pending` 恒为 0（基线）', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ decision: 'A' })
    await c.record({ decision: 'B' })
    await c.record({ decision: 'C' })
    assertEq(breaks(f.path), [], '正常路径不得有断口')
    assertEq(c.pending, 0)
  } finally {
    f.cleanup()
  }
})

await t('连续失败（无交错）+ `flush()` ⇒ A,B,C 原序且连续', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ decision: 'A' })
    f.writable(false)
    await c.record({ decision: 'B' })
    await c.record({ decision: 'C' })
    f.writable(true)
    await c.flush()
    assertEq(diskLines(f.path).map((l) => l.decision), ['A', 'B', 'C'])
    assertEq(breaks(f.path), [], '连续失败本就无害 ⇒ 这条改动前后都必须绿')
  } finally {
    f.cleanup()
  }
})

await t('失败期间 seq 仍单调；flush 后重启从正确的数续接', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    const r1 = await c.record({ decision: 'A' })
    f.writable(false)
    const r2 = await c.record({ decision: 'B' })
    const r3 = await c.record({ decision: 'C' })
    assertEq([r1.seq, r2.seq, r3.seq], [1, 2, 3], 'seq 不得因进 outbox 而复用')
    f.writable(true)
    await c.flush()
    const c2 = new AuditChain(f.path)
    const r4 = await c2.record({ decision: 'D' })
    assertEq(r4.seq, 4, '重启后必须从 4 续接')
  } finally {
    f.cleanup()
  }
})

await t('正常格式（每条都有 seq）⇒ 恢复行为完全不变', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ decision: 'A' })
    await c.record({ decision: 'B' })
    const c2 = new AuditChain(f.path)
    assertEq(c2.count, 2, '重载后 count 必须是 2')
    const r = await c2.record({ decision: 'C' })
    assertEq(r.seq, 3)
    assertEq(breaks(f.path), [])
  } finally {
    f.cleanup()
  }
})

await t('尾部残行（不可解析）仍被跳过 —— 场景与 `_audit_chain_test.mjs` 场景 4 一致', async () => {
  const f = fixture()
  try {
    const c = new AuditChain(f.path)
    await c.record({ decision: 'A' })
    await c.record({ decision: 'B' })
    writeFileSync(f.path, readFileSync(f.path, 'utf8') + '{"seq":99,"ts":"2026-09-23T00:00:00.000Z","dec')
    const c2 = new AuditChain(f.path)
    assertEq(c2.count, 2, '残行里的 seq:99 不得被当成窗口最大值（它不可解析）')
    const r = await c2.record({ decision: 'C' })
    assertEq(r.seq, 3)
  } finally {
    f.cleanup()
  }
})

// ==================================================== 收尾
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
console.log(`[audit-gate-test] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
