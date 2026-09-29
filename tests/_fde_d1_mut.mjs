/**
 * `_fde_d1_test.mjs` 的**变异验证** —— 证明那 107 条断言真会红，而不是"恰好全绿"。
 *
 * 跑法：`node _fde_d1_mut.mjs`；结果写 `_fde_d1_mut_out.txt`。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 🔴 **与既有 `_*_mut.mjs` 的唯一不同：本套件不就地改真源码，改的是沙箱副本。**
 *
 *    既有做法（`_fde_e5_mut.mjs` 等）= 备份真源码 → 就地改 → 跑 → `finally` 还原 → 核 sha。
 *    那条路每一步都对，但它有一个**不对称的风险**：进程被强杀（Ctrl-C / OOM / 断电）
 *    会**把生产源码留在变异态**，而它能提供的唯一保障是"下次有人来核 sha"。
 *
 *    本套件改走沙箱：真源码**一次都不碰**（收尾核 sha 是用来**证明**这一点的，不是用来补救的）。
 *    代价 = 多一次目录拷贝。收益 = 最坏情况下被污染的是一份随时可弃的副本。
 *
 *    沙箱放在 `_mut/d1/`（**工作区内**，不是系统临时目录）：`dsh-fde-phase/lib/` 里有文件
 *    import `@deepseek-ai/*`，放在工作区内才能让 Node 向上找到 `<工作区>/node_modules` 那个
 *    离线桩（既有 5 个回归脚本的共享夹具）。
 *
 * 🔴 判据（每条变异都必须满足，缺任一 ⇒ 本轮作废）：
 *   ① 期望的**具名**断言出现在红名单里（按**前缀**匹配 —— 有些断言名里带插值出来的计数）；
 *   ② 报告**完整产出**（结果文件存在 + 含收尾行 `（共 N）`）—— **崩溃不是证据**：
 *      崩溃会让整份报告消失，与"断言抓住了"看起来都是"没通过"；
 *   ③ 期望断言没红时**只许报"变异未被抓住"**，不许改写成"是真缺口"，并给出实际红名单。
 *
 * ⚠️ 变异注入前过两关（本项目既有纪律）：① 类型/结构仍成立；② 语义**真不等价**。
 *    改完 `from` 找不到 / 找到多次 ⇒ 无效变异，本轮作废重做，不算红也不算绿。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')  // 插件目录在仓库根，不在 tests/
const OUT = join(HERE, '_fde_d1_mut_out.txt')
const TEST = join(HERE, '_fde_d1_test.mjs')
const SANDBOX = join(HERE, '_mut', 'd1')

/** 真源码里**必须逐字不变**的文件（本套件的存在理由之一就是证明它们没被动过）。 */
const PROTECTED = [
  'dsh-fde-memory/lib/outbox.js',
  'dsh-fde-memory/lib/telemetry-sink.js',
  'dsh-fde-memory/lib/config.js',
  'dsh-fde-phase/lib/remote-state.js',
  'dsh-fde-phase/lib/guard.js',
  'dsh-fde-phase/lib/config.js',
  'dsh-fde-phase/lib/tools.js'
]

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/**
 * 变异表。`from` 必须在目标文件里**恰好出现一次**（本文件跑前已逐条 grep 核过）。
 * 每一条都对着 `_fde_d1_test.mjs` 里的一条**具名**断言 ——
 * 变异若没被它抓住，说明那条断言是摆设（"能观测到" ≠ "会被判红"）。
 */
