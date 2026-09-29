/**
 * 判据⑧ 的**活体版**探针 —— 把 `_lock_probe.mjs` 的 A1/A4 分支指向**真 projectRoot**。
 *
 * 为什么只跑 A1/A4（拒绝分支），不跑 A2/A3（强夺分支）：
 *   强夺成功 ⇒ `writeState` 会**真的写 state.yaml**（改 current_phase / revision / updated_at）
 *   ⇒ 那是真实业务状态变更。离线版用临时 projectRoot 才敢跑。
 *
 * 为什么活体版是安全的（三层）：
 *   ① 只走「未过期 ⇒ 拒绝」分支 ⇒ `acquireLock` 先抛，`writeState` 根本到不了写盘；
 *   ② mutator 写成**抛错函数** —— 万一锁逻辑失效让流程走下去了，它在写盘前拦住，
 *      `state.yaml` 依然一个字节不动（这是**独立于锁**的第二道防线）；
 *   ③ `audit` 传 `null` ⇒ **链上零字节写入**（连 lock-contended 都不记）。
 *
 * 判据（跑前跑后必须同时成立）：
 *   L1 真 state.yaml 的 sha256 跑前跑后**必须相同**（这是本脚本存在的主要理由）
 *   L2 未过期锁（真时钟 at=now，pid=999999）→ writeState 必须抛，且文案含「锁未过期」+ pid
 *   L3 被拒而不动别人的锁 ⇒ 我造的那个锁文件**必须还在**
 *   L4 锁文件内容未被篡改（pid 仍是 999999 —— 证明确实是"拒绝"不是"强夺后重写"）
 *   L5 前置：开跑前**真 projectRoot 不许已有锁**（否则中止 —— 绝不覆盖真锁）
 *   L6 收尾：清理后锁文件必须消失（不给活体留残余）
 *
 * 不碰：不 import 模型、不走 guard/approval、不改 phase、不写任何链。
 */
import { readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const D = 'file:///E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/node_modules/dsh-fde-phase/lib'
const { writeState } = await import(`${D}/state.js`)

/** 真 projectRoot —— 与 cordis.patch.yml 里 phase 的 projectRoot 一致。 */
const ROOT = 'E:\\DSH-desktop\\DeepSeek Harness\\data\\dsh-home\\fde-state'
const STATE = join(ROOT, 'memory', 'state.yaml')
const LOCK = join(ROOT, 'memory', '.state.lock')
const TTL = 30000

const cases = []
const rec = (name, ok, detail) => cases.push({ name, ok, detail })

/**
 * 判「这是一次锁拒绝」—— **判类不判措辞**。
 *
 * 🔴 第一版写成 `/锁未过期/` 一条正则 ⇒ L7 当场假红：`acquireLock` 有**两个拒绝分支**，
 *    文案不同（未过期 / 已超时但持有进程仍存活），我只断言了前者。
 *    这与 `live-A2`（种类 vs 条数）同族：**用分支的具体措辞代替了"拒绝"这个类**。
 *    稳定判据 = ①抛了错 ②文案里带本案例那个 PID（⇒ 确实是锁分支，不是别的异常）
 *    ③拒绝语义之一。措辞只作辅助，结构（sha 未变 / 未走到 mutator）才是主证据。
 */
const isLockRefusal = (m, pid) =>
  typeof m === 'string' && m.includes(`pid=${pid}`) && /锁未过期|仍存活|不自动释放/.test(m)
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// ---------- L5 前置：不能已有真锁 ----------
if (existsSync(LOCK)) {
  console.log('🔴 中止：真 projectRoot 已存在 .state.lock —— 绝不覆盖真锁。')
  console.log('   请先确认没有并发写，人工处理该锁后再跑。')
  process.exitCode = 2
} else {
  rec('L5 前置：真 projectRoot 开跑前无锁', true, `${LOCK} 不存在 ✓`)

  const shaBefore = sha(STATE)
  const stateBefore = readFileSync(STATE, 'utf8')

  // 造锁：真时钟 at=now ⇒ 保证未过期（同进程内立刻调用，无模型回合时延）
  writeFileSync(LOCK, JSON.stringify({ pid: 999999, at: new Date().toISOString() }))

  let msg = null
  let fallthrough = false
  try {
    await writeState(
      STATE,
      LOCK,
      // ② 第二道防线：真走到写盘就会在这里炸，state.yaml 依然不动
      () => {
        fallthrough = true
        throw new Error('🔴 不该走到 mutator —— 锁逻辑失效，写盘已被此处拦住')
      },
      TTL,
      null // ③ 不写审计
    )
  } catch (e) {
    msg = e.message
  }

  rec(
    'L2 未过期锁（真 projectRoot）→ 拒绝',
    isLockRefusal(msg, 999999),
    msg ?? '(竟然放行了 —— 见 L1)'
  )
  rec('L1 真 state.yaml 的 sha256 未变', sha(STATE) === shaBefore, `${shaBefore.slice(0, 16)}… → ${sha(STATE).slice(0, 16)}…`)
  rec('L1b 真 state.yaml 内容逐字未变', readFileSync(STATE, 'utf8') === stateBefore, `长度 ${stateBefore.length} → ${readFileSync(STATE, 'utf8').length}`)
  rec('L3 被拒时不删别人的锁', existsSync(LOCK), existsSync(LOCK) ? '锁文件仍在 ✓' : '🔴 锁被删了')
  if (existsSync(LOCK)) {
    const info = JSON.parse(readFileSync(LOCK, 'utf8'))
    rec('L4 锁未被篡改（pid 仍是 999999 ⇒ 是「拒绝」不是「强夺后重写」）', info.pid === 999999, JSON.stringify(info))
  }
  rec('L2b 没走到 mutator（第二道防线未被触发）', !fallthrough, fallthrough ? '🔴 锁逻辑失效，靠 mutator 才拦住写盘' : '未触发 ✓')

  // ---------- L7 「超时 + 持有 PID 活」→ 仍必须拒绝（A2 的核心：PID 存活检测）----------
  // `state.js` 的强夺条件是 `stale = timedOut && holderDead`（双条件）。上面 L2 只验了
  // 「未过期」那一半；这一半才是 PID 检测本身：**超时了，但持有进程还活着 ⇒ 不抢**
  // （进程可能在跑长任务）。同样走拒绝分支 ⇒ 不写 state.yaml ⇒ 活体上安全。
  // 用**本进程的真 PID** ⇒ `pidAlive` 必然 true ⇒ 只要 PID 检测是对的，就不可能走到强夺。
  rmSync(LOCK, { force: true })
  writeFileSync(
    LOCK,
    JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 10 * 60 * 1000).toISOString() })
  )
  const myPid = process.pid
  let msg7 = null
  let ft7 = false
  try {
    await writeState(
      STATE,
      LOCK,
      () => {
        ft7 = true
        throw new Error('🔴 不该走到 mutator —— 它强夺了一个活进程的锁')
      },
      TTL,
      null
    )
  } catch (e) {
    msg7 = e.message
  }
  rec(
    'L7 超时(10分钟前)但持有 PID 活(本进程真 PID) → 仍拒绝',
    isLockRefusal(msg7, myPid),
    msg7 ?? `(竟然放行了 —— 强夺了活进程 pid=${myPid} 的锁)`
  )
  rec('L7b 该分支下 state.yaml sha 未变', sha(STATE) === shaBefore, shaBefore.slice(0, 16) + '…')
  rec('L7c 该分支下未走到 mutator（没强夺活进程的锁）', !ft7, ft7 ? `🔴 强夺了 pid=${myPid} 的锁` : '未触发 ✓')
  // ⚠️ 这条**不是判据**、是陈述：`pid=本进程` 必然存活，写进 `rec()` 就是一条恒真式，
  //    会白白虚增"通过 N/N"里的一格。恒真式只能当打印，不许进判据集。
  console.log(`[陈述] L7 用的持有者 PID = ${myPid}（本进程自身，故 pidAlive 必然为 true —— 这不是判据）`)
  rmSync(LOCK, { force: true })

  // ---------- L6 收尾清理 ----------
  rmSync(LOCK, { force: true })
  rec('L6 收尾：清理后锁已消失（不给活体留残余）', !existsSync(LOCK), existsSync(LOCK) ? '🔴 锁仍在' : '锁已清理 ✓')
  rec('L6b 收尾后 state.yaml sha 仍等于跑前', sha(STATE) === shaBefore, shaBefore.slice(0, 16) + '…')

  console.log('真 projectRoot: ' + ROOT)
  console.log('state.yaml mtime: ' + statSync(STATE).mtime.toISOString())
}

const failed = cases.filter((c) => !c.ok)
const out = [
  ...cases.map((c) => `${c.ok ? 'OK  ' : 'FAIL'} ${c.name}\n       → ${c.detail}`),
  '',
  `通过 ${cases.length - failed.length}/${cases.length}`,
  `RESULT: ${failed.length === 0 ? 'ALL-PASS' : 'HAS-FAIL'}`
]
writeFileSync('_lock_probe_live_out.txt', out.join('\n') + '\n', 'utf8')
console.log(out.join('\n'))
process.exitCode = failed.length === 0 ? 0 : 1
