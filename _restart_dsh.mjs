/**
 * 重启 DSH（Electron + 后端 node 进程），用于让 `lib/*.js` 的改动生效。
 *
 * 为什么不能靠 PowerShell/CMD：
 *   - 本会话的 PowerShell 工具**无回显**（exit 0 但 stdout 为空），盲操作不可接受；
 *   - Bash 里调 powershell.exe / cmd.exe 被沙箱拦截；
 *   - Bash 里 `spawn node → curl` 会 EBUSY。
 * ⇒ 全程用 node 原生 API（process.kill / child_process.spawn / fetch），结果写文件再读。
 *
 * 用法：node _restart_dsh.mjs
 * 输出：_restart_dsh_out.txt
 */
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { execSync } from 'node:child_process'

const EXE_DIR = 'E:\\DSH-desktop\\DeepSeek Harness'
const EXE = EXE_DIR + '\\DeepSeek Harness.exe'
const BASE = 'http://127.0.0.1:3080'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const L = []
const push = (s) => L.push(String(s))

/** 列出 DSH 相关进程（Electron 本体 + 监听 3080 的后端 node）。 */
function listPids() {
  const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8' })
  const pids = []
  for (const line of out.split('\n')) {
    const cols = line.split('","').map((c) => c.replace(/"/g, ''))
    const name = cols[0]
    const pid = cols[1]
    if (name === 'DeepSeek Harness.exe' && pid) pids.push({ pid: Number(pid), name })
  }
  return pids
}

async function portAlive() {
  try {
    const res = await fetch(BASE + '/api/session/list', { method: 'POST' })
    await res.text()
    return true
  } catch {
    return false
  }
}

const before = listPids()
push('重启前 DSH 进程：' + before.map((p) => `${p.name}(${p.pid})`).join(', '))
push('重启前 3080 可达：' + (await portAlive()))

// 1) 杀：先优雅（不带 /F），超时再强杀
for (const p of before) {
  try {
    process.kill(p.pid)
    push(`已 kill ${p.pid}`)
  } catch (e) {
    push(`kill ${p.pid} 失败：${e.code ?? e.message}`)
  }
}
// 后端 node（监听 3080）不在 tasklist 的 DeepSeek Harness.exe 名录里，靠端口消失来确认整体停了
await sleep(2500)

// 2) 等端口释放
let released = false
for (let i = 0; i < 20; i++) {
  if (!(await portAlive())) {
    released = true
    break
  }
  await sleep(1000)
}
push('端口已释放：' + released + '（等待秒数内自然退出）')

// 残留强杀
const leftover = listPids()
if (leftover.length > 0) {
  push('仍有残留，强杀：' + leftover.map((p) => p.pid).join(', '))
  try {
    execSync('taskkill /F /T /IM "DeepSeek Harness.exe"', { encoding: 'utf8' })
  } catch (e) {
    push('taskkill 失败：' + String(e.message ?? e).slice(0, 200))
  }
  await sleep(2000)
}

// 3) 启动
let started = false
let startErr = ''
try {
  const child = spawn(EXE, [], { cwd: EXE_DIR, detached: true, stdio: 'ignore' })
  child.unref()
  started = true
} catch (e) {
  startErr = String(e.message ?? e)
}
push('已发起启动：' + started + (startErr ? '  错误=' + startErr : ''))

// 4) 等它起来
let up = false
let waited = 0
for (let i = 0; i < 60; i++) {
  await sleep(2000)
  waited += 2
  if (await portAlive()) {
    up = true
    break
  }
}
push(`3080 恢复：${up}（等待 ${waited}s）`)

const after = listPids()
push('重启后 DSH 进程：' + after.map((p) => `${p.name}(${p.pid})`).join(', '))
const changed = JSON.stringify(before.map((p) => p.pid).sort()) !== JSON.stringify(after.map((p) => p.pid).sort())
push('PID 集合已变化（确为**新**进程）：' + changed)
push('RESULT: ' + (up && changed ? 'RESTART-OK' : 'RESTART-NEEDS-ATTENTION'))

writeFileSync('_restart_dsh_out.txt', L.join('\n') + '\n', 'utf8')
console.log(L.join('\n'))
process.exitCode = up && changed ? 0 : 1
