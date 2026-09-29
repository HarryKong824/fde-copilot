/**
 * Stage 5.5 · **活链只读预演**：新代码会不会把当前这条 gate 链判成"不完整"？
 *
 * 为什么必须先在副本上问这个问题：D2 一旦上线，链不通过 ⇒ Phase 4 永久卡死，
 * 而"链其实没问题、只是我的判据太严"这种情况，只能靠**先算一次**发现。
 *
 * ⚠️ 本脚本：
 *   - 把活链**拷到临时文件**再跑（AuditChain 构造函数会补写残尾换行 ⇒ 不得直接碰活文件）；
 *   - 只读，不写入任何活体路径；跑完打印活链 sha256 供对拍。
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyAuditChainText, auditChainFingerprintSync, runD2Check, D2_ANCHOR_ALG } from './dsh-fde-phase/lib/check-d2.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_predict_d2_out.txt')
const LIVE = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/gate.jsonl'
const lines = []
const say = (s) => lines.push(s)

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

try {
  const raw = readFileSync(LIVE)
  const liveSha = sha(LIVE)
  say('== D2 活链预演 ==')
  say(`活链：${LIVE}`)
  say(`  bytes=${raw.length}  sha256=${liveSha}`)

  const copy = join(mkdtempSync(join(tmpdir(), 'fde-d2-')), 'gate.jsonl')
  writeFileSync(copy, raw)

  const text = readFileSync(copy, 'utf8')
  const r = verifyAuditChainText(text)
  say('')
  say('[1] 纯文本校验（运行中真正干的事）')
  say(`  passed    = ${r.passed}`)
  say(`  lineCount  = ${r.lineCount}`)
  say(`  headHash   = ${r.headHash}`)
  say(`  failures   = ${r.failures.length}`)
  for (const f of r.failures.slice(0, 10)) say(`    · 第 ${f.line} 行 [${f.code}] ${f.message}`)

  const fp = auditChainFingerprintSync(copy)
  say('')
  say('[2] guard 侧要比的指纹')
  say(`  { len: ${fp.len}, sha256: ${fp.sha256} }`)
  say(`  alg = ${D2_ANCHOR_ALG}`)

  const asyncR = await runD2Check(copy)
  say('')
  say('[3] runD2Check（工具入口）')
  say(`  passed = ${asyncR.passed}   reason = ${asyncR.reason}`)

  say('')
  say('[4] 结论')
  if (r.passed) {
    say('  ✅ 当前活链能过 D2 ⇒ 工具跑完即可得一个可用结论；')
    say('     ⚠️ 但之后**任何一条新记录**写进这条链，行数就变 ⇒ D2 过期 ⇒ 必须重跑。')
    say('     这不是缺陷：D2 要证明的是"在推进这一刻，链是完整的"。')
  } else {
    say('  🔴 当前活链**过不了** D2 ⇒ 上线即卡死 Phase 4。上面 failures 就是必须先处理的东西。')
  }

  const after = sha(LIVE)
  say('')
  say(`[5] 跑完再取活链 sha256 = ${after}  ⇒ ${after === liveSha ? '零副作用 ✅' : '🔴 活链被改动了！'}`)
} catch (e) {
  say(`预演失败：${e?.stack ?? e}`)
}

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(lines.join('\n'))
console.log(`\n[d2-predict] 结果已写入 ${OUT}`)
