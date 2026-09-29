/**
 * 0008 独立复核（未引用对方输出）：
 *  A. 活链现状：47 行 / 21498B / sha e3b47eb6…bfdcef
 *  B. #44–#47 四条跨进程 lifted 逐字段核对（agent / via / from / denied）
 *  C. 哈希链连续性 + seq 单调（防"记录是对的但链写坏了"）
 *  D. 幂等侧证：被 lifted 的 agent 索引已更新；新会话（无历史）不在索引里
 */
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditChain, GENESIS } from './dsh-fde-phase/lib/audit.js'

const CHAIN = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/phase.jsonl'
const OUT = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18/_verify_0008_out.txt'
const L = []
const log = (s) => {
  L.push(s)
  console.log(s)
}
const sha = (b) => createHash('sha256').update(b).digest('hex')

const buf = readFileSync(CHAIN)
const lines = buf.toString('utf8').split('\n').filter((x) => x.trim())
log(`[A] 活链 lines=${lines.length} bytes=${buf.length} sha256=${sha(buf)}`)
log(`[A] 与 0008 给的（47 / 21498 / e3b47eb6…bfdcef）比较 ⇒ ${lines.length === 47 && buf.length === 21498 && sha(buf).startsWith('e3b47eb6') ? '一致 ✅' : '🔴 不一致'}`)

const recs = lines.map((l) => JSON.parse(l))

log('[B] #44–#47 逐条：')
for (const r of recs.filter((r) => r.seq >= 44)) {
  log(
    `    #${r.seq} ${r.decision} agent=${(r.agent ?? '-').slice(0, 24)}… via=${r.via ?? '-'} from=${r.from ?? '-'} ` +
      `denied=${JSON.stringify(r.denied ?? null)} phase=${r.phase ?? '-'} ts=${r.ts}`
  )
}
const lifted44 = recs.filter((r) => r.seq >= 44)
log(`[B] 新增条数 = ${lifted44.length}（应 4）`)
log(`[B] 全部 decision=restrict-lifted ⇒ ${lifted44.every((r) => r.decision === 'restrict-lifted') ? 'YES ✅' : '🔴 NO'}`)
log(`[B] 全部 via=index ⇒ ${lifted44.every((r) => r.via === 'index') ? 'YES ✅' : '🔴 NO'}`)
const froms = lifted44.map((r) => r.from).sort((a, b) => a - b)
log(`[B] from 集合 = ${JSON.stringify(froms)}（应 [40,41,42,43]）⇒ ${JSON.stringify(froms) === '[40,41,42,43]' ? 'YES ✅' : '🔴 NO'}`)
log(`[B] denied 均为 ["pwsh"] ⇒ ${lifted44.every((r) => JSON.stringify(r.denied) === '["pwsh"]') ? 'YES ✅' : '🔴 NO'}`)

// 反查：from 指向的那条是不是"带限制"的记录
log('[B] 反查 from 指向的记录：')
for (const r of lifted44) {
  const src = recs.find((x) => x.seq === r.from)
  log(
    `    #${r.seq}.from=${r.from} ⇒ #${src?.seq} ${src?.decision} denied=${JSON.stringify(src?.denied ?? null)} ` +
      `agent 相同=${src?.agent === r.agent ? 'YES ✅' : '🔴 NO'}`
  )
}

// ---- C. 哈希链连续性 ----
let prev = GENESIS
let lastSeq = 0
let broken = 0
for (const r of recs) {
  const { prevHash, hash, ...body } = r
  if (prevHash !== prev) broken += 1
  if (hash !== createHash('sha256').update(prev).update('\n').update(JSON.stringify(body)).digest('hex')) broken += 1
  if (!(body.seq > lastSeq)) broken += 1
  lastSeq = body.seq
  prev = hash
}
log(`[C] 哈希链重算：${recs.length} 行，断裂/重号 = ${broken} ⇒ ${broken === 0 ? '全连续 ✅' : '🔴 有断链'}`)

// ---- D. 索引侧证（副本上，避免构造函数补 \n 写活体）----
const tmp = mkdtempSync(join(tmpdir(), 'fde-0008-'))
const copy = join(tmp, 'phase.jsonl')
copyFileSync(CHAIN, copy)
const audit = new AuditChain(copy)
const idx = audit.latestRestrictByAgent()
log(`[D] tailTruncated=${audit.tailTruncated}；索引 ${idx.size} 条：`)
for (const [id, e] of idx) log(`    ${id.slice(0, 24)}… seq=${e.seq} decision=${e.decision} denied=${JSON.stringify(e.denied)}`)
const stillCarrying = [...idx.values()].filter((e) =>
  ['restrict-applied', 'restrict-restored', 'restrict-replaced'].includes(e.decision) && (e.denied ?? []).length > 0
)
log(`[D] 仍"带限制"的 agent 数 = ${stillCarrying.length} ⇒ ${stillCarrying.length === 0 ? '零 ⇒ 下次重启不会再落 ✅（幂等成立）' : '🔴 ' + stillCarrying.length}`)
log(`[D] 新会话 0a3c7421 是否在索引里 ⇒ ${[...idx.keys()].some((k) => k.includes('0a3c7421')) ? '在' : '不在 ✅（无历史 ⇒ 不会被编造）'}`)

writeFileSync(OUT, L.join('\n') + '\n', 'utf8')
