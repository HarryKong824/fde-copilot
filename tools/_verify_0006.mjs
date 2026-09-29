/**
 * 0006 独立复核：把活链**拷贝**后只读分析（绝不在活体上构造 AuditChain）。
 *
 * 验四件事：
 *   1. #36 之后新增的全部 restrict 记录（decision / agent / from / phase）
 *   2. 全链哈希链连续性（prevHash / hash / seq 单调）
 *   3. 是否存在 `restrict-untracked` / `restrict-history-miss`（B 判据的事实面）
 *   4. 「不链式」：同一 agent 多条 restored 的 from 是否恒指同一条 applied
 */
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIVE = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/phase.jsonl'
const AUDIT_DIR = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit'
const OUT = join(HERE, '_verify_0006_out.txt')

const sha = (b) => createHash('sha256').update(b).digest('hex')
const liveBuf = readFileSync(LIVE)
const L = []
L.push(`活链 bytes=${liveBuf.length} sha256=${sha(liveBuf)}`)
L.push(`fde-audit/ 目录内容：${readdirSync(AUDIT_DIR).join(', ')}`)

const tmp = mkdtempSync(join(tmpdir(), 'fde-verify-'))
const copy = join(tmp, 'phase.jsonl')
copyFileSync(LIVE, copy)

const recs = readFileSync(copy, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0)
  .map((l) => JSON.parse(l))
L.push(`行数=${recs.length}`)

// ---- 哈希链连续性 ----
let prev = '0'.repeat(64)
let lastSeq = 0
let broken = 0
for (const r of recs) {
  const { prevHash, hash, ...body } = r
  if (prevHash !== prev) broken += 1
  const calc = createHash('sha256').update(prev).update('\n').update(JSON.stringify(body)).digest('hex')
  if (calc !== hash) broken += 1
  if (!(body.seq > lastSeq)) broken += 1
  lastSeq = body.seq
  prev = hash
}
L.push(`哈希链校验：${broken === 0 ? '✅ 全链连续、seq 单调' : `❌ ${broken} 处异常`}`)

// ---- 新增记录 ----
const short = (id) => (typeof id === 'string' ? id.replace('session-', '').slice(0, 8) : '-')
L.push('')
L.push('=== #36 之后新增的 restrict 记录 ===')
for (const r of recs.filter((r) => r.type === 'restrict' && r.seq >= 36)) {
  L.push(
    `  #${r.seq} ${r.decision} agent=${short(r.agent)} phase=${r.phase ?? '-'} from=${r.from === undefined ? '(缺)' : JSON.stringify(r.from)} denied=${JSON.stringify(r.denied ?? null)} ts=${r.ts}`
  )
}

// ---- 决策统计 ----
L.push('')
L.push('=== 全链 restrict decision 统计 ===')
const tally = {}
for (const r of recs.filter((r) => r.type === 'restrict')) {
  tally[r.decision] = (tally[r.decision] ?? 0) + 1
}
for (const [k, v] of Object.entries(tally)) L.push(`  ${k}: ${v}`)

// ---- 不链式：同 agent 的 restored 是否 from 一致 ----
L.push('')
L.push('=== 不链式检查（同 agent 多条 restored 的 from） ===')
const byAgent = new Map()
for (const r of recs.filter((r) => r.type === 'restrict' && r.decision === 'restrict-restored')) {
  const id = short(r.agent)
  if (!byAgent.has(id)) byAgent.set(id, [])
  byAgent.get(id).push({ seq: r.seq, from: r.from })
}
for (const [id, list] of byAgent) {
  const froms = [...new Set(list.map((x) => String(x.from)))]
  L.push(
    `  ${id}: ${list.map((x) => `#${x.seq} from=${x.from}`).join(' / ')}  ⇒ ${froms.length === 1 ? '✅ 恒指同一条' : '❌ 链式/不一致'}`
  )
}

// ---- B 判据事实面 ----
L.push('')
L.push('=== B（untracked）事实面 ===')
L.push(`  restrict-untracked 条数 = ${tally['restrict-untracked'] ?? 0}`)
L.push(`  restrict-history-miss 条数 = ${tally['restrict-history-miss'] ?? 0}`)

writeFileSync(OUT, L.join('\n') + '\n', 'utf8')
console.log(L.join('\n'))
