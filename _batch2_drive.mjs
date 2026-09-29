/**
 * 第二批活验驱动器（会话 A / B 的建立、发 prompt、等 header、读 header）。
 *
 * 用法：
 *   node _batch2_drive.mjs create                      创建 standard preset 会话
 *   node _batch2_drive.mjs send <sid> <文本>           发一条 prompt 并轮询到 header 出现
 *   node _batch2_drive.mjs headers <sid>               只读：列出全部 request/header
 *   node _batch2_drive.mjs advance <sid> <wantPhase>   让会话里的模型调 fde_phase_advance 推进，
 *                                                      轮询 state.yaml 直到 current_phase 变化（上限 300s）
 *
 * 为什么不复用 `_live_drive.mjs`：它发完 prompt 会 `waitSettle()` 等**整个回合结束**
 * （默认上限 420s）。而本批要的证据（一条 `request/header`）在**请求发出的那一刻**就落盘了
 * ⇒ 等回合结束既要多花几分钟 LLM 时间，又会让模型有机会调别的工具（副作用面变大）。
 * 这里改成「发完 prompt ⇒ 轮询 header 出现 ⇒ 立即取证」，回合让它自己在后台收尾。
 *
 * ⚠️ cookie jar 内容绝不打印（只用于构造 Cookie 头）。
 * 只读程度：create / send 会改动活体（建会话、起回合），headers 只读。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const BASE = 'http://127.0.0.1:3080'
const CWD = 'E:\\DSH-workspace'
const OUT = '_batch2_drive_out.txt'

const lines = []
const log = (s) => {
  lines.push(s)
  console.log(s)
}

function cookieHeader() {
  if (!existsSync(JAR)) throw new Error('cookie jar 不存在: ' + JAR)
  const parts = []
  for (let line of readFileSync(JAR, 'utf8').split(/\r?\n/)) {
    line = line.trim()
    if (!line) continue
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const f = line.split('\t')
    if (f.length < 7) continue
    parts.push(`${f[5]}=${f[6]}`)
  }
  if (!parts.length) throw new Error('cookie jar 里没解析出任何 cookie')
  return parts.join('; ')
}

let n = 0
async function rpc(method, argsObj) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body: JSON.stringify({ type: 'client-request', rpcId: `b2-${++n}-${Date.now()}`, method, payload: { args: argsObj } })
  })
  const text = await res.text()
  let j
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(`${method}: 回包不是 JSON（多半缺 auth cookie）→ ${text.slice(0, 120)}`)
  }
  if (j.result?.ok === false) throw new Error(`${method}: ${JSON.stringify(j.result.error).slice(0, 300)}`)
  return j.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function asOfSeq(sid) {
  const list = await rpc('session/list', { _request: {} })
  const it = (list?.items ?? []).find((x) => (x.sessionId ?? x.id) === sid)
  return it?.projections?.asOfSeq ?? 0
}

async function pageOf(sid, throughSeq) {
  const page = await rpc('session/page', {
    request: { address: { kind: 'session', sessionId: sid }, throughSeq }
  })
  return page
}

const STATE = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state/memory/state.yaml'
const PHASE_AUDIT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/phase.jsonl'

/** 读 state.yaml 的 current_phase / revision（只读）。 */
function readState() {
  const t = readFileSync(STATE, 'utf8')
  const grab = (k) => (t.match(new RegExp(`^${k}:\\s*"?([^"\\n]*)"?`, 'm')) ?? [])[1] ?? null
  return { phase: grab('current_phase'), revision: Number(grab('revision')), raw: t.trim() }
}

function phaseAuditTail(k) {
  const ls = readFileSync(PHASE_AUDIT, 'utf8').split(/\r?\n/).filter(Boolean)
  return { total: ls.length, rows: ls.slice(-k).map((l) => JSON.parse(l)) }
}

/**
 * 从 page 里抽 header 摘要（含 pwsh/read 在不在 —— 判据 2/4/5 的直接观测量）。
 */
export function summarizeHeaders(recs) {
  const out = []
  for (const r of recs ?? []) {
    const ev = r?.event ?? r
    if (ev?.type !== 'request/header') continue
    const tools = ev.data?.header?.tools
    const names = Array.isArray(tools) ? tools.map((t) => t?.name ?? t) : null
    out.push({
      seq: r?.seq ?? ev?.seq ?? null,
      time: typeof ev?.time === 'number' ? ev.time : null,
      reason: ev.data?.reason ?? null,
      n: names === null ? null : names.length,
      pwsh: names === null ? null : names.includes('pwsh'),
      read: names === null ? null : names.includes('read'),
      names: names
    })
  }
  return out
}

async function readHeaders(sid) {
  const seq = await asOfSeq(sid)
  const page = await pageOf(sid, seq)
  return { seq, page, headers: summarizeHeaders(page?.records ?? []) }
}