const MUTANTS = [
  // ── A 组：L2 队列本身 ─────────────────────────────────────────────
  {
    id: 'M1',
    file: 'dsh-fde-memory/lib/outbox.js',
    desc: 'A3 队列改用文件名字典序（`10` 排在 `2` 前面 ⇒ 重放顺序错乱）',
    from: '  seqs.sort((a, b) => a - b)',
    to: '  seqs.sort() // MUT M1',
    expect: 'A3 ★ 队列按 seq **数值**升序'
  },
  {
    id: 'M2',
    file: 'dsh-fde-memory/lib/outbox.js',
    desc: 'A4 非成员被**静默跳过**（不做 ignored 记账 ⇒ "队列看起来是空的"没人能发现）',
    from: '    else if (name !== STATE_FILE) ignored.push(name)',
    to: '    else if (false) ignored.push(name) // MUT M2',
    expect: 'A4 ★ 非成员进 ignored'
  },
  {
    id: 'M3',
    file: 'dsh-fde-memory/lib/outbox.js',
    desc: 'A6b 顶层是数组也算"读到了"（半懂不懂地当成员读）',
    from: "    if (record === null || typeof record !== 'object' || Array.isArray(record)) {",
    to: '    if (record === null) { // MUT M3',
    expect: 'A6b 顶层是数组也判 {ok:false}'
  },
  {
    id: 'M4',
    file: 'dsh-fde-memory/lib/outbox.js',
    desc: 'A8 seq 不再校验（`0` / 小数 / 字符串会被静默规范化成文件名）',
    from: '  if (!Number.isInteger(seq) || seq < 1) {',
    to: '  if (false) { // MUT M4',
    expect: 'A8 outboxFileOf 拒绝 seq=0'
  },
  {
    id: 'M5',
    file: 'dsh-fde-memory/lib/outbox.js',
    desc: 'B4 `degradeAfterMs` 不再要求为正（0 ⇒ "降级"恒成立 ⇒ L4 退化成恒真）',
    from: '  if (!Number.isFinite(parsed.degradeAfterMs) || parsed.degradeAfterMs <= 0) {',
    to: '  if (false) { // MUT M5',
    expect: 'B4 ★ 坏 degradeAfterMs=0 ⇒ bad'
  },
  {
    id: 'M6',
    file: 'dsh-fde-memory/lib/outbox.js',
    desc: 'B3d 不认 schema（版本不匹配的 state.json 被当成"读到了"）',
    from: '  if (parsed.schema !== STATE_SCHEMA) {',
    to: '  if (false) { // MUT M6',
    expect: 'B3d 缺席档④：schema 不认 ⇒ schema'
  },
  {
    id: 'M7',
    file: 'dsh-fde-memory/lib/outbox.js',
    desc: 'A7 删除恒返 true（分不出"我删的"与"被别人先删了"）',
    from: '  if (!existsSync(p)) return false',
    to: '  if (!existsSync(p)) return true // MUT M7',
    expect: 'A7 删除成功返 true、再删返 false'
  },

  // ── C 组：evaluateRemote 三档 ────────────────────────────────────
  {
    id: 'M8',
    file: 'dsh-fde-memory/lib/telemetry-sink.js',
    desc: 'C1 ★ 把"从未投递过"判成 present（fail-closed 反了：没证据被当成存在）',
    from:
      '    return {\n' +
      "      status: 'missing',\n" +
      '      outageMs: null,\n' +
      "      reason: '从未成功投递过",
    to:
      '    return {\n' +
      "      status: 'present',\n" +
      '      outageMs: null,\n' +
      "      reason: '从未成功投递过",
    expect: 'C1 ★ 从未投递 ⇒ missing'
  },
  {
    id: 'M9',
    file: 'dsh-fde-memory/lib/telemetry-sink.js',
    desc: 'C4 降级边界从 `>=` 变 `>`（阈值那一刻仍判不满足 ⇒ 降级晚一拍生效）',
    from: '  if (outageMs >= state.degradeAfterMs) {',
    to: '  if (outageMs > state.degradeAfterMs) { // MUT M9',
    expect: 'C4 ★ 中断 == 阈值 ⇒ degraded'
  },

  // ── D 组：L3 投递 + 降级 ─────────────────────────────────────────
  {
    id: 'M10',
    file: 'dsh-fde-memory/lib/telemetry-sink.js',
    desc: 'D10 ★ 只写端点被破坏：POST 改成 GET',
    from: "        method: 'POST',",
    to: "        method: 'GET', // MUT M10",
    expect: 'D10 ★ 只写端点：方法是 POST'
  },
  {
    id: 'M11',
    file: 'dsh-fde-memory/lib/telemetry-sink.js',
    desc: 'D11 token 为空时也发 Authorization 头（`Bearer ` 空凭据）',
    from: "      if (cfg.telemetryToken !== '') headers.Authorization = `Bearer ${cfg.telemetryToken}`",
    to: '      headers.Authorization = `Bearer ${cfg.telemetryToken}` // MUT M11',
    expect: 'D11 ★ 双向：token 为空 ⇒ 头对象在、且**没有** Authorization 头'
  },
  {
    id: 'M12',
    file: 'dsh-fde-memory/lib/telemetry-sink.js',
    desc: 'D4 投递成功后**不删**队列条目（重放时会重复投递）',
    from:
      '        removeOutboxSync(root, seq)\n' +
      '        if (state.degradedSince !== null) state.degradedDelivered += 1',
    to:
      '        void seq // MUT M12: 不删\n' +
      '        if (state.degradedSince !== null) state.degradedDelivered += 1',
    expect: 'D4 投递成功 ⇒ 队列文件**被删**'
  },
  {
    id: 'M13',
    file: 'dsh-fde-memory/lib/telemetry-sink.js',
    desc: 'D6 ★ 一条失败不再停（`break` 改 `continue` ⇒ 后一条抢在队头前面投出去，远端看到的顺序与链上不一致）',
    from: '          markFailure(out.error)\n          break\n        }',
    to: '          markFailure(out.error)\n          continue // MUT M13\n        }',
    expect: 'D6 ★ 一条失败就停：被尝试投递的**只有队头那一条**'
  },
  {
    id: 'M14',
    file: 'dsh-fde-memory/lib/telemetry-sink.js',
    desc: 'D7 坏条目被删掉（"有一条投不出去"这件事被抹掉）',
    from: '          markFailure(`队列条目不可读：${r.error}`)\n          continue',
    to: '          markFailure(`队列条目不可读：${r.error}`)\n          removeOutboxSync(root, seq) // MUT M14\n          continue',
    expect: 'D7 坏条目**不删**'
  },
  {
    id: 'M15',
    file: 'dsh-fde-memory/lib/telemetry-sink.js',
    desc: 'D8b 进入降级**不留痕**（spec §8「降级事件本身写入审计」失守）',
    from:
      '      state.degradedSince = t\n' +
      '      audit\n' +
      '        .record({\n' +
      '          type: AUDIT_KINDS.telemetryDegraded,',
    to:
      '      state.degradedSince = t\n' +
      '      false && audit\n' +
      '        .record({\n' +
      '          type: AUDIT_KINDS.telemetryDegraded,',
    expect: 'D8b ★ 中断超阈值 ⇒ 链上出现 telemetry-degraded'
  },
  {
    id: 'M16',
    file: 'dsh-fde-memory/lib/telemetry-sink.js',
    desc: 'D9 恢复**不留痕**（spec §8「恢复后集中提示降级期间有 N 条事件待复核」失守）',
    from: '      const recovered = state.degradedDelivered\n      audit\n        .record({',
    to: '      const recovered = state.degradedDelivered\n      false && audit\n        .record({ // MUT M16',
    expect: 'D9 ★ 恢复 ⇒ 写 telemetry-recovered'
  },
  {
    id: 'M17',
    file: 'dsh-fde-memory/lib/telemetry-sink.js',
    desc: 'D13 写残的 .tmp 被清掉却不留痕（"上次进程被杀过"这个事实消失）',
    from: '  if (swept > 0) {\n    audit\n      .record({',
    to: '  if (false) { // MUT M17\n    audit\n      .record({',
    expect: 'D13 写残的 .tmp 被清掉且留下 telemetry-tmp-swept'
  },

  // ── E 组：phase 侧 L4 ───────────────────────────────────────────
  {
    id: 'M18',
    file: 'dsh-fde-phase/lib/remote-state.js',
    desc: 'E1 ★ 把"没配"判成"不满足"（所有没接远端的部署会在 Phase 4 永久卡死 = spec 要修的那个死锁）',
    from: "    return { applicable: false, status: 'present', reason: '未配置 telemetryStatePath ⇒ 外置审计交叉校验不适用（本地链完整即为完整）' }",
    to: "    return { applicable: true, status: 'missing', reason: 'MUT M18' }",
    expect: 'E1 路径为空 ⇒ applicable:false'
  },
  {
    id: 'M19',
    file: 'dsh-fde-phase/lib/remote-state.js',
    desc: 'E2b ★ "读不到"被判成"没问题"（盲区被说成事实）',
    from: "      status: 'missing',\n      reason: `读不到外置审计降级状态",
    to: "      status: 'present',\n      reason: `读不到外置审计降级状态",
    expect: 'E2b ★ 路径给了但内容坏 ⇒ missing'
  },
  {
    id: 'M20',
    file: 'dsh-fde-phase/lib/guard.js',
    desc: 'E6 括号不再判"本轮跑没跑 D2"（没跑也去读远端状态 ⇒ 不相干的阶段被判失败）',
    from: "  if (!Array.isArray(checks) || !checks.includes('D2')) return null",
    to: '  if (false) return null // MUT M20',
    expect: 'E6 ★ 双向：本轮没跑 D2 ⇒ 括号返回 null'
  },
  {
    id: 'M21',
    file: 'dsh-fde-phase/lib/guard.js',
    desc: 'E7 ★ L4 不通过却照样放行（`AND` 的后半个括号整条失效）',
    from: "      if (remote && remote.applicable && remote.status === 'missing') {",
    to: '      if (false) { // MUT M21',
    expect: 'E7 ★ 链完整但 L4 不通过 ⇒ D2 出现在失败里'
  },
  {
    id: 'M22',
    file: 'dsh-fde-phase/lib/guard.js',
    desc: 'E10 ★ 链**不完整**也被忽略（`AND` 的前半失效 ⇒ 降级模式变成万能钥匙）',
    from: "      const v = mirror.verifyChain('D2', cfg.gateAuditPath)\n      if (!v.ok) {",
    to: "      const v = mirror.verifyChain('D2', cfg.gateAuditPath)\n      if (false) { // MUT M22",
    expect: 'E10 ★ 双向：链**不**完整时降级也救不了'
  },

  // ── F 组：跨包同解 ──────────────────────────────────────────────
  {
    id: 'M23',
    file: 'dsh-fde-phase/lib/remote-state.js',
    desc: 'F2 ★ **只改 phase 一侧**的降级边界（两边判据开始漂移 ⇒ 一边说能过、一边说不能，两边都不报错）',
    from: '  if (outageMs >= state.degradeAfterMs) {',
    to: '  if (outageMs > state.degradeAfterMs) { // MUT M23',
    expect: 'F2 ★ 两边 evaluateRemote 逐例同解'
  },

  // ── G 组：回执呈现面 ────────────────────────────────────────────
  {
    // ⚠️ 第一版这条 `from` 写成了 4 空格缩进（真源码是 2 空格）⇒ 锚点 0 次命中，
    //    变异套件正确判成"无效变异"。**教训**：锚点缩进是**从文件里抄来的**，不是估的。
    id: 'M24',
    file: 'dsh-fde-phase/lib/tools.js',
    desc: 'G1 ★ 降级通过时回执**不写**那段文案（用户看到"通过"却不知道依据弱于正常态）',
    from: "'　🔴 本次通过依赖**审计外置降级模式**（远端不可达已超过阈值）：本地哈希链完整，' +",
    to: "'　（MUT M24：文案被删）' +",
    expect: 'G1 ★ 回执里 `degraded===true` 有专门文案'
  },
  {
    id: 'M25',
    file: 'dsh-fde-phase/lib/tools.js',
    desc: 'G1b 文案改成**无条件打印**（不再是"只在降级时"说 ⇒ 正常通过也被说成依据弱）',
    from: '  if (r.degraded === true) {',
    to: '  if (true) { // MUT M25',
    expect: 'G1b ★ 双向：该文案只在 degraded===true 分支里'
  },

  // ── H 组：config 校验 ───────────────────────────────────────────
  {
    id: 'M26',
    file: 'dsh-fde-memory/lib/config.js',
    desc: 'H2 ★ 降级阈值 0 被放行（"降级"恒成立 ⇒ L4 恒真 ⇒ 门禁静默失效）',
    from: '    if (!Number.isFinite(cfg[k]) || cfg[k] <= 0) {',
    to: '    if (!Number.isFinite(cfg[k]) || cfg[k] < 0) { // MUT M26',
    expect: 'H2 ★ 阈值 0 ⇒ 抛'
  }
]

