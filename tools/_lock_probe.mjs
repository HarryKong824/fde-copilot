/**
 * 判据⑧ 无模型探针 —— 直接打**已部署**的 state.js / audit.js，验单写者锁的两条分支。
 * 用临时 projectRoot，不碰活体 state.yaml / .state.lock。
 *
 *  A1 未过期锁（真时钟，at=现在）→ writeState 必须抛「锁未过期」+ 持有者 pid
 *  A2 过期锁（at=10 分钟前）    → writeState 必须成功，且审计落一条 lock-steal（oldPid 正确）
 *  A3 强夺后                   → 锁文件必须被释放（finally）
 *  A4 另一进程的锁             → 被拒时**不得**删掉别人的锁（throw 在 try 之前）
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const D = 'file:///E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/node_modules/dsh-fde-phase/lib'
const { writeState, readStateSync } = await import(`${D}/state.js`)
const { AuditChain } = await import(`${D}/audit.js`)

const cases = []
const rec = (name, ok, detail) => cases.push({ name, ok, detail })

const TTL = 30000
const newRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'lockprobe-'))
  mkdirSync(join(root, 'memory'), { recursive: true })
  return root
}
const forge = (lockPath, atIso, pid) =>
  writeFileSync(lockPath, JSON.stringify({ pid, at: atIso }))

// ---------- A1 未过期锁（真时钟）----------
{
  const root = newRoot()
  const sp = join(root, 'memory', 'state.yaml')
  const lp = join(root, 'memory', '.state.lock')
  forge(lp, new Date().toISOString(), 999999) // at = 现在，真时钟，未过期
  let msg = null
  try {
    await writeState(sp, lp, (c) => ({ ...c, current_phase: '6' }), TTL, null)
  } catch (e) {
    msg = e.message
  }
  rec('A1 未过期锁 → 拒绝', msg !== null && /锁未过期/.test(msg) && /pid=999999/.test(msg), msg ?? '(竟然放行了)')
  rec('A4 被拒时不删别人的锁', existsSync(lp), existsSync(lp) ? '锁文件仍在 ✓' : '🔴 锁被删了')
  rec('A1 state 未被改动', readStateSync(sp).current_phase !== '6', `current_phase=${readStateSync(sp).current_phase ?? '(空)'}`)
}

// ---------- A2/A3 过期锁 → 强夺 ----------
{
  const root = newRoot()
  const sp = join(root, 'memory', 'state.yaml')
  const lp = join(root, 'memory', '.state.lock')
  const auditPath = join(root, 'audit.jsonl')
  const audit = new AuditChain(auditPath)
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString() // 10 分钟前 > TTL 30s
  forge(lp, old, 999998)
  let ok = false
  let detail = ''
  try {
    const next = await writeState(sp, lp, (c) => ({ ...c, current_phase: '6' }), TTL, audit)
    await audit.flush()
    ok = next.current_phase === '6'
    detail = `current_phase=${next.current_phase}, revision=${next.revision}`
  } catch (e) {
    detail = '🔴 竟然抛错：' + e.message
  }
  rec('A2 过期锁 → 强夺成功', ok, detail)

  const lines = readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const steal = lines.find((r) => r.decision === 'lock-steal')
  rec(
    'A2 审计有 lock-steal 且 oldPid 正确',
    !!steal && steal.oldPid === 999998 && steal.type === 'lock',
    steal ? JSON.stringify({ type: steal.type, decision: steal.decision, oldPid: steal.oldPid }) : '🔴 没有 lock-steal 记录'
  )
  rec('A3 强夺后锁被释放', !existsSync(lp), existsSync(lp) ? '🔴 锁仍在' : '锁已释放 ✓')
  const tmp = readdirSync(join(root, 'memory')).filter((f) => f.endsWith('.tmp'))
  rec('A3 无 .tmp 残留', tmp.length === 0, tmp.length ? tmp.join(',') : '无 ✓')
}

const failed = cases.filter((c) => !c.ok)
const out = [
  ...cases.map((c) => `${c.ok ? 'OK  ' : 'FAIL'} ${c.name}\n       → ${c.detail}`),
  '',
  `通过 ${cases.length - failed.length}/${cases.length}`,
  `RESULT: ${failed.length === 0 ? 'ALL-PASS' : 'HAS-FAIL'}`
]
writeFileSync('_lock_probe_out.txt', out.join('\n') + '\n', 'utf8')
process.exitCode = failed.length === 0 ? 0 : 1
