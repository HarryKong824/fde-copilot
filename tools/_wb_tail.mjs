/**
 * 只读：读 WorkBuddy（CodeBuddy）活跃会话的对话记录，看它此刻在做什么。
 * 用法：node _wb_tail.mjs [N=24] [--msg] [--id <前缀>[,<前缀>]] [--all]
 *   （无参数）  取 mtime 最新的那份
 *   --msg       只看 user/assistant 消息（过滤 function_call 噪音）
 *   --id a,b    指定会话前缀（可多个，逗号分隔）
 *   --all       取 1 小时内活跃的全部会话
 *
 * 记录位置：C:\Users\DELL\.workbuddy\projects\<cwd slug>\<sessionId>.jsonl（**明文，非压缩**）
 * 事件类型：message(role=user/assistant) / function_call / function_call_result / reasoning
 *
 * ⚠️ 两个坑：
 *   1) 别按 sessions/<pid>.json 定位 —— WorkBuddy 每次重启换 pid 和文件名，钉死某个 pid
 *      之后会一直读一份死会话（旧脚本钉的 6084 就是死进程，但它那份 .jsonl 仍在被写）。
 *   2) 同时可能有多个活跃会话（不同 cwd slug）。用 --id / --all 区分。
 */
import { readFileSync, statSync, readdirSync } from 'node:fs'

const HOME = 'C:/Users/DELL/.workbuddy'
const argv = process.argv.slice(2)

// 先摘掉 --id 的值，否则它会被当成 N
const idIdx = argv.indexOf('--id')
const idVal = idIdx >= 0 ? argv[idIdx + 1] : null
const rest = idIdx >= 0 ? argv.filter((_, i) => i !== idIdx && i !== idIdx + 1) : argv
const onlyMsg = rest.includes('--msg')
const all = rest.includes('--all')
const N = Number(rest.find((a) => /^\d+$/.test(a)) ?? 24)

const cands = []
for (const d of readdirSync(`${HOME}/projects`)) {
  let files
  try {
    files = readdirSync(`${HOME}/projects/${d}`)
  } catch {
    continue
  }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue
    const p = `${HOME}/projects/${d}/${f}`
    try {
      const st = statSync(p)
      cands.push({ path: p, sessionId: f.replace(/\.jsonl$/, ''), proj: d, mtimeMs: st.mtimeMs, size: st.size })
    } catch {}
  }
}
if (!cands.length) {
  console.log('projects/ 下没有 .jsonl')
  process.exit(0)
}
cands.sort((a, b) => b.mtimeMs - a.mtimeMs)

const clip = (s, n = 400) => {
  const t = String(s ?? '').replace(/\r?\n/g, ' ⏎ ').replace(/\s+/g, ' ')
  return t.length > n ? t.slice(0, n) + ' …' : t
}

function show(sess) {
  console.log('═'.repeat(78))
  console.log(`会话 ${sess.sessionId}   ${Math.round((Date.now() - sess.mtimeMs) / 1000)}s 前   ${sess.size}B`)
  console.log(`slug ${sess.proj}`)
  console.log(sess.path)

  const evs = []
  for (const l of readFileSync(sess.path, 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue
    try {
      evs.push(JSON.parse(l))
    } catch {}
  }
  const view = onlyMsg ? evs.filter((e) => e.type === 'message') : evs
  console.log(`事件 ${evs.length}，显示末尾 ${N} 条：\n${'─'.repeat(78)}`)
  for (const e of view.slice(-N)) {
    const ts = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 19) : '--:--:--'
    const t = e.type
    if (t === 'message') {
      const body = typeof e.content === 'string' ? e.content : JSON.stringify(e.content)
      console.log(`[${ts}] ${String(e.role).toUpperCase().padEnd(9)} ${clip(body, 600)}`)
    } else if (t === 'function_call') {
      const a = typeof e.arguments === 'string' ? e.arguments : JSON.stringify(e.arguments)
      console.log(`[${ts}] CALL      ${e.name}  ${clip(a, 260)}`)
    } else if (t === 'function_call_result') {
      const out = e.output ?? e.result ?? e.content
      console.log(`[${ts}] RESULT    ${clip(typeof out === 'string' ? out : JSON.stringify(out), 220)}`)
    } else if (t === 'reasoning') {
      console.log(`[${ts}] reasoning ${clip(e.summary ?? e.text ?? e.content, 180)}`)
    } else {
      console.log(`[${ts}] ${t}`)
    }
  }
  console.log('')
}

let picked
if (idVal) {
  const wants = idVal.split(',').map((s) => s.trim()).filter(Boolean)
  picked = cands.filter((c) => wants.some((w) => c.sessionId.startsWith(w)))
  if (!picked.length) {
    console.log(`没有匹配 ${idVal} 的会话`)
    process.exit(0)
  }
} else if (all) {
  picked = cands.filter((c) => Date.now() - c.mtimeMs < 3600_000)
} else {
  picked = [cands[0]]
}

console.log('候选记录（按新鲜度）:')
for (const c of cands.slice(0, 5)) {
  console.log(`  ${new Date(c.mtimeMs).toISOString()}  ${Math.round((Date.now() - c.mtimeMs) / 1000)}s前  ${c.sessionId}  ${c.size}B  ${c.proj}`)
}
console.log('')
for (const c of picked) show(c)