// ──────────────────────────────────────────────────────────── 沙箱
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SANDBOX, { recursive: true })
function reseed() {
  for (const pkg of ['dsh-fde-memory', 'dsh-fde-phase']) {
    cpSync(join(REPO, pkg, 'lib'), join(SANDBOX, pkg, 'lib'), { recursive: true })
  }
}
reseed()

const before = new Map(PROTECTED.map((r) => [r, sha(join(REPO, r))]))

const lines = []
const sandboxOut = join(SANDBOX, '_fde_d1_out.txt')

/**
 * 跑一次测试，返回 `{exit, reds, complete}`。
 *
 * 🔴 两个"仪器自身的谎"都在这里堵住：
 *   ① **跑前先删结果文件** —— 否则崩溃时会读到**上一轮**的产物，把"崩溃"读成"绿/红"；
 *   ② **完整性判据是结果文件里的收尾行 `（共 N）`**，不是 exit code ——
 *      崩溃与"断言抓住"都表现为"没通过"，靠退出码分不开。
 */
function runTest() {
  rmSync(sandboxOut, { force: true })
  let exit = 0
  try {
    execFileSync(process.execPath, [TEST], {
      cwd: HERE,
      encoding: 'utf8',
      env: { ...process.env, FDE_TEST_ROOT: SANDBOX }
    })
  } catch (e) {
    exit = typeof e.status === 'number' ? e.status : -1
  }
  if (!existsSync(sandboxOut)) return { exit, reds: new Set(), complete: false, why: '结果文件未产出（崩溃/未跑完）' }
  const text = readFileSync(sandboxOut, 'utf8')
  const complete = /（共 \d+）/.test(text)
  const reds = new Set(
    text
      .split('\n')
      .filter((l) => l.startsWith('FAIL '))
      .map((l) => l.slice(5).trim())
  )
  return { exit, reds, complete, why: complete ? '' : '结果文件缺收尾行（报告不完整）' }
}

