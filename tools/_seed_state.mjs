/**
 * 把活环境的 state.yaml 种到指定阶段（用**已部署**的 state.js 写，保证格式与插件同源）。
 * 用法：node _seed_state.mjs <phase>
 *
 * 为什么要种：D1 门禁挂在 DENY_CHECKS['3'] 上，只有 current_phase === '3' 时
 * 推进 3→4 才会触发 D1。从 0.1 一路推上去要 7 次模型往返，种一下更快也更可控。
 */
import { join } from 'node:path'

const DEPLOY = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/node_modules/dsh-fde-phase/lib'
const { writeState } = await import(`file:///${DEPLOY}/state.js`)

const projectRoot = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state'
const phase = process.argv[2] ?? '3'

const statePath = join(projectRoot, 'memory', 'state.yaml')
const lockPath = join(projectRoot, 'memory', '.state.lock')

const next = await writeState(
  statePath,
  lockPath,
  (cur) => ({ ...cur, current_phase: phase, phase_status: 'in_progress' }),
  30000,
  null
)

console.log(`已种入 current_phase=${next.current_phase} revision=${next.revision}`)
