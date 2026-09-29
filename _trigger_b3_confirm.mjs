/**
 * 触发 B3 confirmed 弹窗 —— **新建干净会话**（不带"前三次 abort"的污染记忆）发 advance 指令，
 * 但**不超时取消**，让 approval 弹窗一直挂着，等用户在 DSH 桌面端点 Allow once。
 *
 * 为什么新开会话：session-0d5f498b 已经记下"advance 三次 abort"，模型这次会改调
 * ask_user_question 而不碰 advance。新会话没有这段记忆，会直接调用 advance。
 *
 * 与 _live_drive.mjs 的区别：后者 waitSettle 420s 超时后 session/cancel → approval cancelled
 * → 每次都被降级成 degraded。本脚本发完 prompt 就退出，不碰 cancel，弹窗可持续挂起。
 *
 * 用法：node _trigger_b3_confirm.mjs
 * 前置：state.yaml 已 seed 到 current_phase:"2"（脚本会顺带做，不依赖 python）。
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3080'
const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const CWD = 'E:\\DSH-workspace'
const STATE = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory/state.yaml'

function cookieHeader() {
  if (!existsSync(JAR)) return ''
  const parts = []
  for (const raw of readFileSync(JAR, 'utf8').split('\n')) {
    let line = raw.trim()
    if (!line) continue
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const cols = line.split('\t')
    if (cols.length < 7) continue
    parts.push(`${cols[5]}=${cols[6]}`)
  }
  return parts.join('; ')
}

let rpcSeq = 0
async function rpc(method, argsObj) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `d${++rpcSeq}`,
    method,
    payload: { args: argsObj }
  })
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { throw new Error(`${method} 返回非 JSON：${text.slice(0, 200)}`) }
  if (json.result && json.result.ok === false) throw new Error(`${method} 失败: ${JSON.stringify(json.result.error)}`)
  return json.result?.value
}

// 1. seed state 回 phase 2（revision 是工具写入的计数器，不手改）
const st = readFileSync(STATE, 'utf8')
const seeded = st.replace(/current_phase:\s*"[^"]*"/, 'current_phase: "2"')
if (seeded !== st) {
  writeFileSync(STATE, seeded, 'utf8')
  console.log('[seed] current_phase → "2"')
} else {
  console.log('[seed] current_phase 已是 "2"')
}

// 2. 新建干净会话（standard preset，否则工具经 run_code 转发、gate 拒 run_code）
const created = await rpc('session/create', { request: { cwd: CWD, agentPreset: 'standard' } })
const sessionId = created?.sessionId ?? created?.id ?? created?.session?.sessionId
console.log(`[新会话] ${sessionId}`)
if (!sessionId) { console.log('创建会话失败：' + JSON.stringify(created)); process.exit(1) }

// 3. 发 advance 指令（不 waitSettle、不 cancel）
const prompt = '请调用 fde_phase_advance：to=3，reason=完成数据接入前置检查并进入 Ontology 完整定义阶段，data_authorization=患者已签署知情同意书授权使用脱敏后的 MRI 影像与结构化诊断字段，deidentification_plan=MRI 影像去除 DICOM 头部 PHI 仅保留影像像素与诊断标签。这会弹出确认窗，请等待用户点 Allow once。'
await rpc('session/prompt', {
  request: {
    sessionId,
    requestId: `req-b3-${Date.now()}`,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }]
  }
})
console.log('[已发出] advance 指令 → 弹窗挂起中，等用户在 DSH 桌面端点 Allow once')
console.log(`[会话] ${sessionId}`)
writeFileSync('_b3_confirm_session_id.txt', sessionId, 'utf8')
console.log('脚本结束（不 cancel，弹窗持续挂起）')
