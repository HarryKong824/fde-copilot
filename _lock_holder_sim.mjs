/**
 * 模拟"另一进程正在持有锁"：每 2 秒把 .state.lock 的 at 刷成当前时刻。
 *
 * 为什么要刷新：本插件 lockTtlMs=30000，而一次模型回合要 30–90 秒 ——
 * 若只写一次时间戳，模型真正调用时锁早已过期、会被判强夺，测不到「未过期 → 拒绝」。
 * 持续刷新的持有者才是"锁未过期"的忠实形态。
 *
 * 自终止：默认 240 秒后退出，不留孤儿进程。
 * 用法：node _lock_holder_sim.mjs [秒数]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const SECONDS = Number(process.argv[2] ?? 240)
const LOCK = join(
  'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state',
  'memory',
  '.state.lock'
)
const PID = 777777

mkdirSync(dirname(LOCK), { recursive: true })
const t0 = Date.now()
const tick = () => {
  writeFileSync(LOCK, JSON.stringify({ pid: PID, at: new Date().toISOString() }))
}
tick()
const iv = setInterval(() => {
  tick()
  if (Date.now() - t0 > SECONDS * 1000) {
    clearInterval(iv)
    console.log(`[holder-sim] 已刷新 ${SECONDS}s，退出（锁文件保留，需手动删）`)
  }
}, 2000)
console.log(`[holder-sim] 开始持有锁 pid=${PID}，每 2s 刷新，${SECONDS}s 后自终止`)