function printHeaders(sid, headers, opts = {}) {
  log(`session=${sid}  共 ${headers.length} 条 request/header${opts.note ? '  ' + opts.note : ''}`)
  for (const h of headers) {
    log(
      `  seq=${h.seq} time=${JSON.stringify(h.time)} reason=${JSON.stringify(h.reason)} ` +
        `n=${JSON.stringify(h.n)} pwsh=${h.pwsh === null ? 'n/a' : h.pwsh ? 'IN' : 'OUT'} ` +
        `read=${h.read === null ? 'n/a' : h.read ? 'IN' : 'OUT'}`
    )
    if (opts.withNames) log(`     names=${JSON.stringify(h.names)}`)
  }
}

const [cmd, arg1, ...rest] = process.argv.slice(2)

try {
  if (cmd === 'create') {
    const preset = arg1 ?? 'standard'
    const v = await rpc('session/create', { request: { cwd: CWD, agentPreset: preset } })
    const sid = v?.sessionId ?? v?.id ?? v?.session?.sessionId
    if (!sid) throw new Error('创建会话没拿到 sessionId：' + JSON.stringify(v))
    log(`[创建] ${sid}  agentPreset=${preset}`)
    writeFileSync('_batch2_session_last.txt', sid, 'utf8')
  } else if (cmd === 'send') {
    const sid = arg1
    const text = rest.join(' ')
    if (!sid || !text) throw new Error('用法: node _batch2_drive.mjs send <sid> <文本>')
    const before = await asOfSeq(sid)
    log(`[发出] session=${sid} asOfSeq(before)=${before}`)
    log(`[文本] ${JSON.stringify(text)}`)
    await rpc('session/prompt', {
      request: { sessionId: sid, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] }
    })
    let tries = 0
    let res
    for (;;) {
      tries++
      await sleep(3000)
      res = await readHeaders(sid)
      if (res.headers.length > 0) break
      if (tries >= 20) {
        log(`[超时] 轮询 ${tries} 次仍未出现 request/header（asOfSeq=${res.seq}）`)
        break
      }
    }
    log(`[结果] 轮询 ${tries} 次，asOfSeq=${res.seq}`)
    printHeaders(sid, res.headers, { withNames: true })
  } else if (cmd === 'headers') {
    const sid = arg1
    if (!sid) throw new Error('用法: node _batch2_drive.mjs headers <sid>')
    const res = await readHeaders(sid)
    log(`asOfSeq=${res.seq}  window=${JSON.stringify(res.page?.window ?? null)}`)
    printHeaders(sid, res.headers, { withNames: true })
  } else if (cmd === 'advance') {
    // 推进 Phase：**只能**通过会话里的模型真调 fde_phase_advance（直接写 state.yaml 是绕过权威，
    // 而且内存镜像不知道 ⇒ phase-changed 挂点不会触发 ⇒ 判据 5 拿不到证据）。
    const sid = arg1
    const wantPhase = rest[0] ?? ''
    const customText = rest.slice(1).join(' ').trim()
    if (!sid) throw new Error('用法: node _batch2_drive.mjs advance <sid> [期望到达的phase] [自定义提示词]')
    const before = readState()
    const auditTotalBefore = phaseAuditTail(1).total
    log(`[推进前] current_phase=${before.phase} revision=${before.revision} phase.jsonl=${auditTotalBefore} 行`)
    const text =
      customText ||
      '请调用 fde_phase_advance 工具推进到下一个阶段（只调用这一次，不要调用其它任何工具）。reason 请如实填写：Stage 5 第二批 restrict 活验：需要推进出受保护阶段以验证工具面恢复。'
    log(`[发出] ${JSON.stringify(text)}`)
    await rpc('session/prompt', {
      request: { sessionId: sid, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] }
    })
    let tries = 0
    let st = before
    for (;;) {
      tries++
      await sleep(5000)
      st = readState()
      if (String(st.phase) !== String(before.phase)) break
      if (tries >= 60) {
        log(`[超时] 轮询 ${tries} 次（${tries * 5}s）current_phase 仍是 ${st.phase} —— 模型可能没调工具`)
        break
      }
    }
    log(`[推进后] current_phase=${st.phase} revision=${st.revision}（轮询 ${tries} 次 / ${tries * 5}s）`)
    if (wantPhase && String(st.phase) !== String(wantPhase)) log(`[⚠ 不符预期] 期望 ${wantPhase}，实到 ${st.phase}`)
    const tail = phaseAuditTail(3)
    log(`[审计] phase.jsonl ${auditTotalBefore} → ${tail.total} 行，末 3 行：`)
    for (const r of tail.rows) log('   ' + JSON.stringify(r))
  } else {
    console.log('用法: node _batch2_drive.mjs create | send <sid> <文本> | headers <sid> | advance <sid> [wantPhase] [文本]')
    process.exitCode = 2
  }
} catch (e) {
  log(`[错误] ${e.message}`)
  process.exitCode = 1
} finally {
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
}
