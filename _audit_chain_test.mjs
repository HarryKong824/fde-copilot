// 缺陷 ② 回归测试：AuditChain 跨实例（模拟插件热重载）必须续接旧链。
// 运行：node _audit_chain_test.mjs
import { AuditChain } from './dsh-fde-ontology-gate/lib/audit.js'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const tmp = fileURLToPath(new URL('./_audit_chain_test_tmp.jsonl', import.meta.url))
rmSync(tmp, { force: true })

const fail = (msg) => { console.error('❌ ' + msg); process.exit(1) }
const ok = (msg) => console.log('✅ ' + msg)

const linkHash = (prevHash, record) =>
  createHash('sha256').update(prevHash).update('\n').update(JSON.stringify(record)).digest('hex')

// 场景 1：全新文件 → 链从全零开始
const a = new AuditChain(tmp)
if (a.count !== 0) fail(`新文件 count 应为 0，实际 ${a.count}`)
await a.record({ tool: 'x', decision: 'deny' })
await a.record({ tool: 'y', decision: 'shadow-deny' })
if (a.count !== 2) fail(`A.count 应为 2，实际 ${a.count}`)
ok('场景1：新链 seq 1→2，prevHash 起于全零')

// 场景 2：新实例（= 插件热重载）→ 必须续接而不是重开
const b = new AuditChain(tmp)
if (b.count !== 2) fail(`重载后 count 应恢复为 2，实际 ${b.count}（缺陷②未修时会回到 0）`)
const r3 = await b.record({ tool: 'z', decision: 'deny' })
if (r3.seq !== 3) fail(`续接后第一条 seq 应为 3，实际 ${r3.seq}（缺陷②未修时会回到 1）`)
ok('场景2：重载后续接旧链，seq=3（不回 1）')

// 场景 3：全文件逐条校验 —— 单一连续链，无 A/B 断点
{
  const lines = readFileSync(tmp, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  let prev = '0'.repeat(64)
  lines.forEach((line, idx) => {
    if (line.seq !== idx + 1) fail(`第 ${idx + 1} 行 seq=${line.seq}，应单调 1..n（seq 复用 = 缺陷②）`)
    if (line.prevHash !== prev) fail(`第 ${idx + 1} 行 prevHash 断链（缺陷②）`)
    const { prevHash, hash, ...record } = line
    if (hash !== linkHash(prev, record)) fail(`第 ${idx + 1} 行 hash 不匹配`)
    prev = hash
  })
  ok(`场景3：${lines.length} 条全链校验通过 —— 单一连续链，跨实例无断点`)
}

// 场景 4：尾部崩溃残行（无换行、不可解析）→ 跳过并续接，残行不得吞掉新记录
writeFileSync(tmp, readFileSync(tmp, 'utf8') + '{"seq":99,"ts":"2026-09-23T00:00:00.000Z","tool":"broken","dec')
const d = new AuditChain(tmp)
if (d.count !== 3) fail(`残行后应从 seq 3 续接，实际 ${d.count}`)
const r4 = await d.record({ tool: 'w', decision: 'deny' })
if (r4.seq !== 4) fail(`残行后续接 seq 应为 4，实际 ${r4.seq}`)
{
  const good = readFileSync(tmp, 'utf8').split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
  const l3 = good.find((l) => l.seq === 3)
  const l4 = good.find((l) => l.seq === 4)
  if (!l3 || !l4) fail('残行场景：seq 3 / 4 记录缺失（残行吞掉了新记录）')
  if (l4.prevHash !== l3.hash) fail('残行场景：seq 4 未接在 seq 3 之后')
}
ok('场景4：尾部残行被隔离 + 跳过，seq 4 正确接在 seq 3 之后')

rmSync(tmp, { force: true })

// 故意反一次以验证退出码真的会变红（手册 §8 第二条纪律）。
// 口径：**所有回归一视同仁** —— 不存在「只管新增回归」的豁免。
// 本脚本原本用 fail() → process.exit(1) 判定，单次而言它是会红的；
// 但缺少统一的"故意做反"钩子，就无法与其它套件用同一条命令自证。补齐后才能一视同仁地复核。
if (process.env.FDE_INVERT === '1') {
  console.error('❌ [INVERT] 故意失败以验证退出码敏感')
  process.exit(1)
}

console.log('全部通过：缺陷 ② 修复回归 4/4')
