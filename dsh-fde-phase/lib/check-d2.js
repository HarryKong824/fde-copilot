/**
 * D2 —— **gate 审计链的完整性检查**（Stage 5.5）。
 *
 * 为什么它是"全量读"而不是沿用 `TAIL_BYTES` 尾部窗口：
 * 一条链被《中间截断》后，尾部窗口照样能解出若干合法行、照样能拿到一个链头 hash，
 * **单看窗口看不出中间少了东西**。而"少了一段"正是要验出来的那种事 ——
 * 所以这里只认**从第一行到最后一行逐条接得上**（施工单 §6-3）。
 * 现实体量：2026-09-26 实测 79 行 / 36KB，全量读毫无压力；真到量级再说分片，
 * 但**不允许**为此退回尾部窗口（那等于把要验的东西定义没了）。
 *
 * 三种调用形态：
 *   - `verifyAuditChainText(text)`    纯函数（无 IO）⇒ 离线可精确构造每种坏链。
 *   - `auditChainFingerprintSync(p)`  同步取指纹 ⇒ 给 **guard** 用（guard 必须同步、不能 await）。
 *   - `runD2Check(p)`                 异步全量跑 ⇒ 给 `fde-run-audit-check` **工具**用。
 *
 * 🔴 工具与 guard 必须走**同一个** `verifyAuditChainText` 的口径定义：
 * 工具负责"深验一次"，guard 只负责"链从上次验完到现在有没有被动过"（比对 `len` + `headHash`）。
 * 两边各写一份解析 ⇒ 迟早算出不同的指纹 ⇒ 要么永远新鲜（等于没验）要么永远过期（等于卡死）。
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { GENESIS } from './audit.js'

/** D2 的锚点算法标记。dsl/phase 两侧如需引用，从各自的 ANCHOR_ALGS 表取；这里是唯一定义处。 */
export const D2_ANCHOR_ALG = 'audit-chain(len+head)@v1'

const HEX64 = /^[0-9a-f]{64}$/

/**
 * 把文本切成"非空行"。空行不是记录（文件末尾换行会多出一个空串）。
 * @param {string} text
 * @returns {string[]}
 */
export function chainLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * 逐条校验一条审计链是否完整。
 *
 * 判据（任一不满足即记为一条 failure，**不因某条坏了就停下**）：
 *   ① 每行都能解析成 JSON 对象；
 *   ② 每行都有合法的 64 位十六进制 `hash`；
 *   ③ 首条的 `prevHash` 必须是 GENESIS，其余每条的 `prevHash` 必须等于前一条的 `hash`；
 *   ④ `seq` 必须是整数且严格递增（缺 seq / 不递增 = 这条记录在链上的位置不可信，
 *      正是 P2-3 那道坑的同形态 —— 换个插件、换种写链方式，就可能再犯一次，所以这里必须再挡）。
 *
 * @param {string} text
 * @returns {{passed: boolean, lineCount: number, headHash: string, failures: Array<{line:number, code:string, message:string}>}}
 */
export function verifyAuditChainText(text) {
  const lines = chainLines(text)
  const failures = []
  let expectPrev = GENESIS
  let expectPrevKnown = true
  let prevSeq = null
  let headHash = GENESIS

  lines.forEach((raw, i) => {
    const lineNo = i + 1

    let rec
    try {
      rec = JSON.parse(raw)
    } catch {
      failures.push({
        line: lineNo,
        code: 'unparseable-line',
        message: `第 ${lineNo} 行无法解析为 JSON（残尾，或被人改写过）`
      })
      expectPrevKnown = false
      return
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      failures.push({ line: lineNo, code: 'not-an-object', message: `第 ${lineNo} 行不是 JSON 对象` })
      expectPrevKnown = false
      return
    }

    if (typeof rec.hash !== 'string' || !HEX64.test(rec.hash)) {
      failures.push({
        line: lineNo,
        code: 'bad-hash',
        message: `第 ${lineNo} 行缺少合法的 hash（应为 64 位十六进制）`
      })
    }

    // 前一条不可解析 ⇒ 已经因为它报过一次，这里不再重复刷屏（根因在它身上）。
    if (expectPrevKnown && rec.prevHash !== expectPrev) {
      failures.push({
        line: lineNo,
        code: 'prevHash-mismatch',
        message:
          i === 0
            ? `第 ${lineNo} 行（首条）的 prevHash 不是 GENESIS —— 链不是从起点开始的`
            : `第 ${lineNo} 行的 prevHash 与前一条的 hash 不接 —— 链在此处断开（中间被改或被截）`
      })
    }

    if (!Number.isInteger(rec.seq) || (prevSeq !== null && rec.seq <= prevSeq)) {
      failures.push({
        line: lineNo,
        code: 'bad-seq',
        message: `第 ${lineNo} 行的 seq 缺失、非整数或不递增 —— 这条记录在链上的位置不可信`
      })
    }

    expectPrevKnown = typeof rec.hash === 'string' && HEX64.test(rec.hash)
    expectPrev = expectPrevKnown ? rec.hash : GENESIS
    prevSeq = Number.isInteger(rec.seq) ? rec.seq : prevSeq
    if (typeof rec.hash === 'string') headHash = rec.hash
  })

  return { passed: failures.length === 0, lineCount: lines.length, headHash, failures }
}

/**
 * 同步取"链此刻的样子"的指纹 = `(行数, 链头 hash)`。
 *
 * ⚠️ 这是 **guard 侧唯一的 D2 判据**，所以它必须与工具的口径完全一致
 * （同一个 `verifyAuditChainText`）—— 行数用同一个 `chainLines` 切法，链头用同一个取值范围。
 *
 * 🔴 这里刻意**全量读**：行数只有全量读才知道。施工单 §4.3 写的"只读尾部窗口"取不到行数 ——
 * 取不到行数就比不了 `len`，而 `len` 正是"链有没有被追加/截断"的唯一廉价信号。
 *
 * @param {string} path - gate 审计链路径
 * @returns {{len: number, sha256: string}}
 * @throws {Error} 读不到文件时抛（由调用方翻成 deny 理由 —— 绝不返回一个"看起来能用"的指纹）
 */
export function auditChainFingerprintSync(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`读取 gate 审计链失败（${path}）：${String(e?.message ?? e)}`)
  }
  const r = verifyAuditChainText(text)
  return { len: r.lineCount, sha256: r.headHash }
}

/**
 * 异步全量跑一次 D2（给 `fde-run-audit-check` 工具）。
 *
 * 文件读不到 ⇒ `passed:false` 并在 `failures` 里给原因（fail-closed：
 * 验不出完整性 = 不能证明它完整）。
 *
 * @param {string} path
 * @returns {Promise<{passed:boolean, lineCount:number, headHash:string, failures:Array<object>, reason:string}>}
 */
export async function runD2Check(path) {
  let text = null
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    const msg = `读不到 gate 审计链（${path}）：${String(e?.message ?? e)}`
    return { passed: false, lineCount: 0, headHash: GENESIS, failures: [{ line: 0, code: 'unreadable', message: msg }], reason: msg }
  }
  const r = verifyAuditChainText(text)
  return {
    passed: r.passed,
    lineCount: r.lineCount,
    headHash: r.headHash,
    failures: r.failures,
    reason: r.passed ? '链自首条至末条逐条接续，seq 递增且无坏行' : `${r.failures.length} 处问题：${r.failures[0].message}`
  }
}
