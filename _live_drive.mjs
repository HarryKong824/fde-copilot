/**
 * 活体驱动脚本（Typert HTTP RPC）—— 开/续会话、发 prompt、等回合结束、导出 transcript。
 *
 * 用法：
 *   node _live_drive.mjs --new "<prompt>"                 新建会话并发一条
 *   node _live_drive.mjs --sid <sessionId> "<prompt>"     续会话再发一条
 *   node _live_drive.mjs --tools <sessionId>              只回读该会话的工具调用与结果
 *
 * 输出：控制台一行摘要 + 明细落 _live_drive_out.txt（Windows 代码页乱码规避）。
 */
import { writeFileSync, appendFileSync, existsSync, rmSync, readFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3080'
const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const CWD = 'E:\\DSH-workspace'

let rpcSeq = 0
/**
 * 发 RPC —— **用 node 原生 fetch，不再起 curl 子进程**。
 *
 * ⚠️ 环境变更（2026-09-25 第二批）：本沙箱里 `spawnSync('curl')` 稳定报 EBUSY，
 * 历史脚本走 curl 的路已经走不通了。改 fetch 后要自己处理鉴权 cookie：
 * 从 curl 的 Netscape cookie jar 里拼 Cookie 头。
 *
 * 🔴 jar 解析有一个坑：`#HttpOnly_` 前缀的行是**带 HttpOnly 标记的正常 cookie**，不是注释。
 * 按 `#` 开头一律跳过 ⇒ 唯一那条 `dsh-auth-*` 会被丢掉 ⇒ 回包体是明文 `unauthorized`（不是 JSON）。
 */
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
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${method} 返回非 JSON（多半缺 auth cookie）：${text.slice(0, 200)}`)
  }
  if (json.result && json.result.ok === false) {
    throw new Error(`${method} 失败: ${JSON.stringify(json.result.error)}`)
  }
  return json.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function asOfSeq(sessionId) {
  const v = await rpc('session/list', { _request: {} })
  const items = v?.items ?? []
  const it = items.find((x) => (x.sessionId ?? x.id) === sessionId)
  return it?.projections?.asOfSeq ?? 0
}

async function readRecords(sessionId, throughSeq) {
  const v = await rpc('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq }
  })
  return v?.records ?? []
}

/**
 * 当前会话里已出现的最大 turn 号（0 = 还没有任何回合）。
 * 🔴 用途：`--sid` 续会话时，**上一回合的 `finish` chunk 仍然在记录里**。
 *    若 `waitSettle` 不设基线，它会在第一次轮询就命中那个旧 finish 并立刻返回
 *    ⇒ 新回合整个被丢掉，表现为「工具事件 0 条」+ 回显上一轮的文本。
 *    （2026-09-29 实测：E4 第五层活验因此被误读成"模型没调工具"，而 transcript 里
 *      `tool/call`/`tool/result` 都在。**这是仪器缺陷，不是模型行为。**）
 */
async function maxTurn(sessionId) {
  const s = await asOfSeq(sessionId)
  const recs = await readRecords(sessionId, s)
  let m = 0
  for (const r of recs) {
    const ev = r.event ?? r
    const t = ev?.data?.turn
    if (typeof t === 'number' && t > m) m = t
  }
  return m
}

/**
 * 等回合真结束。
 *
 * ⚠️ 别用「asOfSeq 连续几次不变」判 —— 模型在两次工具调用之间可以静默思考很久，
 * 那次 asOfSeq 稳定 7.5s 后直接从 565 跳到 2729，早退会漏掉整个回合。
 *
 * 正解：看最后一个 `assistant/chunk` 的 `chunk.type === 'finish'`，
 * 其 `reason.kind !== 'tool-calls'` 即本回合不再发起工具调用（回合结束）。
 */
async function waitSettle(sessionId, minTurn = 0, maxMs = 420000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const s = await asOfSeq(sessionId)
    const recs = await readRecords(sessionId, s)
    let lastFinish = null
    let lastFinishTurn = 0
    let lastStepEnd = 0
    for (const r of recs) {
      const ev = r.event ?? r
      if (ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'finish') {
        lastFinish = ev.data.chunk
        lastFinishTurn = ev.data.turn ?? 0
      }
      if (ev.type === 'step/end') lastStepEnd++
    }
    // 🔴 `lastFinishTurn > minTurn`：只认**本回合**（或更新的回合）的 finish，别拿旧回合的交差。
    if (lastFinish && lastFinishTurn > minTurn && lastStepEnd > 0 && lastFinish.reason?.kind !== 'tool-calls') return s
    await sleep(4000)
  }
  // 超时：主动取消，别让模型继续跑野
  await rpc('session/cancel', { request: { sessionId } }).catch(() => {})
  return await asOfSeq(sessionId)
}

function summarize(records) {
  const out = []
  // callId → 工具名：`tool/result` 的 data 里**没有** name，只有 `message.source.callId`
  const nameByCallId = new Map()
  for (const r of records) {
    const ev = r.event ?? r
    if (ev?.type === 'tool/call') {
      const d = ev.data ?? {}
      if (d.callId) nameByCallId.set(d.callId, d.name)
    }
  }
  for (const r of records) {
    const ev = r.event ?? r
    const t = ev?.type
    if (t === 'tool/call') {
      const d = ev.data ?? {}
      out.push({ kind: 'call', name: d.name, args: d.arguments ?? d.args })
    } else if (t === 'tool/result') {
      const d = ev.data ?? {}
      // 🔴 真实形态是两层：`content[0]` 是 `{type:'tool-result', content:[{type:'text',text}]}`。
      //    早先只读 `content[0].text` ⇒ 恒 undefined ⇒ 结果永远打印成空。
      const block = d.message?.content?.[0] ?? {}
      const inner = (block.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('')
      out.push({
        kind: 'result',
        name: nameByCallId.get(block.toolCallId ?? d.message?.source?.callId) ?? block.toolCallId ?? '?',
        isError: block.isError ?? false,
        text: inner || String(block.text ?? '')
      })
    } else if (t === 'message/assistant' || t === 'message' || t === 'assistant/message') {
      const c = (ev.data?.message?.content ?? []).filter((x) => x.type === 'text')
      const txt = c.map((x) => x.text).join('')
      if (txt.trim()) out.push({ kind: 'say', text: txt })
    }
  }
  return out
}

const argv = process.argv.slice(2)
const mode = argv[0]
let sessionId = null
let prompt = null
if (mode === '--new') prompt = argv[1]
else if (mode === '--sid') { sessionId = argv[1]; prompt = argv[2] }
else if (mode === '--tools') sessionId = argv[1]
else { console.error('用法见文件头'); process.exit(2) }

const lines = []
const log = (s) => { lines.push(s); console.log(s) }

if (!sessionId) {
  // ⚠️ 必须指定 preset：默认是 ptc（工具经 run_code 转发），而 gate 按设计拒 run_code
  // → ptc 会话里模型一条工具都调不到。standard 才是直接调用工具的模式。
  const created = await rpc('session/create', { request: { cwd: CWD, agentPreset: 'standard' } })
  sessionId = created?.sessionId ?? created?.id ?? created?.session?.sessionId
  log(`[新会话] ${sessionId}`)
  if (!sessionId) { log('创建会话失败：' + JSON.stringify(created)); process.exit(1) }
}

if (prompt) {
  // 🔴 发问之前先取基线 turn：续会话时旧回合的 finish 还在记录里（见 maxTurn 注释）
  const baseTurn = await maxTurn(sessionId)
  log(`[发出] ${prompt}`)
  await rpc('session/prompt', {
    request: {
      sessionId,
      requestId: `req-${Date.now()}`,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }]
    }
  })
  const seq = await waitSettle(sessionId, baseTurn)
  log(`[回合结束] asOfSeq=${seq}（基线 turn=${baseTurn}，等待 turn>${baseTurn} 的 finish）`)
}

const seq = await asOfSeq(sessionId)
const records = await readRecords(sessionId, seq)
const items = summarize(records)
log(`[记录] ${records.length} 条，其中工具事件 ${items.filter((i) => i.kind !== 'say').length} 条`)
for (const it of items) {
  if (it.kind === 'call') log(`  → 调用 ${it.name} args=${JSON.stringify(it.args)}`)
  else if (it.kind === 'result') log(`  ← ${it.isError ? 'ERROR' : 'ok'} ${it.name}: ${it.text.slice(0, 400).replace(/\n/g, ' | ')}`)
  else log(`  💬 ${it.text.slice(0, 600).replace(/\n/g, ' | ')}`)
}

if (!existsSync('_live_drive_out.txt')) rmSync('_live_drive_out.txt', { force: true })
appendFileSync('_live_drive_out.txt', `\n===== session=${sessionId} =====\n` + lines.join('\n') + '\n', 'utf8')
writeFileSync('_live_session_id.txt', sessionId, 'utf8')