lines.push('== `_fde_d1_test.mjs` 变异验证（沙箱 = _mut/d1/，**真源码零改动**）==')
lines.push('')

// ── 基线 ────────────────────────────────────────────────────────
lines.push('-- 基线（无变异）--')
let fatal = false
{
  reseed()
  const b = runTest()
  if (!b.complete || b.reds.size > 0 || b.exit !== 0) {
    lines.push(`  ✗ 基线不是全绿：exit=${b.exit} 红=${b.reds.size} 完整=${b.complete}（${b.why}）`)
    lines.push('  ⇒ 基线不成立，本轮作废（先修测试再谈变异）')
    fatal = true
  } else {
    lines.push('  ✓ 基线全绿（exit=0，报告完整）')
  }
}

let red = 0
let green = 0
let invalid = 0

if (!fatal) {
  lines.push('')
  for (const m of MUTANTS) {
    lines.push(`-- ${m.id}：${m.desc} --`)
    reseed()
    const target = join(SANDBOX, m.file)
    const src = readFileSync(target, 'utf8')
    const occurrences = src.split(m.from).length - 1
    if (occurrences !== 1) {
      invalid += 1
      lines.push(`  ⚠️ 无效变异：锚点在 ${m.file} 里出现 ${occurrences} 次（要求恰好 1 次）⇒ 本轮作废重做`)
      lines.push('')
      continue
    }
    writeFileSync(target, src.replace(m.from, m.to), 'utf8')
    const r = runTest()
    if (!r.complete) {
      invalid += 1
      lines.push(`  ⚠️ 无效变异：${r.why}（exit=${r.exit}）⇒ 是崩溃不是断言红，本轮作废重做`)
    } else if ([...r.reds].some((n) => n.startsWith(m.expect))) {
      red += 1
      const others = [...r.reds].filter((n) => !n.startsWith(m.expect))
      lines.push(
        `  ✓ 期望断言红：「${m.expect}…」` +
          (others.length > 0 ? `（另有 ${others.length} 条红：${others.join(' / ')}）` : '') +
          (r.exit !== 0 ? `，exit=${r.exit}` : '，⚠️ 但 exit=0 ⇒ 退出码没跟着变')
      )
    } else {
      green += 1
      lines.push('  ✗ 期望断言**没红**：变异未被抓住 ⇒ 该判据对这条缺陷是盲的')
      lines.push(`      实际红名单：${[...r.reds].map((s) => `「${s}」`).join(' / ') || '（空）'}`)
    }
    lines.push('')
  }
}

