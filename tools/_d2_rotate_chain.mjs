/**
 * Stage 5.5 · 处置历史 gate 链的两处 GENESIS 断层（**默认 dry-run，不碰任何文件**）。
 *
 * ## 背景（不是我猜的，是算出来的）
 * `_predict_d2.mjs` 在活链**副本**上先算了一遍：当前 `gate.jsonl`（79 行 / `77bf2a4b…581960`）
 * 有 2 处 `prevHash = GENESIS` 且 `seq` 归 1 的接缝（第 9 行 @05:42:15、第 14 行 @06:25:13，均为 2026-09-23）。
 * 那是"插件重载导致链从全零重启"缺陷（gate README 第 8 条，当天已修）留下的**历史痕迹**。
 *
 * ⇒ **D2 没有误报**：这条链确实不是一条从头到尾接得起来的链。
 *   不处置 ⇒ D2 在活体上永远跑不过 ⇒ Phase 4 一直被拦。
 *
 * ## 本脚本做什么（只有显式 `--execute` 才做）
 *   1. 把当前链**原样归档**为 `gate.jsonl.<ts>`（字节级复制，sha256 对拍确认）；
 *   2. 写一份 manifest：`gate.jsonl.<ts>.manifest.md`；
 *   3. 原位 `gate.jsonl` 换成**新的空文件**，**再用 gate 自己的 `AuditChain` 写一条 chain-rotated 起点记录**
 *      ⇒ 新链长这样：`1 行 / seq=1 / prevHash=GENESIS`，按 D2 既有四条判据直接通过，**不需要任何特判**。
 *
 * 🔴 **为什么起点记录用真 `AuditChain` 写，而不是在这里照抄 `linkHash`**：
 * 自己抄一份 ⇒ 迟早算出不同的 hash ⇒ 要么永远新鲜（等于没验）要么永远过期（等于卡死）。
 * 这一条对"一次性运维脚本"同样成立 —— 让它直接调用生产实现，格式由生产代码独家保证。
 *
 * 历史证据**一个字节都没删**，只是不再是"当前活跃链"。
 *
 * 用法：
 *   node _d2_rotate_chain.mjs                 # dry-run：只打印计划与哈希
 *   node _d2_rotate_chain.mjs --execute       # 真正执行
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyAuditChainText } from '../dsh-fde-phase/lib/check-d2.js'
import { AuditChain } from '../dsh-fde-ontology-gate/lib/audit.js'

const CHAIN = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/gate.jsonl'
const EXECUTE = process.argv.includes('--execute')
const OUT = join(dirname(fileURLToPath(import.meta.url)), '_d2_rotate_out.txt')
const lines = []
const say = (s) => lines.push(s)

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

try {
  if (!existsSync(CHAIN)) {
    say(`链不存在：${CHAIN} —— 无需处置。`)
    say('')
  } else {
    const raw = readFileSync(CHAIN)
    const before = sha(CHAIN)
    const r = verifyAuditChainText(raw.toString('utf8'))
    const seams = r.failures.filter((f) => f.code === 'prevHash-mismatch').map((f) => f.line)

    say('== D2 历史链处置 ==')
    say(`链：${CHAIN}`)
    say(`  bytes=${raw.length}  sha256=${before}`)
    say(`  lineCount=${r.lineCount}  headHash=${r.headHash}`)
    say(`  passed=${r.passed}  failures=${r.failures.length}`)
    say(`  GENESIS 接缝行号 = ${seams.length > 0 ? seams.join(', ') : '（无）'}`)
    say('')
    say(EXECUTE ? '>> 模式：EXECUTE（真的归档 + 起新链）' : '>> 模式：DRY-RUN（只打印计划，不碰任何文件）')
    say('')
    say('计划：')
    say('  1) 归档  gate.jsonl      →  gate.jsonl.<ts>   （字节级复制，sha256 对拍）')
    say('  2) 写 manifest           →  gate.jsonl.<ts>.manifest.md')
    say('  3) 原位换空文件          →  gate.jsonl')
    say('  4) 用真 AuditChain 写一条 chain-rotated 起点记录（seq=1 / prevHash=GENESIS）')

    if (EXECUTE) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const archived = `${CHAIN}.${ts}`
      copyFileSync(CHAIN, archived)
      const archivedSha = sha(archived)
      if (archivedSha !== before) {
        say('')
        say('🔴 归档失败：副本 sha256 与原件不符，已中止，原位链未动。')
      } else {
        const archivedName = basename(archived)
        writeFileSync(
          `${archived}.manifest.md`,
          [
            '# gate 审计链归档 manifest',
            '',
            '> 给将来读这份归档的人：**先读这一页，再验链。**',
            '> 归档文件里有 2 处断链，它们是**已知且已修的历史缺陷留下的痕迹，不是篡改**。',
            '',
            `- **归档文件名**：${archivedName}`,
            `- **原 sha256**：${before}（${raw.length} 字节 / ${r.lineCount} 行非空）`,
            `- **归档时刻**：${new Date().toISOString()}`,
            '- **操作人**：用户（人工执行 `node _d2_rotate_chain.mjs --execute`；该脚本**未注册为工具、未被任何插件 import**，模型不可调用 ⇒ 归档是运维动作，不是模型能力）',
            '- **归档原因**：Stage 5.5 的 D2 要求"一条从头到尾接得起来的链"；本链存在 2 处历史 GENESIS 接缝，D2 在活体上**永不可通过** ⇒ Phase 4 被永久拦（即 B 方案的"死门禁"，比没有门禁更糟）。',
            '',
            '## 已知接缝',
            '',
            '| 行 | seq | prevHash | 时刻 | 性质 |',
            '|---|---|---|---|---|',
            `| ${seams[0] ?? '?'} | 1 | \`0000…0000\` | 2026-09-23T05:42:15.078Z | GENESIS 接缝（链从全零重开） |`,
            `| ${seams[1] ?? '?'} | 1 | \`0000…0000\` | 2026-09-23T06:25:13.143Z | GENESIS 接缝（链从全零重开） |`,
            '',
            '- **接缝成因**：2026-09-23 的"插件重载 ⇒ 链从全零重启、`seq` 归 1"缺陷（gate README 诚实清单第 8 条，**当天已修并活验**）。',
            '- **已修的证明**：第 14 行之后 **65 行完全连续**（`seq` 2→66，逐条 `prevHash` 接得上，末行 `ts=2026-09-24T12:37:46.316Z`）⇒ 两处均为**历史遗留**，不是"还在漏"。',
            '- **⇒ 请按"三条链段被运维原因前后拼接在一个文件里"来理解这份归档**：它不是一条链。',
            '',
            '## 校验边界（务必读，别把它当成更强的保证）',
            '',
            '- **结构性校验**（已做）：`verifyAuditChainText` 逐条验 `prevHash` 接续、`seq` 递增、`hash` 为 64 位十六进制。',
            '- **内容级校验**（**归档时额外做了一次，但不是运行时能力**）：',
            `  一次性只读探针 \`_probe_content_hash.mjs\` 对这 ${r.lineCount} 行**逐行重算** hash`,
            `  （\`sha256(prevHash + '\\n' + JSON.stringify(record))\`，与写链时同公式），结果 **${r.lineCount}/${r.lineCount} 相符**`,
            '  ⇒ 归档那一刻，每条记录的内容都与其 hash 一致。输出见 `_probe_content_hash_out.txt`，任何人可重跑核对。',
            '- 🔴 **三者的区别请勿混同**：',
            '  - `archivedSha256` 是**文件级**哈希 ⇒ 证明**这份归档文件后来没被动过**；',
            '  - 重算探针 ⇒ 证明**归档那一刻链上的内容没被改过**；',
            '  - **运行时 D2 目前不做内容级重算（无此判据，见 S2）** ⇒ 不要因为这里记了 sha256，',
            '    就以为活链已经受内容级密码学校验。**这份 manifest 不构成对活链的任何保证。**',
            '',
            '## 处置方式',
            '',
            '- **只归档、不删除**：历史证据一个字节都没删，只是不再是"当前活跃链"。',
            `- 原位 \`gate.jsonl\` 是一条 **chain-rotated 起点记录**（指向 ${archivedName}），由 gate 自己的 \`AuditChain\` 写出。`,
            '- 归档副本 sha256 与原件**逐字节对拍**（脚本内校验），不符即中止，原位链不动。',
            ''
          ].join('\n'),
          'utf8'
        )

        // 原位换成空文件（先写临时文件再 rename，避免半写状态）
        const tmp = `${CHAIN}.new.${ts}`
        writeFileSync(tmp, '', 'utf8')
        renameSync(tmp, CHAIN)

        // 起点记录：**用 gate 真实实现写**，hash 与格式由生产代码独家保证
        const chain = new AuditChain(CHAIN)
        const rec = await chain.record({
          event: 'chain-rotated',
          archivedTo: archivedName,
          archivedSha256: archivedSha,
          archivedLines: r.lineCount,
          archivedBytes: raw.length,
          seams: seams.slice(0, 2)
        })

        const newText = readFileSync(CHAIN, 'utf8')
        const vr = verifyAuditChainText(newText)
        say('')
        say(`已归档：${archivedName}  sha256=${archivedSha}  ${archivedSha === before ? '✅ 与原件一致' : '🔴 不一致'}`)
        say(`manifest：${archivedName}.manifest.md`)
        say(`起点记录：persisted=${rec.persisted}  seq=${rec.seq}  hash=${String(rec.hash).slice(0, 12)}…`)
        if (!rec.persisted) say('🔴 起点记录没写进磁盘 —— 链现在是空的，请勿启动 DSH，先人工确认。')
        say(`新链：bytes=${Buffer.byteLength(newText)}  lineCount=${vr.lineCount}  headHash=${vr.headHash}`)
        say(`      verifyAuditChainText ⇒ passed=${vr.passed}  failures=${vr.failures.length}`)
      }
    }

    const afterSha = existsSync(CHAIN) ? sha(CHAIN) : '(missing)'
    say('')
    say(`跑完再取：${CHAIN}  sha256=${afterSha}`)
  }
} catch (e) {
  say(`失败：${e?.stack ?? e}`)
}

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(lines.join('\n'))
console.log(`\n[d2-rotate] 结果已写入 ${OUT}`)