// 🔴 沙箱留在**最后一条变异**的状态里会变成一个陷阱：它长得跟源码一模一样，
//    将来有人 `grep` 到它就以为自己看到了源码。⇒ 收尾 reseed 一次，让沙箱 ≡ 源。
//    （保留目录而不是删掉，是为了失败时还能进去看现场。）
reseed()

// ── 真源码未被触碰（这一节是本套件沙箱设计的**证据**，不是补救）──
lines.push('-- 真源码核对（沙箱设计 ⇒ 期望逐字未变）--')
let touched = 0
for (const rel of PROTECTED) {
  const now = sha(join(REPO, rel))
  const same = now === before.get(rel)
  if (!same) touched += 1
  lines.push(`  ${same ? '✓' : '✗'} ${rel}${same ? '' : `  ${before.get(rel)} → ${now}`}`)
}
if (touched > 0) lines.push(`  ✗ 有 ${touched} 个真源码文件被改动 ⇒ 沙箱隔离失效，必须手工还原`)

lines.push('')
lines.push(`红 ${red} / 绿 ${green} / 无效 ${invalid}（共 ${MUTANTS.length} 条）`)
let exitCode = 0
if (fatal || touched > 0) {
  lines.push('RESULT: INVALID（基线不成立或真源码被污染）')
  exitCode = 2
} else if (green > 0 || invalid > 0) {
  lines.push('RESULT: FAIL')
  exitCode = 1
} else {
  lines.push('RESULT: PASS（全部变异被期望的具名断言抓住，且真源码逐字未变）')
}

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(`[d1-mut] 结果已写入 ${OUT}：红 ${red} / 绿 ${green} / 无效 ${invalid}`)
process.exitCode = exitCode
